/**
 * Local-only catalogue of LLM models the user can pick in Settings → Voice
 * & Models. Adding a new model here makes it selectable; it's then forwarded
 * to the upstream provider via the per-tier override on `SettingsRecord`.
 *
 * Server-side proxies fall back to env-var defaults when no override is set
 * (`PARLEY_ANTHROPIC_FAST_MODEL`, etc.) so this list can be edited without
 * a deploy.
 */

export type ModelProviderId = "anthropic" | "openai";
export type ModelTier = "fast" | "smart";

export type ModelEntry = {
  id: string;
  label: string;
  provider: ModelProviderId;
  tier: ModelTier;
};

export const MODEL_OPTIONS: ModelEntry[] = [
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", provider: "anthropic", tier: "fast" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", provider: "anthropic", tier: "smart" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", provider: "anthropic", tier: "smart" },
  { id: "gpt-6-luna", label: "GPT-6 Luna", provider: "openai", tier: "fast" },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", provider: "openai", tier: "smart" },
];

export function modelsForProviderTier(provider: ModelProviderId, tier: ModelTier): ModelEntry[] {
  return MODEL_OPTIONS.filter((m) => m.provider === provider && m.tier === tier);
}
