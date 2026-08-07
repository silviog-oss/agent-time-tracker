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

import { firebaseConfig, ALLOWED_EMAIL_DOMAIN, SUPER_ADMIN_EMAILS } from "./config.js?v=3";

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

// ---------- App meta ----------
const APP_VERSION = "v2.1.0";

// ---------- Global state ----------
let ME = null;              // { uid, name, email, photo, role }
let ROUTE = "dashboard";    // active view id
let PREVIEW_AGENT = false;  // admin previewing the agent dashboard
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
// 24h HH:MM for <input type="time">
function hhmm(m) {
  const d = new Date(m);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
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
    renderVersionFooters();
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
  renderVersionFooters();
  go("dashboard");
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

async function startActivity(text, minutes = 15) {
  const desc = (text || "").trim();
  if (!desc) { toast("Type what you're working on first.", true); return; }
  const day = todayKey();
  const data = await loadDay(ME.uid, day);
  const st = deriveStatus(data);
  if (!st.openSession) { toast("Start your day before adding a task.", true); return refreshAgent(); }
  if (st.openLunch) { toast("You're on lunch — end lunch first.", true); return refreshAgent(); }
  if (st.openActivity) { toast("End the current task first.", true); return refreshAgent(); }
  await addDoc(C.activities, {
    user_id: ME.uid, user_name: ME.name, description: desc,
    start_time: Timestamp.now(), end_time: null, duration: 0,
    planned_minutes: Math.max(5, Math.round(minutes) || 15),
    date: day, session_id: st.openSession.id,
  });
  toast("Task started");
  refreshAgent();
}

// Agent may extend the planned time of the OPEN task (start_time stays fixed).
async function extendActivity(id, addMin = 15) {
  const data = await loadDay(ME.uid, todayKey());
  const a = data.activities.find((x) => x.id === id);
  if (!a || a.end_time) return;
  const next = (a.planned_minutes || 15) + addMin;
  await updateDoc(doc(C.activities, id), { planned_minutes: next });
  toast(`Extended to ${next} min`);
  refreshAgent();
}

async function endActivity() {
  const day = todayKey();
  const data = await loadDay(ME.uid, day);
  const st = deriveStatus(data);
  if (!st.openActivity) { toast("No task running.", true); return refreshAgent(); }
  await endActivityDoc(st.openActivity);
  toast("Task ended");
  refreshAgent();
}
async function endActivityDoc(a) {
  const now = Timestamp.now();
  const dur = Math.round((now.toMillis() - ms(a.start_time)) / 1000);
  await updateDoc(doc(C.activities, a.id), { end_time: now, duration: dur });
}

// Admin-only: change a task's start time (agents cannot — enforced in rules).
async function adminSetActivityStart(id, hhmm, dayKey) {
  const [h, m] = hhmm.split(":").map(Number);
  const [y, mo, d] = dayKey.split("-").map(Number);
  const when = new Date(y, mo - 1, d, h, m, 0, 0);
  await updateDoc(doc(C.activities, id), { start_time: Timestamp.fromDate(when) });
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
  if (ROUTE === "dashboard") return (admin && !PREVIEW_AGENT) ? viewAdminDashboard() : viewAgentDashboard();
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
async function refreshAgent() { if (ROUTE === "dashboard" && (ME.role === "agent" || PREVIEW_AGENT)) viewAgentDashboard(); }

async function viewAgentDashboard() {
  viewEl.innerHTML = skeleton();
  const day = todayKey();
  const data = await loadDay(ME.uid, day);
  const st = deriveStatus(data);
  const shiftEnded = data.sessions.length > 0 && !st.openSession; // a day was started and then ended

  // ----- top banner (admin preview) -----
  const previewBanner = PREVIEW_AGENT ? `
    <div class="preview-banner">
      <span>Previewing the agent view</span>
      <button class="btn btn-outline btn-sm" id="exit-preview">Back to admin</button>
    </div>` : "";

  // ----- big status + primary buttons -----
  let statusLine, buttons;
  if (st.status === "out") {
    statusLine = shiftEnded
      ? `<span class="dot out"></span>Shift ended`
      : `<span class="dot out"></span>Not started`;
    buttons = `<button class="btn btn-primary btn-lg" id="btn-startday">Start day</button>`;
  } else if (st.status === "lunch") {
    statusLine = `<span class="dot lunch"></span>On lunch`;
    buttons = `<button class="btn btn-primary btn-lg" id="btn-endlunch">End lunch</button>`;
  } else {
    // working
    statusLine = `<span class="dot working"></span>Working`;
    buttons = st.openActivity
      ? `<button class="btn btn-dark btn-lg" id="btn-endtask">End task</button>
         <button class="btn btn-outline btn-lg" id="btn-lunch">Lunch</button>
         <button class="btn btn-danger btn-lg" id="btn-endshift">End shift</button>`
      : `<button class="btn btn-primary btn-lg" id="btn-addtask">Add task</button>
         <button class="btn btn-outline btn-lg" id="btn-lunch">Lunch</button>
         <button class="btn btn-danger btn-lg" id="btn-endshift">End shift</button>`;
  }

  // ----- current task card (when a task is running) -----
  let currentTask = "";
  if (st.status === "working" && st.openActivity) {
    const a = st.openActivity;
    currentTask = `
      <div class="card card-pad current-task">
        <div class="section-title">Current task</div>
        <div class="ct-row">
          <span class="pulse"></span>
          <span class="ct-desc">${esc(a.description)}</span>
        </div>
        <div class="ct-meta">
          <span>Started ${fmtClock(ms(a.start_time))}</span>
          <span>·</span>
          <span>Planned ${a.planned_minutes || 15} min</span>
          <span>·</span>
          <span>Elapsed <b class="num" id="t-task">—</b></span>
        </div>
        <div class="ct-actions">
          <button class="btn btn-outline btn-sm" id="btn-extend">Extend +15 min</button>
        </div>
      </div>`;
  }

  const timeline = buildTimeline(data);

  // Tasks the admin assigned to this agent (not yet done)
  let assignedStrip = "";
  if (st.status === "working" && !st.openActivity) {
    const assigned = (await getDocsArr(query(C.tasks, where("assigned_to", "==", ME.uid))))
      .filter((t) => t.status !== "done")
      .sort((a, b) => (ms(b.created_at) || 0) - (ms(a.created_at) || 0));
    if (assigned.length) {
      assignedStrip = `
        <div class="card card-pad mt-18">
          <div class="section-title">Assigned by your admin (${assigned.length})</div>
          <div class="assigned-list">
            ${assigned.map((t) => `
              <div class="assigned-row">
                <span class="assigned-title">${esc(t.title)}${t.details ? ` — <span class="em">${esc(t.details)}</span>` : ""}</span>
                <button class="btn btn-outline btn-sm" data-assigned='${esc(JSON.stringify({ id: t.id, title: t.title }))}'>Start this</button>
              </div>`).join("")}
          </div>
        </div>`;
    }
  }

  viewEl.innerHTML = `
    ${previewBanner}
    <p class="greeting">${greetWord()}, ${esc(ME.name.split(" ")[0])}</p>
    <p class="greeting-sub">${new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</p>

    <div class="status-card">
      <div class="status-head">
        <div>
          <div class="status-label">Status</div>
          <div class="status-value">${statusLine}</div>
          ${st.openSession ? `<div class="status-timer" id="t-main">—</div>`
            : shiftEnded ? `<div class="status-timer">See you next time.</div>`
            : `<div class="status-timer">Press Start day to begin.</div>`}
        </div>
        <div class="status-actions">${buttons}</div>
      </div>
    </div>

    ${currentTask}

    ${assignedStrip}

    <div class="card card-pad mt-18">
      <div class="section-title">Today's timeline</div>
      ${timeline}
    </div>`;

  // ----- wire buttons -----
  $("exit-preview") && $("exit-preview").addEventListener("click", () => { PREVIEW_AGENT = false; render(); });
  $("btn-startday") && $("btn-startday").addEventListener("click", guard(async () => { await clockIn(); }));
  $("btn-addtask") && $("btn-addtask").addEventListener("click", () => openAddTaskModal());
  $("btn-endtask") && $("btn-endtask").addEventListener("click", guard(endActivity));
  $("btn-extend") && $("btn-extend").addEventListener("click", guard(() => extendActivity(st.openActivity.id, 15)));
  $("btn-lunch") && $("btn-lunch").addEventListener("click", guard(async () => { await startLunch(); openLunchModal(); }));
  $("btn-endlunch") && $("btn-endlunch").addEventListener("click", guard(async () => { await endLunch(); closeModal(); }));
  $("btn-endshift") && $("btn-endshift").addEventListener("click", () => confirmEndShift());

  // assigned-task "Start this" → open Add task modal prefilled, mark task in progress
  viewEl.querySelectorAll("[data-assigned]").forEach((b) =>
    b.addEventListener("click", () => {
      const info = JSON.parse(b.dataset.assigned);
      openAddTaskModal(info.title, info.id);
    }));

  // if we reload while on lunch, pop the lunch modal automatically
  if (st.status === "lunch") openLunchModal();

  // ----- live tick -----
  tickHandler = () => {
    const now = Date.now();
    if (st.openSession) {
      const sSec = st.workedSecFor(st.openSession);
      if (st.status === "working") setText("t-main", "Working · " + fmtClockDur(sSec) + " today");
      if (st.openActivity) setText("t-task", fmtClockDur((now - ms(st.openActivity.start_time)) / 1000));
    }
    if (st.status === "lunch") {
      const lSec = (now - ms(st.openLunch.start_time)) / 1000;
      setText("t-main", "On lunch · " + fmtClockDur(lSec));
      setText("modal-lunch-timer", fmtClockDur(lSec));
    }
  };
  tickHandler();
}

// ---- Add task modal (description + duration, default 15) ----
function openAddTaskModal(prefill = "", assignedTaskId = null) {
  openModal(`
    <h3 class="modal-title">What are you doing?</h3>
    <textarea id="m-desc" class="modal-textarea" placeholder="e.g. Answering customer chats">${esc(prefill)}</textarea>
    <label class="field-label" style="margin-top:14px">How long do you expect this to take?</label>
    <div class="duration-row">
      <button class="dur-step" data-d="-5" type="button">–5</button>
      <input id="m-mins" class="dur-input num" type="number" min="5" step="5" value="15" />
      <span class="dur-unit">min</span>
      <button class="dur-step" data-d="5" type="button">+5</button>
    </div>
    <p class="modal-hint">Default is 15 minutes. You can extend it later; only an admin can change the start time.</p>
    <div class="modal-actions">
      <button class="btn btn-outline btn-sm" id="m-cancel">Cancel</button>
      <button class="btn btn-primary btn-sm" id="m-start">Start task</button>
    </div>
  `);
  const mins = document.getElementById("m-mins");
  document.querySelectorAll(".dur-step").forEach((b) =>
    b.addEventListener("click", () => {
      mins.value = Math.max(5, (parseInt(mins.value, 10) || 15) + parseInt(b.dataset.d, 10));
    }));
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-start").addEventListener("click", guard(async () => {
    const desc = document.getElementById("m-desc").value.trim();
    if (!desc) { toast("Type what you're doing first.", true); return; }
    const minutes = Math.max(5, parseInt(mins.value, 10) || 15);
    closeModal();
    if (assignedTaskId) { try { await taskSetStatus(assignedTaskId, "in_progress"); } catch (_) {} }
    await startActivity(desc, minutes);
  }));
  setTimeout(() => document.getElementById("m-desc")?.focus(), 40);
}

