/**
 * Admission fixtures for the first combinator slice (compiled-builder 2d). Shared by the unit test (local jq) and the
 * engine proof (Kestra), so both judge exactly the same cases. Each set has the EMPTY input and a NULL (the kit's rules).
 * Values chosen to break naive lowerings: an apostrophe in a literal (Pebble's quote), fractional and whole numbers
 * through `tostring`, and a nullable email that really is null.
 */
import { T } from "../typecheck/types.js";
import type { AdmissionCase } from "./admission.js";
import type { Literal, Pred } from "./combinators.js";

const ROW = T.record({ id: T.int(), name: T.text(), email: T.option(T.address()), rate: T.number(), dept: T.text() });
const ROWS = T.list(ROW);
const lit = (value: string | number | boolean): Literal => ({ value, from: "test" });

const DATA = [
  { id: 1, name: "Ada", email: "ada@x.example", rate: 92.5, dept: "ENG" },
  { id: 2, name: "O'Brien", email: null, rate: 79, dept: "OPS" },
  { id: 3, name: "Grace", email: "grace@x.example", rate: 80, dept: "ENG" },
  { id: 4, name: "Linus", email: "linus@x.example", rate: 7644.8, dept: "OPS" },
];

export const SLICE_1_CASES: AdmissionCase[] = [
  { name: "filter lt literal", inputTy: ROWS, input: DATA, pipeline: [{ op: "filter", where: { cmp: "lt", left: { field: "rate" }, right: { lit: lit(80) } } }] },
  { name: "filter on empty", inputTy: ROWS, input: [], pipeline: [{ op: "filter", where: { cmp: "ge", left: { field: "rate" }, right: { lit: lit(80) } } }] },
  { name: "filter eq a literal with an apostrophe", inputTy: ROWS, input: DATA, pipeline: [{ op: "filter", where: { cmp: "eq", left: { field: "name" }, right: { lit: lit("O'Brien") } } }] },
  { name: "notNull narrows, then template reads it", inputTy: ROWS, input: DATA, pipeline: [
    { op: "filter", where: { notNull: "email" } },
    { op: "template", as: "line", parts: [{ text: "To " }, { field: "email" }, { text: ": your rate is " }, { field: "rate" }, { text: "%" }] },
  ] },
  { name: "and / or / not", inputTy: ROWS, input: DATA, pipeline: [{ op: "filter", where: { and: [
    { notNull: "email" },
    { or: [{ cmp: "eq", left: { field: "dept" }, right: { lit: lit("ENG") } }, { not: { cmp: "lt", left: { field: "rate" }, right: { lit: lit(100) } } }] },
  ] } }] },
  { name: "isNull", inputTy: ROWS, input: DATA, pipeline: [{ op: "filter", where: { isNull: "email" } }] },
  { name: "project renames", inputTy: ROWS, input: DATA, pipeline: [{ op: "project", fields: [{ name: "who", from: "name" }, { name: "pct", from: "rate" }] }] },
  { name: "join_text with an empty case", inputTy: ROWS, input: [], pipeline: [{ op: "join_text", as: "text", parts: [{ field: "name" }], sep: "\n", empty: "Nothing to report." }] },
  { name: "join_text over rows", inputTy: ROWS, input: DATA, pipeline: [{ op: "join_text", as: "text", parts: [{ text: "- " }, { field: "name" }, { text: " (" }, { field: "rate" }, { text: ")" }], sep: "\n", empty: "Nothing to report." }] },
  { name: "count, empty and not", inputTy: ROWS, input: [], pipeline: [{ op: "count", as: "n" }] },
  { name: "filter then count", inputTy: ROWS, input: DATA, pipeline: [{ op: "filter", where: { cmp: "eq", left: { field: "dept" }, right: { lit: lit("OPS") } } }, { op: "count", as: "n" }] },
];

