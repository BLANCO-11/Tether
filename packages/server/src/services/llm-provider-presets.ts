/**
 * OpenAI-compatible provider presets for personal BYOK (AI models page).
 * Native Anthropic Messages is out of scope — Claude is reached via OpenRouter.
 */

export type LlmProviderPresetId = "openai" | "openrouter" | "opencode" | "groq" | "custom";

export type LlmProviderPreset = {
  id: LlmProviderPresetId;
  label: string;
  /** Filled into the form; empty for custom. */
  baseUrl: string;
  /** Whether the user may edit baseUrl. */
  baseUrlEditable: boolean;
  keyHint: string;
  blurb: string;
};

export const LLM_PROVIDER_PRESETS: readonly LlmProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    baseUrlEditable: false,
    keyHint: "sk-… from platform.openai.com",
    blurb: "GPT models via OpenAI’s API.",
  },
  {
    id: "openrouter",
    label: "Claude and more (OpenRouter)",
    baseUrl: "https://openrouter.ai/api/v1",
    baseUrlEditable: false,
    keyHint: "sk-or-… from openrouter.ai",
    blurb: "Use this for Anthropic/Claude models, plus many others, with one key.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    baseUrl: "https://opencode.ai/zen/v1",
    baseUrlEditable: true,
    keyHint: "OpenCode / Zen API key",
    blurb: "OpenCode Zen gateway. Edit the URL if your deployment differs.",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    baseUrlEditable: false,
    keyHint: "gsk_… from console.groq.com",
    blurb: "Fast open models on Groq.",
  },
  {
    id: "custom",
    label: "Custom gateway",
    baseUrl: "",
    baseUrlEditable: true,
    keyHint: "API key for your OpenAI-compatible gateway",
    blurb: "Any OpenAI-compatible /v1 host (LiteLLM, Azure OpenAI proxy, local, …).",
  },
] as const;

export function presetById(id: string | null | undefined): LlmProviderPreset {
  return LLM_PROVIDER_PRESETS.find((p) => p.id === id) ?? LLM_PROVIDER_PRESETS[LLM_PROVIDER_PRESETS.length - 1]!;
}

/** Resolve the base URL to store: preset fills fixed URLs; custom/editable keep the supplied one. */
export function resolvePresetBaseUrl(providerId: string, suppliedBaseUrl: string): string {
  const preset = presetById(providerId);
  if (!preset.baseUrlEditable && preset.baseUrl) return preset.baseUrl.replace(/\/+$/, "");
  return suppliedBaseUrl.trim().replace(/\/+$/, "");
}
