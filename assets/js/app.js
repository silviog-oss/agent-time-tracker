// ============================================================
//  Shift — Agent Time Tracking
//  Static frontend (GitHub Pages) + Firebase Auth + Firestore
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  signInWithEmailAndPassword, EmailAuthProvider, linkWithCredential, updatePassword
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, serverTimestamp, Timestamp, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import { firebaseConfig, ALLOWED_EMAIL_DOMAIN, SUPER_ADMIN_EMAILS, USERNAME_MAP } from "./config.js?v=45";
import { INVENTORY_SEED, INVENTORY_STATUSES, INVENTORY_MODELS, INVENTORY_CATEGORIES, CATEGORY_MAX } from "./inventory-seed.js?v=45";

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
  instances:  collection(db, "instances"),
  settings:   collection(db, "settings"),
  it_requests: collection(db, "it_requests"),
  shopping:   collection(db, "shopping"),
  inventory:  collection(db, "inventory"),
};

// ---------- App meta ----------
const APP_VERSION = "v4.5.0";

// ---------- Night mode (personal preference, stored per-browser) ----------
const THEME_KEY = "vulcan_theme";
function applyTheme(theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}
function currentTheme() { return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light"; }
function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
  syncThemeToggleUI();
}
function syncThemeToggleUI() {
  const dark = currentTheme() === "dark";
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = dark ? "☀️" : "🌙";
  const settingsToggle = document.getElementById("settings-theme-toggle");
  if (settingsToggle) settingsToggle.checked = dark;
}
applyTheme(currentTheme()); // apply immediately, before first paint, to avoid a flash

// ---------- Title color (personal preference, stored per-browser) ----------
const TITLE_COLOR_KEY = "vulcan_title_color";
function currentTitleColor() { return localStorage.getItem(TITLE_COLOR_KEY) || ""; }
function applyTitleColor(color) {
  if (color) document.documentElement.style.setProperty("--title-color", color);
  else document.documentElement.style.removeProperty("--title-color");
}
function setTitleColor(color) {
  if (color) localStorage.setItem(TITLE_COLOR_KEY, color);
  else localStorage.removeItem(TITLE_COLOR_KEY);
  applyTitleColor(color);
}
applyTitleColor(currentTitleColor());

// ---------- Global state ----------
let ME = null;              // { uid, name, email, photo, role }
let ROUTE = "dashboard";    // active view id
let PREVIEW_ROLE = null;   // super admin previewing another role's view
let tickHandler = null;     // function called every second by the global interval
let unsubscribers = [];     // onSnapshot cleanups for the current view
let bellUnsub = null;       // IT notifications listener
let pendingHighlight = null;// name to highlight on the map after accepting a request
let INV_TAB = "CPU";      // active Inventory category tab

// ---------- Roles & capabilities ----------
const ROLE_LABELS = {
  super_admin: "Super admin", it_admin: "IT admin", it_agent: "IT agent",
  supervisor: "Supervisor", agent: "Agent", admin: "IT admin",
};
const ROLE_OPTIONS = ["agent", "supervisor", "it_agent", "it_admin", "super_admin"];
function baseRole() {
  if (ME && isSuperAdminEmail(ME.email)) return "super_admin";
  return (ME && ME.role) || "agent";
}
function effRole() { return PREVIEW_ROLE || baseRole(); }
const CAP = {
  adminDash:      ["super_admin", "it_admin", "admin", "supervisor"],
  management:     ["super_admin", "it_admin", "admin"],
  mapEdit:        ["super_admin", "it_admin", "admin"],
  seeTasks:       ["super_admin", "it_admin", "admin"],
  addTasks:       ["super_admin", "it_admin", "admin"],
  itStaff:        ["super_admin", "it_admin", "admin", "it_agent"],
  createReq:      ["super_admin", "it_admin", "admin", "it_agent", "supervisor"],
  shoppingCreate: ["super_admin", "it_admin", "admin", "supervisor"],
  shoppingView:   ["super_admin", "it_admin", "admin", "it_agent"],
  inventory:      ["super_admin", "it_admin", "admin", "it_agent"],
  instances:      ["super_admin", "it_admin", "admin"],
  deleteUsers:    ["super_admin"],
  roleManage:     ["super_admin"],
  settings:       ["super_admin"],
  viewAs:         ["super_admin"],
};
function can(cap) { const a = CAP[cap]; return !!a && a.includes(effRole()); }

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
$("theme-toggle") && $("theme-toggle").addEventListener("click", toggleTheme);
syncThemeToggleUI();

// ---------- Code sign-in (username + PIN, for devices without Google) ----------
let PIN = "";
function setPin(next) {
  PIN = next.slice(0, 10);
  const disp = $("pin-display");
  if (disp) disp.textContent = PIN.length ? "•".repeat(PIN.length) : "Enter your code";
}
function resolveUsername(input) {
  const v = (input || "").trim();
  if (!v) return "";
  if (v.includes("@")) return v.toLowerCase();
  const mapped = USERNAME_MAP[v.toLowerCase()];
  return mapped || "";
}
$("show-code-login") && $("show-code-login").addEventListener("click", () => {
  $("login-screen").querySelector(".login-card:not(.hidden)").classList.add("hidden");
  $("code-login-card").classList.remove("hidden");
  setPin("");
});
$("hide-code-login") && $("hide-code-login").addEventListener("click", () => {
  $("code-login-card").classList.add("hidden");
  $("login-screen").querySelectorAll(".login-card")[0].classList.remove("hidden");
  setPin("");
});
document.querySelectorAll(".num-btn[data-num]").forEach((b) =>
  b.addEventListener("click", () => setPin(PIN + b.dataset.num)));
$("pin-back") && $("pin-back").addEventListener("click", () => setPin(PIN.slice(0, -1)));
$("pin-clear") && $("pin-clear").addEventListener("click", () => setPin(""));
$("code-signin-btn") && $("code-signin-btn").addEventListener("click", async () => {
  const email = resolveUsername($("code-username").value);
  if (!email) { toast("Unknown username — try your full email instead.", true); return; }
  if (PIN.length < 6) { toast("Code must be at least 6 digits.", true); return; }
  const btn = $("code-signin-btn");
  btn.disabled = true; btn.textContent = "Signing in…";
  try {
    await signInWithEmailAndPassword(auth, email, PIN);
  } catch (e) {
    const msg = e.code === "auth/invalid-credential" || e.code === "auth/wrong-password"
      ? "Wrong code. Try again."
      : e.code === "auth/user-not-found"
      ? "No account for that username yet."
      : "Sign-in failed: " + e.message;
    toast(msg, true);
    setPin("");
  }
  btn.disabled = false; btn.textContent = "Sign in";
});
setPin("");

onAuthStateChanged(auth, async (user) => {
  clearView();
  if (!user) {
    ME = null;
    if (bellUnsub) { try { bellUnsub(); } catch (_) {} bellUnsub = null; }
    $("bell-btn") && $("bell-btn").classList.add("hidden");
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

  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("Timed out loading your account. Check your connection and try again.")), 15000));
    ME = await Promise.race([bootstrapUser(user), timeout]);
    loginScr.classList.add("hidden");
    splash.classList.add("hidden");
    appEl.classList.remove("hidden");
    renderShell();
    renderVersionFooters();
    startBellWatch();
    go(defaultRouteFor(effRole()));
  } catch (err) {
    console.error("Vulcan failed to load:", err);
    showLoadError(err);
  }
});

