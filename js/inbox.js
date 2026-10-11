// ===================== Inbox check (Gmail, read-only, on-device) =====================
// One button: sign in with Google (gmail.readonly), look at recent inbox threads and
// list the ones where someone wrote last and you haven't replied. Runs entirely in
// the browser — nothing is stored except your OAuth client ID; the access token lives
// in this session only (1 hour).

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const INBOX_QUERY = "in:inbox newer_than:30d -category:promotions -category:social -category:updates -category:forums";
const TOKEN_KEY = "logbook.gmailToken";
const STATE_KEY = "logbook.gmailState";

let inboxToken = null;           // { token, exp }
let inboxLast = null;            // { at: Date, waiting: [...], filtered: n }
let gisLoading = null;

function gmailClientId() {
  const id = (state.config && state.config.gmail_client_id) || "";
  return /^[\w.-]+\.apps\.googleusercontent\.com$/.test(id) ? id : null;
}

function redirectUri() { return location.origin + location.pathname; }

function sessionGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
function sessionSet(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } }

function validToken() {
  if (!inboxToken) {
    try { inboxToken = JSON.parse(sessionGet(TOKEN_KEY) || "null"); } catch (e) { inboxToken = null; }
  }
  return inboxToken && inboxToken.exp > Date.now() + 60000 ? inboxToken.token : null;
}

function storeToken(token, expiresIn) {
  inboxToken = { token, exp: Date.now() + (Number(expiresIn) || 3600) * 1000 };
  sessionSet(TOKEN_KEY, JSON.stringify(inboxToken));
}

// Load Google's sign-in library ahead of time, so the tap itself can open the
// sign-in popup (iOS only allows popups straight from a tap).
function preloadGoogleSignIn() {
  if (!gmailClientId() || gisLoading) return gisLoading;
  gisLoading = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
  return gisLoading;
}

// Fallback when popups don't work (e.g. some Home Screen apps): full-page redirect.
function signInWithRedirect() {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessionSet(STATE_KEY, nonce);
  const p = new URLSearchParams({
    client_id: gmailClientId(), redirect_uri: redirectUri(), response_type: "token",
    scope: GMAIL_SCOPE, state: nonce, include_granted_scopes: "true", prompt: "select_account",
  });
  location.href = "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString();
}

// Called on startup: pick up the token after a redirect sign-in.
function consumeOAuthRedirect() {
  if (!location.hash.includes("access_token=")) return false;
  const p = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", location.pathname + location.search);
  const expected = sessionGet(STATE_KEY);
  sessionSet(STATE_KEY, null);
  if (!expected || p.get("state") !== expected) return false; // not a sign-in we started
  storeToken(p.get("access_token"), p.get("expires_in"));
  return true;
}

function getToken() {
  const t = validToken();
  if (t) return Promise.resolve(t);
  return new Promise((resolve, reject) => {
    if (!(window.google && google.accounts && google.accounts.oauth2)) {
      signInWithRedirect();
      return reject(new Error("redirect"));
    }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: gmailClientId(),
      scope: GMAIL_SCOPE,
      callback: (r) => {
        if (r && r.access_token) { storeToken(r.access_token, r.expires_in); resolve(r.access_token); }
        else reject(new Error((r && r.error) || "Sign-in failed"));
      },
      error_callback: (err) => {
        if (err && (err.type === "popup_failed_to_open" || err.type === "popup_closed")) {
          if (err.type === "popup_failed_to_open") { signInWithRedirect(); return reject(new Error("redirect")); }
        }
        reject(new Error(err && err.type === "popup_closed" ? "Sign-in cancelled" : "Sign-in failed"));
      },
    });
    client.requestAccessToken({ prompt: "" });
  });
}

async function gmail(path, token) {
  const res = await fetch(GMAIL_API + path, { headers: { Authorization: "Bearer " + token } });
  if (res.status === 401) { inboxToken = null; sessionSet(TOKEN_KEY, null); throw new Error("Your Google sign-in expired — tap Check inbox again."); }
  if (res.status === 403) throw new Error("Gmail refused access. Make sure the Gmail API is enabled in your Google Cloud project.");
  if (!res.ok) throw new Error("Gmail error " + res.status);
  return res.json();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  });
  await Promise.all(workers);
  return out;
}

function parseAddress(raw) {
  const s = String(raw || "");
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  const email = (m ? m[2] : s).trim().toLowerCase();
  const name = (m && m[1].trim()) || email.split("@")[0];
  return { name, email };
}

function decodeEntities(str) {
  const t = document.createElement("textarea");
  t.innerHTML = String(str || "");
  return t.value;
}

