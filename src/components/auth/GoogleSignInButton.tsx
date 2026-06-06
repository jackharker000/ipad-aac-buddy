import { useState } from "react";

import { AuthError, signInWithGoogle } from "@/lib/auth";

type Props = {
  redirect?: string;
  /** Optional label override (defaults to "Continue with Google"). */
  label?: string;
};

/**
 * Google sign-in button. Uses Firebase `signInWithRedirect` under the
 * hood — the page leaves for Google's OAuth flow and returns to the
 * login route, at which point a useEffect watches `useSession()` and
 * navigates onward. We never resolve a `SessionUser` here, so loading
 * state stays on until the navigation completes; only an error initiating
 * the redirect resets it.
 */
export function GoogleSignInButton({ redirect, label = "Continue with Google" }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setError(null);
    setLoading(true);
    try {
      await signInWithGoogle(redirect);
      // signInWithRedirect navigates away — anything past this is the
      // browser still pre-navigation. Leave loading=true so the button
      // visually stays in its "Signing in…" state until the page leaves.
    } catch (err) {
      setError(err instanceof AuthError ? err.message : "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full border border-[var(--line)] bg-white px-4 text-sm font-semibold text-[var(--ink)] shadow-sm transition hover:bg-[var(--sand-2)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <GoogleGlyph />
        {loading ? "Signing in…" : label}
      </button>
      {error ? <p className="text-sm text-[var(--coral)]">{error}</p> : null}
    </div>
  );
}

function GoogleGlyph() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3 0 5.8 1.1 7.9 3l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.7 8.4 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.3 0 10.1-2 13.7-5.3l-6.3-5.2C29.3 35 26.8 36 24 36c-5.2 0-9.6-3.3-11.2-7.9l-6.5 5C9.6 39.5 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6.3 5.2C41.4 35 44 30 44 24c0-1.2-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}
