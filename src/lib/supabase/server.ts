import { createServerClient } from "@supabase/ssr";
import type { CookieOptions } from "@supabase/ssr";
import { getCookies, setCookie } from "@tanstack/react-start/server";

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Add it to .env (server) and the Vercel project.`,
    );
  }
  return value;
}

export function getSupabaseServerClient() {
  const url = getEnv("SUPABASE_URL");
  const anonKey = getEnv("SUPABASE_ANON_KEY");

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        try {
          const all = getCookies() ?? {};
          return Object.entries(all).map(([name, value]) => ({ name, value }));
        } catch {
          return [];
        }
      },
      setAll(
        cookies: Array<{ name: string; value: string; options: CookieOptions }>,
      ) {
        try {
          for (const c of cookies) {
            setCookie(c.name, c.value, c.options as Parameters<typeof setCookie>[2]);
          }
        } catch {
          // outside a request scope (e.g. prerender) — safe to skip
        }
      },
    },
  });
}

/**
 * Privileged client (service-role key) for admin-only server work:
 * listing all users, reading usage metrics, etc. NEVER expose this on the client.
 */
export function getSupabaseServiceClient() {
  const url = getEnv("SUPABASE_URL");
  const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createServerClient(url, serviceKey, {
    cookies: {
      getAll() {
        return [];
      },
      setAll() {},
    },
  });
}