// If login/setup ever fails or hangs, show the real reason instead of spinning forever.
function showLoadError(err) {
  splash.innerHTML = `
    <div class="splash-brand">
      <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M3 7h11a6 6 0 0 0 5 3l2-2v4.2A5.8 5.8 0 0 1 15.2 18H12l1.4 3H6.6L8 18H7a4 4 0 0 1-4-4V7Z" fill="currentColor"/>
        <rect x="6" y="21" width="12" height="2" rx="1" fill="currentColor"/>
      </svg></span>
      <div class="splash-mark">Vulcan</div>
    </div>
    <p style="color:#DC2626;font-size:13px;margin-top:16px;max-width:340px;text-align:center;padding:0 20px;line-height:1.5;">
      Couldn't load your account.<br>
      <span style="font-family:monospace;font-size:11.5px;color:#6B7280;word-break:break-word;">${esc((err && err.message) || String(err))}</span>
    </p>
    <button id="retry-btn" style="margin-top:16px;background:#FF6A00;color:#fff;border:none;border-radius:8px;padding:10px 20px;font-weight:600;font-size:13px;cursor:pointer;">Retry</button>
  `;
  splash.classList.remove("hidden");
  appEl.classList.add("hidden");
  loginScr.classList.add("hidden");
  $("retry-btn") && $("retry-btn").addEventListener("click", () => location.reload());
}

// ---------- IT notification bell ----------
function startBellWatch() {
  const btn = $("bell-btn");
  if (bellUnsub) { try { bellUnsub(); } catch (_) {} bellUnsub = null; }
  const staff = can("itStaff");
  const creator = can("createReq");
  if (!staff && !creator) { btn.classList.add("hidden"); return; }
  btn.classList.remove("hidden");
  btn.onclick = () => go("it");
  bellUnsub = onSnapshot(C.it_requests, (snap) => {
    let n = 0;
    snap.forEach((d) => {
      const r = d.data();
      if (staff && r.status === "open") n++;
      else if (!staff && r.created_by === ME.uid && (r.status === "accepted" || r.status === "done")) n++;
    });
    const c = $("bell-count");
    if (n > 0) { c.textContent = n > 9 ? "9+" : String(n); c.classList.remove("hidden"); }
    else c.classList.add("hidden");
  }, (err) => console.warn("bell:", err.message));
}

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
      await updateDoc(ref, { role: "super_admin" });
      data.role = "super_admin";
    }
    return { ...data };
  }
  const d = snap.data();
  // Keep profile fresh from Google (name/photo may change).
  const patch = {};
  if (d.name !== user.displayName && user.displayName) patch.name = user.displayName;
  if (d.profile_picture !== user.photoURL && user.photoURL) patch.profile_picture = user.photoURL;
  // Auto-promote configured super admins (rules also grant them by email).
  if (isSuperAdminEmail(user.email) && d.role !== "super_admin") patch.role = "super_admin";
  if (Object.keys(patch).length) await updateDoc(ref, patch);
  return { ...d, ...patch };
}

// ============================================================
//  App shell + navigation
// ============================================================
function navFor(role) {
  const D = ["dashboard", "Dashboard", icon("grid")];
  const MAP = ["map", "Map", icon("map")];
  const IT = ["it", "IT Service", icon("bolt")];
  const SHOP = ["shopping", "Shopping", icon("cart")];
  const INV = ["inventory", "Inventory", icon("box")];
  const TASKS = ["tasks", "Tasks", icon("check")];
  const MYTASKS = ["my-tasks", "My Tasks", icon("check")];
  const AGENTS = ["agents", "Agents", icon("users")];
  const ACT = ["activity", "Activity", icon("list")];
  const REP = ["reports", "Time Reports", icon("chart")];
  const SET = ["settings", "Settings", icon("cog")];
  switch (role) {
    case "agent":       return [D, MAP];
    case "it_agent":    return [D, MYTASKS, IT, SHOP, INV, MAP];
    case "supervisor":  return [MYTASKS, IT, SHOP, MAP];
    case "it_admin":
    case "admin":       return [AGENTS, TASKS, ACT, REP, IT, SHOP, INV, MAP];
    case "super_admin": return [AGENTS, TASKS, ACT, REP, IT, SHOP, INV, MAP, SET];
    default:            return [D, MAP];
  }
}
// First nav item for a role — used as the landing page after login (Dashboard
// isn't in every role's nav anymore, so we can't always default to it).
function defaultRouteFor(role) {
  const items = navFor(role);
  return items.length ? items[0][0] : "dashboard";
}

function renderShell() {
  $("side-avatar").src = ME.profile_picture || fallbackAvatar(ME.name);
  $("side-avatar").onerror = () => { $("side-avatar").src = fallbackAvatar(ME.name); };
  $("side-name").textContent = ME.name;
  $("side-role").textContent = ROLE_LABELS[effRole()] || effRole();
  const items = navFor(effRole());
  navEl.innerHTML = items.map(([id, label, ic]) =>
    `<button class="nav-item" data-route="${id}">${ic}<span>${label}</span></button>`
  ).join("");
  navEl.querySelectorAll(".nav-item").forEach((b) =>
    b.addEventListener("click", () => { go(b.dataset.route); closeMobileNav(); })
  );
  const pe = $("preview-exit");
  if (pe) {
    if (PREVIEW_ROLE) {
      pe.textContent = `Exit ${ROLE_LABELS[PREVIEW_ROLE] || PREVIEW_ROLE} preview`;
      pe.classList.remove("hidden");
      pe.onclick = () => { PREVIEW_ROLE = null; renderShell(); go(defaultRouteFor(effRole())); };
    } else {
      pe.classList.add("hidden");
    }
  }
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

// ============================================================
//  Instances (management-only notes on an agent's day:
//  a time range + reason — never shown to agents)
// ============================================================
async function loadInstances(uid, dayKey) {
  try {
    return (await getDocsArr(query(C.instances, where("user_id", "==", uid), where("date", "==", dayKey))))
      .sort((a, b) => (ms(a.from) || ms(a.at) || 0) - (ms(b.from) || ms(b.at) || 0));
  } catch (e) {
    console.warn("Could not load instances:", e.message);
    return [];
  }
}
async function addInstance(uid, userName, { fromHHMM, toHHMM, reason, dayKey }) {
  const mk = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    const [y, mo, d] = dayKey.split("-").map(Number);
    return new Date(y, mo - 1, d, h, m, 0, 0);
  };
  const from = mk(fromHHMM);
  const to = mk(toHHMM);
  await addDoc(C.instances, {
    user_id: uid, user_name: userName,
    created_by: ME.uid, created_by_name: ME.name,
    reason: (reason || "").trim(),
    from: Timestamp.fromDate(from),
    to: Timestamp.fromDate(to),
    at: Timestamp.fromDate(from), // keep for older sorts
    date: dayKey, created_at: serverTimestamp(),
  });
}
async function deleteInstance(id) { await deleteDoc(doc(C.instances, id)); }
async function updateInstance(id, { fromHHMM, toHHMM, reason, dayKey }) {
  const mk = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    const [y, mo, d] = dayKey.split("-").map(Number);
    return new Date(y, mo - 1, d, h, m, 0, 0);
  };
  const from = mk(fromHHMM), to = mk(toHHMM);
  if (to.getTime() < from.getTime()) { toast("End can't be before start.", true); return false; }
  await updateDoc(doc(C.instances, id), {
    reason: (reason || "").trim(),
    from: Timestamp.fromDate(from),
    to: Timestamp.fromDate(to),
    at: Timestamp.fromDate(from),
  });
  return true;
}

