import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, withCors } from "@/lib/api-cors";
import {
  countUsersAtMost,
  isAdminConfigured,
  setAdminClaim,
  verifyIdToken,
} from "@/lib/firebase/admin";

/**
 * Promotes the FIRST account in the project to admin (custom claim
 * `admin: true`). Verifies the caller's Firebase ID token, then — if this is
 * the only account that exists — sets the admin claim on them. Idempotent and
 * safe to call on every sign-in: once any account is admin, the first-user
 * check no longer applies.
 *
 * Requires the service account (FIREBASE_SERVICE_ACCOUNT_B64). If it isn't
 * configured, returns is_admin:false so the app still works (no admin yet).
 */

export const Route = createFileRoute("/api/auth/ensure-role")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        if (!isAdminConfigured()) {
          return json({ is_admin: false, note: "admin-sdk-not-configured" }, 200);
        }

        let idToken: string | undefined;
        try {
          const body = (await request.json()) as { idToken?: string };
          idToken = body.idToken;
        } catch {
          return json({ error: "Invalid body" }, 400);
        }
        if (!idToken) return json({ error: "Missing idToken" }, 400);

        let uid: string;
        try {
          const decoded = await verifyIdToken(idToken);
          uid = decoded.uid;
          if (decoded.claims.admin === true) {
            return json({ is_admin: true }, 200);
          }
        } catch {
          return json({ error: "Invalid token" }, 401);
        }

        try {
          const count = await countUsersAtMost(1);
          if (count <= 1) {
            await setAdminClaim(uid);
            return json({ is_admin: true }, 200);
          }
        } catch (err) {
          console.error(
            "[api/auth/ensure-role] role bootstrap failed:",
            err instanceof Error ? err.message : "unknown",
          );
          return json({ is_admin: false }, 200);
        }

        return json({ is_admin: false }, 200);
      },
    },
  },
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: withCors({ "content-type": "application/json" }),
  });
}
