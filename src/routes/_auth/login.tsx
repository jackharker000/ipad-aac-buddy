import { useEffect, useState } from "react";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthError, readPostSignInRedirect, signIn, useSession } from "@/lib/auth";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";

const LoginSearch = z.object({
  redirect: z.string().optional(),
});

export const Route = createFileRoute("/_auth/login")({
  validateSearch: LoginSearch,
  component: LoginPage,
  head: () => ({
    meta: [
      { title: "Log in — Parley" },
      {
        name: "description",
        content: "Sign in to pick up where the last conversation left off.",
      },
    ],
  }),
});

function LoginPage() {
  const router = useRouter();
  const search = Route.useSearch();
  const { user } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Post-redirect landing pad. When Google sends the user back here
  // after `signInWithRedirect`, `useSession` picks up the new user via
  // `getRedirectResult` + `onAuthStateChanged`, and this effect fires
  // the navigation onward. Priority of destinations:
  //   1) the sessionStorage stash we set just before the redirect (so
  //      the original `?redirect=` param survives the bounce)
  //   2) the current `?redirect=` search param (covers a fresh
  //      sign-in that wasn't started here)
  //   3) /app
  useEffect(() => {
    if (!user) return;
    const stashed = readPostSignInRedirect();
    const target = stashed ?? search.redirect ?? "/app";
    router.navigate({ to: target });
  }, [user, router, search.redirect]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await signIn(email, password);
      const target = search.redirect ?? "/app";
      router.navigate({ to: target });
    } catch (err) {
      if (err instanceof AuthError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-8 shadow-sm">
      <h1 className="text-2xl font-semibold tracking-tight">Welcome back to Parley.</h1>
      <p className="mt-2 text-sm text-[var(--ink-soft)]">
        Sign in to pick up where the last conversation left off.
      </p>

      <div className="mt-6 space-y-4">
        <GoogleSignInButton redirect={search.redirect} />
        <Divider />
      </div>

      <form className="mt-4 space-y-4" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loading}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
          />
        </div>

        {error ? <p className="text-sm text-[var(--coral)] mt-2">{error}</p> : null}

        <Button
          type="submit"
          disabled={loading}
          className="h-11 w-full rounded-full bg-[var(--teal)] text-white hover:bg-[var(--teal-dark)]"
        >
          {loading ? "Logging in…" : "Log in"}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-[var(--ink-soft)]">
        Don&apos;t have an account?{" "}
        <Link to="/signup" className="font-medium text-[var(--teal)] hover:underline">
          Create one.
        </Link>
      </p>
    </div>
  );
}

function Divider() {
  return (
    <div className="flex items-center gap-3">
      <div className="h-px flex-1 bg-[var(--line)]" />
      <span className="text-xs uppercase tracking-wider text-[var(--ink-soft)]">or</span>
      <div className="h-px flex-1 bg-[var(--line)]" />
    </div>
  );
}