// Build a plain-text version of a day summary (for copy/paste into Slack, email, etc.)
// One simple chronological timeline: tasks appear when they start AND when they finish.
function buildSummaryText(u, dayKey, data, st, instances) {
  const L = [];
  L.push(`${u.name} — ${fmtDate(dayKey)}`);
  L.push(`Status: ${{ working: "Working", lunch: "On lunch", out: "Clocked out" }[st.status]}`);
  L.push(`Worked: ${fmtHM(st.totalWorkedSec)}   Lunch: ${fmtHM(st.totalLunchSec)}   Tasks: ${data.activities.length}`);
  L.push("");
  L.push("TIMELINE");

  const ev = [];
  data.sessions.forEach((s) => {
    ev.push({ t: ms(s.clock_in), line: `${fmtClock(ms(s.clock_in))}  Clocked in` });
    if (s.clock_out) ev.push({ t: ms(s.clock_out), line: `${fmtClock(ms(s.clock_out))}  Clocked out` });
  });
  data.lunches.forEach((l) => {
    const end = l.end_time ? ms(l.end_time) : Date.now();
    ev.push({
      t: ms(l.start_time),
      line: `${fmtClock(ms(l.start_time))} - ${l.end_time ? fmtClock(ms(l.end_time)) : "now"}  Lunch (${fmtHM((end - ms(l.start_time)) / 1000)})`,
    });
  });
  data.activities.forEach((a) => {
    const from = fmtClock(ms(a.start_time));
    const to = a.end_time ? fmtClock(ms(a.end_time)) : "now";
    ev.push({ t: ms(a.start_time), line: `${from} - ${to}  ${a.description}` });
  });
  // instances sit inline in the same timeline
  (instances || []).forEach((i) => {
    const from = ms(i.from || i.at), to = i.to ? ms(i.to) : null;
    ev.push({
      t: from,
      line: `${fmtClock(from)}${to ? " - " + fmtClock(to) : ""}  ${i.reason || i.note || i.type || ""}`,
    });
  });

  // Mark when a task actually finished — but only if other things happened
  // while it was running, otherwise the line would just repeat itself.
  const baseTimes = ev.map((e) => e.t);
  data.activities.forEach((a) => {
    if (!a.end_time) return;
    const s = ms(a.start_time), e2 = ms(a.end_time);
    const spanned = baseTimes.some((t) => t > s && t < e2);
    if (spanned) {
      ev.push({
        t: e2,
        line: `${fmtClock(s)} - ${fmtClock(e2)}  ${a.description} (Finished)`,
      });
    }
  });

  ev.sort((x, y) => x.t - y.t);
  if (ev.length) ev.forEach((e) => L.push(e.line));
  else L.push("(nothing logged)");

  return L.join("\n");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // Fallback for browsers/contexts without the async clipboard API
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }
}

// Admin-only: edit a whole task (agents can't — enforced in rules).
async function adminSaveActivity(id, { desc, startHHMM, endHHMM, planned }, dayKey) {
  if (!desc) { toast("Description can't be empty.", true); return false; }
  if (!startHHMM) { toast("Start time is required.", true); return false; }
  const mk = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    const [y, mo, d] = dayKey.split("-").map(Number);
    return new Date(y, mo - 1, d, h, m, 0, 0);
  };
  const start = mk(startHHMM);
  const end = endHHMM ? mk(endHHMM) : null;
  if (end && end.getTime() < start.getTime()) { toast("End can't be before start.", true); return false; }
  await updateDoc(doc(C.activities, id), {
    description: desc,
    start_time: Timestamp.fromDate(start),
    end_time: end ? Timestamp.fromDate(end) : null,
    duration: end ? Math.round((end.getTime() - start.getTime()) / 1000) : 0,
    planned_minutes: Math.max(5, planned || 15),
  });
  return true;
}

