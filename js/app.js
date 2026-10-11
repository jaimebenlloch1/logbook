// ===================== Logbook frontend =====================

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_FULL = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

// Settings PIN: chosen on the device; only its SHA-256 lives in the data file
async function hashPin(pin) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("logbook:" + pin));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
let settingsUnlocked = false;

let state = null;
let saveTimer = null;
let scheduleScrolledToToday = false;

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

// Danish kroner formatting: 1.234,56 kr.
// Animate a numeric element from its last value to `to`, formatting with `fmt`.
function animateNumber(el, to, fmt, duration = 600) {
  if (!el) return;
  const from = typeof el._val === "number" ? el._val : 0;
  const t0 = performance.now();
  function step(t) {
    const p = Math.min(1, (t - t0) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    const v = from + (to - from) * eased;
    el.textContent = fmt(v);
    if (p < 1) requestAnimationFrame(step);
    else el._val = to;
  }
  requestAnimationFrame(step);
}

function todayKey() {
  // JS: Sun=0 … Sat=6 → our Mon-first keys
  return DAYS[(new Date().getDay() + 6) % 7];
}

function monthLabel(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

function daysUntil(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const due = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86400000);
}

// ---------------- Persistence ----------------

async function loadData() {
  state = await storeLoad();
}

function setSaveIndicator(mode) {
  const el = document.getElementById("save-indicator");
  el.classList.remove("saving", "saved");
  if (mode === "saving") {
    el.textContent = "saving…";
    el.classList.add("saving");
  } else {
    el.textContent = "saved";
    el.classList.add("saved");
  }
}

async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  setSaveIndicator("saving");
  try {
    await storeSave(state);
    setSaveIndicator("saved");
  } catch (e) {
    setSaveIndicator("saving");
    document.getElementById("save-indicator").textContent = "save failed";
  }
}

function saveDebounced(delay = 500) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, delay);
}

// ---------------- Tabs (sliding pill) ----------------

const TAB_RENDERERS = {
  today: () => renderToday(),
  calendar: () => renderCalendar(),
  schedule: () => renderSchedule(),
  tasks: () => renderTasks(),
  masters: () => renderMasters(),
  settings: () => renderSettings(),
};

function movePill(btn) {
  const pill = document.getElementById("tab-pill");
  pill.style.left = btn.offsetLeft + "px";
  pill.style.width = btn.offsetWidth + "px";
}

const MORE_TABS = ["masters", "settings"];
const TAB_TITLES = { today: "Today", calendar: "Calendar", schedule: "Schedule", tasks: "Tasks", masters: "Master's",
  settings: "Settings" };

function isPhone() { return matchMedia("(max-width: 760px)").matches; }

function showTab(name) {
  const buttons = document.querySelectorAll(".tab-btn");
  buttons.forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  const btn = document.querySelector(`.tab-btn[data-tab="${name}"]`);
  btn.classList.add("active");
  // on phones the secondary tabs live under "More"
  if (isPhone() && MORE_TABS.includes(name)) document.querySelector('.tab-btn[data-tab="more"]').classList.add("active");
  movePill(btn);
  document.getElementById(`panel-${name}`).classList.add("active");
  window.scrollTo(0, 0);
  // re-render the freshly shown tab so edits made elsewhere show up
  const render = TAB_RENDERERS[name];
  if (render) render();
}

function initTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.tab === "more") openMoreSheet();
      else showTab(btn.dataset.tab);
    });
  });
  window.addEventListener("resize", () => movePill(document.querySelector(".tab-btn.active")));
  requestAnimationFrame(() => movePill(document.querySelector(".tab-btn.active")));
  // switching between phone and desktop layouts changes how several tabs render
  matchMedia("(max-width: 760px)").addEventListener("change", () => renderAll());
}

function openMoreSheet() {
  const overlay = document.getElementById("modal-overlay");
  const content = document.getElementById("modal-content");
  const ico = { masters: "✎", settings: "⚙" };
  const sub = {
    masters: () => { const n = upcomingDeadlines().filter((d) => d.days <= 7).length; return n ? `${n} deadline${n > 1 ? "s" : ""} this week` : "Courses & assignments"; },
    settings: () => "Schedule, courses, wake times",
  };
  const dark = state.config.theme === "dark";
  content.innerHTML = `
    <div class="sheet-grabber"></div>
    <h3 class="sheet-title">More</h3>
    <div class="more-list">
      ${MORE_TABS.map((t) => `
        <button class="more-row" data-tab="${t}">
          <span class="more-ico">${ico[t]}</span>
          <span class="more-text"><span class="more-title">${TAB_TITLES[t]}</span><span class="more-sub">${escapeHtml(sub[t]())}</span></span>
          <span class="more-chev">›</span>
        </button>`).join("")}
    </div>
    <div class="more-list">
      <button class="more-row" data-action="review"><span class="more-ico">★</span><span class="more-text"><span class="more-title">Weekly review</span></span><span class="more-chev">›</span></button>
      <button class="more-row" data-action="data"><span class="more-ico">⇅</span><span class="more-text"><span class="more-title">Data &amp; backup</span><span class="more-sub">Export, import, snapshots</span></span><span class="more-chev">›</span></button>
      <button class="more-row" data-action="theme"><span class="more-ico">${dark ? "☀" : "☾"}</span><span class="more-text"><span class="more-title">${dark ? "Light" : "Dark"} mode</span></span></button>
    </div>
    <div class="more-version">Logbook v${APP_VERSION}</div>`;
  overlay.classList.remove("hidden");
  content.querySelectorAll(".more-row").forEach((row) => {
    row.addEventListener("click", () => {
      overlay.classList.add("hidden");
      if (row.dataset.tab) showTab(row.dataset.tab);
      else if (row.dataset.action === "review") openReviewModal();
      else if (row.dataset.action === "data") openVersionsModal();
      else if (row.dataset.action === "theme") toggleTheme();
    });
  });
}

// ---------------- Clock ----------------

function initClock() {
  const el = document.getElementById("clock");
  function tick() {
    const d = new Date();
    el.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, "0")).join(":");
  }
  tick();
  setInterval(tick, 1000);
}

function upcomingDeadlines() {
  const list = [];
  state.courses.forEach((c) => {
    c.assignments.forEach((a) => {
      if (!a.done && a.due) list.push({ course: c, assignment: a, days: daysUntil(a.due) });
    });
  });
  list.sort((a, b) => (a.assignment.due < b.assignment.due ? -1 : 1));
  return list;
}

function deadlineChip(days) {
  if (days < 0) return `<span class="deadline-chip overdue">${-days}d overdue</span>`;
  if (days === 0) return `<span class="deadline-chip overdue">today</span>`;
  if (days <= 3) return `<span class="deadline-chip soon">in ${days}d</span>`;
  return `<span class="deadline-chip">in ${days}d</span>`;
}

// ================= TODAY =================

const TYPE_COLORS = {
  class: "var(--maroon)", work: "var(--work)", training: "var(--forest)",
  danish: "var(--danish)", commute: "var(--commute)",
};

