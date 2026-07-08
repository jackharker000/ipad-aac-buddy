import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Firestore, Timestamp as TimestampType } from "firebase-admin/firestore";
import type { Auth as AdminAuthType, UserRecord } from "firebase-admin/auth";
import { requireAdmin } from "./server/auth-guard";

/**
 * Admin-only server functions: metrics + cost ONLY.
 *
 * Scope note (project policy): admins must never see user conversations or
 * transcripts. `user_backups` holds the encrypted snapshot and is deliberately
 * NEVER read here — not even its metadata. `backupUpdatedAt` is therefore
 * always null (the admin surface has zero backup visibility), preserving the
 * "no admin access to backups" guarantee at the code level, not just via rules.
 */

/** Hard cap on usage_log rows fetched per aggregate query. */
const USAGE_ROW_CAP = 50_000;
/** Hard cap on auth users paged in for the dashboard. */
const USER_CAP = 5_000;

function daysAgoDate(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function isoDaysAgo(days: number): string {
  return daysAgoDate(days).toISOString();
}

/** Firestore Timestamp → ISO string (tolerant of missing/pending values). */
function tsToIso(v: unknown): string {
  if (v && typeof (v as { toDate?: () => Date }).toDate === "function") {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  return new Date().toISOString();
}

async function loadAdmin(): Promise<{
  db: Firestore;
  auth: AdminAuthType;
  Timestamp: typeof TimestampType;
  FieldValue: typeof import("firebase-admin/firestore").FieldValue;
}> {
  const [{ adminDb, adminAuth }, { Timestamp, FieldValue }] = await Promise.all([
    import("@/integrations/firebase/admin"),
    import("firebase-admin/firestore"),
  ]);
  return { db: adminDb(), auth: adminAuth(), Timestamp, FieldValue };
}

/** Page through every auth user (up to USER_CAP). */
async function listAllUsers(auth: AdminAuthType): Promise<UserRecord[]> {
  const users: UserRecord[] = [];
  let pageToken: string | undefined;
  do {
    const res = await auth.listUsers(1000, pageToken);
    users.push(...res.users);
    pageToken = res.pageToken;
  } while (pageToken && users.length < USER_CAP);
  return users;
}

/** Most recent activity signal for an auth user, as epoch ms (0 if unknown). */
function lastActiveMs(u: UserRecord): number {
  const candidates = [u.metadata?.lastRefreshTime, u.metadata?.lastSignInTime]
    .filter(Boolean)
    .map((s) => new Date(s as string).getTime())
    .filter((n) => Number.isFinite(n));
  return candidates.length ? Math.max(...candidates) : 0;
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
    const { db, auth, Timestamp } = await loadAdmin();
    const cut7 = daysAgoDate(7).getTime();
    const cut30 = daysAgoDate(30).getTime();
    const ts7 = Timestamp.fromDate(daysAgoDate(7));
    const ts30 = Timestamp.fromDate(daysAgoDate(30));

    const usage = db.collection("usage_log");
    const [users, calls30Agg, cost30Snap, rows7Snap] = await Promise.all([
      listAllUsers(auth),
      usage.where("createdAt", ">=", ts30).count().get(),
      usage.where("createdAt", ">=", ts30).select("estCostUsd").limit(USAGE_ROW_CAP).get(),
      usage.where("createdAt", ">=", ts7).select("ok").limit(USAGE_ROW_CAP).get(),
    ]);

    const totalUsers = users.length;
    const newUsers30d = users.filter((u) => {
      const c = new Date(u.metadata?.creationTime ?? 0).getTime();
      return Number.isFinite(c) && c >= cut30;
    }).length;
    const activeUsers7d = users.filter((u) => lastActiveMs(u) >= cut7).length;

    const estCost30d = cost30Snap.docs.reduce(
      (sum, d) => sum + ((d.get("estCostUsd") as number | null) ?? 0),
      0,
    );
    const calls7 = rows7Snap.size;
    const errors7 = rows7Snap.docs.filter((d) => d.get("ok") === false).length;

    return {
      totalUsers,
      activeUsers7d,
      newUsers30d,
      calls30d: calls30Agg.data().count,
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
  /** Always null — admins deliberately have zero visibility into backups. */
  backupUpdatedAt: string | null;
  calls30d: number;
  estCost30d: number;
};

type ProfileDoc = {
  email?: string | null;
  displayName?: string | null;
  role?: string;
  createdAt?: unknown;
  lastActiveAt?: unknown;
};

export const adminUsers = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async (): Promise<AdminUserRow[]> => {
    const { db, auth, Timestamp } = await loadAdmin();
    const ts30 = Timestamp.fromDate(daysAgoDate(30));

    const [users, profSnap, usageSnap] = await Promise.all([
      listAllUsers(auth),
      db.collection("profiles").get(),
      db
        .collection("usage_log")
        .where("createdAt", ">=", ts30)
        .select("userId", "estCostUsd")
        .limit(USAGE_ROW_CAP)
        .get(),
    ]);

    const profileById = new Map<string, ProfileDoc>();
    for (const doc of profSnap.docs) profileById.set(doc.id, doc.data() as ProfileDoc);

    const usageByUser = new Map<string, { calls: number; cost: number }>();
    for (const doc of usageSnap.docs) {
      const uid = doc.get("userId") as string | null;
      if (!uid) continue;
      const agg = usageByUser.get(uid) ?? { calls: 0, cost: 0 };
      agg.calls += 1;
      agg.cost += (doc.get("estCostUsd") as number | null) ?? 0;
      usageByUser.set(uid, agg);
    }

    const rows: AdminUserRow[] = users.map((u) => {
      const p = profileById.get(u.uid);
      const agg = usageByUser.get(u.uid);
      const createdAt = p?.createdAt
        ? tsToIso(p.createdAt)
        : new Date(u.metadata?.creationTime ?? Date.now()).toISOString();
      const lastActiveIso = p?.lastActiveAt
        ? tsToIso(p.lastActiveAt)
        : lastActiveMs(u)
          ? new Date(lastActiveMs(u)).toISOString()
          : null;
      return {
        userId: u.uid,
        email: p?.email ?? u.email ?? null,
        displayName: p?.displayName ?? u.displayName ?? null,
        role: p?.role ?? "user",
        createdAt,
        lastActiveAt: lastActiveIso,
        backupUpdatedAt: null,
        calls30d: agg?.calls ?? 0,
        estCost30d: agg?.cost ?? 0,
      };
    });

    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return rows;
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
    const { db, Timestamp } = await loadAdmin();
    const days = data.days;
    const cutoff = Timestamp.fromDate(daysAgoDate(days));

    const [usageSnap, profSnap] = await Promise.all([
      // Numeric/meta columns only — never the error text.
      db
        .collection("usage_log")
        .where("createdAt", ">=", cutoff)
        .orderBy("createdAt", "asc")
        .limit(USAGE_ROW_CAP)
        .select(
          "userId",
          "fn",
          "provider",
          "model",
          "inputTokens",
          "outputTokens",
          "estCostUsd",
          "latencyMs",
          "ok",
          "createdAt",
        )
        .get(),
      db.collection("profiles").select("email").get(),
    ]);

    const emailByUser = new Map<string, string | null>();
    for (const doc of profSnap.docs)
      emailByUser.set(doc.id, (doc.get("email") as string | null) ?? null);

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

    for (const doc of usageSnap.docs) {
      const cost = (doc.get("estCostUsd") as number | null) ?? 0;
      const provider = (doc.get("provider") as string | null) ?? "unknown";
      const fnName = (doc.get("fn") as string | null) ?? "unknown";
      const okVal = doc.get("ok") as boolean;
      const latency = doc.get("latencyMs") as number | null;
      const userId = doc.get("userId") as string | null;

      const dayKey = tsToIso(doc.get("createdAt")).slice(0, 10);
      const day = daily.get(dayKey) ?? { calls: 0, estCostUsd: 0, errors: 0 };
      day.calls += 1;
      day.estCostUsd += cost;
      if (okVal === false) day.errors += 1;
      daily.set(dayKey, day);

      const prov = byProvider.get(provider) ?? {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        estCostUsd: 0,
      };
      prov.calls += 1;
      prov.inputTokens += (doc.get("inputTokens") as number | null) ?? 0;
      prov.outputTokens += (doc.get("outputTokens") as number | null) ?? 0;
      prov.estCostUsd += cost;
      byProvider.set(provider, prov);

      const modelKey = (doc.get("model") as string | null) ?? "(none)";
      const model = byModel.get(modelKey) ?? { calls: 0, estCostUsd: 0 };
      model.calls += 1;
      model.estCostUsd += cost;
      byModel.set(modelKey, model);

      const fn = byFn.get(fnName) ?? { calls: 0, estCostUsd: 0, latencySum: 0, latencyCount: 0 };
      fn.calls += 1;
      fn.estCostUsd += cost;
      if (latency != null) {
        fn.latencySum += latency;
        fn.latencyCount += 1;
      }
      byFn.set(fnName, fn);

      if (userId) {
        const user = byUser.get(userId) ?? { calls: 0, estCostUsd: 0 };
        user.calls += 1;
        user.estCostUsd += cost;
        byUser.set(userId, user);
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
    const { db, auth, FieldValue } = await loadAdmin();

    // Last-admin-standing guard: refuse a demotion that would leave zero admins
    // and lock everyone out of the admin surface with no in-app recovery.
    // (Security review M1.) PARLEY_ADMIN_EMAILS remains the break-glass path.
    if (data.role !== "admin") {
      const adminCount = await db.collection("profiles").where("role", "==", "admin").count().get();
      if (adminCount.data().count <= 1) {
        throw new Response("Cannot demote the last remaining admin", { status: 400 });
      }
    }

    // Durable role in Firestore (source of truth) + Firebase custom claim
    // (so `request.auth.token.admin` gates client Firestore reads and the auth
    // guard can short-circuit without a profile read). The claim reaches the
    // client on the next ID-token refresh; requireAdmin also honors the role
    // doc, so server-side admin access is effective immediately.
    await db
      .collection("profiles")
      .doc(data.userId)
      .set({ role: data.role, lastActiveAt: FieldValue.serverTimestamp() }, { merge: true });
    await auth.setCustomUserClaims(data.userId, { admin: data.role === "admin" });

    return { ok: true as const, userId: data.userId, role: data.role };
  });
