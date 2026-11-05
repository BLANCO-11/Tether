/**
 * Per-flow chat configurability (Phase 5) — the config schema, its readers,
 * and the meta write path. Pure and unit-tested: nothing here needs a
 * database or a model.
 */
import { describe, expect, it } from "vitest";
import {
  chatConfigSchema,
  modelSubstitutionNote,
  parseChatConfig,
  resolveChatModel,
} from "./flow-chat-config.js";
import { updateFlowSchema } from "./flow.service.js";

describe("chatConfigSchema", () => {
  it("defaults an empty object to nobody-chose", () => {
    expect(chatConfigSchema.parse({})).toEqual({ model: null, instructions: null, suggestions: true });
  });

  it("rejects unknown keys rather than storing them", () => {
    expect(chatConfigSchema.safeParse({ model: "x", bogus: true }).success).toBe(false);
  });

  it("bounds the model name and the instructions length", () => {
    expect(chatConfigSchema.safeParse({ model: "" }).success).toBe(false);
    expect(chatConfigSchema.safeParse({ model: "x".repeat(129) }).success).toBe(false);
    expect(chatConfigSchema.safeParse({ instructions: "x".repeat(2001) }).success).toBe(false);
  });

  it("accepts a fully-set config", () => {
    expect(
      chatConfigSchema.parse({ model: "gpt-x", instructions: "call them reqs", suggestions: false }),
    ).toEqual({ model: "gpt-x", instructions: "call them reqs", suggestions: false });
  });
});

describe("parseChatConfig", () => {
  it("reads never-configured as null", () => {
    expect(parseChatConfig(null)).toBe(null);
    expect(parseChatConfig(undefined)).toBe(null);
  });

  it("parses a stored row, filling defaults", () => {
    expect(parseChatConfig({ model: "gpt-x" })).toEqual({
      model: "gpt-x",
      instructions: null,
      suggestions: true,
    });
  });

  it("treats an unparseable row as never-configured, never a crash", () => {
    expect(parseChatConfig({ model: 42 })).toBe(null);
    expect(parseChatConfig("gpt-x")).toBe(null);
    expect(parseChatConfig([{ model: "x" }])).toBe(null);
  });
});

describe("resolveChatModel", () => {
  const provider = (model: string, allowedModels: string[]) => ({ model, allowedModels });

  it("resolves no configured model to the default with no note", () => {
    expect(resolveChatModel(null, provider("gpt-default", ["gpt-default"]))).toEqual({
      model: undefined,
      substitution: null,
    });
  });

  it("passes an offered model through with no note", () => {
    expect(resolveChatModel("gpt-x", provider("gpt-default", ["gpt-default", "gpt-x"]))).toEqual({
      model: "gpt-x",
      substitution: null,
    });
  });

  it("passes the stored model through when the deployment names no restriction", () => {
    expect(resolveChatModel("gpt-x", provider("gpt-default", []))).toEqual({
      model: "gpt-x",
      substitution: null,
    });
  });

  it("substitutes the default with a visible line when the stored model is not offered", () => {
    const resolved = resolveChatModel("gpt-gone", provider("gpt-default", ["gpt-default"]));
    expect(resolved.model).toBe(undefined);
    expect(resolved.substitution).toContain("gpt-gone");
    expect(resolved.substitution).toContain("gpt-default");
  });

  it("names both models in the substitution line", () => {
    expect(modelSubstitutionNote("gpt-gone", "gpt-default")).toContain("gpt-gone");
    expect(modelSubstitutionNote("gpt-gone", "gpt-default")).toContain("gpt-default");
  });
});

describe("updateFlowSchema — the meta write path", () => {
  it("still refuses an empty body", () => {
    expect(updateFlowSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a name or description alone, as before", () => {
    expect(updateFlowSchema.safeParse({ name: "renamed" }).success).toBe(true);
    expect(updateFlowSchema.safeParse({ description: "reworded" }).success).toBe(true);
  });

  it("accepts a chat config alone, filling defaults", () => {
    const parsed = updateFlowSchema.safeParse({ chatConfig: { model: "gpt-x" } });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.chatConfig).toEqual({ model: "gpt-x", instructions: null, suggestions: true });
    }
  });

  it("accepts an explicit null chat config — clearing is something to update", () => {
    expect(updateFlowSchema.safeParse({ chatConfig: null }).success).toBe(true);
    expect(updateFlowSchema.safeParse({ designSelection: null }).success).toBe(true);
  });

  it("accepts a design scope alone", () => {
    expect(
      updateFlowSchema.safeParse({ designSelection: { toolRefs: ["mail_send"] } }).success,
    ).toBe(true);
  });

  it("rejects a scope that names nothing, as the seed path does", () => {
    expect(updateFlowSchema.safeParse({ designSelection: {} }).success).toBe(false);
  });
});

describe("withChatModel", () => {
  it("S8: no override returns the base chooser itself — zero behavior change", async () => {
    const { withChatModel } = await import("./flow-chat-config.js");
    const base = (async () => "raw") as never;
    expect(withChatModel(base, undefined)).toBe(base);
  });

  it("S8: an override forwards it as the chooser's fourth argument", async () => {
    const { withChatModel } = await import("./flow-chat-config.js");
    const seen: unknown[] = [];
    const base = (async (...args: unknown[]) => {
      seen.push(args);
      return "raw";
    }) as never;
    const bound = withChatModel(base, "gpt-cheap");
    await bound("p", { name: "n", schema: {} as never }, "chat:route");
    expect(seen).toEqual([["p", { name: "n", schema: {} }, "chat:route", "gpt-cheap"]]);
  });
});
