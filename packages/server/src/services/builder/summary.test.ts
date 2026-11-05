/**
 * builder-behaviour P1 (R4): a summary is a part of the plan. Over a table or a written read it is the READ's contract — computed in
 * SQL, never by the flow over capped rows — checked against the read's own form; over a saved reader (its SQL fixed) it is the flow's
 * group stage, and a test of a measure reads the group. Controls: the switch off (no summary at all), and a read that misses a part.
 */
import { afterEach, describe, expect, it } from "vitest";
import { checkState, emptyFlow, errorsOf, renderType, SYNTHETIC, type CatalogueSnapshot, type EFlow, type Ty } from "@foundry/flow-edit";
import { clauses, normalisePlan, planSchema, planToSpec, type Plan } from "./plan.js";
import { checkSpec, readback, type BuilderCatalogue } from "./goal-spec.js";
import { readContract } from "./read-contract.js";
import { solve } from "./solver.js";
import { enumCount, ENUM_BUDGET } from "./strict-schema.js";

const on = () => { process.env.BUILDER_INPUTS = "1"; };
const off = () => { delete process.env.BUILDER_INPUTS; };
afterEach(off);

const CAT: BuilderCatalogue = { items: [
  { ref: "fin.new_read", kind: "reader", about: "a new read" },
  { ref: "fin.table.public.invoices", kind: "reader", about: "invoices", fields: [{ name: "vendor_id", ty: "Int" }, { name: "amount", ty: "Number" }] },
] };
const G = "show the total invoice spend per vendor, biggest first, only the top 5";
const CS = clauses(G);
const PLAN: Plan = {
  sources: [{ ref: "fin.table.public.invoices", clauses: [CS[0]!.id] }], each: null, rows: [], schedule: null, conditions: [], actions: [], values: [], missing: "", joining: CS.slice(1).map((c) => c.id),
  summary: { clauses: [CS[0]!.id], over: 0, by: [{ field: "fin.table.public.invoices.vendor_id", words: "vendor" }], measures: [{ fn: "sum", field: "fin.table.public.invoices.amount", words: "the total invoice spend" }], sort: { by: "summary:0", dir: "desc" }, limit: "5" },
};

describe("a summary over a table is the WRITTEN read's contract", () => {
  it("the table becomes a written read that groups, totals, orders and limits; CONTROL: off, there is no summary at all", () => {
    on();
    const { spec } = planToSpec(normalisePlan(PLAN), CS, CAT, G);
    expect(spec.sources.map((s) => s.ref)).toEqual(["fin.new_read"]);
    expect(spec.summary).toEqual(expect.objectContaining({ over: "fin.new_read", by: ["vendor_id"], measures: [{ name: "sum_amount", fn: "sum", field: "amount", words: "the total invoice spend" }] }));
    // Its order and how many it keeps are the flow's, over the read's grouped rows (the read's form cannot sort by an aggregate).
    expect(spec.shapes?.find((sh) => sh.over === "fin.new_read")?.stages.map((x) => [x.op, x.field ?? x.value, x.dir ?? ""])).toEqual([["sort", "fin.new_read.sum_amount", "desc"], ["limit", "5", ""]]);
    // The read returns what the FLOW reads of it — the measure it sorts by — and computes the summary as its form allows.
    expect(readContract(spec, "fin.new_read", [G]).fields?.map((f) => f.name)).toEqual(["sum_amount"]);
    expect(readback(checkSpec(spec, [G], CAT), CAT).join("\n")).toMatch(/Computes: one row per `vendor_id`, with the total of `amount` \(as `sum_amount`\)/);
  });
});

