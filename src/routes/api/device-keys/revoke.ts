import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, requireClientToken, withCors } from "@/lib/api-cors";
import {
  deleteDeviceKey,
  isAdminConfigured,
  listDeviceKeysForUser,
  verifyIdToken,
} from "@/lib/firebase/admin";

/**
 * Revoke one of the caller's device keys by its hash id. The home-screen
 * icon that references the underlying key becomes inert immediately —
 * the next autologin attempt 401s and the gateway redirects to /login.
 *
 * Ownership check: the key's hash id is provided by the caller, so we
 * re-list the caller's keys server-side and reject any id that doesn't
 * belong to them. This is one extra RPC vs trusting the caller, but
 * keeps a hostile actor from revoking someone else's keys with a
 * stolen ID token + a guessable hash.
 */

export const Route = createFileRoute("/api/device-keys/revoke")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        const denied = requireClientToken(request);
        if (denied) return denied;

        if (!isAdminConfigured()) {
          return json(
            { error: "Server not configured for device keys." },
            500,
            request,
          );
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

        let keyId: string | undefined;
        try {
          const body = (await request.json()) as { id?: unknown };
          if (typeof body.id === "string") keyId = body.id;
        } catch {
          return json({ error: "Invalid body" }, 400, request);
        }
        if (!keyId) return json({ error: "Missing id" }, 400, request);

        try {
          const owned = await listDeviceKeysForUser(uid);
          if (!owned.some((k) => k.id === keyId)) {
            return json({ error: "Not found" }, 404, request);
          }
          await deleteDeviceKey(keyId);
          return json({ ok: true }, 200, request);
        } catch (err) {
          console.error(
            "[api/device-keys/revoke] failed:",
            err instanceof Error ? err.message : "unknown",
          );
          return json({ error: "Couldn't revoke the key" }, 500, request);
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
