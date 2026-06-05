import { type FirebaseApp, getApps, initializeApp } from "firebase/app";
import { type Auth, getAuth } from "firebase/auth";
import { type Firestore, getFirestore } from "firebase/firestore";

/**
 * Client-side Firebase. The config is PUBLIC by design (it ships in the
 * browser bundle and only identifies the project) — security is enforced by
 * Firebase Auth + Firestore Security Rules, not by hiding these values.
 *
 * Browser-only: do not call these during SSR. Guarded so an accidental
 * server import doesn't crash the build.
 */

/**
 * Resolve the Firebase Auth domain.
 *
 * `signInWithPopup` (Google sign-in) loads `https://<authDomain>/__/auth/
 * handler`. That path is ONLY served by Firebase-hosted domains
 * (`*.firebaseapp.com` / `*.web.app`). This app is hosted on Vercel, so a
 * custom authDomain like `parley.help` 404s the handler and breaks Google
 * sign-in entirely (it also surfaces earlier as `redirect_uri_mismatch`).
 *
 * So: trust the configured value only when it's a Firebase-hosted domain;
 * otherwise coerce it back to the canonical `<projectId>.firebaseapp.com`.
 * This makes Google sign-in resilient to a misconfigured
 * VITE_FIREBASE_AUTH_DOMAIN (the common foot-gun is setting it to the site's
 * custom domain). To intentionally use a custom auth domain, serve
 * `/__/auth/handler` from it via Firebase Hosting and point the env var at a
 * `*.firebaseapp.com` / `*.web.app` host.
 */
function resolveAuthDomain(): string {
  const configured = (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined)?.trim();
  const projectId = (import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined)?.trim();
  if (configured && /\.(firebaseapp\.com|web\.app)$/i.test(configured)) {
    return configured;
  }
  if (projectId) {
    if (configured && configured !== `${projectId}.firebaseapp.com`) {
      console.warn(
        `[firebase] VITE_FIREBASE_AUTH_DOMAIN="${configured}" can't serve the auth handler on this host; ` +
          `using "${projectId}.firebaseapp.com" so Google sign-in works.`,
      );
    }
    return `${projectId}.firebaseapp.com`;
  }
  return configured ?? "";
}

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string,
  authDomain: resolveAuthDomain(),
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID as string | undefined,
};

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let dbInstance: Firestore | null = null;

export function isFirebaseConfigured(): boolean {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
}

export function getFirebaseApp(): FirebaseApp {
  if (typeof window === "undefined") {
    throw new Error("Firebase client is browser-only.");
  }
  if (!isFirebaseConfigured()) {
    throw new Error(
      "Missing VITE_FIREBASE_* config. Add the Firebase web config to .env.",
    );
  }
  if (!app) {
    app = getApps()[0] ?? initializeApp(firebaseConfig);
  }
  return app;
}

export function getFirebaseAuth(): Auth {
  if (!authInstance) authInstance = getAuth(getFirebaseApp());
  return authInstance;
}

export function getFirebaseDb(): Firestore {
  if (!dbInstance) dbInstance = getFirestore(getFirebaseApp());
  return dbInstance;
}
