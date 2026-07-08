import { useEffect, useRef, useState } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithPopup,
  signOut,
  GoogleAuthProvider,
  type User,
} from "firebase/auth";
import { auth, isFirebaseConfigured } from "@/integrations/firebase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2, ShieldCheck, ArrowLeft } from "lucide-react";
import { ParleyLogo } from "@/components/ParleyLogo";
import { pullForUser, clearLocal } from "@/lib/cloud-sync";

/**
 * Wraps the whole app. Parley is a login-gated, multi-tenant product: when
 * Firebase is configured every visitor must sign in, and each account's data
 * is fully isolated (Firestore security rules server-side, per-user Dexie
 * snapshot client-side).
 *
 * Local-first escape hatch: in DEV builds with no Firebase env vars the app
 * runs anonymous so the engine can be hacked on offline. A PRODUCTION build
 * without Firebase shows a configuration notice instead of silently running
 * an unauthenticated multi-user deploy.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const firebaseReady = isFirebaseConfigured();

  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(firebaseReady);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!firebaseReady) return;
    // onAuthStateChanged fires once Firebase has restored the persisted session
    // and on every subsequent sign-in/sign-out.
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setChecking(false);
    });
    return () => unsub();
  }, [firebaseReady]);

  // Pull cloud backup whenever the user changes. On a shared AAC iPad this is
  // also the point where we must isolate tenants: sign-out / session expiry
  // must wipe the previous user's local data so the next person can't see it,
  // and a user switch must not carry one account's data into another's cloud
  // backup (pullForUser wipes on switch too). Security review HIGH-2.
  const prevUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    const uid = user?.uid ?? null;
    if (!uid) {
      if (prevUserIdRef.current) {
        prevUserIdRef.current = null;
        void clearLocal().catch((e) => console.error("clearLocal failed", e));
      }
      setHydrated(false);
      return;
    }
    prevUserIdRef.current = uid;
    let cancelled = false;
    setHydrated(false);
    pullForUser(uid)
      .catch((e) => console.error("Cloud pull failed", e))
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  if (!firebaseReady) {
    // Dev without Firebase → run local-first so the engine works offline.
    if (import.meta.env.DEV) return <>{children}</>;
    return <NotConfiguredScreen />;
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) return <AuthScreen />;

  if (!hydrated) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background text-muted-foreground">
        <ParleyLogo className="size-12" />
        <Loader2 className="size-5 animate-spin" />
        <p className="text-sm">Loading your Parley…</p>
      </div>
    );
  }

  return <>{children}</>;
}

function NotConfiguredScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="max-w-md text-center">
        <ParleyLogo className="mx-auto size-12" />
        <h1 className="mt-6 text-xl font-semibold tracking-tight">
          This Parley deployment isn't set up yet
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Accounts are required so each person's conversations stay private, and this server has no
          authentication configured. Set the <code>VITE_FIREBASE_*</code> client config and the
          server-side <code>FIREBASE_SERVICE_ACCOUNT_B64</code> environment variables, then
          redeploy.
        </p>
      </div>
    </main>
  );
}

type AuthMode = "signin" | "signup" | "reset";

function GoogleButton({ busy, onBusy }: { busy: boolean; onBusy: (b: boolean) => void }) {
  async function handleGoogle() {
    onBusy(true);
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Google sign-in failed";
      // A user closing the popup isn't an error worth shouting about.
      if (!/popup-closed-by-user|cancelled-popup-request/.test(msg)) toast.error(msg);
    } finally {
      onBusy(false);
    }
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="lg"
      className="h-11 w-full"
      disabled={busy}
      onClick={handleGoogle}
    >
      Continue with Google
    </Button>
  );
}

function OrDivider() {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      or
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function AuthScreen() {
  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    setBusy(true);
    try {
      await createUserWithEmailAndPassword(auth, email, password);
      toast.success("Welcome to Parley — your account is ready");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create account");
    } finally {
      setBusy(false);
    }
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await sendPasswordResetEmail(auth, email);
      toast.success("Check your email for a reset link");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send reset link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <ParleyLogo className="size-14" />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">Parley</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Your conversation copilot — listening, suggesting, speaking in your voice.
          </p>
        </div>

        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          {mode === "signin" && (
            <form onSubmit={handleSignIn} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="auth-email">Email</Label>
                <Input
                  id="auth-email"
                  type="email"
                  autoComplete="email"
                  className="h-11"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="auth-pw">Password</Label>
                  <button
                    type="button"
                    onClick={() => setMode("reset")}
                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>
                <Input
                  id="auth-pw"
                  type="password"
                  autoComplete="current-password"
                  className="h-11"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" size="lg" className="h-11 w-full" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </Button>
              <OrDivider />
              <GoogleButton busy={busy} onBusy={setBusy} />
              <p className="text-center text-sm text-muted-foreground">
                New to Parley?{" "}
                <button
                  type="button"
                  onClick={() => setMode("signup")}
                  className="font-medium text-foreground underline-offset-2 hover:underline"
                >
                  Create an account
                </button>
              </p>
            </form>
          )}

          {mode === "signup" && (
            <form onSubmit={handleSignUp} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="su-email">Email</Label>
                <Input
                  id="su-email"
                  type="email"
                  autoComplete="email"
                  className="h-11"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="su-pw">Password</Label>
                <Input
                  id="su-pw"
                  type="password"
                  autoComplete="new-password"
                  className="h-11"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                />
                <p className="text-xs text-muted-foreground">At least 8 characters.</p>
              </div>
              <Button type="submit" size="lg" className="h-11 w-full" disabled={busy}>
                {busy ? "Creating…" : "Create account"}
              </Button>
              <OrDivider />
              <GoogleButton busy={busy} onBusy={setBusy} />
              <p className="text-center text-sm text-muted-foreground">
                Already have an account?{" "}
                <button
                  type="button"
                  onClick={() => setMode("signin")}
                  className="font-medium text-foreground underline-offset-2 hover:underline"
                >
                  Sign in
                </button>
              </p>
            </form>
          )}

          {mode === "reset" && (
            <form onSubmit={handleReset} className="space-y-4">
              <button
                type="button"
                onClick={() => setMode("signin")}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="size-3.5" /> Back to sign in
              </button>
              <div className="space-y-1.5">
                <Label htmlFor="rp-email">Email</Label>
                <Input
                  id="rp-email"
                  type="email"
                  autoComplete="email"
                  className="h-11"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" size="lg" className="h-11 w-full" disabled={busy}>
                {busy ? "Sending…" : "Send reset link"}
              </Button>
            </form>
          )}
        </div>

        <p className="mt-6 flex items-start justify-center gap-2 text-center text-xs leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Every account is private. Conversations, people and voice data are isolated per user and
            synced only to your own account.
          </span>
        </p>
      </div>
    </main>
  );
}

/** Sign out helper exposed for the Settings page. */
export async function signOutAndClear() {
  const { flushPush } = await import("@/lib/cloud-sync");
  try {
    await flushPush();
  } catch {
    // best-effort final flush; sign out regardless
  }
  await signOut(auth);
  await clearLocal();
}
