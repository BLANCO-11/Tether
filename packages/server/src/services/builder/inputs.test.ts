/**
 * builder-inputs phase 1 (P1-D1…D6): an input is a part of the plan, separate from whether its value is known; code places it (a flow
 * filter, a reader's parameter, a written read's parameter) and the build is judged complete on the BUILT flow. Each rule has a control
 * (the switch off, or the case the rule must leave alone) and the end-to-end cases run the real solver, the real lowering and the real
 * spec match over the engine's name-free synthetic catalogue.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyFlow, SYNTHETIC as cat, type CatalogueSnapshot } from "@foundry/flow-edit";
import { checkSpec, readback, type BuilderCatalogue, type GoalSpec } from "./goal-spec.js";
import { solve } from "./solver.js";
import { lowerPipelinesWith } from "../flow-pipeline.js";
import { fieldTyIn, specMatch } from "./spec-match.js";
import { endForPort, testFor, type SpecInput } from "./inputs.js";
import { clauses, inputFindings, planSchema, planToSpec, type Plan } from "./plan.js";
import { readContract } from "./read-contract.js";
import { enumCount, ENUM_BUDGET, schemaProblem } from "./strict-schema.js";

const on = () => { process.env.BUILDER_INPUTS = "1"; };
const off = () => { delete process.env.BUILDER_INPUTS; };

describe("an input's canonical form (equivalences, by code)", () => {
  it("a test against an input takes the comparison its kind allows", () => {
    expect(testFor("date_range", "within_days")).toBe("equals"); // R2, 2026-10-04: a span is the days IN it, whatever was written
    expect(testFor("date", "date_passed")).toBe("below");
    expect(testFor("number", "below")).toBe("below");
    expect(testFor("text", "below")).toBeNull(); // CONTROL: a text has no order
  });
});

describe("a value relative to the run date, at a parameter's own end", () => {
  it("a month is the engine's month, a month-compared date its first day; a span's ends follow the parameter's comparison", () => {
    expect(endForPort("last_month", undefined, "single", "month")?.computed).toBe("priorMonth");
    expect(endForPort("last_month", undefined, "single", "month_date")?.computed).toBe("priorMonthStart");
    expect(endForPort("last_week", undefined, "start", "date", "ge")).toMatchObject({ computed: "currentDate", offsetDays: -7 });
    // "before the run day" on an on-or-before end is the day before it runs; "on or before it" on a before end is the day after.
    expect(endForPort("last_week", undefined, "end", "date", "le")?.computed).toBe("priorDate");
    expect(endForPort("today", undefined, "end", "date", "lt")).toMatchObject({ computed: "currentDate", offsetDays: 1 });
  });
  it("N days ago is that one day; the next N days run from the run day to N days after it (B04, B20)", () => {
    expect(endForPort("days_ago", 3, "single", "date")).toMatchObject({ computed: "currentDate", offsetDays: -3 });
    expect(endForPort("next_n_days", 7, "start", "date", "ge")).toMatchObject({ computed: "currentDate" });
    expect(endForPort("next_n_days", 7, "end", "date", "le")).toMatchObject({ computed: "currentDate", offsetDays: 7 });
    expect(endForPort("next_n_days", undefined, "end", "date", "le")).toBeNull(); // CONTROL: no count, no end
  });
  it("an end the engine cannot compute is null — stated, never approximated", () => {
    expect(endForPort("last_month", undefined, "end", "date", "le")).toBeNull(); // the day before the month starts
    expect(endForPort("last_month", undefined, "end", "date", "lt")?.computed).toBe("currentMonthStart"); // CONTROL: before it is fine
  });
});

const CAT: BuilderCatalogue = { items: [
  { ref: "ds.items", kind: "reader", about: "items", fields: [{ name: "due", ty: "Date" }, { name: "amount", ty: "Number" }] },
  { ref: "ds.new_read", kind: "reader", about: "a new read" },
  { ref: "tether_email_send", kind: "tool", about: "email", params: [{ name: "to", about: "" }] },
] };
const G = "for each item between two dates email me";
const CS = clauses(G);
const plan = (p: Partial<Plan>): Plan => ({ sources: [{ ref: "ds.items", clauses: ["C1"] }], each: null, rows: [], schedule: null, conditions: [], actions: [], values: [], missing: "", joining: [], ...p });
const RANGE = { id: "in_a", kind: "date_range" as const, words: "between two dates", fill: "each_run" as const, clauses: ["C1"] };

describe("the plan with inputs (switch on)", () => {
  beforeEach(on); afterEach(off);
  it("offers inputs and lets a test name one — still in the strict subset and the enum budget; CONTROL: off, neither exists", () => {
    const s = planSchema(CAT, CS);
    expect(schemaProblem(s)).toBeNull();
    expect(enumCount(s)).toBeLessThan(ENUM_BUDGET);
    expect(JSON.stringify(s)).toContain("\"inputs\"");
  });
  it("an input a test on a listed field names is a FLOW input; the stage names it, never its words", () => {
    const p = plan({ inputs: [RANGE], rows: [{ clauses: ["C1"], field: "ds.items.due", about: "", test: "within_days", value: "", input: "in_a" }] });
    const { spec } = planToSpec(p, CS, CAT, G);
    expect(spec.inputs).toEqual([expect.objectContaining({ id: "in_a", at: "flow" })]);
    expect(spec.shapes?.[0]?.stages[0]).toMatchObject({ test: "within_days", value: "input:in_a" });
    expect(spec.values.some((v) => v.input)).toBe(false); // a flow input travels in its stage, never as a value
  });
  it("with a read written for the goal, an untested input is a parameter OF that read — whether or not its value is known", () => {
    const p = plan({ sources: [{ ref: "ds.new_read", clauses: ["C1"] }], inputs: [RANGE] });
    const { spec } = planToSpec(p, CS, CAT, G);
    expect(spec.inputs?.[0]?.at).toBe("read");
    const c = readContract(spec, "ds.new_read", [G]);
    expect(c.params.map((x) => [x.name, x.type, x.end])).toEqual([["period_start", "date", "start"], ["period_end", "date", "end"]]);
    // CONTROL — the root cause, measured: with the switch off the same "given each run" value makes NO parameter (2026-10-03, C2).
  });
  it("an input a test on EACH ITEM names is the flow's, even when the field comes from the written read — never also a read parameter (2026-10-04)", () => {
    const N = { id: "in_a", kind: "number" as const, words: "over 100", fill: "given" as const, clauses: ["C1"] };
    const item = { clauses: ["C1"], over: "each_item" as const, where: [{ field: "new_read", about: "the amount", test: "above" as const, value: "", input: "in_a" }], count: null };
    const p = plan({ sources: [{ ref: "ds.new_read", clauses: ["C1"] }], each: { over: 0, clauses: ["C1"] }, inputs: [N], conditions: [item], actions: [{ ref: "tether_email_send", clauses: ["C1"], on: "if:0", per_item: true, approve_first: null, recipient: { from: "requester", words: "me" } }] });
    const { spec } = planToSpec(p, CS, CAT, G);
    expect(spec.inputs?.[0]?.at).toBe("flow");
    expect(readContract(spec, "ds.new_read", [G]).params).toEqual([]);
    // CONTROL: the same input with no test on it is the read's parameter
    const q = plan({ sources: [{ ref: "ds.new_read", clauses: ["C1"] }], inputs: [N] });
    expect(planToSpec(q, CS, CAT, G).spec.inputs?.[0]?.at).toBe("read");
  });
  it("a month given each run on a written read is ONE month parameter, and the readback says any day of it will do; CONTROL: a span says neither", () => {
    const month = { ...RANGE, kind: "month" as const, words: "a given month" };
    const { spec } = planToSpec(plan({ sources: [{ ref: "ds.new_read", clauses: ["C1"] }], inputs: [month] }), CS, CAT, G);
    expect(readContract(spec, "ds.new_read", [G]).params.map((x) => [x.name, x.type])).toEqual([["period", "month"]]);
    const said = (sp: GoalSpec) => readback(checkSpec(sp, [G], CAT), CAT).join("\n");
    expect(said(spec)).toMatch(/“a given month”, given each time it runs — as any day of that month \(only its month is used\)/);
    const { spec: span } = planToSpec(plan({ sources: [{ ref: "ds.new_read", clauses: ["C1"] }], inputs: [RANGE] }), CS, CAT, G);
    expect(said(span)).not.toMatch(/any day of that month/);
  });
  it("an input given each run on a SCHEDULED flow is a finding (nobody starts it to give one); CONTROL: unscheduled, none", () => {
    const p = plan({ schedule: { cron: "0 9 * * 5", clauses: ["C1"] }, rows: [{ clauses: ["C1"], field: "ds.items.due", about: "", test: "equals", value: "", input: "in_a" }], inputs: [RANGE] });
    expect(inputFindings(p).join(" ")).toMatch(/given each time it runs, and the automation runs on a schedule/);
    expect(inputFindings({ ...p, schedule: null }).join(" ")).not.toMatch(/schedule/);
  });
  it("“older than 3 days” on a written read is a DATE it takes, 3 days before the run day — never a number (B20)", () => {
    const p = plan({ sources: [{ ref: "ds.new_read", clauses: ["C1"] }], rows: [{ clauses: ["C1"], field: "new_read", about: "when it was opened", test: "older_than_days", value: "3" }] });
    const { spec } = planToSpec(p, CS, CAT, G);
    expect(spec.inputs).toEqual([expect.objectContaining({ kind: "date", fill: "from_run_date", relative: "days_ago", days: 3, at: "read" })]);
    expect(readContract(spec, "ds.new_read", [G]).params.map((x) => [x.name, x.type])).toEqual([["as_of", "date"]]);
  });
  it("findings: an input no test, reader or read takes; a test naming an input that does not exist; a whole-list test guarding a per-item action", () => {
    expect(inputFindings(plan({ inputs: [RANGE] })).join(" ")).toMatch(/input in_a .* is used by nothing/);
    expect(inputFindings(plan({ inputs: [RANGE], rows: [{ clauses: ["C1"], field: "ds.items.due", about: "", test: "equals", value: "", input: "in_a" }] }))).toEqual([]); // CONTROL
    expect(inputFindings(plan({ rows: [{ clauses: ["C1"], field: "ds.items.due", about: "", test: "equals", value: "", input: "in_b" }] })).join(" ")).toMatch(/in_b, which is not in `inputs`/);
    const guard = (over: Plan["conditions"][number]["over"], perItem: boolean) => inputFindings(plan({ each: { over: 0, clauses: ["C1"] }, conditions: [{ clauses: ["C1"], over, where: [], count: null }],
      actions: [{ ref: "tether_email_send", clauses: ["C1"], on: "if:0", per_item: perItem, approve_first: null, recipient: { from: "requester", words: "me" } }] }));
    expect(guard("any_row", true).join(" ")).toMatch(/runs for each item, and condition 0 .* tests nothing about the item/); // B1
    expect(guard("any_row", false)).toEqual([]); // CONTROL: "if there are any, email me" — one action, the whole list
  });
});

// ── End to end over the synthetic catalogue: the real solver, the real lowering, the real spec match ──────────────────────────────
const fieldsOf = (r: CatalogueSnapshot["refs"][string]) => (r.kind === "tool" ? [] : Object.keys((r.payload as { of: { fields: Record<string, unknown> } }).of.fields).map((name) => ({ name, ty: "" })));
const ITEMS: BuilderCatalogue = { items: Object.entries(cat.refs).map(([ref, r]) => ({ ref, kind: r.kind === "tool" ? ("tool" as const) : ("reader" as const), about: ref, params: r.params.map((p) => ({ name: p.name, about: "" })), fields: fieldsOf(r) })) };
const GOAL = "send me the widgets as of 2026-06-30 due between two dates";
const W: Partial<GoalSpec> = { sources: [{ ref: "store.widgets", quote: "the widgets" }], sinks: [{ ref: "notify_me", quote: "send me" }], values: [{ role: "date", from: "goal", quote: "2026-06-30", fills: "store.widgets.as_of" }, { role: "recipient", from: "requester", quote: "me", fills: "notify_me.to" }] };
const flowInput = (i: Partial<SpecInput>): SpecInput => ({ id: "in_a", kind: "date_range", words: "between two dates", fill: "each_run", at: "flow", ...i });
const built = (inp: SpecInput, extra: Partial<GoalSpec> = {}) => {
  const checked = checkSpec({ sources: [], sinks: [], values: [], conditions: [], schedule: null, missing: null, ...W, inputs: [inp],
    shapes: [{ over: "store.widgets", stages: [{ op: "filter", quote: "due between two dates", field: "store.widgets.due", test: "equals", value: `input:${inp.id}` }] }], ...extra }, [GOAL], ITEMS);
  const r = solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [] });
  return { r, checked, model: lowerPipelinesWith(r.flow as never, cat) as never as Parameters<typeof specMatch>[0] };
};

describe("end to end: a flow filter against an input (switch on)", () => {
  beforeEach(on); afterEach(off);
  it("a span given each run is two run inputs, both read by the filter; the spec match reads them from the jq that runs", () => {
    const { r, checked, model } = built(flowInput({}));
    expect(r.unmet).toEqual([]);
    expect(r.flow.inputs.map((i) => [i.id, i.type])).toEqual(expect.arrayContaining([["start_date", "DATE"], ["end_date", "DATE"]]));
    const expr = model.steps.find((s) => s.kind === "transform")?.expr ?? "";
    expect(expr).toContain("(.due >= ' ~ (inputs.start_date | toJson) ~ ')");
    expect(expr).toContain("(.due <= ' ~ (inputs.end_date | toJson) ~ ')");
    const stored = { goalSpec: { spec: checked.spec }, trace: { base: [] } };
    expect(specMatch(model, stored, undefined, fieldTyIn(cat.refs))).toEqual([]);
    // NEGATIVE CONTROL: a lowering that makes the last day exclusive is refused, read from what runs.
    const perturbed = { ...model, steps: model.steps.map((s) => (s.expr ? { ...s, expr: s.expr.replace("(.due <= ' ~ (inputs.end_date", "(.due < ' ~ (inputs.end_date") } : s)) };
    expect(specMatch(perturbed, stored, undefined, fieldTyIn(cat.refs)).join(" ")).toMatch(/`due` <= the run input `end_date` .* no step of the flow applies that/);
  });
  it("a month given each run is ONE date, read by its month: the field's month equals the input's; the spec match reads it from the jq", () => {
    const { r, checked, model } = built(flowInput({ kind: "month", words: "a given month" }));
    expect(r.unmet).toEqual([]);
    expect(r.flow.inputs.filter((i) => !i.computed).map((i) => [i.id, i.type])).toEqual([["month", "DATE"]]); // CONTROL vs span: one, not two
    const expr = model.steps.find((s) => s.kind === "transform")?.expr ?? "";
    expect(expr).toContain("(.due_month == (' ~ (inputs.month | toJson) ~ ' | tostring | .[0:7]))");
    const stored = { goalSpec: { spec: checked.spec }, trace: { base: [] } };
    expect(specMatch(model, stored, undefined, fieldTyIn(cat.refs))).toEqual([]);
    // NEGATIVE CONTROL: a lowering that compares the input's whole DAY (not its month) is refused, read from what runs.
    const perturbed = { ...model, steps: model.steps.map((s) => (s.expr ? { ...s, expr: s.expr.replace("| tostring | .[0:7]))", "| tostring | .[0:10]))") } : s)) };
    expect(specMatch(perturbed, stored, undefined, fieldTyIn(cat.refs)).join(" ")).toMatch(/`due_month` == the run input `month` .* no step of the flow applies that/);
    expect(readback(checked, ITEMS).join("\n")).toMatch(/any day of that month \(only its month is used\)/);
  });
  it("last month, worked out when it runs: on or after the first day of the month before, before the first day of this one", () => {
    const { r, checked, model } = built(flowInput({ fill: "from_run_date", relative: "last_month", kind: "month", words: "last month" }));
    expect(r.unmet).toEqual([]);
    expect(r.flow.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ id: "prior_month_start", computed: "priorMonthStart" }), expect.objectContaining({ id: "month_start", computed: "currentMonthStart" })]));
    expect(specMatch(model, { goalSpec: { spec: checked.spec }, trace: { base: [] } }, undefined, fieldTyIn(cat.refs))).toEqual([]);
  });
});

describe("end to end: a span on a reader with two ends (switch on)", () => {
  beforeEach(on); afterEach(off);
  // A reader declaring a start (on or after) and an end (on or before) — the shape a read written for "between two dates" has.
  const span = { ...cat.refs["store.widgets"]!, params: [{ ...cat.refs["store.widgets"]!.params[0]!, name: "period_start", edge: "ge" as const }, { ...cat.refs["store.widgets"]!.params[0]!, name: "period_end", edge: "le" as const }] };
  const cat2: CatalogueSnapshot = { ...cat, refs: { ...cat.refs, "store.span": span } };
  const items2: BuilderCatalogue = { items: [...ITEMS.items, { ref: "store.span", kind: "reader", about: "store.span", params: [{ name: "period_start", about: "" }, { name: "period_end", about: "" }], fields: fieldsOf(span) }] };
  const run = (inp: SpecInput, known: Array<{ ref: string; port: string; value: string; stepId: string }> = []) => {
    const checked = checkSpec({ sources: [{ ref: "store.span", quote: "the widgets" }], sinks: [], values: [{ role: "period", from: "flow_input", quote: inp.words, fills: "store.span.period_start", input: inp.id }], conditions: [], schedule: null, missing: null, inputs: [inp] }, ["the widgets for the dates I choose each run"], items2);
    return solve(emptyFlow("t"), { spec: checked, cat: cat2, answers: new Map(), base: [], known } as never);
  };
  const reader = (r: ReturnType<typeof solve>) => r.flow.steps.find((st) => (st as { ref?: string }).ref === "store.span") as { inputs: Array<{ name: string; source: unknown }> };
  it("a span mapped to ONE end is both ends — never the other end's date given before (C1, 2026-10-04); CONTROL: a single date stays one end", () => {
    const r = run({ id: "in_a", kind: "date_range", words: "the dates I choose", fill: "each_run", fills: "store.span.period_start", at: "reader" }, [{ ref: "store.span", port: "period_end", value: "2026-09-15", stepId: "old_read" }]);
    expect(reader(r).inputs.map((b) => [b.name, (b.source as { from: string }).from])).toEqual([["period_start", "input"], ["period_end", "input"]]);
    expect(r.unmet).toEqual([]);
    const one = run({ id: "in_a", kind: "date", words: "the date I choose", fill: "each_run", fills: "store.span.period_start", at: "reader" }, [{ ref: "store.span", port: "period_end", value: "2026-09-15", stepId: "old_read" }]);
    expect(reader(one).inputs.find((b) => b.name === "period_end")?.source).toEqual({ from: "literal", value: "2026-09-15" });
  });
});

describe("end to end: a reader parameter worked out from the run date (switch on)", () => {
  beforeEach(on); afterEach(off);
  const monthly = (relative?: "last_month") => {
    const v = { role: "period" as const, from: "flow_input" as const, quote: "last month", fills: "store.by_month.period", input: "in_a", ...(relative ? { relative } : {}) };
    const checked = checkSpec({ sources: [{ ref: "store.by_month", quote: "the totals" }], sinks: [], values: [v], conditions: [], schedule: null, missing: null,
      inputs: [{ id: "in_a", kind: "month", words: "last month", fill: relative ? "from_run_date" : "each_run", ...(relative ? { relative } : {}), fills: "store.by_month.period", at: "reader" }] }, ["the totals for last month"], ITEMS);
    return solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [] });
  };
  it("“last month” is the engine's month before it runs — chosen, never matched from the words", () => {
    const r = monthly("last_month");
    expect(r.flow.inputs).toEqual([expect.objectContaining({ id: "prior_month", computed: "priorMonth" })]);
    expect(r.unmet).toEqual([]);
  });
  it("CONTROL: the same words with no relative value named are asked each run (a plain run input)", () => {
    const r = monthly();
    expect(r.flow.inputs.map((i) => i.computed)).toEqual([undefined]);
  });
});

describe("completeness, judged on the built flow (switch on)", () => {
  beforeEach(on); afterEach(off);
  it("an input nothing takes is unmet — never a complete flow doing less", () => {
    const { r } = built(flowInput({}), { shapes: [] });
    expect(r.unmet.join(" ")).toMatch(/the input “between two dates” is used by nothing built/);
  });
  it("a reader's input no port takes is unmet — judged on the flow's ports; CONTROL: bound, it is not", () => {
    const run = (withValue: boolean) => {
      const inp: SpecInput = { id: "in_a", kind: "month", words: "last month", fill: "from_run_date", relative: "last_month", fills: "store.by_month.period", at: "reader" };
      const v = { role: "period" as const, from: "flow_input" as const, quote: "last month", fills: "store.by_month.period", input: "in_a", relative: "last_month" as const };
      const checked = checkSpec({ sources: [{ ref: "store.by_month", quote: "the totals" }], sinks: [], values: withValue ? [v] : [], conditions: [], schedule: null, missing: null, inputs: [inp] }, ["the totals for last month"], ITEMS);
      return solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [] }).unmet.join(" ");
    };
    expect(run(false)).toMatch(/the input “last month” is used by nothing built/);
    expect(run(true)).not.toMatch(/used by nothing built/);
  });
  it("a part the plan could not lower is unmet; CONTROL: off, the same spec reports neither", () => {
    expect(built(flowInput({}), { planGaps: ["the test “x” on each item is not built"] }).r.unmet).toContain("the test “x” on each item is not built");
  });
});

describe("“more than N days ago” with N stated as an input (E01, v5) — the list is built, and N survives normalising", () => {
  it("a date older than a GIVEN “2 days”: the filter reads 2 days before the run, declared, and the spec match agrees", () => {
    const inp = flowInput({ kind: "number", words: "2 days", fill: "given" });
    const checked = checkSpec({ sources: [], sinks: [], values: [], conditions: [], schedule: null, missing: null, ...W, inputs: [inp],
      shapes: [{ over: "store.widgets", stages: [{ op: "filter", quote: "due more than 2 days ago", field: "store.widgets.due", test: "older_than_days", value: `input:${inp.id}` }] }] }, [GOAL, "due more than 2 days ago"], ITEMS);
    const r = solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [] });
    expect(r.unmet.join(" ")).not.toMatch(/no flow input/);
    expect(r.flow.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ id: "days_before_2", computed: "currentDate", offsetDays: -2 })]));
    expect(r.flow.steps.some((s) => s.kind === "transform" && JSON.stringify(s).includes("days_before_2"))).toBe(true);
  });
});