function renderToday() {
  const today = todayKey();
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dateStr = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const wake = state.schedule.wake_times[today];

  // --- schedule list ---
  const blocks = state.schedule.blocks
    .filter((b) => b.day === today && blockVisible(b))
    .sort((a, b) => parseTime(a.start) - parseTime(b.start));
  const scheduleHtml = blocks.length ? blocks.map((b, i) => {
    const isNow = !b.skipped && parseTime(b.start) <= nowMin && nowMin < parseTime(b.end);
    return `
      <div class="today-block editable ${b.skipped ? "skipped" : ""} ${isNow ? "now" : ""}" data-block-id="${b.id}" title="Click to edit" style="animation-delay:${i * 45}ms">
        <span class="tb-dot" style="background:${TYPE_COLORS[b.type] || "var(--muted)"}"></span>
        <span class="tb-time">${escapeHtml(b.start)}–${escapeHtml(b.end)}</span>
        <span class="tb-label">${escapeHtml(b.label)}${b.room ? " · " + escapeHtml(b.room) : ""}</span>
        ${isNow ? `<span class="now-chip">NOW</span>` : ""}
      </div>`;
  }).join("") : `<div class="empty-hint">Nothing scheduled — free day!</div>`;

  // --- tasks ---
  const tasks = state.weekly_tasks.days[today] || [];
  const tasksHtml = tasks.length ? tasks.map((t) => `
    <div class="task-item ${t.done ? "done" : ""}" data-id="${t.id}">
      <span class="task-text">${escapeHtml(t.text)}</span>
    </div>`).join("") : `<div class="empty-hint">No tasks for today</div>`;
  const doneCount = tasks.filter((t) => t.done).length;

  // --- deadlines ---
  const deadlines = upcomingDeadlines().slice(0, 4);
  const deadlinesHtml = deadlines.length ? deadlines.map((d) => `
    <div class="deadline-item">
      ${deadlineChip(d.days)}
      <span class="dl-course">${escapeHtml(d.course.code)}</span>
      <span class="dl-title">${escapeHtml(d.assignment.title)}</span>
      <span class="dl-date">${formatDateEU(d.assignment.due)}</span>
    </div>`).join("") : `<div class="empty-hint">No upcoming deadlines 🎉</div>`;

  const panel = document.getElementById("panel-today");
  panel.innerHTML = `
    <div class="today-header">
      <h2 class="section-title">Today</h2>
      <span class="today-date">${dateStr}</span>
      ${wake ? `<span class="today-wake">⏰ wake ${wake}</span>` : ""}
    </div>
    ${inboxCardHtml()}
    <div class="today-grid">
      <div class="card today-card schedule-card rise">
        <h3>Schedule</h3>
        ${scheduleHtml}
        ${classesActive() ? "" : classesHiddenNote()}
      </div>
      <div>
        <div class="card today-card rise" style="animation-delay:60ms; margin-bottom:18px">
          <h3>Tasks <span style="font-family:var(--font-mono); font-size:11px; color:var(--muted)">${doneCount}/${tasks.length}</span></h3>
          <div class="task-list" id="today-task-list">${tasksHtml}</div>
          <div class="task-add-row">
            <input type="text" id="today-new-task" placeholder="Add task for today…">
            <button id="today-add-task-btn">+</button>
          </div>
        </div>
      <div>
        <div class="card today-card rise" style="animation-delay:240ms">
          <h3>Deadlines</h3>
          ${deadlinesHtml}
        </div>
      </div>
    </div>
  `;

  wireInboxCard(panel);

  // wire: task toggling + adding
  panel.querySelectorAll("#today-task-list .task-item").forEach((el) => {
    el.addEventListener("click", () => {
      toggleTask(today, el.dataset.id);
      renderToday();
    });
  });
  const addBtn = panel.querySelector("#today-add-task-btn");
  const addInput = panel.querySelector("#today-new-task");
  const addTodayTask = () => {
    const text = addInput.value.trim();
    if (!text) return;
    state.weekly_tasks.days[today].push({ id: genId(), text, done: false });
    renderTasks();
    renderToday();
    saveDebounced(200);
    document.getElementById("today-new-task").focus();
  };
  addBtn.addEventListener("click", addTodayTask);
  addInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addTodayTask(); });

  // click a schedule row to edit the block
  panel.querySelectorAll(".today-block[data-block-id]").forEach((el) => {
    el.addEventListener("click", () => openBlockEditor(el.dataset.blockId));
  });

}

// ================= PHONE: day picker =================
// Phones show one weekday at a time (Schedule, Tasks, Meals) with a strip of
// the seven days on top; swiping left/right on the content changes the day.

let phoneDay = null;          // "Mon".."Sun" — shared by the day-view tabs
let scheduleMode = "day";     // phone Schedule: "day" | "week"

function currentPhoneDay() { return phoneDay || todayKey(); }

function weekDateOf(dayKey) {
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  return new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + DAYS.indexOf(dayKey));
}

// badges: optional {Mon: "3", …} shown under each day
function dayStripHtml(badges = {}) {
  const sel = currentPhoneDay(), today = todayKey();
  return `<div class="day-strip" role="tablist">${DAYS.map((d) => `
    <button class="ds-day${d === sel ? " active" : ""}${d === today ? " today" : ""}" data-day="${d}" role="tab">
      <span class="ds-name">${d.slice(0, 1)}${d.slice(1, 2).toLowerCase()}</span>
      <span class="ds-num">${weekDateOf(d).getDate()}</span>
      <span class="ds-badge">${badges[d] || ""}</span>
    </button>`).join("")}</div>`;
}

function wireDayStrip(panel, rerender) {
  panel.querySelectorAll(".ds-day").forEach((b) => b.addEventListener("click", () => {
    phoneDay = b.dataset.day;
    rerender();
  }));
  const swipeEl = panel.querySelector(".day-swipe");
  if (!swipeEl) return;
  let x0 = null, y0 = null;
  swipeEl.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  swipeEl.addEventListener("touchend", (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const i = DAYS.indexOf(currentPhoneDay()) + (dx < 0 ? 1 : -1);
    if (i < 0 || i > 6) return;
    phoneDay = DAYS[i];
    rerender(dx < 0 ? "left" : "right");
  }, { passive: true });
}

function slideClass(dir) { return dir === "left" ? " slide-left" : dir === "right" ? " slide-right" : ""; }

// ================= SCHEDULE =================

const PX_PER_MIN = 1.1;
const DAY_START_MIN = 5 * 60; // 05:00
const DAY_END_MIN = 20 * 60; // 20:00
const HOUR_PX = 60 * PX_PER_MIN;

function parseTime(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

const TYPE_LABELS = {
  class: "Class", work: "Work", training: "Training", danish: "Danish", commute: "Commute",
};

// Uni classes only appear from schedule.classes_start onwards (the Master's start).
function classesStartISO() {
  return (state.schedule && state.schedule.classes_start) || null;
}
function classesActive() {
  const s = classesStartISO();
  return !s || todayISO() >= s;
}
// Class blocks are hidden on Today/Schedule until classes start; everything else always shows.
function blockVisible(b) {
  return b.type !== "class" || classesActive();
}
function classesHiddenNote() {
  const s = classesStartISO();
  return `<div class="mini-note">📚 Uni classes start ${formatDateEU(s)}</div>`;
}

function renderScheduleDay(dir) {
  const day = currentPhoneDay();
  const today = todayKey();
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const blocks = state.schedule.blocks
    .filter((b) => b.day === day && blockVisible(b))
    .sort((a, b) => parseTime(a.start) - parseTime(b.start));
  const counts = Object.fromEntries(DAYS.map((d) => [d, state.schedule.blocks.filter((b) => b.day === d && blockVisible(b)).length ? "•" : ""]));
  const wake = state.schedule.wake_times[day];
  const items = blocks.map((b) => {
    const isNow = day === today && !b.skipped && parseTime(b.start) <= nowMin && nowMin < parseTime(b.end);
    const isPast = day === today && parseTime(b.end) <= nowMin;
    const meta = [TYPE_LABELS[b.type] || b.type, b.room, b.teacher].filter(Boolean).map(escapeHtml).join(" · ");
    return `
      <button class="agenda-item type-${escapeAttr(b.type)}${b.skipped ? " skipped" : ""}${isNow ? " now" : ""}${isPast ? " past" : ""}" data-block-id="${b.id}">
        <span class="ag-time"><b>${escapeHtml(b.start)}</b><span>${escapeHtml(b.end)}</span></span>
        <span class="ag-body">
          <span class="ag-title">${escapeHtml(b.label)}${isNow ? ` <span class="now-chip">NOW</span>` : ""}${b.skipped ? ` <span class="ag-skip">skipped</span>` : ""}</span>
          <span class="ag-meta">${meta}</span>
        </span>
      </button>`;
  }).join("");

  const panel = document.getElementById("panel-schedule");
  panel.innerHTML = `
    <div class="phone-head">
      <h2 class="section-title">Schedule</h2>
      <div class="seg"><button class="seg-btn active" data-mode="day">Day</button><button class="seg-btn" data-mode="week">Week</button></div>
    </div>
    ${dayStripHtml(counts)}
    <div class="day-swipe${slideClass(dir)}">
      <div class="agenda-head">${DAY_FULL[day]}${day === today ? " · today" : ""}${wake ? `<span class="agenda-wake">⏰ wake ${escapeHtml(wake)}</span>` : ""}</div>
      ${!classesActive() ? `<div class="mini-note">📚 Uni classes are hidden until ${formatDateEU(classesStartISO())}</div>` : ""}
      <div class="agenda">${items || `<div class="empty-state">Nothing scheduled — free day</div>`}</div>
      <button class="add-row-btn" id="add-block-btn">+ Add block</button>
    </div>`;
  wireDayStrip(panel, renderSchedule);
  wireScheduleModeToggle(panel);
  panel.querySelectorAll(".agenda-item").forEach((el) => el.addEventListener("click", () => openBlockEditor(el.dataset.blockId)));
  panel.querySelector("#add-block-btn").addEventListener("click", () => {
    const last = blocks[blocks.length - 1];
    const start = last ? last.end : "09:00";
    const endMin = Math.min(parseTime(start) + 60, 23 * 60 + 59);
    const b = { id: genId(), day, start, end: `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`,
      type: "work", label: "New block", code: "", teacher: "", room: "", skipped: false };
    state.schedule.blocks.push(b);
    saveDebounced(200);
    renderSchedule();
    openBlockEditor(b.id);
  });
}

function wireScheduleModeToggle(panel) {
  panel.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => {
    scheduleMode = b.dataset.mode;
    renderSchedule();
  }));
}

