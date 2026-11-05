/**
 * stepSchema is DERIVED from the registry — what this file pins.
 *
 * `flow.service.ts`'s `stepSchema` builds one member per kind: legacy members
 * take their new typed keys from `NODE_TYPES` (`legacyNewKeys`), `llm`/`http`
 * are the drafted shapes by import. This file asserts the three behaviours
 * that arrangement promises, per kind:
 *
 * 1. A spec-complete step (every registry property + every old required key)
 *    passes.
 * 2. A step missing a `required` property fails with an issue naming that
 *    property (zod field path, not a union blob).
 * 3. A step carrying an unknown property key is STRIPPED, not refused —
 *    documented tolerance, not a hole: stored history carries keys no member
 *    names, and refusing them would refuse history. (The accepted-and-ignored
 *    failure mode this tolerance could hide is what `generation-provider.ts`
 *    refuses by name on its own path.)
 *
 * It also pins the registry coverage mechanically: every property
 * `NODE_TYPES` declares on a member-bearing kind survives a storage
 * round-trip, except the documented skips below. A property added to the
 * registry without storage support fails here rather than stripping silently.
 *
 * Documented skips (each with its stage that reunites them):
 * - `code.contract`: lives in its own column (`contractJson`), never a step
 *   a step-field (the Stage-4 panel shape) while drafted storage holds an id
 *   string. The drafted member wins until Stage 4 unifies them.
 */
import { describe, it, expect } from "vitest";
import { NODE_TYPES, type PropertySpec, type StepKind } from "@foundry/flow-edit";
import { flowModelSchema, stepSchema } from "./flow.service.js";
import { validateModel } from "./flow-compiler.service.js";

const MEMBER_KINDS = [
  "tool",
  "datasource",
  "query",
  "transform",
  "code",
  "branch",
  "merge",
  "approval",
  "llm",
  "http",
] as const satisfies readonly StepKind[];

/** Old display-string keys each member still requires (the enforced shape). */
const BASE: Record<(typeof MEMBER_KINDS)[number], Record<string, unknown>> = {
  tool: { kind: "tool", id: "t1", ref: "demo.tool", paramsExpr: "[{}]" },
  datasource: { kind: "datasource", id: "d1", ref: "demo.db", paramsExpr: "[{}]" },
  query: { kind: "query", id: "q1", ref: "demo.op", paramsExpr: "[{}]" },
  transform: { kind: "transform", id: "t2", expr: "{{ 1 }}" },
  code: {
    kind: "code",
    id: "c1",
    code: "def run(payload):\n    return {}",
    inputExpr: "{}",
    outputKeys: ["result"],
  },
  branch: { kind: "branch", id: "b1", conditionExpr: "{{ true }}" },
  merge: { kind: "merge", id: "m1", sources: ["t1", "t2"] },
  approval: { kind: "approval", id: "a1", summaryExpr: '"ok?"' },
  llm: { kind: "llm", id: "l1" },
  http: { kind: "http", id: "h1" },
};

/** A plausible stored value per registry property kind. */
function sampleValue(kind: StepKind, spec: PropertySpec): unknown {
  // Drafted storage for llm/http holds id strings where the registry already
  // declares the Stage-4 step-field shape — omit until unified (see header).
  if ((kind === "llm" || kind === "http") && spec.kind === "step-field") return undefined;
  switch (spec.kind) {
    case "text":
    case "paragraph":
    case "model-picker":
      return "x";
    case "expression":
      return "{{ 1 }}";
    case "template":
      return "hi";
    case "number":
    case "integer":
      return spec.min ?? 0;
    case "toggle":
      return true;
    case "select":
      // An option-less select has no samplable value — except `operator`,
      // whose storage falls back to `BranchTest` (see `flow.service.ts`), so
      // the registry fallback is the honest sample.
      if (spec.options?.length) return spec.options[0].value;
      return spec.name === "operator" ? "field_eq" : undefined;
    case "step-field":
      return { from: "self" };
    case "step-list":
      return ["a", "b"];
    case "key-value-list":
      return [{ name: "n", value: "v" }];
    case "field-list":
      return [{ name: "f", type: "string" }];
    case "prompt-blocks":
      return [{ role: "user", text: "hi" }];
    case "group": {
      const out: Record<string, unknown> = {};
      for (const f of spec.fields ?? []) {
        const v = sampleValue(kind, f);
        if (v !== undefined) out[f.name] = v;
      }
      return out;
    }
    case "output-rows":
      throw new Error(`registry property "${spec.name}" is flow-level, never a step key`);
  }
}

