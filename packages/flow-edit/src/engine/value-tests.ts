/**
 * Conditions that compare values (phase C) as the engine's own moves — ONE definition, used by the canvas (a gesture) and the
 * builder (a goal's condition), so both place exactly the same steps.
 *
 * - A Decide (D-371): one value — a list's count, or a field of a step that yields ONE record — compared with a value. A test
 *   transform ending in `keep_if` and the has-rows condition on it; an else-if's test is placed ahead of its chain. Or a ROW test:
 *   a field of a list's rows, holding when SOME row passes ("read_1 has a row whose name is blanco") — a lone `filter` and the
 *   has-rows condition on it, placed the same way.
 * - A Split (D-373): a list's rows divided by one test on a row field — a filter, its complement GENERATED as `not` of the same
 *   test, and a has-rows condition on each, each its own chain (both may run). A nullable field states its null rule
 *   (`notNull and …`, D-374), so a null row goes to the rest.
 *
 * Neither is a new op and neither reaches the compiler as anything new: filters and has-rows conditions only.
 */
import type { Cmp, Literal, Pred } from "../ir/combinators.js";
import type { CatalogueSnapshot } from "../typecheck/signature.js";
import { SECONDS_IN, type TimeUnit, type Ty } from "../typecheck/types.js";
import { chainHead, type EFlow } from "./model.js";
import { readableTy, transformTy, type EngineOp } from "./ops.js";
import { decideTest, splitSide } from "./shape.js";
import { freshStepId } from "./options.js";

const isNum = (t: Ty) => t.t === "Int" || t.t === "Number";
const unwrap = (t: Ty) => (t.t === "Option" ? t.of : t);

/** `k` distinct fresh ids on one base, for a gesture that adds several steps of one kind. */
export const freshIds = (f: EFlow, base: string, k: number): string[] => {
  const ids: string[] = [];
  for (let n = 1; ids.length < k; n++) { const id = `${base}_${n}`; if (!f.steps.some((s) => s.id === id) && !f.inputs.some((i) => i.id === id)) ids.push(id); }
  return ids;
};

/**
 * The number in a value's words: a number, optionally with its unit after it ("30", "10,000", "30 days", "15 percent", "80%") —
 * the goal's own words for a count or an amount. `null` when the words are not one number (a range, a word, two numbers). One
 * definition: the solver places this number and the save funnel's spec check expects it.
 */
