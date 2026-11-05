/**
 * builder-behaviour P7 (P4-I4): an approval INSIDE a loop is one item's — its request names the item, it pauses that item alone, and
 * the step it guards runs only when THAT item was approved (a rejected item's step is skipped, the others go on). Measured on the
 * engine first (phase-7 E1); built from the engine's own ops, compiled through the one emitter.
 */
import { describe, expect, it } from "vitest";
import { apply, emptyFlow, SYNTHETIC, type EFlow, type EngineOp } from "@foundry/flow-edit";
import { flowCompiler, validateModel, type FlowModel } from "./flow-compiler.service.js";
import { namespaceFor } from "./kestra-client.service.js";
import { lowerPipelinesWith } from "./flow-pipeline.js";
import { compilerRenderInputs } from "./flow-typecheck.js";
import { pausedTaskrunId } from "./step-approval.service.js";

const draft = namespaceFor("acme", "hr", "draft");
const run = (ops: EngineOp[]): EFlow => ops.reduce((f, op) => { const r = apply(f, op, SYNTHETIC); if (!r.ok) throw new Error(`${op.op}: ${r.error}`); return r.flow; }, emptyFlow("loops"));
const model = (f: EFlow) => lowerPipelinesWith({ ...(f as unknown as FlowModel), id: "loops" }, { ...SYNTHETIC, renderInputs: compilerRenderInputs });
const LIST: EngineOp[] = [
  { op: "add_reader", id: "read", ref: "store.people" },
  { op: "add_transform", id: "list", from: "read", pipeline: [{ op: "limit", n: { value: 1000, from: "person" } }] },
  { op: "add_loop", id: "each", over: "list", concurrency: 3 },
];
const post = (under: string): EngineOp[] => [
  { op: "add_call", id: "post", ref: "chat_post", under },
  { op: "bind", stepId: "post", port: "channel", source: { from: "literal", value: "#ops", provenance: "person" } },
  { op: "bind", stepId: "post", port: "text", source: { from: "field", stepId: "each", field: "name" } },
];

describe("an approval inside a loop is REFUSED (builder-behaviour P5)", () => {
  // Kestra v1.3.29 resumes an execution's FIRST paused task — its resume takes no taskrun id (measured 2026-10-04: item 1's rejection
  // landed on item 0, one decision at a time). An item's decision cannot be delivered to that item, so the gate stands before the loop.
  it("the engine refuses the gate, and the compiler refuses a model that carries one", () => {
    const f = run([...LIST, ...post("each")]);
    const r = apply(f, { op: "add_gate", id: "gate", before: "post", summary: "Post it?" }, SYNTHETIC);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/cannot be delivered to its own item — put the approval before the loop/);
    const m = model(f);
    const forced = { ...m, steps: [...m.steps.slice(0, m.steps.findIndex((x) => x.id === "post")), { id: "gate", kind: "approval", summary: "Post it?", dependsOn: ["each"] }, ...m.steps.slice(m.steps.findIndex((x) => x.id === "post")).map((x) => (x.id === "post" ? { ...x, dependsOn: [...(x.dependsOn ?? []), "gate"] } : x))] } as FlowModel;
    expect(() => flowCompiler.compile(forced, { namespace: draft })).toThrow(/cannot be delivered to its own item/);
  });
  it("CONTROL: a gate OUTSIDE a loop is emitted exactly as before — no scope, no runIf", () => {
    const y = flowCompiler.compile(model(run([
      { op: "add_reader", id: "read", ref: "store.people" },
      { op: "add_call", id: "post", ref: "chat_post" },
      { op: "bind", stepId: "post", port: "channel", source: { from: "literal", value: "#ops", provenance: "person" } },
      { op: "bind", stepId: "post", port: "text", source: { from: "literal", value: "hi", provenance: "person" } },
      { op: "add_gate", id: "gate", before: "post", summary: "Post it?" },
    ])), { namespace: draft }).yaml;
    expect(y).not.toContain(`"scope"`);
    expect(y).not.toContain("runIf");
  });
});

describe("resuming THAT item's pause", () => {
  // Two items paused under one step name; each registered by its own task, whose parent is the item's own branch.
  const ex = { taskRunList: [
    { id: "reg_a", taskId: "gate", parentTaskRunId: "arm_a", state: { current: "SUCCESS" } },
    { id: "reg_b", taskId: "gate", parentTaskRunId: "arm_b", state: { current: "SUCCESS" } },
    { id: "pause_a", taskId: "gate_await", parentTaskRunId: "arm_a", state: { current: "PAUSED" } },
    { id: "pause_b", taskId: "gate_await", parentTaskRunId: "arm_b", state: { current: "PAUSED" } },
  ] };
  it("is the sibling of the task that registered the request — never the first paused task by name", () => {
    expect(pausedTaskrunId(ex, "gate_await", "reg_b")).toBe("pause_b");
    expect(pausedTaskrunId(ex, "gate_await", "reg_a")).toBe("pause_a");
  });
  it("in a loop BODY every item shares one parent — the item is its `value` (measured 2026-10-04: the parent alone resumed another item)", () => {
    const shared = { taskRunList: [
      { id: "reg_0", taskId: "gate", parentTaskRunId: "loop", value: '{"_i":0}', state: { current: "SUCCESS" } },
      { id: "reg_1", taskId: "gate", parentTaskRunId: "loop", value: '{"_i":1}', state: { current: "SUCCESS" } },
      { id: "pause_0", taskId: "gate_await", parentTaskRunId: "loop", value: '{"_i":0}', state: { current: "PAUSED" } },
      { id: "pause_1", taskId: "gate_await", parentTaskRunId: "loop", value: '{"_i":1}', state: { current: "PAUSED" } },
    ] };
    expect(pausedTaskrunId(shared, "gate_await", "reg_1")).toBe("pause_1");
    expect(pausedTaskrunId(shared, "gate_await", "reg_0")).toBe("pause_0");
    // and an item whose pause has not opened yet is NOT given another item's
    const early = { taskRunList: shared.taskRunList.filter((t) => t.id !== "pause_1") };
    expect(pausedTaskrunId(early, "gate_await", "reg_1")).toBeUndefined();
  });
  it("CONTROL: with no registering task known (a row from before), the first by name — as before", () => {
    expect(pausedTaskrunId(ex, "gate_await")).toBe("pause_a");
  });
});