const ROW2 = T.record({ id: T.int(), dept: T.text(), region: T.text(), amount_cents: T.int(), score: T.number(), email: T.option(T.address()), late: T.bool() });
const ROWS2 = T.list(ROW2);
const DATA2 = [
  { id: 1, dept: "OPS", region: "EMEA", amount_cents: 1250, score: 0.1, email: "a@x.example", late: true },
  { id: 2, dept: "ENG", region: "AMER", amount_cents: 99, score: 0.2, email: null, late: false },
  { id: 3, dept: "OPS", region: "AMER", amount_cents: 1250, score: 7.5, email: "c@x.example", late: false },
  { id: 4, dept: "ENG", region: "EMEA", amount_cents: 300000, score: 0.2, email: "d@x.example", late: true },
  { id: 5, dept: "FIN", region: "EMEA", amount_cents: 0, score: 3, email: null, late: true },
];

export const SLICE_2_CASES: AdmissionCase[] = [
  { name: "sort asc with ties (stable)", inputTy: ROWS2, input: DATA2, pipeline: [{ op: "sort", by: "amount_cents", dir: "asc" }] },
  { name: "sort desc = reverse of stable asc", inputTy: ROWS2, input: DATA2, pipeline: [{ op: "sort", by: "score", dir: "desc" }] },
  { name: "sort by text", inputTy: ROWS2, input: DATA2, pipeline: [{ op: "sort", by: "dept", dir: "asc" }] },
  { name: "limit", inputTy: ROWS2, input: DATA2, pipeline: [{ op: "sort", by: "amount_cents", dir: "desc" }, { op: "limit", n: lit(2) }] },
  { name: "limit on empty", inputTy: ROWS2, input: [], pipeline: [{ op: "limit", n: lit(3) }] },
  { name: "distinct keeps first per key, sorted by key", inputTy: ROWS2, input: DATA2, pipeline: [{ op: "distinct", by: "dept" }] },
  { name: "first", inputTy: ROWS2, input: DATA2, pipeline: [{ op: "first" }] },
  { name: "first of nothing is null", inputTy: ROWS2, input: [], pipeline: [{ op: "first" }] },
  { name: "coalesce a null email", inputTy: ROWS2, input: DATA2, pipeline: [{ op: "coalesce", field: "email", with: { lit: lit("ops@x.example") } }] },
  { name: "convert to text and minor to major", inputTy: ROWS2, input: DATA2, pipeline: [
    { op: "convert", field: "score", as: "score_text", to: "text" },
    { op: "convert", field: "amount_cents", as: "amount", to: "minor_to_major" },
  ] },
  { name: "derive arithmetic", inputTy: ROWS2, input: DATA2, pipeline: [{ op: "derive", as: "x", expr: { add: [{ mul: [{ field: "score" }, { lit: lit(2) }] }, { div: [{ field: "amount_cents" }, lit(100)] }] } }] },
  { name: "derive case", inputTy: ROWS2, input: DATA2, pipeline: [{ op: "derive", as: "urgency", expr: { case: [
    { when: { cmp: "gt", left: { field: "amount_cents" }, right: { lit: lit(100000) } }, then: { lit: lit("urgent") } },
    { when: { cmp: "eq", left: { field: "late" }, right: { lit: lit(true) } }, then: { lit: lit("high") } },
  ], else: { lit: lit("normal") } } }] },
  { name: "group with every aggregate", inputTy: ROWS2, input: DATA2, pipeline: [{ op: "group", by: ["dept"], aggs: [
    { as: "n", fn: "count" },
    { as: "total", fn: "sum", field: "amount_cents" },
    { as: "mean", fn: "avg", field: "score" },
    { as: "lo", fn: "min", field: "score" },
    { as: "hi", fn: "max", field: "region" },
    { as: "late_n", fn: "count_where", where: { cmp: "eq", left: { field: "late" }, right: { lit: lit(true) } } },
    { as: "ids", fn: "collect", fields: ["id", "email"] },
  ] }] },
  { name: "group by two keys", inputTy: ROWS2, input: DATA2, pipeline: [{ op: "group", by: ["region", "dept"], aggs: [{ as: "n", fn: "count" }] }] },
  { name: "group on empty", inputTy: ROWS2, input: [], pipeline: [{ op: "group", by: ["dept"], aggs: [{ as: "n", fn: "count" }] }] },
  { name: "float sum order (0.1 + 0.2)", inputTy: ROWS2, input: DATA2, pipeline: [{ op: "filter", where: { cmp: "lt", left: { field: "score" }, right: { lit: lit(1) } } }, { op: "group", by: ["region"], aggs: [{ as: "s", fn: "sum", field: "score" }] }] },
];

