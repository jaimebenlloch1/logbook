// ===================== Logbook on-device store =====================
// Replaces the Python server: everything lives in IndexedDB on the device.
// Mirrors app.py — default data, migrations, snapshots, .ics calendar.

const APP_VERSION = "2.2";
const MAX_SNAPSHOTS = 100;
const SNAPSHOT_MIN_GAP_MS = 5 * 60 * 1000; // at most one snapshot per 5 min of editing

// ---------------- IndexedDB ----------------

const DB_NAME = "logbook";
let _dbp = null;

function _db() {
  if (_dbp) return _dbp;
  _dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("kv");
      db.createObjectStore("versions", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbp;
}

async function _tx(store, mode, fn) {
  const db = await _db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const os = tx.objectStore(store);
    let result;
    const r = fn(os);
    if (r) r.onsuccess = () => { result = r.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const kvGet = (k) => _tx("kv", "readonly", (os) => os.get(k));
const kvSet = (k, v) => _tx("kv", "readwrite", (os) => os.put(v, k));

// ---------------- Defaults (ported from app.py) ----------------

const S_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function newId() {
  return (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(16).slice(2) + "00000000").slice(0, 8);
}

function nowMonth() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

function defaultMonthlyPlan() {
  return { hourly_rate: 0, hours_per_week: 0, extra_incomes: [], fixed_expenses: [], other_expenses: [] };
}

function defaultMeals() {
  const week = {};
  S_DAYS.forEach((d) => {
    week[d] = {
      breakfast: { recipe_id: null, at_work: false },
      lunch: { recipe_id: null, at_work: false },
      dinner: { recipe_id: null, at_work: false },
    };
  });
  return { week, grocery_checked: {}, extra_groceries: [] };
}

function defaultRecipes() {
  const ing = (name, qty) => ({ id: newId(), name, qty });
  return [
    { id: newId(), name: "Oatmeal & fruit", ingredients: [ing("Oats", "80 g"), ing("Milk", "300 ml"), ing("Banana", "1")] },
    { id: newId(), name: "Chicken & rice", ingredients: [ing("Chicken breast", "400 g"), ing("Rice", "250 g"), ing("Broccoli", "1 head")] },
    { id: newId(), name: "Pasta bolognese", ingredients: [ing("Pasta", "250 g"), ing("Minced beef", "400 g"), ing("Tomato passata", "500 ml"), ing("Onion", "1")] },
  ];
}

// name, kcal, protein, carbs, fat, grams per piece — per 100 g
const _FOODS = [
  ["Pasta", 350, 12.5, 71, 1.5, null], ["Rice", 350, 7, 78, 0.6, null], ["Rice noodles", 360, 3.4, 83, 0.6, null],
  ["Egg", 155, 13, 1.1, 11, 60],
  ["Chicken breast", 165, 31, 0, 3.6, 200], ["Chicken thigh", 210, 26, 0, 11, 150], ["Ground beef", 176, 20, 0, 10, null],
  ["Ground pork", 168, 19, 0, 9.7, null], ["Pork chop", 230, 25, 0, 14, 150], ["Bacon", 540, 37, 1.4, 42, 15],
  ["Beef steak", 149, 21.7, 0, 6.3, 200], ["Jamón serrano", 234, 30, 1.5, 12, null], ["Fuet", 464, 26, 2.4, 39, null],
  ["Chorizo", 455, 24.1, 1.9, 38.3, null],
  ["Sourdough bread", 247, 8.8, 48.8, 1.2, 50], ["Rice cakes", 387, 8.2, 81.5, 2.8, 9],
  ["Lentils", 350, 25, 60, 1, null], ["Whole milk", 61, 3.2, 4.8, 3.3, null], ["Honey", 304, 0.3, 82, 0, null],
  ["Tomato", 18, 0.9, 3.9, 0.2, 120], ["Onion", 40, 1.1, 9.3, 0.1, 150], ["Garlic", 149, 6.4, 33, 0.5, 4],
  ["Broccoli", 34, 2.8, 7, 0.4, null], ["Spinach", 23, 2.9, 3.6, 0.4, null], ["Carrot", 41, 0.9, 10, 0.2, 80],
  ["Bell pepper", 31, 1, 6, 0.3, 160], ["Zucchini", 17, 1.2, 3.1, 0.3, 200], ["Lettuce", 15, 1.4, 2.9, 0.2, null],
  ["Potato", 77, 2, 17, 0.1, 150],
];

function defaultFoods() {
  return _FOODS.map(([name, kcal, protein, carbs, fat, piece_g]) => ({ id: newId(), name, kcal, protein, carbs, fat, piece_g }));
}

// Fresh installs start empty; import your data file (Data → Import) or add
// blocks, courses and recipes in Settings.
function defaultData() {
  return {
    config: { currency: "DKK", currency_symbol: "kr.", theme: "light" },
    body: { entries: [] },
    schedule: {
      classes_start: null,
      wake_times: Object.fromEntries(S_DAYS.map((d) => [d, null])),
      blocks: [],
    },
    weekly_tasks: { days: Object.fromEntries(S_DAYS.map((d) => [d, []])), archive: [] },
    courses: [],
    meals: defaultMeals(),
    recipes: defaultRecipes(),
    foods: defaultFoods(),
    calendar_events: [],
    finances: {
      monthly_plan: defaultMonthlyPlan(),
      ledger: [],
      ledger_month: nowMonth(),
      ledger_archive: {},
      savings_goals: [],
    },
  };
}

// ---------------- Migrations (ported from app.py) ----------------

function rolloverLedger(data) {
  const fin = data.finances || (data.finances = {});
  const now = nowMonth();
  if (fin.ledger_month == null) {
    fin.ledger_month = now;
    fin.ledger_archive = fin.ledger_archive || {};
    return true;
  }
  if (fin.ledger_month === now) return false;
  const archive = fin.ledger_archive || (fin.ledger_archive = {});
  const tx = fin.ledger || [];
  if (tx.length) {
    const [y, m] = fin.ledger_month.split("-").map(Number);
    const label = new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    archive[fin.ledger_month] = { label, transactions: tx };
  }
  fin.ledger = [];
  fin.ledger_month = now;
  return true;
}

function migrate(data) {
  let changed = false;
  const cfg = data.config || (data.config = {});
  if (cfg.currency !== "DKK") { cfg.currency = "DKK"; cfg.currency_symbol = "kr."; changed = true; }
  if ("trainings" in data) { delete data.trainings; changed = true; }

  const fin = data.finances || (data.finances = { monthly_plan: defaultMonthlyPlan(), ledger: [] });
  const plan = fin.monthly_plan || {};
  if (!("fixed_expenses" in plan)) {
    fin.monthly_plan = {
      hourly_rate: plan.hourly_rate ?? 150.0,
      hours_per_week: plan.hours_per_week ?? 24.5,
      extra_incomes: [],
      fixed_expenses: plan.expenses || defaultMonthlyPlan().fixed_expenses,
      other_expenses: [],
    };
    changed = true;
  }
  if (!data.meals) { data.meals = defaultMeals(); changed = true; }
  if (!data.recipes) { data.recipes = defaultRecipes(); changed = true; }
  if (rolloverLedger(data)) changed = true;
  if (!data.foods || !data.foods.length) { data.foods = defaultFoods(); changed = true; }

  const sched = data.schedule || (data.schedule = {});
  if (!Array.isArray(sched.blocks)) { sched.blocks = []; changed = true; }
  if (!sched.wake_times) { sched.wake_times = {}; changed = true; }
  if (!("classes_start" in sched)) { sched.classes_start = null; changed = true; }

  if (!data.body) { data.body = { entries: [] }; changed = true; }
  if (!data.body.entries) { data.body.entries = []; changed = true; }
  if (!fin.savings_goals) { fin.savings_goals = []; changed = true; }
  if (!cfg.theme) { cfg.theme = "light"; changed = true; }
  // v2.0 (iPhone): calendar events live in the data file, not in EventKit
  if (!Array.isArray(data.calendar_events)) { data.calendar_events = []; changed = true; }
  if (!data.weekly_tasks) { data.weekly_tasks = { days: {}, archive: [] }; changed = true; }
  S_DAYS.forEach((d) => { if (!data.weekly_tasks.days[d]) { data.weekly_tasks.days[d] = []; changed = true; } });
  return changed;
}

// ---------------- Load / save / snapshots ----------------

let _lastSnapshotAt = 0;

async function storeLoad() {
  // ask iOS not to evict our storage (granted automatically for Home Screen apps)
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignore */ }
  let data = await kvGet("current");
  if (!data) {
    data = defaultData();
    await kvSet("current", data);
    return data;
  }
  if (migrate(data)) await storeSave(data);
  return data;
}

async function storeSave(data, { snapshot = "auto" } = {}) {
  rolloverLedger(data);
  const copy = JSON.parse(JSON.stringify(data));
  await kvSet("current", copy);
  const now = Date.now();
  if (snapshot === "force" || (snapshot === "auto" && now - _lastSnapshotAt > SNAPSHOT_MIN_GAP_MS)) {
    _lastSnapshotAt = now;
    await _addSnapshot(copy);
  }
  return data;
}

function _stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function _addSnapshot(data) {
  const id = _stamp() + "_" + newId().slice(0, 4);
  await _tx("versions", "readwrite", (os) => os.put({ id, data }));
  const keys = (await _tx("versions", "readonly", (os) => os.getAllKeys())) || [];
  keys.sort();
  const excess = keys.length - MAX_SNAPSHOTS;
  if (excess > 0) {
    await _tx("versions", "readwrite", (os) => { keys.slice(0, excess).forEach((k) => os.delete(k)); });
  }
}

async function storeListVersions() {
  const keys = (await _tx("versions", "readonly", (os) => os.getAllKeys())) || [];
  return keys.sort().reverse().map((k) => ({ filename: k, timestamp: k.slice(0, 19) }));
}

async function storeRestoreVersion(id) {
  const rec = await _tx("versions", "readonly", (os) => os.get(id));
  if (!rec) throw new Error("Version not found");
  const data = rec.data;
  migrate(data);
  await storeSave(data, { snapshot: "force" });
  return data;
}

// Replace everything with an imported data file (e.g. current.json from the Mac).
async function storeImportData(obj) {
  if (!obj || typeof obj !== "object" || !obj.schedule || !obj.weekly_tasks) {
    throw new Error("That file doesn't look like Logbook data (current.json).");
  }
  migrate(obj);
  sanitizeData(obj);
  await storeSave(obj, { snapshot: "force" });
  return obj;
}

// Imported files are untrusted: the UI builds HTML from ids, times and dates, so
// force those into their expected shapes (text fields are escaped at render time).
const _SAFE_ID = /^[\w-]{1,64}$/;
const _TIME = /^\d{2}:\d{2}$/;
const _DATE = /^\d{4}-\d{2}-\d{2}$/;
function sanitizeData(data) {
  const walk = (v, key) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === "string") {
        if ((k === "id" || k.endsWith("_id")) && !_SAFE_ID.test(x)) v[k] = newId();
        else if ((k === "start" || k === "end") && !_TIME.test(x) && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(x)) v[k] = "00:00";
        else if ((k === "date" || k === "due") && x && !_DATE.test(x)) v[k] = null;
      } else if (typeof x === "number" && !Number.isFinite(x)) {
        v[k] = null;
      } else walk(x, k);
    }
  };
  walk(data);
  // numeric settings must be numbers (they're shown in form fields)
  const cfg = data.config || {};
  ["bmr_kcal", "height_cm", "age"].forEach((k) => {
    if (cfg[k] != null && !(typeof cfg[k] === "number" && Number.isFinite(cfg[k]))) cfg[k] = Number.isFinite(Number(cfg[k])) ? Number(cfg[k]) : null;
  });
  if (cfg.sex != null && cfg.sex !== "m" && cfg.sex !== "f") cfg.sex = null;
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  (data.schedule.blocks || []).forEach((b) => { if (!days.includes(b.day)) b.day = "Mon"; });
  Object.entries(data.schedule.wake_times || {}).forEach(([d, t]) => {
    if (t != null && !_TIME.test(t)) data.schedule.wake_times[d] = null;
  });
}