function renderSchedule(dir) {
  if (isPhone() && scheduleMode === "day") return renderScheduleDay(dir);
  const totalMin = DAY_END_MIN - DAY_START_MIN;
  const totalPx = totalMin * PX_PER_MIN;
  const today = todayKey();

  let hourLabels = "";
  for (let h = 5; h <= 20; h++) {
    const top = (h * 60 - DAY_START_MIN) * PX_PER_MIN;
    hourLabels += `<div class="time-label" style="top:${top}px">${String(h).padStart(2, "0")}:00</div>`;
  }

  let headerCells = `<div class="corner-cell"></div>`;
  DAYS.forEach((d) => {
    const wake = state.schedule.wake_times[d];
    headerCells += `
      <div class="day-header ${d === today ? "today" : ""}">
        <div class="day-name">${d}</div>
        <div class="wake-time">${wake ? "wake " + wake : "&nbsp;"}</div>
      </div>`;
  });

  let blockIndex = 0;
  let dayCols = `<div class="time-col" style="height:${totalPx}px; --hour-px:${HOUR_PX}px">${hourLabels}</div>`;
  DAYS.forEach((d) => {
    const blocks = state.schedule.blocks.filter((b) => b.day === d && blockVisible(b));
    let blocksHtml = "";
    blocks.forEach((b) => {
      const start = parseTime(b.start);
      const end = parseTime(b.end);
      const top = (start - DAY_START_MIN) * PX_PER_MIN;
      const height = (end - start) * PX_PER_MIN;
      const skippedClass = b.skipped ? " skipped" : "";
      const delay = (blockIndex++ * 40) + "ms";
      blocksHtml += `
        <div class="block editable type-${b.type}${skippedClass}"
             style="top:${top}px; height:${height}px; animation-delay:${delay}"
             data-block-id="${b.id}"
             data-tooltip="${escapeAttr(`${b.label} · ${b.start}–${b.end}${b.room ? " · " + b.room : ""}${b.teacher ? " · " + b.teacher : ""}`)}">
          <div class="b-title">${escapeHtml(b.label)}</div>
          <div class="b-meta">${escapeHtml(b.start)}–${escapeHtml(b.end)}${b.room ? " · " + escapeHtml(b.room) : ""}</div>
        </div>`;
    });

    // current-time line on today's column
    let nowLine = "";
    if (d === today) {
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      if (nowMin >= DAY_START_MIN && nowMin <= DAY_END_MIN) {
        const top = (nowMin - DAY_START_MIN) * PX_PER_MIN;
        nowLine = `<div class="now-line" style="top:${top}px"></div>`;
      }
    }

    const weekend = d === "Sat" || d === "Sun" ? " weekend" : "";
    const todayCls = d === today ? " today" : "";
    dayCols += `<div class="day-col${weekend}${todayCls}" style="height:${totalPx}px; --hour-px:${HOUR_PX}px">${blocksHtml}${nowLine}</div>`;
  });

  const legend = Object.entries(TYPE_LABELS)
    .map(([key, label]) => `<div class="legend-item"><span class="legend-swatch" style="background:var(--${key === "work" ? "work" : key === "danish" ? "danish" : key === "commute" ? "commute" : key === "training" ? "forest" : "maroon"})"></span>${label}</div>`)
    .join("") + `<div class="legend-item"><span class="legend-swatch" style="background:repeating-linear-gradient(45deg, var(--danger), var(--danger) 3px, transparent 3px, transparent 6px)"></span>Skipped</div>`;

  const html = `
    ${isPhone()
      ? `<div class="phone-head"><h2 class="section-title">Schedule</h2><div class="seg"><button class="seg-btn" data-mode="day">Day</button><button class="seg-btn active" data-mode="week">Week</button></div></div>`
      : `<h2 class="section-title">Schedule</h2>`}
    <div class="schedule-toolbar">
      <div class="legend">${legend}</div>
      <span class="foods-hint">Tap a block to edit · add blocks & wake times in ⚙ Settings</span>
    </div>
    ${classesActive() ? "" : `<div class="mini-note" style="margin:-4px 0 12px">📚 Uni classes are hidden until they start on ${formatDateEU(classesStartISO())} — change the date in ⚙ Settings.</div>`}
    <div class="schedule-scroll"><div class="schedule-grid-wrap">
      ${headerCells}
      ${dayCols}
    </div></div>
  `;
  const panel = document.getElementById("panel-schedule");
  const prevScroll = panel.querySelector(".schedule-grid-wrap");
  const keepLeft = prevScroll ? prevScroll.scrollLeft : null;
  panel.innerHTML = html;
  wireScheduleModeToggle(panel);
  // phones: the week scrolls sideways — keep the user's position, else start at today
  const scroller = panel.querySelector(".schedule-grid-wrap");
  if (scroller.scrollWidth > scroller.clientWidth) {
    if (!scheduleScrolledToToday) {
      const todayHead = panel.querySelector(".day-header.today");
      const timeCol = panel.querySelector(".corner-cell");
      if (todayHead) scroller.scrollLeft = todayHead.offsetLeft - (timeCol ? timeCol.offsetWidth : 0);
      scheduleScrolledToToday = true;
    } else if (keepLeft != null) {
      scroller.scrollLeft = keepLeft;
    }
  }

  // tooltips
  let tooltipEl = null;
  panel.querySelectorAll(".block").forEach((el) => {
    el.addEventListener("mouseenter", (e) => {
      tooltipEl = document.createElement("div");
      tooltipEl.className = "block-tooltip";
      tooltipEl.textContent = el.dataset.tooltip;
      document.body.appendChild(tooltipEl);
      positionTooltip(e);
    });
    el.addEventListener("mousemove", positionTooltip);
    el.addEventListener("mouseleave", () => {
      if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
    });
    el.addEventListener("click", () => {
      if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
      openBlockEditor(el.dataset.blockId);
    });
  });
  function positionTooltip(e) {
    if (!tooltipEl) return;
    tooltipEl.style.left = e.clientX + 14 + "px";
    tooltipEl.style.top = e.clientY + 14 + "px";
  }
}

// ================= CALENDAR (on-device; .ics to share with Apple Calendar) =================

let calCursor = null;    // first day of the visible month
let calEvents = [];

const CAL_WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function isoDate(d) {
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}

function renderCalendar() {
  const panel = document.getElementById("panel-calendar");
  if (!calCursor) calCursor = startOfMonth(new Date());
  panel.innerHTML = calMonthShell();
  wireMonthControls(panel);
  loadAndRenderMonth(panel);
}