/** Flow inputs inside a combinator: the constants rule's third source, spliced with `toJson` (engine-measured). */
export const SLICE_3_CASES: AdmissionCase[] = [
  { name: "filter by a numeric flow input", inputTy: ROWS, input: DATA, inputs: { threshold: { ty: T.number(), value: 80, kestra: "FLOAT" } },
    pipeline: [{ op: "filter", where: { cmp: "lt", left: { field: "rate" }, right: { input: "threshold" } } }] },
  { name: "filter by a text input holding both quote characters", inputTy: ROWS, input: DATA, inputs: { who: { ty: T.text(), value: "O'Brien", kestra: "STRING" } },
    pipeline: [{ op: "filter", where: { cmp: "eq", left: { field: "name" }, right: { input: "who" } } }] },
  { name: "coalesce from an input, then template", inputTy: ROWS, input: DATA, inputs: { fallback: { ty: T.address(), value: "ops@x.example", kestra: "STRING" } },
    pipeline: [{ op: "coalesce", field: "email", with: { input: "fallback" } }, { op: "template", as: "to", parts: [{ field: "email" }] }] },
  { name: "an input on empty rows", inputTy: ROWS, input: [], inputs: { threshold2: { ty: T.number(), value: 50, kestra: "FLOAT" } },
    pipeline: [{ op: "filter", where: { cmp: "ge", left: { field: "rate" }, right: { input: "threshold2" } } }, { op: "count", as: "n" }] },
  // A month is a DATE read by its month: any day of it selects that month — and only that year's (builder-inputs P1, 2026-10-04).
  { name: "a date input read by its month, against dates and moments across years", inputTy: T.list(T.record({ id: T.int(), on: T.date(), at: T.dateTime() })),
    input: [{ id: 1, on: "2026-08-01", at: "2026-08-31T23:59:00Z" }, { id: 2, on: "2025-08-15", at: "2025-08-15T09:00:00Z" }, { id: 3, on: "2026-09-01", at: "2026-07-31T10:00:00Z" }, { id: 4, on: "2026-08-31", at: "2026-08-01T00:00:00Z" }],
    inputs: { month: { ty: T.date(), value: "2026-08-15", kestra: "DATE" } },
    pipeline: [
      { op: "convert", field: "on", as: "on_month", to: "month" }, { op: "convert", field: "at", as: "at_month", to: "month" },
      { op: "filter", where: { and: [{ cmp: "eq", left: { field: "on_month" }, right: { input: "month", cut: "month" } }, { cmp: "eq", left: { field: "at_month" }, right: { input: "month", cut: "month" } }] } },
      { op: "project", fields: [{ name: "id", from: "id" }] },
    ] },
];

/** `take`: a tool that answers `{total, employees: [...]}` becomes rows, then any combinator applies. */
const WRAPPED = T.record({ total: T.int(), employees: T.list(T.record({ id: T.int(), work_email: T.option(T.address()) })) });
export const SLICE_4_CASES: AdmissionCase[] = [
  { name: "take a list field, then filter it", inputTy: WRAPPED, input: { total: 3, employees: [{ id: 1, work_email: "a@x.example" }, { id: 2, work_email: null }, { id: 3, work_email: "c@x.example" }] },
    pipeline: [{ op: "take", field: "employees" }, { op: "filter", where: { isNull: "work_email" } }] },
  { name: "take from an empty list", inputTy: WRAPPED, input: { total: 0, employees: [] }, pipeline: [{ op: "take", field: "employees" }, { op: "count", as: "n" }] },
];

/** `project` builds a tool's arguments: a one-element recipient list and a constant field. */
export const SLICE_5_CASES: AdmissionCase[] = [
  { name: "project a one-element list and a literal", inputTy: ROWS, input: DATA, pipeline: [
    { op: "filter", where: { notNull: "email" } },
    { op: "project", fields: [{ name: "to", list: "email" }, { name: "priority", lit: lit("normal") }, { name: "who", from: "name" }] },
  ] },
  { name: "project on empty", inputTy: ROWS, input: [], pipeline: [{ op: "project", fields: [{ name: "n", from: "name" }, { name: "k", lit: lit(1) }] }] },
];

