/**
 * Registry coverage + change rows (workflow-ux Phase 6.2 + 6.3).
 *
 * The guarantee: a property a person can edit in the panel and chat cannot
 * name fails here. The test walks every `runtime !== null` kind in
 * `NODE_TYPES`, generates a conforming value per `PropertyKind` (groups
 * recurse), applies `{ op: "set_property" }` through `applyOp`, and requires
 * `ok` — so renaming a registry property without `set_property` accepting it
 * breaks CI, as does adding a kind the generator cannot satisfy.
 *
 * `describeOpRows` is pinned beside it: the transcript's `label old → new`
 * detail under each `describeOp` sentence, in the panel's words.
 */
import { describe, expect, it } from "vitest";
import {
  applyOp,
  BRANCH_TESTS,
  describeOpRows,
  NODE_TYPES,
  STEP_KINDS,
  type ApplyResult,
  type AuthoredFlow,
  type FlowEditOp,
  type PropertySpec,
} from "./index.js";

/** One step per runnable kind — minimal records, no catalogue needed. */
const flow: AuthoredFlow = {
  id: "coverage",
  steps: [
    { kind: "datasource", id: "t_ds", ref: "q.ds", paramsExpr: "[{}]" },
    { kind: "query", id: "t_q", ref: "q.q", paramsExpr: "[{}]" },
    { kind: "tool", id: "t_tool", ref: "q.tool", paramsExpr: "[{}]", dependsOn: ["t_ds"] },
    { kind: "transform", id: "t_x", expr: "{{ 1 }}", dependsOn: ["t_q"] },
    {
      kind: "code",
      id: "t_code",
      inputExpr: "{{ 1 }}",
      contract: {
        purpose: "coverage",
        input: [{ name: "rows", type: "array" }],
        output: [{ name: "ranked", type: "array" }],
      },
      dependsOn: ["t_tool"],
    },
    { kind: "approval", id: "t_ask", summaryExpr: '"why?"', dependsOn: ["t_code"] },
    { kind: "branch", id: "t_guard", conditionExpr: "{{ 1 }}", dependsOn: ["t_tool"] },
    { kind: "merge", id: "t_m", sources: ["t_tool"], dependsOn: ["t_tool"] },
    {
      kind: "llm",
      id: "t_judge",
      model: "coverage-model",
      tempPreset: "balanced",
      temperature: 0.7,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      promptBlocks: [{ role: "user", text: "coverage" }],
      outputFields: [],
      memoryEnabled: false,
      visionDetail: "low",
      reasoningSeparated: false,
      dependsOn: ["t_tool"],
    },
    {
      kind: "http",
      id: "t_post",
      method: "POST",
      url: "https://example.internal/coverage",
      headers: [],
      queryParams: [],
      body: { kind: "none", content: "" },
      auth: { kind: "none" },
      sslVerify: true,
      dependsOn: ["t_judge"],
    },
  ],
};

function stepFor(kind: string): string {
  const step = flow.steps.find((s) => s.kind === kind);
  if (!step) throw new Error(`coverage flow has no ${kind} step`);
  return step.id;
}

/** First value satisfying every numeric bound — deterministic, no guessing. */
function pickNumber(spec: PropertySpec): number {
  const candidates = [spec.min, spec.max, 0, 1, 0.5, 60, 100, 1000];
  for (const candidate of candidates) {
    if (candidate === undefined || !Number.isFinite(candidate)) continue;
    if (spec.kind === "integer" && !Number.isInteger(candidate)) continue;
    if (spec.min !== undefined && candidate < spec.min) continue;
    if (spec.max !== undefined && candidate > spec.max) continue;
    return candidate;
  }
  throw new Error(`no conforming number for ${spec.name}`);
}

/**
 * A value `applySetProperty` accepts for one property spec. Transform rows
 * carry the rows editor's real shape — `{ name, type, source }`, the panel's
 * `{name, source}` / `{name, type, source}` plus the contract `type` the
 * array validation requires, which the panel ignores when reading back.
 */
function conformingValue(spec: PropertySpec): unknown {
  switch (spec.kind) {
    case "text":
    case "paragraph":
    case "expression":
    case "template":
      return spec.name === "url" ? "https://example.internal/coverage" : "coverage";
    case "number":
    case "integer":
      return pickNumber(spec);
    case "toggle":
      return spec.fallback !== true;
    case "select": {
      const first = spec.options?.[0];
      if (first) return first.value;
      // An option-less select speaks `BranchTest` (branch `test.operator`).
      const test = BRANCH_TESTS[0];
      return test ? test.test : "field_eq";
    }
    case "model-picker":
      return "coverage-model";
    case "step-field":
      // A `Source` exercises `checkSource`; `null` would pass trivially.
      return { from: "step", stepId: "t_ds", field: "body" };
    case "step-list":
      return [flow.steps[0]!.id];
    case "key-value-list":
      return [{ name: "x-coverage", value: "1" }];
    case "field-list":
      return spec.name === "inputBindings" || spec.name === "outputColumns"
        ? [{ name: "coverage_field", type: "string", source: { kind: "fixed", value: "1" } }]
        : [{ name: "coverage_field", type: "string" }];
    case "prompt-blocks":
      return [{ role: "user", text: "coverage" }];
    case "output-rows":
      // Flow-level, never a step key (`applySetProperty` refuses it by
      // design) — covered through `set_output_rows` below, not here.
      throw new Error(`step property ${spec.name} must not use kind "output-rows"`);
    case "group": {
      const obj: Record<string, unknown> = {};
      for (const field of spec.fields ?? []) obj[field.name] = conformingValue(field);
      return obj;
    }
  }
}

