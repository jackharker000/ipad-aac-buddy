import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, requireClientToken, withCors } from "@/lib/api-cors";
import {
  createCustomToken,
  isAdminConfigured,
  lookupDeviceKey,
} from "@/lib/firebase/admin";

/**
 * iPad autologin exchange. The home-screen icon launches
 * `/app?device_key=<long-lived-key>`; the cockpit posts that key here
 * and we hand back a short-lived Firebase custom token, which the
 * client immediately exchanges via `signInWithCustomToken`.
 *
 * NOT authenticated by an ID token — the device key IS the credential.
 * The key was generated server-side from 32 bytes of crypto-grade
 * randomness, so brute-forcing one is computationally infeasible. The
 * Firestore lookup is by SHA-256(key); a database breach reveals
 * mappings, not usable keys.
 *
 * No rate limiting at this layer — we'd need Vercel KV or similar to
 * track failed-attempt counts and we don't have one wired up. If that
 * becomes a real concern, see the unimplemented mitigations in
 * `lib/firebase/admin.ts` device-keys block.
 */

export const Route = createFileRoute("/api/autologin")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        const denied = requireClientToken(request);
        if (denied) return denied;

        if (!isAdminConfigured()) {
          return json(
            { error: "Server not configured for autologin." },
            500,
            request,
          );
        }

        let deviceKey: string | undefined;
        try {
          const body = (await request.json()) as { device_key?: unknown };
          if (typeof body.device_key === "string") deviceKey = body.device_key;
        } catch {
          return json({ error: "Invalid body" }, 400, request);
        }
        if (!deviceKey) return json({ error: "Missing device_key" }, 400, request);

        // Bound the input — anything longer than this couldn't be a
        // 32-byte base64url string and is either malformed or hostile.
        if (deviceKey.length > 256) {
          return json({ error: "Invalid device_key" }, 400, request);
        }

        let resolved: { userId: string } | null;
        try {
          resolved = await lookupDeviceKey(deviceKey);
        } catch (err) {
          console.error(
            "[api/autologin] lookup failed:",
            err instanceof Error ? err.message : "unknown",
          );
          return json({ error: "Lookup failed" }, 500, request);
        }
        if (!resolved) return json({ error: "Unknown device key" }, 401, request);

        const token = createCustomToken(resolved.userId);
        return json({ token }, 200, request);
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