// A saved reader: the synthetic catalogue's `store.widgets` (state, qty, …).
const fieldsOf = (r: CatalogueSnapshot["refs"][string]) => (r.kind === "tool" ? [] : Object.entries((r.payload as { of: { fields: Record<string, Ty> } }).of.fields).map(([name, t]) => ({ name, ty: renderType(t) })));
const ITEMS: BuilderCatalogue = { items: Object.entries(SYNTHETIC.refs).map(([ref, r]) => ({ ref, kind: r.kind === "tool" ? ("tool" as const) : ("reader" as const), about: ref, params: r.params.map((p) => ({ name: p.name, about: "" })), fields: fieldsOf(r) })) };
const G2 = "count the widgets as of 2026-06-30 by state and post the states with more than 5 to #ops";
const CS2 = clauses(G2);
const PLAN2: Plan = {
  sources: [{ ref: "store.widgets", clauses: [CS2[0]!.id] }], each: null, rows: [], schedule: null, missing: "", joining: [],
  conditions: [{ quote: "with more than 5", clauses: [CS2.at(-1)!.id], over: "any_row", where: [{ field: "summary:0", about: "", test: "above", value: "5" }], count: null }],
  actions: [{ ref: "chat_post", clauses: [CS2.at(-1)!.id], on: "if:0", per_item: false, approve_first: null, recipient: { from: "goal", words: "#ops" } }],
  values: [{ role: "date", from: "goal", quote: "2026-06-30", fills: "store.widgets.as_of", clauses: [CS2[0]!.id] }, { role: "channel", from: "goal", quote: "#ops", fills: "chat_post.channel", clauses: [CS2.at(-1)!.id] }],
  summary: { clauses: [CS2[0]!.id], over: 0, by: [{ field: "store.widgets.state", words: "state" }], measures: [{ fn: "count", field: "new_read", words: "count the widgets" }], sort: null, limit: "" },
};

describe("a summary over a SAVED reader is the flow's group stage", () => {
  it("grouped, counted, and a test of the count reads the group; built valid by the real solver; CONTROL: off, nothing is grouped", () => {
    on();
    const { spec } = planToSpec(normalisePlan(PLAN2), CS2, ITEMS, G2);
    expect(spec.summary).toBeUndefined();
    const last = spec.shapes!.at(-1)!;
    expect(last.stages.map((s) => s.op)).toEqual(["group", "filter"]);
    expect(last.stages[0]).toMatchObject({ by: ["store.widgets.state"], measures: [{ fn: "count", field: null }] });
    expect(last.stages[1]).toMatchObject({ field: "stage:0:0", test: "above", value: "5" });
    const checked = checkSpec(spec, [G2], ITEMS);
    const r = solve(emptyFlow("t"), { spec: checked, cat: SYNTHETIC, answers: new Map(), base: [] });
    expect(errorsOf(checkState(r.flow, SYNTHETIC))).toEqual([]);
    const pipes = JSON.stringify(r.flow.steps.filter((s): s is Extract<EFlow["steps"][number], { kind: "transform" }> => s.kind === "transform").map((s) => s.pipeline));
    expect(pipes).toMatch(/"op":"group","by":\["state"\]/);
    expect(pipes).toMatch(/"cmp":"gt","left":\{"field":"count"\}/);
  });
  it("the plan schema with summaries is still within the gateway's enum budget", () => {
    on();
    expect(enumCount(planSchema(ITEMS, CS2))).toBeLessThanOrEqual(ENUM_BUDGET);
  });
});

describe("rows ALSO used one by one keep their own list; the summary is a second list over them (B21)", () => {
  it("the loop goes through the rows; the once-only action takes the summary; CONTROL: with no per-item use, one list", () => {
    on();
    const G3 = "for each widget email me, and post how many there were to #ops";
    const CS3 = clauses(G3);
    const plan: Plan = {
      sources: [{ ref: "store.widgets", clauses: [CS3[0]!.id] }], each: { over: 0, clauses: [CS3[0]!.id] }, rows: [], schedule: null, conditions: [], missing: "", joining: [],
      actions: [
        { ref: "mail_send", clauses: [CS3[0]!.id], on: "always", per_item: true, approve_first: null, recipient: { from: "requester", words: "me" } },
        { ref: "chat_post", clauses: [CS3.at(-1)!.id], on: "always", per_item: false, approve_first: null, recipient: { from: "goal", words: "#ops" } },
      ],
      values: [], summary: { clauses: [CS3.at(-1)!.id], over: 0, by: [], measures: [{ fn: "count", field: "new_read", words: "how many there were" }], sort: null, limit: "" },
    };
    const { spec } = planToSpec(normalisePlan(plan), CS3, ITEMS, G3);
    expect(spec.wiring?.each?.over).toBe("reader:0");
    expect(spec.wiring?.actions.map((a) => a.takes)).toEqual(["item", "list:0"]);
    expect(spec.shapes?.[0]?.stages.map((x) => x.op)).toEqual(["group"]);
    const once = { ...plan, each: null, actions: [plan.actions[1]!] };
    const { spec: s2 } = planToSpec(normalisePlan(once), CS3, ITEMS, G3);
    expect(s2.wiring?.actions.map((a) => a.takes)).toEqual(["list:0"]);
    expect(s2.shapes).toHaveLength(1);
  });
});