function mustOk(result: ApplyResult, what: string): AuthoredFlow {
  if (!result.ok) throw new Error(`expected ok for ${what}, got: ${result.error}`);
  return result.flow;
}

describe("registry coverage — chat can set what the panel can set", () => {
  it("every property of every runnable kind accepts a conforming set_property", () => {
    // Engine-only kinds (for each, D-361) are set by engine ops, never by `set_property`, and declare no properties.
    const kinds = STEP_KINDS.filter((k) => NODE_TYPES[k].runtime !== null && !NODE_TYPES[k].engineOnly);
    expect(kinds.length).toBeGreaterThan(0);
    let count = 0;
    for (const kind of kinds) {
      const stepId = stepFor(kind);
      for (const spec of NODE_TYPES[kind].properties) {
        const value = conformingValue(spec);
        const result = applyOp(flow, { op: "set_property", stepId, property: spec.name, value });
        expect(result.ok, `${kind}.${spec.name} refused a conforming value`).toBe(true);
        count += 1;
      }
    }
    expect(count).toBeGreaterThan(0);
  });

  it("transform rows persist beside the text through set_property", () => {
    const bindings = [{ name: "rows", type: "array", source: { kind: "fixed", value: "[]" } }];
    const columns = [
      { name: "total", type: "number", source: { kind: "step", stepId: "t_q", field: "body" } },
    ];
    const afterBindings = mustOk(
      applyOp(flow, { op: "set_property", stepId: "t_x", property: "inputBindings", value: bindings }),
      "transform.inputBindings",
    );
    expect(afterBindings.steps.find((s) => s.id === "t_x")).toMatchObject({
      inputBindings: bindings,
      expr: "{{ 1 }}",
    });
    const afterColumns = mustOk(
      applyOp(flow, { op: "set_property", stepId: "t_x", property: "outputColumns", value: columns }),
      "transform.outputColumns",
    );
    expect(afterColumns.steps.find((s) => s.id === "t_x")).toMatchObject({
      outputColumns: columns,
      expr: "{{ 1 }}",
    });
  });

  it("no step property uses the flow-level output-rows kind", () => {
    for (const kind of STEP_KINDS) {
      for (const spec of NODE_TYPES[kind].properties) {
        expect(spec.kind, `${kind}.${spec.name}`).not.toBe("output-rows");
      }
    }
  });

  it("output rows go through set_output_rows, the flow-level op", () => {
    const result = applyOp(flow, {
      op: "set_output_rows",
      rows: [
        { name: "shortlist", type: "array[object]", source: { from: "step", stepId: "t_tool", field: "body" } },
        { name: "period", type: "string", source: { from: "input", inputId: "period" } },
      ],
    });
    expect(mustOk(result, "set_output_rows").output?.rows).toHaveLength(2);
  });
});

