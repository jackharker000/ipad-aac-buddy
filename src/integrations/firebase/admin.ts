// Server-side Firebase Admin SDK — service account, full privileges (bypasses
// Firestore security rules). SECURITY: only ever import this from server code
// (server functions / server middleware / server routes). It reads the secret
// FIREBASE_SERVICE_ACCOUNT_B64 and must never reach the client bundle — always
// pull it in via a dynamic `await import(...)` from inside a `.server()` /
// `.handler()` body so the bundler keeps it server-only.
import { getApps, initializeApp, cert, type App, type ServiceAccount } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/**
 * Whether the server-side Firebase Admin credentials are present. Analog of the
 * old `serverSupabaseConfigured()` (service-role key check): true iff the
 * base64 service account is set. A cheap env check — does not touch the SDK.
 */
export function serverFirebaseConfigured(): boolean {
  return Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_B64);
}

function decodeServiceAccount(): ServiceAccount | null {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) return null;
  try {
    const json = Buffer.from(b64, "base64").toString("utf8");
    // The Google-issued service account JSON uses snake_case keys
    // (project_id / client_email / private_key). `cert()` accepts that shape
    // directly, so we pass the parsed object through and only cast for TS.
    return JSON.parse(json) as ServiceAccount;
  } catch (e) {
    console.error("[firebase-admin] failed to decode FIREBASE_SERVICE_ACCOUNT_B64", e);
    return null;
  }
}

// Lazy singleton — initializeApp runs at most once per server instance.
let _app: App | undefined;

function ensureApp(): App {
  if (_app) return _app;
  const existing = getApps();
  if (existing.length) {
    _app = existing[0];
    return _app;
  }
  const serviceAccount = decodeServiceAccount();
  if (!serviceAccount) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_B64 is not set (or invalid) — cannot initialize firebase-admin.",
    );
  }
  _app = initializeApp({ credential: cert(serviceAccount) });
  return _app;
}

/** Firebase Admin Auth (token verification, custom claims, user records). */
export function adminAuth(): Auth {
  return getAuth(ensureApp());
}

/** Firestore via the Admin SDK (bypasses security rules). */
export function adminDb(): Firestore {
  return getFirestore(ensureApp());
}
