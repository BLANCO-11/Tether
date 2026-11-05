/**
 * A read may compare with the PRESENT (2026-10-04). "Invoices past their due date" and "incidents open for more than 30 minutes"
 * could not be written: a written read's only parameters were the values the goal STATES, and the present is never stated — the
 * writer refused and the whole automation with it. The contract now offers the day it runs and the moment it runs; the automation
 * fills them itself. Neutral catalogue (a lending library), so this is the mechanism, never a workspace.
 */
import { describe, expect, it } from "vitest";
import { SYNTHETIC, emptyFlow, TypeOf as T, type CatalogueSnapshot, type EFlow } from "@foundry/flow-edit";
import { solve } from "./solver.js";
import { checkSpec, type BuilderCatalogue, type GoalSpec } from "./goal-spec.js";
import { applyContract, contractFindings, contractText, readContract } from "./read-contract.js";

const cat: CatalogueSnapshot = {
  ...SYNTHETIC,
  refs: {
    ...SYNTHETIC.refs,
    "lib.query.overdue": { kind: "operation", params: [{ name: "run_day", ty: T.date(), required: true }, { name: "run_time", ty: T.dateTime(), required: true }], payload: T.rows(T.record({ loan_id: T.int() })) },
    note_mail: { kind: "tool", params: [{ name: "to", ty: T.list(T.address()), required: false, liftsScalar: true, fallsBackToRequester: true }, { name: "subject", ty: T.text(), required: true, heading: true }, { name: "body", ty: T.text(), required: true, message: true }], payload: T.record({ status: T.text() }) },
  },
};
const ITEMS: BuilderCatalogue = { items: [
  { ref: "lib.query.overdue", kind: "reader", about: "loans", fields: [{ name: "loan_id", ty: "Int" }], params: [{ name: "run_day", about: "" }, { name: "run_time", about: "" }] },
  { ref: "note_mail", kind: "tool", about: "mail", params: [{ name: "to", about: "" }, { name: "subject", about: "" }, { name: "body", about: "" }] },
] };
const GOAL = "email me the overdue loans with subject Overdue";
const spec = (runParams?: GoalSpec["runParams"]): GoalSpec => ({
  sources: [{ ref: "lib.query.overdue", quote: "the overdue loans" }], sinks: [{ ref: "note_mail", quote: "email me" }],
  values: [{ role: "recipient", from: "requester", quote: "me", fills: "note_mail.to" }, { role: "subject", from: "goal", quote: "Overdue", fills: "note_mail.subject" }],
  conditions: [], schedule: null, missing: null, ...(runParams ? { runParams } : {}),
});
const build = (s: GoalSpec) => solve(emptyFlow("t"), { spec: checkSpec(s, [GOAL], ITEMS), cat, answers: new Map(), base: [] });
const readOf = (f: EFlow) => f.steps.find((s) => s.kind === "datasource") as Extract<EFlow["steps"][number], { kind: "datasource" }>;

describe("the present, in a written read", () => {
  it("the contract offers the day and the moment it runs — optional, and each of its own kind", () => {
    const c = readContract({ sources: [{ ref: "lib.new_read", quote: "the overdue loans" }], sinks: [], values: [], conditions: [], schedule: null, missing: null }, "lib.new_read", [GOAL]);
    expect(contractText(c)).toMatch(/"run_day": the day it runs[\s\S]*"run_time": the moment it runs/);
    expect(contractFindings(c, {})).toEqual([]); // not used: no finding
    expect(contractFindings(c, { run_day: { type: "date" }, run_time: { type: "string", format: "datetime" } })).toEqual([]);
    // the moment cut to its day would compare "open for 30 minutes" at midnight
    expect(contractFindings(c, { run_time: { type: "date" } }).join(" ")).toMatch(/run_time.*an instant/);
    // CONTROL: any other parameter the goal never stated is still refused
    expect(contractFindings(c, { as_of: { type: "date" } }).join(" ")).toMatch(/not a parameter of the contract/);
  });

  it("the read's use of them is recorded on the spec, by code", () => {
    const s0: GoalSpec = { sources: [{ ref: "lib.new_read", quote: "the overdue loans" }], sinks: [], values: [], conditions: [], schedule: null, missing: null };
    const s = applyContract(s0, "lib.new_read", "lib.query.overdue", readContract(s0, "lib.new_read", [GOAL]), [], ["run_day", "loan_id"]);
    expect(s.runParams).toEqual([{ fills: "lib.query.overdue.run_day", at: "day" }]);
  });

  it("the solver fills them from the engine's own values when it runs — never a question", () => {
    const r = build(spec([{ fills: "lib.query.overdue.run_day", at: "day" }, { fills: "lib.query.overdue.run_time", at: "time" }]));
    expect(r.flow.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ id: "run_day", computed: "currentDate" }), expect.objectContaining({ id: "run_time", computed: "runTimestamp" })]));
    const inputs = readOf(r.flow).inputs;
    expect(inputs.find((b) => b.name === "run_day")?.source).toEqual({ from: "input", inputId: "run_day" });
    expect(inputs.find((b) => b.name === "run_time")?.source).toEqual({ from: "input", inputId: "run_time" });
    expect(r.flow.holes.filter((h) => "port" in h.site && /^run_/.test(h.site.port))).toEqual([]);
  });

  it("CONTROL: with nothing recorded, the same ports are inputs a PERSON gives each run — nothing computes them", () => {
    const r = build(spec());
    expect(r.flow.inputs.length).toBe(2);
    expect(r.flow.inputs.every((x) => !("computed" in x) || !x.computed)).toBe(true);
  });

});

describe("a read the FLOW summarises returns its rows (2026-10-04: every count was 1)", () => {
  const s0: GoalSpec = { sources: [{ ref: "lib.new_read", quote: "the loans" }], sinks: [], values: [], conditions: [], schedule: null, missing: null,
    shapes: [{ over: "lib.new_read", stages: [{ op: "group", quote: "count the loans per branch", by: ["lib.new_read.branch"], measures: [{ fn: "count", field: null }], rows: true }] }] };
  it("the contract says so, and a summarising read is refused, naming it", () => {
    const c = readContract(s0, "lib.new_read", [GOAL]);
    expect(c.rows).toBe("count the loans per branch");
    expect(contractText(c)).toMatch(/returns the ROWS themselves/);
    expect(contractFindings(c, {}, undefined, true).join(" ")).toMatch(/return the rows, one per item/);
    expect(contractFindings(c, {}, undefined, false)).toEqual([]);
  });
  it("CONTROL: with no group over it, the read may summarise as its words say", () => {
    const c = readContract({ ...s0, shapes: [] }, "lib.new_read", [GOAL]);
    expect(c.rows).toBeUndefined();
    expect(contractFindings(c, {}, undefined, true)).toEqual([]);
  });
});