const AUTOMATED_FROM = /no.?reply|do.?not.?reply|notification|mailer|newsletter|^news@|^info@|^support@|billing|receipt|invoice|alerts?@|^updates?@|^hello@|^team@|marketing|calendar-notification|@.*\.(mailchimp|sendgrid|hubspot)/i;

// Decide which threads are waiting on you.
function analyseThreads(threads, me) {
  const waiting = [];
  let filtered = 0;
  threads.forEach((t) => {
    if (!t || !t.messages || !t.messages.length) return;
    const last = t.messages[t.messages.length - 1];
    const h = {};
    (last.payload && last.payload.headers || []).forEach((x) => { h[x.name.toLowerCase()] = x.value; });
    const from = parseAddress(h.from);
    if ((last.labelIds || []).includes("SENT") || from.email === me) return; // you wrote last
    const automated = h["list-unsubscribe"] || /bulk|list|junk/i.test(h.precedence || "")
      || (h["auto-submitted"] && !/^no$/i.test(h["auto-submitted"])) || AUTOMATED_FROM.test(from.email);
    if (automated) { filtered++; return; }
    const toMe = String(h.to || "").toLowerCase().includes(me);
    const subject = decodeEntities(h.subject || "(no subject)");
    const snippet = decodeEntities(last.snippet || "");
    const question = /\?/.test(subject + " " + snippet);
    const ongoing = t.messages.some((m) => (m.labelIds || []).includes("SENT"));
    const days = Math.max(0, Math.floor((Date.now() - Number(last.internalDate)) / 86400000));
    const score = (toMe ? 2 : 0) + (question ? 2 : 0) + (ongoing ? 1 : 0) + Math.min(days, 10) * 0.3
      + ((last.labelIds || []).includes("IMPORTANT") ? 1 : 0);
    waiting.push({ id: t.id, from, subject, snippet, question, ongoing, toMe, days, score,
      unread: (last.labelIds || []).includes("UNREAD") });
  });
  waiting.sort((a, b) => b.score - a.score || b.days - a.days);
  return { waiting, filtered };
}

async function checkInbox() {
  if (!gmailClientId()) { openInboxSetup(); return; }
  const btn = document.querySelector("#inbox-check-btn");
  const setBusy = (msg) => { if (btn) { btn.disabled = !!msg; btn.querySelector(".hs-text span").textContent = msg || inboxSummaryText(); } };
  let token;
  try {
    token = await getToken();
  } catch (e) {
    if (e.message !== "redirect") toast(e.message);
    return;
  }
  try {
    setBusy("Reading your inbox…");
    const me = (await gmail("/profile", token)).emailAddress.toLowerCase();
    const list = await gmail("/threads?maxResults=40&q=" + encodeURIComponent(INBOX_QUERY), token);
    const ids = (list.threads || []).map((t) => t.id);
    const headers = ["From", "To", "Subject", "Date", "List-Unsubscribe", "Precedence", "Auto-Submitted"]
      .map((x) => "&metadataHeaders=" + x).join("");
    const threads = await mapLimit(ids, 6, (id) => gmail(`/threads/${encodeURIComponent(id)}?format=metadata${headers}`, token).catch(() => null));
    inboxLast = { at: new Date(), ...analyseThreads(threads, me), scanned: ids.length };
    setBusy(null);
    openInboxResults();
  } catch (e) {
    setBusy(null);
    toast(e.message);
  }
}