// ============================================================
//  Router
// ============================================================
const TITLES = {
  dashboard: "Dashboard", "my-tasks": "My Tasks", "my-activity": "My Activity",
  "my-time": "My Time", profile: "Profile", agents: "Agents", tasks: "Tasks",
  activity: "Activity", reports: "Time Reports", map: "Office Map",
  it: "IT Service", shopping: "Shopping", inventory: "Inventory", settings: "Settings",
};
function render() {
  clearView();
  titleEl.textContent = TITLES[ROUTE] || "Dashboard";
  viewEl.classList.toggle("view--wide", ROUTE === "map");
  if (ROUTE === "map") return viewMap(pendingHighlight);
  if (ROUTE === "it") return can("createReq") || can("itStaff") ? viewITService() : go(defaultRouteFor(effRole()));
  if (ROUTE === "shopping") return can("shoppingCreate") || can("shoppingView") ? viewShopping() : go(defaultRouteFor(effRole()));
  if (ROUTE === "inventory") return viewInventory();
  if (ROUTE === "dashboard") return can("adminDash") ? viewAdminDashboard() : viewAgentDashboard();
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

// Office map — self-contained page embedded in an iframe (visible to everyone)
function viewMap(highlight) {
  const h = highlight ? "&highlight=" + encodeURIComponent(highlight) : "";
  pendingHighlight = null;
  viewEl.innerHTML = `<div class="map-wrap"><iframe class="map-frame" src="assets/office-map.html?v=45${h}" title="Office Map"></iframe></div>`;
}

// IT Service board + Inventory placeholder are defined lower in the file.

// ============================================================
//  IT SERVICE — requests + shopping list
// ============================================================
const IT_CATEGORIES = ["Internet issue", "Slack issue", "Tailscale issue", "Audio issue", "Mouse issue", "Keyboard issue", "Computer issue", "Purchase request", "Other"];

async function viewITService() {
  viewEl.innerHTML = skeleton();
  const staff = can("itStaff");
  const [reqs, users] = await Promise.all([
    getDocsArr(C.it_requests).catch(() => []),
    getDocsArr(C.users).catch(() => []),
  ]);
  reqs.sort((a, b) => (ms(b.created_at) || 0) - (ms(a.created_at) || 0));

  const myReqs = staff ? reqs : reqs.filter((r) => r.created_by === ME.uid);
  const openReqs = myReqs.filter((r) => r.status !== "done");
  const doneReqs = myReqs.filter((r) => r.status === "done");

  const statusBadge = (s) => {
    const map = { open: ["out", "Open"], accepted: ["lunch", "Accepted"], done: ["working", "Resolved"] };
    const [cls, label] = map[s] || map.open;
    return `<span class="badge ${cls}"><span class="dot ${cls}"></span>${label}</span>`;
  };

  const body = (r) => {
    if (r.category === "Purchase request" && r.purchase) {
      const p = r.purchase;
      return `<div class="it-details">
        <div><b>Wants:</b> ${esc(p.item || "—")}</div>
        ${p.link ? `<div><b>Link:</b> <a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.link)}</a></div>` : ""}
        ${p.why ? `<div><b>Why:</b> ${esc(p.why)}</div>` : ""}
      </div>`;
    }
    return r.details ? `<p class="it-details">${esc(r.details)}</p>` : "";
  };

  const reqCard = (r) => `
    <div class="it-card" data-id="${r.id}">
      <div class="it-head">
        <div><span class="it-cat">${esc(r.category || "Request")}</span> ${statusBadge(r.status)}</div>
        <span class="em">${fmtClock(ms(r.created_at))} · ${fmtDate(r.date || dateKeyFromMs(ms(r.created_at) || Date.now()))}</span>
      </div>
      <div class="it-for">Needs help: <b>${esc(r.for_name || "—")}</b> · from ${esc(r.created_by_name || "")}</div>
      ${body(r)}
      ${r.status !== "open" ? `<div class="it-meta">Accepted by <b>${esc(r.accepted_by_name || "—")}</b></div>` : ""}
      ${r.status === "done" ? `<div class="it-resolution">Resolved: ${esc(r.resolution || "—")}</div>` : ""}
      <div class="it-actions">
        ${staff && r.status === "open" ? `<button class="btn btn-primary btn-sm" data-accept="${r.id}" data-for="${esc(r.for_name || "")}">Accept</button>` : ""}
        ${staff && r.status === "accepted" && r.accepted_by === ME.uid ? `<button class="btn btn-dark btn-sm" data-resolve="${r.id}">Mark done</button>` : ""}
        ${staff && r.status !== "open" && r.for_name ? `<button class="btn btn-outline btn-sm" data-locate="${esc(r.for_name)}">Show on map</button>` : ""}
        ${(can("management") || r.created_by === ME.uid) && r.status !== "done" ? `<button class="btn btn-outline btn-sm" data-cancel="${r.id}">Cancel</button>` : ""}
      </div>
    </div>`;

  viewEl.innerHTML = `
    <div class="page-head">
      <div class="section-title" style="margin:0">${staff ? "IT requests" : "My IT requests"}</div>
      <div class="it-topbtns">
        ${can("createReq") ? `<button class="btn btn-primary btn-sm" id="new-req">New IT request</button>` : ""}
      </div>
    </div>

    <div class="it-list">
      ${openReqs.length ? openReqs.map(reqCard).join("") : `<div class="card"><div class="empty"><strong>No open requests</strong>${can("createReq") ? "Create one with the button above." : "You're all caught up."}</div></div>`}
    </div>
    ${doneReqs.length ? `<div class="section-title mt-18" style="margin-top:22px">Resolved</div><div class="it-list">${doneReqs.slice(0, 20).map(reqCard).join("")}</div>` : ""}`;

  $("new-req") && $("new-req").addEventListener("click", () => openNewRequestModal(users));

  viewEl.querySelectorAll("[data-accept]").forEach((b) => b.addEventListener("click", guard(async () => {
    await updateDoc(doc(C.it_requests, b.dataset.accept), {
      status: "accepted", accepted_by: ME.uid, accepted_by_name: ME.name, accepted_at: Timestamp.now(),
    });
    toast("Request accepted");
    if (b.dataset.for) { pendingHighlight = b.dataset.for; go("map"); } else viewITService();
  })));
  viewEl.querySelectorAll("[data-resolve]").forEach((b) => b.addEventListener("click", () => openResolveModal(b.dataset.resolve)));
  viewEl.querySelectorAll("[data-locate]").forEach((b) => b.addEventListener("click", () => { pendingHighlight = b.dataset.locate; go("map"); }));
  viewEl.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", guard(async () => {
    await deleteDoc(doc(C.it_requests, b.dataset.cancel));
    toast("Request cancelled");
    viewITService();
  })));
}

// ============================================================
//  SHOPPING LIST — its own page
// ============================================================
async function viewShopping() {
  viewEl.innerHTML = skeleton();
  const canViewAll = can("shoppingView");
  const shopAll = await getDocsArr(C.shopping).catch(() => []);
  const shop = (canViewAll ? shopAll : shopAll.filter((s) => s.created_by === ME.uid))
    .sort((a, b) => (a.status === "done") - (b.status === "done") || (ms(b.created_at) || 0) - (ms(a.created_at) || 0));

  const pendingQty = shop.filter((s) => s.status !== "done").reduce((t, s) => t + (Number(s.quantity) || 1), 0);

  const row = (s) => `
    <div class="it-shop-row ${s.status === "done" ? "done" : ""}" data-id="${s.id}">
      <div class="it-shop-main">
        <div class="nm">${esc(s.item_name)} ${(s.quantity && s.quantity > 1) ? `<span class="shop-amount">× ${s.quantity}</span>` : ""} ${s.status === "done" ? '<span class="badge working">bought</span>' : ""}</div>
        <div class="em">${esc(s.reason || "")}${s.amazon_link ? ` · <a href="${esc(s.amazon_link)}" target="_blank" rel="noopener">link</a>` : ""} · from ${esc(s.created_by_name || "")}</div>
      </div>
      <div class="it-actions" style="margin:0">
        ${canViewAll && s.status !== "done" ? `<button class="btn btn-dark btn-sm" data-shopdone="${s.id}">Mark bought</button>` : ""}
        ${(canViewAll || s.created_by === ME.uid) ? `<button class="btn btn-outline btn-sm" data-shopdel="${s.id}">Delete</button>` : ""}
      </div>
    </div>`;

  viewEl.innerHTML = `
    <div class="page-head">
      <div class="section-title" style="margin:0">${canViewAll ? "Shopping list" : "My shopping requests"}</div>
      ${can("shoppingCreate") ? `<button class="btn btn-primary btn-sm" id="new-shop">Request item</button>` : ""}
    </div>
    ${pendingQty > 0 ? `<div class="tiles" style="margin-bottom:14px"><div class="tile"><div class="t-label">Items pending</div><div class="t-value">${pendingQty}</div></div></div>` : ""}
    <div class="card card-pad">
      ${shop.length ? `<div class="it-list">${shop.map(row).join("")}</div>`
        : `<div class="empty"><strong>Nothing here yet</strong>${can("shoppingCreate") ? "Request an item with the button above." : "No shopping items."}</div>`}
    </div>`;

  $("new-shop") && $("new-shop").addEventListener("click", () => openShoppingModal());
  viewEl.querySelectorAll("[data-shopdone]").forEach((b) => b.addEventListener("click", guard(async () => {
    await updateDoc(doc(C.shopping, b.dataset.shopdone), { status: "done", done_by: ME.uid, done_by_name: ME.name, done_at: Timestamp.now() });
    toast("Marked as bought");
    viewShopping();
  })));
  viewEl.querySelectorAll("[data-shopdel]").forEach((b) => b.addEventListener("click", guard(async () => {
    await deleteDoc(doc(C.shopping, b.dataset.shopdel));
    toast("Item deleted");
    viewShopping();
  })));
}

