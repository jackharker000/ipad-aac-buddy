import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, withCors } from "@/lib/api-cors";
import { getUserByUid, isAdminConfigured } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/firebase/admin-guard";

/**
 * Returns a single account by uid (cross-device). Admin-only. POST body:
 * `{ idToken, uid }`.
 */

export const Route = createFileRoute("/api/admin/user")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        if (!isAdminConfigured()) {
          return json({ error: "Admin features not configured on the server" }, 503);
        }
        const guard = await requireAdmin(request);
        if (guard instanceof Response) return withCorsResponse(guard);

        let uid: string | undefined;
        try {
          const body = (await request.json()) as { uid?: string };
          uid = body.uid;
        } catch {
          return json({ error: "Invalid body" }, 400);
        }
        if (!uid) return json({ error: "Missing uid" }, 400);

        try {
          const user = await getUserByUid(uid);
          if (!user) return json({ error: "User not found" }, 404);
          return json({ user }, 200);
        } catch {
          return json({ error: "User not found" }, 404);
        }
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

function withCorsResponse(res: Response): Response {
  const headers = withCors({ "content-type": "application/json" });
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}