const ROW6 = T.record({ id: T.int(), team: T.text(), region: T.text(), email: T.option(T.address()), alt: T.option(T.address()), note: T.option(T.text()), score: T.number(), hired: T.bool() });
const ROWS6 = T.list(ROW6);
const DATA6 = [
  { id: 1, team: "B", region: "EU", email: null, alt: "b1@x.example", note: " ", score: 4, hired: true },
  { id: 2, team: "A", region: "US", email: "a2@x.example", alt: null, note: null, score: 2, hired: false },
  { id: 3, team: "A", region: "EU", email: "", alt: null, note: " ", score: 5, hired: true },
  { id: 4, team: "B", region: "US", email: null, alt: null, note: "ok", score: 1, hired: true },
  { id: 5, team: "A", region: "US", email: "a2@x.example", alt: "a5@x.example", note: "\tgo\n", score: 3, hired: false },
];

/** The re-expression extensions (phase 2 exit gate): each is generic list/relational algebra (§5 rule 4). */
export const SLICE_6_CASES: AdmissionCase[] = [
  { name: "eq / ne on a nullable field (equality with null is the same on both sides)", inputTy: ROWS6, input: DATA6,
    pipeline: [{ op: "filter", where: { and: [{ cmp: "ne", left: { field: "email" }, right: { lit: lit("") } }, { cmp: "ne", left: { field: "email" }, right: { lit: lit("a2@x.example") } }] } }] },
  { name: "isBlank: null, spaces, a tab-newline mix — and a non-breaking space is NOT blank", inputTy: ROWS6, input: DATA6, pipeline: [{ op: "filter", where: { isBlank: "note" } }] },
  { name: "coalesce through two fallbacks", inputTy: ROWS6, input: DATA6, pipeline: [{ op: "coalesce", field: "email", with: [{ field: "alt" }, { lit: lit("ops@x.example") }] }] },
  { name: "an optional template part", inputTy: ROWS6, input: DATA6, pipeline: [{ op: "template", as: "line", parts: [{ text: "#" }, { field: "id" }, { opt: "alt", pre: " (alt ", post: ")" }] }] },
  { name: "sort by two keys", inputTy: ROWS6, input: DATA6, pipeline: [{ op: "sort", by: ["team", "region"], dir: "asc" }] },
  { name: "project a list mixing a literal and fields", inputTy: ROWS6, input: DATA6, pipeline: [{ op: "project", fields: [{ name: "labels", listOf: [{ lit: lit("team") }, { field: "team" }, { field: "region" }] }] }] },
  { name: "group: first, distinct_count, collect_distinct, share", inputTy: ROWS6, input: DATA6, pipeline: [{ op: "group", by: ["team"], aggs: [
    { as: "first_id", fn: "first", field: "id" },
    { as: "regions", fn: "distinct_count", field: "region" },
    { as: "emails", fn: "collect_distinct", field: "email" },
    { as: "hired_share", fn: "share", where: { cmp: "eq", left: { field: "hired" }, right: { lit: lit(true) } } },
  ] }] },
  { name: "summarize over rows", inputTy: ROWS6, input: DATA6, pipeline: [{ op: "summarize", aggs: [
    { as: "n", fn: "count" }, { as: "total", fn: "sum", field: "score" }, { as: "mean", fn: "avg", field: "score" },
    { as: "hired_n", fn: "count_where", where: { cmp: "eq", left: { field: "hired" }, right: { lit: lit(true) } } },
    { as: "hired_share", fn: "share", where: { cmp: "eq", left: { field: "hired" }, right: { lit: lit(true) } } },
    { as: "teams", fn: "distinct_count", field: "team" }, { as: "lo", fn: "min", field: "score" }, { as: "first_id", fn: "first", field: "id" },
  ] }] },
  { name: "summarize over NOTHING: no 0/0, nulls where nothing exists", inputTy: ROWS6, input: [], pipeline: [{ op: "summarize", aggs: [
    { as: "n", fn: "count" }, { as: "total", fn: "sum", field: "score" }, { as: "mean", fn: "avg", field: "score" },
    { as: "hired_share", fn: "share", where: { cmp: "eq", left: { field: "hired" }, right: { lit: lit(true) } } }, { as: "lo", fn: "min", field: "score" },
  ] }] },
];

