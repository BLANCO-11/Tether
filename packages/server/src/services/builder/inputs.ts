/**
 * A goal's INPUTS (builder-inputs phase 1, P1-D1…D6; applied in builder-behaviour phase 5 — the prototype switch is gone).
 *
 * What an automation must be TOLD — a date, a range of days, a month, a number, a text — is its own part of the plan, separate from
 * whether its value is known. Before this, an input existed only when the person typed its value: "a specific date range", "two
 * dates", "a period I pick each time" named no value, so no parameter was ever made, and the read went unfiltered or was refused
 * (plans/investigation-2026-10-03). Now the plan names the input and how it is FILLED:
 *
 *   given          the person's words state the value          → a fixed value on the step
 *   each_run       anything else, said or unsaid               → a run input the person gives each time it runs
 *   from_run_date  a value relative to when it runs, chosen    → a computed run input (the engine's own: the run day, the month
 *                  from a closed list (never a phrase code       before it, N days before it …)
 *                  matches against the person's words)
 *
 * WHERE an input goes is code's (P1-D3): a test on a saved reader's or a table's field makes it a FLOW filter (the engine's `{ input }`
 * operand); a reader's own parameter takes it as that parameter's value; otherwise, with a read written for the goal, it is a
 * PARAMETER of that read, typed from its kind. Pure: no database, no model.
 */
import { apply, type CatalogueSnapshot, type EFlow, type Ty } from "@foundry/flow-edit";

/** Input ids carry NO digits: older readers of a stage value pull a number out of it ("within 7 days"), and `input:in1` once read as 1. */
export const INPUT_IDS = ["in_a", "in_b", "in_c", "in_d"] as const;
export const INPUT_KINDS = ["date", "date_range", "month", "number", "text"] as const;
export const INPUT_FILLS = ["given", "each_run", "from_run_date"] as const;
export const RELATIVES = ["none", "today", "yesterday", "this_month", "last_month", "last_week", "last_n_days", "days_ago", "next_n_days"] as const;
export type InputKind = (typeof INPUT_KINDS)[number];
export type InputFill = (typeof INPUT_FILLS)[number];
export type Relative = (typeof RELATIVES)[number];
/** Where an input is used — decided by code (`planToSpec`), never the model. `none`: nothing takes it (a stated gap). */
export type InputAt = "flow" | "reader" | "read" | "none";

export interface SpecInput { id: string; kind: InputKind; words: string; fill: InputFill; relative?: Relative; days?: number; fills?: string; at: InputAt }

/** A relative value has ONE kind: the day, the month, or the days of a span — code's, so a model's kind cannot contradict it. */
export function kindFor(relative: Relative | undefined, kind: InputKind): InputKind {
  switch (relative) {
    case "today": case "yesterday": return "date";
    case "this_month": case "last_month": return "month";
    case "last_week": case "last_n_days": case "next_n_days": return "date_range";
    case "days_ago": return "date";
    default: return kind;
  }
}

/** How a relative value reads to a person — said beside it, so "last week" is never silently a different span. */
export function relativeWords(r: Relative | undefined, days?: number): string {
  switch (r) {
    case "today": return "the day it runs";
    case "yesterday": return "the day before it runs";
    case "this_month": return "the month it runs";
    case "last_month": return "the month before it runs";
    case "last_week": return "the 7 days before the day it runs";
    case "last_n_days": return `the ${days ?? "?"} days up to the day it runs`;
    case "days_ago": return `${days ?? "?"} days before the day it runs`;
    case "next_n_days": return `the ${days ?? "?"} days from the day it runs`;
    default: return "";
  }
}

export const isPeriod = (k: InputKind) => k === "date_range" || k === "month";

