/**
 * OpenAI-compatible provider presets for personal BYOK (AI models page).
 * Includes OpenCode Go and OpenCode Zen (fixed URLs, not editable).
 * Native Anthropic Messages is out of scope — Claude is reached via OpenRouter.
 */

export type LlmProviderPresetId = "opencode_go" | "opencode_zen" | "openai" | "openrouter" | "groq" | "custom";

export type LlmProviderPreset = {
  id: LlmProviderPresetId;
  label: string;
  /** Filled into the form; empty for custom. */
  baseUrl: string;
  /** Absolute models-list URL when it is not `${baseUrl}/models`. */
  modelsUrl?: string;
  /** Whether the user may edit baseUrl. */
  baseUrlEditable: boolean;
  keyHint: string;
  blurb: string;
};

export const LLM_PROVIDER_PRESETS: readonly LlmProviderPreset[] = [
  {
    id: "opencode_go",
    label: "OpenCode Go",
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
    modelsUrl: "https://opencode.ai/inference/go/v1/models",
    baseUrlEditable: false,
    keyHint: "OpenCode API key (Go subscription)",
    blurb: "Models included in your OpenCode Go subscription.",
  },
  {
    id: "opencode_zen",
    label: "OpenCode Zen",
    baseUrl: "https://opencode.ai/inference/openai/v1",
    modelsUrl: "https://opencode.ai/inference/v1/models",
    baseUrlEditable: false,
    keyHint: "OpenCode API key",
    blurb: "OpenCode Zen pay-as-you-go gateway.",
  },
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

/** Trim + lower-case a provider id. The legacy "opencode" maps to opencode_zen; unknown ids map to custom. */
export function normalizeProviderId(id: string | null | undefined): LlmProviderPresetId {
  const v = (id ?? "").trim().toLowerCase();
  if (v === "opencode") return "opencode_zen";
  const hit = LLM_PROVIDER_PRESETS.find((p) => p.id === v);
  return hit ? hit.id : "custom";
}

export function presetById(id: string | null | undefined): LlmProviderPreset {
  return LLM_PROVIDER_PRESETS.find((p) => p.id === normalizeProviderId(id)) ?? LLM_PROVIDER_PRESETS[LLM_PROVIDER_PRESETS.length - 1]!;
}

/** Resolve the base URL to store: preset fills fixed URLs; custom/editable keep the supplied one. */
export function resolvePresetBaseUrl(providerId: string, suppliedBaseUrl: string): string {
  const preset = presetById(providerId);
  if (!preset.baseUrlEditable && preset.baseUrl) return preset.baseUrl.replace(/\/+$/, "");
  return suppliedBaseUrl.trim().replace(/\/+$/, "");
}

/** The models-list URL for a provider: the preset's absolute modelsUrl when set, else `${baseUrl}/models`. */
export function modelsListUrl(providerId: string | null | undefined, baseUrl: string): string {
  const preset = presetById(providerId);
  if (preset.modelsUrl) return preset.modelsUrl;
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}
