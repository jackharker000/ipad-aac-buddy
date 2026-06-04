import crypto from "node:crypto";

import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, withCors } from "@/lib/api-cors";
import { getProjectId, isAdminConfigured } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/firebase/admin-guard";

/**
 * Aggregated usage events for the admin dashboard. Reads the last N days of
 * `usage_events` from Firestore (REST `runQuery`) and rolls them up server-side
 * into totals + per-user / per-kind / per-provider breakdowns.
 *
 * Admin-only. Mirrors `/api/admin/users` for CORS + the 503-if-not-configured
 * guard. POST so the ID token travels in the body, not the URL.
 *
 * Body: `{ idToken, days? }` (days ∈ 1..365, default 30).
 */

export const Route = createFileRoute("/api/admin/usage")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        if (!isAdminConfigured()) {
          return json({ error: "Admin features not configured on the server" }, 503);
        }
        const guard = await requireAdmin(request);
        if (guard instanceof Response) return withCorsResponse(guard);

        let days = 30;
        try {
          const body = (await request.json()) as { days?: unknown };
          if (typeof body.days === "number" && Number.isFinite(body.days)) {
            days = Math.max(1, Math.min(365, Math.floor(body.days)));
          }
        } catch {
          // Empty / non-JSON body is fine — default to 30 days.
        }

        try {
          const aggregate = await loadUsage(days);
          return json({ aggregate }, 200);
        } catch (err) {
          console.error(
            "[api/admin/usage] load failed:",
            err instanceof Error ? err.message : "unknown",
          );
          return json({ error: "Couldn't load usage" }, 500);
        }
      },
    },
  },
});

// --------------------------------------------------------------------------
// Aggregation
// --------------------------------------------------------------------------

type UserBucket = {
  uid: string | null;
  events: number;
  tokensIn: number;
  tokensOut: number;
  characters: number;
  audioBytes: number;
  millicents: number;
};

type KindBucket = { kind: string; events: number; millicents: number };
type ProviderBucket = { provider: string; events: number; millicents: number };

type Aggregate = {
  totals: {
    events: number;
    tokensIn: number;
    tokensOut: number;
    characters: number;
    audioBytes: number;
    millicents: number;
  };
  byUser: UserBucket[];
  byKind: KindBucket[];
  byProvider: ProviderBucket[];
  days: number;
  rangeFrom: string;
  rangeTo: string;
};

type UsageEventRow = {
  uid: string | null;
  kind: string;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  characters: number;
  audioBytes: number;
  millicents: number;
};

function emptyAggregate(days: number, from: string, to: string): Aggregate {
  return {
    totals: {
      events: 0,
      tokensIn: 0,
      tokensOut: 0,
      characters: 0,
      audioBytes: 0,
      millicents: 0,
    },
    byUser: [],
    byKind: [],
    byProvider: [],
    days,
    rangeFrom: from,
    rangeTo: to,
  };
}

async function loadUsage(days: number): Promise<Aggregate> {
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const rangeFrom = from.toISOString();
  const rangeTo = now.toISOString();

  const events = await queryUsageEvents(rangeFrom);
  if (events.length === 0) return emptyAggregate(days, rangeFrom, rangeTo);

  const totals = {
    events: 0,
    tokensIn: 0,
    tokensOut: 0,
    characters: 0,
    audioBytes: 0,
    millicents: 0,
  };
  const userMap = new Map<string, UserBucket>();
  const kindMap = new Map<string, KindBucket>();
  const providerMap = new Map<string, ProviderBucket>();

  for (const ev of events) {
    totals.events += 1;
    totals.tokensIn += ev.tokensIn;
    totals.tokensOut += ev.tokensOut;
    totals.characters += ev.characters;
    totals.audioBytes += ev.audioBytes;
    totals.millicents += ev.millicents;

    const userKey = ev.uid ?? "__anon__";
    const ub = userMap.get(userKey) ?? {
      uid: ev.uid,
      events: 0,
      tokensIn: 0,
      tokensOut: 0,
      characters: 0,
      audioBytes: 0,
      millicents: 0,
    };
    ub.events += 1;
    ub.tokensIn += ev.tokensIn;
    ub.tokensOut += ev.tokensOut;
    ub.characters += ev.characters;
    ub.audioBytes += ev.audioBytes;
    ub.millicents += ev.millicents;
    userMap.set(userKey, ub);

    const kb = kindMap.get(ev.kind) ?? { kind: ev.kind, events: 0, millicents: 0 };
    kb.events += 1;
    kb.millicents += ev.millicents;
    kindMap.set(ev.kind, kb);

    const pb = providerMap.get(ev.provider) ?? { provider: ev.provider, events: 0, millicents: 0 };
    pb.events += 1;
    pb.millicents += ev.millicents;
    providerMap.set(ev.provider, pb);
  }

  const byUser = Array.from(userMap.values()).sort((a, b) => b.millicents - a.millicents);
  const byKind = Array.from(kindMap.values()).sort((a, b) => b.millicents - a.millicents);
  const byProvider = Array.from(providerMap.values()).sort((a, b) => b.millicents - a.millicents);

  return { totals, byUser, byKind, byProvider, days, rangeFrom, rangeTo };
}

