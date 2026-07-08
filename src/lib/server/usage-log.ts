import { getRequestContext } from "./request-context";

export type UsageEvent = {
  fn?: string;
  provider: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  characters?: number;
  estCostUsd?: number | null;
  latencyMs?: number;
  ok: boolean;
  error?: string;
};

function serviceRoleConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

let warnedOnce = false;

/**
 * Fire-and-forget usage/cost logging. Never throws and never blocks the
 * request path — a failed insert only warns. Rows are written with the
 * service-role client (RLS has no INSERT policy for users by design).
 */
export function logUsage(event: UsageEvent): void {
  if (!serviceRoleConfigured()) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(
        "[usage-log] SUPABASE_SERVICE_ROLE_KEY not set — per-call usage logging disabled",
      );
    }
    return;
  }
  const ctx = getRequestContext();
  void (async () => {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { error } = await (supabaseAdmin.from("usage_log") as any).insert({
        user_id: ctx?.userId ?? null,
        fn: event.fn ?? ctx?.fnName ?? "unknown",
        provider: event.provider,
        model: event.model ?? null,
        input_tokens: event.inputTokens ?? null,
        output_tokens: event.outputTokens ?? null,
        characters: event.characters ?? null,
        est_cost_usd: event.estCostUsd ?? null,
        latency_ms: event.latencyMs ?? null,
        ok: event.ok,
        error: event.error ? event.error.slice(0, 500) : null,
      });
      if (error) console.warn("[usage-log] insert failed", error.message);
    } catch (e) {
      console.warn("[usage-log] insert exception", e);
    }
  })();
}
