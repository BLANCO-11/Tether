import { describe, expect, it } from "vitest";
import { prettyModelName } from "@/lib/model-names";

describe("prettyModelName", () => {
  it("names families and versions", () => {
    expect(prettyModelName("gpt-6-luna")).toBe("GPT-6 Luna");
    expect(prettyModelName("gpt-5.6-luna")).toBe("GPT-5.6 Luna");
    expect(prettyModelName("DeepSeek-V4-Flash-0731")).toBe("DeepSeek V4 Flash");
    expect(prettyModelName("RadixArk/Qwen3.8-27B-NVFP4")).toBe("Qwen3.8 27B");
    expect(prettyModelName("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(prettyModelName("glm-4.6")).toBe("GLM-4.6");
    expect(prettyModelName("gpt-4o-mini")).toBe("GPT-4o Mini");
  });

  it("strips date stamps and quantisation tags", () => {
    expect(prettyModelName("claude-opus-5-5-20260101")).toBe("Claude Opus 5.5");
    expect(prettyModelName("litellm/gpt-6-luna-fp8")).toBe("GPT-6 Luna");
    expect(prettyModelName("Llama-3.1-8B-Instruct-AWQ")).toBe("Llama 3.1 8B Instruct");
    expect(prettyModelName("some_model_GGUF")).toBe("Some Model");
    expect(prettyModelName("model-20250514")).toBe("Model");
  });

  it("never throws and always returns a non-empty string for odd input", () => {
    for (const id of ["", "   ", "/", "---", "0731"]) {
      const out = prettyModelName(id);
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThan(0);
    }
  });
});
