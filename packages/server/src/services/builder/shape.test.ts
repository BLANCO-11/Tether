import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TypeOf as T, evaluate, lowerPipeline, withContext, type Comb } from "@foundry/flow-edit";
import { checkShapes, lowerShape, shapeReadback, stageNames, type Shape } from "./shape.js";
import { ORDERING_TESTS, VALUED_TESTS, quoted, quotedWord } from "./goal-spec.js";
import { condStages } from "./solver.js";

/**
 * Slice 5e — the spec's shape in the engine's own combinators. NAME-FREE (`r.a`, `t1`…): nothing here may know a domain.
 */
const GOAL = "per k1 count them and total v1, keep those over 10, largest first, top 3";
const ctx = (goal = GOAL) => ({
  sources: ["r"], fields: new Set(["r.k1", "r.v1", "r.v2", "r.d1", "r.e1"]), quoted: (q: string) => quoted(q, [goal]), quotedWord: (v: string) => quotedWord(v, [goal]),
  valued: VALUED_TESTS, ordering: ORDERING_TESTS, vague: (_v: string) => null,
  nullable: (f: string) => f === "r.v2" || f === "r.e1",
});
const ROWS = T.list(T.record({ k1: T.text(), v1: T.int(), v2: T.option(T.int()), d1: T.date(), e1: T.option(T.text()) }));
const SHAPE: Shape = { over: "r", stages: [
  { op: "group", quote: "per k1", by: ["r.k1"], measures: [{ fn: "count", field: null }, { fn: "sum", field: "r.v1" }] },
  { op: "filter", quote: "keep those over 10", field: "stage:0:1", test: "above", value: "10" },
  { op: "sort", quote: "largest first", field: "stage:0:1", dir: "desc" },
  { op: "limit", quote: "top 3", value: "3" },
] };
const lower = (sh: Shape, answers = new Map<number, string>()) => lowerShape(sh.stages, ROWS, { answers, valued: VALUED_TESTS, inputs: {}, filterStages: condStages });

describe("checkShapes — the code half", () => {
  it("keeps a well-formed shape", () => {
    const r = checkShapes([SHAPE], ctx());
    expect(r.dropped).toEqual([]);
    expect(r.shapes[0]!.stages).toHaveLength(4);
  });
  it("a stage whose quote is not the goal's words ends the shape there, stated", () => {
    const bad = { ...SHAPE, stages: [SHAPE.stages[0]!, { ...SHAPE.stages[1]!, quote: "keep the big ones" }, SHAPE.stages[2]!] };
    const r = checkShapes([bad], ctx());
    expect(r.shapes[0]!.stages).toHaveLength(1);
    expect(r.dropped[0]!.why).toMatch(/not in the goal/);
  });
  it("a stage ref must name an EARLIER stage's output", () => {
    const fwd = { over: "r", stages: [{ op: "sort" as const, quote: "largest first", field: "stage:1:0", dir: "desc" as const }] };
    expect(checkShapes([fwd], ctx()).shapes).toEqual([]);
  });
  it("a compared value the goal did not say is dropped; an unsaid one is kept empty (asked)", () => {
    const f = (value: string, goal = GOAL) => checkShapes([{ over: "r", stages: [{ op: "filter", quote: "keep those over 10", field: "r.v1", test: "above", value }] }], ctx(goal));
    expect(f("12").shapes).toEqual([]);
    expect(f("").shapes[0]!.stages[0]!.value).toBe("");
  });
  it("a shape over a reader the goal does not use is dropped", () => {
    expect(checkShapes([{ ...SHAPE, over: "other" }], ctx()).shapes).toEqual([]);
  });
});

