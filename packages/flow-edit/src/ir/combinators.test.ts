/**
 * Combinator slice 1 (compiled-builder 2d): typing, evaluation, and the admission kit against LOCAL jq.
 * Local jq is the fast inner loop; Kestra (jackson-jq) is the authority, in `kestra-combinators.ts`.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { T, assignable } from "../typecheck/types.js";
import { admit, fixtureGaps, type JqRunner } from "./admission.js";
import { evaluate, evaluatePipeline, jqLit, lowerPipeline, typePipeline, withContext, type Pipeline } from "./combinators.js";
import { SLICE_1_CASES } from "./fixtures.js";

/** Local jq, with each input sentinel replaced by the value's JSON literal — what the engine's `toJson` splice produces. */
const localJq: JqRunner = async (program, input, c) => {
  const p = program.replace(/__FOUNDRY_INPUT_([A-Za-z_][A-Za-z0-9_]*)__/g, (_m, id: string) => JSON.stringify(c.inputs?.[id]?.value ?? null));
  return JSON.parse(execFileSync("jq", ["-c", p], { input: JSON.stringify(input) }).toString());
};

const ROWS = T.list(T.record({ id: T.int(), email: T.option(T.address()), rate: T.number(), on: T.date() }));
const typeErr = (p: Pipeline) => { const r = typePipeline(ROWS, p); return r.ok ? null : r.error; };

describe("typing — the preconditions ARE the guarantee", () => {
  it("refuses a comparison on a value that may be null (jq would order null below every number)", () => {
    expect(typeErr([{ op: "filter", where: { cmp: "lt", left: { field: "email" }, right: { lit: { value: "a", from: "test" } } } }])).toMatch(/may be null/);
  });
  it("refuses a template over a nullable field (jq would print \"null\")", () => {
    expect(typeErr([{ op: "template", as: "t", parts: [{ field: "email" }] }])).toMatch(/may be null/);
  });
  it("accepts it once notNull has narrowed the field", () => {
    expect(typeErr([{ op: "filter", where: { notNull: "email" } }, { op: "template", as: "t", parts: [{ field: "email" }] }])).toBeNull();
  });
  it("names a field the rows do not have, with the ones they do", () => {
    expect(typeErr([{ op: "project", fields: [{ name: "x", from: "nope" }] }])).toMatch(/no field "nope".*id, email, rate, on/);
  });
  it("refuses comparing a number with text, and a date column with a non-date literal", () => {
    expect(typeErr([{ op: "filter", where: { cmp: "eq", left: { field: "rate" }, right: { lit: { value: "80", from: "test" } } } }])).toMatch(/cannot compare/);
    expect(typeErr([{ op: "filter", where: { cmp: "lt", left: { field: "on" }, right: { lit: { value: "last month", from: "test" } } } }])).toMatch(/not a date/);
    expect(typeErr([{ op: "filter", where: { cmp: "lt", left: { field: "on" }, right: { lit: { value: "2026-06-30", from: "test" } } } }])).toBeNull();
  });
  it("refuses a null test on a field that is never null (the test would be constant)", () => {
    expect(typeErr([{ op: "filter", where: { isNull: "id" } }])).toMatch(/never null/);
  });
  it("refuses count on a single record and join_text on a record", () => {
    expect(typeErr([{ op: "count", as: "n" }, { op: "count", as: "m" }])).toMatch(/count needs rows/);
  });
});

describe("lowering safety", () => {
  it("a literal can never close the Pebble single-quoted string", () => {
    expect(jqLit("O'Brien")).toBe('"O\\u0027Brien"');
    expect(lowerPipeline(ROWS, [{ op: "project", fields: [{ name: "it's", from: "id" }] }])).not.toContain("'");
  });
  it("an ill-typed pipeline cannot be lowered", () => {
    expect(() => lowerPipeline(ROWS, [{ op: "template", as: "t", parts: [{ field: "email" }] }])).toThrow(/ill-typed/);
  });
});

