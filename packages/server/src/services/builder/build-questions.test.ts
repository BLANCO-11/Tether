/**
 * One question per input of a component (UAT 2026-09-30: the sender of three emails was asked three times — once per step). The
 * same port of the same component, of the same type, open on several steps, is asked ONCE and its answer fills each. A port the
 * catalogue declares as wording (a subject, a message) is each step's own and stays its own question.
 */
import { describe, expect, it } from "vitest";
import { apply, emptyFlow, SYNTHETIC, type CatalogueSnapshot, type EFlow, type EngineOp } from "@foundry/flow-edit";
import { answer, emptyTrace, questionsFor } from "./build.js";

// `subject` declared a heading, as a catalogue declares it (the grouping reads the declaration, never the port's name).
const cat: CatalogueSnapshot = { ...SYNTHETIC, refs: { ...SYNTHETIC.refs, mail_send: { ...SYNTHETIC.refs.mail_send!, params: SYNTHETIC.refs.mail_send!.params.map((p) => (p.name === "subject" ? { ...p, heading: true } : p)) } } };
const run = (ops: EngineOp[]) => ops.reduce<EFlow>((f, o) => { const r = apply(f, o, cat); if (!r.ok) throw new Error(`${o.op}: ${r.error}`); return r.flow; }, emptyFlow("f"));
const f = run([{ op: "add_call", id: "call_1", ref: "mail_send" }, { op: "add_call", id: "call_2", ref: "mail_send" }, { op: "add_call", id: "call_3", ref: "mail_send" }]);
const portHoles = (g: EFlow, port: string) => g.holes.filter((h) => h.site.at === "port" && h.site.port === port).map((h) => h.id);

describe("the same input on several steps is ONE question", () => {
  const qs = questionsFor(f, f.holes.map((h) => h.id), emptyTrace(), 1, cat);
  it("the three `to`s are one question naming how many it fills; its answer fills all three", () => {
    const to = qs.filter((q) => q.port === "to");
    expect(to).toHaveLength(1);
    expect(to[0]!.ask).toMatch(/for all 3 of its steps/);
    expect(to[0]!.alsoFills).toHaveLength(2);
    const g = answer(f, to[0]!, "ops@acme-corp.com", cat);
    expect(to[0]!.filled).toBe(true);
    expect(portHoles(g, "to")).toEqual([]);
  });
  it("CONTROL: a declared wording input (the subject) is asked per step", () => {
    expect(qs.filter((q) => q.port === "subject")).toHaveLength(3);
  });
  it("asked once: the holes it fills are never asked again", () => {
    const trace = emptyTrace();
    trace.questions.push(...qs);
    expect(questionsFor(f, f.holes.map((h) => h.id), trace, 2, cat)).toEqual([]);
  });
  it("an answer that does not fit fills none of them", () => {
    const to = { ...questionsFor(f, f.holes.map((h) => h.id), emptyTrace(), 1, cat).find((q) => q.port === "to")! };
    const g = answer(f, to, "not an address", cat);
    expect(to.filled).toBe(false);
    expect(portHoles(g, "to")).toHaveLength(3);
  });
});
