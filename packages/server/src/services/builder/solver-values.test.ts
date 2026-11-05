/**
 * Through the solver: the goal's words are bound as the VALUE the port takes (2026-10-01). Neutral catalogue (`store.staff`) —
 * the declared types and the column's known values at work, never a datasource's names.
 */
import { describe, expect, it } from "vitest";
import { SYNTHETIC, emptyFlow, TypeOf as T, type CatalogueSnapshot, type EFlow } from "@foundry/flow-edit";
import { solve } from "./solver.js";
import { checkSpec, type BuilderCatalogue, type GoalSpec } from "./goal-spec.js";

const cat: CatalogueSnapshot = {
  ...SYNTHETIC,
  refs: {
    ...SYNTHETIC.refs,
    "store.staff": {
      kind: "operation",
      params: [
        { name: "from_date", ty: T.date(), required: true },
        { name: "status", ty: T.text([{ r: "OneOf", values: ["Active", "Terminated"] }]), required: true },
      ],
      payload: T.rows(T.record({ name: T.text(), email: T.address() })),
    },
  },
};
const ITEMS: BuilderCatalogue = {
  items: Object.entries(cat.refs).map(([ref, r]) => ({ ref, kind: r.kind === "tool" ? ("tool" as const) : ("reader" as const), about: ref, params: r.params.map((p) => ({ name: p.name, about: "" })), fields: [] })),
};
const spec = (dateQuote: string, statusQuote: string): GoalSpec => ({
  sources: [{ ref: "store.staff", quote: "the staff" }],
  sinks: [{ ref: "notify_me", quote: "send me" }],
  values: [
    { role: "date", from: "goal", quote: dateQuote, fills: "store.staff.from_date" },
    { role: "other", from: "goal", quote: statusQuote, fills: "store.staff.status" },
  ],
  conditions: [],
  schedule: null,
  missing: null,
});
const build = (goal: string, d: string, st: string) => solve(emptyFlow("t"), { spec: checkSpec(spec(d, st), [goal], ITEMS), cat, answers: new Map(), base: [] });
const bound = (f: EFlow, port: string) => (f.steps.find((s) => s.kind === "datasource") as { inputs: Array<{ name: string; source: unknown }> }).inputs.find((b) => b.name === port)?.source;

describe("the goal's words as values", () => {

  it("CONTROL: words with no one reading are left a question — never bound raw", () => {
    const r = build("send me the staff from 1 August who are current staff", "1 August", "current staff");
    expect(bound(r.flow, "from_date")).toBeUndefined();
    expect(bound(r.flow, "status")).toBeUndefined();
  });


  it("CONTROL: words already the value are bound as written", () => {
    const r = build("send me the staff from 2026-08-01 who are Active", "2026-08-01", "Active");
    expect(bound(r.flow, "from_date")).toMatchObject({ value: "2026-08-01" });
    expect(bound(r.flow, "status")).toMatchObject({ value: "Active" });
  });
});

describe("a stated PERIOD gives both ends of a read's range (2026-10-01, H02)", () => {
  const rcat: CatalogueSnapshot = { ...SYNTHETIC, refs: { ...SYNTHETIC.refs, "store.leave": { kind: "operation", params: [
    { name: "start_date", ty: T.date(), required: true, edge: "ge" }, { name: "end_date", ty: T.date(), required: true, edge: "le" },
  ], payload: T.rows(T.record({ name: T.text() })) } } } as CatalogueSnapshot;
  const items: BuilderCatalogue = { items: Object.entries(rcat.refs).map(([ref, r]) => ({ ref, kind: r.kind === "tool" ? ("tool" as const) : ("reader" as const), about: ref, params: r.params.map((p) => ({ name: p.name, about: "" })), fields: [] })) };
  const run = (quote: string, fills: string, more: GoalSpec["values"] = []) => {
    const goal = `send me the leave for ${quote}`;
    const s: GoalSpec = { sources: [{ ref: "store.leave", quote: "the leave" }], sinks: [{ ref: "notify_me", quote: "send me" }], values: [{ role: "period", from: "goal", quote, fills }, ...more], conditions: [], schedule: null, missing: null };
    const f = solve(emptyFlow("t"), { spec: checkSpec(s, [goal], items), cat: rcat, answers: new Map(), base: [] }).flow;
    const read = f.steps.find((x) => x.kind === "datasource") as { inputs: Array<{ name: string; source: unknown }> };
    return (port: string) => read.inputs.find((b) => b.name === port)?.source;
  };
  it("CONTROL: one stated DAY is one end — the other is still the person's to say", () => {
    expect(run("1 august 2026", "store.leave.end_date")("start_date")).not.toMatchObject({ from: "literal" });
  });
});