function openNewRequestModal(users) {
  const people = (users || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  openModal(`
    <h3 class="modal-title">New IT request</h3>
    <label class="field-label">Who needs help?</label>
    <input id="req-for" class="modal-input" list="req-people" placeholder="Type a name" />
    <datalist id="req-people">${people.map((p) => `<option value="${esc(p.name)}">`).join("")}</datalist>
    <label class="field-label" style="margin-top:12px">Category</label>
    <select id="req-cat" class="modal-input">${IT_CATEGORIES.map((c) => `<option>${c}</option>`).join("")}</select>

    <div id="req-generic">
      <label class="field-label" style="margin-top:12px">What's going on?</label>
      <textarea id="req-details" class="modal-textarea" placeholder="Describe the issue"></textarea>
    </div>

    <div id="req-purchase" class="hidden">
      <label class="field-label" style="margin-top:12px">What do you want?</label>
      <input id="req-item" class="modal-input" placeholder="e.g. Logitech M185 mouse" />
      <label class="field-label" style="margin-top:12px">Link to the item</label>
      <input id="req-link" class="modal-input" placeholder="https://amazon.com.mx/..." />
      <label class="field-label" style="margin-top:12px">Why do you need it?</label>
      <textarea id="req-why" class="modal-textarea" placeholder="Reason"></textarea>
    </div>

    <div class="modal-actions">
      <button class="btn btn-outline btn-sm" id="req-cancel">Cancel</button>
      <button class="btn btn-primary btn-sm" id="req-send">Send request</button>
    </div>
  `);
  const catSel = document.getElementById("req-cat");
  const syncFields = () => {
    const purchase = catSel.value === "Purchase request";
    document.getElementById("req-purchase").classList.toggle("hidden", !purchase);
    document.getElementById("req-generic").classList.toggle("hidden", purchase);
  };
  catSel.addEventListener("change", syncFields);
  syncFields();

  document.getElementById("req-cancel").addEventListener("click", closeModal);
  document.getElementById("req-send").addEventListener("click", guard(async () => {
    const for_name = document.getElementById("req-for").value.trim();
    const category = catSel.value;
    if (!for_name) { toast("Who needs help?", true); return; }
    const base = {
      for_name, category, status: "open",
      created_by: ME.uid, created_by_name: ME.name, created_by_email: ME.email,
      accepted_by: null, accepted_by_name: null, resolution: "",
      date: todayKey(), created_at: Timestamp.now(),
    };
    if (category === "Purchase request") {
      const item = document.getElementById("req-item").value.trim();
      const link = document.getElementById("req-link").value.trim();
      const why = document.getElementById("req-why").value.trim();
      if (!item) { toast("What do you want to buy?", true); return; }
      base.details = "";
      base.purchase = { item, link, why };
    } else {
      base.details = document.getElementById("req-details").value.trim();
      base.purchase = null;
    }
    await addDoc(C.it_requests, base);
    closeModal();
    toast("Request sent to IT");
    viewITService();
  }));
  setTimeout(() => document.getElementById("req-for")?.focus(), 40);
}

function openResolveModal(id) {
  openModal(`
    <h3 class="modal-title">Mark as done</h3>
    <label class="field-label">How was it solved?</label>
    <textarea id="res-note" class="modal-textarea" placeholder="Short explanation for the requester"></textarea>
    <div class="modal-actions">
      <button class="btn btn-outline btn-sm" id="res-cancel">Cancel</button>
      <button class="btn btn-primary btn-sm" id="res-save">Mark done</button>
    </div>
  `);
  document.getElementById("res-cancel").addEventListener("click", closeModal);
  document.getElementById("res-save").addEventListener("click", guard(async () => {
    const resolution = document.getElementById("res-note").value.trim();
    await updateDoc(doc(C.it_requests, id), { status: "done", resolution, done_at: Timestamp.now() });
    closeModal();
    toast("Marked done");
    viewITService();
  }));
}

function openShoppingModal() {
  openModal(`
    <h3 class="modal-title">Request a shopping item</h3>
    <label class="field-label">Item name</label>
    <input id="shop-name" class="modal-input" placeholder="e.g. Logitech M185 mouse" />
    <label class="field-label" style="margin-top:12px">Amazon link</label>
    <input id="shop-link" class="modal-input" placeholder="https://amazon.com.mx/..." />
    <label class="field-label" style="margin-top:12px">How many?</label>
    <div class="duration-row">
      <button class="dur-step" data-q="-1" type="button">–</button>
      <input id="shop-qty" class="dur-input num" type="number" min="1" step="1" value="1" />
      <span class="dur-unit">unit(s)</span>
      <button class="dur-step" data-q="1" type="button">+</button>
    </div>
    <label class="field-label" style="margin-top:12px">Why is it needed?</label>
    <textarea id="shop-reason" class="modal-textarea" placeholder="Reason"></textarea>
    <div class="modal-actions">
      <button class="btn btn-outline btn-sm" id="shop-cancel">Cancel</button>
      <button class="btn btn-primary btn-sm" id="shop-send">Add to shopping list</button>
    </div>
  `);
  document.getElementById("shop-cancel").addEventListener("click", closeModal);
  const qtyInput = document.getElementById("shop-qty");
  document.querySelectorAll(".dur-step").forEach((b) =>
    b.addEventListener("click", () => {
      qtyInput.value = Math.max(1, (parseInt(qtyInput.value, 10) || 1) + parseInt(b.dataset.q, 10));
    }));
  document.getElementById("shop-send").addEventListener("click", guard(async () => {
    const item_name = document.getElementById("shop-name").value.trim();
    const amazon_link = document.getElementById("shop-link").value.trim();
    const quantity = Math.max(1, parseInt(qtyInput.value, 10) || 1);
    const reason = document.getElementById("shop-reason").value.trim();
    if (!item_name) { toast("Item name is required.", true); return; }
    await addDoc(C.shopping, {
      item_name, amazon_link, quantity, reason, status: "open",
      created_by: ME.uid, created_by_name: ME.name,
      date: todayKey(), created_at: Timestamp.now(),
    });
    closeModal();
    toast("Added to shopping list");
    viewShopping();
  }));
  setTimeout(() => document.getElementById("shop-name")?.focus(), 40);
}

// ============================================================
//  INVENTORY — workstations (shared, IT roles only)
// ============================================================
async function viewInventory() {
  viewEl.innerHTML = skeleton();
  let items = await getDocsArr(C.inventory).catch(() => []);

  // Live-refresh when the map (or another admin) writes to inventory.
  let firstSnap = true;
  unsubscribers.push(onSnapshot(C.inventory, () => {
    if (firstSnap) { firstSnap = false; return; }
    if (ROUTE === "inventory" && !document.querySelector("#inv-body input:focus")) viewInventory();
  }, (err) => console.warn("inventory live:", err.message)));

  // First run: seed from the Coda export.
  if (!items.length) {
    viewEl.innerHTML = `
      <div class="card card-pad">
        <div class="section-title">Workstation inventory</div>
        <p class="greeting-sub">No inventory loaded yet. Import the ${INVENTORY_SEED.length} CPUs from the Coda table to get started.</p>
        <button class="btn btn-primary btn-sm" id="inv-seed">Import ${INVENTORY_SEED.length} CPUs</button>
      </div>`;
    $("inv-seed").addEventListener("click", guard(async () => {
      const btn = $("inv-seed");
      btn.disabled = true; btn.textContent = "Importing…";
      for (const r of INVENTORY_SEED) {
        await addDoc(C.inventory, { ...r, tag: "", notes: "", created_at: Timestamp.now() });
      }
      toast("Inventory imported");
      viewInventory();
    }));
    return;
  }

  const catOf = (i) => i.category || "CPU";
  const isUnassigned = (i) => !((i.assigned_to || "").trim());
  const TABS = [...INVENTORY_CATEGORIES, "Unassigned"];
  if (!TABS.includes(INV_TAB)) INV_TAB = "CPU";

  const counts = {};
  TABS.forEach((t) => {
    counts[t] = t === "Unassigned"
      ? items.filter(isUnassigned).length
      : items.filter((i) => catOf(i) === t).length;
  });

  const shown = (INV_TAB === "Unassigned"
    ? items.filter(isUnassigned)
    : items.filter((i) => catOf(i) === INV_TAB)
  ).sort((a, b) => (a.assigned_to || "zzz").localeCompare(b.assigned_to || "zzz"));

  // duplicate serials across the whole inventory
  const serialCount = {};
  items.forEach((i) => { const v = (i.serial || "").trim(); if (v) serialCount[v] = (serialCount[v] || 0) + 1; });
  const dupes = Object.values(serialCount).filter((n) => n > 1).length;

  const row = (i) => `
    <tr data-id="${i.id}">
      <td><input class="iv-assigned" value="${esc(i.assigned_to || "")}" placeholder="Unassigned" /></td>
      <td><select class="iv-cat">${INVENTORY_CATEGORIES.map((c) => `<option ${catOf(i) === c ? "selected" : ""}>${c}</option>`).join("")}</select></td>
      <td><input class="iv-model" value="${esc(i.model || "")}" list="iv-models" placeholder="Model" /></td>
      <td><input class="iv-serial ${serialCount[(i.serial || "").trim()] > 1 ? "dupe" : ""}" value="${esc(i.serial || "")}" placeholder="Serial" /></td>
      <td><input class="iv-tag" value="${esc(i.tag || "")}" placeholder="Tag" /></td>
      <td><select class="iv-status">${INVENTORY_STATUSES.map((st) => `<option ${((i.status || "Assigned") === st) ? "selected" : ""}>${st}</option>`).join("")}</select></td>
      <td class="iv-actions">
        <button class="btn btn-outline btn-sm iv-save">Save</button>
        ${isUnassigned(i) ? `<button class="btn btn-danger btn-sm iv-del">Delete</button>`
          : `<button class="btn btn-outline btn-sm iv-release">Unassign</button>`}
      </td>
    </tr>`;

  viewEl.innerHTML = `
    <div class="page-head">
      <div class="section-title" style="margin:0">Inventory (${items.length} items)</div>
      <div class="it-topbtns">
        <button class="btn btn-outline btn-sm" id="inv-csv">Export CSV</button>
        <button class="btn btn-primary btn-sm" id="inv-add">Add item</button>
      </div>
    </div>

    <div class="inv-tabs">
      ${TABS.map((t) => `<button class="inv-tab ${t === INV_TAB ? "active" : ""}" data-tab="${t}">${t} <span>${counts[t]}</span></button>`).join("")}
    </div>

    ${dupes ? `<div class="inv-warn"><b>${dupes} serial number${dupes === 1 ? "" : "s"} appear on more than one item</b> — highlighted in red.</div>` : ""}

    <div class="filters">
      <div class="field"><label>Search</label><input id="inv-search" placeholder="Name, model, serial or tag" /></div>
    </div>

    <datalist id="iv-models">${INVENTORY_MODELS.map((m) => `<option value="${m}">`).join("")}</datalist>
    <div class="card table-wrap">
      ${shown.length ? `<table class="inv-table"><thead><tr>
        <th>Assigned to</th><th>Category</th><th>Model</th><th>Serial number</th><th>Asset tag</th><th>Status</th><th></th>
      </tr></thead><tbody id="inv-body">${shown.map(row).join("")}</tbody></table>`
        : `<div class="empty"><strong>Nothing in ${esc(INV_TAB)}</strong>${INV_TAB === "Unassigned" ? "Everything is assigned." : "Add an item or assign one from the map."}</div>`}
    </div>`;

  viewEl.querySelectorAll(".inv-tab").forEach((b) =>
    b.addEventListener("click", () => { INV_TAB = b.dataset.tab; viewInventory(); }));

  viewEl.querySelectorAll("#inv-body tr").forEach((tr) => {
    const id = tr.dataset.id;
    tr.querySelector(".iv-save").addEventListener("click", guard(async () => {
      const who = tr.querySelector(".iv-assigned").value.trim();
      await updateDoc(doc(C.inventory, id), {
        assigned_to: who,
        category: tr.querySelector(".iv-cat").value,
        model: tr.querySelector(".iv-model").value.trim(),
        serial: tr.querySelector(".iv-serial").value.trim(),
        tag: tr.querySelector(".iv-tag").value.trim(),
        status: who ? tr.querySelector(".iv-status").value : "Unassigned",
      });
      toast("Saved");
      viewInventory();
    }));
    const rel = tr.querySelector(".iv-release");
    rel && rel.addEventListener("click", guard(async () => {
      await updateDoc(doc(C.inventory, id), { assigned_to: "", status: "Unassigned" });
      toast("Moved to Unassigned");
      viewInventory();
    }));
    const del = tr.querySelector(".iv-del");
    del && del.addEventListener("click", guard(async () => {
      await deleteDoc(doc(C.inventory, id));
      toast("Deleted");
      viewInventory();
    }));
  });

  $("inv-search") && $("inv-search").addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    viewEl.querySelectorAll("#inv-body tr").forEach((tr) => {
      const hay = [...tr.querySelectorAll("input")].map((i) => i.value).join(" ").toLowerCase();
      tr.style.display = hay.includes(q) ? "" : "none";
    });
  });

  $("inv-add").addEventListener("click", guard(async () => {
    await addDoc(C.inventory, {
      assigned_to: "", category: INV_TAB === "Unassigned" ? "CPU" : INV_TAB,
      model: "", serial: "", tag: "", status: "Unassigned", since: "", notes: "",
      created_at: Timestamp.now(),
    });
    toast("Item added");
    viewInventory();
  }));

  $("inv-csv").addEventListener("click", () => {
    const rows = [["Assigned To", "Category", "Model", "Serial Number", "Asset Tag", "Status"]];
    items.forEach((i) => rows.push([i.assigned_to || "", catOf(i), i.model || "", i.serial || "", i.tag || "", i.status || ""]));
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `inventory_${todayKey()}.csv`; a.click();
    URL.revokeObjectURL(url);
    toast("CSV exported");
  });
}

