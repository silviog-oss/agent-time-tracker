// ============================================================
//  Shift — Agent Time Tracking
//  Static frontend (GitHub Pages) + Firebase Auth + Firestore
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, serverTimestamp, Timestamp, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import { firebaseConfig, ALLOWED_EMAIL_DOMAIN, SUPER_ADMIN_EMAILS } from "./config.js?v=2";

const isSuperAdminEmail = (email) =>
  (SUPER_ADMIN_EMAILS || []).map((e) => e.toLowerCase()).includes((email || "").toLowerCase());

// ---------- Init ----------
const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);
const provider = new GoogleAuthProvider();

const C = {
  users:      collection(db, "users"),
  sessions:   collection(db, "sessions"),
  lunches:    collection(db, "lunches"),
  activities: collection(db, "activities"),
  tasks:      collection(db, "tasks"),
};

// ---------- Global state ----------
let ME = null;              // { uid, name, email, photo, role }
let ROUTE = "dashboard";    // active view id
let tickHandler = null;     // function called every second by the global interval
let unsubscribers = [];     // onSnapshot cleanups for the current view

// ---------- Element refs ----------
const $ = (id) => document.getElementById(id);
const splash   = $("splash");
const loginScr = $("login-screen");
const appEl    = $("app");
const viewEl   = $("view");
const navEl    = $("nav");
const titleEl  = $("view-title");

// ============================================================
//  Utilities
// ============================================================
const ms = (ts) => (ts && typeof ts.toMillis === "function") ? ts.toMillis() : null;

function todayKey(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function dateKeyFromMs(m) { return todayKey(new Date(m)); }

function fmtClock(m) {
  if (!m) return "—";
  return new Date(m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtDate(key) {
  const [y, mo, d] = key.split("-").map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
// "6h 12m"  (rounds to minutes)
function fmtHM(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}
// "6:12:04"  (live ticking)
function fmtClockDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
function greetWord() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
let toastTimer;
function toast(msg, isErr = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2800);
}

// ============================================================
//  Auth
// ============================================================
$("google-signin-btn").addEventListener("click", async () => {
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e.code !== "auth/popup-closed-by-user") toast("Sign-in failed: " + e.message, true);
  }
});
$("signout-btn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  clearView();
  if (!user) {
    ME = null;
    splash.classList.add("hidden");
    appEl.classList.add("hidden");
    loginScr.classList.remove("hidden");
    return;
  }

  // Optional domain restriction
  if (ALLOWED_EMAIL_DOMAIN && !user.email.endsWith("@" + ALLOWED_EMAIL_DOMAIN)) {
    toast(`Only @${ALLOWED_EMAIL_DOMAIN} accounts are allowed.`, true);
    await signOut(auth);
    return;
  }

  ME = await bootstrapUser(user);
  loginScr.classList.add("hidden");
  splash.classList.add("hidden");
  appEl.classList.remove("hidden");
  renderShell();
  go(ME.role === "admin" ? "dashboard" : "dashboard");
});

// Create or read the user's profile doc.
async function bootstrapUser(user) {
  const ref = doc(C.users, user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    const data = {
      uid: user.uid,
      google_id: user.uid,
      name: user.displayName || user.email,
      email: user.email,
      profile_picture: user.photoURL || "",
      role: "agent",
      created_at: serverTimestamp(),
    };
    await setDoc(ref, data);
    // New users must be created as 'agent' (rules enforce this). If this is a
    // configured super admin, promote right after — allowed because the rules
    // grant them admin by email.
    if (isSuperAdminEmail(user.email)) {
      await updateDoc(ref, { role: "admin" });
      data.role = "admin";
    }
    return { ...data };
  }
  const d = snap.data();
  // Keep profile fresh from Google (name/photo may change).
  const patch = {};
  if (d.name !== user.displayName && user.displayName) patch.name = user.displayName;
  if (d.profile_picture !== user.photoURL && user.photoURL) patch.profile_picture = user.photoURL;
  // Auto-promote configured super admins (rules also grant them admin by email).
  if (isSuperAdminEmail(user.email) && d.role !== "admin") patch.role = "admin";
  if (Object.keys(patch).length) await updateDoc(ref, patch);
  return { ...d, ...patch };
}

// ============================================================
//  App shell + navigation
// ============================================================
const NAV = {
  agent: [
    ["dashboard", "Dashboard", icon("grid")],
    ["my-tasks", "My Tasks", icon("check")],
    ["my-activity", "My Activity", icon("list")],
    ["my-time", "My Time", icon("clock")],
    ["profile", "Profile", icon("user")],
  ],
  admin: [
    ["dashboard", "Dashboard", icon("grid")],
    ["agents", "Agents", icon("users")],
    ["tasks", "Tasks", icon("check")],
    ["activity", "Activity", icon("list")],
    ["reports", "Time Reports", icon("chart")],
    ["settings", "Settings", icon("cog")],
  ],
};

function renderShell() {
  $("side-avatar").src = ME.profile_picture || fallbackAvatar(ME.name);
  $("side-avatar").onerror = () => { $("side-avatar").src = fallbackAvatar(ME.name); };
  $("side-name").textContent = ME.name;
  $("side-role").textContent = ME.role;
  const items = NAV[ME.role] || NAV.agent;
  navEl.innerHTML = items.map(([id, label, ic]) =>
    `<button class="nav-item" data-route="${id}">${ic}<span>${label}</span></button>`
  ).join("");
  navEl.querySelectorAll(".nav-item").forEach((b) =>
    b.addEventListener("click", () => { go(b.dataset.route); closeMobileNav(); })
  );
}

// mobile nav
$("menu-toggle").addEventListener("click", () => appEl.classList.toggle("nav-open"));
$("scrim").addEventListener("click", closeMobileNav);
function closeMobileNav() { appEl.classList.remove("nav-open"); }

// topbar clock
setInterval(() => {
  const el = $("topbar-clock");
  if (el) el.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}, 1000);

function go(route) {
  ROUTE = route;
  navEl.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.route === route));
  render();
}

// ============================================================
//  Global 1-second tick (updates live timers only)
// ============================================================
setInterval(() => { if (tickHandler) try { tickHandler(); } catch (_) {} }, 1000);

function clearView() {
  tickHandler = null;
  unsubscribers.forEach((u) => { try { u(); } catch (_) {} });
  unsubscribers = [];
}