function inboxSummaryText() {
  if (!gmailClientId()) return "Connect Gmail (one-time setup)";
  if (!inboxLast) return "See who's waiting for your reply";
  const n = inboxLast.waiting.length;
  return n ? `${n} waiting for a reply · checked ${inboxLast.at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
    : "All caught up ✓";
}

function inboxCardHtml() {
  return `
    <div class="inbox-bar">
      <button class="hs-btn" id="inbox-check-btn"><span class="hs-ico inbox-ico">✉</span><span class="hs-text"><b>Check inbox</b><span>${escapeHtml(inboxSummaryText())}</span></span></button>
      <button class="hs-help" id="inbox-setup-btn" aria-label="Gmail setup">⚙</button>
    </div>`;
}

function wireInboxCard(panel) {
  const b = panel.querySelector("#inbox-check-btn");
  if (b) b.addEventListener("click", checkInbox);
  const s = panel.querySelector("#inbox-setup-btn");
  if (s) s.addEventListener("click", openInboxSetup);
  preloadGoogleSignIn();
}

function openInboxResults() {
  const overlay = document.getElementById("modal-overlay");
  const content = document.getElementById("modal-content");
  const r = inboxLast;
  const rows = r.waiting.map((w) => `
    <a class="mail-row" href="https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(w.id)}" target="_blank" rel="noopener">
      <span class="mail-top">
        <b class="mail-from">${escapeHtml(w.from.name)}</b>
        <span class="mail-wait${w.days >= 3 ? " late" : ""}">${w.days === 0 ? "today" : w.days + " d"}</span>
      </span>
      <span class="mail-subj">${w.unread ? "● " : ""}${escapeHtml(w.subject)}</span>
      <span class="mail-snip">${escapeHtml(w.snippet)}</span>
      <span class="mail-tags">${w.toMe ? `<i>to you</i>` : `<i>cc</i>`}${w.question ? `<i class="q">question</i>` : ""}${w.ongoing ? `<i>ongoing</i>` : ""}</span>
    </a>`).join("");
  const n = r.waiting.length;
  content.innerHTML = `
    <div class="sheet-grabber"></div>
    <h3 class="sheet-title">${n ? `${n} ${n === 1 ? "person is" : "people are"} waiting for you` : "You're all caught up"}</h3>
    <p class="section-hint">Last 30 days of your inbox: threads where someone else wrote last. ${r.filtered} newsletter/automatic email${r.filtered === 1 ? "" : "s"} skipped. Most urgent first.</p>
    <div class="mail-list">${rows || `<div class="empty-state">Nobody is waiting on a reply 🎉</div>`}</div>
    <button class="modal-close" id="inbox-close">Close</button>`;
  overlay.classList.remove("hidden");
  content.querySelector("#inbox-close").addEventListener("click", () => overlay.classList.add("hidden"));
  const bar = document.querySelector("#inbox-check-btn .hs-text span");
  if (bar) bar.textContent = inboxSummaryText();
}

function openInboxSetup() {
  const overlay = document.getElementById("modal-overlay");
  const content = document.getElementById("modal-content");
  const origin = location.origin;
  content.innerHTML = `
    <div class="sheet-grabber"></div>
    <h3 class="sheet-title">Connect Gmail</h3>
    <div class="setup">
      <p>Logbook reads your inbox <b>read-only</b>, on this phone only. Google needs a free "OAuth client" once — about 5 minutes on a computer.</p>
      <label class="be-field">Google OAuth Client ID
        <input type="text" id="gmail-client-id" placeholder="1234…apps.googleusercontent.com" value="${escapeAttr(state.config.gmail_client_id || "")}" autocapitalize="off" autocomplete="off" spellcheck="false">
      </label>
      <button class="cal-primary" id="gmail-save" style="width:100%;margin-top:8px">Save</button>
      <h4>Where to get the Client ID</h4>
      <ol class="setup-steps">
        <li>Go to <b>console.cloud.google.com</b> → create a project called <i>Logbook</i>.</li>
        <li><b>APIs &amp; Services → Library</b> → search <b>Gmail API</b> → <b>Enable</b>.</li>
        <li><b>Google Auth Platform</b> (OAuth consent screen) → <b>Get started</b>: app name <i>Logbook</i>, your email, audience <b>External</b> → Create.</li>
        <li><b>Audience</b> → <b>Test users</b> → <b>Add users</b> → your Gmail address.</li>
        <li><b>Clients</b> → <b>Create client</b> → type <b>Web application</b>.<br>
          Authorized JavaScript origins: <code>${escapeHtml(origin)}</code><br>
          Authorized redirect URIs: <code>${escapeHtml(redirectUri())}</code></li>
        <li><b>Create</b> → copy the <b>Client ID</b> and paste it above.</li>
      </ol>
      <p class="setup-opt">When you sign in, Google says the app "hasn't been verified" — that's expected for your own private app: tap <b>Continue</b>. The sign-in lasts an hour; after that one tap signs you in again.</p>
    </div>
    <button class="modal-close" id="gmail-close">Close</button>`;
  overlay.classList.remove("hidden");
  content.querySelector("#gmail-save").addEventListener("click", () => {
    const v = content.querySelector("#gmail-client-id").value.trim();
    if (v && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(v)) { toast("That doesn't look like a Client ID (…apps.googleusercontent.com)"); return; }
    state.config.gmail_client_id = v || null;
    saveDebounced(100);
    gisLoading = null;
    preloadGoogleSignIn();
    overlay.classList.add("hidden");
    renderToday();
    toast(v ? "Gmail connected — tap Check inbox" : "Gmail disconnected");
  });
  content.querySelector("#gmail-close").addEventListener("click", () => overlay.classList.add("hidden"));
}
