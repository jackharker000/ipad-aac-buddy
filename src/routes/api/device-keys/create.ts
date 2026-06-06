import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, requireClientToken, withCors } from "@/lib/api-cors";
import {
  createDeviceKey,
  isAdminConfigured,
  verifyIdToken,
} from "@/lib/firebase/admin";

/**
 * Mint a new iPad device key for the calling user. The plaintext key is
 * returned exactly once — it's never persisted server-side; only the
 * SHA-256 hash and metadata go to Firestore. The caller is responsible
 * for using it immediately (bake into the manifest, walk the user
 * through Add-to-Home-Screen) and discarding it.
 *
 * Auth: a Firebase ID token in `Authorization: Bearer <token>`. The
 * resulting key belongs to that token's uid; no way for a client to
 * mint a key for another user.
 */

const MAX_LABEL_LENGTH = 80;

export const Route = createFileRoute("/api/device-keys/create")({
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

        let label = "iPad";
        try {
          const body = (await request.json()) as { label?: unknown };
          if (typeof body.label === "string") {
            const trimmed = body.label.trim();
            if (trimmed.length > 0) label = trimmed.slice(0, MAX_LABEL_LENGTH);
          }
        } catch {
          // Body is optional — fall through with the default label.
        }

        try {
          const { key, meta } = await createDeviceKey(uid, label);
          return json({ key, meta }, 200, request);
        } catch (err) {
          console.error(
            "[api/device-keys/create] failed:",
            err instanceof Error ? err.message : "unknown",
          );
          return json({ error: "Couldn't create the key" }, 500, request);
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
