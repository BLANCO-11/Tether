import { describe, expect, it } from "vitest";
import { parseParams } from "./flow-params";
import { buildCodeInput, buildFanOutParams, buildSingleParams, type OutputShapes, type Source } from "./flow-expr";
import { EXPRESSION_REFUSAL, setBinding, setCodeInputSource, setInputSource, setOverStep, toSimpleBindings } from "./step-binding";
import { stepIo } from "./step-io";
import type { AuthoredFlow, AuthoredStep } from "./flow-authoring";

/**
 * The writer behind the input rows: one edit in, every other binding byte
 * back out. Each assertion re-parses the emitted expression, so a passing
 * test means the expression — not an in-memory map — still carries the
 * untouched bindings.
 */

const SHAPES: OutputShapes = {
  datasource: { template: "json(outputs.<id>.body)", describes: null, caution: null },
  query: { template: "json(outputs.<id>.body)", describes: null, caution: null },
  tool: { template: "json(outputs.<id>.body)", describes: null, caution: null },
  merge: { template: "json(outputs.<id>.value)", describes: null, caution: null },
  transform: { template: "json(outputs.<id>.value)", describes: null, caution: null },
  code: { template: "outputs.<id>.vars.result", describes: null, caution: null },
  approval: { template: null, describes: null, caution: null },
  branch: { template: null, describes: null, caution: null },
};

const CATALOGUE = {
  entries: [
    {
      ref: "mail_send",
      params: [
        { name: "to_email" },
        { name: "subject" },
        { name: "body" },
        { name: "cc" },
      ],
    },
  ],
  outputs: SHAPES,
};

const READ: AuthoredStep = { kind: "datasource", id: "read", ref: "hr.attendance", paramsExpr: "[{}]" };
const OTHER: AuthoredStep = { kind: "datasource", id: "other", ref: "hr.attendance", paramsExpr: "[{}]" };

/** A tool fanned out over `read` with four mappings — the destructive-rebuild fixture. */
function fourMappingStep(): AuthoredStep {
  return {
    kind: "tool",
    id: "send",
    ref: "mail_send",
    paramsExpr: buildFanOutParams(SHAPES, READ, [
      { param: "to_email", source: { from: "step", stepId: "read", field: "contact_email" } },
      { param: "subject", source: { from: "literal", value: "hello" } },
      { param: "body", source: { from: "input", inputId: "period" } },
      { param: "cc", source: { from: "self" } },
    ])!,
    dependsOn: ["read"],
  };
}

function flowWith(step: AuthoredStep): AuthoredFlow {
  return { id: "f", inputs: [], steps: [READ, OTHER, step] } as AuthoredFlow;
}