describe("lowerShape — the engine's combinators, typed", () => {
  it("group → filter on a total → sort → limit types and lowers, with code's names", () => {
    expect(stageNames(SHAPE.stages)[0]).toEqual(["count", "sum_v1"]);
    const lo = lower(SHAPE);
    expect(lo.problems).toEqual([]);
    expect(lo.placed).toEqual([0, 1, 2, 3]);
    expect(lo.pipeline.map((c) => c.op)).toEqual(["group", "filter", "sort", "limit"]);
  });
  it("the evaluator and local jq agree on the lowered program", () => {
    const rows = [{ k1: "a", v1: 5 }, { k1: "a", v1: 7 }, { k1: "b", v1: 20 }, { k1: "c", v1: 3 }, { k1: "d", v1: 11 }, { k1: "e", v1: 30 }].map((r) => ({ ...r, v2: null, d1: "2026-01-01", e1: null }));
    const lo = lower(SHAPE);
    const ev = lo.pipeline.reduce<unknown>((acc, c) => evaluate(acc as never, c as Comb), rows) as Array<{ k1: string; sum_v1: number }>;
    expect(ev.map((r) => r.k1)).toEqual(["e", "b", "a"]);
    const jq = JSON.parse(execFileSync("jq", ["-c", withContext({}, () => lowerPipeline(ROWS, lo.pipeline))], { input: JSON.stringify(rows) }).toString()) as Array<{ k1: string }>;
    expect(jq.map((r) => r.k1)).toEqual(["e", "b", "a"]);
  });
  it("a stage that does not type is dropped and stated, never repaired (the average of a text field)", () => {
    const lo = lower({ over: "r", stages: [{ op: "group", quote: "per k1", by: ["r.k1"], measures: [{ fn: "avg", field: "r.e1" }] }] });
    expect(lo.placed).toEqual([]);
    expect(lo.problems[0]).toMatch(/per k1/);
  });
  it("a total over a field that may be empty is over the rows where it is present; an empty group key is narrowed and stated", () => {
    const lo = lower({ over: "r", stages: [{ op: "group", quote: "per k1", by: ["r.e1"], measures: [{ fn: "sum", field: "r.v2" }] }] });
    expect(lo.problems).toEqual([]);
    expect(lo.narrowed).toEqual(["e1"]);
  });
  it("an unsaid limit waits for the person's answer — then is theirs (provenance person)", () => {
    const sh: Shape = { over: "r", stages: [{ op: "limit", quote: "top 3", value: "" }] };
    expect(lower(sh).waiting).toEqual([0]);
    expect(lower(sh, new Map([[0, "4"]])).pipeline).toEqual([{ op: "limit", n: { value: 4, from: "person", quote: "top 3" } }]);
  });
  it("a field compared with another field", () => {
    const lo = lower({ over: "r", stages: [{ op: "filter", quote: "keep those over 10", field: "r.v1", test: "above", against: "r.v2" }] });
    expect(lo.pipeline).toEqual([{ op: "filter", where: { notNull: "v2" } }, { op: "filter", where: { cmp: "gt", left: { field: "v1" }, right: { field: "v2" } } }]);
  });
  it("NEGATIVE CONTROL: without the group stage, the filter on its total has nothing to read", () => {
    const lo = lower({ over: "r", stages: SHAPE.stages.slice(1) });
    expect(lo.placed).toEqual([]);
  });
});

describe("shapeReadback — written by code", () => {
  it("one line per stage, from the enums, code's names and the person's quoted words", () => {
    const lines = shapeReadback(SHAPE, VALUED_TESTS);
    expect(lines[0]).toBe("Groups the rows by `k1`, with the number of rows (as `count`), the total of `v1` (as `sum_v1`) — for “per k1”");
    expect(lines[1]).toBe("Keeps rows where `sum_v1` is above “10” — for “keep those over 10”");
    expect(lines[3]).toBe("Keeps the first “3” — for “top 3”");
  });
});

