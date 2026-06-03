import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { corsPreflight, requireClientToken, withCors } from "@/lib/api-cors";
import { getSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * Waitlist intake endpoint. Anyone (anonymous) can POST a name/email/about
 * triple; the row is written via the service-role client so RLS stays on
 * but no client-side reads are possible. Admin reads happen server-side
 * (later: /admin/waitlist page using the service client too).
 */

const BodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  about: z.string().trim().max(2000).optional().default(""),
});

export const Route = createFileRoute("/api/waitlist")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        const denied = requireClientToken(request);
        if (denied) return denied;

        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return jsonResponse({ ok: false, error: "Invalid body" }, 400);
        }

        const parsed = BodySchema.safeParse(raw);
        if (!parsed.success) {
          return jsonResponse({ ok: false, error: "Invalid body" }, 400);
        }

        try {
          const supabase = getSupabaseServiceClient();
          const { error } = await supabase.from("waitlist").insert({
            name: parsed.data.name,
            email: parsed.data.email,
            about: parsed.data.about,
          });
          if (error) {
            // Don't echo the body — could include PII.
            console.error("[api/waitlist] supabase insert failed:", error.message);
            return jsonResponse({ ok: false, error: "Couldn't save your request" }, 500);
          }
        } catch (err) {
          console.error(
            "[api/waitlist] unexpected error:",
            err instanceof Error ? err.message : err,
          );
          return jsonResponse({ ok: false, error: "Couldn't save your request" }, 500);
        }

        return jsonResponse({ ok: true }, 200);
      },
    },
  },
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: withCors({ "content-type": "application/json" }),
  });
}