describe("setInputSource", () => {
  it("changing one mapping preserves the other three byte-for-byte", () => {
    const before = fourMappingStep();
    const flow = flowWith(before);
    const r = setInputSource(flow.steps[2]!, CATALOGUE, flow, "subject", {
      from: "literal",
      value: "changed",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = parseParams(SHAPES, flow.steps, (r.step as { paramsExpr: string }).paramsExpr)!;
    expect(after).not.toBeNull();
    expect(after.overStepId).toBe("read");
    const byParam = new Map(after.mappings.map((m) => [m.param, m.source]));
    expect(byParam.get("subject")).toEqual({ from: "literal", value: "changed" });
    // The regression: the other three come back exactly as parsed before.
    const expected = parseParams(SHAPES, flow.steps, (before as { paramsExpr: string }).paramsExpr)!;
    for (const name of ["to_email", "body", "cc"]) {
      expect(byParam.get(name)).toEqual(expected.mappings.find((m) => m.param === name)!.source);
    }
    expect(after.mappings).toHaveLength(4);
  });

  it("removing a mapping keeps the rest and the fan-out", () => {
    const flow = flowWith(fourMappingStep());
    const r = setInputSource(flow.steps[2]!, CATALOGUE, flow, "cc", null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = parseParams(SHAPES, flow.steps, (r.step as { paramsExpr: string }).paramsExpr)!;
    expect(after.mappings.map((m) => m.param).sort()).toEqual(["body", "subject", "to_email"]);
    expect(after.overStepId).toBe("read");
  });

  it("a blank expression with no over step emits the single-call form", () => {
    const step: AuthoredStep = { kind: "tool", id: "send", ref: "mail_send", paramsExpr: "[{}]" };
    const flow: AuthoredFlow = { id: "f", inputs: [], steps: [READ, step] } as AuthoredFlow;
    const r = setInputSource(step, CATALOGUE, flow, "subject", { from: "literal", value: "hi" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.step as { paramsExpr: string }).paramsExpr).toBe(
      buildSingleParams([{ param: "subject", source: { from: "literal", value: "hi" } }]),
    );
  });

  it("a blank expression with a head dependency fans out over it", () => {
    const step: AuthoredStep = {
      kind: "tool",
      id: "send",
      ref: "mail_send",
      paramsExpr: "  ",
      dependsOn: ["read"],
    };
    const flow: AuthoredFlow = { id: "f", inputs: [], steps: [READ, step] } as AuthoredFlow;
    const r = setInputSource(step, CATALOGUE, flow, "subject", { from: "literal", value: "hi" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.step as { paramsExpr: string }).paramsExpr).toBe(
      buildFanOutParams(SHAPES, READ, [{ param: "subject", source: { from: "literal", value: "hi" } }]),
    );
  });

  it("refuses an unparseable expression and leaves it untouched", () => {
    const step: AuthoredStep = {
      kind: "tool",
      id: "send",
      ref: "mail_send",
      paramsExpr: "{{ a_custom_thing }}",
      dependsOn: ["read"],
    };
    const flow = flowWith(step);
    const r = setInputSource(step, CATALOGUE, flow, "subject", { from: "literal", value: "hi" });
    expect(r).toEqual({ ok: false, error: EXPRESSION_REFUSAL });
    expect(step.paramsExpr).toBe("{{ a_custom_thing }}");
  });

  it("refuses an unreadable row filter even though the mappings parse", () => {
    const base = buildFanOutParams(SHAPES, READ, [
      { param: "subject", source: { from: "literal", value: "hi" } },
    ])!;
    const filtered = base.replace("[.[] | {", "[.[] | select(.wit > wat) | {");
    const step: AuthoredStep = { kind: "tool", id: "send", ref: "mail_send", paramsExpr: filtered, dependsOn: ["read"] };
    const flow = flowWith(step);
    expect(parseParams(SHAPES, flow.steps, filtered)?.filterUnreadable).toBe(true);
    const r = setInputSource(step, CATALOGUE, flow, "subject", { from: "literal", value: "changed" });
    expect(r).toEqual({ ok: false, error: EXPRESSION_REFUSAL });
    expect(step.paramsExpr).toBe(filtered);
  });
  it("refuses a parseable expression with skipped pairs a rebuild would drop", () => {
    const base = buildFanOutParams(SHAPES, READ, [
      { param: "subject", source: { from: "literal", value: "hi" } },
    ])!;
    const lossy = base.replace('{"subject": "hi"}', '{"subject": "hi", "tag": custom(.x)}');
    const step: AuthoredStep = { kind: "tool", id: "send", ref: "mail_send", paramsExpr: lossy, dependsOn: ["read"] };
    const flow = flowWith(step);
    expect(parseParams(SHAPES, flow.steps, lossy)?.skipped).toEqual(["tag"]);
    const r = setInputSource(step, CATALOGUE, flow, "subject", { from: "literal", value: "changed" });
    expect(r).toEqual({ ok: false, error: EXPRESSION_REFUSAL });
    expect(step.paramsExpr).toBe(lossy);
  });

  it("refuses when the over step has no rows shape instead of rebuilding blank", () => {
    const shapes = { ...SHAPES, datasource: { template: null, describes: null, caution: null } };
    const flow = flowWith(fourMappingStep());
    const r = setInputSource(flow.steps[2]!, { ...CATALOGUE, outputs: shapes }, flow, "subject", {
      from: "literal",
      value: "hi",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe(EXPRESSION_REFUSAL);
    expect((flow.steps[2] as { paramsExpr: string }).paramsExpr).toContain("[.[]");
  });

  it("carries the row filter across a mapping edit", () => {
    const predicated = buildFanOutParams(
      SHAPES,
      READ,
      [{ param: "subject", source: { from: "literal", value: "hi" } }],
      { test: "field_gt", field: "", value: "5" },
    )!;
    const step: AuthoredStep = {
      kind: "tool",
      id: "send",
      ref: "mail_send",
      paramsExpr: predicated,
      dependsOn: ["read"],
    };
    const flow = flowWith(step);
    const r = setInputSource(step, CATALOGUE, flow, "subject", { from: "literal", value: "changed" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = parseParams(SHAPES, flow.steps, (r.step as { paramsExpr: string }).paramsExpr)!;
    expect(after.predicate).toMatchObject({ test: "field_gt", value: "5" });
    expect(after.overStepId).toBe("read");
  });
});

describe("setOverStep", () => {
  it("moves the mappings and the filter onto the new over step", () => {
    const predicated = buildFanOutParams(
      SHAPES,
      READ,
      [
        { param: "to_email", source: { from: "step", stepId: "read", field: "contact_email" } },
        { param: "subject", source: { from: "literal", value: "hi" } },
      ],
      { test: "field_gt", field: "", value: "5" },
    )!;
    const step: AuthoredStep = {
      kind: "tool",
      id: "send",
      ref: "mail_send",
      paramsExpr: predicated,
      dependsOn: ["read"],
    };
    const flow = flowWith(step);
    const r = setOverStep(step, CATALOGUE, flow, "other");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = parseParams(SHAPES, flow.steps, (r.step as { paramsExpr: string }).paramsExpr)!;
    expect(after.overStepId).toBe("other");
    expect(after.predicate).toMatchObject({ test: "field_gt", value: "5" });
  });

  it("null returns to the single-call form with the mappings kept", () => {
    const step: AuthoredStep = {
      kind: "tool",
      id: "send",
      ref: "mail_send",
      paramsExpr: buildFanOutParams(SHAPES, READ, [
        { param: "to_email", source: { from: "step", stepId: "read", field: "contact_email" } },
        { param: "subject", source: { from: "literal", value: "hi" } },
      ])!,
      dependsOn: ["read"],
    };
    const flow = flowWith(step);
    const r = setOverStep(step, CATALOGUE, flow, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const expr = (r.step as { paramsExpr: string }).paramsExpr;
    const after = parseParams(SHAPES, flow.steps, expr)!;
    expect(after.overStepId).toBeNull();
    // The single-call form reads the step field off `read`'s WHOLE output in jq
    // (E3.1) — it used to emit `""` here and drop the binding on the round trip.
    expect(after.mappings).toEqual([
      { param: "to_email", source: { from: "step", stepId: "read", field: "contact_email" } },
      { param: "subject", source: { from: "literal", value: "hi" } },
    ]);
  });
  it("refuses an unparseable expression", () => {
    const step: AuthoredStep = {
      kind: "tool",
      id: "send",
      ref: "mail_send",
      paramsExpr: "{{ nope }}",
      dependsOn: ["read"],
    };
    const flow = flowWith(step);
    expect(setOverStep(step, CATALOGUE, flow, "other")).toEqual({ ok: false, error: EXPRESSION_REFUSAL });
    expect(step.paramsExpr).toBe("{{ nope }}");
  });
});

describe("toSimpleBindings", () => {
  it("recovers the over step and mappings and drops the predicate", () => {
    const predicated = buildFanOutParams(
      SHAPES,
      READ,
      [{ param: "subject", source: { from: "literal", value: "hi" } }],
      { test: "field_gt", field: "", value: "5" },
    )!;
    const step: AuthoredStep = {
      kind: "tool",
      id: "send",
      ref: "mail_send",
      paramsExpr: predicated,
      dependsOn: ["read"],
    };
    const flow = flowWith(step);
    const r = toSimpleBindings(step, CATALOGUE, flow);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = parseParams(SHAPES, flow.steps, (r.step as { paramsExpr: string }).paramsExpr)!;
    expect(after.overStepId).toBe("read");
    expect(after.mappings).toEqual([{ param: "subject", source: { from: "literal", value: "hi" } }]);
    expect(after.predicate).toBeNull();
  });

  it("a hand-written whole-object read converts to an empty fan-out over that step", () => {
    const step: AuthoredStep = {
      kind: "tool",
      id: "send",
      ref: "mail_send",
      paramsExpr: "{{ json(outputs.read.body) }}",
    };
    const flow = flowWith(step);
    const r = toSimpleBindings(step, CATALOGUE, flow);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.step as { paramsExpr: string }).paramsExpr).toBe(buildFanOutParams(SHAPES, READ, [])!);
  });

  it("refuses a step with no paramsExpr field", () => {
    const step: AuthoredStep = { kind: "transform", id: "t", expr: "1" };
    const flow: AuthoredFlow = { id: "f", inputs: [], steps: [step] } as AuthoredFlow;
    expect(toSimpleBindings(step, CATALOGUE, flow).ok).toBe(false);
  });
});

const CODE_CONTRACT = {
  purpose: "sum",
  input: [
    { name: "rows", type: "array", description: "rows in" },
    { name: "rate", type: "number", description: "rate in" },
  ],
  output: [{ name: "total", type: "number", description: "total out" }],
} as const;

function codeStep(inputExpr: string): AuthoredStep {
  return {
    kind: "code",
    id: "calc",
    inputExpr,
    contract: { purpose: CODE_CONTRACT.purpose, input: [...CODE_CONTRACT.input], output: [...CODE_CONTRACT.output] },
    dependsOn: ["read"],
  } as AuthoredStep;
}

describe("setCodeInputSource", () => {
  it("binds one input of a blank payload and leaves the other null", () => {
    const step = codeStep("");
    const flow: AuthoredFlow = { id: "f", inputs: [], steps: [READ, step] } as AuthoredFlow;
    const r = setCodeInputSource(step, CATALOGUE, flow, "rows", { from: "step", stepId: "read", field: "" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.step as { inputExpr: string }).inputExpr).toBe(
      buildCodeInput(SHAPES, [
        { name: "rows", from: READ },
        { name: "rate", from: null },
      ]),
    );
  });

  it("a contract-shaped payload binds the picked input and nulls the rest", () => {
    const step = codeStep(JSON.stringify({ rows: null, rate: null }));
    const flow: AuthoredFlow = { id: "f", inputs: [], steps: [READ, OTHER, step] } as AuthoredFlow;
    const r = setCodeInputSource(step, CATALOGUE, flow, "rate", { from: "step", stepId: "other", field: "" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.step as { inputExpr: string }).inputExpr).toBe(
      buildCodeInput(SHAPES, [
        { name: "rows", from: null },
        { name: "rate", from: OTHER },
      ]),
    );
  });

  it("unbinding one input of a contract-shaped payload nulls it", () => {
    const step = codeStep('{"rows": {{ json(outputs.read.body) }}, "rate": null}');
    const flow: AuthoredFlow = { id: "f", inputs: [], steps: [READ, OTHER, step] } as AuthoredFlow;
    const r = setCodeInputSource(step, CATALOGUE, flow, "rows", null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.step as { inputExpr: string }).inputExpr).toBe(
      buildCodeInput(SHAPES, [
        { name: "rows", from: null },
        { name: "rate", from: null },
      ]),
    );
  });

  it("editing one binding preserves every other binding, whatever its source", () => {
    // The destructive-rebuild regression, for code: rows is whole, rate is a
    // flow input, and a third field is a literal. Touching one must keep the
    // other two byte for byte in meaning — read back, not compared as text.
    const rated = codeStep(
      buildCodeInput(SHAPES, [
        { name: "rows", source: { kind: "step", step: READ, field: "" } },
        { name: "rate", source: { kind: "input", inputId: "period" } },
      ]),
    );
    const flow: AuthoredFlow = { id: "f", inputs: [{ id: "period" }], steps: [READ, OTHER, rated] } as AuthoredFlow;
    const r = setCodeInputSource(rated, CATALOGUE, flow, "rows", { from: "step", stepId: "other", field: "" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.step as { inputExpr: string }).inputExpr).toBe(
      buildCodeInput(SHAPES, [
        { name: "rows", source: { kind: "step", step: OTHER, field: "" } },
        { name: "rate", source: { kind: "input", inputId: "period" } },
      ]),
    );
  });

  it("a fixed string is a literal binding now: editing beside it keeps it", () => {
    // `"a note"` used to fail the editable check, so any edit beside it was
    // refused. The picker writes literals and reads them back, so the row
    // shows the value and an edit elsewhere preserves it.
    const step = codeStep(JSON.stringify({ rows: "a note, not a binding", rate: null }));
    const flow: AuthoredFlow = { id: "f", inputs: [], steps: [READ, OTHER, step] } as AuthoredFlow;
    const r = setCodeInputSource(step, CATALOGUE, flow, "rate", { from: "step", stepId: "read", field: "" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.step as { inputExpr: string }).inputExpr).toBe(
      buildCodeInput(SHAPES, [
        { name: "rows", source: { kind: "literal", value: "a note, not a binding" } },
        { name: "rate", source: { kind: "step", step: READ, field: "" } },
      ]),
    );
  });

  it("clearing a literal row nulls it — the value was shown, so the loss is chosen", () => {
    const step = codeStep(JSON.stringify({ rows: "a note, not a binding", rate: null }));
    const flow: AuthoredFlow = { id: "f", inputs: [], steps: [READ, OTHER, step] } as AuthoredFlow;
    const r = setCodeInputSource(step, CATALOGUE, flow, "rows", null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.step as { inputExpr: string }).inputExpr).toBe(
      buildCodeInput(SHAPES, [
        { name: "rows", from: null },
        { name: "rate", from: null },
      ]),
    );
  });

  it("a column pick writes a projection over the step's rows, and reads back as that column", () => {
    const step = codeStep(JSON.stringify({ rows: null, rate: null }));
    const flow: AuthoredFlow = { id: "f", inputs: [], steps: [READ, step] } as AuthoredFlow;
    const r = setCodeInputSource(step, CATALOGUE, flow, "rows", { from: "step", stepId: "read", field: "email" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const expr = (r.step as { inputExpr: string }).inputExpr;
    expect(expr).toContain("[.[] | .email]");
    const io = stepIo(r.step, CATALOGUE, flow.steps);
    expect(io.inputs.map((i) => i.source)).toEqual([
      { kind: "step", stepId: "read", field: "email" },
      { kind: "unset" },
    ]);
  });

  it("refuses a hand-shaped payload with extra keys", () => {
    const step = codeStep(JSON.stringify({ rows: "{{ json(outputs.read.body) }}", smuggled: 1 }));
    const flow: AuthoredFlow = { id: "f", inputs: [], steps: [READ, step] } as AuthoredFlow;
    const before = (step as { inputExpr: string }).inputExpr;
    const r = setCodeInputSource(step, CATALOGUE, flow, "rows", { from: "step", stepId: "read", field: "" });
    expect(r).toEqual({ ok: false, error: EXPRESSION_REFUSAL });
    expect((step as { inputExpr: string }).inputExpr).toBe(before);
  });

  it("refuses a payload that is not JSON at all", () => {
    const step = codeStep("not json {{");
    const flow: AuthoredFlow = { id: "f", inputs: [], steps: [READ, step] } as AuthoredFlow;
    expect(setCodeInputSource(step, CATALOGUE, flow, "rows", { from: "step", stepId: "read", field: "" })).toEqual({
      ok: false,
      error: EXPRESSION_REFUSAL,
    });
  });

  it("refuses a payload with a non-string value no writer preserves", () => {
    const step = codeStep(JSON.stringify({ rows: 5, rate: null }));
    const flow: AuthoredFlow = { id: "f", inputs: [], steps: [READ, step] } as AuthoredFlow;
    const before = (step as { inputExpr: string }).inputExpr;
    expect(setCodeInputSource(step, CATALOGUE, flow, "rate", { from: "step", stepId: "read", field: "" })).toEqual({
      ok: false,
      error: EXPRESSION_REFUSAL,
    });
    expect((step as { inputExpr: string }).inputExpr).toBe(before);
  });

  it("a contract-shaped JSON payload rebuilds field by field", () => {
    const step = codeStep(JSON.stringify({ rows: null, rate: null }));
    const flow: AuthoredFlow = { id: "f", inputs: [], steps: [READ, step] } as AuthoredFlow;
    const r = setCodeInputSource(step, CATALOGUE, flow, "rate", { from: "step", stepId: "read", field: "" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.step as { inputExpr: string }).inputExpr).toBe(
      buildCodeInput(SHAPES, [
        { name: "rows", from: null },
        { name: "rate", from: READ },
      ]),
    );
  });
});

describe("dual-write: every writer stores typed inputs beside the display string", () => {
  it("setInputSource stores the edited mappings as typed inputs", () => {
    const flow = flowWith(fourMappingStep());
    const r = setInputSource(flow.steps[2]!, CATALOGUE, flow, "subject", { from: "literal", value: "changed" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.step as { inputs: unknown }).inputs).toEqual([
      { name: "to_email", source: { from: "step", stepId: "read", field: "contact_email" } },
      { name: "subject", source: { from: "literal", value: "changed" } },
      { name: "body", source: { from: "input", inputId: "period" } },
      { name: "cc", source: { from: "self" } },
    ]);
  });

  it("a dual-written step's display string re-parses to the same mappings — rendered, hence parseable", () => {
    // The invariant the whole cutover rests on: a builder-written display
    // string is never `unknown` to the reader. If this fails, the fallback
    // path and the typed path can disagree about one step.
    const flow = flowWith(fourMappingStep());
    const r = setInputSource(flow.steps[2]!, CATALOGUE, flow, "subject", { from: "literal", value: "changed" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const step = r.step as { paramsExpr: string; inputs: Array<{ name: string; source: Source }> };
    const after = parseParams(SHAPES, flow.steps, step.paramsExpr)!;
    expect(after).not.toBeNull();
    expect(after.mappings).toEqual(step.inputs.map((b) => ({ param: b.name, source: b.source })));
    expect(after.overStepId).toBe("read");
  });

  it("stepIo reads a dual-written step typed-first: bound, never unknown, editable", () => {
    const flow = flowWith(fourMappingStep());
    const r = setInputSource(flow.steps[2]!, CATALOGUE, flow, "subject", { from: "literal", value: "changed" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const io = stepIo(r.step, CATALOGUE, flow.steps);
    expect(io.inputs.map((i) => i.source)).toEqual([
      { kind: "step", stepId: "read", field: "contact_email" },
      { kind: "literal", value: "changed" },
      { kind: "input", inputId: "period" },
      { kind: "self" },
    ]);
    expect(io.editable).toBe(true);
    expect(io.readonly).toBeNull();
    expect(io.overStepId).toBe("read");
  });

  it("setOverStep moves the typed inputs onto the new over step", () => {
    const predicated = buildFanOutParams(
      SHAPES,
      READ,
      [{ param: "subject", source: { from: "literal", value: "hi" } }],
      { test: "field_gt", field: "", value: "5" },
    )!;
    const step: AuthoredStep = {
      kind: "tool",
      id: "send",
      ref: "mail_send",
      paramsExpr: predicated,
      dependsOn: ["read"],
    };
    const flow = flowWith(step);
    const r = setOverStep(step, CATALOGUE, flow, "other");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.step as { inputs: unknown }).inputs).toEqual([
      { name: "subject", source: { from: "literal", value: "hi" } },
    ]);
  });

  it("toSimpleBindings stores typed inputs for the converted mappings", () => {
    const predicated = buildFanOutParams(
      SHAPES,
      READ,
      [{ param: "subject", source: { from: "literal", value: "hi" } }],
      { test: "field_gt", field: "", value: "5" },
    )!;
    const step: AuthoredStep = {
      kind: "tool",
      id: "send",
      ref: "mail_send",
      paramsExpr: predicated,
      dependsOn: ["read"],
    };
    const flow = flowWith(step);
    const r = toSimpleBindings(step, CATALOGUE, flow);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.step as { inputs: unknown }).inputs).toEqual([
      { name: "subject", source: { from: "literal", value: "hi" } },
    ]);
  });

  it("setCodeInputSource stores typed inputs mirroring the payload, whole staying whole", () => {
    const step = codeStep(JSON.stringify({ rows: null, rate: null }));
    const flow: AuthoredFlow = { id: "f", inputs: [], steps: [READ, step] } as AuthoredFlow;
    const r = setCodeInputSource(step, CATALOGUE, flow, "rows", { from: "step", stepId: "read", field: "" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // A field-less step bind IS the whole rows — the payload spells it as a
    // bare rows address, so the typed side names it `whole`, exactly as the
    // display fallback reads it.
    expect((r.step as { inputs: unknown }).inputs).toEqual([
      { name: "rows", source: { from: "whole", stepId: "read" } },
      { name: "rate", source: null },
    ]);
    const io = stepIo(r.step, CATALOGUE, flow.steps);
    expect(io.inputs.map((i) => i.source)).toEqual([{ kind: "whole", stepId: "read" }, { kind: "unset" }]);
    expect(io.editable).toBe(true);
  });

  it("a dual-written code payload re-parses to the same bindings — rendered, hence parseable", () => {
    const rated = codeStep(
      buildCodeInput(SHAPES, [
        { name: "rows", source: { kind: "step", step: READ, field: "" } },
        { name: "rate", source: { kind: "input", inputId: "period" } },
      ]),
    );
    const flow: AuthoredFlow = { id: "f", inputs: [{ id: "period" }], steps: [READ, OTHER, rated] } as AuthoredFlow;
    const r = setCodeInputSource(rated, CATALOGUE, flow, "rows", { from: "step", stepId: "other", field: "" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const io = stepIo(r.step, CATALOGUE, flow.steps);
    expect(io.inputs.map((i) => i.source)).toEqual([
      { kind: "whole", stepId: "other" },
      { kind: "input", inputId: "period" },
    ]);
  });
});

describe("setBinding", () => {
  it("routes a call step to the call writer, display and inputs together", () => {
    const step: AuthoredStep = { kind: "tool", id: "send", ref: "mail_send", paramsExpr: "[{}]" };
    const flow: AuthoredFlow = { id: "f", inputs: [], steps: [READ, step] } as AuthoredFlow;
    const r = setBinding(step, CATALOGUE, flow, "subject", { from: "literal", value: "hi" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.step as { paramsExpr: string }).paramsExpr).toBe(
      buildSingleParams([{ param: "subject", source: { from: "literal", value: "hi" } }]),
    );
    expect((r.step as { inputs: unknown }).inputs).toEqual([
      { name: "subject", source: { from: "literal", value: "hi" } },
    ]);
  });

  it("routes a code step to the code writer, display and inputs together", () => {
    const step = codeStep(JSON.stringify({ rows: null, rate: null }));
    const flow: AuthoredFlow = { id: "f", inputs: [], steps: [READ, step] } as AuthoredFlow;
    const r = setBinding(step, CATALOGUE, flow, "rows", { from: "step", stepId: "read", field: "email" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const expr = (r.step as { inputExpr: string }).inputExpr;
    expect(expr).toContain("[.[] | .email]");
    expect((r.step as { inputs: unknown }).inputs).toEqual([
      { name: "rows", source: { from: "step", stepId: "read", field: "email" } },
      { name: "rate", source: null },
    ]);
  });

  it("refuses a kind with no named bindings, never half-written", () => {
    const step: AuthoredStep = { kind: "transform", id: "t", expr: "{{ 1 }}" };
    const flow: AuthoredFlow = { id: "f", inputs: [], steps: [step] } as AuthoredFlow;
    expect(setBinding(step, CATALOGUE, flow, "expr", { from: "literal", value: "x" })).toEqual({
      ok: false,
      error: EXPRESSION_REFUSAL,
    });
  });
});
