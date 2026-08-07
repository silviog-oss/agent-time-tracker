# Shift — Agent Activity & Time Tracking

A lightweight time-tracking app for customer-service teams. Agents clock in/out, take lunch, and log what they're working on; admins get a live floor view, per-agent timelines, and exportable reports.

**Stack:** static HTML/CSS/JS frontend (hosted on GitHub Pages) + Firebase Authentication (Google Sign-In) + Cloud Firestore (database + security rules). No build step, no server to run.

---

## Folder structure

```
agent-time-tracker/
├── index.html                # App shell: login screen + sidebar + views
├── assets/
│   ├── css/
│   │   └── styles.css         # Orange / white / black design system
│   └── js/
│       ├── config.js          # ← YOU EDIT THIS (Firebase project keys)
│       └── app.js             # Auth, state, data layer, all agent + admin views
├── firestore.rules            # Security rules (agent isolation, admin access)
├── firestore.indexes.json     # Firestore index config (empty — none required)
├── firebase.json              # Firebase CLI config
├── .firebaserc                # ← set your project id if using the CLI
├── .gitignore
└── README.md
```

---

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> → **Add project**. Name it e.g. `shift-timetracker`. Analytics optional.
2. In the project, open **Build → Firestore Database → Create database**.
   - Start in **production mode** (we ship real rules below).
   - Pick the region closest to your team.
3. Open **Build → Authentication → Get started → Sign-in method → Google → Enable**. Set a support email and save.

## 2. Register a Web app & get your config

1. Project **Settings** (gear icon) → **Your apps** → **Web** (`</>`).
2. Register the app (nickname `shift`, no Hosting needed).
3. Copy the `firebaseConfig` object it shows you.
4. Paste those values into **`assets/js/config.js`**, replacing every `REPLACE_ME`:

```js
export const firebaseConfig = {
  apiKey: "AIza…",
  authDomain: "shift-timetracker.firebaseapp.com",
  projectId: "shift-timetracker",
  storageBucket: "shift-timetracker.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef…"
};

// Optional: lock sign-in to one Workspace domain (e.g. "bizee.com"), or "" for any Google account.
export const ALLOWED_EMAIL_DOMAIN = "bizee.com";
```

## 3. Authorize your domains for Google Sign-In

Firebase **Authentication → Settings → Authorized domains → Add domain**. Add:

- `localhost` (already there — for local testing)
- your GitHub Pages host: `YOUR-USERNAME.github.io`

> Google Sign-In popups only work on authorized domains. If login silently fails after deploy, this is almost always the cause.

## 4. Deploy the security rules & schema

The database "schema" is created automatically the first time data is written — Firestore is schemaless. You only need to install the **rules**.

**Option A — Console (no tools):** open **Firestore → Rules**, paste the entire contents of `firestore.rules`, click **Publish**.

**Option B — Firebase CLI:**
```bash
npm install -g firebase-tools
firebase login
# put your project id in .firebaserc first, then:
firebase deploy --only firestore:rules
```

### Collections created at runtime
| Collection | Fields |
|---|---|
| `users` | `uid`, `google_id`, `name`, `email`, `profile_picture`, `role` (`agent`/`admin`), `created_at` |
| `sessions` | `user_id`, `user_name`, `user_email`, `clock_in`, `clock_out`, `total_work_time`, `date`, `created_at` |
| `lunches` | `user_id`, `session_id`, `start_time`, `end_time`, `duration`, `date` |
| `activities` | `user_id`, `user_name`, `description`, `start_time`, `end_time`, `duration`, `date`, `session_id` |
| `tasks` | `assigned_to`, `assigned_to_name`, `assigned_to_email`, `assigned_by`, `assigned_by_name`, `title`, `details`, `due_date`, `status` (`open`/`in_progress`/`done`), `agent_note`, `created_at`, `completed_at` |

All timestamps are stored as Firestore `Timestamp`s and durations are always recomputed **from the stored timestamps**, so timers survive refreshes and never drift. `date` is a local `YYYY-MM-DD` string used for day/range filtering.

> **Indexes:** every query uses only equality filters or a single-field range, so no composite indexes are required. If you later add a query that needs one, Firestore's error message includes a one-click link to create it.

## 5. Run locally

Because the app uses ES-module imports, open it through a local server (not `file://`):

```bash
cd agent-time-tracker
python3 -m http.server 8000
# visit http://localhost:8000
```

Sign in with Google. Your user doc is created automatically as an **agent**.

## 6. The first admin (automatic)

`silvio.g@incfile.com` is a **super admin** — it's granted admin automatically on login, both in the app and in the security rules. No console step needed: just sign in with that account and you'll land on the admin sidebar (Dashboard, Agents, Tasks, Activity, Time Reports, Settings).

Super admins are defined in **two places that must stay in sync**:
- `assets/js/config.js` → `SUPER_ADMIN_EMAILS` (controls the UI)
- `firestore.rules` → `isSuperAdmin()` list (controls data access)

To add another permanent admin, add their email to **both** lists and re-publish the rules. For everyday role changes, just use the in-app **Settings** page (promote/demote any agent) — no console or redeploy required.

## 7. Deploy to GitHub Pages

```bash
git init
git add .
git commit -m "Shift time tracker"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/agent-time-tracker.git
git push -u origin main
```

Then on GitHub: **repo → Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `root` → Save.**

Your app goes live at `https://YOUR-USERNAME.github.io/agent-time-tracker/` within a minute or two. **Remember to add that `github.io` host to Firebase Authorized domains (step 3).**

---

## Is it safe to commit `config.js`?

Yes. The Firebase web `apiKey` is **not a secret** — it only identifies your project to Google and is designed to ship in client code. Access is controlled by:

- **Firestore Security Rules** (`firestore.rules`) — agents can only read/write their own records; only admins can read everyone's data or change roles.
- **Google Sign-In** — no valid Google session, no access.
- Optionally, **`ALLOWED_EMAIL_DOMAIN`** to restrict to your Workspace.

There are **no private credentials, service-account keys, or secrets** anywhere in this repo. If you want an extra lock, add HTTP-referrer restrictions to the API key in Google Cloud Console → APIs & Services → Credentials.

---

## Feature checklist

- ✅ Google login (Firebase Auth)
- ✅ Clock in / clock out, with double-action guards
- ✅ Start / end lunch (work timer pauses during lunch)
- ✅ Start / end activity notes; previous activities are never deleted
- ✅ Clocking out auto-ends any open activity and lunch
- ✅ Timers derived from DB timestamps → survive refresh
- ✅ Agent dashboard, timeline, My Activity, My Time, Profile
- ✅ Admin live floor view (🟢 working / 🟠 lunch / ⚫ out), per-agent timeline
- ✅ **Tasks:** admin assigns work to one agent or all; agents Start / Mark done and file a report; admin sees status + report; agents can't reassign or edit others' tasks (enforced in rules)
- ✅ Reports with agent/date/range/status filters + summary tiles
- ✅ CSV export
- ✅ Firestore persistence + rules preventing cross-agent access
- ✅ Deployable from GitHub Pages

## Notes & limits (MVP)

- Timestamps use the **client clock** at the moment of each action (adequate for a shift tracker). For tamper-proof server time you'd move writes behind Cloud Functions.
- Reports aggregate in the browser; fine for dozens of agents. For hundreds, add pagination or a scheduled rollup.
- "Status" filter in Reports reflects each agent's **current** status (today).
