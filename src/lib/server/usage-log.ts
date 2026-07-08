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

function serverFirebaseConfigured(): boolean {
  return Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_B64);
}

let warnedOnce = false;

/**
 * Fire-and-forget usage/cost logging. Never throws and never blocks the
 * request path — a failed write only warns. Rows are written with the Firebase
 * Admin SDK (Firestore rules deny client writes to `usage_log` by design).
 */
export function logUsage(event: UsageEvent): void {
  if (!serverFirebaseConfigured()) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(
        "[usage-log] FIREBASE_SERVICE_ACCOUNT_B64 not set — per-call usage logging disabled",
      );
    }
    return;
  }
  const ctx = getRequestContext();
  void (async () => {
    try {
      const { adminDb } = await import("@/integrations/firebase/admin");
      const { FieldValue } = await import("firebase-admin/firestore");
      await adminDb()
        .collection("usage_log")
        .add({
          userId: ctx?.userId ?? null,
          fn: event.fn ?? ctx?.fnName ?? "unknown",
          provider: event.provider,
          model: event.model ?? null,
          inputTokens: event.inputTokens ?? null,
          outputTokens: event.outputTokens ?? null,
          characters: event.characters ?? null,
          estCostUsd: event.estCostUsd ?? null,
          latencyMs: event.latencyMs ?? null,
          ok: event.ok,
          error: event.error ? event.error.slice(0, 500) : null,
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (e) {
      console.warn("[usage-log] write exception", e);
    }
  })();
}
