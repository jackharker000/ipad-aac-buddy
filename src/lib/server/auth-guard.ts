import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { runWithRequestContext } from "./request-context";

/**
 * Auth guard for every server function that spends money (LLM/STT/TTS/embed)
 * or touches user data.
 *
 * - Supabase configured (multi-tenant deploy): a valid bearer token is
 *   REQUIRED; anonymous calls get a 401. This is what keeps strangers from
 *   burning the API keys on a public deployment.
 * - Supabase not configured (local-first dev): passes through with a null
 *   userId so the app still runs offline / in dev without env vars.
 */

function serverSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY);
}

function isProduction(): boolean {
  // Vercel sets VERCEL_ENV=production on prod deploys; NODE_ENV covers the rest.
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}

/**
 * Best-effort extraction of the server-function name from the RPC URL
 * (TanStack encodes it as `...--<exportName>_createServerFn_handler`).
 * Used only to label usage-log rows; falls back to "unknown".
 */
function parseFnName(): string | undefined {
  try {
    const url = getRequest()?.url;
    const m = url?.match(/--([A-Za-z0-9$_]+?)_createServerFn/);
    return m?.[1];
  } catch {
    return undefined;
  }
}

async function validateBearerToken(): Promise<{ userId: string } | null> {
  const request = getRequest();
  const authHeader = request?.headers?.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);
  if (!token) return null;

  const supabase = createClient<Database>(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    { auth: { storage: undefined, persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await supabase.auth.getClaims(token);
  if (error || !data?.claims?.sub) return null;
  return { userId: data.claims.sub };
}

export const requireUserOrLocal = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    if (!serverSupabaseConfigured()) {
      // FAIL CLOSED in production. Anonymous pass-through is a dev-only
      // convenience so the engine runs offline without env vars. In prod, a
      // missing server-side Supabase config must NOT silently expose the
      // money-spending endpoints — that would let anyone POST directly to
      // the LLM/TTS/STT routes and burn the API keys, regardless of what the
      // client-side login wall renders. (Security review HIGH-1.)
      if (isProduction()) {
        throw new Response(
          "Server auth is not configured. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.",
          { status: 500 },
        );
      }
      return runWithRequestContext({ userId: null, fnName: parseFnName() }, () =>
        next({ context: { userId: null as string | null } }),
      );
    }
    const auth = await validateBearerToken();
    if (!auth) {
      throw new Response("Unauthorized: sign in required", { status: 401 });
    }
    return runWithRequestContext({ userId: auth.userId, fnName: parseFnName() }, () =>
      next({ context: { userId: auth.userId as string | null } }),
    );
  },
);

/**
 * Admin gate: valid user AND (profiles.role = 'admin' OR email allow-listed
 * via PARLEY_ADMIN_EMAILS). The env allow-list bootstraps the first admin
 * before any role exists in the database.
 */
export const requireAdmin = createMiddleware({ type: "function" }).server(async ({ next }) => {
  if (!serverSupabaseConfigured()) {
    throw new Response("Admin requires Supabase to be configured", { status: 501 });
  }
  const auth = await validateBearerToken();
  if (!auth) {
    throw new Response("Unauthorized: sign in required", { status: 401 });
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: profile } = await (supabaseAdmin.from("profiles") as any)
    .select("role, email")
    .eq("id", auth.userId)
    .maybeSingle();

  // The durable source of truth is the DB role. The env allow-list is a
  // bootstrap for the FIRST admin only, and it must not trust a
  // self-asserted email: an attacker could register an allow-listed address
  // and, if email confirmation is disabled, instantly become admin. So the
  // allow-list path additionally requires a confirmed email. (Review M3.)
  let isAdmin = profile?.role === "admin";
  if (!isAdmin) {
    const allowList = (process.env.PARLEY_ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const email = (profile?.email ?? "").toLowerCase();
    if (email && allowList.includes(email)) {
      const { data: userRes } = await supabaseAdmin.auth.admin.getUserById(auth.userId);
      isAdmin = Boolean(userRes?.user?.email_confirmed_at);
    }
  }
  if (!isAdmin) {
    throw new Response("Forbidden: admin only", { status: 403 });
  }
  return runWithRequestContext({ userId: auth.userId }, () =>
    next({ context: { userId: auth.userId as string | null, isAdmin: true } }),
  );
});

export { serverSupabaseConfigured };
