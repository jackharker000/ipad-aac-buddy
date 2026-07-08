import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { DecodedIdToken } from "firebase-admin/auth";
import { runWithRequestContext } from "./request-context";

/**
 * Auth guard for every server function that spends money (LLM/STT/TTS/embed)
 * or touches user data.
 *
 * - Firebase configured (multi-tenant deploy): a valid Firebase ID token is
 *   REQUIRED; anonymous calls get a 401. This is what keeps strangers from
 *   burning the API keys on a public deployment.
 * - Firebase not configured (local-first dev): passes through with a null
 *   userId so the app still runs offline / in dev without env vars.
 *
 * firebase-admin is Node-only and must never reach the client bundle, so it is
 * imported lazily via `await import(...)` from inside the server-only handlers
 * below (never at module top-level).
 */

function serverFirebaseConfigured(): boolean {
  return Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_B64);
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

function getBearerToken(): string | null {
  const request = getRequest();
  const authHeader = request?.headers?.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);
  return token || null;
}

/** Verify the request's Firebase ID token. Returns the decoded token or null. */
async function verifyToken(): Promise<DecodedIdToken | null> {
  const token = getBearerToken();
  if (!token) return null;
  try {
    const { adminAuth } = await import("@/integrations/firebase/admin");
    return await adminAuth().verifyIdToken(token);
  } catch {
    return null;
  }
}

export const requireUserOrLocal = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    if (!serverFirebaseConfigured()) {
      // FAIL CLOSED in production. Anonymous pass-through is a dev-only
      // convenience so the engine runs offline without env vars. In prod, a
      // missing server-side Firebase config must NOT silently expose the
      // money-spending endpoints — that would let anyone POST directly to
      // the LLM/TTS/STT routes and burn the API keys, regardless of what the
      // client-side login wall renders. (Security review HIGH-1.)
      if (isProduction()) {
        throw new Response("Server auth is not configured. Set FIREBASE_SERVICE_ACCOUNT_B64.", {
          status: 500,
        });
      }
      return runWithRequestContext({ userId: null, fnName: parseFnName() }, () =>
        next({ context: { userId: null as string | null } }),
      );
    }
    const decoded = await verifyToken();
    if (!decoded) {
      throw new Response("Unauthorized: sign in required", { status: 401 });
    }
    return runWithRequestContext({ userId: decoded.uid, fnName: parseFnName() }, () =>
      next({ context: { userId: decoded.uid as string | null } }),
    );
  },
);

/**
 * Is this verified token an admin? True when ANY of:
 *   1. the `admin` custom claim is true (set by adminSetRole), OR
 *   2. the durable profiles/{uid}.role === 'admin', OR
 *   3. the email is allow-listed via PARLEY_ADMIN_EMAILS AND verified.
 *
 * The env allow-list bootstraps the FIRST admin before any role/claim exists,
 * and it must not trust a self-asserted email: an attacker could register an
 * allow-listed address and, if verification is skipped, instantly become admin.
 * So the allow-list path additionally requires a verified email. (Review M3.)
 */
async function isAdminForToken(decoded: DecodedIdToken): Promise<boolean> {
  if (decoded.admin === true) return true;

  const { adminDb } = await import("@/integrations/firebase/admin");
  const snap = await adminDb().collection("profiles").doc(decoded.uid).get();
  const role = snap.exists ? (snap.data()?.role as string | undefined) : undefined;
  if (role === "admin") return true;

  const allowList = (process.env.PARLEY_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const email = (decoded.email ?? "").toLowerCase();
  return Boolean(email && allowList.includes(email) && decoded.email_verified === true);
}

/**
 * Admin gate: valid user AND admin per `isAdminForToken` above.
 */
export const requireAdmin = createMiddleware({ type: "function" }).server(async ({ next }) => {
  if (!serverFirebaseConfigured()) {
    throw new Response("Admin requires Firebase to be configured", { status: 501 });
  }
  const decoded = await verifyToken();
  if (!decoded) {
    throw new Response("Unauthorized: sign in required", { status: 401 });
  }
  if (!(await isAdminForToken(decoded))) {
    throw new Response("Forbidden: admin only", { status: 403 });
  }
  return runWithRequestContext({ userId: decoded.uid }, () =>
    next({ context: { userId: decoded.uid as string | null, isAdmin: true } }),
  );
});

export { serverFirebaseConfigured };
