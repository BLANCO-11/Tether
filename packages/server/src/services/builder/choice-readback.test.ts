/**
 * The readback of choices (phase 8 task 1, P6): every step and every bound input is a choice the approver can read, with who made
 * it and from how many options; least-certain first; no invented confidence; the spec-match result beside it.
 */
import { describe, expect, it } from "vitest";
import { apply, complete, emptyFlow, SYNTHETIC as cat, walk, type EFlow, type EngineOp } from "@foundry/flow-edit";
import { choiceReadback } from "./choice-readback.js";
import type { GoalSpec } from "./goal-spec.js";

const build = (ops: EngineOp[]) => ops.reduce((f, op) => { const r = apply(f, op, cat); if (!r.ok) throw new Error(r.error); return r.flow; }, emptyFlow("t"));
const flow = build([
  { op: "add_reader", id: "people", ref: "store.people" },
  { op: "add_transform", id: "list", from: "people", pipeline: [{ op: "count", as: "n" }] },
  { op: "add_call", id: "send", ref: "mail_send" },
  { op: "bind", stepId: "send", port: "to", source: { from: "literal", value: "ops@acme-corp.com", provenance: "goal", quote: "to ops@acme-corp.com" } },
  { op: "bind", stepId: "send", port: "subject", source: { from: "literal", value: "Weekly", provenance: "person" } },
  { op: "bind", stepId: "send", port: "body", source: { from: "text", stepId: "list" } },
  { op: "set_output", stepId: "list" },
]);
const spec: GoalSpec = {
  sources: [{ ref: "store.people", quote: "everyone" }], sinks: [{ ref: "mail_send", quote: "email it" }],
  values: [{ role: "recipient", from: "goal", quote: "to ops@acme-corp.com", fills: "mail_send.to" } as never],
  conditions: [], schedule: null, missing: null, shapes: [{ over: "people", stages: [{ op: "count", quote: "how many" }] } as never],
};
const stored = { goalSpec: { goal: "email ops how many people there are", readback: ["Reads everyone", "Sends an email"], spec }, trace: { questions: [], base: [] } };

describe("choice readback", () => {
  it("lists every step and every bound input, each with who chose it — from what runs", () => {
    const r = choiceReadback(flow, stored as never, cat);
    const at = (stepId: string, port?: string) => r.choices.find((c) => c.stepId === stepId && c.port === port && !c.what.startsWith("the flow's result"))!;
    expect(at("people")).toMatchObject({ chosen: "store.people", by: "llm", quote: "everyone" });
    expect(at("send")).toMatchObject({ chosen: "mail_send", by: "llm", quote: "email it" });
    expect(at("send", "to")).toMatchObject({ chosen: '"ops@acme-corp.com"', by: "goal", quote: "to ops@acme-corp.com" });
    expect(at("send", "subject")).toMatchObject({ by: "person" });
    expect(at("send", "body")).toMatchObject({ chosen: "list, as text", by: expect.stringMatching(/code|forced/) });
    expect(at("list")).toMatchObject({ chosen: "count rows as n", by: "llm", quote: "how many" });
    expect(r.choices.every((c) => c.confidence === null)).toBe(true); // none recorded — never made up
    expect(r.goal?.readback).toEqual(["Reads everyone", "Sends an email"]);
    expect(r.specMatch).toEqual([]);
  });

  it("counts a port's options from the engine (unbound, what would it list?) — one option is forced", () => {
    const r = choiceReadback(flow, stored as never, cat);
    const body = r.choices.find((c) => c.stepId === "send" && c.port === "body")!;
    expect(body.options).toBeGreaterThan(0);
    expect(body.by).toBe(body.options === 1 ? "forced" : "code");
  });

  it("least-certain first: the model's picks before forced ones", () => {
    const by = choiceReadback(flow, stored as never, cat).choices.map((c) => c.by);
    const last = (b: string) => by.lastIndexOf(b as never), first = (b: string) => by.indexOf(b as never);
    expect(last("llm")).toBeLessThan(Math.max(first("person"), first("goal"), first("forced"), by.length));
  });

  it("a flow built by hand (no confirmed goal) reads back as the person's choices, with no spec match to run", () => {
    const r = choiceReadback(flow, null, cat);
    expect(r.goal).toBeNull();
    expect(r.specMatch).toEqual([]);
    expect(new Set(r.choices.map((c) => c.by))).toEqual(new Set(["person"]));
  });

  it("a flow that does more than its spec says shows the mismatch beside the choices", () => {
    const extra = { ...stored, goalSpec: { ...stored.goalSpec, spec: { ...spec, sinks: [] } } };
    expect(choiceReadback(flow, extra as never, cat).specMatch.join(" ")).toMatch(/mail_send.*does not ask for/);
  });

  it("covers every step of every complete walked flow — no step goes unread", () => {
    let flows = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const w = walk(emptyFlow("t"), cat, 3 + (seed % 12), seed);
      const done = complete(w.at(-1)?.flow ?? emptyFlow("t"), cat, seed).at(-1)?.flow ?? w.at(-1)?.flow;
      if (!done) continue;
      const f: EFlow = done;
      flows++;
      const r = choiceReadback(f, null, cat);
      for (const s of f.steps) expect(r.choices.some((c) => c.stepId === s.id), `step ${s.id} (${s.kind}) has no choice`).toBe(true);
      for (const s of f.steps) if ("inputs" in s) for (const b of s.inputs.filter((x) => x.source)) expect(r.choices.some((c) => c.stepId === s.id && c.port === b.name), `${s.id}.${b.name}`).toBe(true);
    }
    expect(flows).toBeGreaterThan(20);
  });
});
