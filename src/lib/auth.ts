import { createServerFn } from "@tanstack/react-start";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export type SessionUser = {
  id: string;
  email: string | null;
  is_admin: boolean;
};

function toSessionUser(u: {
  id: string;
  email?: string | null;
  app_metadata?: Record<string, unknown> | null;
}): SessionUser {
  const meta = (u.app_metadata ?? {}) as Record<string, unknown>;
  return {
    id: u.id,
    email: u.email ?? null,
    is_admin: meta.is_admin === true || meta.role === "admin",
  };
}

/**
 * Returns the signed-in user (with derived `is_admin` flag) from request cookies.
 * Null if no session. Safe to call in `beforeLoad` and server functions.
 */
export const getCurrentUser = createServerFn({ method: "GET" }).handler(
  async (): Promise<SessionUser | null> => {
    try {
      const supabase = getSupabaseServerClient();
      const { data, error } = await supabase.auth.getUser();
      if (error || !data?.user) return null;
      return toSessionUser(data.user);
    } catch {
      // No Supabase env configured yet, or transient failure → treat as signed-out.
      return null;
    }
  },
);

export const signOutFn = createServerFn({ method: "POST" }).handler(async () => {
  try {
    const supabase = getSupabaseServerClient();
    await supabase.auth.signOut();
  } catch {
    // env not set; treat as already signed out
  }
  return { ok: true } as const;
});
