import { useEffect, useState } from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
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
 * Reactive session. Subscribes to Firebase auth state and reads the admin
 * custom claim from the ID token. `loading` is true until the first auth
 * state resolves.
 */
export function useSession(): { user: SessionUser | null; loading: boolean } {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isFirebaseConfigured()) {
      setLoading(false);
      return;
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
    return () => unsub();
  }, []);

  return { user, loading };
}
