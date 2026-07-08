import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "./server/auth-guard";

/**
 * Admin-only server functions: metrics + cost ONLY.
 *
 * Scope note (project policy): admins must never see user conversations or
 * transcripts. user_backups is only ever queried for its metadata columns
 * (user_id, updated_at) — the encrypted `data` column is deliberately never
 * selected here, and no transcript-adjacent table is touched.
 */

/** Hard cap on usage_log rows fetched per aggregate query. */
const USAGE_ROW_CAP = 50_000;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function getAdminDb() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

function throwIfError(
  res: { error?: { message?: string } | null } | null | undefined,
  what: string,
): void {
  if (res?.error) {
    throw new Error(`${what} failed: ${res.error.message ?? "unknown error"}`);
  }
}

/* -------------------------------- Overview --------------------------------- */

export type AdminOverview = {
  totalUsers: number;
  activeUsers7d: number;
  newUsers30d: number;
  calls30d: number;
  estCost30d: number;
  /** 0..1 fraction of failed calls over the last 7 days. */
  errorRate7d: number;
};

export const adminOverview = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async (): Promise<AdminOverview> => {
    const supabaseAdmin = await getAdminDb();
    const cut7 = isoDaysAgo(7);
    const cut30 = isoDaysAgo(30);

    const [totalRes, activeRes, newRes, calls30Res, calls7Res, errors7Res, costRes] =
      await Promise.all([
        (supabaseAdmin.from("profiles") as any).select("id", { count: "exact", head: true }),
        (supabaseAdmin.from("profiles") as any)
          .select("id", { count: "exact", head: true })
          .gte("last_active_at", cut7),
        (supabaseAdmin.from("profiles") as any)
          .select("id", { count: "exact", head: true })
          .gte("created_at", cut30),
        (supabaseAdmin.from("usage_log") as any)
          .select("id", { count: "exact", head: true })
          .gte("created_at", cut30),
        (supabaseAdmin.from("usage_log") as any)
          .select("id", { count: "exact", head: true })
          .gte("created_at", cut7),
        (supabaseAdmin.from("usage_log") as any)
          .select("id", { count: "exact", head: true })
          .eq("ok", false)
          .gte("created_at", cut7),
        (supabaseAdmin.from("usage_log") as any)
          .select("est_cost_usd")
          .gte("created_at", cut30)
          .limit(USAGE_ROW_CAP),
      ]);
    throwIfError(totalRes, "profiles count");
    throwIfError(activeRes, "active users count");
    throwIfError(newRes, "new users count");
    throwIfError(calls30Res, "usage 30d count");
    throwIfError(calls7Res, "usage 7d count");
    throwIfError(errors7Res, "errors 7d count");
    throwIfError(costRes, "usage cost fetch");

    const costRows = (costRes.data ?? []) as { est_cost_usd: number | null }[];
    const estCost30d = costRows.reduce((sum, r) => sum + (r.est_cost_usd ?? 0), 0);
    const calls7 = calls7Res.count ?? 0;
    const errors7 = errors7Res.count ?? 0;

    return {
      totalUsers: totalRes.count ?? 0,
      activeUsers7d: activeRes.count ?? 0,
      newUsers30d: newRes.count ?? 0,
      calls30d: calls30Res.count ?? 0,
      estCost30d,
      errorRate7d: calls7 > 0 ? errors7 / calls7 : 0,
    };
  });

/* --------------------------------- Users ----------------------------------- */

export type AdminUserRow = {
  userId: string;
  email: string | null;
  displayName: string | null;
  role: string;
  createdAt: string;
  lastActiveAt: string | null;
  /** From user_backups.updated_at (metadata only — never the data column). */
  backupUpdatedAt: string | null;
  calls30d: number;
  estCost30d: number;
};