function calMonthShell() {
  const label = calCursor.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const head = CAL_WEEK.map((d) => `<div class="cal-dow">${d}</div>`).join("");
  return `<div class="cal-wrap">
    <div class="cal-toolbar">
      <h2 class="section-title" style="margin:0">${label}</h2>
      <div class="cal-nav">
        <button class="ghost-btn" id="cal-prev" title="Previous month">‹</button>
        <button class="ghost-btn" id="cal-today">Today</button>
        <button class="ghost-btn" id="cal-next" title="Next month">›</button>
        <label class="ghost-btn file-btn" title="Import .ics file">Import<input type="file" id="cal-import" accept=".ics,text/calendar" hidden></label>
        <button class="cal-primary" id="cal-add">+ New</button>
      </div>
    </div>
    <div class="cal-grid-head">${head}</div>
    <div class="cal-grid" id="cal-grid"><div class="cal-loading">Loading…</div></div>
  </div>`;
}

function wireMonthControls(panel) {
  panel.querySelector("#cal-prev").addEventListener("click", () => {
    calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1); renderCalendar();
  });
  panel.querySelector("#cal-next").addEventListener("click", () => {
    calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1); renderCalendar();
  });
  panel.querySelector("#cal-today").addEventListener("click", () => {
    calCursor = startOfMonth(new Date()); renderCalendar();
  });
  panel.querySelector("#cal-add").addEventListener("click", () => openEventModal(null, defaultDayISO()));
  panel.querySelector("#cal-import").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const evs = parseIcs(await f.text());
    const seen = new Set(state.calendar_events.map((x) => x.uid).filter(Boolean));
    const fresh = evs.filter((x) => !x.uid || !seen.has(x.uid));
    state.calendar_events.push(...fresh);
    saveDebounced(100);
    if (fresh[0]) calCursor = startOfMonth(new Date(fresh[0].start.slice(0, 10) + "T00:00"));
    renderCalendar();
    toast(`${fresh.length} event(s) imported`);
  });
}

function defaultDayISO() {
  const now = new Date();
  if (now.getFullYear() === calCursor.getFullYear() && now.getMonth() === calCursor.getMonth()) return isoDate(now);
  return isoDate(calCursor);
}

function monthGridStart() {
  const first = new Date(calCursor);
  const jsDow = (first.getDay() + 6) % 7; // Monday = 0
  const start = new Date(first);
  start.setDate(first.getDate() - jsDow);
  return start;
}

function loadAndRenderMonth(panel) {
  const start = monthGridStart();
  const end = new Date(start); end.setDate(start.getDate() + 42);
  const lo = isoDate(start), hi = isoDate(end);
  calEvents = (state.calendar_events || []).filter((e) => (e.end || e.start || "").slice(0, 10) >= lo && (e.start || "").slice(0, 10) < hi);

  const grid = panel.querySelector("#cal-grid");
  grid.innerHTML = calCellsHtml(start);
  if (isPhone()) return wirePhoneMonth(panel, grid);
  grid.querySelectorAll(".cal-cell").forEach((cell) => {
    cell.addEventListener("click", (e) => {
      if (e.target.closest(".cal-ev")) return;
      openEventModal(null, cell.dataset.date);
    });
  });
  grid.querySelectorAll(".cal-ev").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      openEventModal(findEvent(el.dataset.id), null);
    });
  });
}

// Phone: tap a day to select it; its events list below the month.
let calSelected = null;

function wirePhoneMonth(panel, grid) {
  if (!calSelected || calSelected.slice(0, 7) !== isoDate(calCursor).slice(0, 7)) calSelected = defaultDayISO();
  const list = document.createElement("div");
  list.className = "cal-day-list";
  grid.after(list);
  const show = () => {
    grid.querySelectorAll(".cal-cell").forEach((c) => c.classList.toggle("selected", c.dataset.date === calSelected));
    const evs = eventsForDay(calSelected);
    const [y, m, d] = calSelected.split("-").map(Number);
    const label = new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
    list.innerHTML = `
      <div class="agenda-head">${label}</div>
      <div class="agenda">${evs.map((e) => `
        <button class="agenda-item" data-id="${escapeAttr(e.id)}">
          <span class="ag-time">${e.allDay ? "<b>all-day</b>" : `<b>${escapeHtml((e.start || "").slice(11, 16))}</b><span>${escapeHtml((e.end || "").slice(11, 16))}</span>`}</span>
          <span class="ag-body"><span class="ag-title">${escapeHtml(e.title)}</span>${e.location ? `<span class="ag-meta">📍 ${escapeHtml(e.location)}</span>` : ""}</span>
        </button>`).join("") || `<div class="empty-state">No events</div>`}</div>
      <button class="add-row-btn" id="cal-add-day">+ Add event</button>`;
    list.querySelectorAll(".agenda-item").forEach((el) => el.addEventListener("click", () => openEventModal(findEvent(el.dataset.id), null)));
    list.querySelector("#cal-add-day").addEventListener("click", () => openEventModal(null, calSelected));
  };
  grid.querySelectorAll(".cal-cell").forEach((cell) => cell.addEventListener("click", () => {
    calSelected = cell.dataset.date;
    show();
  }));
  show();
}

function eventsForDay(iso) {
  return calEvents.filter((e) => {
    const s = (e.start || "").slice(0, 10);
    const en = (e.end || e.start || "").slice(0, 10);
    return s <= iso && iso <= en;
  }).sort((a, b) => (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0) || (a.start || "").localeCompare(b.start || ""));
}

function calCellsHtml(start) {
  const todayIso = todayISO();
  const cur = new Date(start);
  let html = "";
  for (let i = 0; i < 42; i++) {
    const iso = isoDate(cur);
    const other = cur.getMonth() !== calCursor.getMonth();
    const isToday = iso === todayIso;
    const evs = eventsForDay(iso);
    const chips = isPhone()
      ? `<div class="cal-dots">${evs.slice(0, 3).map(() => "<i></i>").join("")}</div>`
      : evs.slice(0, 4).map((e) => {
        const t = e.allDay ? "" : (e.start || "").slice(11, 16) + " ";
        return `<div class="cal-ev${e.allDay ? " allday" : ""}" data-id="${escapeAttr(e.id)}" style="--evc:var(--brass)" title="${escapeAttr(t + e.title)}"><span class="cal-ev-dot"></span><span class="cal-ev-t">${escapeHtml(t + e.title)}</span></div>`;
      }).join("");
    const more = !isPhone() && evs.length > 4 ? `<div class="cal-more">+${evs.length - 4} more</div>` : "";
    html += `<div class="cal-cell${other ? " other" : ""}${isToday ? " today" : ""}" data-date="${iso}">
      <div class="cal-daynum">${cur.getDate()}</div>${chips}${more}</div>`;
    cur.setDate(cur.getDate() + 1);
  }
  return html;
}

function findEvent(id) { return calEvents.find((e) => e.id === id) || null; }