/** The second re-expression set (phase 2 exit gate, slice 7): each again generic list/relational algebra. */
export const SLICE_7_CASES: AdmissionCase[] = [
  { name: "join_text with a head that counts the rows", inputTy: ROWS6, input: DATA6, pipeline: [
    { op: "join_text", as: "text", head: [{ text: "Teams (" }, { field: "count" }, { text: "):\n" }], parts: [{ text: "- " }, { field: "team" }], sep: "\n", empty: "Nothing to report." }] },
  { name: "join_text with a head, on empty: the head is not printed", inputTy: ROWS6, input: [], pipeline: [
    { op: "join_text", as: "text", head: [{ text: "Teams (" }, { field: "count" }, { text: "):\n" }], parts: [{ field: "team" }], sep: "\n", empty: "Nothing to report." }] },
  { name: "an optional part with an else", inputTy: ROWS6, input: DATA6, pipeline: [
    { op: "template", as: "line", parts: [{ text: "#" }, { field: "id" }, { text: " → " }, { opt: "alt", pre: "", post: "", else: "no alternate" }] }] },
  { name: "a FILTERED aggregate in a group: avg and join over the rows where it holds, possibly none", inputTy: ROWS6, input: DATA6, pipeline: [
    { op: "group", by: ["team"], aggs: [
      { as: "hired_avg", fn: "avg", field: "score", where: { cmp: "eq", left: { field: "hired" }, right: { lit: lit(true) } } },
      { as: "emails", fn: "join", parts: [{ field: "email" }], sep: ", ", where: { notNull: "email" } },
      { as: "top", fn: "max", field: "score", where: { cmp: "gt", left: { field: "score" }, right: { lit: lit(4) } } },
      { as: "lines", fn: "join", parts: [{ field: "id" }, { text: ":" }, { field: "region" }], sep: "; " },
    ] }] },
  { name: "a filtered distinct count in summarize, over nothing", inputTy: ROWS6, input: [], pipeline: [
    { op: "summarize", aggs: [{ as: "n", fn: "count" }, { as: "hired_teams", fn: "distinct_count", field: "team", where: { cmp: "eq", left: { field: "hired" }, right: { lit: lit(true) } } }] }] },
  { name: "coalesce whose last fallback may be null, then notNull", inputTy: ROWS6, input: DATA6, pipeline: [
    { op: "coalesce", field: "email", with: [{ field: "alt" }] }, { op: "filter", where: { notNull: "email" } }] },
  { name: "project the empty list, and a compact list that drops nulls", inputTy: ROWS6, input: DATA6, pipeline: [
    { op: "project", fields: [{ name: "cc", emptyList: true }, { name: "to", listOf: [{ field: "email" }, { field: "alt" }], compact: true }] }] },
];

/**
 * Phase C (D-371): a condition on ONE value is lowered to `keep_if` over that record + the has-rows test the compiler already
 * emits; a Split is a filter and its generated complement (`not` of the same test). Each Decide case has both outcomes (the test
 * holds / does not), and the Split pairs carry a NULL — which lands in "the rest" (D-372: `null == x` is false, so `not` holds).
 */
const DAY = T.record({ as_of: T.date(), n: T.int(), who: T.text() });
const RATE_GT_80 = { cmp: "gt", left: { field: "rate" }, right: { lit: lit(80) } } as const;
const ADA = { cmp: "eq", left: { field: "email" }, right: { lit: lit("ada@x.example") } } as const;
/** A nullable NUMBER, ordered (D-374): the conjunction states what null means — `notNull` first — so it types, and its `not`
 * sends the null row to the rest. */