describe("“… and post the rest” is a split: the rows that pass, and the rest (B22)", () => {
  it("the condition divides its list; the first action takes the rows that pass, the second the rest; built valid; CONTROL: off, no split", () => {
    on();
    const G4 = "email me the widgets as of 2026-06-30 with qty over 30 and post the rest to #ops";
    const CS4 = clauses(G4);
    const plan: Plan = {
      sources: [{ ref: "store.widgets", clauses: [CS4[0]!.id] }], each: null, rows: [], schedule: null, missing: "", joining: [],
      conditions: [{ quote: "with qty over 30", clauses: [CS4[0]!.id], over: "any_row", where: [{ field: "store.widgets.qty", about: "", test: "above", value: "30" }], count: null }],
      actions: [
        { ref: "notify_me", clauses: [CS4[0]!.id], on: "if:0", per_item: false, approve_first: null, recipient: { from: "requester", words: "me" } },
        { ref: "chat_post", clauses: [CS4.at(-1)!.id], on: "rest:0", per_item: false, approve_first: null, recipient: { from: "goal", words: "#ops" } },
      ],
      values: [{ role: "date", from: "goal", quote: "2026-06-30", fills: "store.widgets.as_of", clauses: [CS4[0]!.id] }, { role: "channel", from: "goal", quote: "#ops", fills: "chat_post.channel", clauses: [CS4.at(-1)!.id] }],
    };
    const { spec } = planToSpec(normalisePlan(plan), CS4, ITEMS, G4);
    expect(spec.wiring?.paths).toEqual([expect.objectContaining({ test: "split", measure: "qty", cmp: "gt", value: "30" })]);
    expect(spec.wiring?.actions.map((a) => a.path)).toEqual([0, "rest:0"]);
    const checked = checkSpec(spec, [G4], ITEMS);
    expect(checked.dropped).toEqual([]);
    const r = solve(emptyFlow("t"), { spec: checked, cat: SYNTHETIC, answers: new Map(), base: [] });
    expect(errorsOf(checkState(r.flow, SYNTHETIC))).toEqual([]);
    const pipes = r.flow.steps.filter((s): s is Extract<EFlow["steps"][number], { kind: "transform" }> => s.kind === "transform").map((s) => JSON.stringify(s.pipeline));
    expect(pipes.some((x) => x.includes('"cmp":"gt","left":{"field":"qty"}') && !x.includes('"not"'))).toBe(true);
    expect(pipes.some((x) => x.includes('"not"') && x.includes('"field":"qty"'))).toBe(true);
    expect(r.unmet).toEqual([]);
  });
});

describe("a split by a number the goal gives as an input uses that input (B22)", () => {
  it("built complete: no “used by nothing”; the split compares with its value", () => {
    on();
    const G5 = "email me the widgets as of 2026-06-30 with qty over 30 and post the rest to #ops";
    const CS5 = clauses(G5);
    const plan: Plan = {
      sources: [{ ref: "store.widgets", clauses: [CS5[0]!.id] }], each: null, rows: [], schedule: null, missing: "", joining: [],
      inputs: [{ id: "in_a", kind: "number", words: "30", fill: "given", clauses: [CS5[0]!.id] }],
      conditions: [{ quote: "with qty over 30", clauses: [CS5[0]!.id], over: "any_row", where: [{ field: "store.widgets.qty", about: "", test: "above", value: "", input: "in_a" }], count: null }],
      actions: [
        { ref: "notify_me", clauses: [CS5[0]!.id], on: "if:0", per_item: false, approve_first: null, recipient: { from: "requester", words: "me" } },
        { ref: "chat_post", clauses: [CS5.at(-1)!.id], on: "rest:0", per_item: false, approve_first: null, recipient: { from: "goal", words: "#ops" } },
      ],
      values: [{ role: "date", from: "goal", quote: "2026-06-30", fills: "store.widgets.as_of", clauses: [CS5[0]!.id] }, { role: "channel", from: "goal", quote: "#ops", fills: "chat_post.channel", clauses: [CS5.at(-1)!.id] }],
    };
    const { spec } = planToSpec(normalisePlan(plan), CS5, ITEMS, G5);
    expect(spec.wiring?.paths[0]).toMatchObject({ test: "split", value: "30", input: "in_a" });
    const r = solve(emptyFlow("t"), { spec: checkSpec(spec, [G5], ITEMS), cat: SYNTHETIC, answers: new Map(), base: [] });
    expect(r.unmet).toEqual([]);
  });
});