// ============================================================
//  AGENT — Dashboard
// ============================================================
async function refreshAgent() { if (ROUTE === "dashboard" && !can("adminDash")) viewAgentDashboard(); }

async function viewAgentDashboard() {
  viewEl.innerHTML = skeleton();
  const day = todayKey();
  const data = await loadDay(ME.uid, day);
  const st = deriveStatus(data);
  const shiftEnded = data.sessions.length > 0 && !st.openSession; // a day was started and then ended

  // ----- top banner (admin preview) -----
  const previewBanner = PREVIEW_ROLE ? `
    <div class="preview-banner">
      <span>Previewing as ${ROLE_LABELS[PREVIEW_ROLE] || PREVIEW_ROLE}</span>
      <button class="btn btn-outline btn-sm" id="exit-preview">Back to super admin</button>
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
          <button class="btn btn-dark btn-sm" id="btn-endtask-card">End task</button>
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
  $("exit-preview") && $("exit-preview").addEventListener("click", () => { PREVIEW_ROLE = null; renderShell(); go(defaultRouteFor(effRole())); });
  $("btn-startday") && $("btn-startday").addEventListener("click", guard(async () => { await clockIn(); }));
  $("btn-addtask") && $("btn-addtask").addEventListener("click", () => openAddTaskModal());
  $("btn-endtask") && $("btn-endtask").addEventListener("click", guard(endActivity));
  $("btn-endtask-card") && $("btn-endtask-card").addEventListener("click", guard(endActivity));
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
function buildTimeline(data, instances = []) {
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
  // Management-only instances (only passed in from the admin day summary)
  (instances || []).forEach((i) => {
    const from = ms(i.from || i.at), to = i.to ? ms(i.to) : null;
    events.push({
      t: from, node: "inst",
      time: `${fmtClock(from)}${to ? " – " + fmtClock(to) : ""}`,
      desc: i.reason || i.note || i.type || "Instance",
      dur: "Instance" + (to ? " · " + fmtHM((to - from) / 1000) : ""),
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
        ${can("viewAs") ? `<div class="viewas">
          <label class="field-label" style="margin:0">View as</label>
          <select id="view-as">
            <option value="">— my view —</option>
            ${ROLE_OPTIONS.map((r) => `<option value="${r}">${ROLE_LABELS[r]}</option>`).join("")}
          </select>
        </div>` : ""}
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

    $("view-as") && $("view-as").addEventListener("change", (e) => {
      PREVIEW_ROLE = e.target.value || null;
      renderShell();
      go("dashboard");
    });

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
    const instances = await loadInstances(uid, dayKey);
    const editor = (can("management") && acts.length) ? `
      <div class="card card-pad mt-18">
        <div class="section-title">Edit tasks (admin only)</div>
        <div class="task-edit-list">
          ${acts.map((a) => `
            <div class="task-edit-row" data-id="${a.id}">
              <input class="te-desc" type="text" value="${esc(a.description)}" placeholder="Description" />
              <label class="te-field"><span>Start</span><input class="te-start" type="time" value="${hhmm(ms(a.start_time))}" /></label>
              <label class="te-field"><span>End</span><input class="te-end" type="time" value="${a.end_time ? hhmm(ms(a.end_time)) : ""}" /></label>
              <label class="te-field"><span>Planned</span><input class="te-planned num" type="number" min="5" step="5" value="${a.planned_minutes || 15}" /></label>
              <button class="btn btn-outline btn-sm te-save">Save</button>
              <button class="btn btn-danger btn-sm te-del">Delete</button>
            </div>`).join("")}
        </div>
        <p class="modal-hint">Leave End empty to keep a task still running. Agents can't edit these — only you can.</p>
      </div>` : "";

    const instancesPanel = can("management") ? `
      <div class="card card-pad mt-18">
        <div class="section-title">Instances — management only 🔒</div>
        <p class="modal-hint" style="margin-top:0">Log a time range and a reason (breaks, incidents, etc.). Never shown to the agent.</p>
        <div class="inst-list">
          ${instances.length ? instances.map((i) => `
            <div class="inst-row" data-id="${i.id}">
              <label class="te-field"><span>From</span><input class="ie-from" type="time" value="${hhmm(ms(i.from || i.at))}" /></label>
              <label class="te-field"><span>To</span><input class="ie-to" type="time" value="${i.to ? hhmm(ms(i.to)) : hhmm(ms(i.from || i.at))}" /></label>
              <input class="ie-reason inst-note-input" type="text" value="${esc(i.reason || i.note || i.type || "")}" placeholder="Reason" />
              <span class="inst-by">by ${esc(i.created_by_name || "")}</span>
              <button class="btn btn-outline btn-sm ie-save">Save</button>
              <button class="btn btn-danger btn-sm inst-del">Delete</button>
            </div>`).join("") : `<div class="em" style="padding:6px 0">No instances logged for this day.</div>`}
        </div>
        <div class="inst-divider"></div>
        <div class="section-title" style="font-size:11px">Add instance</div>
        <div class="inst-form">
          <label class="te-field"><span>From</span><input id="inst-from" type="time" value="${hhmm(Date.now())}" /></label>
          <label class="te-field"><span>To</span><input id="inst-to" type="time" value="${hhmm(Date.now())}" /></label>
          <input id="inst-reason" class="inst-note-input" type="text" placeholder="Reason" />
          <button class="btn btn-primary btn-sm" id="inst-add">Save</button>
        </div>
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
        <div class="tile"><div class="t-label">Instances</div><div class="t-value">${instances.length}</div></div>
      </div>
      <div class="card card-pad">
        <div class="summary-head">
          <div class="section-title" style="margin:0">Day summary — ${fmtDate(dayKey)}</div>
          <button class="btn btn-outline btn-sm" id="copy-summary">Copy</button>
        </div>
        ${buildTimeline(data, instances)}
      </div>
      ${instancesPanel}
      ${editor}
      <button class="btn btn-outline btn-sm mt-18" style="margin-top:18px" id="back-btn">← Back</button>`;
    $("detail-date").addEventListener("change", (e) => draw(e.target.value));
    $("back-btn").addEventListener("click", () => go(can("management") ? "agents" : "dashboard"));

    $("copy-summary") && $("copy-summary").addEventListener("click", async () => {
      const btn = $("copy-summary");
      const ok = await copyText(buildSummaryText(u, dayKey, data, st, instances));
      if (ok) {
        btn.textContent = "Copied";
        toast("Summary copied");
        setTimeout(() => { if ($("copy-summary")) $("copy-summary").textContent = "Copy"; }, 1600);
      } else {
        toast("Couldn't copy — try again", true);
      }
    });

    // task editor wiring
    viewEl.querySelectorAll(".task-edit-row").forEach((row) => {
      const id = row.dataset.id;
      row.querySelector(".te-save").addEventListener("click", guard(async () => {
        const ok = await adminSaveActivity(id, {
          desc: row.querySelector(".te-desc").value.trim(),
          startHHMM: row.querySelector(".te-start").value,
          endHHMM: row.querySelector(".te-end").value,
          planned: parseInt(row.querySelector(".te-planned").value, 10) || 15,
        }, dayKey);
        if (ok) { toast("Task updated"); draw(dayKey); }
      }));
      row.querySelector(".te-del").addEventListener("click", guard(async () => {
        await deleteDoc(doc(C.activities, id));
        toast("Task deleted");
        draw(dayKey);
      }));
    });

    // instances wiring
    $("inst-add") && $("inst-add").addEventListener("click", guard(async () => {
      const fromHHMM = $("inst-from").value, toHHMM = $("inst-to").value;
      const reason = $("inst-reason").value.trim();
      if (!fromHHMM || !toHHMM) { toast("Set both times.", true); return; }
      if (!reason) { toast("Add a reason.", true); return; }
      await addInstance(uid, u.name, { fromHHMM, toHHMM, reason, dayKey });
      toast("Instance saved");
      draw(dayKey);
    }));
    viewEl.querySelectorAll(".inst-row").forEach((row) => {
      const id = row.dataset.id;
      row.querySelector(".ie-save").addEventListener("click", guard(async () => {
        const fromHHMM = row.querySelector(".ie-from").value;
        const toHHMM = row.querySelector(".ie-to").value;
        const reason = row.querySelector(".ie-reason").value.trim();
        if (!fromHHMM || !toHHMM) { toast("Set both times.", true); return; }
        if (!reason) { toast("Add a reason.", true); return; }
        const ok = await updateInstance(id, { fromHHMM, toHHMM, reason, dayKey });
        if (ok) { toast("Instance updated"); draw(dayKey); }
      }));
      row.querySelector(".inst-del").addEventListener("click", guard(async () => {
        await deleteInstance(row.dataset.id);
        toast("Instance deleted");
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
  const canDelete = can("deleteUsers");
  const dark = currentTheme() === "dark";
  viewEl.innerHTML = `
    <div class="page-head"><div class="section-title">Settings</div></div>

    <div class="card card-pad settings-section">
      <div class="settings-section-title">Appearance</div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Night mode</div>
          <div class="settings-row-hint">Switches Vulcan to a dark theme on this browser. Everyone sets their own — it doesn't affect anyone else.</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="settings-theme-toggle" ${dark ? "checked" : ""} />
          <span class="switch-track"><span class="switch-thumb"></span></span>
        </label>
      </div>
      <div class="settings-row" style="margin-top:18px;padding-top:18px;border-top:1px solid var(--border)">
        <div>
          <div class="settings-row-label">Page title color</div>
          <div class="settings-row-hint">Color of the heading at the top of every page (e.g. "Dashboard", "Office Map"). Personal — only changes it for you.</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="color" id="settings-title-color" value="${currentTitleColor() || "#16181d"}" class="color-swatch" />
          <button class="btn btn-outline btn-sm" id="settings-title-reset">Reset</button>
        </div>
      </div>
    </div>

    <div class="card card-pad settings-section">
      <div class="settings-section-title">Sign-in code</div>
      <p class="greeting-sub" style="margin-bottom:14px">Set a numeric code so you can sign in on a device without using Google — your phone, for example. It's tied to this same account; nobody else can use it.</p>
      <div class="settings-row" style="align-items:flex-start">
        <div style="flex:1">
          <label class="field-label">Username you'll type</label>
          <div class="nm" style="margin:4px 0 12px">${esc(ME.email)}${Object.entries(USERNAME_MAP || {}).find(([, v]) => v === ME.email) ? ` (or "${Object.entries(USERNAME_MAP).find(([, v]) => v === ME.email)[0]}")` : ""}</div>
          <label class="field-label">Set a code (6+ digits)</label>
          <input id="pin-set-1" type="password" inputmode="numeric" pattern="[0-9]*" class="modal-input" placeholder="New code" style="margin:4px 0 8px;max-width:220px" />
          <input id="pin-set-2" type="password" inputmode="numeric" pattern="[0-9]*" class="modal-input" placeholder="Confirm code" style="max-width:220px" />
          <div class="mt-18"><button class="btn btn-primary btn-sm" id="pin-set-save">Save code</button></div>
        </div>
      </div>
    </div>

    <div class="card card-pad settings-section">
      <div class="settings-section-title">People &amp; roles</div>
      <p class="greeting-sub" style="margin-bottom:14px">Set each person's role.${canDelete ? " Only a super admin can delete a user — deleting removes their profile and all of their records." : ""}</p>
      <div class="table-wrap">
        <table><thead><tr><th>Person</th><th>Email</th><th>Role</th>${canDelete ? "<th></th>" : ""}</tr></thead><tbody>
        ${users.map((u) => {
          const current = isSuperAdminEmail(u.email) ? "super_admin" : (u.role || "agent");
          const locked = isSuperAdminEmail(u.email) || u.uid === ME.uid;
          return `<tr>
          <td><div class="cell-agent">
            <img class="avatar" src="${esc(u.profile_picture || fallbackAvatar(u.name))}" onerror="this.src='${fallbackAvatar(u.name)}'" alt="" />
            <span class="nm">${esc(u.name)}</span></div></td>
          <td>${esc(u.email)}</td>
          <td>${locked
            ? `<span class="badge out">${ROLE_LABELS[current] || current}${u.uid === ME.uid ? " · you" : ""}</span>`
            : `<select class="role-select" data-uid="${u.uid}">
                ${ROLE_OPTIONS.map((r) => `<option value="${r}" ${current === r ? "selected" : ""}>${ROLE_LABELS[r]}</option>`).join("")}
              </select>`}</td>
          ${canDelete ? `<td>${locked ? "" : `<button class="btn btn-danger btn-sm" data-del-uid="${u.uid}" data-name="${esc(u.name)}">Delete</button>`}</td>` : ""}
        </tr>`;
        }).join("")}
        </tbody></table>
      </div>
    </div>`;
  $("settings-theme-toggle") && $("settings-theme-toggle").addEventListener("change", toggleTheme);
  $("settings-title-color") && $("settings-title-color").addEventListener("input", (e) => setTitleColor(e.target.value));
  $("settings-title-reset") && $("settings-title-reset").addEventListener("click", () => {
    setTitleColor("");
    const inp = $("settings-title-color");
    if (inp) inp.value = "#16181d";
    toast("Title color reset");
  });
  $("pin-set-save") && $("pin-set-save").addEventListener("click", guard(async () => {
    const p1 = $("pin-set-1").value, p2 = $("pin-set-2").value;
    if (!/^\d{6,10}$/.test(p1)) { toast("Code must be 6–10 digits.", true); return; }
    if (p1 !== p2) { toast("Codes don't match.", true); return; }
    try {
      const cred = EmailAuthProvider.credential(auth.currentUser.email, p1);
      const hasPasswordAlready = auth.currentUser.providerData.some((p) => p.providerId === "password");
      if (hasPasswordAlready) await updatePassword(auth.currentUser, p1);
      else await linkWithCredential(auth.currentUser, cred);
      $("pin-set-1").value = ""; $("pin-set-2").value = "";
      toast("Sign-in code saved");
    } catch (e) {
      toast("Couldn't save code: " + e.message, true);
    }
  }));
  viewEl.querySelectorAll("select.role-select").forEach((sel) =>
    sel.addEventListener("change", guard(async () => {
      await updateDoc(doc(C.users, sel.dataset.uid), { role: sel.value });
      toast(`Role set to ${ROLE_LABELS[sel.value] || sel.value}`);
    })));
  viewEl.querySelectorAll("button[data-del-uid]").forEach((b) =>
    b.addEventListener("click", () => confirmDeleteUser(b.dataset.delUid, b.dataset.name)));
}

// Confirm + fully remove a user and their records.
function confirmDeleteUser(uid, name) {
  openModal(`
    <h3 class="modal-title">Delete ${esc(name)}?</h3>
    <p class="modal-hint">This permanently removes their profile and every record they have — time sessions, lunches, tasks, and assigned tasks. This can't be undone.</p>
    <div class="modal-actions">
      <button class="btn btn-outline btn-sm" id="m-cancel">Cancel</button>
      <button class="btn btn-danger btn-sm" id="m-confirm">Delete user</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-confirm").addEventListener("click", guard(async () => {
    const btn = document.getElementById("m-confirm");
    if (btn) { btn.textContent = "Deleting…"; btn.disabled = true; }
    await adminDeleteUser(uid);
    closeModal();
    toast(`${name} deleted`);
    viewSettings();
  }));
}

async function adminDeleteUser(uid) {
  const purge = async (col, field) => {
    const snap = await getDocs(query(col, where(field, "==", uid)));
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
  };
  await purge(C.sessions, "user_id");
  await purge(C.lunches, "user_id");
  await purge(C.activities, "user_id");
  await purge(C.tasks, "assigned_to");
  await purge(C.instances, "user_id").catch(() => {});
  await purge(C.it_requests, "created_by").catch(() => {});
  await purge(C.shopping, "created_by").catch(() => {});
  await deleteDoc(doc(C.users, uid));
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
    map: '<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>',
    bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    cart: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
    cog: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  }[name];
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}