export const adminUsers = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async (): Promise<AdminUserRow[]> => {
    const supabaseAdmin = await getAdminDb();
    const cut30 = isoDaysAgo(30);

    const [profRes, backupRes, usageRes] = await Promise.all([
      (supabaseAdmin.from("profiles") as any)
        .select("id, email, display_name, role, created_at, last_active_at")
        .order("created_at", { ascending: true }),
      (supabaseAdmin.from("user_backups") as any).select("user_id, updated_at"),
      (supabaseAdmin.from("usage_log") as any)
        .select("user_id, est_cost_usd, created_at")
        .gte("created_at", cut30)
        .limit(USAGE_ROW_CAP),
    ]);
    throwIfError(profRes, "profiles fetch");
    throwIfError(backupRes, "backups metadata fetch");
    throwIfError(usageRes, "usage fetch");

    const profiles = (profRes.data ?? []) as {
      id: string;
      email: string | null;
      display_name: string | null;
      role: string;
      created_at: string;
      last_active_at: string | null;
    }[];
    const backups = (backupRes.data ?? []) as { user_id: string; updated_at: string }[];
    const usage = (usageRes.data ?? []) as {
      user_id: string | null;
      est_cost_usd: number | null;
    }[];

    const backupByUser = new Map(backups.map((b) => [b.user_id, b.updated_at] as const));
    const usageByUser = new Map<string, { calls: number; cost: number }>();
    for (const row of usage) {
      if (!row.user_id) continue;
      const agg = usageByUser.get(row.user_id) ?? { calls: 0, cost: 0 };
      agg.calls += 1;
      agg.cost += row.est_cost_usd ?? 0;
      usageByUser.set(row.user_id, agg);
    }

    return profiles.map((p) => {
      const agg = usageByUser.get(p.id);
      return {
        userId: p.id,
        email: p.email,
        displayName: p.display_name,
        role: p.role,
        createdAt: p.created_at,
        lastActiveAt: p.last_active_at,
        backupUpdatedAt: backupByUser.get(p.id) ?? null,
        calls30d: agg?.calls ?? 0,
        estCost30d: agg?.cost ?? 0,
      };
    });
  });

/* --------------------------------- Usage ----------------------------------- */

const usageInputSchema = z.object({
  days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30),
});

export type AdminUsageReport = {
  days: number;
  dailySeries: { date: string; calls: number; estCostUsd: number; errors: number }[];
  byProvider: {
    provider: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    estCostUsd: number;
  }[];
  byModel: { model: string; calls: number; estCostUsd: number }[];
  byFn: { fn: string; calls: number; estCostUsd: number; avgLatencyMs: number | null }[];
  topUsers: { userId: string; email: string | null; calls: number; estCostUsd: number }[];
};

