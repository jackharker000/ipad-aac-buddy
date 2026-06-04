/**
 * Server-side usage metering. Every /api/* call records a usage_event in
 * Firestore so the admin dashboard can show per-user totals and estimated
 * cost. Latency-sensitive: writes are awaited but the Firestore REST round
 * trip is typically <150ms, and the alternative (fire-and-forget) is unsafe
 * in a serverless function where the worker is killed once the response is
 * sent.
 *
 * When the service account isn't configured, logUsage is a silent no-op so
 * the API routes keep working.
 */

import { getProjectId, isAdminConfigured, verifyIdToken } from "@/lib/firebase/admin";

export type UsageKind = "llm" | "stt" | "tts" | "embed";

export type UsageEvent = {
  uid: string | null; // null = unauthenticated request (still logged)
  kind: UsageKind;
  provider: string; // "anthropic" | "openai" | "elevenlabs" | "cartesia"
  model: string | null; // e.g. "claude-haiku-4-5"
  /** LLM/embed: prompt tokens (Anthropic input_tokens, OpenAI prompt_tokens). */
  tokensIn?: number;
  /** LLM: completion tokens. */
  tokensOut?: number;
  /** TTS: characters synthesised. */
  characters?: number;
  /** STT: input audio bytes (raw POST body length). */
  audioBytes?: number;
  /** Whole-request server-side wall time, ms. */
  durationMs: number;
  /** Estimated cost, US-cents *100 (i.e. millicents) — keep integer math.  */
  millicents: number;
  /** HTTP status of the upstream response (or 0 on local failure). */
  status: number;
};

// --------------------------------------------------------------------------
// Cost table — rough, per the public price sheets at time of writing.
// Updated by the price sheets; close enough for "are we on track" budgeting.
// All values are US cents per UNIT; tokens are per 1M.
// --------------------------------------------------------------------------

type Rate = {
  inPer1M?: number; // $/1M input tokens, in cents
  outPer1M?: number; // $/1M output tokens, in cents
  perChar?: number; // $/character, in millicents (1c = 1000 millicents)
  perMinute?: number; // $/min, in cents (for STT)
};

const RATES: Record<string, Rate> = {
  // Anthropic
  "claude-haiku-4-5": { inPer1M: 80, outPer1M: 400 },
  "claude-sonnet-4-5": { inPer1M: 300, outPer1M: 1500 },
  // OpenAI (rough — actual price depends on model alias)
  "gpt-4o-mini": { inPer1M: 15, outPer1M: 60 },
  "gpt-4o": { inPer1M: 250, outPer1M: 1000 },
  "text-embedding-3-small": { inPer1M: 2 },
  // ElevenLabs Flash v2.5
  "eleven_flash_v2_5": { perChar: 30 }, // ~$0.0003/char
  // Cartesia Sonic
  "sonic-2": { perChar: 25 },
  // ElevenLabs Scribe v2 realtime — billed per minute of audio
  "scribe_v2_realtime": { perMinute: 30 }, // ~$0.30/min
};

function rateFor(model: string | null | undefined): Rate {
  if (!model) return {};
  return RATES[model] ?? {};
}

export function estimateMillicents(
  event: Omit<UsageEvent, "millicents" | "uid" | "durationMs" | "status">,
): number {
  const r = rateFor(event.model);
  if (event.kind === "llm" || event.kind === "embed") {
    const inMc = (event.tokensIn ?? 0) * (r.inPer1M ?? 0) * 1000 / 1_000_000;
    const outMc = (event.tokensOut ?? 0) * (r.outPer1M ?? 0) * 1000 / 1_000_000;
    return Math.round(inMc + outMc);
  }
  if (event.kind === "tts") {
    return Math.round((event.characters ?? 0) * (r.perChar ?? 0));
  }
  if (event.kind === "stt") {
    // Audio bytes → seconds: assume 16kHz mono Int16 (32_000 bytes/sec)
    const seconds = (event.audioBytes ?? 0) / 32_000;
    const minutes = seconds / 60;
    return Math.round(minutes * (r.perMinute ?? 0) * 1000);
  }
  return 0;
}

// --------------------------------------------------------------------------
// Identify the caller from the Authorization header (best-effort)
// --------------------------------------------------------------------------

export async function uidFromRequest(request: Request): Promise<string | null> {
  if (!isAdminConfigured()) return null;
  const authz = request.headers.get("authorization");
  if (!authz?.startsWith("Bearer ")) return null;
  try {
    const decoded = await verifyIdToken(authz.slice(7));
    return decoded.uid;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Write the event to Firestore
// --------------------------------------------------------------------------

import crypto from "node:crypto";

async function getAccessToken(): Promise<string | null> {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) return null;
  // Reuse admin.ts's token? Easier to inline — small import surface, single concern.
  // (admin.ts caches its own token; this duplicates that cache. Acceptable for now.)
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

export async function logUsage(event: UsageEvent): Promise<void> {
  if (!isAdminConfigured()) return;
  const token = await getAccessToken();
  if (!token) return;
  const url = `https://firestore.googleapis.com/v1/projects/${getProjectId()}/databases/(default)/documents/usage_events`;
  const body = {
    fields: {
      uid: event.uid ? { stringValue: event.uid } : { nullValue: null },
      kind: { stringValue: event.kind },
      provider: { stringValue: event.provider },
      model: event.model ? { stringValue: event.model } : { nullValue: null },
      tokensIn: { integerValue: String(event.tokensIn ?? 0) },
      tokensOut: { integerValue: String(event.tokensOut ?? 0) },
      characters: { integerValue: String(event.characters ?? 0) },
      audioBytes: { integerValue: String(event.audioBytes ?? 0) },
      durationMs: { integerValue: String(event.durationMs) },
      millicents: { integerValue: String(event.millicents) },
      status: { integerValue: String(event.status) },
      createdAt: { timestampValue: new Date().toISOString() },
    },
  };
  try {
    await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Never block the API response on a logging failure.
  }
}

// Convenience: build + log in one call.
export async function meter(
  request: Request,
  fields: Omit<UsageEvent, "uid" | "millicents">,
): Promise<void> {
  const uid = await uidFromRequest(request);
  const millicents = estimateMillicents(fields);
  await logUsage({ ...fields, uid, millicents });
}