export function numberOfWords(value: string): number | null {
  const m = /^\s*(-?\d[\d,_]*(?:\.\d+)?)\s*(?:[a-z]+|%)?\s*$/i.exec(value);
  if (!m) return null;
  const n = Number(m[1]!.replace(/[,_]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * builder-behaviour P7 (R23): the length of time a value's words SAY ("3 days", "90 minutes", "2 business days") — the unit word read
 * like a date's month name: a closed vocabulary of time units, never a guess. `null` when the words carry no time unit.
 */
const UNIT_WORDS: Array<[RegExp, TimeUnit, number]> = [
  [/^(s|secs?|seconds?)$/i, "seconds", 1], [/^(m|mins?|minutes?)$/i, "minutes", 1], [/^(h|hrs?|hours?)$/i, "hours", 1],
  [/^days?$/i, "days", 1], [/^weeks?$/i, "days", 7],
];
export function timeOfWords(value: string): { n: number; unit: TimeUnit } | null {
  const m = /^\s*(-?\d[\d,_]*(?:\.\d+)?)\s*(business\s+|working\s+)?([a-z]+)\s*$/i.exec(value);
  if (!m) return null;
  const n = Number(m[1]!.replace(/[,_]/g, ""));
  const hit = UNIT_WORDS.find(([re]) => re.test(m[3]!));
  if (!hit || !Number.isFinite(n)) return null;
  if (m[2]) return hit[1] === "minutes" || hit[1] === "hours" ? { n: n * hit[2] * (hit[1] === "hours" ? 60 : 1), unit: "business_minutes" } : null;
  return { n: n * hit[2], unit: hit[1] };
}
/** A said length of time in the unit a number DECLARES: exact for calendar units; working time only to working time; else why not. */
export function inUnit(said: { n: number; unit: TimeUnit }, to: TimeUnit): number | string {
  if (said.unit === to) return said.n;
  const a = SECONDS_IN[said.unit], b = SECONDS_IN[to];
  if (a !== undefined && b !== undefined) return (said.n * a) / b;
  return to === "business_minutes"
    ? `it is calendar time, and the value is counted in working minutes only — say it in working hours or minutes`
    : `it is working time, and the value is counted in calendar ${to}`;
}

/** A value typed or quoted, as the literal its field's type takes — a number field takes a number, and words that are not one are refused. */
/** A compared number as the PERSON says it: an amount declared in minor units is shown in whole units (the inverse of `literalFor`). */
export function personNumber(t: Ty, v: unknown): string {
  const u = unwrap(t);
  return typeof v === "number" && isNum(u) && "unit" in u && u.unit === "minor" ? String(v / 100) : String(v);
}

function literalFor(t: Ty, value: string, from: Literal["from"], quote?: string): Literal | string {
  // A yes/no test ("if a contract auto-renews") is the field compared with TRUE or FALSE: a true/false field takes the boolean, and a
  // number standing for one (SQLite stores them as 1 / 0) takes 1 or 0. Anything else is refused by the rules below.
  const yesNo = value === "true" ? true : value === "false" ? false : null;
  if (yesNo !== null && unwrap(t).t === "Bool") return { value: yesNo, from, ...(quote ? { quote } : {}) };
  if (yesNo !== null && isNum(unwrap(t))) return { value: yesNo ? 1 : 0, from, ...(quote ? { quote } : {}) };
  if (isNum(unwrap(t))) {
    const n = numberOfWords(value);
    if (n === null) return `“${value}” is not a number`;
    // An amount its owner DECLARED in minor units (cents) is compared with a person's number in whole units: "over 10000" on
    // `amount_cents` is 1,000,000 cents, never 10,000 (the units trap, live). By the declared `unit`, never a name; the quote keeps
    // the person's words, so the readback says what they said.
    const u = unwrap(t);
    // P7 (R23): a length of time said with its unit, for a number that DECLARES its time unit, is converted exactly ("3 days" on a
    // count of minutes is 4320, never 3 — B20 compared `age_mins > 3`); one that cannot be converted is refused with why. A number
    // that declares no unit takes the number as said, as before.
    const tu = "unit" in u && u.unit && u.unit !== "minor" ? u.unit : undefined;
    const said = tu ? timeOfWords(value) : null;
    if (tu && said) { const v = inUnit(said, tu); return typeof v === "string" ? `“${value}”: ${v}` : { value: v, from, ...(quote ? { quote } : {}) }; }
    const scaled = "unit" in u && u.unit === "minor" ? Math.round(n * 100) : n;
    return { value: scaled, from, ...(quote ? { quote } : {}) };
  }
  return { value, from, ...(quote ? { quote } : {}) };
}

/** What a step reads as: its rows' record (a list), or its one record — `null` when neither. */
function shapeOf(f: EFlow, cat: CatalogueSnapshot, stepId: string): { list: boolean; fields: Record<string, Ty> } | null {
  const ty = readableTy(f, cat, stepId);
  if (typeof ty === "string") return null;
  const inner = ty.t === "Envelope" ? ty.of : ty;
  if ((inner.t === "List" || inner.t === "Rows") && inner.of.t === "Record") return { list: true, fields: inner.of.fields };
  if (inner.t === "List" || inner.t === "Rows") return { list: true, fields: {} };
  if (inner.t === "Record") return { list: false, fields: inner.fields };
  return null;
}

/** A comparison on `field`, stating its null rule when the field may be empty (`notNull and …`, D-374) — ONE construction for a
 * Decide, a Split and an edit of either, so an edited condition keeps the rule its placing gave it. */
function testWhere(field: string, fty: Ty, cmp: Cmp, lit: Literal): Pred {
  const c: Pred = { cmp, left: { field }, right: { lit } };
  return fty.t === "Option" ? { and: [{ notNull: field }, c] } : c;
}

export interface DecideSpec {
  subject: string;
  /** `count` — how many rows the subject has; `value` — the ONE number field of a one-record subject; otherwise a field of it —
   * of a list's ROWS, the condition holds when some row passes. */
  measure: "count" | "value" | string;
  cmp: Cmp;
  value: string;
  from: Literal["from"];
  quote?: string;
  /** Continue this condition's chain as an else-if. */
  of?: string;
  /** Compare with ANOTHER FIELD of the same subject ("its spend is more than its budget"), instead of `value`. An amount declared in
   *  minor units against one that is not is converted first — by the declared `unit`, never a name. */
  against?: string;
}
/** The field a Decide tests, and whether it counts first or tests each row — or why the subject cannot be tested that way. */
export function decideField(f: EFlow, cat: CatalogueSnapshot, subject: string, measure: string): { counts: boolean; rows?: true; field: string; ty: Ty } | string {
  const sh = shapeOf(f, cat, subject);
  if (!sh) return `${subject} gives no value to compare`;
  // "The count of" a list that is already ONE number (a count, a total) is that number: counting one record always gives 1, which
  // no goal means. A one-record subject with any other shape has nothing to count.
  if (measure === "count" && !sh.list) {
    const nums = Object.entries(sh.fields).filter(([, t]) => isNum(unwrap(t)));
    return nums.length === 1 ? { counts: false, field: nums[0]![0], ty: nums[0]![1] } : `${subject} is one record, not a list to count`;
  }
  if (measure === "count") return { counts: true, field: "n", ty: { t: "Int" } };
  if (sh.list && measure === "value") return `${subject} is a list; compare its count, a field of its rows, or shape it into one value first`;
  if (sh.list) { const t = sh.fields[measure]; return t ? { counts: false, rows: true, field: measure, ty: t } : `${subject}'s rows have no field \`${measure}\``; }
  const nums = Object.entries(sh.fields).filter(([, t]) => isNum(unwrap(t)));
  if (measure === "value") return nums.length === 1 ? { counts: false, field: nums[0]![0], ty: nums[0]![1] } : `${subject} has ${nums.length ? `${nums.length} numbers (${nums.map(([k]) => k).join(", ")})` : "no number"} — say which`;
  const t = sh.fields[measure];
  return t ? { counts: false, field: measure, ty: t } : `${subject} has no field \`${measure}\``;
}
/** The ops of a Decide: the test and its condition (or else-if). `branch` is the condition's id. */
export function decideOps(f: EFlow, cat: CatalogueSnapshot, d: DecideSpec): { ops: EngineOp[]; test: string; branch: string } | string {
  const fd = decideField(f, cat, d.subject, d.measure);
  if (typeof fd === "string") return fd;
  const test = freshStepId(f, "test"), branch = freshStepId(f, d.of ? "elif" : "when");
  let where: Pred;
  const conv: Array<{ op: "convert"; field: string; as: string; to: "minor_to_major" }> = [];
  if (d.against) {
    const sh = shapeOf(f, cat, d.subject);
    const aty = sh?.fields[d.against];
    if (!sh || !aty) return `${d.subject} has no field \`${d.against}\``;
    if (fd.counts) return "a count is compared with a number, never with a field";
    const [l, r] = [unwrap(fd.ty), unwrap(aty)];
    if (isNum(l) !== isNum(r) || (!isNum(l) && l.t !== r.t)) return `\`${fd.field}\` and \`${d.against}\` are not the same kind of value`;
    // Like units with like: an amount in minor units is compared after ÷100 when the other is not (declared, D-unit).
    const minor = (t: Ty) => isNum(t) && "unit" in t && t.unit === "minor";
    const whole = (n: string) => { let as = `${n}_whole`; for (let k = 2; sh.fields[as]; k++) as = `${n}_whole_${k}`; conv.push({ op: "convert", field: n, as, to: "minor_to_major" }); return as; };
    const lf = minor(l) && !minor(r) ? whole(fd.field) : fd.field;
    const rf = minor(r) && !minor(l) ? whole(d.against) : d.against;
    const c: Pred = { cmp: d.cmp, left: { field: lf }, right: { field: rf } };
    const guards = [fd.ty.t === "Option" ? lf : null, aty.t === "Option" ? rf : null].filter((x): x is string => !!x).map((n) => ({ notNull: n }) as Pred);
    where = guards.length ? { and: [...guards, c] } : c;
  } else {
    const lit = literalFor(fd.ty, d.value, d.from, d.quote);
    if (typeof lit === "string") return lit;
    // A value that may be empty (a total over no rows) says so first: empty does not hold — the Split's rule (D-372, D-374).
    where = testWhere(fd.field, fd.ty, d.cmp, lit);
  }
  // A row test keeps the rows that pass; the condition asks whether any did.
  const pipeline = fd.rows ? [...conv, { op: "filter" as const, where }] : [...(fd.counts ? [{ op: "count" as const, as: "n" }] : []), ...conv, { op: "keep_if" as const, where }];
  const ops: EngineOp[] = d.of
    ? [{ op: "add_transform", id: test, from: d.subject, pipeline, before: chainHead(f, d.of) }, { op: "add_otherwise", id: branch, of: d.of, when: [{ stepId: test, test: "any" }] }]
    : [{ op: "add_transform", id: test, from: d.subject, pipeline }, { op: "add_branch", id: branch, when: [{ stepId: test, test: "any" }] }];
  return { ops, test, branch };
}

export interface SplitSpec { subject: string; field: string; cmp: Cmp; value: string; from: Literal["from"]; quote?: string }
/** The ops of a Split: both filters and both conditions. `matched`/`rest` are the filters, `when` their conditions. */
export function splitOps(f: EFlow, cat: CatalogueSnapshot, s: SplitSpec): { ops: EngineOp[]; matched: string; rest: string; when: [string, string] } | string {
  const sh = shapeOf(f, cat, s.subject);
  if (!sh?.list) return `${s.subject} is not a list of rows to split`;
  const fty = sh.fields[s.field];
  if (!fty) return `${s.subject}'s rows have no field \`${s.field}\``;
  const lit = literalFor(fty, s.value, s.from, s.quote);
  if (typeof lit === "string") return lit;
  // A field that may be null says so first: a null row does not match, so it goes to the rest (D-372) — by construction.
  const where = testWhere(s.field, fty, s.cmp, lit);
  const [matched, rest] = [freshStepId(f, "matched"), freshStepId(f, "rest")];
  const [w1, w2] = freshIds(f, "when", 2) as [string, string];
  return {
    matched, rest, when: [w1, w2],
    ops: [
      { op: "add_transform", id: matched, from: s.subject, pipeline: [{ op: "filter", where }] },
      { op: "add_transform", id: rest, from: s.subject, pipeline: [{ op: "filter", where: { not: where } }] },
      { op: "add_branch", id: w1, when: [{ stepId: matched, test: "any" }] },
      { op: "add_branch", id: w2, when: [{ stepId: rest, test: "any" }] },
    ],
  };
}

/** The comparison inside a test as built by `testWhere` — the field it compares, and how. `null` for any other shape. */
export function testOf(where: Pred): { field: string; cmp: Cmp; lit: Literal } | null {
  const c = "and" in where && where.and.length === 2 && "notNull" in where.and[0]! ? where.and[1]! : where;
  return "cmp" in c && "field" in c.left && "lit" in c.right ? { field: c.left.field, cmp: c.cmp, lit: c.right.lit } : null;
}

/**
 * The ops that change what an existing condition compares (phase C): `testStep` is a Decide's test or a Split side, as the engine
 * recognises them (`decideTest` / `splitSide`). A Decide is one `retest`; a Split is two — its rest regenerated as `not` of the new
 * test, so the two sides still cannot drift apart. The field stays; the comparison and the value change. Applied all-or-nothing.
 */
export function retestOps(f: EFlow, cat: CatalogueSnapshot, testStep: string, cmp: Cmp, value: string): EngineOp[] | string {
  const d = decideTest(f, testStep);
  if (d) {
    const t = testOf(d.where);
    if (!t) return `${testStep}'s test is not one comparison`;
    const counts = d.before.some((c) => c.op === "count");
    const fd = decideField(f, cat, d.subject, counts ? "count" : t.field);
    if (typeof fd === "string") return fd;
    const lit = literalFor(fd.ty, value, "person");
    return typeof lit === "string" ? lit : [{ op: "retest", stepId: testStep, where: testWhere(fd.field, fd.ty, cmp, lit) }];
  }
  const sp = splitSide(f, testStep);
  if (sp) {
    const t = testOf(sp.where);
    const fty = shapeOf(f, cat, sp.subject)?.fields[t?.field ?? ""];
    if (!t || !fty) return `${testStep}'s test is not one comparison on a field of ${sp.subject}`;
    const lit = literalFor(fty, value, "person");
    if (typeof lit === "string") return lit;
    const where = testWhere(t.field, fty, cmp, lit);
    const [matched, rest] = sp.side === "matched" ? [testStep, sp.pair] : [sp.pair, testStep];
    return [{ op: "retest", stepId: matched, where }, { op: "retest", stepId: rest, where: { not: where } }];
  }
  return `${testStep} is not a condition's test`;
}

/**
 * The op that changes what ONE filter stage of a transform compares (2026-09-30: a transform's filter could not be changed): the
 * field stays, the comparison and the value change, the null rule the field needs is kept. A condition's own test and a Split's
 * side are changed from their condition (`retestOps`) — a Split's rest is regenerated with its side, never left behind.
 */
export function stageRetestOps(f: EFlow, cat: CatalogueSnapshot, stepId: string, stage: number, cmp: Cmp, value: string): EngineOp[] | string {
  const s = f.steps.find((x) => x.id === stepId);
  if (!s || s.kind !== "transform") return `${stepId} is not a transform`;
  if (decideTest(f, stepId) || splitSide(f, stepId)) return `${stepId} is a condition's test — change it from its condition`;
  const st = s.pipeline[stage];
  if (!st || st.op !== "filter") return `stage ${stage + 1} of ${stepId} is not a filter`;
  const t = testOf(st.where);
  const fty = t ? rowFieldsBefore(f, cat, s, stage)?.[t.field] : undefined;
  if (!t || !fty) return `stage ${stage + 1} of ${stepId} is not one comparison on a field`;
  const lit = literalFor(fty, value, "person");
  return typeof lit === "string" ? lit : [{ op: "retest", stepId, stage, where: testWhere(t.field, fty, cmp, lit) }];
}
/** The row fields a transform's stage sees: its source's rows, as the stages before it leave them. */
export function rowFieldsBefore(f: EFlow, cat: CatalogueSnapshot, s: Extract<EFlow["steps"][number], { kind: "transform" }>, stage: number): Record<string, Ty> | null {
  const ty = stage === 0 ? readableTy(f, cat, s.from) : transformTy(f, cat, s.from, s.pipeline.slice(0, stage));
  if (typeof ty === "string") return null;
  const inner = ty.t === "Envelope" ? ty.of : ty;
  return (inner.t === "List" || inner.t === "Rows") && inner.of.t === "Record" ? inner.of.fields : null;
}