const SCORED = T.list(T.record({ who: T.text(), score: T.option(T.number()) }));
const SCORES = [{ who: "Ada", score: 91 }, { who: "O'Brien", score: null }, { who: "Grace", score: 50 }, { who: "Linus", score: 12.5 }];
const SCORE_GT_50: Pred = { and: [{ notNull: "score" }, { cmp: "gt", left: { field: "score" }, right: { lit: lit(50) } }] };
export const SLICE_C_CASES: AdmissionCase[] = [
  { name: "decide on a count: holds", inputTy: ROWS, input: DATA, pipeline: [{ op: "count", as: "n" }, { op: "keep_if", where: { cmp: "gt", left: { field: "n" }, right: { lit: lit(3) } } }] },
  { name: "decide on a count: does not hold", inputTy: ROWS, input: DATA, pipeline: [{ op: "count", as: "n" }, { op: "keep_if", where: { cmp: "gt", left: { field: "n" }, right: { lit: lit(5) } } }] },
  { name: "decide on the count of nothing", inputTy: ROWS, input: [], pipeline: [{ op: "count", as: "n" }, { op: "keep_if", where: { cmp: "eq", left: { field: "n" }, right: { lit: lit(0) } } }] },
  { name: "decide against a flow input", inputTy: ROWS, input: DATA, inputs: { min_rows: { ty: T.int(), value: 2, kestra: "INT" } },
    pipeline: [{ op: "count", as: "n" }, { op: "keep_if", where: { cmp: "ge", left: { field: "n" }, right: { input: "min_rows" } } }] },
  { name: "decide on a record's field: holds", inputTy: WRAPPED, input: { total: 0, employees: [] }, pipeline: [{ op: "keep_if", where: { cmp: "eq", left: { field: "total" }, right: { lit: lit(0) } } }] },
  { name: "decide on a record's field: does not hold", inputTy: WRAPPED, input: { total: 3, employees: [] }, pipeline: [{ op: "keep_if", where: { cmp: "eq", left: { field: "total" }, right: { lit: lit(0) } } }] },
  { name: "decide on a date before a date input", inputTy: DAY, input: { as_of: "2026-09-01", n: 3, who: "O'Brien" }, inputs: { deadline: { ty: T.date(), value: "2026-09-29", kestra: "DATE" } },
    pipeline: [{ op: "keep_if", where: { cmp: "lt", left: { field: "as_of" }, right: { input: "deadline" } } }] },
  { name: "decide on a date after a date input", inputTy: DAY, input: { as_of: "2026-10-01", n: 3, who: "Ada" }, inputs: { deadline2: { ty: T.date(), value: "2026-09-29", kestra: "DATE" } },
    pipeline: [{ op: "keep_if", where: { cmp: "lt", left: { field: "as_of" }, right: { input: "deadline2" } } }] },
  { name: "decide on text with an apostrophe", inputTy: DAY, input: { as_of: "2026-09-01", n: 3, who: "O'Brien" }, pipeline: [{ op: "keep_if", where: { cmp: "eq", left: { field: "who" }, right: { lit: lit("O'Brien") } } }] },
  { name: "split: the matched rows", inputTy: ROWS, input: DATA, pipeline: [{ op: "filter", where: RATE_GT_80 }] },
  { name: "split: the rest", inputTy: ROWS, input: DATA, pipeline: [{ op: "filter", where: { not: RATE_GT_80 } }] },
  { name: "split on a nullable field: the matched rows", inputTy: ROWS, input: DATA, pipeline: [{ op: "filter", where: ADA }] },
  { name: "split on a nullable field: the rest — the null row lands here", inputTy: ROWS, input: DATA, pipeline: [{ op: "filter", where: { not: ADA } }] },
  { name: "decide on a total that may be empty: a total over the limit holds", inputTy: T.record({ total: T.option(T.number()) }), input: { total: 25.5 },
    pipeline: [{ op: "keep_if", where: { and: [{ notNull: "total" }, { cmp: "gt", left: { field: "total" }, right: { lit: lit(20) } }] } }] },
  { name: "decide on a total that may be empty: an empty total does not hold", inputTy: T.record({ total: T.option(T.number()) }), input: { total: null },
    pipeline: [{ op: "keep_if", where: { and: [{ notNull: "total" }, { cmp: "gt", left: { field: "total" }, right: { lit: lit(20) } }] } }] },
  { name: "split ordered on a nullable number: the matched rows (50 is not > 50)", inputTy: SCORED, input: SCORES, pipeline: [{ op: "filter", where: SCORE_GT_50 }] },
  { name: "split ordered on a nullable number: the rest — the null row lands here", inputTy: SCORED, input: SCORES, pipeline: [{ op: "filter", where: { not: SCORE_GT_50 } }] },
];
