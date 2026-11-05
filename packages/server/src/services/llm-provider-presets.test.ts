import { describe, expect, it } from "vitest";
import { LLM_PROVIDER_PRESETS, presetById, resolvePresetBaseUrl } from "./llm-provider-presets.js";

describe("llm provider presets", () => {
  it("includes OpenAI, OpenRouter (Claude), OpenCode, Groq, and Custom", () => {
    expect(LLM_PROVIDER_PRESETS.map((p) => p.id)).toEqual(["openai", "openrouter", "opencode", "groq", "custom"]);
  });

  it("fixed presets ignore a supplied base URL; custom keeps it", () => {
    expect(resolvePresetBaseUrl("openai", "https://evil.example/v1")).toBe("https://api.openai.com/v1");
    expect(resolvePresetBaseUrl("openrouter", "")).toBe("https://openrouter.ai/api/v1");
    expect(resolvePresetBaseUrl("custom", "https://my.gateway/v1/")).toBe("https://my.gateway/v1");
  });

  it("unknown id falls back to custom", () => {
    expect(presetById("nope").id).toBe("custom");
  });
});