// ============================================================
//  Data layer
// ============================================================
async function getDocsArr(q) {
  const s = await getDocs(q);
  return s.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// All of a user's records for a given day
async function loadDay(uid, dayKey) {
  const [sessions, lunches, activities] = await Promise.all([
    getDocsArr(query(C.sessions, where("user_id", "==", uid), where("date", "==", dayKey))),
    getDocsArr(query(C.lunches, where("user_id", "==", uid), where("date", "==", dayKey))),
    getDocsArr(query(C.activities, where("user_id", "==", uid), where("date", "==", dayKey))),
  ]);
  return { sessions, lunches, activities };
}

// Compute derived status from a day's records.
function deriveStatus({ sessions, lunches, activities }) {
  const now = Date.now();
  const openSession = sessions.find((s) => !s.clock_out) || null;
  let status = "out";
  let openLunch = null;
  if (openSession) {
    openLunch = lunches.find((l) => l.session_id === openSession.id && !l.end_time) || null;
    status = openLunch ? "lunch" : "working";
  }
  const openActivity = activities.find((a) => !a.end_time) || null;

  // lunch seconds inside a session
  const lunchSecFor = (sid) => lunches
    .filter((l) => l.session_id === sid)
    .reduce((t, l) => t + ((l.end_time ? ms(l.end_time) : now) - ms(l.start_time)) / 1000, 0);

  // worked seconds for a session (excludes lunch)
  const workedSecFor = (s) => {
    const end = s.clock_out ? ms(s.clock_out) : now;
    return Math.max(0, (end - ms(s.clock_in)) / 1000 - lunchSecFor(s.id));
  };

  const totalWorkedSec = sessions.reduce((t, s) => t + workedSecFor(s), 0);
  const totalLunchSec = lunches.reduce(
    (t, l) => t + ((l.end_time ? ms(l.end_time) : now) - ms(l.start_time)) / 1000, 0);

  return {
    status, openSession, openLunch, openActivity,
    totalWorkedSec, totalLunchSec, workedSecFor, lunchSecFor,
  };
}

// ---------- Actions ----------
async function clockIn() {
  const day = todayKey();
  const { sessions } = await loadDay(ME.uid, day);
  if (sessions.some((s) => !s.clock_out)) { toast("You're already clocked in.", true); return refreshAgent(); }
  await addDoc(C.sessions, {
    user_id: ME.uid, user_name: ME.name, user_email: ME.email,
    clock_in: Timestamp.now(), clock_out: null, total_work_time: 0,
    date: day, created_at: serverTimestamp(),
  });
  toast("Clocked in");
  refreshAgent();
}

async function clockOut() {
  const day = todayKey();
  const data = await loadDay(ME.uid, day);
  const st = deriveStatus(data);
  if (!st.openSession) { toast("You're not clocked in.", true); return refreshAgent(); }

  // Close any open activity first (auto-end on clock out).
  if (st.openActivity) {
    await endActivityDoc(st.openActivity);
    toast("Ended active activity and clocked out");
  }
  // Close any open lunch.
  if (st.openLunch) await endLunchDoc(st.openLunch);

  const worked = st.workedSecFor(st.openSession);
  await updateDoc(doc(C.sessions, st.openSession.id), {
    clock_out: Timestamp.now(),
    total_work_time: Math.round(worked),
  });
  if (!st.openActivity) toast("Clocked out");
  refreshAgent();
}

async function startLunch() {
  const day = todayKey();
  const data = await loadDay(ME.uid, day);
  const st = deriveStatus(data);
  if (!st.openSession) { toast("Clock in before starting lunch.", true); return refreshAgent(); }
  if (st.openLunch) { toast("You're already on lunch.", true); return refreshAgent(); }
  // Pause any active activity during lunch.
  if (st.openActivity) await endActivityDoc(st.openActivity);
  await addDoc(C.lunches, {
    user_id: ME.uid, session_id: st.openSession.id,
    start_time: Timestamp.now(), end_time: null, duration: 0, date: day,
  });
  toast("Lunch started");
  refreshAgent();
}

async function endLunch() {
  const day = todayKey();
  const data = await loadDay(ME.uid, day);
  const st = deriveStatus(data);
  if (!st.openLunch) { toast("You're not on lunch.", true); return refreshAgent(); }
  await endLunchDoc(st.openLunch);
  toast("Back to work");
  refreshAgent();
}
async function endLunchDoc(l) {
  const now = Timestamp.now();
  const dur = Math.round((now.toMillis() - ms(l.start_time)) / 1000);
  await updateDoc(doc(C.lunches, l.id), { end_time: now, duration: dur });
}

async function startActivity(text) {
  const desc = (text || "").trim();
  if (!desc) { toast("Type what you're working on first.", true); return; }
  const day = todayKey();
  const data = await loadDay(ME.uid, day);
  const st = deriveStatus(data);
  if (!st.openSession) { toast("Clock in before logging an activity.", true); return refreshAgent(); }
  if (st.openLunch) { toast("You're on lunch — end lunch first.", true); return refreshAgent(); }
  if (st.openActivity) { toast("End the current activity first.", true); return refreshAgent(); }
  await addDoc(C.activities, {
    user_id: ME.uid, user_name: ME.name, description: desc,
    start_time: Timestamp.now(), end_time: null, duration: 0,
    date: day, session_id: st.openSession.id,
  });
  toast("Activity started");
  refreshAgent();
}

async function endActivity() {
  const day = todayKey();
  const data = await loadDay(ME.uid, day);
  const st = deriveStatus(data);
  if (!st.openActivity) { toast("No active activity.", true); return refreshAgent(); }
  await endActivityDoc(st.openActivity);
  toast("Activity ended");
  refreshAgent();
}
async function endActivityDoc(a) {
  const now = Timestamp.now();
  const dur = Math.round((now.toMillis() - ms(a.start_time)) / 1000);
  await updateDoc(doc(C.activities, a.id), { end_time: now, duration: dur });
}

// ============================================================
//  Router
// ============================================================
const TITLES = {
  dashboard: "Dashboard", "my-tasks": "My Tasks", "my-activity": "My Activity",
  "my-time": "My Time", profile: "Profile", agents: "Agents", tasks: "Tasks",
  activity: "Activity", reports: "Time Reports", settings: "Settings",
};
function render() {
  clearView();
  titleEl.textContent = TITLES[ROUTE] || "Dashboard";
  const admin = ME.role === "admin";
  if (ROUTE === "dashboard") return admin ? viewAdminDashboard() : viewAgentDashboard();
  if (ROUTE === "my-tasks") return viewMyTasks();
  if (ROUTE === "my-activity") return viewMyActivity();
  if (ROUTE === "my-time") return viewMyTime();
  if (ROUTE === "profile") return viewProfile();
  if (ROUTE === "agents") return viewAgents();
  if (ROUTE === "tasks") return viewAdminTasks();
  if (ROUTE === "activity") return viewAdminActivity();
  if (ROUTE === "reports") return viewReports();
  if (ROUTE === "settings") return viewSettings();
}

// ============================================================
//  AGENT — Dashboard
// ============================================================
async function refreshAgent() { if (ROUTE === "dashboard" && ME.role === "agent") viewAgentDashboard(); }

async function viewAgentDashboard() {
  viewEl.innerHTML = skeleton();
  const day = todayKey();
  const data = await loadDay(ME.uid, day);
  const st = deriveStatus(data);

  const statusText = { working: "Working", lunch: "On lunch", out: "Clocked out" }[st.status];

  // main actions
  let actions = "";
  if (st.status === "out") {
    actions = `<button class="btn btn-primary btn-lg" id="btn-clockin">Clock in</button>`;
  } else if (st.status === "working") {
    actions = `
      <button class="btn btn-dark btn-lg" id="btn-clockout">Clock out</button>
      <button class="btn btn-outline btn-lg" id="btn-lunch">Start lunch</button>`;
  } else {
    actions = `<button class="btn btn-primary btn-lg" id="btn-endlunch">End lunch</button>`;
  }

  // live stat blocks
  const stats = st.status === "out" ? "" : `
    <div class="stat-row">
      <div class="stat"><span class="stat-label">Clock-in time</span><span class="stat-value">${fmtClock(ms(st.openSession.clock_in))}</span></div>
      ${st.status === "lunch"
        ? `<div class="stat"><span class="stat-label">Lunch started</span><span class="stat-value">${fmtClock(ms(st.openLunch.start_time))}</span></div>
           <div class="stat"><span class="stat-label">On lunch for</span><span class="stat-value num" id="t-lunch">—</span></div>`
        : `<div class="stat"><span class="stat-label">Worked this session</span><span class="stat-value num" id="t-session">—</span></div>
           <div class="stat"><span class="stat-label">Current activity</span><span class="stat-value" style="font-size:15px">${st.openActivity ? esc(st.openActivity.description) : "—"}</span></div>`}
      <div class="stat"><span class="stat-label">Today's total worked</span><span class="stat-value num" id="t-today">—</span></div>
    </div>`;

  // activity box (only when working)
  let activityCard = "";
  if (st.status === "working") {
    if (st.openActivity) {
      activityCard = `
        <div class="card card-pad activity-box">
          <div class="section-title">Activity notes</div>
          <div class="activity-current">
            <span class="pulse"></span>
            <span class="txt">${esc(st.openActivity.description)}</span>
            <span class="since" id="t-activity">—</span>
          </div>
          <button class="btn btn-dark btn-sm" id="btn-endact">End activity</button>
        </div>`;
    } else {
      activityCard = `
        <div class="card card-pad activity-box">
          <div class="section-title">What are you working on?</div>
          <textarea id="act-input" placeholder="e.g. Helping customer with account verification"></textarea>
          <div class="mt-18"><button class="btn btn-primary btn-sm" id="btn-startact">Start activity</button></div>
        </div>`;
    }
  }

  const timeline = buildTimeline(data);

  // Open tasks assigned by admin
  const openTasks = (await getDocsArr(query(C.tasks, where("assigned_to", "==", ME.uid))))
    .filter((t) => t.status !== "done")
    .sort((a, b) => (ms(b.created_at) || 0) - (ms(a.created_at) || 0));
  const tasksCard = openTasks.length ? `
    <div class="card card-pad mt-18">
      <div class="section-title">Assigned tasks (${openTasks.length})</div>
      <div class="task-mini-list">
        ${openTasks.map((t) => `
          <div class="task-mini" data-id="${t.id}">
            <div class="task-mini-main">
              <div class="task-title">${esc(t.title)}</div>
              <div class="task-meta">${t.due_date ? `Due ${esc(t.due_date)} · ` : ""}from ${esc(t.assigned_by_name || "admin")}</div>
            </div>
            ${taskBadge(t.status)}
            <div class="task-actions">
              ${t.status === "open" ? `<button class="btn btn-outline btn-sm" data-act="start">Start</button>` : ""}
              <button class="btn btn-primary btn-sm" data-act="done">Done</button>
            </div>
          </div>`).join("")}
      </div>
      <a href="#" id="tasks-all" class="task-all-link">Open My Tasks to add reports →</a>
    </div>` : "";

  viewEl.innerHTML = `
    <p class="greeting">${greetWord()}, ${esc(ME.name.split(" ")[0])}</p>
    <p class="greeting-sub">${new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</p>

    <div class="status-card">
      <div class="status-head">
        <div>
          <div class="status-label">Status</div>
          <div class="status-value"><span class="dot ${st.status}"></span>${statusText}</div>
          ${st.status !== "out" ? `<div class="status-timer" id="t-main">—</div>` : `<div class="status-timer">Ready when you are.</div>`}
        </div>
        <div class="status-actions">${actions}</div>
      </div>
      ${stats}
    </div>

    ${activityCard}

    ${tasksCard}

    <div class="card card-pad mt-18">
      <div class="section-title">Today's timeline</div>
      ${timeline}
    </div>`;

  // wire buttons
  $("btn-clockin") && $("btn-clockin").addEventListener("click", guard(clockIn));
  $("btn-clockout") && $("btn-clockout").addEventListener("click", guard(clockOut));
  $("btn-lunch") && $("btn-lunch").addEventListener("click", guard(startLunch));
  $("btn-endlunch") && $("btn-endlunch").addEventListener("click", guard(endLunch));
  $("btn-startact") && $("btn-startact").addEventListener("click", guard(() => startActivity($("act-input").value)));
  $("btn-endact") && $("btn-endact").addEventListener("click", guard(endActivity));

  // dashboard task buttons
  viewEl.querySelectorAll(".task-mini").forEach((el) => {
    const id = el.dataset.id;
    const s = el.querySelector('[data-act="start"]');
    const d = el.querySelector('[data-act="done"]');
    s && s.addEventListener("click", guard(async () => { await taskSetStatus(id, "in_progress"); toast("Task started"); refreshAgent(); }));
    d && d.addEventListener("click", guard(async () => { await taskSetStatus(id, "done"); toast("Task done"); refreshAgent(); }));
  });
  $("tasks-all") && $("tasks-all").addEventListener("click", (e) => { e.preventDefault(); go("my-tasks"); });

  // live tick
  tickHandler = () => {
    const now = Date.now();
    if (st.status === "working") {
      const sSec = st.workedSecFor(st.openSession);
      setText("t-session", fmtClockDur(sSec));
      setText("t-main", "Working for " + fmtClockDur(sSec) + " this session");
      if (st.openActivity) setText("t-activity", fmtClockDur((now - ms(st.openActivity.start_time)) / 1000));
    } else if (st.status === "lunch") {
      const lSec = (now - ms(st.openLunch.start_time)) / 1000;
      setText("t-lunch", fmtClockDur(lSec));
      setText("t-main", "On lunch for " + fmtClockDur(lSec));
    }
    // today's total recomputes from stored timestamps
    setText("t-today", fmtHM(deriveStatus(data).totalWorkedSec));
  };
  tickHandler();
}

function setText(id, v) { const el = $(id); if (el) el.textContent = v; }

// prevent double-clicks firing an action twice
function guard(fn) {
  let busy = false;
  return async (e) => {
    if (busy) return;
    busy = true;
    if (e && e.currentTarget) e.currentTarget.disabled = true;
    try { await fn(); } catch (err) { toast(err.message || "Something went wrong", true); }
    busy = false;
    if (e && e.currentTarget) e.currentTarget.disabled = false;
  };
}

// Build a chronological timeline of a day's events.
function buildTimeline(data) {
  const events = [];
  data.sessions.forEach((s) => {
    events.push({ t: ms(s.clock_in), node: "green", time: fmtClock(ms(s.clock_in)), desc: "Clocked in" });
    if (s.clock_out) events.push({ t: ms(s.clock_out), node: "gray", time: fmtClock(ms(s.clock_out)), desc: "Clocked out" });
  });
  data.lunches.forEach((l) => {
    const end = l.end_time ? ms(l.end_time) : Date.now();
    events.push({
      t: ms(l.start_time), node: "amber",
      time: `${fmtClock(ms(l.start_time))} – ${l.end_time ? fmtClock(ms(l.end_time)) : "now"}`,
      desc: "Lunch", dur: fmtHM((end - ms(l.start_time)) / 1000),
    });
  });
  data.activities.forEach((a) => {
    const end = a.end_time ? ms(a.end_time) : Date.now();
    events.push({
      t: ms(a.start_time), node: "orange",
      time: `${fmtClock(ms(a.start_time))} – ${a.end_time ? fmtClock(ms(a.end_time)) : "now"}`,
      desc: a.description, dur: fmtHM((end - ms(a.start_time)) / 1000),
    });
  });
  events.sort((x, y) => x.t - y.t);
  if (!events.length) return `<div class="empty"><strong>Nothing logged yet</strong>Clock in to start your shift.</div>`;
  return `<ul class="timeline">` + events.map((e) => `
    <li class="tl-item">
      <div class="tl-rail"><span class="tl-node ${e.node}"></span><span class="tl-line"></span></div>
      <div class="tl-body">
        <div class="tl-time">${esc(e.time)}</div>
        <div class="tl-desc">${esc(e.desc)}</div>
        ${e.dur ? `<div class="tl-dur">${e.dur}</div>` : ""}
      </div>
    </li>`).join("") + `</ul>`;
}

// ============================================================
//  AGENT — My Activity
// ============================================================
async function viewMyActivity() {
  viewEl.innerHTML = skeleton();
  const acts = (await getDocsArr(query(C.activities, where("user_id", "==", ME.uid))))
    .sort((a, b) => ms(b.start_time) - ms(a.start_time));
  viewEl.innerHTML = `
    <div class="page-head"><div class="section-title">All activities (${acts.length})</div></div>
    <div class="card table-wrap">${activityTable(acts, false)}</div>`;
}

function activityTable(acts, showAgent) {
  if (!acts.length) return `<div class="empty"><strong>No activities yet</strong>Logged activities will appear here.</div>`;
  const now = Date.now();
  return `<table><thead><tr>
      <th>Date</th>${showAgent ? "<th>Agent</th>" : ""}<th>Activity</th><th>Start</th><th>End</th><th>Duration</th>
    </tr></thead><tbody>` + acts.map((a) => {
    const end = a.end_time ? ms(a.end_time) : now;
    return `<tr>
      <td>${fmtDate(a.date)}</td>
      ${showAgent ? `<td>${esc(a.user_name || "")}</td>` : ""}
      <td>${esc(a.description)}</td>
      <td class="num">${fmtClock(ms(a.start_time))}</td>
      <td class="num">${a.end_time ? fmtClock(ms(a.end_time)) : '<span class="badge working">active</span>'}</td>
      <td class="num">${fmtHM((end - ms(a.start_time)) / 1000)}</td>
    </tr>`;
  }).join("") + `</tbody></table>`;
}

// ============================================================
//  AGENT — My Time
// ============================================================
async function viewMyTime() {
  viewEl.innerHTML = skeleton();
  const [sessions, lunches] = await Promise.all([
    getDocsArr(query(C.sessions, where("user_id", "==", ME.uid))),
    getDocsArr(query(C.lunches, where("user_id", "==", ME.uid))),
  ]);
  sessions.sort((a, b) => ms(b.clock_in) - ms(a.clock_in));
  viewEl.innerHTML = `
    <div class="page-head"><div class="section-title">Time sessions (${sessions.length})</div></div>
    <div class="card table-wrap">${sessionTable(sessions, lunches, false)}</div>`;
}

function sessionTable(sessions, lunches, showAgent) {
  if (!sessions.length) return `<div class="empty"><strong>No sessions yet</strong>Your clock-in history will appear here.</div>`;
  const now = Date.now();
  return `<table><thead><tr>
      <th>Date</th>${showAgent ? "<th>Agent</th>" : ""}<th>Clock in</th><th>Clock out</th><th>Lunch</th><th>Worked</th>
    </tr></thead><tbody>` + sessions.map((s) => {
    const sl = lunches.filter((l) => l.session_id === s.id);
    const lunchSec = sl.reduce((t, l) => t + ((l.end_time ? ms(l.end_time) : now) - ms(l.start_time)) / 1000, 0);
    const end = s.clock_out ? ms(s.clock_out) : now;
    const worked = Math.max(0, (end - ms(s.clock_in)) / 1000 - lunchSec);
    return `<tr>
      <td>${fmtDate(s.date)}</td>
      ${showAgent ? `<td>${esc(s.user_name || "")}</td>` : ""}
      <td class="num">${fmtClock(ms(s.clock_in))}</td>
      <td class="num">${s.clock_out ? fmtClock(ms(s.clock_out)) : '<span class="badge working">open</span>'}</td>
      <td class="num">${lunchSec > 0 ? fmtHM(lunchSec) : "—"}</td>
      <td class="num">${fmtHM(worked)}</td>
    </tr>`;
  }).join("") + `</tbody></table>`;
}

// ============================================================
//  AGENT — Profile
// ============================================================
function viewProfile() {
  viewEl.innerHTML = `
    <div class="card card-pad">
      <div class="profile-hero">
        <img class="avatar" src="${esc(ME.profile_picture || fallbackAvatar(ME.name))}" onerror="this.src='${fallbackAvatar(ME.name)}'" alt="" />
        <div>
          <div class="p-name">${esc(ME.name)}</div>
          <div class="p-email">${esc(ME.email)}</div>
        </div>
      </div>
      <dl class="kv mt-18">
        <dt>Role</dt><dd style="text-transform:capitalize">${esc(ME.role)}</dd>
        <dt>User ID</dt><dd class="num">${esc(ME.uid)}</dd>
        <dt>Email</dt><dd>${esc(ME.email)}</dd>
      </dl>
    </div>`;
}

// ============================================================
//  ADMIN — Dashboard (live)
// ============================================================
async function viewAdminDashboard() {
  viewEl.innerHTML = skeleton();
  const users = await getDocsArr(C.users);
  const usersById = Object.fromEntries(users.map((u) => [u.uid, u]));
  const day = todayKey();

  const rebuild = async () => {
    const [sessions, lunches, activities] = await Promise.all([
      getDocsArr(query(C.sessions, where("date", "==", day))),
      getDocsArr(query(C.lunches, where("date", "==", day))),
      getDocsArr(query(C.activities, where("date", "==", day))),
    ]);

    const rows = users.map((u) => {
      const data = {
        sessions: sessions.filter((s) => s.user_id === u.uid),
        lunches: lunches.filter((l) => l.user_id === u.uid),
        activities: activities.filter((a) => a.user_id === u.uid),
      };
      return { u, st: deriveStatus(data) };
    });
    // working first, then lunch, then out; each group by name
    const order = { working: 0, lunch: 1, out: 2 };
    rows.sort((a, b) => order[a.st.status] - order[b.st.status] || a.u.name.localeCompare(b.u.name));

    const counts = { working: 0, lunch: 0, out: 0 };
    rows.forEach((r) => counts[r.st.status]++);

    viewEl.innerHTML = `
      <div class="tiles">
        <div class="tile"><div class="t-label">🟢 Working</div><div class="t-value">${counts.working}</div></div>
        <div class="tile"><div class="t-label">🟠 On lunch</div><div class="t-value">${counts.lunch}</div></div>
        <div class="tile"><div class="t-label">⚫ Clocked out</div><div class="t-value">${counts.out}</div></div>
        <div class="tile"><div class="t-label">Total agents</div><div class="t-value">${users.length}</div></div>
      </div>
      <div class="card table-wrap">
        <table><thead><tr>
          <th>Agent</th><th>Status</th><th>Clock in</th><th>Current activity</th><th>Today's hours</th><th>Lunch</th>
        </tr></thead><tbody>
        ${rows.map(({ u, st }) => `
          <tr class="clickable" data-uid="${u.uid}">
            <td><div class="cell-agent">
              <img class="avatar" src="${esc(u.profile_picture || fallbackAvatar(u.name))}" onerror="this.src='${fallbackAvatar(u.name)}'" alt="" />
              <div><div class="nm">${esc(u.name)}</div><div class="em">${esc(u.email)}</div></div>
            </div></td>
            <td>${badge(st.status)}</td>
            <td class="num">${st.openSession ? fmtClock(ms(st.openSession.clock_in)) : "—"}</td>
            <td>${st.openActivity ? esc(st.openActivity.description) : (st.status === "lunch" ? "<span style='color:#9CA3AF'>on lunch</span>" : "—")}</td>
            <td class="num" data-worked="${u.uid}">${fmtHM(st.totalWorkedSec)}</td>
            <td class="num">${st.totalLunchSec > 0 ? fmtHM(st.totalLunchSec) : "—"}</td>
          </tr>`).join("")}
        </tbody></table>
      </div>
      <p class="greeting-sub mt-18" style="margin:14px 0 0;font-size:12.5px">Live — updates automatically. Click an agent for their full timeline.</p>`;

    viewEl.querySelectorAll("tr.clickable").forEach((tr) =>
      tr.addEventListener("click", () => openAgentDetail(tr.dataset.uid, usersById[tr.dataset.uid])));

    // keep "today's hours" ticking live for currently-working agents
    tickHandler = () => {
      rows.forEach(({ u, st }) => {
        if (st.status === "working" || st.status === "lunch") {
          const cell = viewEl.querySelector(`[data-worked="${u.uid}"]`);
          if (cell) {
            const fresh = deriveStatus({
              sessions: sessions.filter((s) => s.user_id === u.uid),
              lunches: lunches.filter((l) => l.user_id === u.uid),
              activities: activities.filter((a) => a.user_id === u.uid),
            });
            cell.textContent = fmtHM(fresh.totalWorkedSec);
          }
        }
      });
    };
  };

  await rebuild();
  // live: re-pull whenever today's sessions change
  unsubscribers.push(onSnapshot(query(C.sessions, where("date", "==", day)), () => { if (ROUTE === "dashboard") rebuild(); }));
}

// ============================================================
//  ADMIN — Agents list
// ============================================================
async function viewAgents() {
  viewEl.innerHTML = skeleton();
  const users = (await getDocsArr(C.users)).sort((a, b) => a.name.localeCompare(b.name));
  viewEl.innerHTML = `
    <div class="filters">
      <div class="field"><label>Search</label><input id="agent-search" placeholder="Name or email" /></div>
    </div>
    <div class="card table-wrap" id="agent-list"></div>`;
  const draw = (q = "") => {
    const filtered = users.filter((u) =>
      (u.name + " " + u.email).toLowerCase().includes(q.toLowerCase()));
    $("agent-list").innerHTML = !filtered.length
      ? `<div class="empty"><strong>No matches</strong>Try a different search.</div>`
      : `<table><thead><tr><th>Agent</th><th>Email</th><th>Role</th></tr></thead><tbody>${
        filtered.map((u) => `<tr class="clickable" data-uid="${u.uid}">
          <td><div class="cell-agent">
            <img class="avatar" src="${esc(u.profile_picture || fallbackAvatar(u.name))}" onerror="this.src='${fallbackAvatar(u.name)}'" alt="" />
            <span class="nm">${esc(u.name)}</span></div></td>
          <td>${esc(u.email)}</td><td style="text-transform:capitalize">${esc(u.role)}</td>
        </tr>`).join("")}</tbody></table>`;
    $("agent-list").querySelectorAll("tr.clickable").forEach((tr) => {
      const u = users.find((x) => x.uid === tr.dataset.uid);
      tr.addEventListener("click", () => openAgentDetail(u.uid, u));
    });
  };
  draw();
  $("agent-search").addEventListener("input", (e) => draw(e.target.value));
}

// Agent detail — full timeline for a chosen day
async function openAgentDetail(uid, u) {
  clearView();
  titleEl.textContent = u.name;
  viewEl.innerHTML = skeleton();
  const day = todayKey();
  const draw = async (dayKey) => {
    const data = await loadDay(uid, dayKey);
    const st = deriveStatus(data);
    viewEl.innerHTML = `
      <div class="page-head">
        <div class="cell-agent">
          <img class="avatar" style="width:44px;height:44px" src="${esc(u.profile_picture || fallbackAvatar(u.name))}" onerror="this.src='${fallbackAvatar(u.name)}'" alt="" />
          <div><div class="nm" style="font-size:17px">${esc(u.name)}</div><div class="em">${esc(u.email)}</div></div>
        </div>
        <div class="field"><label>Date</label><input type="date" id="detail-date" value="${dayKey}" /></div>
      </div>
      <div class="tiles">
        <div class="tile"><div class="t-label">Status</div><div class="t-value" style="font-size:16px;margin-top:8px">${badge(st.status)}</div></div>
        <div class="tile"><div class="t-label">Worked</div><div class="t-value">${fmtHM(st.totalWorkedSec)}</div></div>
        <div class="tile"><div class="t-label">Lunch</div><div class="t-value">${fmtHM(st.totalLunchSec)}</div></div>
        <div class="tile"><div class="t-label">Activities</div><div class="t-value">${data.activities.length}</div></div>
      </div>
      <div class="card card-pad"><div class="section-title">Timeline — ${fmtDate(dayKey)}</div>${buildTimeline(data)}</div>
      <button class="btn btn-outline btn-sm mt-18" style="margin-top:18px" id="back-btn">← Back</button>`;
    $("detail-date").addEventListener("change", (e) => draw(e.target.value));
    $("back-btn").addEventListener("click", () => go(ME.role === "admin" ? "agents" : "dashboard"));
  };
  await draw(day);
}

// ============================================================
//  ADMIN — Activity feed
// ============================================================
async function viewAdminActivity() {
  viewEl.innerHTML = skeleton();
  const day = todayKey();
  const draw = async (dayKey) => {
    const acts = (await getDocsArr(query(C.activities, where("date", "==", dayKey))))
      .sort((a, b) => ms(b.start_time) - ms(a.start_time));
    viewEl.innerHTML = `
      <div class="filters">
        <div class="field"><label>Date</label><input type="date" id="act-date" value="${dayKey}" /></div>
      </div>
      <div class="card table-wrap">${activityTable(acts, true)}</div>`;
    $("act-date").addEventListener("change", (e) => draw(e.target.value));
  };
  await draw(day);
}

// ============================================================
//  ADMIN — Reports + CSV
// ============================================================
async function viewReports() {
  viewEl.innerHTML = skeleton();
  const users = (await getDocsArr(C.users)).sort((a, b) => a.name.localeCompare(b.name));
  const today = todayKey();
  const weekAgo = todayKey(new Date(Date.now() - 6 * 864e5));

  viewEl.innerHTML = `
    <div class="filters">
      <div class="field"><label>Agent</label>
        <select id="r-agent"><option value="">All agents</option>${users.map((u) => `<option value="${u.uid}">${esc(u.name)}</option>`).join("")}</select>
      </div>
      <div class="field"><label>From</label><input type="date" id="r-from" value="${weekAgo}" /></div>
      <div class="field"><label>To</label><input type="date" id="r-to" value="${today}" /></div>
      <div class="field"><label>Status</label>
        <select id="r-status"><option value="">Any</option><option value="working">Working now</option><option value="lunch">On lunch now</option><option value="out">Clocked out</option></select>
      </div>
      <button class="btn btn-outline btn-sm" id="r-run">Apply</button>
      <button class="btn btn-primary btn-sm" id="r-csv">Export CSV</button>
    </div>
    <div id="report-out"></div>`;

  const run = async () => {
    const uid = $("r-agent").value, from = $("r-from").value, to = $("r-to").value, statusF = $("r-status").value;
    $("report-out").innerHTML = skeleton();

    const [allS, allL, allA] = await Promise.all([
      getDocsArr(query(C.sessions, where("date", ">=", from), where("date", "<=", to))),
      getDocsArr(query(C.lunches, where("date", ">=", from), where("date", "<=", to))),
      getDocsArr(query(C.activities, where("date", ">=", from), where("date", "<=", to))),
    ]);

    let sessions = uid ? allS.filter((s) => s.user_id === uid) : allS;
    const lunches = uid ? allL.filter((l) => l.user_id === uid) : allL;
    const activities = uid ? allA.filter((a) => a.user_id === uid) : allA;

    // status filter uses each agent's CURRENT status (today)
    if (statusF) {
      const todayData = await Promise.all(
        [...new Set(sessions.map((s) => s.user_id))].map(async (u) => [u, deriveStatus(await loadDay(u, today)).status])
      );
      const map = Object.fromEntries(todayData);
      sessions = sessions.filter((s) => map[s.user_id] === statusF);
    }

    sessions.sort((a, b) => ms(b.clock_in) - ms(a.clock_in));

    const now = Date.now();
    let totalWork = 0, totalLunch = 0;
    sessions.forEach((s) => {
      const sl = lunches.filter((l) => l.session_id === s.id);
      const ls = sl.reduce((t, l) => t + ((l.end_time ? ms(l.end_time) : now) - ms(l.start_time)) / 1000, 0);
      const end = s.clock_out ? ms(s.clock_out) : now;
      totalWork += Math.max(0, (end - ms(s.clock_in)) / 1000 - ls);
      totalLunch += ls;
    });
    const relevantActs = uid ? activities : activities;

    $("report-out").innerHTML = `
      <div class="tiles">
        <div class="tile"><div class="t-label">Total worked</div><div class="t-value">${fmtHM(totalWork)}</div></div>
        <div class="tile"><div class="t-label">Total lunch</div><div class="t-value">${fmtHM(totalLunch)}</div></div>
        <div class="tile"><div class="t-label">Sessions</div><div class="t-value">${sessions.length}</div></div>
        <div class="tile"><div class="t-label">Activities</div><div class="t-value">${relevantActs.length}</div></div>
      </div>
      <div class="card table-wrap">${sessionTable(sessions, lunches, true)}</div>
      <div class="section-title" style="margin-top:22px">Activities</div>
      <div class="card table-wrap">${activityTable(relevantActs.sort((a, b) => ms(b.start_time) - ms(a.start_time)), true)}</div>`;

    // stash for CSV
    viewReports._data = { sessions, lunches, activities: relevantActs, from, to };
  };

  $("r-run").addEventListener("click", run);
  $("r-csv").addEventListener("click", exportCSV);
  await run();
}

function exportCSV() {
  const d = viewReports._data;
  if (!d) return;
  const now = Date.now();
  const rows = [["Type", "Agent", "Date", "Start", "End", "Duration (min)", "Description"]];
  d.sessions.forEach((s) => {
    const sl = d.lunches.filter((l) => l.session_id === s.id);
    const ls = sl.reduce((t, l) => t + ((l.end_time ? ms(l.end_time) : now) - ms(l.start_time)) / 1000, 0);
    const end = s.clock_out ? ms(s.clock_out) : now;
    const worked = Math.max(0, (end - ms(s.clock_in)) / 1000 - ls);
    rows.push(["Session", s.user_name || "", s.date, fmtClock(ms(s.clock_in)),
      s.clock_out ? fmtClock(ms(s.clock_out)) : "OPEN", Math.round(worked / 60), ""]);
  });
  d.lunches.forEach((l) => rows.push(["Lunch", agentName(d, l.user_id), l.date,
    fmtClock(ms(l.start_time)), l.end_time ? fmtClock(ms(l.end_time)) : "OPEN",
    Math.round(((l.end_time ? ms(l.end_time) : now) - ms(l.start_time)) / 60000), ""]));
  d.activities.forEach((a) => rows.push(["Activity", a.user_name || "", a.date,
    fmtClock(ms(a.start_time)), a.end_time ? fmtClock(ms(a.end_time)) : "OPEN",
    Math.round(((a.end_time ? ms(a.end_time) : now) - ms(a.start_time)) / 60000), a.description || ""]));

  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `shift-report_${d.from}_to_${d.to}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  toast("CSV exported");
}
function agentName(d, uid) {
  const a = d.activities.find((x) => x.user_id === uid) || d.sessions.find((x) => x.user_id === uid);
  return a ? a.user_name || "" : "";
}

// ============================================================
//  ADMIN — Settings (roles)
// ============================================================
async function viewSettings() {
  viewEl.innerHTML = skeleton();
  const users = (await getDocsArr(C.users)).sort((a, b) => a.name.localeCompare(b.name));
  viewEl.innerHTML = `
    <div class="page-head"><div class="section-title">Agent roles</div></div>
    <p class="greeting-sub">Promote an agent to admin or change them back. Admins can see all agents and reports.</p>
    <div class="card table-wrap">
      <table><thead><tr><th>Agent</th><th>Email</th><th>Role</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr>
        <td><div class="cell-agent">
          <img class="avatar" src="${esc(u.profile_picture || fallbackAvatar(u.name))}" onerror="this.src='${fallbackAvatar(u.name)}'" alt="" />
          <span class="nm">${esc(u.name)}</span></div></td>
        <td>${esc(u.email)}</td>
        <td style="text-transform:capitalize">${esc(u.role)}</td>
        <td>${u.uid === ME.uid ? '<span class="em">you</span>' :
          `<button class="btn btn-outline btn-sm" data-uid="${u.uid}" data-role="${u.role === "admin" ? "agent" : "admin"}">
            Make ${u.role === "admin" ? "agent" : "admin"}</button>`}</td>
      </tr>`).join("")}
      </tbody></table>
    </div>`;
  viewEl.querySelectorAll("button[data-uid]").forEach((b) =>
    b.addEventListener("click", guard(async () => {
      await updateDoc(doc(C.users, b.dataset.uid), { role: b.dataset.role });
      toast(`Role updated to ${b.dataset.role}`);
      viewSettings();
    })));
}

// ============================================================
//  TASKS — actions
// ============================================================
async function taskSetStatus(id, status) {
  const patch = { status };
  patch.completed_at = status === "done" ? Timestamp.now() : null;
  await updateDoc(doc(C.tasks, id), patch);
}
async function taskSaveNote(id, note) {
  await updateDoc(doc(C.tasks, id), { agent_note: note });
}
async function adminCreateTask({ assignTo, agents, title, details, due }) {
  const stamp = () => ({
    assigned_by: ME.uid, assigned_by_name: ME.name,
    title, details: details || "", due_date: due || "",
    status: "open", agent_note: "", created_at: serverTimestamp(), completed_at: null,
  });
  const targets = assignTo === "ALL" ? agents : agents.filter((a) => a.uid === assignTo);
  await Promise.all(targets.map((a) => addDoc(C.tasks, {
    ...stamp(),
    assigned_to: a.uid, assigned_to_name: a.name, assigned_to_email: a.email,
  })));
  return targets.length;
}
async function adminDeleteTask(id) { await deleteDoc(doc(C.tasks, id)); }

function taskBadge(status) {
  const map = { open: ["out", "Open"], in_progress: ["lunch", "In progress"], done: ["working", "Done"] };
  const [cls, label] = map[status] || map.open;
  return `<span class="badge ${cls}"><span class="dot ${cls}"></span>${label}</span>`;
}

// ============================================================
//  AGENT — My Tasks
// ============================================================
async function viewMyTasks() {
  viewEl.innerHTML = skeleton();
  const tasks = (await getDocsArr(query(C.tasks, where("assigned_to", "==", ME.uid))))
    .sort((a, b) => (a.status === "done") - (b.status === "done")
      || (ms(b.created_at) || 0) - (ms(a.created_at) || 0));

  if (!tasks.length) {
    viewEl.innerHTML = `<div class="card"><div class="empty"><strong>No tasks yet</strong>Tasks assigned to you will show up here.</div></div>`;
    return;
  }
  viewEl.innerHTML = `<div class="stack">${tasks.map(taskCardAgent).join("")}</div>`;
  wireAgentTaskCards();
}

function taskCardAgent(t) {
  const done = t.status === "done";
  return `<div class="card card-pad task-card ${done ? "task-done" : ""}" data-id="${t.id}">
    <div class="task-head">
      <div class="task-title">${esc(t.title)}</div>
      ${taskBadge(t.status)}
    </div>
    ${t.details ? `<p class="task-details">${esc(t.details)}</p>` : ""}
    <div class="task-meta">
      ${t.due_date ? `Due ${esc(t.due_date)} · ` : ""}Assigned by ${esc(t.assigned_by_name || "admin")}
    </div>
    <div class="task-actions">
      ${t.status !== "in_progress" && !done ? `<button class="btn btn-outline btn-sm" data-act="start">Start</button>` : ""}
      ${!done ? `<button class="btn btn-primary btn-sm" data-act="done">Mark done</button>` : `<button class="btn btn-outline btn-sm" data-act="reopen">Reopen</button>`}
    </div>
    <div class="task-note">
      <label class="field-label">Your report / notes</label>
      <textarea data-note placeholder="Add a note about progress or the result…">${esc(t.agent_note || "")}</textarea>
      <button class="btn btn-dark btn-sm" data-act="save">Save report</button>
    </div>
  </div>`;
}

function wireAgentTaskCards() {
  viewEl.querySelectorAll(".task-card").forEach((card) => {
    const id = card.dataset.id;
    const btn = (act) => card.querySelector(`[data-act="${act}"]`);
    btn("start") && btn("start").addEventListener("click", guard(async () => { await taskSetStatus(id, "in_progress"); toast("Task started"); viewMyTasks(); }));
    btn("done") && btn("done").addEventListener("click", guard(async () => { await taskSetStatus(id, "done"); toast("Task marked done"); viewMyTasks(); }));
    btn("reopen") && btn("reopen").addEventListener("click", guard(async () => { await taskSetStatus(id, "in_progress"); toast("Task reopened"); viewMyTasks(); }));
    btn("save") && btn("save").addEventListener("click", guard(async () => {
      await taskSaveNote(id, card.querySelector("[data-note]").value.trim());
      toast("Report saved");
    }));
  });
}

// ============================================================
//  ADMIN — Tasks (assign + track)
// ============================================================
async function viewAdminTasks() {
  viewEl.innerHTML = skeleton();
  const users = (await getDocsArr(C.users)).sort((a, b) => a.name.localeCompare(b.name));
  const agents = users; // assignable people (any user)

  viewEl.innerHTML = `
    <div class="card card-pad">
      <div class="section-title">Assign a task</div>
      <div class="task-form">
        <div class="field"><label>Assign to</label>
          <select id="t-assign">
            <option value="ALL">All agents (${agents.length})</option>
            ${agents.map((a) => `<option value="${a.uid}">${esc(a.name)}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Due date (optional)</label><input type="date" id="t-due" /></div>
        <div class="field grow"><label>Title</label><input id="t-title" placeholder="e.g. Clear the escalations queue" /></div>
      </div>
      <div class="field" style="margin-top:12px"><label>Details (optional)</label>
        <textarea id="t-details" placeholder="Any context or instructions…"></textarea>
      </div>
      <div class="mt-18"><button class="btn btn-primary btn-sm" id="t-create">Assign task</button></div>
    </div>

    <div class="filters" style="margin-top:22px">
      <div class="field"><label>Agent</label>
        <select id="tf-agent"><option value="">All</option>${agents.map((a) => `<option value="${a.uid}">${esc(a.name)}</option>`).join("")}</select>
      </div>
      <div class="field"><label>Status</label>
        <select id="tf-status"><option value="">Any</option><option value="open">Open</option><option value="in_progress">In progress</option><option value="done">Done</option></select>
      </div>
    </div>
    <div id="tasks-out"></div>`;

  const drawList = async () => {
    const fa = $("tf-agent").value, fs = $("tf-status").value;
    let tasks = await getDocsArr(C.tasks);
    if (fa) tasks = tasks.filter((t) => t.assigned_to === fa);
    if (fs) tasks = tasks.filter((t) => t.status === fs);
    tasks.sort((a, b) => (a.status === "done") - (b.status === "done") || (ms(b.created_at) || 0) - (ms(a.created_at) || 0));

    $("tasks-out").innerHTML = !tasks.length
      ? `<div class="card"><div class="empty"><strong>No tasks</strong>Assign one above to get started.</div></div>`
      : `<div class="card table-wrap"><table><thead><tr>
          <th>Task</th><th>Agent</th><th>Due</th><th>Status</th><th>Report</th><th></th>
        </tr></thead><tbody>${tasks.map((t) => `<tr>
          <td><div class="nm">${esc(t.title)}</div>${t.details ? `<div class="em">${esc(t.details)}</div>` : ""}</td>
          <td>${esc(t.assigned_to_name || "")}</td>
          <td class="num">${t.due_date ? esc(t.due_date) : "—"}</td>
          <td>${taskBadge(t.status)}</td>
          <td>${t.agent_note ? esc(t.agent_note) : '<span class="em">—</span>'}</td>
          <td><button class="btn btn-outline btn-sm" data-del="${t.id}">Delete</button></td>
        </tr>`).join("")}</tbody></table></div>`;

    $("tasks-out").querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", guard(async () => {
        await adminDeleteTask(b.dataset.del); toast("Task deleted"); drawList();
      })));
  };

  $("t-create").addEventListener("click", guard(async () => {
    const title = $("t-title").value.trim();
    if (!title) { toast("Give the task a title.", true); return; }
    const n = await adminCreateTask({
      assignTo: $("t-assign").value, agents,
      title, details: $("t-details").value.trim(), due: $("t-due").value,
    });
    $("t-title").value = ""; $("t-details").value = ""; $("t-due").value = "";
    toast(`Task assigned to ${n} ${n === 1 ? "agent" : "agents"}`);
    drawList();
  }));
  $("tf-agent").addEventListener("change", drawList);
  $("tf-status").addEventListener("change", drawList);
  await drawList();
}

// ============================================================
//  Small helpers (UI)
// ============================================================
function badge(status) {
  const label = { working: "Working", lunch: "On lunch", out: "Clocked out" }[status];
  return `<span class="badge ${status}"><span class="dot ${status}"></span>${label}</span>`;
}
function skeleton() {
  return `<div class="empty"><div class="spinner" style="margin:0 auto 12px"></div>Loading…</div>`;
}
function fallbackAvatar(name) {
  const initials = (name || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#FF6A00"/><text x="50%" y="50%" dy=".35em" text-anchor="middle" fill="white" font-family="Inter,sans-serif" font-size="26" font-weight="700">${initials}</text></svg>`;
  // Fully URL-encoded → no raw quotes/&/<>, safe inside HTML attributes and inline JS strings.
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}
function icon(name) {
  const p = {
    grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    check: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
    cog: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  }[name];
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}
