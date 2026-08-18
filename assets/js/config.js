// ============================================================
//  Firebase configuration
// ------------------------------------------------------------
export const firebaseConfig = {
  apiKey: "AIzaSyD9CQ5lYDHlOt3DDPCn_fulHwYZ_t0KUrU",
  authDomain: "shift-ea902.firebaseapp.com",
  projectId: "shift-ea902",
  storageBucket: "shift-ea902.firebasestorage.app",
  messagingSenderId: "80374788766",
  appId: "1:80374788766:web:d1d1c01f8b9029e861018f"
};

// Optional: restrict sign-in to a single Google Workspace domain.
// Leave as "" to allow any Google account. Example: "incfile.com"
export const ALLOWED_EMAIL_DOMAIN = "";

// These emails are ALWAYS admins — granted automatically on login.
// Keep in sync with isSuperAdmin() in firestore.rules.
export const SUPER_ADMIN_EMAILS = ["silvio.g@incfile.com"];

// Shorthand usernames for the code-based sign-in on mobile/kiosk devices.
// A code sign-in still requires a real linked password on that account
// (set once from Settings while signed in normally) — this map just saves
// typing the full email. Add more entries as people set up their own codes.
export const USERNAME_MAP = {
  "silvio": "silvio.g@incfile.com",
};
