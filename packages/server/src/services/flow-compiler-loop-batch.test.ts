/**
 * D-370 (phase F, F4b): a loop whose body is ONE call runs in batches of `LOOP_BATCH` — the numbered rows cut into chunks, a
 * ForEach over the chunks, the call emitted as today's per-row fan-out over the current chunk, a per-chunk pick of the item numbers
 * and the batch envelope, and an output that joins each item to its `results[k]`. Anything more inside runs per item, as before.
 * Built from the engine's own ops, compiled through the one emitter.
 */
import { describe, expect, it } from "vitest";
import { apply, emptyFlow, SYNTHETIC, type EFlow, type EngineOp } from "@foundry/flow-edit";
import { batchedCall, flowCompiler, LOOP_BATCH, validateModel, type FlowModel } from "./flow-compiler.service.js";
import { namespaceFor } from "./kestra-client.service.js";
import { lowerPipelinesWith } from "./flow-pipeline.js";
import { compilerRenderInputs } from "./flow-typecheck.js";

const draft = namespaceFor("acme", "hr", "draft");
const run = (ops: EngineOp[]): EFlow => ops.reduce((f, op) => { const r = apply(f, op, SYNTHETIC); if (!r.ok) throw new Error(`${op.op}: ${r.error}`); return r.flow; }, emptyFlow("loops"));
const LIST: EngineOp[] = [
  { op: "add_reader", id: "read", ref: "store.people" },
  { op: "add_transform", id: "list", from: "read", pipeline: [{ op: "limit", n: { value: 1000, from: "person" } }] },
  { op: "add_loop", id: "each", over: "list", concurrency: 3 },
];
const ONE_CALL: EngineOp[] = [
  ...LIST,
  { op: "add_call", id: "post", ref: "chat_post", under: "each" },
  { op: "bind", stepId: "post", port: "channel", source: { from: "literal", value: "#ops", provenance: "person" } },
  { op: "bind", stepId: "post", port: "text", source: { from: "field", stepId: "each", field: "name" } },
  { op: "close_loop", id: "rows", loop: "each", result: "post" },
  { op: "set_output", stepId: "rows" },
];
// What the save funnel does before compiling: each transform's pipeline lowered to its expression.
const model = (f: EFlow) => lowerPipelinesWith({ ...(f as unknown as FlowModel), id: "loops" }, { ...SYNTHETIC, renderInputs: compilerRenderInputs });
const yamlOf = (f: EFlow) => flowCompiler.compile(model(f), { namespace: draft }).yaml;
const setLimit = (m: FlowModel, n: number) => { const t = m.steps.find((s) => s.id === "list") as unknown as { pipeline: Array<{ n: { value: number } }> }; t.pipeline[0]!.n.value = n; };
const loopOf = (m: FlowModel) => m.steps.find((s) => s.kind === "for_each") as never;

describe("a one-call loop runs in batches (D-370)", () => {
  it("is batched: chunks of LOOP_BATCH, a ForEach over the chunks, the call as a fan-out over the current chunk", () => {
    const m = model(run(ONE_CALL));
    expect(() => validateModel(m)).not.toThrow();
    expect((batchedCall(m, loopOf(m)) as { id: string } | null)?.id).toBe("post");
    const y = yamlOf(run(ONE_CALL));
    expect(y).toContain("- id: each-chunks");
    expect(y).toContain(`[range(0; length; ${LOOP_BATCH}) as $k | .[$k:$k + ${LOOP_BATCH}]]`);
    expect(y).toMatch(/- id: each\n\s+type: io\.kestra\.plugin\.core\.flow\.ForEach\n.*\n\s+values: "\{\{ outputs\['each-chunks'\]\.value \}\}"/);
    expect(y).toContain("concurrencyLimit: 3");
    // The call: ONE request per chunk, one params object per row of it, each row's own field — the fan-out's jq shape.
    expect(y).toMatch(/json\(taskrun\.value\) \| jq\('\[\.\[\] \| \{"channel": "#ops", "text": \.name\}\]'\) \| first/);
    // The pick carries the chunk's item numbers and the batch envelope; the output joins results[k] back by number.
    expect(y).toContain("'is': json(taskrun.value) | jq('[.[] | ._i]') | first, 'r': outputs.post[taskrun.value].body");
    expect(y).toContain("$b.results[$k]");
    expect(y).toContain("ff_ok: $ok");
    // The per-item shape is NOT emitted for it.
    expect(y).not.toContain("values: \"{{ outputs['each-rows'].value }}\"");
  });

  it("a call that takes nothing from the item (the engine's canonical `[{}]`) is still one call per row — batched, `{}` per row", () => {
    const f = run([...LIST, { op: "add_call", id: "ping", ref: "notify_me", under: "each" }]);
    const m = model(f);
    expect((batchedCall(m, loopOf(m)) as { id: string } | null)?.id).toBe("ping");
  });
  it("anything more inside runs per item — a transform before the call, a skipped-when-empty field, a second call", () => {
    const withTransform = run([...LIST, { op: "add_transform", id: "line", from: "each", pipeline: [{ op: "project", fields: [{ name: "name", from: "name" }] }] },
      { op: "close_loop", id: "rows", loop: "each", result: "line" }]);
    const twoCalls = run([...ONE_CALL.slice(0, -2), { op: "add_call", id: "again", ref: "chat_post", under: "each" },
      { op: "bind", stepId: "again", port: "channel", source: { from: "literal", value: "#alerts", provenance: "person" } },
      { op: "bind", stepId: "again", port: "text", source: { from: "field", stepId: "each", field: "name" } }]);
    for (const f of [withTransform, twoCalls]) {
      const m = model(f);
      expect(batchedCall(m, loopOf(m))).toBeNull();
      const y = yamlOf(f);
      expect(y).not.toContain("each-chunks");
      expect(y).toContain("values: \"{{ outputs['each-rows'].value }}\"");
    }
    // A field the call skips when empty drops rows before the call — the batch's results[k] would no longer be row k.
    const m = model(run(ONE_CALL));
    const post = m.steps.find((s) => s.id === "post") as { inputs: Array<{ name: string; source: { onNull?: string } }> };
    post.inputs.find((b) => b.name === "text")!.source.onNull = "skip";
    expect(batchedCall(m, loopOf(m))).toBeNull();
  });

  it("CONTROL: the batch and the per-item shape differ only in the loop — everything before it is byte-identical", () => {
    const perItem = yamlOf(run([...LIST, { op: "add_transform", id: "line", from: "each", pipeline: [{ op: "project", fields: [{ name: "name", from: "name" }] }] }, { op: "close_loop", id: "rows", loop: "each", result: "line" }]));
    const batched = yamlOf(run(ONE_CALL));
    const head = (y: string) => y.slice(0, y.indexOf("- id: each-rows"));
    expect(head(batched)).toBe(head(perItem));
  });

  it("a list above 1,000 rows cannot be looped over — the engine refuses, and the compiler refuses a model that got one", () => {
    const f = run(LIST.slice(0, 1));
    const big = apply(run([...LIST.slice(0, 1), { op: "add_transform", id: "list", from: "read", pipeline: [{ op: "limit", n: { value: 1001, from: "person" } }] }]), { op: "add_loop", id: "each", over: "list" }, SYNTHETIC);
    expect(big.ok ? "" : big.error).toMatch(/limit 1001 is above 1000/);
    expect(f.steps.length).toBe(1);
    const m = model(run(ONE_CALL));
    setLimit(m, 1001);
    expect(() => flowCompiler.compile(m, { namespace: draft })).toThrow(/at most 1000 rows; filter or limit the list first/);
  });
});
