/**
 * AI model catalog, grouped by provider.
 *
 * The Settings page lets the user pick a provider first (Gemini / Anthropic /
 * OpenAI), then a specific model for each tier (Fast = live suggestions +
 * predictions + expansion; Smart = summaries, drafts, event prep). Model ids
 * carry a provider prefix so the server's `resolveChatChain` routes them to the
 * right provider — and falls back to the others automatically if that provider
 * errors or is rate-limited.
 */

export type AiProviderId = "anthropic" | "gemini" | "openai";

export type AiModel = {
  /** Provider-prefixed id sent to the server (e.g. "anthropic/claude-haiku-5-5"). */
  id: string;
  label: string;
  hint: string;
};

export type AiProvider = {
  id: AiProviderId;
  label: string;
  /** One-line note shown under the provider buttons. */
  note: string;
  models: AiModel[];
  defaultFast: string;
  defaultSmart: string;
};

export const AI_PROVIDERS: AiProvider[] = [
  {
    id: "gemini",
    label: "Gemini",
    note: "Google — the default. If the free tier rate-limits, Parley auto-falls-back to Anthropic/OpenAI so suggestions keep working.",
    models: [
      {
        id: "gemini/gemini-3.5-flash-lite",
        label: "Gemini 3.5 Flash-Lite",
        hint: "Fastest · cheapest",
      },
      {
        id: "gemini/gemini-3.8-flash",
        label: "Gemini 3.8 Flash",
        hint: "Balanced · smart",
      },
      {
        id: "gemini/gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro (preview)",
        hint: "Smartest · needs paid tier",
      },
    ],
    defaultFast: "gemini/gemini-3.5-flash-lite",
    defaultSmart: "gemini/gemini-3.8-flash",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    note: "Claude. Paid key — most reliable/lowest-latency; pick this if the Gemini free tier rate-limits too often.",
    models: [
      {
        id: "anthropic/claude-haiku-5-5",
        label: "Claude Haiku 5.5",
        hint: "Fastest · cheapest",
      },
      {
        id: "anthropic/claude-sonnet-5-5",
        label: "Claude Sonnet 5.5",
        hint: "Balanced · smart",
      },
      {
        id: "anthropic/claude-opus-5-5",
        label: "Claude Opus 5.5",
        hint: "Most capable · slower",
      },
    ],
    defaultFast: "anthropic/claude-haiku-5-5",
    defaultSmart: "anthropic/claude-sonnet-5-5",
  },
  {
    id: "openai",
    label: "OpenAI",
    note: "GPT. Uses your OpenAI key.",
    models: [
      {
        id: "openai-direct/gpt-6-luna",
        label: "GPT-6 Luna",
        hint: "Fast · cheapest",
      },
      {
        id: "openai-direct/gpt-6.1-sol",
        label: "GPT-6.1 Sol",
        hint: "Balanced",
      },
      {
        id: "openai-direct/gpt-6-astra",
        label: "GPT-6 Astra",
        hint: "Most capable",
      },
    ],
    defaultFast: "openai-direct/gpt-6-luna",
    defaultSmart: "openai-direct/gpt-6.1-sol",
  },
];

/** Which provider a stored model id belongs to. Anthropic / OpenAI by explicit
 *  prefix; everything else (gemini/, legacy google/, unknown) → Gemini, the
 *  default provider — matching DEFAULT_SETTINGS, getSettings healing, and the
 *  auto-pick order, so an unrecognised id never shows the wrong provider. */
export function providerIdForModel(modelId: string | undefined): AiProviderId {
  if (modelId?.startsWith("anthropic/")) return "anthropic";
  if (modelId?.startsWith("openai-direct/") || modelId?.startsWith("openai/"))
    return "openai";
  return "gemini";
}

export function getProvider(id: AiProviderId): AiProvider {
  return AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[0];
}