function openEventModal(ev, defaultDay) {
  const overlay = document.getElementById("modal-overlay");
  const content = document.getElementById("modal-content");
  const isNew = !ev;
  const base = defaultDay || (ev && (ev.start || "").slice(0, 10)) || todayISO();
  const allDay = ev ? !!ev.allDay : false;
  const startISO = (ev && ev.start) || (base + "T09:00");
  const endISO = (ev && ev.end) || (base + "T10:00");
  const sd = startISO.slice(0, 10), st = startISO.slice(11, 16) || "09:00";
  const ed = endISO.slice(0, 10), et = endISO.slice(11, 16) || "10:00";

  content.innerHTML = `
    <h3>${isNew ? "New appointment" : "Edit appointment"}</h3>
    <div class="ev-form">
      <input type="text" id="ev-title" class="ev-title" placeholder="Title" value="${escapeAttr(ev ? ev.title : "")}">
      <label class="ev-check"><input type="checkbox" id="ev-allday" ${allDay ? "checked" : ""}> All-day</label>
      <div class="ev-when">
        <label class="be-field">Starts<div class="ev-dt"><input type="date" id="ev-sd" value="${sd}"><input type="time" id="ev-st" value="${st}"></div></label>
        <label class="be-field">Ends<div class="ev-dt"><input type="date" id="ev-ed" value="${ed}"><input type="time" id="ev-et" value="${et}"></div></label>
      </div>
      <input type="text" id="ev-loc" placeholder="Location" value="${escapeAttr(ev ? ev.location : "")}">
      <textarea id="ev-notes" placeholder="Notes" rows="3">${escapeHtml(ev ? ev.notes : "")}</textarea>
    </div>
    ${isNew ? "" : `<button class="ghost-btn ev-ics" id="ev-ics">📲 Add to iPhone Calendar</button>`}
    <div class="ev-actions">
      ${isNew ? "" : `<button class="be-delete" id="ev-delete">Delete</button>`}
      <button class="modal-close" id="ev-cancel" style="margin-top:0">Cancel</button>
      <button class="cal-primary" id="ev-save">${isNew ? "Add" : "Save"}</button>
    </div>`;
  overlay.classList.remove("hidden");

  const allDayCb = content.querySelector("#ev-allday");
  const toggleTimes = () => content.querySelectorAll("#ev-st,#ev-et").forEach((i) => { i.style.display = allDayCb.checked ? "none" : ""; });
  allDayCb.addEventListener("change", toggleTimes); toggleTimes();
  if (isNew && matchMedia("(hover: hover)").matches) content.querySelector("#ev-title").focus();

  content.querySelector("#ev-cancel").addEventListener("click", () => overlay.classList.add("hidden"));
  const del = content.querySelector("#ev-delete");
  if (del) del.addEventListener("click", () => {
    if (!confirm("Delete this appointment?")) return;
    state.calendar_events = state.calendar_events.filter((x) => x.id !== ev.id);
    saveDebounced(100);
    overlay.classList.add("hidden");
    renderCalendar();
  });
  const icsBtn = content.querySelector("#ev-ics");
  if (icsBtn) icsBtn.addEventListener("click", () => shareIcs([ev], (ev.title || "event").replace(/[^\w-]+/g, "_") + ".ics"));
  content.querySelector("#ev-save").addEventListener("click", () => {
    const isAllDay = allDayCb.checked;
    const sdv = content.querySelector("#ev-sd").value;
    const edv = content.querySelector("#ev-ed").value || sdv;
    const stv = isAllDay ? "00:00" : (content.querySelector("#ev-st").value || "09:00");
    const etv = isAllDay ? "23:59" : (content.querySelector("#ev-et").value || "10:00");
    const fields = {
      title: content.querySelector("#ev-title").value.trim() || "New event",
      start: sdv + "T" + stv, end: edv + "T" + etv, allDay: isAllDay,
      location: content.querySelector("#ev-loc").value.trim(),
      notes: content.querySelector("#ev-notes").value.trim(),
    };
    if (fields.end < fields.start) fields.end = fields.start;
    if (isNew) state.calendar_events.push({ id: genId(), ...fields });
    else Object.assign(state.calendar_events.find((x) => x.id === ev.id) || {}, fields);
    saveDebounced(100);
    overlay.classList.add("hidden");
    renderCalendar();
  });
}

// ================= WEEKLY TASKS =================

function renderTasksDay(dir) {
  const day = currentPhoneDay();
  const today = todayKey();
  const tasks = state.weekly_tasks.days[day] || [];
  const badges = Object.fromEntries(DAYS.map((d) => {
    const open = (state.weekly_tasks.days[d] || []).filter((t) => !t.done).length;
    return [d, open ? String(open) : ""];
  }));
  const done = tasks.filter((t) => t.done).length;
  const panel = document.getElementById("panel-tasks");
  panel.innerHTML = `
    <div class="phone-head">
      <h2 class="section-title">Tasks</h2>
      <button class="ghost-btn" id="reset-week-btn">Reset week</button>
    </div>
    ${dayStripHtml(badges)}
    <div class="day-swipe${slideClass(dir)}">
      <div class="agenda-head">${DAY_FULL[day]}${day === today ? " · today" : ""}<span class="agenda-wake">${tasks.length ? `${done}/${tasks.length} done` : ""}</span></div>
      <div class="card list-card">
        ${tasks.map((t) => `
          <div class="task-item ${t.done ? "done" : ""}" data-day="${day}" data-id="${t.id}">
            <span class="task-check"></span>
            <span class="task-text">${escapeHtml(t.text)}</span>
            <button class="task-del" data-day="${day}" data-id="${t.id}" aria-label="Delete">✕</button>
          </div>`).join("") || `<div class="empty-state">No tasks for ${DAY_FULL[day]}</div>`}
        <div class="task-add-row">
          <input type="text" placeholder="Add a task…" data-day="${day}" class="new-task-input" enterkeyhint="done">
          <button data-day="${day}" class="add-task-btn">+</button>
        </div>
      </div>
    </div>`;
  wireDayStrip(panel, renderTasks);
  panel.querySelectorAll(".task-item").forEach((el) => el.addEventListener("click", (e) => {
    if (e.target.closest(".task-del")) return;
    toggleTask(el.dataset.day, el.dataset.id);
    renderTasks();
  }));
  panel.querySelectorAll(".task-del").forEach((btn) => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteTask(btn.dataset.day, btn.dataset.id);
  }));
  panel.querySelector(".add-task-btn").addEventListener("click", () => addTask(day));
  panel.querySelector(".new-task-input").addEventListener("keydown", (e) => { if (e.key === "Enter") addTask(day); });
  document.getElementById("reset-week-btn").addEventListener("click", resetWeek);
}

function renderTasks(dir) {
  if (isPhone()) return renderTasksDay(dir);
  const today = todayKey();
  let cols = "";
  DAYS.forEach((d, i) => {
    const tasks = state.weekly_tasks.days[d] || [];
    let items = tasks.map((t) => `
      <div class="task-item ${t.done ? "done" : ""}" data-day="${d}" data-id="${t.id}">
        <span class="task-text">${escapeHtml(t.text)}</span>
        <button class="task-del" data-day="${d}" data-id="${t.id}">✕</button>
      </div>`).join("");
    if (!tasks.length) items = `<div class="empty-hint">No tasks</div>`;

    cols += `
      <div class="day-task-col rise ${d === today ? "today" : ""}" style="animation-delay:${i * 55}ms">
        <h3>${DAY_FULL[d]}</h3>
        <div class="task-list">${items}</div>
        <div class="task-add-row">
          <input type="text" placeholder="Add task…" data-day="${d}" class="new-task-input">
          <button data-day="${d}" class="add-task-btn">+</button>
        </div>
      </div>`;
  });

  const html = `
    <div class="tasks-toolbar">
      <h2 class="section-title" style="margin:0">Weekly tasks</h2>
      <button class="ghost-btn" id="reset-week-btn">Reset week</button>
    </div>
    <div class="tasks-grid">${cols}</div>
  `;
  const panel = document.getElementById("panel-tasks");
  panel.innerHTML = html;

  panel.querySelectorAll(".task-item .task-text").forEach((el) => {
    el.addEventListener("click", () => {
      const parent = el.closest(".task-item");
      toggleTask(parent.dataset.day, parent.dataset.id);
    });
  });
  panel.querySelectorAll(".task-del").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteTask(btn.dataset.day, btn.dataset.id);
    });
  });
  panel.querySelectorAll(".add-task-btn").forEach((btn) => {
    btn.addEventListener("click", () => addTask(btn.dataset.day));
  });
  panel.querySelectorAll(".new-task-input").forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addTask(input.dataset.day);
    });
  });
  document.getElementById("reset-week-btn").addEventListener("click", resetWeek);
}

function toggleTask(day, id) {
  const t = state.weekly_tasks.days[day].find((x) => x.id === id);
  if (t) t.done = !t.done;
  const el = document.querySelector(`#panel-tasks .task-item[data-day="${day}"][data-id="${id}"]`);
  if (el) el.classList.toggle("done", t.done);
  saveDebounced(200);
}

function deleteTask(day, id) {
  state.weekly_tasks.days[day] = state.weekly_tasks.days[day].filter((x) => x.id !== id);
  renderTasks();
  saveDebounced(200);
}

function addTask(day) {
  const input = document.querySelector(`.new-task-input[data-day="${day}"]`);
  const text = input.value.trim();
  if (!text) return;
  state.weekly_tasks.days[day].push({ id: genId(), text, done: false });
  input.value = "";
  renderTasks();
  saveDebounced(200);
  document.querySelector(`.new-task-input[data-day="${day}"]`).focus();
}

