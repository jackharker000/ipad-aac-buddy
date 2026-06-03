import { useEffect, useState } from "react";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";

import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

export const Route = createFileRoute("/auth/callback")({
  component: AuthCallbackPage,
});

function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;

    async function run() {
      const params = new URLSearchParams(window.location.search);
      const code = params.get("code");
      const next = params.get("next") ?? "/app";

      if (code) {
        try {
          const supabase = getSupabaseBrowserClient();
          const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
          if (cancelled) return;
          if (exchangeError) {
            setError(exchangeError.message);
            return;
          }
        } catch (err) {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : "Something went wrong");
          return;
        }
      }

      if (cancelled) return;
      await router.invalidate();
      router.navigate({ to: next, replace: true });
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--sand)] text-[var(--ink)]">
        <div className="w-full max-w-md rounded-2xl border border-[var(--line)] bg-white p-8 shadow-sm text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Couldn&apos;t sign you in</h1>
          <p className="mt-2 text-sm text-[var(--coral)]">{error}</p>
          <p className="mt-6 text-sm text-[var(--ink-soft)]">
            <Link to="/login" className="font-medium text-[var(--teal)] hover:underline">
              Back to log in
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--sand)] text-[var(--ink)]">
      <div className="text-center">
        <p className="text-lg font-medium">Signing you in…</p>
        <p className="mt-2 text-sm text-[var(--ink-soft)]">One moment please.</p>
      </div>
    </div>
  );
}
