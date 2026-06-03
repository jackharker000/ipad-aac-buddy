import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { getSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * Admin-only server helpers. EVERY function in this file MUST re-verify the
 * caller's admin flag — defense in depth. The route-level `beforeLoad` guard
 * in `src/routes/admin.tsx` is the first line, but server functions can be
 * called directly (e.g. from a fetch in DevTools), so they must not trust the
 * route guard alone.
 *
 * All queries go through `getSupabaseServiceClient()` — the service-role key
 * is required to list users and read the cross-user `waitlist` table without
 * RLS getting in the way. The service client MUST stay server-side.
 *
 * Returned objects are stripped to plain serializable shapes — Supabase's
 * `User` type carries factors, identities, etc. that aren't needed in the UI
 * and won't survive structured clone across the network boundary cleanly.
 */

/** Compact, serializable shape of an auth user — only the fields the UI uses. */
export type AdminUser = {
  id: string;
  email: string | null;
  created_at: string | null;
  last_sign_in_at: string | null;
  email_confirmed_at: string | null;
  provider: string | null;
  is_admin: boolean;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
};

/** A row from the `waitlist` table. */
export type WaitlistEntry = {
  id: string | number;
  email: string | null;
  name: string | null;
  about: string | null;
  created_at: string | null;
};

type RawUser = {
  id: string;
  email?: string | null;
  created_at?: string;
  last_sign_in_at?: string | null;
  email_confirmed_at?: string | null;
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
  identities?: Array<{ provider?: string | null }> | null;
};

function toAdminUser(u: RawUser): AdminUser {
  const meta = (u.app_metadata ?? {}) as Record<string, unknown>;
  return {
    id: u.id,
    email: u.email ?? null,
    created_at: u.created_at ?? null,
    last_sign_in_at: u.last_sign_in_at ?? null,
    email_confirmed_at: u.email_confirmed_at ?? null,
    provider: u.identities?.[0]?.provider ?? null,
    is_admin: meta.is_admin === true || meta.role === "admin",
    app_metadata: meta,
    user_metadata: (u.user_metadata ?? {}) as Record<string, unknown>,
  };
}

async function assertAdmin(): Promise<void> {
  const me = await getCurrentUser();
  if (!me?.is_admin) {
    throw new Error("Forbidden");
  }
}

/**
 * Overview: top-of-page stats and two short recent lists.
 *
 * Conversation counts intentionally absent — those live in each user's
 * on-device Dexie, not Supabase. The UI surfaces that as a labelled gap.
 */
export const getOverview = createServerFn({ method: "GET" }).handler(async () => {
  await assertAdmin();
  const supabase = getSupabaseServiceClient();

  // perPage:1 is the cheapest call that still returns the total via Pagination.
  const totalRes = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
  const userCount =
    totalRes.error || typeof (totalRes.data as { total?: number }).total !== "number"
      ? null
      : (totalRes.data as { total: number }).total;

  const recentUsersRes = await supabase.auth.admin.listUsers({ page: 1, perPage: 10 });
  const recentUsers = recentUsersRes.error
    ? []
    : (recentUsersRes.data.users as RawUser[]).map(toAdminUser);

  const waitlistRes = await supabase
    .from("waitlist")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(10);

  const recentWaitlist: WaitlistEntry[] = waitlistRes.error
    ? []
    : ((waitlistRes.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
        id: (row.id as string | number) ?? "",
        email: (row.email as string | null) ?? null,
        name: (row.name as string | null) ?? null,
        about: (row.about as string | null) ?? null,
        created_at: (row.created_at as string | null) ?? null,
      }));
  const waitlistCount = waitlistRes.error ? null : (waitlistRes.count ?? recentWaitlist.length);

  return { userCount, waitlistCount, recentUsers, recentWaitlist };
});

const ListUsersInput = z.object({
  page: z.number().int().min(1).default(1),
  perPage: z.number().int().min(1).max(200).default(25),
});

/**
 * Paginated user list for `/admin/users`. The Supabase admin API is the only
 * way to see every user — `auth.users` isn't queryable via the standard table
 * client, even with the service role.
 */
export const listUsers = createServerFn({ method: "GET" })
  .inputValidator(ListUsersInput)
  .handler(async ({ data }) => {
    await assertAdmin();
    const supabase = getSupabaseServiceClient();

    const res = await supabase.auth.admin.listUsers({
      page: data.page,
      perPage: data.perPage,
    });
    if (res.error) {
      throw new Error(`Failed to list users: ${res.error.message}`);
    }

    const users = (res.data.users as RawUser[]).map(toAdminUser);
    const total =
      typeof (res.data as { total?: number }).total === "number"
        ? (res.data as { total: number }).total
        : null;

    return {
      users,
      total,
      page: data.page,
      perPage: data.perPage,
    };
  });

const GetUserByIdInput = z.object({
  userId: z.string().min(1),
});

/** Single user detail for `/admin/users/$userId`. */
export const getUserById = createServerFn({ method: "GET" })
  .inputValidator(GetUserByIdInput)
  .handler(async ({ data }) => {
    await assertAdmin();
    const supabase = getSupabaseServiceClient();

    const res = await supabase.auth.admin.getUserById(data.userId);
    if (res.error || !res.data?.user) {
      throw new Error(res.error?.message ?? "User not found");
    }
    return { user: toAdminUser(res.data.user as RawUser) };
  });
