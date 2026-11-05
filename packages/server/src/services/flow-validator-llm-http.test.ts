import { describe, expect, it } from "vitest";
import {
  checkHttpSteps,
  checkLlmModels,
  flowValidator,
  FlowValidationError,
} from "./flow-validator.service.js";
import type { FlowModel } from "./flow-compiler.service.js";

/**
 * The two Wave-1 save refusals (Stage 4): an `llm` step names a model the
 * deployment serves; an `http` step carries no credential and has a target.
 * Every refusal names the step; the secret's VALUE never appears in one.
 */

const SECRET = "sk-live-0123456789abcdefghij";

const llmStep = (over: Record<string, unknown> = {}) => ({
  id: "ask",
  kind: "llm",
  model: "test-model",
  tempPreset: "balanced",
  temperature: 0.7,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  promptBlocks: [{ role: "user", text: "hi" }],
  outputFields: [],
  memoryEnabled: false,
  visionDetail: "low",
  reasoningSeparated: false,
  ...over,
});

const httpStep = (over: Record<string, unknown> = {}) => ({
  id: "post",
  kind: "http",
  method: "POST",
  url: "https://hooks.example.test/shortlist",
  headers: [],
  queryParams: [],
  body: { kind: "none", content: "" },
  auth: { kind: "none" },
  sslVerify: true,
  ...over,
});

const model = (steps: Array<Record<string, unknown>>): FlowModel =>
  ({ id: "f", steps }) as unknown as FlowModel;

describe("checkLlmModels", () => {
  it("refuses an empty model, naming the step", () => {
    const findings = checkLlmModels(model([llmStep({ model: "" })]), ["test-model"]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("llm_missing_model");
    expect(findings[0]!.stepId).toBe("ask");
    expect(findings[0]!.message).toContain('"ask"');
  });

  it("refuses a model outside the deployment's set, naming the available ones", () => {
    const findings = checkLlmModels(model([llmStep({ model: "rogue-model" })]), ["test-model"]);
    expect(findings[0]!.rule).toBe("unknown_llm_model");
    expect(findings[0]!.message).toContain('"ask"');
    expect(findings[0]!.message).toContain("rogue-model");
    expect(findings[0]!.message).toContain("test-model");
  });

  it("refuses any model when none is configured, pointing at the AI model page", () => {
    const findings = checkLlmModels(model([llmStep()]), []);
    expect(findings[0]!.rule).toBe("llm_no_model_configured");
    expect(findings[0]!.message).toMatch(/AI model page/);
  });

  it("accepts a configured model", () => {
    expect(checkLlmModels(model([llmStep()]), ["test-model"])).toEqual([]);
  });
});

describe("checkHttpSteps", () => {
  it("refuses an empty url, naming the step", () => {
    const findings = checkHttpSteps(model([httpStep({ url: "" })]));
    expect(findings.some((f) => f.rule === "http_missing_url" && f.stepId === "post")).toBe(true);
  });

  it.each([
    ["headers[0].value", { headers: [{ name: "Authorization", value: SECRET }] }],
    ["body.content", { body: { kind: "raw", content: SECRET } }],
    ["auth.secretRef", { auth: { kind: "bearer", secretRef: SECRET } }],
  ])("refuses a literal token in %s, naming the field and never the value", (field, over) => {
    const findings = checkHttpSteps(model([httpStep(over)]));
    const hit = findings.find((f) => f.rule === "http_literal_secret");
    expect(hit, `no refusal for ${field}`).toBeDefined();
    expect(hit!.stepId).toBe("post");
    expect(hit!.message).toContain('"post"');
    expect(hit!.message).toContain(field);
    expect(hit!.message).not.toContain(SECRET);
  });

  it("an env-var name in auth.secretRef is not a secret", () => {
    const findings = checkHttpSteps(
      model([httpStep({ auth: { kind: "bearer", secretRef: "HOOKS_TOKEN" } })]),
    );
    expect(findings).toEqual([]);
  });
});

describe("assertValid runs both refusals on the save path", () => {
  it("throws for an unconfigured llm model even with no refs or interfaces", () => {
    expect(() => flowValidator.assertValid(model([llmStep()]), [], {}, [])).toThrow(
      FlowValidationError,
    );
  });

  it("a flow with neither kind still saves", () => {
    expect(() =>
      flowValidator.assertValid(
        model([{ id: "t", kind: "transform", expr: "{{ 1 }}" }]),
        [],
        {},
        [],
      ),
    ).not.toThrow();
  });
});