/** A computed run input — the engine's own (`COMPUTED_INPUTS`); `offsetDays` only ever on the run day. */
export interface Computed { id: string; computed: "currentDate" | "priorDate" | "currentMonth" | "priorMonth" | "currentMonthStart" | "priorMonthStart"; offsetDays?: number; type: "DATE" | "STRING"; format?: "month" }
const RUN = {
  run_day: { id: "run_day", computed: "currentDate", type: "DATE" },
  prior_day: { id: "prior_day", computed: "priorDate", type: "DATE" },
  run_month: { id: "run_month", computed: "currentMonth", type: "STRING", format: "month" },
  prior_month: { id: "prior_month", computed: "priorMonth", type: "STRING", format: "month" },
  month_start: { id: "month_start", computed: "currentMonthStart", type: "DATE" },
  prior_month_start: { id: "prior_month_start", computed: "priorMonthStart", type: "DATE" },
} as const satisfies Record<string, Computed>;
const daysBack = (n: number): Computed => ({ id: `days_before_${n}`, computed: "currentDate", offsetDays: -n, type: "DATE" });
const daysOn = (n: number): Computed => ({ id: `days_after_${n}`, computed: "currentDate", offsetDays: n, type: "DATE" });

/** What end of a value a port or a filter takes: one value, or the first / last day of a span. */
export type End = "single" | "start" | "end";
/** The port's form: a day, a day compared by its month (`per: "month"`), or a month. */
export type PortForm = "date" | "month_date" | "month";
export const portForm = (ty: Ty): PortForm | null => {
  const t = ty.t === "Option" || ty.t === "List" ? (ty as { of: Ty }).of : ty;
  if (t.t === "Month") return "month";
  if (t.t === "Date") return "per" in t && t.per === "month" ? "month_date" : "date";
  return null;
};

/**
 * The computed input a relative value gives one end of a port or a filter, and the comparison that end makes (`ge` a start, `le` /
 * `lt` an end, `eq` a single day). Null when the engine cannot compute it (the end of last month is the day before the month starts,
 * and only the run day takes an offset) — a stated gap, never a near miss.
 */
export function runDateEnd(r: Relative | undefined, days: number | undefined, end: End, form: PortForm): { c: Computed; cmp: "ge" | "le" | "lt" | "eq" } | null {
  if (form === "month") return r === "this_month" ? { c: RUN.run_month, cmp: "eq" } : r === "last_month" ? { c: RUN.prior_month, cmp: "eq" } : null;
  if (form === "month_date") return r === "this_month" ? { c: RUN.run_day, cmp: "eq" } : r === "last_month" ? { c: RUN.prior_month_start, cmp: "eq" } : null;
  const counted = (r === "last_n_days" || r === "days_ago" || r === "next_n_days") && Number.isInteger(days) && days! > 0 && days! <= 3650 ? days! : null;
  const n = r === "last_week" ? 7 : counted;
  if (r === "days_ago") return counted ? { c: daysBack(counted), cmp: end === "start" ? "ge" : end === "end" ? "le" : "eq" } : null;
  if (r === "next_n_days") return end === "start" ? { c: RUN.run_day, cmp: "ge" } : end === "end" && counted ? { c: daysOn(counted), cmp: "le" } : null;
  if (end === "single") return r === "today" ? { c: RUN.run_day, cmp: "eq" } : r === "yesterday" ? { c: RUN.prior_day, cmp: "eq" } : null;
  if (end === "start") {
    if (r === "today") return { c: RUN.run_day, cmp: "ge" };
    if (r === "yesterday") return { c: RUN.prior_day, cmp: "ge" };
    if (r === "this_month") return { c: RUN.month_start, cmp: "ge" };
    if (r === "last_month") return { c: RUN.prior_month_start, cmp: "ge" };
    return n ? { c: daysBack(n), cmp: "ge" } : null;
  }
  if (r === "today" || r === "this_month" || r === "last_n_days") return n === null && r === "last_n_days" ? null : { c: RUN.run_day, cmp: "le" };
  if (r === "yesterday") return { c: RUN.prior_day, cmp: "le" };
  if (r === "last_month") return { c: RUN.month_start, cmp: "lt" };
  if (r === "last_week") return { c: RUN.run_day, cmp: "lt" };
  return null;
}