describe("engine semantics the kit encodes", () => {
  it("equality is modulo null-valued keys — the engine cannot represent a present null", async () => {
    const { engineEqual, sameJson } = await import("./admission.js");
    expect(sameJson([{ a: 1, e: null }], [{ a: 1 }])).toBe(false);
    expect(engineEqual([{ a: 1, e: null }], [{ a: 1 }])).toBe(true);
    expect(engineEqual([{ a: 1, e: "x" }], [{ a: 1 }])).toBe(false);
  });
  it("a lowering may not test key presence", async () => {
    const { assertLoweringVocabulary } = await import("./combinators.js");
    expect(() => assertLoweringVocabulary("map(has(\"email\"))")).toThrow(/banned/);
    expect(() => assertLoweringVocabulary("to_entries")).toThrow(/banned/);
    expect(() => assertLoweringVocabulary('map(select(.name == "has keys"))')).not.toThrow();
  });
});

describe("the admission kit, against local jq", () => {
  it("the fixture set satisfies the kit's own rules (an empty case, a null)", () => {
    expect(fixtureGaps(SLICE_1_CASES)).toEqual([]);
  });
  it("every slice-1 case: lowering on jq == evaluator", async () => {
    const r = await admit(SLICE_1_CASES, localJq);
    expect(r.results.filter((x) => !x.ok)).toEqual([]);
    expect(r.admitted).toBe(true);
  });
  it("⚠ NEGATIVE CONTROL: a deliberately wrong lowering is refused", async () => {
    const wrong = ((ty, p) => lowerPipeline(ty, p).replace(/ < /g, " <= ")) as typeof lowerPipeline;
    const r = await admit(SLICE_1_CASES, localJq, wrong);
    expect(r.admitted).toBe(false);
    expect(r.results.find((x) => x.case === "filter lt literal")?.ok).toBe(false);
  });
  it("⚠ NEGATIVE CONTROL: a fixture set without an empty case is refused", () => {
    expect(fixtureGaps(SLICE_1_CASES.filter((c) => !(Array.isArray(c.input) && c.input.length === 0)))).toContain("no EMPTY-input case");
  });
});

describe("slice 2 against local jq", () => {
  it("every slice-2 case: lowering on jq == evaluator", async () => {
    const { SLICE_2_CASES } = await import("./fixtures.js");
    const r = await admit(SLICE_2_CASES, localJq);
    expect(r.results.filter((x) => !x.ok)).toEqual([]);
  });
  it("types refuse what the engine would get wrong", () => {
    const R = T.list(T.record({ n: T.int(), b: T.option(T.bool()), e: T.option(T.text()) }));
    const err = (p: Pipeline) => { const x = typePipeline(R, p); return x.ok ? null : x.error; };
    expect(err([{ op: "derive", as: "q", expr: { div: [{ field: "n" }, { value: 0, from: "test" }] } }])).toMatch(/non-zero/);
    expect(err([{ op: "coalesce", field: "b", with: { lit: { value: true, from: "test" } } }])).toMatch(/treats false as missing/);
    expect(err([{ op: "sort", by: "e", dir: "asc" }])).toMatch(/may be null/);
    expect(err([{ op: "first" }, { op: "template", as: "t", parts: [{ field: "n" }] }])).toMatch(/needs a record/);
  });
  it("a TRANSFORM may not end in null (I-282: null renders as \"\" and the reader fails)", async () => {
    const { typeTransform } = await import("./combinators.js");
    const R = T.list(T.record({ n: T.int() }));
    const r = typeTransform(R, [{ op: "first" }]);
    expect(r.ok ? null : r.error).toMatch(/may end in null/);
    expect(typeTransform(R, [{ op: "count", as: "c" }]).ok).toBe(true);
  });
});

