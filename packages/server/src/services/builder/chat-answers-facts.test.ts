/**
 * 2026-10-01 (47d1e01e): "which step is not finished?" and "why is there period as start input?" both got the same summary, and
 * "make it start date and end date" got "I could not match that". The facts that answer them are in the flow and the catalogue —
 * which input each step reads, and what each reader takes — and these read them, the same way for any component.
 */
import { describe, expect, it } from "vitest";
import { apply, emptyFlow, SYNTHETIC as cat, type EFlow, type EngineOp } from "@foundry/flow-edit";
import { inputFacts, readerFacts } from "./chat-answers.js";
import type { BuilderCatalogue } from "./goal-spec.js";

const ITEMS: BuilderCatalogue = { items: [
  { ref: "store.widgets", kind: "reader", about: "Widgets as of a date. Long prose after the first sentence.", params: [{ name: "as_of", about: "The day to read the widgets as of." }] },
  { ref: "store.people", kind: "reader", about: "Everyone in the store.", params: [] },
] };
const run = (ops: EngineOp[]): EFlow => ops.reduce((f, op) => { const r = apply(f, op, cat); if (!r.ok) throw new Error(`${op.op}: ${r.error}`); return r.flow; }, emptyFlow("t"));

describe("what each run asks for, and why — read off the flow and the catalogue", () => {
  const F = run([
    { op: "declare_input", id: "period", type: "DATE" },
    { op: "declare_input", id: "spare", type: "STRING", format: "month" },
    { op: "add_reader", id: "read", ref: "store.widgets" },
    { op: "bind", stepId: "read", port: "as_of", source: { from: "input", inputId: "period" } },
    { op: "add_reader", id: "people", ref: "store.people" },
  ]);
  it("an input says how it is asked, which component needs it as what, and that component's own words for it", () => {
    expect(inputFacts(F, ITEMS)[0]).toBe("period — asked each run as a date. Widgets as of a date needs it as its as_of (“The day to read the widgets as of.”).");
  });
  it("an input no step reads says so — the stray one a change left behind", () => {
    expect(inputFacts(F, ITEMS)[1]).toBe("spare — asked each run as a month (YYYY-MM). No step reads it yet.");
  });
  it("each reader says what it takes, and that it takes nothing else — or that it takes nothing", () => {
    expect(readerFacts(F, ITEMS)).toEqual([
      "Widgets as of a date takes as_of (“The day to read the widgets as of.”) — and nothing else.",
      "Everyone in the store takes nothing.",
    ]);
  });
  it("CONTROL: a flow with no inputs and no readers has no facts to state", () => {
    expect([inputFacts(emptyFlow("t"), ITEMS), readerFacts(emptyFlow("t"), ITEMS)]).toEqual([[], []]);
  });
});