describe("agnostic", () => {
  it("shape.ts names no table, column, tool or workspace", () => {
    const src = readFileSync(fileURLToPath(new URL("./shape.ts", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src.length).toBeGreaterThan(2000);
    expect(src).not.toMatch(/"(?:[a-z]+_demo|incident|order|ticket|employee|invoice|customer)[^"]*"/i);
  });
});

describe("the gateway's 1000-enum limit (measured: shape-tuned-r1, 18 of 42 refused before the model saw them)", () => {
  it("the shape schema is bounded by the readers CHOSEN, not by the workspace: 2 readers × 60 fields, among 40 readers, stays under", async () => {
    const { shapeSchema } = await import("./goal-spec.js");
    const items = Array.from({ length: 40 }, (_, r) => ({ ref: `ds.r${r}`, kind: "reader" as const, about: "", fields: Array.from({ length: 60 }, (_, c) => ({ name: `c${c}`, ty: "Text" })) }));
    const count = (x: unknown): number => (Array.isArray(x) ? x.reduce((a: number, y) => a + count(y), 0) : x && typeof x === "object" ? Object.entries(x as Record<string, unknown>).reduce((a, [k, v]) => a + (k === "enum" && Array.isArray(v) ? v.length : count(v)), 0) : 0);
    expect(count(shapeSchema({ items }, ["ds.r0", "ds.r1"]))).toBeLessThan(1000);
  });
});

describe("a date or a month the words state is compared as one — by the engine and by the jq it compiles to (2026-10-01)", () => {
  const D = T.list(T.record({ id: T.int(), on: T.date(), at: T.dateTime() }));
  const rows = [
    { id: 1, on: "2026-06-19", at: "2026-06-19T23:30:00Z" }, { id: 2, on: "2026-06-20", at: "2026-06-20T08:00:00Z" },
    { id: 3, on: "2026-07-31", at: "2026-07-31T10:00:00Z" }, { id: 4, on: "2026-08-01", at: "2026-08-01T00:10:00Z" },
    { id: 5, on: "2026-08-31", at: "2026-08-31T23:59:00Z" }, { id: 6, on: "2026-09-01", at: "2026-09-01T09:00:00Z" },
  ];
  const ids = (field: "on" | "at", test: "below" | "equals" | "above", value: string, texts = ["…"]) => {
    const st = condStages(field, field === "on" ? T.date() : T.dateTime(), test, value, value, "goal", texts);
    if (typeof st === "string") return st;
    const ev = (st.reduce<unknown>((acc, c) => evaluate(acc as never, c as Comb), rows) as Array<{ id: number }>).map((r) => r.id);
    const jq = (JSON.parse(execFileSync("jq", ["-c", withContext({}, () => lowerPipeline(D, st))], { input: JSON.stringify(rows) }).toString()) as Array<{ id: number }>).map((r) => r.id);
    expect(jq).toEqual(ev);
    return ev;
  };
  it("an ISO day — on a date, and on a moment by its calendar day (Step 4: words are never mined)", () => {
    expect(ids("on", "below", "2026-06-20")).toEqual([1]);
    expect(ids("at", "below", "2026-06-20")).toEqual([1]);
    // Words are refused by name, never compared raw.
    expect(ids("on", "below", "20 june 2026")).toBe("“20 june 2026” is not a date");
    expect(ids("on", "below", "20 june", ["promised before 20 june, in 2026"])).toBe("“20 june” is not a date");
  });
  it("a MONTH in words is refused by name — only an ISO day compares (Step 4)", () => {
    expect(ids("on", "equals", "2026-08-01")).toEqual([4]);
    expect(ids("at", "equals", "2026-08-01")).toEqual([4]);
    expect(ids("on", "below", "august 2026")).toBe("“august 2026” is not a date");
    expect(ids("on", "above", "august 2026")).toBe("“august 2026” is not a date");
  });
  it("CONTROL: words that are no date are refused by name, never compared raw", () => {
    expect(ids("on", "below", "the busy season")).toBe("“the busy season” is not a date");
  });
});