describe("slice 3 — flow inputs inside a combinator", () => {
  it("every slice-3 case against local jq", async () => {
    const { SLICE_3_CASES } = await import("./fixtures.js");
    const r = await admit(SLICE_3_CASES, localJq);
    expect(r.results.filter((x) => !x.ok)).toEqual([]);
  });
  it("an undeclared input is a type error naming the declared ones", async () => {
    const { withContext } = await import("./combinators.js");
    const R = T.list(T.record({ n: T.int() }));
    const r = withContext({ inputs: { period: T.month() } }, () => typePipeline(R, [{ op: "filter", where: { cmp: "gt", left: { field: "n" }, right: { input: "limit" } } }]));
    expect(r.ok ? null : r.error).toMatch(/no flow input "limit".*period/);
  });
  it("a date input read by its month keeps that month of that year only; CONTROL: uncut, a date never equals a month", async () => {
    const { SLICE_3_CASES } = await import("./fixtures.js");
    const c = SLICE_3_CASES.find((x) => x.name.startsWith("a date input read by its month"))!;
    const ctx = { inputs: { month: T.date() }, values: { month: "2026-08-15" } };
    expect(withContext(ctx, () => evaluatePipeline(c.input, c.pipeline))).toEqual([{ id: 1 }, { id: 4 }]);
    const jqOut = await localJq(withContext(ctx, () => lowerPipeline(c.inputTy, c.pipeline)), c.input, { inputs: { month: { ty: T.date(), value: "2026-08-15" } } } as never);
    expect(jqOut).toEqual([{ id: 1 }, { id: 4 }]);
    const uncut = c.pipeline.map((st) => (st.op === "filter" ? { op: "filter" as const, where: { cmp: "eq" as const, left: { field: "on_month" }, right: { input: "month" } } } : st));
    const r = withContext(ctx, () => typePipeline(c.inputTy, uncut));
    expect(r.ok ? null : r.error).toMatch(/cannot compare/);
    expect(withContext({ inputs: { month: T.number() } }, () => typePipeline(c.inputTy, c.pipeline)).ok).toBe(false); // only a date has a month
  });
  it("spliceInputs builds the measured Pebble concatenation, and nothing else", async () => {
    const { spliceInputs } = await import("./combinators.js");
    expect(spliceInputs("map(select(.r < __FOUNDRY_INPUT_t__))")).toBe("'map(select(.r < ' ~ (inputs.t | toJson) ~ '))'");
    expect(spliceInputs("__FOUNDRY_INPUT_a__")).toBe("(inputs.a | toJson)");
    expect(spliceInputs("length")).toBe("'length'");
  });
});

describe("slice 4 — take", () => {
  it("against local jq, and it has its own empty case", async () => {
    const { SLICE_4_CASES } = await import("./fixtures.js");
    expect(fixtureGaps(SLICE_4_CASES)).toEqual([]);
    const r = await admit(SLICE_4_CASES, localJq);
    expect(r.results.filter((x) => !x.ok)).toEqual([]);
  });
  it("take refuses rows (take reads ONE record's field)", () => {
    expect(typeErr([{ op: "take", field: "id" }])).toMatch(/ONE record/);
  });
});

describe("phase 2 gate — no Opaque leaves a pipeline", () => {
  const R = T.list(T.record({ id: T.int(), blob: T.opaque(), nested: T.record({ x: T.opaque() }) }));
  const err = (p: Pipeline) => { const x = typePipeline(R, p); return x.ok ? null : x.error; };
  it("a pipeline over an Opaque value does not type at all", () => {
    expect(typePipeline(T.opaque(), [{ op: "count", as: "n" }]).ok).toBe(false);
  });
  it("project, take and collect refuse an Opaque field (and a record that contains one)", () => {
    expect(err([{ op: "project", fields: [{ name: "b", from: "blob" }] }])).toMatch(/no declared type/);
    expect(err([{ op: "project", fields: [{ name: "n", from: "nested" }] }])).toMatch(/no declared type/);
    expect(err([{ op: "group", by: ["id"], aggs: [{ as: "c", fn: "collect", fields: ["blob"] }] }])).toMatch(/no declared type/);
  });
  it("filter and template refuse it too, as not comparable / not text", () => {
    expect(err([{ op: "filter", where: { cmp: "eq", left: { field: "blob" }, right: { lit: { value: 1, from: "test" } } } }])).toMatch(/cannot be compared/);
    expect(err([{ op: "template", as: "t", parts: [{ field: "blob" }] }])).toMatch(/not text/);
  });
  it("CONTROL: the typed fields still project", () => {
    expect(err([{ op: "project", fields: [{ name: "i", from: "id" }] }])).toBeNull();
  });
});

describe("slice 5 — project builds arguments", () => {
  it("against local jq", async () => {
    const { SLICE_5_CASES } = await import("./fixtures.js");
    const r = await admit(SLICE_5_CASES, localJq);
    expect(r.results.filter((x) => !x.ok)).toEqual([]);
  });
  it("a one-element list of a nullable field is refused ([null] is a list holding null)", () => {
    expect(typeErr([{ op: "project", fields: [{ name: "to", list: "email" }] }])).toMatch(/would hold null/);
  });
});