// ---- Lunch modal (running timer + end) ----
function openLunchModal() {
  openModal(`
    <h3 class="modal-title">On lunch</h3>
    <div class="lunch-timer num" id="modal-lunch-timer">0:00:00</div>
    <p class="modal-hint">Your work timer is paused. Enjoy your break.</p>
    <div class="modal-actions">
      <button class="btn btn-primary btn-sm" id="m-endlunch">End lunch</button>
    </div>
  `, { dismissable: false });
  document.getElementById("m-endlunch").addEventListener("click", guard(async () => {
    await endLunch(); closeModal();
  }));
}

// ---- End shift: confirm, then close day; agent sees only a confirmation ----
function confirmEndShift() {
  openModal(`
    <h3 class="modal-title">End your shift?</h3>
    <p class="modal-hint">This closes your day. Any running task and lunch will be ended, and a timestamped summary is sent to your admin.</p>
    <div class="modal-actions">
      <button class="btn btn-outline btn-sm" id="m-cancel">Not yet</button>
      <button class="btn btn-danger btn-sm" id="m-confirm">End shift</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-confirm").addEventListener("click", guard(async () => {
    await clockOut();
    openModal(`
      <div class="modal-check">✓</div>
      <h3 class="modal-title" style="text-align:center">Shift ended</h3>
      <p class="modal-hint" style="text-align:center">Nice work today. Your summary has been sent to your admin.</p>
      <div class="modal-actions" style="justify-content:center">
        <button class="btn btn-primary btn-sm" id="m-ok">Done</button>
      </div>
    `);
    document.getElementById("m-ok").addEventListener("click", closeModal);
  }));
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
    const planned = a.planned_minutes ? ` · planned ${a.planned_minutes}m` : "";
    events.push({
      t: ms(a.start_time), node: "orange",
      time: `${fmtClock(ms(a.start_time))} – ${a.end_time ? fmtClock(ms(a.end_time)) : "now"}`,
      desc: a.description, dur: fmtHM((end - ms(a.start_time)) / 1000) + planned,
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
      <div class="page-head">
        <div class="section-title" style="margin:0">Live floor</div>
        <button class="btn btn-outline btn-sm" id="view-as-agent">View as agent</button>
      </div>
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
      <p class="greeting-sub mt-18" style="margin:14px 0 0;font-size:12.5px">Live — updates automatically. Click an agent for their full day summary.</p>`;

    $("view-as-agent").addEventListener("click", () => { PREVIEW_AGENT = true; go("dashboard"); });

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
    const acts = [...data.activities].sort((a, b) => ms(a.start_time) - ms(b.start_time));
    const startEditor = acts.length ? `
      <div class="card card-pad mt-18">
        <div class="section-title">Adjust task start times (admin only)</div>
        <div class="start-edit-list">
          ${acts.map((a) => `
            <div class="start-edit-row" data-id="${a.id}">
              <span class="se-desc">${esc(a.description)}</span>
              <input type="time" class="se-time" value="${hhmm(ms(a.start_time))}" />
              <button class="btn btn-outline btn-sm se-save">Save</button>
            </div>`).join("")}
        </div>
        <p class="modal-hint">Agents can't change these — only you can.</p>
      </div>` : "";
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
        <div class="tile"><div class="t-label">Tasks</div><div class="t-value">${data.activities.length}</div></div>
      </div>
      <div class="card card-pad"><div class="section-title">Day summary — ${fmtDate(dayKey)}</div>${buildTimeline(data)}</div>
      ${startEditor}
      <button class="btn btn-outline btn-sm mt-18" style="margin-top:18px" id="back-btn">← Back</button>`;
    $("detail-date").addEventListener("change", (e) => draw(e.target.value));
    $("back-btn").addEventListener("click", () => go(ME.role === "admin" ? "agents" : "dashboard"));
    viewEl.querySelectorAll(".start-edit-row").forEach((row) => {
      row.querySelector(".se-save").addEventListener("click", guard(async () => {
        const val = row.querySelector(".se-time").value;
        if (!val) return;
        await adminSetActivityStart(row.dataset.id, val, dayKey);
        toast("Start time updated");
        draw(dayKey);
      }));
    });
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
//  Modal
// ============================================================
let modalRoot = null;
function ensureModalRoot() {
  if (!modalRoot) {
    modalRoot = document.createElement("div");
    modalRoot.id = "modal-root";
    document.body.appendChild(modalRoot);
  }
  return modalRoot;
}
function openModal(innerHTML, { dismissable = true } = {}) {
  const root = ensureModalRoot();
  root.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-card" role="dialog" aria-modal="true">${innerHTML}</div>`;
  root.classList.add("open");
  if (dismissable) {
    root.querySelector(".modal-backdrop").addEventListener("click", closeModal);
  }
}
function closeModal() {
  if (modalRoot) { modalRoot.classList.remove("open"); modalRoot.innerHTML = ""; }
}

// ============================================================
//  Version footer
// ============================================================
function renderVersionFooters() {
  document.querySelectorAll(".app-version").forEach((el) => { el.textContent = APP_VERSION; });
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
