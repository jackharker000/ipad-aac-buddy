import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, requireClientToken, withCors } from "@/lib/api-cors";
import {
  isAdminConfigured,
  listDeviceKeysForUser,
  verifyIdToken,
} from "@/lib/firebase/admin";

/**
 * List the calling user's device keys (metadata only — the plaintext
 * key values were never stored). Powers the Settings → Device keys
 * card.
 *
 * Auth: Firebase ID token in `Authorization: Bearer <token>`.
 */

export const Route = createFileRoute("/api/device-keys/list")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      GET: async ({ request }) => {
        const denied = requireClientToken(request);
        if (denied) return denied;

        if (!isAdminConfigured()) {
          // Empty list rather than an error — the Settings card can still
          // render the "Generate" UX even before the service account is
          // wired, and the eventual generate call will surface the real
          // misconfiguration.
          return json({ keys: [] }, 200, request);
        }

        const authHeader = request.headers.get("authorization") ?? "";
        const idToken = authHeader.startsWith("Bearer ")
          ? authHeader.slice("Bearer ".length).trim()
          : "";
        if (!idToken) return json({ error: "Missing ID token" }, 401, request);

        let uid: string;
        try {
          ({ uid } = await verifyIdToken(idToken));
        } catch {
          return json({ error: "Invalid ID token" }, 401, request);
        }

        try {
          const keys = await listDeviceKeysForUser(uid);
          return json({ keys }, 200, request);
        } catch (err) {
          console.error(
            "[api/device-keys/list] failed:",
            err instanceof Error ? err.message : "unknown",
          );
          return json({ error: "Couldn't list device keys" }, 500, request);
        }
      },
    },
  },
});

function json(body: unknown, status: number, request?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: withCors({ "content-type": "application/json" }, request),
  });
}
