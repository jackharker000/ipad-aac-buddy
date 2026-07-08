// Client-side Firebase (browser + SSR render). Public config only — the
// values here are the Firebase "web app config", which are designed to be
// shipped in the client bundle. The server-only service account lives in
// `admin.ts` and is never imported here.
import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

/**
 * Read a public Firebase config value. Prefers the Vite build-time inlined
 * `import.meta.env.VITE_*` (client bundle) and falls back to `process.env` for
 * SSR, where the same VITE_-prefixed vars are present in the environment.
 */
function pick(viteValue: string | undefined, procKey: string): string | undefined {
  if (viteValue) return viteValue;
  if (typeof process !== "undefined" && process.env) return process.env[procKey];
  return undefined;
}

const firebaseConfig = {
  apiKey: pick(import.meta.env.VITE_FIREBASE_API_KEY, "VITE_FIREBASE_API_KEY"),
  authDomain: pick(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN, "VITE_FIREBASE_AUTH_DOMAIN"),
  projectId: pick(import.meta.env.VITE_FIREBASE_PROJECT_ID, "VITE_FIREBASE_PROJECT_ID"),
  storageBucket: pick(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET, "VITE_FIREBASE_STORAGE_BUCKET"),
  messagingSenderId: pick(
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    "VITE_FIREBASE_MESSAGING_SENDER_ID",
  ),
  appId: pick(import.meta.env.VITE_FIREBASE_APP_ID, "VITE_FIREBASE_APP_ID"),
  measurementId: pick(import.meta.env.VITE_FIREBASE_MEASUREMENT_ID, "VITE_FIREBASE_MEASUREMENT_ID"),
};

/**
 * Whether the public Firebase env vars are present. Lets callers (e.g.
 * AuthGate, cloud-sync) check WITHOUT triggering any auth/network work — so the
 * app can run local-first / anonymous when Firebase isn't configured instead of
 * blocking on a sign-in wall. Mirrors the old `isSupabaseConfigured()` role.
 *
 * `apiKey` + `projectId` are the minimum needed to talk to Auth + Firestore.
 */
export function isFirebaseConfigured(): boolean {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
}

// Guard against double-init (HMR, SSR re-eval, multiple imports).
export const firebaseApp: FirebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth: Auth = getAuth(firebaseApp);
export const db: Firestore = getFirestore(firebaseApp);
