import { useEffect, useState } from "react";
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  getRedirectResult,
  onAuthStateChanged,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithRedirect,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";

import { getFirebaseAuth, isFirebaseConfigured } from "@/lib/firebase/client";

/**
 * Client-side authentication via Firebase Auth (email/password).
 *
 * `is_admin` comes from a Firebase custom claim (`admin: true`). The first
 * account created in the project is promoted to admin by the server route
 * `/api/auth/ensure-role` (it uses the Admin SDK; the client can't set its
 * own claims). After promotion the client refreshes its ID token so the
 * claim is visible without a re-login.
 */

export type SessionUser = {
  id: string;
  email: string | null;
  is_admin: boolean;
};

export class AuthError extends Error {}

function friendlyError(code: unknown): string {
  switch (code) {
    case "auth/email-already-in-use":
      return "An account with that email already exists.";
    case "auth/invalid-email":
      return "Enter a valid email address.";
    case "auth/weak-password":
      return "Password must be at least 6 characters.";
    case "auth/user-not-found":
    case "auth/invalid-credential":
    case "auth/wrong-password":
      return "Email or password is incorrect.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a moment and try again.";
    case "auth/network-request-failed":
      return "Network problem — check your connection and try again.";
    case "auth/unauthorized-domain":
      return "This domain isn't on the Firebase Auth allow-list. Add it under Firebase Console → Authentication → Settings → Authorized domains.";
    case "auth/operation-not-supported-in-this-environment":
      return "Google sign-in isn't available in this environment. Try the email + password form instead.";
    case "auth/internal-error":
      return "Firebase returned an internal error. Try again, or use email + password.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/** Ask the server to promote the first-ever account to admin, then refresh the token. */
async function ensureRole(user: User): Promise<boolean> {
  try {
    const idToken = await user.getIdToken();
    const res = await fetch("/api/auth/ensure-role", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    if (res.ok) {
      const data = (await res.json()) as { is_admin?: boolean };
      if (data.is_admin) {
        // Force a token refresh so the new custom claim is visible.
        await user.getIdToken(true);
        return true;
      }
    }
  } catch {
    // Admin SDK not configured, or transient failure — default to non-admin.
  }
  return false;
}

async function resolve(user: User, runEnsure: boolean): Promise<SessionUser> {
  if (runEnsure) await ensureRole(user);
  const token = await user.getIdTokenResult();
  return {
    id: user.uid,
    email: user.email,
    is_admin: token.claims.admin === true,
  };
}

export async function signUp(email: string, password: string): Promise<SessionUser> {
  if (!isFirebaseConfigured()) {
    throw new AuthError("Sign-in isn't configured yet (missing Firebase config).");
  }
  try {
    const cred = await createUserWithEmailAndPassword(
      getFirebaseAuth(),
      email.trim(),
      password,
    );
    return await resolve(cred.user, true);
  } catch (err) {
    throw new AuthError(friendlyError((err as { code?: string })?.code));
  }
}

export async function signIn(email: string, password: string): Promise<SessionUser> {
  if (!isFirebaseConfigured()) {
    throw new AuthError("Sign-in isn't configured yet (missing Firebase config).");
  }
  try {
    const cred = await signInWithEmailAndPassword(getFirebaseAuth(), email.trim(), password);
    // Run ensureRole on sign-in too, so the very first user is promoted even
    // if the post-signup call didn't land.
    return await resolve(cred.user, true);
  } catch (err) {
    throw new AuthError(friendlyError((err as { code?: string })?.code));
  }
}

/**
 * Where to navigate after the Google redirect returns. Stashed before we
 * leave, read by the login route's post-redirect effect. Picks up on the
 * same device because sessionStorage survives the Firebase OAuth bounce
 * (same origin, same tab) — but NOT cross-device, which is fine: a
 * redirect by definition resumes on the device it started on.
 */
const POST_REDIRECT_KEY = "parley.auth.postRedirect";

export function readPostSignInRedirect(): string | null {
  try {
    if (typeof window === "undefined") return null;
    const target = window.sessionStorage.getItem(POST_REDIRECT_KEY);
    window.sessionStorage.removeItem(POST_REDIRECT_KEY);
    return target ?? null;
  } catch {
    return null;
  }
}

/**
 * Kick off a full-page redirect to Google's OAuth flow. Resolves once the
 * browser has accepted the navigation — the page leaves before any
 * meaningful work, so the caller should NOT try to navigate or await a
 * SessionUser after this. The returning page (any route mounting
 * `useSession`) harvests the result via `getRedirectResult` and
 * `onAuthStateChanged` fires with the signed-in user.
 *
 * Was `signInWithPopup` historically; switched because Apple's standalone
 * PWA webview reliably breaks popup-based sign-in (popups open a new tab
 * outside the PWA frame, or are blocked outright, depending on iOS
 * version). Redirect works in every surface.
 */
export async function signInWithGoogle(redirect?: string): Promise<void> {
  if (!isFirebaseConfigured()) {
    throw new AuthError("Sign-in isn't configured yet (missing Firebase config).");
  }
  try {
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(POST_REDIRECT_KEY, redirect ?? "/app");
      } catch {
        // sessionStorage unavailable (private mode etc.) — the login
        // route's fallback to `/app` still works.
      }
    }
    const provider = new GoogleAuthProvider();
    await signInWithRedirect(getFirebaseAuth(), provider);
    // Control transferred to the OAuth flow. We don't return.
  } catch (err) {
    const code = (err as { code?: string })?.code;
    // Log the raw code so future unrecognised failures are diagnosable
    // from devtools without digging through the Firebase source.
    console.warn("[auth] signInWithGoogle failed:", code, err);
    if (code === "auth/account-exists-with-different-credential") {
      throw new AuthError(
        "An account with this email already exists with a different sign-in method. Try email + password instead.",
      );
    }
    throw new AuthError(friendlyError(code));
  }
}

export async function signOut(): Promise<void> {
  if (!isFirebaseConfigured()) return;
  await fbSignOut(getFirebaseAuth());
}

/** Current user's Firebase ID token (for authenticating calls to /api/admin/*). */
export async function getIdToken(): Promise<string | null> {
  if (!isFirebaseConfigured()) return null;
  const user = getFirebaseAuth().currentUser;
  if (!user) return null;
  return user.getIdToken();
}

/**
 * Exchange a long-lived iPad device key for a fresh Firebase session.
 *
 * The home-screen icon's `start_url` (baked at Add-to-Home-Screen time
 * via `/api/manifest?key=…`) launches `/app?device_key=…`. When the
 * cockpit boots without an existing session it pulls the key off the
 * URL, POSTs it here, and the server hands back a Firebase custom
 * token. `signInWithCustomToken` then mints a real session, after
 * which `onAuthStateChanged` fires and the gate flips to the cockpit.
 *
 * Returns true on success, false on any failure — caller falls through
 * to the normal sign-out path (gateway redirects to /login).
 */
export async function signInWithDeviceKey(deviceKey: string): Promise<boolean> {
  if (!isFirebaseConfigured() || !deviceKey) return false;
  try {
    const res = await fetch("/api/autologin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_key: deviceKey }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { token?: string };
    if (!data.token) return false;
    await signInWithCustomToken(getFirebaseAuth(), data.token);
    return true;
  } catch (err) {
    console.warn("[auth] signInWithDeviceKey failed:", err);
    return false;
  }
}

/**
 * Reactive session. Subscribes to Firebase auth state and reads the admin
 * custom claim from the ID token. `loading` is true until the first auth
 * state resolves.
 *
 * Plus a four-piece stay-logged-in pass for the iPad PWA:
 *
 *   1. **One-time `navigator.storage.persist()` request.** Asks the
 *      browser to mark the origin's storage as persistent — Safari's
 *      heuristic gates this so we won't always be granted it, but the
 *      ask is free and on supporting runtimes it puts the IDB store
 *      out of reach of automatic eviction.
 *   2. **Resume-refresh** on `visibilitychange` (visible) + `pageshow`.
 *      A PWA can sit suspended for hours; touching the token on resume
 *      catches any expiry before the next `/api/admin/*` call surprises
 *      us with a 401 race.
 *   3. **Periodic refresh** every 50 min while the tab is alive. Firebase
 *      ID tokens last 60 min; pre-emptive refresh keeps one in hand at
 *      all times and avoids "token expired mid-flight" edge cases when
 *      the user only briefly looks at the app.
 *   4. **`online`-event refresh.** When the network comes back after an
 *      outage, retry the refresh immediately rather than waiting for
 *      the next visibility flip.
 *
 * The IDB persistence layer in `lib/firebase/client.ts` makes all of
 * these refreshes succeed silently — no network round-trip for the user.
 */
const TOKEN_REFRESH_INTERVAL_MS = 50 * 60 * 1000;

/**
 * Pull the `device_key` search param off the current URL and remove it
 * via history.replaceState so refreshes don't re-fire the autologin call.
 * Returns the trimmed key string (or null when absent / oversized).
 */
function consumeDeviceKeyFromUrl(): string | null {
  try {
    const url = new URL(window.location.href);
    const raw = url.searchParams.get("device_key");
    if (!raw) return null;
    url.searchParams.delete("device_key");
    window.history.replaceState(
      window.history.state,
      "",
      url.pathname + url.search + url.hash,
    );
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > 256) return null;
    return trimmed;
  } catch {
    return null;
  }
}

let storagePersistAsked = false;
function maybeAskStoragePersist(): void {
  if (storagePersistAsked) return;
  storagePersistAsked = true;
  if (typeof navigator === "undefined") return;
  const storage = navigator.storage;
  if (!storage || typeof storage.persist !== "function") return;
  void storage
    .persist()
    .then((granted) => {
      // The boolean is informational only — most Safaris will deny but
      // the IDB store stays usable either way. Log so devtools can show
      // the outcome without surfacing UI to the user.
      console.debug("[auth] navigator.storage.persist() →", granted);
    })
    .catch(() => {
      // Some runtimes throw rather than resolve false. Silent — it's a
      // best-effort hint, not a guarantee we ever needed.
    });
}

export function useSession(): { user: SessionUser | null; loading: boolean } {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isFirebaseConfigured()) {
      setLoading(false);
      return;
    }

    maybeAskStoragePersist();

    // Harvest a pending `signInWithRedirect` result if we just got
    // bounced back from Google. The SDK applies it to the current user
    // internally, so we don't need the return value — `onAuthStateChanged`
    // below will fire with the signed-in user either way. Failures are
    // logged because they're useful for diagnosing
    // unauthorized-domain / redirect-uri config drift; they don't block
    // anything because the existing auth state still controls the gate.
    void getRedirectResult(getFirebaseAuth()).catch((err) => {
      const code = (err as { code?: string })?.code;
      if (code) console.warn("[auth] getRedirectResult:", code, err);
    });

    // iPad autologin: when the home-screen icon launches the cockpit
    // with `?device_key=…`, exchange it for a Firebase custom-token
    // session BEFORE we decide there's no user. We only attempt this if
    // there's no current user yet — a signed-in icon-launcher (the
    // happy 7-day-window path) skips the exchange. Strip the param from
    // the URL after consumption so refreshes don't re-fire the call.
    const deviceKey = consumeDeviceKeyFromUrl();
    if (deviceKey && !getFirebaseAuth().currentUser) {
      void signInWithDeviceKey(deviceKey);
      // `onAuthStateChanged` fires either way — on success with the
      // resolved user, on failure with null (gateway falls through to
      // /login). No need to await here.
    }

    const unsub = onAuthStateChanged(getFirebaseAuth(), async (u) => {
      if (!u) {
        setUser(null);
        setLoading(false);
        return;
      }
      try {
        const token = await u.getIdTokenResult();
        setUser({ id: u.uid, email: u.email, is_admin: token.claims.admin === true });
      } catch {
        setUser({ id: u.uid, email: u.email, is_admin: false });
      }
      setLoading(false);
    });

    const refresh = () => {
      const current = getFirebaseAuth().currentUser;
      if (!current) return;
      void current.getIdToken(true).catch(() => {
        // Refresh failure is non-fatal — onAuthStateChanged fires with
        // null if the user is genuinely signed out and the existing
        // redirect handles it. A network blip just leaves the old
        // (still-valid) token in place.
      });
    };

    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };

    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("pageshow", refreshIfVisible);
    window.addEventListener("online", refresh);
    const interval = window.setInterval(refresh, TOKEN_REFRESH_INTERVAL_MS);

    return () => {
      unsub();
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("pageshow", refreshIfVisible);
      window.removeEventListener("online", refresh);
      window.clearInterval(interval);
    };
  }, []);

  return { user, loading };
}