/** A spec-complete step: old required keys + every samplable registry property. */
function specComplete(kind: (typeof MEMBER_KINDS)[number]): Record<string, unknown> {
  const step: Record<string, unknown> = { ...BASE[kind] };
  for (const prop of NODE_TYPES[kind].properties) {
    if (prop.name === "contract") continue;
    const v = sampleValue(kind, prop);
    if (v !== undefined) step[prop.name] = v;
  }
  return step;
}

function parseSteps(steps: Array<Record<string, unknown>>) {
  return flowModelSchema.safeParse({ id: "flow", steps });
}

describe("node-type-derived stepSchema", () => {
  it("has one member per storable kind: six legacy plus llm/http plus for_each/collect", () => {
    // Update this number deliberately when a kind is added — a member that
    // appears without a review of this file is how a kind stops validating.
    // Phase F (D-361) added `for_each` and `collect` — engine-only, settings and ids, no registry properties.
    expect(stepSchema.options.length).toBe(10);
  });

  it.each(MEMBER_KINDS)("a spec-complete %s step passes", (kind) => {
    const r = parseSteps([specComplete(kind)]);
    expect(r.success).toBe(true);
  });

  it.each(MEMBER_KINDS)("every registry property on %s survives storage", (kind) => {
    const r = parseSteps([specComplete(kind)]);
    expect(r.success).toBe(true);
    if (!r.success) return;
    const out = r.data.steps[0] as Record<string, unknown>;
    for (const prop of NODE_TYPES[kind].properties) {
      if (prop.name === "contract") continue;
      if (kind === "llm" && prop.name === "contextStepId") continue;
      expect(out, `registry property "${kind}.${prop.name}" stripped`).toHaveProperty(prop.name);
    }
  });
  it("keeps the branch test group nested, not flattened", () => {
    const r = parseSteps([{ ...BASE.branch, test: { left: { from: "self" }, operator: "field_eq" } }]);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.steps[0]).toHaveProperty("test.operator", "field_eq");
  });
  it("retains a client-written transform on a step source (Stage3C projection)", () => {
    // The registry's `Source` does not name it, but client writers store it —
    // stripping would lose the projection, refusing would refuse the step.
    const r = parseSteps([
      { ...BASE.tool, inputs: [{ name: "rows", source: { from: "step", stepId: "d1", field: "day", transform: "date" } }] },
    ]);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.steps[0]).toHaveProperty("inputs[0].source.transform", "date");
  });

  it.each([
    ["tool", "ref"],
    ["transform", "expr"],
    ["code", "outputKeys"],
    ["llm", "model"],
    ["http", "url"],
  ] as const)("a %s step missing required %s fails naming it", (kind, key) => {
    const step = specComplete(kind);
    delete step[key];
    const r = parseSteps([step]);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => i.path.includes(key))).toBe(true);
  });

  it("an approval with no question in EITHER form parses, and validateModel refuses it by name", () => {
    // Optional in storage since phase 3 step 4 (the typed `summary` replaced the
    // hand-written `summaryExpr`); the "a gate is not a button" rule moved to
    // validateModel, which reads both forms.
    const step = specComplete("approval");
    delete step["summaryExpr"];
    delete step["summary"];
    expect(parseSteps([step]).success).toBe(true);
    expect(() => validateModel({ id: "f", steps: [{ id: "a", kind: "transform", expr: "{{ 1 }}" }, { ...step, dependsOn: ["a"] }] } as never)).toThrow(/has no summary/);
  });

  it("a merge with one source fails the shape bound (validateModel names the step)", () => {
    const r = parseSteps([{ ...BASE.merge, sources: ["only"] }]);
    expect(r.success).toBe(false);
  });

  it("an unknown property key is stripped, not refused", () => {
    const r = parseSteps([{ ...BASE.tool, zzz_unknown: 1 }]);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.steps[0]).not.toHaveProperty("zzz_unknown");
  });
});