function resetWeek() {
  if (!confirm("Archive this week's completed tasks and clear all checkmarks?")) return;
  const snapshot = { archived_at: new Date().toISOString(), days: JSON.parse(JSON.stringify(state.weekly_tasks.days)) };
  state.weekly_tasks.archive.push(snapshot);
  DAYS.forEach((d) => {
    state.weekly_tasks.days[d].forEach((t) => (t.done = false));
  });
  renderTasks();
  saveNow();
}

// ================= MASTER'S =================

function renderMasters() {
  const deadlines = upcomingDeadlines();
  const deadlinesHtml = deadlines.length ? `
    <div class="card deadlines-card rise">
      <h3>Upcoming deadlines</h3>
      <div class="deadlines-row">
        ${deadlines.slice(0, 8).map((d) => `
          <div class="deadline-item">
            ${deadlineChip(d.days)}
            <span class="dl-course">${escapeHtml(d.course.code)}</span>
            <span class="dl-title">${escapeHtml(d.assignment.title)}</span>
            <span class="dl-date">${formatDateEU(d.assignment.due)}</span>
          </div>`).join("")}
      </div>
    </div>` : "";

  const cards = state.courses.map((course, i) => {
    const total = course.assignments.length;
    const done = course.assignments.filter((a) => a.done).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const r = 26;
    const circumference = 2 * Math.PI * r;

    const assignmentsHtml = course.assignments.length
      ? course.assignments.map((a) => `
        <div class="assignment-item ${a.done ? "done" : ""}" data-course="${course.id}" data-a="${a.id}">
          <span class="a-title">${escapeHtml(a.title)}</span>
          <span class="a-due">${a.due ? formatDateEU(a.due) : ""}</span>
          <button class="a-del" data-course="${course.id}" data-a="${a.id}">✕</button>
        </div>`).join("")
      : `<div class="empty-hint">No assignments yet</div>`;

    return `
      <div class="course-card rise" style="animation-delay:${i * 70}ms">
        <div class="course-head">
          <div class="course-info">
            <h3>${escapeHtml(course.title)}</h3>
            <div class="course-meta">${course.code} · ${course.ects} ECTS · ${escapeHtml(course.teacher)}</div>
          </div>
          <div class="ring-wrap">
            <svg viewBox="0 0 64 64" width="64" height="64">
              <defs>
                <linearGradient id="ring-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#a2452e"/>
                  <stop offset="100%" stop-color="#7A2E2E"/>
                </linearGradient>
              </defs>
              <circle class="ring-bg" cx="32" cy="32" r="${r}"></circle>
              <circle class="ring-fg" cx="32" cy="32" r="${r}"
                stroke-dasharray="${circumference}"
                stroke-dashoffset="${circumference}"
                data-target-offset="${circumference * (1 - pct / 100)}"></circle>
            </svg>
            <div class="ring-label" data-pct="${pct}">0%</div>
          </div>
        </div>
        <div class="assignment-list">${assignmentsHtml}</div>
        <div class="add-assignment-row">
          <input type="text" class="a-title-input" placeholder="Assignment title…" data-course="${course.id}">
          <input type="date" class="a-date-input" data-course="${course.id}">
          <button class="add-assignment-btn" data-course="${course.id}">Add</button>
        </div>
      </div>`;
  }).join("");

  const panel = document.getElementById("panel-masters");
  panel.innerHTML = `<h2 class="section-title">Master's</h2>${deadlinesHtml}<div class="masters-grid">${cards}</div>`;

  panel.querySelectorAll(".assignment-item .a-title").forEach((el) => {
    el.addEventListener("click", () => {
      const parent = el.closest(".assignment-item");
      toggleAssignment(parent.dataset.course, parent.dataset.a);
    });
  });
  panel.querySelectorAll(".a-del").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteAssignment(btn.dataset.course, btn.dataset.a);
    });
  });
  panel.querySelectorAll(".add-assignment-btn").forEach((btn) => {
    btn.addEventListener("click", () => addAssignment(btn.dataset.course));
  });

  // animate rings + % labels on load
  requestAnimationFrame(() => {
    panel.querySelectorAll(".ring-fg").forEach((circle) => {
      const target = circle.dataset.targetOffset;
      requestAnimationFrame(() => { circle.style.strokeDashoffset = target; });
    });
    panel.querySelectorAll(".ring-label").forEach((label) => {
      animateNumber(label, Number(label.dataset.pct), (v) => Math.round(v) + "%", 1000);
    });
  });
}

function toggleAssignment(courseId, aId) {
  const course = state.courses.find((c) => c.id === courseId);
  const a = course.assignments.find((x) => x.id === aId);
  if (a) a.done = !a.done;
  renderMasters();
  saveDebounced(200);
}

function deleteAssignment(courseId, aId) {
  const course = state.courses.find((c) => c.id === courseId);
  course.assignments = course.assignments.filter((x) => x.id !== aId);
  renderMasters();
  saveDebounced(200);
}

function addAssignment(courseId) {
  const titleInput = document.querySelector(`.a-title-input[data-course="${courseId}"]`);
  const dateInput = document.querySelector(`.a-date-input[data-course="${courseId}"]`);
  const title = titleInput.value.trim();
  if (!title) return;
  const course = state.courses.find((c) => c.id === courseId);
  course.assignments.push({ id: genId(), title, due: dateInput.value || "", done: false });
  renderMasters();
  saveDebounced(200);
}

// ================= SETTINGS =================

const BLOCK_TYPES = ["class", "work", "training", "danish", "commute"];