describe("slice 6 — the re-expression extensions", () => {
  it("against local jq, including the non-breaking-space and empty-summarize cases", async () => {
    const { SLICE_6_CASES } = await import("./fixtures.js");
    const r = await admit(SLICE_6_CASES, localJq);
    expect(r.results.filter((x) => !x.ok)).toEqual([]);
  });
  it("ordering a nullable value is still refused (only equality became legal)", () => {
    expect(typeErr([{ op: "filter", where: { cmp: "lt", left: { field: "email" }, right: { lit: { value: "a", from: "test" } } } }])).toMatch(/may be null/);
  });
  it("summarize types what may not exist over no rows as Option", async () => {
    const R = T.list(T.record({ s: T.number() }));
    const r = typePipeline(R, [{ op: "summarize", aggs: [{ as: "n", fn: "count" }, { as: "t", fn: "sum", field: "s" }, { as: "m", fn: "avg", field: "s" }] }]);
    expect(r.ok && r.ty).toEqual(T.record({ n: T.int(), t: T.option(T.number()), m: T.option(T.number()) }));
  });
});

describe("slice 7 — the second re-expression set", () => {
  const R7 = T.list(T.record({ k: T.text(), email: T.option(T.address()), s: T.option(T.number()) }));
  it("against local jq, including the empty head and the filtered aggregates over no matching rows", async () => {
    const { SLICE_7_CASES } = await import("./fixtures.js");
    const r = await admit(SLICE_7_CASES, localJq);
    expect(r.results.filter((x) => !x.ok)).toEqual([]);
  });
  it("a filtered aggregate is Option even in a group (no row may match), and reads a field its filter proves non-null", () => {
    const r = typePipeline(R7, [{ op: "group", by: ["k"], aggs: [{ as: "m", fn: "max", field: "s", where: { notNull: "s" } }, { as: "n", fn: "count" }] }]);
    expect(r.ok && r.ty).toEqual(T.list(T.record({ k: T.text(), m: T.option(T.number()), n: T.int() })));
    // Without the filter, a nullable field is refused as before.
    expect(typePipeline(R7, [{ op: "group", by: ["k"], aggs: [{ as: "m", fn: "max", field: "s" }] }]).ok).toBe(false);
  });
  it("a head reads only the row count", () => {
    const r = typePipeline(R7, [{ op: "join_text", as: "t", head: [{ field: "k" }], parts: [{ field: "k" }], sep: ",", empty: "-" }]);
    expect(!r.ok && r.error).toMatch(/reads only "count"/);
  });
  it("coalescing an Address from a Text literal yields Text, not Address (a fallback cannot borrow a refinement)", () => {
    const r = typePipeline(R7, [{ op: "coalesce", field: "email", with: { lit: { value: "ops@x.example", from: "test" } } }]);
    expect(r.ok && r.ty).toEqual(T.list(T.record({ k: T.text(), email: T.text(), s: T.option(T.number()) })));
    const same = typePipeline(T.list(T.record({ a: T.option(T.address()), b: T.address() })), [{ op: "coalesce", field: "a", with: { field: "b" } }]);
    expect(same.ok && same.ty).toEqual(T.list(T.record({ a: T.address(), b: T.address() })));
  });
  it("the empty list fills any list port; a compact list may take nullable items, a plain one may not", () => {
    expect(assignable(T.list(T.never()), T.list(T.address())).ok).toBe(true);
    expect(assignable(T.list(T.text()), T.list(T.address())).ok).toBe(false);
    expect(typePipeline(R7, [{ op: "project", fields: [{ name: "to", listOf: [{ field: "email" }] }] }]).ok).toBe(false);
    const c = typePipeline(R7, [{ op: "project", fields: [{ name: "to", listOf: [{ field: "email" }], compact: true }] }]);
    expect(c.ok && c.ty).toEqual(T.list(T.record({ to: T.list(T.address()) })));
  });
});