export const adminUsage = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d) => usageInputSchema.parse(d))
  .handler(async ({ data }): Promise<AdminUsageReport> => {
    const supabaseAdmin = await getAdminDb();
    const days = data.days;
    const cutoff = isoDaysAgo(days);

    const [usageRes, profRes] = await Promise.all([
      // Numeric/meta columns only — never the error text.
      (supabaseAdmin.from("usage_log") as any)
        .select(
          "user_id, fn, provider, model, input_tokens, output_tokens, est_cost_usd, latency_ms, ok, created_at",
        )
        .gte("created_at", cutoff)
        .order("created_at", { ascending: true })
        .limit(USAGE_ROW_CAP),
      (supabaseAdmin.from("profiles") as any).select("id, email"),
    ]);
    throwIfError(usageRes, "usage fetch");
    throwIfError(profRes, "profiles fetch");

    const rows = (usageRes.data ?? []) as {
      user_id: string | null;
      fn: string;
      provider: string;
      model: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
      est_cost_usd: number | null;
      latency_ms: number | null;
      ok: boolean;
      created_at: string;
    }[];
    const emailByUser = new Map(
      ((profRes.data ?? []) as { id: string; email: string | null }[]).map(
        (p) => [p.id, p.email] as const,
      ),
    );

    // Daily series: seed every day in the window so the chart has no gaps.
    const daily = new Map<string, { calls: number; estCostUsd: number; errors: number }>();
    for (let i = days - 1; i >= 0; i--) {
      daily.set(isoDaysAgo(i).slice(0, 10), { calls: 0, estCostUsd: 0, errors: 0 });
    }

    const byProvider = new Map<
      string,
      { calls: number; inputTokens: number; outputTokens: number; estCostUsd: number }
    >();
    const byModel = new Map<string, { calls: number; estCostUsd: number }>();
    const byFn = new Map<
      string,
      { calls: number; estCostUsd: number; latencySum: number; latencyCount: number }
    >();
    const byUser = new Map<string, { calls: number; estCostUsd: number }>();

    for (const row of rows) {
      const cost = row.est_cost_usd ?? 0;

      const dayKey = row.created_at.slice(0, 10);
      const day = daily.get(dayKey) ?? { calls: 0, estCostUsd: 0, errors: 0 };
      day.calls += 1;
      day.estCostUsd += cost;
      if (!row.ok) day.errors += 1;
      daily.set(dayKey, day);

      const prov = byProvider.get(row.provider) ?? {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        estCostUsd: 0,
      };
      prov.calls += 1;
      prov.inputTokens += row.input_tokens ?? 0;
      prov.outputTokens += row.output_tokens ?? 0;
      prov.estCostUsd += cost;
      byProvider.set(row.provider, prov);

      const modelKey = row.model ?? "(none)";
      const model = byModel.get(modelKey) ?? { calls: 0, estCostUsd: 0 };
      model.calls += 1;
      model.estCostUsd += cost;
      byModel.set(modelKey, model);

      const fn = byFn.get(row.fn) ?? {
        calls: 0,
        estCostUsd: 0,
        latencySum: 0,
        latencyCount: 0,
      };
      fn.calls += 1;
      fn.estCostUsd += cost;
      if (row.latency_ms != null) {
        fn.latencySum += row.latency_ms;
        fn.latencyCount += 1;
      }
      byFn.set(row.fn, fn);

      if (row.user_id) {
        const user = byUser.get(row.user_id) ?? { calls: 0, estCostUsd: 0 };
        user.calls += 1;
        user.estCostUsd += cost;
        byUser.set(row.user_id, user);
      }
    }

    return {
      days,
      dailySeries: [...daily.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => ({ date, ...v })),
      byProvider: [...byProvider.entries()]
        .map(([provider, v]) => ({ provider, ...v }))
        .sort((a, b) => b.estCostUsd - a.estCostUsd),
      byModel: [...byModel.entries()]
        .map(([model, v]) => ({ model, ...v }))
        .sort((a, b) => b.estCostUsd - a.estCostUsd),
      byFn: [...byFn.entries()]
        .map(([fn, v]) => ({
          fn,
          calls: v.calls,
          estCostUsd: v.estCostUsd,
          avgLatencyMs: v.latencyCount > 0 ? Math.round(v.latencySum / v.latencyCount) : null,
        }))
        .sort((a, b) => b.estCostUsd - a.estCostUsd),
      topUsers: [...byUser.entries()]
        .map(([userId, v]) => ({
          userId,
          email: emailByUser.get(userId) ?? null,
          ...v,
        }))
        .sort((a, b) => b.estCostUsd - a.estCostUsd)
        .slice(0, 10),
    };
  });

/* -------------------------------- Set role --------------------------------- */

const setRoleSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["user", "admin"]),
});

export const adminSetRole = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d) => setRoleSchema.parse(d))
  .handler(async ({ data, context }) => {
    const me = (context as { userId: string | null }).userId;
    if (data.userId === me && data.role !== "admin") {
      throw new Response("You cannot demote yourself", { status: 400 });
    }
    const supabaseAdmin = await getAdminDb();
    // Last-admin-standing guard: refuse a demotion that would leave zero admins
    // and lock everyone out of the admin surface with no in-app recovery.
    // (Security review M1.) PARLEY_ADMIN_EMAILS remains the break-glass path.
    if (data.role !== "admin") {
      const { count } = await (supabaseAdmin.from("profiles") as any)
        .select("id", { count: "exact", head: true })
        .eq("role", "admin");
      if ((count ?? 0) <= 1) {
        throw new Response("Cannot demote the last remaining admin", { status: 400 });
      }
    }
    const { error } = await (supabaseAdmin.from("profiles") as any)
      .update({ role: data.role })
      .eq("id", data.userId);
    if (error) throw new Error(`role update failed: ${error.message}`);
    return { ok: true as const, userId: data.userId, role: data.role };
  });