function renderSettings() {
  const panel = document.getElementById("panel-settings");

  if (!settingsUnlocked) {
    const hasPin = !!(state.config && state.config.settings_pin_hash);
    panel.innerHTML = `
      <div class="card settings-lock" id="settings-lock">
        <span class="lock-icon">🔒</span>
        <h3>${hasPin ? "Settings are locked" : "Set a Settings PIN"}</h3>
        <p>${hasPin
          ? "Enter your PIN to edit schedules, courses and wake times."
          : "Choose a PIN (4+ digits) that protects schedules, courses and wake times on this device."}</p>
        <div class="lock-form">
          <input type="password" id="settings-pw" placeholder="••••••" maxlength="12" autocomplete="off" inputmode="numeric">
          <button id="settings-unlock-btn">${hasPin ? "Unlock" : "Set PIN"}</button>
        </div>
        <div class="lock-error" id="lock-error"></div>
      </div>
    `;
    const pwInput = panel.querySelector("#settings-pw");
    const fail = (msg) => {
      const lock = panel.querySelector("#settings-lock");
      panel.querySelector("#lock-error").textContent = msg;
      lock.classList.remove("shake");
      void lock.offsetWidth;
      lock.classList.add("shake");
      pwInput.value = "";
      pwInput.focus();
    };
    const tryUnlock = async () => {
      const pin = pwInput.value.trim();
      if (!hasPin) {
        if (pin.length < 4) return fail("Use at least 4 characters");
        state.config.settings_pin_hash = await hashPin(pin);
        saveNow();
        settingsUnlocked = true;
        renderSettings();
      } else if ((await hashPin(pin)) === state.config.settings_pin_hash) {
        settingsUnlocked = true;
        renderSettings();
      } else {
        fail("Wrong PIN");
      }
    };
    panel.querySelector("#settings-unlock-btn").addEventListener("click", tryUnlock);
    pwInput.addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });
    return;
  }

  // ---------- unlocked ----------

  // wake times
  const wakeCells = DAYS.map((d) => `
    <div class="wake-cell">
      <label>${d}</label>
      <input type="time" value="${state.schedule.wake_times[d] || ""}" data-day="${d}" class="wake-input">
    </div>`).join("");

  // schedule blocks (sorted by day then start)
  const dayOrder = Object.fromEntries(DAYS.map((d, i) => [d, i]));
  const sortedBlocks = [...state.schedule.blocks].sort((a, b) =>
    (dayOrder[a.day] - dayOrder[b.day]) || (parseTime(a.start) - parseTime(b.start)));
  const schedRows = sortedBlocks.map((b) => `
    <div class="sched-row type-strip t-${b.type}" data-id="${b.id}">
      <select data-id="${b.id}" data-field="day" class="sched-input">
        ${DAYS.map((d) => `<option value="${d}" ${b.day === d ? "selected" : ""}>${d}</option>`).join("")}
      </select>
      <input type="time" value="${b.start}" data-id="${b.id}" data-field="start" class="sched-input">
      <input type="time" value="${b.end}" data-id="${b.id}" data-field="end" class="sched-input">
      <select data-id="${b.id}" data-field="type" class="sched-input">
        ${BLOCK_TYPES.map((t) => `<option value="${t}" ${b.type === t ? "selected" : ""}>${TYPE_LABELS[t]}</option>`).join("")}
      </select>
      <input type="text" value="${escapeAttr(b.label)}" data-id="${b.id}" data-field="label" class="sched-input" placeholder="Label">
      <input type="text" value="${escapeAttr(b.room || "")}" data-id="${b.id}" data-field="room" class="sched-input" placeholder="Room">
      <input type="text" value="${escapeAttr(b.teacher || "")}" data-id="${b.id}" data-field="teacher" class="sched-input" placeholder="Teacher">
      <input type="checkbox" ${b.skipped ? "checked" : ""} data-id="${b.id}" data-field="skipped" class="sched-input sched-skip" title="Skipped (hatched)">
      <button class="sched-del" data-id="${b.id}">✕</button>
    </div>`).join("");

  // courses
  const courseRows = state.courses.map((c) => `
    <div class="course-row" data-id="${c.id}">
      <input type="text" value="${escapeAttr(c.title)}" data-id="${c.id}" data-field="title" class="course-input">
      <input type="text" value="${escapeAttr(c.code)}" data-id="${c.id}" data-field="code" class="course-input">
      <input type="number" value="${c.ects}" data-id="${c.id}" data-field="ects" class="course-input course-num">
      <input type="text" value="${escapeAttr(c.teacher)}" data-id="${c.id}" data-field="teacher" class="course-input">
      <input type="text" value="${escapeAttr(c.room || "")}" data-id="${c.id}" data-field="room" class="course-input">
      <button class="course-del" data-id="${c.id}">✕</button>
    </div>`).join("");

  panel.innerHTML = `
    <div class="settings-toolbar">
      <h2 class="section-title" style="margin:0">Settings</h2>
      <button class="ghost-btn" id="settings-lock-btn">🔒 Lock</button>
    </div>

    <div class="card settings-section rise">
      <h3>Wake-up times</h3>
      <p class="section-hint">Shown on the schedule day headers and the Today tab. Leave empty for none.</p>
      <div class="wake-grid">${wakeCells}</div>
    </div>

    <div class="card settings-section rise" style="animation-delay:50ms">
      <h3>Schedule blocks</h3>
      <p class="section-hint">Classes, work, training, Danish and commutes — the weekly time-grid is drawn from these. "Skipped" draws a block hatched (mandatory but not attended).</p>
      <div class="classes-start-row">
        <label for="classes-start-input">Uni classes start on</label>
        <input type="date" id="classes-start-input" value="${escapeAttr(state.schedule.classes_start || "")}">
        <span class="section-hint" style="margin:0">Class blocks stay hidden on Today &amp; Schedule until this date.</span>
      </div>
      <div class="sched-head">
        <span>Day</span><span>Start</span><span>End</span><span>Type</span><span>Label</span><span>Room</span><span>Teacher</span><span style="text-align:center">Skip</span><span></span>
      </div>
      <div class="sched-list">${schedRows}</div>
      <button class="add-row-btn" id="add-block-btn">+ Add schedule block</button>
    </div>

    <div class="card settings-section rise" style="animation-delay:100ms">
      <h3>Courses</h3>
      <p class="section-hint">The Master's tab cards. Assignments are managed on the Master's tab itself.</p>
      <div class="courses-head">
        <span>Title</span><span>Code</span><span>ECTS</span><span>Teacher</span><span>Room</span><span></span>
      </div>
      ${courseRows}
      <button class="add-row-btn" id="add-course-btn">+ Add course</button>
    </div>
  `;

  wireSettingsEvents(panel);
}

function wireSettingsEvents(panel) {
  panel.querySelector("#settings-lock-btn").addEventListener("click", () => {
    settingsUnlocked = false;
    renderSettings();
  });

  // ---- uni classes start date ----
  const csInput = panel.querySelector("#classes-start-input");
  if (csInput) {
    csInput.addEventListener("change", () => {
      state.schedule.classes_start = csInput.value || null;
      saveDebounced(300);
      renderToday();
      renderSchedule();
    });
  }

  // ---- wake times ----
  panel.querySelectorAll(".wake-input").forEach((input) => {
    input.addEventListener("change", () => {
      state.schedule.wake_times[input.dataset.day] = input.value || null;
      saveDebounced(300);
    });
  });

  // ---- schedule blocks ----
  panel.querySelectorAll(".sched-input").forEach((input) => {
    const handler = () => {
      const b = state.schedule.blocks.find((x) => x.id === input.dataset.id);
      if (!b) return;
      const field = input.dataset.field;
      if (field === "skipped") b.skipped = input.checked;
      else b[field] = input.value;
      saveDebounced(400);
      // day/type/skipped changes re-sort or restyle the list
      if (["day", "type", "skipped"].includes(field)) renderSettings();
    };
    input.addEventListener(input.tagName === "SELECT" || input.type === "checkbox" || input.type === "time" ? "change" : "input", handler);
  });
  panel.querySelectorAll(".sched-del").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.schedule.blocks = state.schedule.blocks.filter((x) => x.id !== btn.dataset.id);
      renderSettings();
      saveDebounced(200);
    });
  });
  panel.querySelector("#add-block-btn").addEventListener("click", () => {
    state.schedule.blocks.push({
      id: genId(), day: "Mon", start: "08:00", end: "09:00",
      type: "class", label: "New block", code: "", teacher: "", room: "", skipped: false,
    });
    renderSettings();
    saveDebounced(200);
  });

  // ---- courses ----
  panel.querySelectorAll(".course-input").forEach((input) => {
    input.addEventListener("input", () => {
      const c = state.courses.find((x) => x.id === input.dataset.id);
      if (!c) return;
      const field = input.dataset.field;
      c[field] = field === "ects" ? Number(input.value) || 0 : input.value;
      saveDebounced(500);
    });
  });
  panel.querySelectorAll(".course-del").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = state.courses.find((x) => x.id === btn.dataset.id);
      if (!c) return;
      if (!confirm(`Delete course "${c.title}" and its ${c.assignments.length} assignment(s)?`)) return;
      state.courses = state.courses.filter((x) => x.id !== btn.dataset.id);
      renderSettings();
      saveDebounced(200);
    });
  });
  panel.querySelector("#add-course-btn").addEventListener("click", () => {
    state.courses.push({ id: genId(), title: "New course", code: "", ects: 5, teacher: "", room: "", assignments: [] });
    renderSettings();
    saveDebounced(200);
  });
}

// ================= Version history modal =================