/** A run input the person gives each run, for a flow filter: its id and declared type. */
/** `byMonth`: a date read by its MONTH — the person gives any day of the month they mean, and only its year and month are used. */
export interface Asked { id: string; type: "DATE" | "FLOAT" | "STRING"; byMonth?: true }
/**
 * The run inputs each `each_run` FLOW input asks for — by its kind, never its words: a span is a first and a last day, a month is ONE
 * date read by its month (any day of it; the same rule a written read's `month` filter applies), a date is one day, a number a number,
 * a text a text. Names are fresh against each other and against `taken` (the flow's own inputs).
 */
export function askedFor(inputs: readonly SpecInput[], taken: readonly string[] = []): Map<string, { single?: Asked; start?: Asked; end?: Asked }> {
  const used = new Set(taken);
  const fresh = (base: string) => { let n = base; for (let k = 2; used.has(n); k++) n = `${base}_${k}`; used.add(n); return n; };
  const out = new Map<string, { single?: Asked; start?: Asked; end?: Asked }>();
  for (const i of inputs) {
    if (i.at !== "flow" || i.fill !== "each_run") continue;
    if (i.kind === "month") out.set(i.id, { single: { id: fresh("month"), type: "DATE", byMonth: true } });
    else if (isPeriod(i.kind)) out.set(i.id, { start: { id: fresh("start_date"), type: "DATE" }, end: { id: fresh("end_date"), type: "DATE" } });
    else out.set(i.id, { single: i.kind === "date" ? { id: fresh("date"), type: "DATE" } : i.kind === "number" ? { id: fresh("number"), type: "FLOAT" } : { id: fresh("value"), type: "STRING" } });
  }
  return out;
}
const tyOf = (t: "DATE" | "FLOAT" | "STRING", format?: "month"): Ty => (t === "DATE" ? { t: "Date" } : t === "FLOAT" ? { t: "Number" } : format === "month" ? { t: "Month" } : { t: "Text" });

/** One end of a flow filter against an input: the run input it reads, the comparison, and how to declare that input when it is new. */
/** `cut: "month"`: both sides are compared by their month (the field converted, the input cut) — a date input read by its month. */
export type Operand = { id: string; cmp: "ge" | "le" | "lt" | "eq" | "gt" | "ne"; cut?: "month"; declare: { id: string; type: string; format?: "month"; computed?: Computed["computed"]; offsetDays?: number } };
/** The inputs a flow filter may read, typed — for the pipeline's typing context before they are declared. */
export function operandTypes(inputs: readonly SpecInput[], taken: readonly string[] = []): Record<string, Ty> {
  const out: Record<string, Ty> = {};
  for (const [, a] of askedFor(inputs, taken)) for (const x of [a.single, a.start, a.end]) if (x) out[x.id] = tyOf(x.type);
  for (const i of inputs) {
    if (i.at !== "flow" || i.fill !== "from_run_date") continue;
    for (const e of (isPeriod(i.kind) ? ["start", "end"] : ["single"]) as End[]) { const r = runDateEnd(i.relative, i.days, e, "date"); if (r) out[r.c.id] = tyOf(r.c.type, r.c.format); }
  }
  return out;
}
/**
 * The operands a test of a DATE field against a non-given input makes: a span or a month is two (on or after its first day, on or
 * before / before its last); one day or a value is one, by the test's own comparison. Null when an end cannot be had (a stated gap).
 */