describe("an EDIT that narrows rows the flow already reads attaches its test to that reader (2026-10-01, H11)", () => {
  // The automation as it is ALREADY filters its rows — the edit's test must be a list of its own, not that filter.
  const first = solve(emptyFlow("t"), { spec: { spec: { ...spec("1 August", "active staff"), shapes: [{ over: "store.staff", stages: [{ op: "filter", quote: "named Bo", field: "store.staff.name", test: "equals", value: "Bo" }] }] }, dropped: [], texts: ["send me the staff from 1 August, 2026 who are active staff named Bo"] } as never, cat, answers: new Map(), base: [] }).flow;
  const edit = (shapes: GoalSpec["shapes"]) => {
    const s: GoalSpec = { sources: [], sinks: [], values: [], conditions: [], schedule: null, missing: null, shapes };
    return solve(first, { spec: { spec: s, dropped: [], texts: ["only the ones named Ann"] } as never, cat, answers: new Map(), base: first.steps.map((x) => ({ kind: x.kind, id: x.id, ...("ref" in x && x.ref ? { ref: x.ref } : {}) })) }).flow;
  };
  const filters = (f: EFlow) => f.steps.filter((x) => x.kind === "transform").length;
  it("a shape over the existing reader is built, with no new source — beside the filter already there", () => {
    expect(filters(first)).toBeGreaterThan(0);
    expect(filters(edit([{ over: "store.staff", stages: [{ op: "filter", quote: "named Ann", field: "store.staff.name", test: "equals", value: "Ann" }] }]))).toBeGreaterThan(filters(first));
  });
  it("CONTROL: a shape over a reader the flow does not have attaches to nothing", () => {
    expect(filters(edit([{ over: "store.other", stages: [{ op: "filter", quote: "named Ann", field: "store.other.name", test: "equals", value: "Ann" }] }]))).toBe(filters(first));
  });
});

describe("a run input on a flow nothing can give one to (a schedule) — never an empty input (2026-10-01, O03)", () => {
  const sched = (quote: string) => {
    const goal = `every day at 9 send me the staff from ${quote} who are active staff`;
    const s: GoalSpec = { ...spec("x", "active staff"), values: [{ role: "date", from: "flow_input", quote, fills: "store.staff.from_date", ...(quote === "today" ? { relative: "today" as const } : {}) }, { role: "other", from: "goal", quote: "active staff", fills: "store.staff.status" }], schedule: { cron: "0 9 * * *", quote: "every day at 9" } };
    return solve(emptyFlow("t"), { spec: checkSpec(s, [goal], ITEMS), cat, answers: new Map(), base: [] }).flow;
  };
  // The plan chooses “today” from its closed list (`relative`); code never matches the words (phase 5 deleted `RUN_WORDS`).
  it("“today”, chosen as relative to the run date, is the day it runs, worked out when it runs", () => {
    const f = sched("today");
    const src = bound(f, "from_date") as { from: string; inputId: string };
    expect(src.from).toBe("input");
    expect(f.inputs.find((i) => i.id === src.inputId)).toMatchObject({ computed: "currentDate" });
  });
  it("CONTROL: words naming no run-time value stay the port's question — never an optional input with no default", () => {
    const f = sched("the usual day");
    expect(f.inputs.some((i) => i.required === false && i.defaults === undefined && i.computed === undefined)).toBe(false);
    expect(f.holes.map((h) => h.id)).toContain("h_read_1_from_date");
  });
});
