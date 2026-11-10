import { describe, expect, it } from "vitest";
import {
  LLM_PROVIDER_PRESETS,
  modelsListUrl,
  normalizeProviderId,
  presetById,
  resolvePresetBaseUrl,
} from "./llm-provider-presets.js";

describe("llm provider presets", () => {
  it("includes OpenCode Go, OpenCode Zen, OpenAI, OpenRouter (Claude), Groq, and Custom", () => {
    expect(LLM_PROVIDER_PRESETS.map((p) => p.id)).toEqual(["opencode_go", "opencode_zen", "openai", "openrouter", "groq", "custom"]);
  });

  it("fixed presets ignore a supplied base URL; custom keeps it", () => {
    expect(resolvePresetBaseUrl("openai", "https://evil.example/v1")).toBe("https://api.openai.com/v1");
    expect(resolvePresetBaseUrl("openrouter", "")).toBe("https://openrouter.ai/api/v1");
    expect(resolvePresetBaseUrl("custom", "https://my.gateway/v1/")).toBe("https://my.gateway/v1");
  });

  it("opencode_go and opencode_zen are not editable", () => {
    expect(resolvePresetBaseUrl("opencode_go", "https://evil.example/v1")).toBe("https://opencode.ai/inference/go/openai/v1");
    expect(resolvePresetBaseUrl("opencode_zen", "https://evil.example/v1")).toBe("https://opencode.ai/inference/openai/v1");
  });

  it("modelsListUrl uses the preset's models URL, else baseUrl + /models", () => {
    expect(modelsListUrl("opencode_go", "https://opencode.ai/inference/go/openai/v1")).toBe("https://opencode.ai/inference/go/v1/models");
    expect(modelsListUrl("opencode_zen", "https://opencode.ai/inference/openai/v1")).toBe("https://opencode.ai/inference/v1/models");
    expect(modelsListUrl("custom", "https://gw.example/v1/")).toBe("https://gw.example/v1/models");
    expect(modelsListUrl("openai", "https://api.openai.com/v1")).toBe("https://api.openai.com/v1/models");
  });

  it("normalizeProviderId trims, lower-cases, maps legacy opencode, and falls back to custom", () => {
    expect(normalizeProviderId("opencode")).toBe("opencode_zen");
    expect(normalizeProviderId("OPENCODE_GO")).toBe("opencode_go");
    expect(normalizeProviderId("nope")).toBe("custom");
    expect(normalizeProviderId(undefined)).toBe("custom");
  });

  it("unknown id falls back to custom", () => {
    expect(presetById("nope").id).toBe("custom");
  });
});
