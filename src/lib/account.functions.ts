import { createServerFn } from "@tanstack/react-start";
import { requireUserOrLocal, serverSupabaseConfigured } from "./server/auth-guard";

export type WhoAmI = {
  userId: string | null;
  email: string | null;
  displayName: string | null;
  role: "user" | "admin";
  isAdmin: boolean;
  /** False on local-first dev deploys with no Supabase configured. */
  cloudEnabled: boolean;
};

/**
 * Identity + role for the signed-in user. Drives the account menu and whether
 * the Admin nav entry renders. The env allow-list (PARLEY_ADMIN_EMAILS)
 * bootstraps the first admin; the profiles.role column is the durable source.
 */
export const whoami = createServerFn({ method: "GET" })
  .middleware([requireUserOrLocal])
  .handler(async ({ context }): Promise<WhoAmI> => {
    const userId = (context as { userId: string | null }).userId;
    if (!userId || !serverSupabaseConfigured()) {
      return {
        userId,
        email: null,
        displayName: null,
        role: "user",
        isAdmin: false,
        cloudEnabled: serverSupabaseConfigured(),
      };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: profile } = await (supabaseAdmin.from("profiles") as any)
      .select("email, display_name, role")
      .eq("id", userId)
      .maybeSingle();

    // Touch last_active_at so the admin dashboard can show activity.
    void (supabaseAdmin.from("profiles") as any)
      .update({ last_active_at: new Date().toISOString() })
      .eq("id", userId)
      .then(() => {});

    const allowList = (process.env.PARLEY_ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const email: string | null = profile?.email ?? null;
    const isAdmin =
      profile?.role === "admin" || Boolean(email && allowList.includes(email.toLowerCase()));

    return {
      userId,
      email,
      displayName: profile?.display_name ?? null,
      role: isAdmin ? "admin" : "user",
      isAdmin,
      cloudEnabled: true,
    };
  });