export function operandsFor(i: SpecInput, asked: ReturnType<typeof askedFor>, testCmp: Operand["cmp"] | undefined, dateField: boolean): Operand[] | string {
  const decl = (a: Asked) => ({ id: a.id, type: a.type });
  if (i.fill === "each_run") {
    const a = asked.get(i.id);
    if (!a) return `the input “${i.words}” is not asked for on this flow`;
    if (a.start && a.end) return dateField ? [{ id: a.start.id, cmp: "ge", declare: decl(a.start) }, { id: a.end.id, cmp: "le", declare: decl(a.end) }] : `“${i.words}” is a span of days, and the field it is tested on is not a date`;
    if (a.single?.byMonth) return dateField ? [{ id: a.single.id, cmp: "eq", cut: "month", declare: decl(a.single) }] : `“${i.words}” is a month, and the field it is tested on is not a date`;
    if (!testCmp) return `“${i.words}” has no comparison to make`;
    return [{ id: a.single!.id, cmp: testCmp, declare: decl(a.single!) }];
  }
  if (!dateField) return `“${i.words}” is worked out from the run date, and the field it is tested on is not a date`;
  const ends: End[] = isPeriod(i.kind) ? ["start", "end"] : ["single"];
  const out: Operand[] = [];
  for (const e of ends) {
    const r = runDateEnd(i.relative, i.days, e, "date");
    if (!r) return `“${i.words}” (${relativeWords(i.relative, i.days)}) cannot be worked out by the engine`;
    out.push({ id: r.c.id, cmp: e === "single" ? (testCmp ?? "eq") : r.cmp, declare: { id: r.c.id, type: r.c.type, ...(r.c.format ? { format: r.c.format } : {}), computed: r.c.computed, ...(r.c.offsetDays !== undefined ? { offsetDays: r.c.offsetDays } : {}) } });
  }
  return out;
}

/** The run inputs no step reads — the engine's own test: the ones it would let a person stop asking for. */
export const unreadInputs = (f: EFlow, cat: CatalogueSnapshot): string[] => f.inputs.filter((i) => i.computed === undefined && apply(f, { op: "remove_input", id: i.id }, cat).ok).map((i) => i.id);

/**
 * The computed input for one END of a parameter whose own comparison is `edge` (a read's `lte` end, a reader's `lt` end): the run-date
 * end moved to that comparison. "Before the run day" on an on-or-before parameter is the day before it runs; "on or before the run day"
 * on a before parameter is the day after. Null when the engine cannot compute it (only the run day takes an offset).
 */
export function endForPort(r: Relative | undefined, days: number | undefined, end: End, form: PortForm, edge?: "ge" | "gt" | "le" | "lt"): Computed | null {
  const w = runDateEnd(r, days, end, form);
  if (!w) return null;
  if (end !== "end" || !edge || form !== "date") return w.c;
  const portStrict = edge === "lt", wantStrict = w.cmp === "lt";
  if (portStrict === wantStrict) return w.c;
  if (wantStrict) return w.c.id === RUN.run_day.id ? RUN.prior_day : null;
  return w.c.id === RUN.run_day.id ? { id: "day_after_run", computed: "currentDate", offsetDays: 1, type: "DATE" } : w.c.id === RUN.prior_day.id ? RUN.run_day : null;
}

/** The declaration of every run input a FLOW input's filters may read, by id — declared when a placed filter reads it. */
export function flowDecls(inputs: readonly SpecInput[], asked: ReturnType<typeof askedFor>): Map<string, Operand["declare"]> {
  const out = new Map<string, Operand["declare"]>();
  for (const i of inputs) {
    if (i.at !== "flow" || i.fill === "given") continue;
    const ops = operandsFor(i, asked, "eq", true);
    if (typeof ops !== "string") for (const o of ops) out.set(o.id, o.declare);
  }
  return out;
}

/**
 * The tests that can compare a field with an input of each kind (P1, an equivalence by code): a span or a month is the days IN it —
 * whatever comparison the plan wrote, it is `equals` (within); a day is ordered or equal (a "passed" test names the day it is before
 * or from); a number is ordered or equal; a text is equal or not. Anything else is not a comparison with that input (null).
 */
export function testFor(kind: InputKind, test: string): string | null {
  if (isPeriod(kind)) return "equals";
  const ordered = ["equals", "not_equals", "below", "above", "at_most", "at_least"];
  if (kind === "date") return test === "date_passed" ? "below" : test === "date_not_passed" ? "at_least" : ordered.includes(test) ? test : null;
  // A number of days ("older than 3 days", the input "3 days"): a days-ago test takes it as its N (P7 — refused, it re-asked a right plan).
  if (kind === "number") return ordered.includes(test) || test === "older_than_days" || test === "within_days" ? test : null;
  return test === "equals" || test === "not_equals" ? test : null;
}