describe("convert to a date (slice 5d): a moment compared by its calendar day with the day the flow runs", () => {
  const MOMENTS = T.list(T.record({ id: T.int(), at: T.dateTime() }));
  const p: Pipeline = [{ op: "convert", field: "at", as: "at_day", to: "date" }, { op: "filter", where: { cmp: "lt", left: { field: "at_day" }, right: { input: "run_day" } } }];
  const rows = [{ id: 1, at: "2026-06-29T23:59:00.000Z" }, { id: 2, at: "2026-06-30T00:01:00.000Z" }, { id: 3, at: "2026-07-01T08:00:00.000Z" }];
  it("types: a DateTime converts to a Date, which compares with a Date input; text does not convert", () => {
    expect(withContext({ inputs: { run_day: T.date() } }, () => typePipeline(MOMENTS, p)).ok).toBe(true);
    // Without the conversion a moment does not compare with a day.
    expect(withContext({ inputs: { run_day: T.date() } }, () => typePipeline(MOMENTS, [p[1]!.op === "filter" ? { op: "filter", where: { cmp: "lt", left: { field: "at" }, right: { input: "run_day" } } } : p[1]!]).ok)).toBe(false);
    expect(typePipeline(T.list(T.record({ s: T.text() })), [{ op: "convert", field: "s", as: "d", to: "date" }]).ok).toBe(false);
  });
  it("the evaluator and the lowered jq agree: only the rows whose DAY is before the run day", async () => {
    const got = withContext({ inputs: { run_day: T.date() }, values: { run_day: "2026-06-30" } }, () => p.reduce<unknown>((acc, c) => evaluate(acc as never, c), rows));
    expect((got as Array<{ id: number }>).map((r) => r.id)).toEqual([1]);
    const program = withContext({ inputs: { run_day: T.date() } }, () => lowerPipeline(MOMENTS, p));
    const jq = await localJq(program, rows, { inputs: { run_day: { value: "2026-06-30" } } } as never);
    expect((jq as Array<{ id: number }>).map((r) => r.id)).toEqual([1]);
  });
});

describe("slice C — a condition on one value, and a split (phase C, D-371/D-372)", () => {
  it("against local jq: a Decide lowers to keep_if + has-rows, a Split to a filter and its generated complement", async () => {
    const { SLICE_C_CASES } = await import("./fixtures.js");
    const r = await admit(SLICE_C_CASES, localJq);
    expect(r.results.filter((x) => !x.ok)).toEqual([]);
  });
  it("each Decide pair takes both outcomes — a CONTROL that the test can fail", async () => {
    const { SLICE_C_CASES } = await import("./fixtures.js");
    const out = (name: string) => {
      const c = SLICE_C_CASES.find((x) => x.name === name)!;
      const ctx = { inputs: Object.fromEntries(Object.entries(c.inputs ?? {}).map(([k, v]) => [k, v.ty])), values: Object.fromEntries(Object.entries(c.inputs ?? {}).map(([k, v]) => [k, v.value])) };
      return withContext(ctx, () => c.pipeline.reduce<unknown>((v, st) => evaluate(v as never, st), c.input)) as unknown[];
    };
    expect(out("decide on a count: holds")).toHaveLength(1);
    expect(out("decide on a count: does not hold")).toHaveLength(0);
    expect(out("decide on a date before a date input")).toHaveLength(1);
    expect(out("decide on a date after a date input")).toHaveLength(0);
    expect(out("decide on a total that may be empty: a total over the limit holds")).toHaveLength(1);
    expect(out("decide on a total that may be empty: an empty total does not hold")).toHaveLength(0);
  });
  it("a split's two halves are disjoint and together are the input — and the null row is in the rest", async () => {
    const { SLICE_C_CASES } = await import("./fixtures.js");
    const run = (name: string) => { const c = SLICE_C_CASES.find((x) => x.name === name)!; return (c.pipeline.reduce<unknown>((v, st) => evaluate(v as never, st), c.input) as Array<{ id: number; email: string | null }>); };
    for (const [m, rest] of [["split: the matched rows", "split: the rest"], ["split on a nullable field: the matched rows", "split on a nullable field: the rest — the null row lands here"]] as const) {
      const a = run(m).map((x) => x.id), b = run(rest).map((x) => x.id);
      expect(a.filter((x) => b.includes(x))).toEqual([]);
      expect([...a, ...b].sort()).toEqual([1, 2, 3, 4]);
    }
    expect(run("split on a nullable field: the rest — the null row lands here").some((x) => x.email === null)).toBe(true);
    // The ordered split on a nullable number (D-374): disjoint, covering, the null row and the boundary (50) in the rest.
    const who = (name: string) => (SLICE_C_CASES.find((x) => x.name === name)!.pipeline.reduce<unknown>((v, st) => evaluate(v as never, st), SLICE_C_CASES.find((x) => x.name === name)!.input) as Array<{ who: string }>).map((x) => x.who);
    expect(who("split ordered on a nullable number: the matched rows (50 is not > 50)")).toEqual(["Ada"]);
    expect(who("split ordered on a nullable number: the rest — the null row lands here")).toEqual(["O'Brien", "Grace", "Linus"]);
  });
  it("a conjunction narrows as it reads (D-374): notNull first lets the field be ordered; the other order, and `or`, do not", () => {
    const ty = T.list(T.record({ score: T.option(T.number()) }));
    const gt = { cmp: "gt" as const, left: { field: "score" }, right: { lit: { value: 50, from: "test" as const } } };
    const err = (where: unknown) => { const r = typePipeline(ty, [{ op: "filter", where: where as never }]); return r.ok ? null : r.error; };
    expect(err({ and: [{ notNull: "score" }, gt] })).toBeNull();
    expect(err({ not: { and: [{ notNull: "score" }, gt] } })).toBeNull();
    // CONTROLS: the null test after the comparison, and a disjunction, still leave the comparison over a possible null.
    expect(err({ and: [gt, { notNull: "score" }] })).toMatch(/may be null/);
    expect(err({ or: [{ notNull: "score" }, gt] })).toMatch(/may be null/);
    expect(err(gt)).toMatch(/may be null/);
  });
  it("keep_if tests ONE record: on rows it is refused, pointing at filter", () => {
    expect(typeErr([{ op: "keep_if", where: { cmp: "gt", left: { field: "rate" }, right: { lit: { value: 1, from: "test" } } } }])).toMatch(/ONE record.*use filter/);
  });
});

