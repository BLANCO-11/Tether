/**
 * Phase Z (I-320): each step's STRUCTURE — inputs with types and values, output fields with types, a condition's paths, who reads
 * it — for the canvas to draw as a component. The reported flow's shape, in neutral names over the synthetic catalogue.
 */
import { describe, expect, it } from "vitest";
import { SYNTHETIC } from "./synthetic.js";
import { decideTest, flowShape, typeName } from "./shape.js";
import { apply, type EngineOp } from "./ops.js";
import { emptyFlow, type EFlow } from "./model.js";
import { T } from "../typecheck/types.js";

const FLOW: EFlow = {
  id: "f", inputs: [{ id: "as_of_1", type: "DATE" }], holes: [],
  steps: [
    { id: "read_1", kind: "datasource", ref: "store.widgets", inputs: [{ name: "as_of", source: { from: "input", inputId: "as_of_1" } }], dependsOn: [] },
    { id: "where_1", kind: "transform", from: "read_1", expr: "", dependsOn: ["read_1"], pipeline: [
      { op: "group", by: ["state"], aggs: [{ as: "sum_qty", fn: "sum", field: "qty" }] },
    ] },
    { id: "when_1", kind: "branch", conditions: [{ op: "any", left: { stepId: "read_1", field: "" } }], dependsOn: ["read_1"] },
    { id: "when_2", kind: "branch", elseOf: "when_1", dependsOn: [] },
    { id: "call_1", kind: "tool", ref: "chat_post", inputs: [{ name: "channel", source: { from: "literal", value: "#ops" } }, { name: "text", source: { from: "whole", stepId: "where_1", transform: "text" } }], dependsOn: ["when_1", "where_1"] },
    { id: "call_2", kind: "tool", ref: "notify_me", inputs: [], dependsOn: ["when_2"] },
  ],
};
const S = flowShape(FLOW, SYNTHETIC);

describe("flowShape — a step as a component: typed inputs, typed outputs, paths, who reads it", () => {
  it("a call's inputs: every declared one, typed, with what fills it — a variable, a literal, or unset and why", () => {
    expect(S.call_1!.inputs).toEqual([
      { name: "channel", type: "string", required: true, value: { literal: "#ops" } },
      { name: "text", type: "string", required: true, value: { var: { stepId: "where_1", asText: true } } },
    ]);
    expect(S.call_2!.inputs.map((i) => i.value)).toEqual([{ unset: "requester" }, { unset: "required" }]);
    expect(S.read_1!.inputs[0]!.value).toEqual({ input: "as_of_1" });
  });

  it("outputs are the fields a reader sees, typed", () => {
    expect(S.where_1!.output).toEqual({ list: true, fields: [{ name: "state", type: "string" }, { name: "sum_qty", type: "number" }] });
    expect(S.when_1!.output).toBeNull();
  });

  it("a condition carries its chain; a step on a path says which", () => {
    const paths = [
      { branchId: "when_1", label: "IF", conditions: [{ var: { stepId: "read_1" }, op: "is not empty" }], steps: ["call_1"] },
      { branchId: "when_2", label: "ELSE", conditions: [], steps: ["call_2"] },
    ];
    expect(S.when_1!.paths).toEqual(paths);
    expect(S.when_2!.paths).toEqual(paths);
    expect(S.call_1!.on).toEqual({ branchId: "when_1", label: "IF" });
    expect(S.call_2!.on).toEqual({ branchId: "when_2", label: "ELSE" });
  });

  it("usedBy names who reads a step and into which input", () => {
    expect(S.read_1!.usedBy).toEqual([{ stepId: "where_1" }, { stepId: "when_1" }]);
    expect(S.where_1!.usedBy).toEqual([{ stepId: "call_1", input: "text" }]);
  });

  it("types as a workflow tool names them", () => {
    expect(typeName(T.rows(T.record({ a: T.text() })))).toBe("array[object]");
    expect(typeName(T.option(T.date()))).toBe("date?");
  });
});

describe("a Decide — a condition on ONE value — is one test, not a hidden transform (phase C, D-371)", () => {
  // Built through the engine's own ops: read, count, keep it if n > 3, a condition on that, a call on the path.
  const ops: EngineOp[] = [
    { op: "declare_input", id: "as_of_1", type: "DATE" },
    { op: "add_reader", id: "read_1", ref: "store.widgets" },
    { op: "bind", stepId: "read_1", port: "as_of", source: { from: "input", inputId: "as_of_1" } },
    { op: "add_transform", id: "count_1", from: "read_1", pipeline: [{ op: "count", as: "n" }, { op: "keep_if", where: { cmp: "gt", left: { field: "n" }, right: { lit: { value: 3, from: "goal" } } } }] },
    { op: "add_branch", id: "when_1", when: [{ stepId: "count_1", test: "any" }] },
    { op: "add_transform", id: "where_1", from: "read_1", pipeline: [{ op: "filter", where: { cmp: "gt", left: { field: "qty" }, right: { lit: { value: 1, from: "goal" } } } }] },
    { op: "add_branch", id: "when_2", when: [{ stepId: "where_1", test: "any" }] },
    // A step on the path reads the filter's rows: they are data. (A filter ONLY a condition reads is a row test — canvas.test.ts.)
    { op: "add_transform", id: "count_2", from: "where_1", pipeline: [{ op: "count", as: "n" }], under: "when_2" },
  ];
  const f = ops.reduce((g, op) => { const r = apply(g, op, SYNTHETIC); if (!r.ok) throw new Error(`${op.op}: ${r.error}`); return r.flow; }, emptyFlow("f"));
  const sh = flowShape(f, SYNTHETIC);
  it("its condition carries the test — subject, what is worked out first, and the typed comparison", () => {
    const test = sh.when_1!.paths![0]!.conditions[0]!.test!;
    expect(test.subject).toBe("read_1");
    expect(test.before).toEqual([{ op: "count", as: "n" }]);
    expect(test.where).toEqual({ cmp: "gt", left: { field: "n" }, right: { lit: { value: 3, from: "goal" } } });
    expect(sh.count_1!.testFor).toBe("when_1");
    expect(decideTest(f, "count_1")).not.toBeNull();
  });
  it("CONTROL: a filter a condition tests is data (actions read it), not a hidden test", () => {
    expect(sh.when_2!.paths![0]!.conditions[0]!.test).toBeUndefined();
    expect(sh.where_1!.testFor).toBeUndefined();
  });
});