async function openVersionsModal() {
  const versions = await storeListVersions();
  const overlay = document.getElementById("modal-overlay");
  const content = document.getElementById("modal-content");
  const rows = versions.length
    ? versions.map((v) => `
      <div class="version-row">
        <span>${v.timestamp.replace("_", " ").replace(/-(\d\d)-(\d\d)$/, ":$1:$2")}</span>
        <button data-filename="${v.filename}">Restore</button>
      </div>`).join("")
    : `<div class="empty-hint">No snapshots yet</div>`;
  content.innerHTML = `
    <h3>Data &amp; history</h3>
    <p class="section-hint">Everything is stored on this device only. Export a backup now and then — it's your safety net if the phone is lost or reset.</p>
    <div class="data-actions">
      <button class="ghost-btn" id="backup-btn">📦 Export backup</button>
      <label class="ghost-btn file-btn">📥 Import data file<input type="file" id="import-file" accept=".json,application/json" hidden></label>
    </div>
    <div class="section-hint" id="data-result"></div>
    <h3 style="margin-top:18px">Snapshots</h3>
    <div class="versions-list">${rows}</div>
    <button class="modal-close" id="modal-close-btn">Close</button>
  `;
  overlay.classList.remove("hidden");
  const out = content.querySelector("#data-result");
  content.querySelector("#backup-btn").addEventListener("click", async () => {
    try {
      const r = await storeExportBackup(state);
      out.textContent = r.ok ? "✓ Exported " + r.name : "";
    } catch (e) {
      out.textContent = "Backup failed: " + e.message;
    }
  });
  content.querySelector("#import-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const obj = JSON.parse(await f.text());
      if (!confirm(`Replace all data on this device with "${f.name}"? A snapshot of the current data is kept.`)) return;
      await storeSave(state, { snapshot: "force" });
      state = await storeImportData(obj);
      applyTheme(state.config.theme || "light");
      overlay.classList.add("hidden");
      renderAll();
      toast("Data imported");
    } catch (err) {
      out.textContent = "✗ " + err.message;
    }
  });
  content.querySelectorAll("button[data-filename]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const label = btn.parentElement.querySelector("span").textContent;
      if (!confirm(`Restore snapshot from ${label}? This replaces current data.`)) return;
      state = await storeRestoreVersion(btn.dataset.filename);
      overlay.classList.add("hidden");
      renderAll();
    });
  });
  document.getElementById("modal-close-btn").addEventListener("click", () => overlay.classList.add("hidden"));
}

// ================= Block quick-editor =================

// Click-to-edit popup for a single schedule block (from Today or the Schedule grid).
function openBlockEditor(id) {
  const b = state.schedule.blocks.find((x) => x.id === id);
  if (!b) return;
  const overlay = document.getElementById("modal-overlay");
  const content = document.getElementById("modal-content");
  const daySel = DAYS.map((d) => `<option value="${d}" ${b.day === d ? "selected" : ""}>${DAY_FULL[d]}</option>`).join("");
  const typeSel = BLOCK_TYPES.map((t) => `<option value="${t}" ${b.type === t ? "selected" : ""}>${TYPE_LABELS[t]}</option>`).join("");
  content.innerHTML = `
    <h3>Edit block</h3>
    <div class="block-edit-form">
      <label class="be-field">Day<select data-f="day">${daySel}</select></label>
      <div class="be-times">
        <label class="be-field">Start<input type="time" data-f="start" value="${b.start}"></label>
        <label class="be-field">End<input type="time" data-f="end" value="${b.end}"></label>
      </div>
      <label class="be-field">Type<select data-f="type">${typeSel}</select></label>
      <label class="be-field">Label<input type="text" data-f="label" value="${escapeAttr(b.label)}" placeholder="Label"></label>
      <label class="be-field">Room<input type="text" data-f="room" value="${escapeAttr(b.room || "")}" placeholder="Room"></label>
      <label class="be-field">Teacher<input type="text" data-f="teacher" value="${escapeAttr(b.teacher || "")}" placeholder="Teacher"></label>
      <label class="be-check"><input type="checkbox" data-f="skipped" ${b.skipped ? "checked" : ""}> Skipped (mandatory but not attended)</label>
    </div>
    <div class="block-edit-actions">
      <button class="be-delete" id="be-delete">Delete</button>
      <button class="modal-close" id="be-done">Done</button>
    </div>
  `;
  overlay.classList.remove("hidden");
  const rerender = () => { renderSchedule(); renderToday(); };
  content.querySelectorAll("[data-f]").forEach((input) => {
    const ev = input.tagName === "SELECT" || input.type === "checkbox" || input.type === "time" ? "change" : "input";
    input.addEventListener(ev, () => {
      const f = input.dataset.f;
      if (f === "skipped") b.skipped = input.checked;
      else b[f] = input.value;
      saveDebounced(300);
      rerender();
    });
  });
  content.querySelector("#be-delete").addEventListener("click", () => {
    if (!confirm(`Delete "${b.label || "this block"}"?`)) return;
    state.schedule.blocks = state.schedule.blocks.filter((x) => x.id !== id);
    overlay.classList.add("hidden");
    saveDebounced(200);
    rerender();
  });
  content.querySelector("#be-done").addEventListener("click", () => overlay.classList.add("hidden"));
}

// ================= Utilities =================

function toast(msg) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2600);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}
function todayISO() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}
function formatDateEU(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// ================= Init =================

function renderAll() {
  renderToday();
  renderSchedule();
  renderTasks();
  renderMasters();
  renderSettings();
}

async function init() {
  initTabs();
  initClock();
  await loadData();
  applyTheme((state.config && state.config.theme) || "light");
  renderAll();
  document.getElementById("version-badge").textContent = "v" + APP_VERSION;
  // back from a Google sign-in redirect → run the inbox check right away
  if (consumeOAuthRedirect()) checkInbox();
  // iOS may suspend the app mid-debounce: flush pending edits when it's hidden
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && saveTimer) saveNow();
    if (document.visibilityState === "visible" && state && rolloverLedger(state)) { saveNow(); renderAll(); }
  });
  window.addEventListener("pagehide", () => { if (saveTimer) saveNow(); });
  // refresh the now-line / NOW chip every minute
  setInterval(() => {
    if (document.getElementById("panel-schedule").classList.contains("active")) renderSchedule();
    if (document.getElementById("panel-today").classList.contains("active")) renderToday();
  }, 60000);
  document.getElementById("versions-btn").addEventListener("click", openVersionsModal);
  document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
  document.getElementById("review-btn").addEventListener("click", openReviewModal);
  document.getElementById("modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "modal-overlay") e.target.classList.add("hidden");
  });
}

init();


// ================= THEME =================

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
}

function toggleTheme() {
  const t = state.config.theme === "dark" ? "light" : "dark";
  state.config.theme = t;
  applyTheme(t);
  saveDebounced(300);
}

// ================= WEEKLY REVIEW =================

function isoWeekNum(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
}

function openReviewModal() {
  const overlay = document.getElementById("modal-overlay");
  const content = document.getElementById("modal-content");

  let taskTotal = 0, taskDone = 0;
  DAYS.forEach((d) => {
    (state.weekly_tasks.days[d] || []).forEach((t) => {
      taskTotal++;
      if (t.done) taskDone++;
    });
  });
  const taskPct = taskTotal ? Math.round((taskDone / taskTotal) * 100) : 0;

  const deadlines7 = upcomingDeadlines().filter((d) => d.days >= 0 && d.days <= 7);
  const nearest = deadlines7[0];

  content.innerHTML = `
    <div class="review-modal">
      <h3>Weekly review</h3>
      <div class="review-week">Week ${isoWeekNum(new Date())} · ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</div>
      <div class="review-stat">
        <span class="rs-icon">✅</span>
        <div class="rs-body"><div class="rs-value">${taskDone}/${taskTotal} tasks · ${taskPct}%</div><div class="rs-label">completed this week</div></div>
      </div>
      <div class="review-stat">
        <span class="rs-icon">📚</span>
        <div class="rs-body"><div class="rs-value">${deadlines7.length} deadline${deadlines7.length === 1 ? "" : "s"} in the next 7 days</div><div class="rs-label">${nearest ? `next: ${escapeHtml(nearest.course.code)} — ${escapeHtml(nearest.assignment.title)} (${formatDateEU(nearest.assignment.due)})` : "nothing due — clear week ahead"}</div></div>
      </div>
      <button class="review-archive-btn" id="review-archive-btn">Archive week & reset checkmarks</button>
      <button class="modal-close" id="review-close-btn">Close</button>
    </div>
  `;
  overlay.classList.remove("hidden");

  content.querySelector("#review-archive-btn").addEventListener("click", () => {
    if (!confirm("Archive this week's tasks and clear all checkmarks?")) return;
    const snapshot = { archived_at: new Date().toISOString(), days: JSON.parse(JSON.stringify(state.weekly_tasks.days)) };
    state.weekly_tasks.archive.push(snapshot);
    DAYS.forEach((d) => state.weekly_tasks.days[d].forEach((t) => (t.done = false)));
    saveNow();
    renderTasks();
    renderToday();
    overlay.classList.add("hidden");
  });
  content.querySelector("#review-close-btn").addEventListener("click", () => overlay.classList.add("hidden"));
}