// Hand the user a JSON backup via the iOS share sheet (or a download fallback).
async function storeExportBackup(data) {
  const name = `logbook_backup_${_stamp()}.json`;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const file = new File([blob], name, { type: "application/json" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Logbook backup" });
      return { ok: true, name };
    } catch (e) {
      if (e && e.name === "AbortError") return { ok: false, error: "cancelled" };
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  return { ok: true, name };
}

// ---------------- Calendar: .ics export / import ----------------

function _icsEsc(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}
function _icsLocal(iso) { // "2026-10-11T14:30" → 20261011T143000
  return iso.replace(/[-:]/g, "").slice(0, 13) + "00";
}

function eventsToIcs(events) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Logbook//EN", "CALSCALE:GREGORIAN"];
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  events.forEach((ev) => {
    lines.push("BEGIN:VEVENT", `UID:${ev.id}@logbook`, `DTSTAMP:${stamp}`);
    if (ev.allDay) {
      const s = ev.start.slice(0, 10).replace(/-/g, "");
      const [y, m, d] = (ev.end || ev.start).slice(0, 10).split("-").map(Number);
      const e = new Date(y, m - 1, d + 1);
      const ed = `${e.getFullYear()}${String(e.getMonth() + 1).padStart(2, "0")}${String(e.getDate()).padStart(2, "0")}`;
      lines.push(`DTSTART;VALUE=DATE:${s}`, `DTEND;VALUE=DATE:${ed}`);
    } else {
      lines.push(`DTSTART:${_icsLocal(ev.start)}`, `DTEND:${_icsLocal(ev.end || ev.start)}`);
    }
    lines.push(`SUMMARY:${_icsEsc(ev.title)}`);
    if (ev.location) lines.push(`LOCATION:${_icsEsc(ev.location)}`);
    if (ev.notes) lines.push(`DESCRIPTION:${_icsEsc(ev.notes)}`);
    lines.push("END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

// Opening an .ics file on iOS shows "Add to Calendar" — that is how events reach Apple Calendar.
async function shareIcs(events, name = "logbook-event.ics") {
  const ics = eventsToIcs(events);
  const file = new File([ics], name, { type: "text/calendar" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e && e.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function _icsUnesc(s) {
  return s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}
function _icsToIso(v) {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
  if (!m) return null;
  if (!m[4]) return `${m[1]}-${m[2]}-${m[3]}T00:00`;
  if (v.endsWith("Z")) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
}

function parseIcs(text) {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const out = [];
  let cur = null;
  lines.forEach((line) => {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT") {
      if (cur && cur.start) {
        const allDay = !!cur._dateOnly;
        let end = cur.end || cur.start;
        if (allDay && cur.end) { // DTEND is exclusive for all-day events
          const [y, m, d] = cur.end.slice(0, 10).split("-").map(Number);
          const e = new Date(y, m - 1, d - 1);
          end = `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, "0")}-${String(e.getDate()).padStart(2, "0")}T23:59`;
        }
        out.push({ id: newId(), title: cur.title || "Event", start: cur.start, end, allDay,
          location: cur.location || "", notes: cur.notes || "", uid: cur.uid || "" });
      }
      cur = null;
    } else if (cur) {
      const i = line.indexOf(":");
      if (i < 0) return;
      const key = line.slice(0, i).toUpperCase(), val = line.slice(i + 1);
      const name = key.split(";")[0];
      if (name === "SUMMARY") cur.title = _icsUnesc(val);
      else if (name === "LOCATION") cur.location = _icsUnesc(val);
      else if (name === "DESCRIPTION") cur.notes = _icsUnesc(val);
      else if (name === "UID") cur.uid = val;
      else if (name === "DTSTART") { cur.start = _icsToIso(val); if (key.includes("VALUE=DATE") || /^\d{8}$/.test(val)) cur._dateOnly = true; }
      else if (name === "DTEND") cur.end = _icsToIso(val);
    }
  });
  return out;
}