describe("describeOpRows — one label old → new row per changed value", () => {
  const judge: AuthoredFlow = {
    id: "rows",
    steps: [
      { kind: "datasource", id: "t_ds", ref: "q.ds", paramsExpr: "[{}]" },
      {
        kind: "llm",
        id: "t_judge",
        model: "coverage-model",
        tempPreset: "balanced",
        temperature: 0,
        topP: 1,
        frequencyPenalty: 0,
        presencePenalty: 0,
        promptBlocks: [{ role: "user", text: "coverage" }],
        outputFields: [],
        memoryEnabled: false,
        visionDetail: "low",
        reasoningSeparated: false,
        dependsOn: ["t_ds"],
      },
      { kind: "approval", id: "t_ask", summaryExpr: '"why?"', context: null, dependsOn: ["t_judge"] },
      {
        kind: "code",
        id: "t_code",
        inputExpr: "{{ 1 }}",
        contract: {
          purpose: "coverage",
          input: [{ name: "rows", type: "array" }],
          output: [{ name: "ranked", type: "array" }],
        },
        dependsOn: ["t_ds"],
      },
    ],
  };

  function applied(before: AuthoredFlow, op: FlowEditOp): AuthoredFlow {
    return mustOk(applyOp(before, op), JSON.stringify(op));
  }

  it("renders a scalar property change with the panel label", () => {
    const op: FlowEditOp = { op: "set_property", stepId: "t_judge", property: "temperature", value: 0.3 };
    expect(describeOpRows(judge, applied(judge, op), op)).toEqual([
      { label: "Temperature", from: "0", to: "0.3" },
    ]);
  });

  it("renders a step-field change as from <step>.<field>", () => {
    const op: FlowEditOp = {
      op: "set_property",
      stepId: "t_ask",
      property: "context",
      value: { from: "step", stepId: "t_ds", field: "body" },
    };
    expect(describeOpRows(judge, applied(judge, op), op)).toEqual([
      { label: "Evidence", from: "not set", to: "from t_ds.body" },
    ]);
  });

  it("renders a run-input source in words", () => {
    const op: FlowEditOp = {
      op: "set_property",
      stepId: "t_ask",
      property: "context",
      value: { from: "input", inputId: "period" },
    };
    expect(describeOpRows(judge, applied(judge, op), op)).toEqual([
      { label: "Evidence", from: "not set", to: "from run input period" },
    ]);
  });

  it("renders a list property as named rows", () => {
    const op: FlowEditOp = {
      op: "set_property",
      stepId: "t_judge",
      property: "outputFields",
      value: [{ name: "summary", type: "string" }],
    };
    expect(describeOpRows(judge, applied(judge, op), op)).toEqual([
      { label: "Structured output", from: "none", to: "summary (string)" },
    ]);
  });

  it("renders a binding change against the stored feed", () => {
    const bound: AuthoredFlow = {
      ...judge,
      steps: judge.steps.map((s) =>
        s.id === "t_code" ? { ...s, inputs: [{ name: "rows", source: null }] } : s,
      ),
    };
    const op: FlowEditOp = {
      op: "set_binding",
      stepId: "t_code",
      name: "rows",
      source: { from: "step", stepId: "t_ds", field: "body" },
    };
    expect(describeOpRows(bound, applied(bound, op), op)).toEqual([
      { label: "rows", from: "not set", to: "from t_ds.body" },
    ]);
  });
  it("reads a blank-text tool input as not set, never unknown", () => {
    const fresh: AuthoredFlow = {
      id: "rows",
      steps: [
        { kind: "datasource", id: "t_ds", ref: "q.ds", paramsExpr: "[{}]" },
        { kind: "tool", id: "t_tool", ref: "q.tool", paramsExpr: "[{}]" },
      ],
    };
    const op: FlowEditOp = {
      op: "set_binding",
      stepId: "t_tool",
      name: "rows",
      source: { from: "step", stepId: "t_ds", field: "body" },
    };
    const after = applied(fresh, op);
    expect(describeOpRows(fresh, after, op)).toEqual([
      { label: "rows", from: "not set", to: "from t_ds.body" },
    ]);
    // …and unbinding reads back the same way, in reverse.
    const unbind: FlowEditOp = { op: "set_binding", stepId: "t_tool", name: "rows", source: null };
    expect(describeOpRows(after, applied(after, unbind), unbind)).toEqual([
      { label: "rows", from: "from t_ds.body", to: "not set" },
    ]);
  });

  it("reads an unstored code input as set in the expression, never not set", () => {
    const op: FlowEditOp = {
      op: "set_binding",
      stepId: "t_code",
      name: "rows",
      source: { from: "step", stepId: "t_ds", field: "body" },
    };
    expect(describeOpRows(judge, applied(judge, op), op)).toEqual([
      { label: "rows", from: "set in the expression", to: "from t_ds.body" },
    ]);
  });

  it("renders transform rows with their feed in words", () => {
    const before: AuthoredFlow = {
      id: "rows",
      steps: [{ kind: "transform", id: "t_x", expr: "{{ 1 }}" }],
    };
    const op: FlowEditOp = {
      op: "set_property",
      stepId: "t_x",
      property: "outputColumns",
      value: [{ name: "total", type: "number", source: { kind: "step", stepId: "t_q", field: "body" } }],
    };
    expect(describeOpRows(before, applied(before, op), op)).toEqual([
      { label: "Output columns", from: "not set", to: "total: from t_q.body" },
    ]);
  });

  it("is empty for structural ops, missing steps, and no-change turns", () => {
    const op: FlowEditOp = { op: "set_property", stepId: "t_judge", property: "temperature", value: 0.3 };
    const after = applied(judge, op);
    expect(describeOpRows(judge, after, { op: "connect", from: "t_ds", to: "t_judge" })).toEqual([]);
    expect(describeOpRows(judge, after, { op: "remove_step", stepId: "t_ds" })).toEqual([]);
    expect(
      describeOpRows(judge, after, { op: "set_property", stepId: "nope", property: "temperature", value: 1 }),
    ).toEqual([]);
    expect(describeOpRows(after, after, op)).toEqual([]);
  });
});