// --------------------------------------------------------------------------
// Firestore REST runQuery
// --------------------------------------------------------------------------

type RunQueryResult = Array<{
  document?: {
    fields?: Record<string, FirestoreValue>;
  };
}>;

type FirestoreValue = {
  nullValue?: null;
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  timestampValue?: string;
};

async function queryUsageEvents(sinceIso: string): Promise<UsageEventRow[]> {
  const token = await getAccessToken();
  if (!token) throw new Error("Couldn't mint a Firestore access token");

  const url = `https://firestore.googleapis.com/v1/projects/${getProjectId()}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: "usage_events" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "createdAt" },
          op: "GREATER_THAN_OR_EQUAL",
          value: { timestampValue: sinceIso },
        },
      },
      limit: 5000,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`runQuery failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const rows = (await res.json()) as RunQueryResult;
  const out: UsageEventRow[] = [];
  for (const row of rows) {
    const fields = row.document?.fields;
    if (!fields) continue; // results without a document are "no matches" sentinels
    out.push({
      uid: readString(fields.uid),
      kind: readString(fields.kind) ?? "unknown",
      provider: readString(fields.provider) ?? "unknown",
      tokensIn: readInt(fields.tokensIn),
      tokensOut: readInt(fields.tokensOut),
      characters: readInt(fields.characters),
      audioBytes: readInt(fields.audioBytes),
      millicents: readInt(fields.millicents),
    });
  }
  return out;
}

function readString(v: FirestoreValue | undefined): string | null {
  if (!v) return null;
  if (typeof v.stringValue === "string") return v.stringValue;
  return null;
}

function readInt(v: FirestoreValue | undefined): number {
  if (!v) return 0;
  if (typeof v.integerValue === "string") {
    const n = Number(v.integerValue);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v.doubleValue === "number" && Number.isFinite(v.doubleValue)) {
    return Math.round(v.doubleValue);
  }
  return 0;
}

// --------------------------------------------------------------------------
// OAuth2 access token (service-account JWT). Duplicates metering.ts's helper
// because importing from there would couple this route to a logging-only
// module that may change shape; the body is small and self-contained.
// --------------------------------------------------------------------------

async function getAccessToken(): Promise<string | null> {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) return null;
  try {
    const sa = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      client_email: string;
      private_key: string;
    };
    sa.private_key = sa.private_key.replace(/\\n/g, "\n");
    const now = Math.floor(Date.now() / 1000);
    const b64url = (s: Buffer | string) =>
      Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
      JSON.stringify({
        iss: sa.client_email,
        scope: "https://www.googleapis.com/auth/datastore",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    );
    const signingInput = `${header}.${claims}`;
    const signature = b64url(
      crypto.createSign("RSA-SHA256").update(signingInput).sign(sa.private_key),
    );
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${signingInput}.${signature}`,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token: string };
    return data.access_token;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Response helpers — mirror the sibling admin routes verbatim.
// --------------------------------------------------------------------------

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