describe("a number that is not one is refused (I-351, found by the compile golden 2026-09-29)", () => {
  it("NaN or Infinity as a literal is a type error in every stage that takes one — JSON would store it as null", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(typeErr([{ op: "coalesce", field: "email", with: { lit: { value: bad, from: "test" } } }])).toMatch(/is not a number/);
      expect(typeErr([{ op: "filter", where: { cmp: "gt", left: { field: "rate" }, right: { lit: { value: bad, from: "test" } } } }])).toMatch(/is not a number/);
    }
    // CONTROL: a real number still types.
    expect(typeErr([{ op: "filter", where: { cmp: "gt", left: { field: "rate" }, right: { lit: { value: 80, from: "test" } } } }])).toBeNull();
  });
});

describe("convert minor units: an amount that may be empty converts to one that may be empty (2026-10-01)", () => {
  const ROWS_ = T.list(T.record({ id: T.int(), cents: T.option(T.int()) }));
  const p: Pipeline = [{ op: "convert", field: "cents", as: "whole", to: "minor_to_major" }];
  const rows = [{ id: 1, cents: 120050 }, { id: 2, cents: null }];
  it("types: Option<Int> in minor units becomes Option<Number>; text and a date still refuse a null", () => {
    const r = typePipeline(ROWS_, p);
    expect(r.ok && JSON.stringify(r.ty)).toContain(JSON.stringify({ whole: T.option(T.number()) }).slice(1, -1));
    expect(typePipeline(ROWS_, [{ op: "convert", field: "cents", as: "t", to: "text" }]).ok).toBe(false);
  });
  it("the evaluator and the lowered jq agree: ÷100, and a null stays null (jq would refuse null / 100)", async () => {
    const want = [{ id: 1, cents: 120050, whole: 1200.5 }, { id: 2, cents: null, whole: null }];
    expect(p.reduce<unknown>((acc, c) => evaluate(acc as never, c), rows)).toEqual(want);
    expect(await localJq(lowerPipeline(ROWS_, p), rows, {} as never)).toEqual(want);
  });
});
