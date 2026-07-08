/**
 * Rough per-call cost estimation for the usage log / admin dashboard.
 *
 * These are ESTIMATES from published list prices (USD per 1M tokens unless
 * noted), current as of July 2026. They exist so the admin dashboard can show
 * relative spend per user/provider — not to reconcile invoices. Keep the table
 * conservative and update it when providers reprice.
 */

type TokenRate = { inputPerM: number; outputPerM: number };

// Longest-prefix match against the model id.
const LLM_RATES: Array<{ prefix: string; rate: TokenRate }> = [
  // Anthropic
  { prefix: "claude-opus-4", rate: { inputPerM: 5.0, outputPerM: 25.0 } },
  { prefix: "claude-sonnet-5", rate: { inputPerM: 3.0, outputPerM: 15.0 } },
  { prefix: "claude-sonnet-4", rate: { inputPerM: 3.0, outputPerM: 15.0 } },
  { prefix: "claude-haiku-4-5", rate: { inputPerM: 1.0, outputPerM: 5.0 } },
  { prefix: "claude", rate: { inputPerM: 3.0, outputPerM: 15.0 } },
  // OpenAI
  { prefix: "gpt-4o-mini", rate: { inputPerM: 0.15, outputPerM: 0.6 } },
  { prefix: "gpt-4o", rate: { inputPerM: 2.5, outputPerM: 10.0 } },
  { prefix: "gpt-5-mini", rate: { inputPerM: 0.25, outputPerM: 2.0 } },
  { prefix: "gpt-5", rate: { inputPerM: 1.25, outputPerM: 10.0 } },
  { prefix: "gpt", rate: { inputPerM: 2.5, outputPerM: 10.0 } },
  { prefix: "o1", rate: { inputPerM: 15.0, outputPerM: 60.0 } },
  // Google
  { prefix: "gemini-2.5-flash-lite", rate: { inputPerM: 0.1, outputPerM: 0.4 } },
  { prefix: "gemini-2.5-flash", rate: { inputPerM: 0.3, outputPerM: 2.5 } },
  { prefix: "gemini-2.5-pro", rate: { inputPerM: 1.25, outputPerM: 10.0 } },
  { prefix: "gemini", rate: { inputPerM: 0.3, outputPerM: 2.5 } },
  // Embeddings (input only)
  { prefix: "text-embedding-3-small", rate: { inputPerM: 0.02, outputPerM: 0 } },
  { prefix: "text-embedding-3-large", rate: { inputPerM: 0.13, outputPerM: 0 } },
];

export function estimateLlmCostUsd(
  model: string | undefined,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): number | null {
  if (!model || (inputTokens == null && outputTokens == null)) return null;
  const hit = LLM_RATES.find((r) => model.startsWith(r.prefix));
  if (!hit) return null;
  const cost =
    ((inputTokens ?? 0) / 1_000_000) * hit.rate.inputPerM +
    ((outputTokens ?? 0) / 1_000_000) * hit.rate.outputPerM;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/**
 * ElevenLabs bills in subscription credits (~1 credit/char on Turbo/Flash).
 * Approximate USD using the Creator-tier effective rate (~$0.15 per 1k chars)
 * so relative TTS spend shows up in the dashboard.
 */
export function estimateTtsCostUsd(characters: number | undefined): number | null {
  if (characters == null) return null;
  return Math.round((characters / 1000) * 0.15 * 1_000_000) / 1_000_000;
}
