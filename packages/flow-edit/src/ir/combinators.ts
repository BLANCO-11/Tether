/**
 * The combinators — the glue language that replaces hand-written jq (compiled-builder phase 2d, D-312).
 *
 * Each combinator is FOUR things that must agree, and the admission kit (`admission.ts`) checks that they do:
 *   1. `typeOf`   — its signature: input type → output type, with preconditions as errors naming what is wrong;
 *   2. `evaluate` — a pure in-process evaluator over JSON values (tests, previews, the soundness fuzz);
 *   3. `lower`    — ONE lowering to a jq program, which `lowerTransformProgram` wraps (I-11/I-43/`| first` stay there);
 *   4. an engine proof — the lowering run on Kestra over fixtures, equal to `evaluate` (`kestra-combinators.ts`).
 *
 * ⚠ The types REMOVE jq's quirks instead of reproducing them. jq orders `null` below every number and `tostring` turns
 * `null` into "null"; a comparison or a template over a value that may be null is therefore a TYPE ERROR here, and the
 * pipeline must say what null means first (`filter notNull` narrows the type; `coalesce` gives a value). That is what
 * lets the evaluator equal the engine on every input the types admit — P7 by construction, not by testing luck.
 *
 * ⚠ A literal carries its PROVENANCE (the constants rule, plan §3.1): quoted from the goal, a catalogue default, or a
 * test fixture. The builder may not invent one; that is phase 3's hole rule, and the field is here so it can be checked.
 */
import { T, render, type Ty } from "../typecheck/types.js";

// ── the language ──────────────────────────────────────────────────────────────

export type LitScalar = string | number | boolean;
export interface Literal { value: LitScalar; from: "goal" | "catalogue" | "person" | "test"; quote?: string }
/**
 * A value a combinator reads: a row's field, a literal with provenance, or a declared FLOW INPUT (the constants rule's third
 * source). An input is lowered as a sentinel the renderer splices with Pebble (`' ~ (inputs.x | toJson) ~ '`), so jq never
 * contains a template (I-11) and the value arrives as a JSON literal whatever it holds.
 */
export type Operand = { field: string } | { lit: Literal } | { input: string; cut?: "month" };
/**
 * ⚠ `cut: "month"` reads a date input BY ITS MONTH (\`.[0:7]\`): a person gives any day of the month they mean, and the
 * comparison is "same month as that day". One input type (a date) for every month question, correct across years — the
 * same rule a written read's \`month\` filter applies in SQL (\`left($1,7)\`).
 */

/** What a pipeline can see besides its rows: the flow's declared inputs (types for typing, values for evaluation). */
export interface IrContext { inputs?: Record<string, Ty>; values?: Record<string, unknown> }
let CTX: IrContext = {};
/** Run `f` with `ctx` visible to typing/evaluation. Scoped so a stale context can never leak between pipelines. */
export function withContext<X>(ctx: IrContext, f: () => X): X {
  const prev = CTX; CTX = ctx;
  try { return f(); } finally { CTX = prev; }
}
export type Cmp = "eq" | "ne" | "lt" | "le" | "gt" | "ge";
export type Pred =
  | { cmp: Cmp; left: Operand; right: Operand }
  | { isNull: string }
  | { notNull: string }
  /** Null, or text of only spaces/tabs/newlines. An explicit class, never \s (JS \s matches Unicode spaces; Java's does not). */
  | { isBlank: string }
  | { and: Pred[] }
  | { or: Pred[] }
  | { not: Pred };
/** A template part: literal text, a field, or an OPTIONAL field — `pre + value + post` when present, nothing when null. */
/**
 * A template part: literal text, a field, or an OPTIONAL field — `pre + value + post` when present, and `else` (default
 * nothing) when null. `else` is how "the promised date, or 'not provided'" is written without a coalesce into text.
 */
export type Part = { text: string } | { field: string } | { opt: string; pre: string; post: string; else?: string };

export type Comb =
  | { op: "filter"; where: Pred }
  | { op: "project"; fields: ProjectField[] }
  | { op: "template"; as: string; parts: Part[] }
  /**
   * One text over all rows. `head` is printed before the joined rows when there ARE rows, and may read one field, \`count\`
   * (the number of rows): "Stuck orders (3):\n" + the lines. The empty input prints \`empty\` alone.
   */
  | { op: "join_text"; as: string; parts: Part[]; sep: string; empty: string; head?: Part[] }
  | { op: "count"; as: string }
  // ── slice 2 ──
  | { op: "sort"; by: string | string[]; dir: "asc" | "desc" }
  | { op: "limit"; n: Literal }
  | { op: "distinct"; by: string }
  | { op: "first" }
  /** The first non-null of the field and its fallbacks, in order; the LAST fallback must be non-null. */
  | { op: "coalesce"; field: string; with: Operand | Operand[] }
  | { op: "convert"; field: string; as: string; to: "text" | "minor_to_major" | "date" | "month" }
  | { op: "derive"; as: string; expr: Expr }
  | { op: "group"; by: string[]; aggs: Agg[] }
  /**
   * Aggregates over ALL rows, with no key: one record. ⚠ The rows may be EMPTY, so `sum`/`min`/`max`/`first` are
   * `Option` (null over nothing), and `avg`/`share` are lowered behind an empty guard (jq errors on 0/0) and typed `Option`.
   */
  | { op: "summarize"; aggs: Agg[] }
  /** Read ONE field of a record as the new value: how a tool that returns `{total, employees: [...]}` becomes rows. */
  | { op: "take"; field: string }
  /**
   * Test ONE record and keep it if the test holds: a list of that record, or an empty list (phase C, D-371). How a condition on a
   * single value (a count, a total, a step's one row) is lowered onto the has-rows test the compiler already emits — never a new
   * `If` expression. The same `Pred` and typing as `filter`; only the input is one record instead of rows.
   */
  | { op: "keep_if"; where: Pred };

/** Typed arithmetic and a case: the only computations `derive` may do (D-312). */
export type Expr =
  | { field: string }
  | { lit: Literal }
  | { add: [Expr, Expr] } | { sub: [Expr, Expr] } | { mul: [Expr, Expr] }
  /** ⚠ The divisor must be a NON-ZERO literal: a column can hold 0, and jq errors on /0 — a run-time failure on data the schema allows. */
  | { div: [Expr, Literal] }
  | { case: Array<{ when: Pred; then: Operand }>; else: Operand };
/**
 * An aggregate. `first`: the field in the group's first row (input order is kept within a group). `distinct_count` /
 * `collect_distinct`: the distinct NON-null values (sorted, as jq's `unique` returns them). `share`: the fraction of rows
 * where `where` holds.
 */
export interface Agg {
  as: string;
  fn: "sum" | "avg" | "min" | "max" | "count" | "count_where" | "collect" | "first" | "distinct_count" | "collect_distinct" | "share" | "join";
  field?: string;
  /**
   * For \`count_where\`/\`share\`, the condition counted. For every OTHER aggregate, a FILTER (SQL's \`FILTER (WHERE …)\`): the
   * aggregate is over the rows where it holds — which may be none, so \`sum\`/\`avg\`/\`min\`/\`max\`/\`first\` become \`Option\`
   * even inside a group. A field it proves non-null may be read by the aggregate.
   */
  where?: Pred;
  fields?: string[];
  /** \`join\`: one text per row, joined by \`sep\` — "" over no rows (only reachable with a \`where\`). */
  parts?: Part[];
  sep?: string;
}

export type Pipeline = Comb[];

/**
 * A projected field: a path, a ONE-element list of a path (a tool's `to: [address]`), or a literal. A literal carries its
 * provenance like any other; a builder may not invent one (phase 3's hole rule).
 */
export type ProjectField =
  | { name: string; from: string }
  | { name: string; list: string }
  | { name: string; lit: Literal }
  /** A list of operands. With \`compact\`, an item may be null and nulls are DROPPED: \`cc: [recruiter]\` or \`[]\`. */
  | { name: string; listOf: Operand[]; compact?: boolean }
  /** The empty list, \`[]\` — it inhabits every list type (\`List<Never>\`), so it fills any list port: \`cc: []\`. */
  | { name: string; emptyList: true };

// ── typing ────────────────────────────────────────────────────────────────────

export type TypeResult = { ok: true; ty: Ty } | { ok: false; error: string };
const bad = (error: string): TypeResult => ({ ok: false, error });

/** The record inside a list-shaped value, or the record itself; `null` for anything else. */
function recordOf(ty: Ty): { fields: Record<string, Ty>; list: boolean } | null {
  const base = ty.t === "Rows" || ty.t === "List" ? ty.of : ty;
  if (base.t !== "Record") return null;
  return { fields: base.fields, list: ty.t === "Rows" || ty.t === "List" };
}

/** A dotted path's type inside a record, or an error naming the missing step of the path. */
function fieldTy(fields: Record<string, Ty>, path: string): Ty | string {
  let cur: Ty = T.record(fields);
  for (const seg of path.split(".")) {
    const base = cur.t === "Option" ? cur.of : cur;
    if (base.t !== "Record") return `"${path}" reads into ${render(cur)}, which has no fields`;
    // A path through a nullable record is itself nullable: reading `.manager.email` off a null manager is null.
    const next = base.fields[seg];
    if (!next) return `"${path}": no field "${seg}" — the rows have ${Object.keys(base.fields).join(", ") || "no fields"}`;
    cur = cur.t === "Option" && next.t !== "Option" ? T.option(next) : next;
  }
  return cur;
}

/**
 * ⚠ The phase 2 gate: a pipeline's output never contains `Opaque`. `filter` and `template` already refuse an Opaque field
 * (it is not a scalar); `project`, `take` and `collect` would pass one straight through, into a typed port nothing had
 * checked — so they refuse it, and the value must be described (a declared output shape, a described query) first.
 */
const containsOpaque = (ty: Ty): boolean => JSON.stringify(ty).includes('"Opaque"');
const opaqueMsg = (f: string) => `"${f}" has no declared type, so nothing downstream could check a read of it — describe it first (declare the tool's output, or describe the query)`;

const SCALAR = new Set(["Text", "Int", "Number", "Bool", "Date", "DateTime", "Month", "Address", "Key"]);
const COMPARABLE: Record<string, string> = { Int: "num", Number: "num", Text: "text", Address: "text", Date: "date", DateTime: "datetime", Month: "month", Bool: "bool" };

function operandTy(fields: Record<string, Ty>, o: Operand): Ty | string {
  if ("field" in o) return fieldTy(fields, o.field);
  if ("input" in o) {
    const ty = CTX.inputs?.[o.input];
    if (!ty) return `no flow input "${o.input}" — declare it (the flow's inputs are ${Object.keys(CTX.inputs ?? {}).join(", ") || "none"})`;
    if (!o.cut) return ty;
    if (ty.t !== "Date" && ty.t !== "DateTime" && ty.t !== "Month") return `input "${o.input}" is ${render(ty)}; only a date has a month`;
    return T.month();
  }
  const v = o.lit.value;
  // A number that is not one (NaN, Infinity — what `Number("some words")` gives) is refused: stored as JSON it becomes null, so
  // the flow a person saved and the flow that compiles would differ (I-351, found by the compile golden 2026-09-29).
  if (typeof v === "number" && !Number.isFinite(v)) return `${String(v)} is not a number`;
  return typeof v === "number" ? (Number.isInteger(v) ? T.int() : T.number()) : typeof v === "boolean" ? T.bool() : T.text();
}

function checkPred(fields: Record<string, Ty>, p: Pred): string | null {
  if ("cmp" in p) {
    const l = operandTy(fields, p.left), r = operandTy(fields, p.right);
    if (typeof l === "string") return l;
    if (typeof r === "string") return r;
    // Equality with null is the same in jq and the evaluator (`null == x` is false for any x); ORDERING a null is not.
    const equality = p.cmp === "eq" || p.cmp === "ne";
    for (const [side, ty] of [["left", l], ["right", r]] as const) {
      if (ty.t === "Option" && !equality) return `the ${side} side (${render(ty)}) may be null; say what null means first (filter notNull, or coalesce)`;
      const base = ty.t === "Option" ? ty.of : ty;
      if (!SCALAR.has(base.t)) return `the ${side} side is ${render(ty)}, which cannot be compared`;
    }
    const lb = l.t === "Option" ? l.of : l, rb = r.t === "Option" ? r.of : r;
    // A text literal against a date/datetime/month column is how a date constant is written; it must be one.
    const litSide = "lit" in p.right ? p.right : "lit" in p.left ? p.left : null;
    const colTy = "lit" in p.right ? lb : rb;
    if (litSide && typeof litSide.lit.value === "string" && (colTy.t === "Date" || colTy.t === "DateTime" || colTy.t === "Month")) {
      const ok = colTy.t === "Date" ? /^\d{4}-\d{2}-\d{2}$/ : colTy.t === "Month" ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T/;
      if (!ok.test(litSide.lit.value)) return `"${litSide.lit.value}" is not a ${colTy.t.toLowerCase()}`;
      return null;
    }
    if (COMPARABLE[lb.t] !== COMPARABLE[rb.t]) return `cannot compare ${render(l)} with ${render(r)}`;
    if (!equality && COMPARABLE[lb.t] === "bool") return `booleans have no order; use eq or ne`;
    return null;
  }
  if ("isBlank" in p) {
    const f = fieldTy(fields, p.isBlank);
    if (typeof f === "string") return f;
    const base = f.t === "Option" ? f.of : f;
    if (base.t !== "Text" && base.t !== "Address" && base.t !== "Key") return `"${p.isBlank}" is ${render(f)}; blank is a property of text`;
    return null;
  }
  if ("isNull" in p || "notNull" in p) {
    const f = fieldTy(fields, "isNull" in p ? p.isNull : p.notNull);
    if (typeof f === "string") return f;
    if (f.t !== "Option") return `"${"isNull" in p ? p.isNull : p.notNull}" is ${render(f)}, never null — the test is always ${"isNull" in p ? "false" : "true"}`;
    return null;
  }
  if ("and" in p || "or" in p) {
    const xs = "and" in p ? p.and : p.or;
    if (xs.length < 2) return `"${"and" in p ? "and" : "or"}" needs at least two conditions`;
    // A conjunction narrows as it reads (phase C, D-374): a member runs only when every one before it held, so after
    // `notNull(f)` the field is not null — `notNull(score) and score > 50` types. jq's `and` and the evaluator's `every` both stop
    // at the first false, so what is typed is what runs. `or` does not narrow (a later member runs exactly when an earlier failed).
    let scope = fields;
    for (const x of xs) {
      const e = checkPred(scope, x);
      if (e) return e;
      if ("and" in p) for (const f of provenNonNull(x)) if (!f.includes(".") && scope[f]?.t === "Option") scope = { ...scope, [f]: (scope[f] as { of: Ty }).of };
    }
    return null;
  }
  return checkPred(fields, p.not);
}

/** Fields a predicate proves non-null when it holds (top-level `notNull`s, and every branch of an `and`). */
function provenNonNull(p: Pred): string[] {
  if ("notNull" in p) return [p.notNull];
  if ("and" in p) return p.and.flatMap(provenNonNull);
  return [];
}

function checkParts(fields: Record<string, Ty>, parts: Part[]): string | null {
  for (const part of parts) {
    if ("text" in part) continue;
    if ("opt" in part) {
      const f = fieldTy(fields, part.opt);
      if (typeof f === "string") return f;
      const base = f.t === "Option" ? f.of : f;
      if (!SCALAR.has(base.t)) return `"${part.opt}" is ${render(f)}, which is not text`;
      continue;
    }
    const f = fieldTy(fields, part.field);
    if (typeof f === "string") return f;
    if (f.t === "Option") return `"${part.field}" may be null and would print as "null"; say what null means first (filter notNull, or coalesce)`;
    if (!SCALAR.has(f.t)) return `"${part.field}" is ${render(f)}, which is not text`;
  }
  return null;
}

export function typeOf(input: Ty, c: Comb): TypeResult {
  const rec = recordOf(input);
  switch (c.op) {
    case "filter": {
      if (!rec || !rec.list) return bad(`filter needs rows; the input is ${render(input)}`);
      const e = checkPred(rec.fields, c.where);
      if (e) return bad(`filter: ${e}`);
      const narrowed = { ...rec.fields };
      for (const f of provenNonNull(c.where)) if (!f.includes(".") && narrowed[f]?.t === "Option") narrowed[f] = (narrowed[f] as { of: Ty }).of;
      return { ok: true, ty: T.list(T.record(narrowed)) };
    }
    case "project": {
      if (!rec) return bad(`project needs a record or rows; the input is ${render(input)}`);
      const out: Record<string, Ty> = {};
      for (const f of c.fields) {
        if (out[f.name]) return bad(`project: "${f.name}" is named twice`);
        if ("lit" in f) { const t = operandTy(rec.fields, { lit: f.lit }); if (typeof t === "string") return bad(`project: ${t}`); out[f.name] = t; continue; }
        if ("emptyList" in f) { out[f.name] = T.list(T.never()); continue; }
        if ("listOf" in f) {
          let item: Ty | null = null;
          for (const o of f.listOf) {
            const t0 = operandTy(rec.fields, o);
            if (typeof t0 === "string") return bad(`project: ${t0}`);
            if (t0.t === "Option" && !f.compact) return bad(`project: an item of "${f.name}" may be null, and the list would hold null (compact drops nulls)`);
            const t = t0.t === "Option" ? t0.of : t0;
            if (!SCALAR.has(t.t)) return bad(`project: an item of "${f.name}" is ${render(t0)}`);
            if (item && COMPARABLE[item.t] !== COMPARABLE[t.t]) return bad(`project: "${f.name}" mixes ${render(item)} and ${render(t)}`);
            // Address and Text mix to Text: the list is only as refined as its least refined item.
            item = item && item.t !== t.t ? (COMPARABLE[t.t] === "text" ? T.text() : item.t === "Number" ? item : t) : item ?? t;
          }
          if (!item) return bad(`project: "${f.name}" is an empty list`);
          out[f.name] = T.list(item); continue;
        }
        const src = "from" in f ? f.from : (f as { list: string }).list;
        const ty = fieldTy(rec.fields, src);
        if (typeof ty === "string") return bad(`project: ${ty}`);
        if (containsOpaque(ty)) return bad(`project: ${opaqueMsg(src)}`);
        // ⚠ A one-element list of a value that may be null is `[null]` — a recipient list holding null. Refused.
        if ("list" in f && ty.t === "Option") return bad(`project: "${f.list}" may be null, and a list of it would hold null; say what null means first`);
        out[f.name] = "list" in f ? T.list(ty) : ty;
      }
      return { ok: true, ty: rec.list ? T.list(T.record(out)) : T.record(out) };
    }
    case "template": {
      if (!rec) return bad(`template needs a record or rows; the input is ${render(input)}`);
      if (rec.fields[c.as]) return bad(`template: "${c.as}" already exists on the rows`);
      const e = checkParts(rec.fields, c.parts);
      if (e) return bad(`template: ${e}`);
      const next = T.record({ ...rec.fields, [c.as]: T.text() });
      return { ok: true, ty: rec.list ? T.list(next) : next };
    }
    case "join_text": {
      if (!rec || !rec.list) return bad(`join_text needs rows; the input is ${render(input)}`);
      const e = checkParts(rec.fields, c.parts);
      if (e) return bad(`join_text: ${e}`);
      const h = c.head ? checkParts({ count: T.int() }, c.head) : null;
      if (h) return bad(`join_text head: ${h} (a head reads only "count", the number of rows)`);
      return { ok: true, ty: T.record({ [c.as]: T.text() }) };
    }
    case "count": {
      if (input.t !== "List" && input.t !== "Rows") return bad(`count needs rows; the input is ${render(input)}`);
      return { ok: true, ty: T.record({ [c.as]: T.int() }) };
    }
    case "sort": case "distinct": {
      if (!rec || !rec.list) return bad(`${c.op} needs rows; the input is ${render(input)}`);
      const keys = Array.isArray(c.by) ? c.by : [c.by];
      if (keys.length === 0) return bad(`${c.op} needs a key`);
      if (c.op === "distinct" && keys.length > 1) return bad(`distinct takes one key`);
      for (const k of keys) {
        const f = fieldTy(rec.fields, k);
        if (typeof f === "string") return bad(`${c.op}: ${f}`);
        if (f.t === "Option") return bad(`${c.op}: "${k}" may be null, and jq orders null before every value — say what null means first`);
        if (!SCALAR.has(f.t)) return bad(`${c.op}: "${k}" is ${render(f)}, which has no order`);
      }
      return { ok: true, ty: T.list(T.record(rec.fields)) };
    }
    case "limit": {
      if (!rec || !rec.list) return bad(`limit needs rows; the input is ${render(input)}`);
      if (typeof c.n.value !== "number" || !Number.isInteger(c.n.value) || c.n.value < 0) return bad(`limit: "${c.n.value}" is not a whole number of rows`);
      return { ok: true, ty: T.list(T.record(rec.fields)) };
    }
    case "first": {
      if (!rec || !rec.list) return bad(`first needs rows; the input is ${render(input)}`);
      // Over zero rows there is no first row: the result may be null, and a reader must say what that means.
      return { ok: true, ty: T.option(T.record(rec.fields)) };
    }
    case "coalesce": {
      if (!rec) return bad(`coalesce needs a record or rows; the input is ${render(input)}`);
      const f = fieldTy(rec.fields, c.field);
      if (typeof f === "string") return bad(`coalesce: ${f}`);
      if (f.t !== "Option") return bad(`coalesce: "${c.field}" is ${render(f)}, never null — there is nothing to fill`);
      if (c.field.includes(".")) return bad(`coalesce: fill a top-level field; project the nested one first`);
      // ⚠ jq's `//` treats FALSE like null, so coalescing a boolean would replace real `false` values.
      if (f.of.t === "Bool") return bad(`coalesce: "${c.field}" is a boolean, and jq's fallback treats false as missing — use a case in derive`);
      const alts = Array.isArray(c.with) ? c.with : [c.with];
      if (alts.length === 0) return bad(`coalesce: name a fallback`);
      for (const [i, alt] of alts.entries()) {
        const w = operandTy(rec.fields, alt);
        if (typeof w === "string") return bad(`coalesce: ${w}`);
        // A last fallback that may be null leaves the field \`Option\` — still honest, and a later \`filter notNull\` narrows it.
        const wb = w.t === "Option" ? w.of : w;
        if (wb.t === "Bool") return bad(`coalesce: a boolean fallback — jq's fallback treats false as missing`);
        if (COMPARABLE[wb.t] !== COMPARABLE[f.of.t]) return bad(`coalesce: fallback ${i + 1} is ${render(w)}, the field is ${render(f.of)}`);
      }
      const altTys = alts.map((a) => operandTy(rec.fields, a) as Ty);
      const last = altTys[altTys.length - 1]!;
      // ⚠ The filled field is only as refined as its least refined source: an Address filled from a Text literal is Text,
      // an Int filled from a Number is a Number. Keeping the field's own type would let a fallback carry a refinement it lacks.
      const bases = altTys.map((t) => (t.t === "Option" ? t.of : t));
      const filled = bases.every((b) => b.t === f.of.t) ? f.of : COMPARABLE[f.of.t] === "text" ? T.text() : COMPARABLE[f.of.t] === "num" ? T.number() : f.of;
      const next = T.record({ ...rec.fields, [c.field]: last.t === "Option" ? T.option(filled) : filled });
      return { ok: true, ty: rec.list ? T.list(next) : next };
    }
    case "convert": {
      if (!rec) return bad(`convert needs a record or rows; the input is ${render(input)}`);
      const f = fieldTy(rec.fields, c.field);
      if (typeof f === "string") return bad(`convert: ${f}`);
      // An amount in minor units that may be empty converts to an amount that may be empty: ÷100 has one answer for a null (null),
      // so nothing needs saying first. Text and a date do not — their null would become the words "null".
      if (f.t === "Option" && c.to !== "minor_to_major") return bad(`convert: "${c.field}" may be null; say what null means first`);
      const inner = f.t === "Option" ? f.of : f;
      if (rec.fields[c.as] && c.as !== c.field) return bad(`convert: "${c.as}" already exists on the rows`);
      if (c.to === "text" && !SCALAR.has(f.t)) return bad(`convert: "${c.field}" is ${render(f)}, which has no text form`);
      if (c.to === "minor_to_major" && inner.t !== "Int" && inner.t !== "Number") return bad(`convert: minor units must be a number; "${c.field}" is ${render(f)}`);
      // The calendar day of a moment (slice 5d): an ISO timestamp's first ten characters are its UTC date, so a day-precision
      // comparison ("has the date passed?") compares like with like. A Date converts to itself.
      if (c.to === "date" && f.t !== "DateTime" && f.t !== "Date") return bad(`convert: only a date or a moment has a date; "${c.field}" is ${render(f)}`);
      if (c.to === "month" && f.t !== "DateTime" && f.t !== "Date" && f.t !== "Month") return bad(`convert: only a date or a moment has a month; "${c.field}" is ${render(f)}`);
      const next = T.record({ ...rec.fields, [c.as]: c.to === "text" ? T.text() : c.to === "date" ? T.date() : c.to === "month" ? T.month() : f.t === "Option" ? T.option(T.number()) : T.number() });
      return { ok: true, ty: rec.list ? T.list(next) : next };
    }
    case "derive": {
      if (!rec) return bad(`derive needs a record or rows; the input is ${render(input)}`);
      if (rec.fields[c.as]) return bad(`derive: "${c.as}" already exists on the rows`);
      const t = exprTy(rec.fields, c.expr);
      if (typeof t === "string") return bad(`derive: ${t}`);
      const next = T.record({ ...rec.fields, [c.as]: t });
      return { ok: true, ty: rec.list ? T.list(next) : next };
    }
    case "keep_if": {
      if (!rec || rec.list) return bad(`keep_if tests ONE record; the input is ${render(input)} — use filter for rows`);
      const e = checkPred(rec.fields, c.where);
      if (e) return bad(`keep_if: ${e}`);
      const narrowed = { ...rec.fields };
      for (const f of provenNonNull(c.where)) if (!f.includes(".") && narrowed[f]?.t === "Option") narrowed[f] = (narrowed[f] as { of: Ty }).of;
      return { ok: true, ty: T.list(T.record(narrowed)) };
    }
    case "take": {
      if (!rec || rec.list) return bad(`take reads a field of ONE record; the input is ${render(input)}`);
      const f = fieldTy(rec.fields, c.field);
      if (typeof f === "string") return bad(`take: ${f}`);
      if (containsOpaque(f)) return bad(`take: ${opaqueMsg(c.field)}`);
      return { ok: true, ty: f };
    }
    case "group": {
      if (!rec || !rec.list) return bad(`group needs rows; the input is ${render(input)}`);
      if (c.by.length === 0) return bad(`group needs at least one key; a total over all rows is an aggregate without a key`);
      const out: Record<string, Ty> = {};
      for (const k of c.by) {
        const f = fieldTy(rec.fields, k);
        if (typeof f === "string") return bad(`group: ${f}`);
        if (f.t === "Option") return bad(`group: key "${k}" may be null; say what null means first`);
        if (!SCALAR.has(f.t)) return bad(`group: key "${k}" is ${render(f)}`);
        if (k.includes(".")) return bad(`group: group by a top-level field; project the nested one first`);
        out[k] = f;
      }
      for (const a of c.aggs) {
        if (out[a.as]) return bad(`group: "${a.as}" is named twice`);
        const t = aggTy(rec.fields, a, false);
        if (typeof t === "string") return bad(`group: ${t}`);
        out[a.as] = t;
      }
      return { ok: true, ty: T.list(T.record(out)) };
    }
    case "summarize": {
      if (!rec || !rec.list) return bad(`summarize needs rows; the input is ${render(input)}`);
      const out: Record<string, Ty> = {};
      for (const a of c.aggs) {
        if (out[a.as]) return bad(`summarize: "${a.as}" is named twice`);
        const t = aggTy(rec.fields, a, true);
        if (typeof t === "string") return bad(`summarize: ${t}`);
        out[a.as] = t;
      }
      return { ok: true, ty: T.record(out) };
    }
  }
}

/** Fields narrowed by what a predicate proves non-null when it holds. */
function narrowBy(fields: Record<string, Ty>, p: Pred): Record<string, Ty> {
  const out = { ...fields };
  for (const f of provenNonNull(p)) if (!f.includes(".") && out[f]?.t === "Option") out[f] = (out[f] as { of: Ty }).of;
  return out;
}

/**
 * ONE aggregate's type. \`mayBeEmpty\`: the rows may be none (\`summarize\`, or any aggregate with a FILTER); a group always
 * has at least one row. A filter (\`where\` on anything but count_where/share) checks first, narrows the fields it proves
 * non-null, and makes the aggregate range over possibly no rows.
 */
function aggTy(fields: Record<string, Ty>, a: Agg, mayBeEmpty: boolean): Ty | string {
  if (a.where && a.fn !== "count_where" && a.fn !== "share") {
    if (a.fn === "count") return `count "${a.as}" with a condition is count_where`;
    const e = checkPred(fields, a.where);
    if (e) return e;
    return aggTy(narrowBy(fields, a.where), { ...a, where: undefined }, true);
  }
  if (a.fn === "join") {
    if (!a.parts?.length) return `join "${a.as}" names no parts`;
    if (typeof a.sep !== "string") return `join "${a.as}" needs a separator`;
    const e = checkParts(fields, a.parts);
    return e ?? T.text();
  }
  if (a.fn === "first" || a.fn === "distinct_count" || a.fn === "collect_distinct" || a.fn === "share") return extraAggTy(fields, a, mayBeEmpty);
  if (mayBeEmpty) return summarizeAggTy(fields, a);
  if (a.fn === "count") return T.int();
  if (a.fn === "count_where") {
    if (!a.where) return `count_where "${a.as}" needs a condition`;
    return checkPred(fields, a.where) ?? T.int();
  }
  if (a.fn === "collect") {
    const out: Record<string, Ty> = {};
    for (const f of a.fields ?? []) { const t = fieldTy(fields, f); if (typeof t === "string") return t; if (containsOpaque(t)) return opaqueMsg(f); out[f] = t; }
    if (!a.fields?.length) return `collect "${a.as}" names no fields`;
    return T.list(T.record(out));
  }
  if (!a.field) return `${a.fn} "${a.as}" needs a field`;
  const f = fieldTy(fields, a.field);
  if (typeof f === "string") return f;
  if (f.t === "Option") return `${a.fn} over "${a.field}", which may be null; say what null means first`;
  if (a.fn === "sum" || a.fn === "avg") {
    if (f.t !== "Int" && f.t !== "Number") return `${a.fn} needs a number; "${a.field}" is ${render(f)}`;
    return a.fn === "sum" && f.t === "Int" ? T.int() : T.number();
  }
  if (!SCALAR.has(f.t)) return `${a.fn} needs an ordered value; "${a.field}" is ${render(f)}`;
  return f; // a group always has at least one row, so min/max are never null
}

/** The four aggregates added for re-expression; `mayBeEmpty` is true in `summarize` (no group guarantees a row). */
function extraAggTy(fields: Record<string, Ty>, a: Agg, mayBeEmpty: boolean): Ty | string {
  if (a.fn === "share") {
    if (!a.where) return `share "${a.as}" needs a condition`;
    const e = checkPred(fields, a.where);
    if (e) return e;
    return mayBeEmpty ? T.option(T.number()) : T.number();
  }
  if (!a.field) return `${a.fn} "${a.as}" needs a field`;
  const f = fieldTy(fields, a.field);
  if (typeof f === "string") return f;
  if (containsOpaque(f)) return opaqueMsg(a.field);
  const base = f.t === "Option" ? f.of : f;
  if (a.fn === "first") return mayBeEmpty ? T.option(base) : f;
  if (!SCALAR.has(base.t)) return `${a.fn} needs a scalar; "${a.field}" is ${render(f)}`;
  return a.fn === "distinct_count" ? T.int() : T.list(base);
}

/** The original aggregates in `summarize`: over possibly-empty rows, everything but a count may be null. */
function summarizeAggTy(fields: Record<string, Ty>, a: Agg): Ty | string {
  if (a.fn === "count") return T.int();
  if (a.fn === "count_where") { if (!a.where) return `count_where "${a.as}" needs a condition`; const e = checkPred(fields, a.where); return e ?? T.int(); }
  if (a.fn === "collect") {
    if (!a.fields?.length) return `collect "${a.as}" names no fields`;
    const out: Record<string, Ty> = {};
    for (const f of a.fields) { const t = fieldTy(fields, f); if (typeof t === "string") return t; if (containsOpaque(t)) return opaqueMsg(f); out[f] = t; }
    return T.list(T.record(out));
  }
  if (!a.field) return `${a.fn} "${a.as}" needs a field`;
  const f = fieldTy(fields, a.field);
  if (typeof f === "string") return f;
  if (f.t === "Option") return `${a.fn} over "${a.field}", which may be null; say what null means first`;
  if ((a.fn === "sum" || a.fn === "avg") && f.t !== "Int" && f.t !== "Number") return `${a.fn} needs a number; "${a.field}" is ${render(f)}`;
  if (!SCALAR.has(f.t)) return `${a.fn} needs an ordered value; "${a.field}" is ${render(f)}`;
  return T.option(a.fn === "avg" ? T.number() : a.fn === "sum" ? (f.t === "Int" ? T.int() : T.number()) : f);
}

function exprTy(fields: Record<string, Ty>, e: Expr): Ty | string {
  if ("field" in e || "lit" in e) {
    const t = operandTy(fields, e as Operand);
    if (typeof t === "string") return t;
    if (t.t === "Option") return `"${(e as { field: string }).field}" may be null; say what null means first (coalesce)`;
    return t;
  }
  if ("case" in e) {
    if (e.case.length === 0) return "a case needs at least one branch";
    let out: Ty | null = null;
    for (const b of [...e.case.map((x) => x.then), e.else]) {
      const t = operandTy(fields, b);
      if (typeof t === "string") return t;
      if (t.t === "Option") return `a case result may be null; say what null means first`;
      if (out && COMPARABLE[out.t] !== COMPARABLE[t.t]) return `a case mixes ${render(out)} and ${render(t)}`;
      out = out && out.t === "Number" ? out : t.t === "Number" ? t : out ?? t;
    }
    for (const b of e.case) { const err = checkPred(fields, b.when); if (err) return err; }
    return out!;
  }
  const [op, [a, b]] = Object.entries(e)[0] as [string, [Expr, Expr | Literal]];
  const ta = exprTy(fields, a);
  if (typeof ta === "string") return ta;
  const tb = op === "div" ? operandTy(fields, { lit: b as Literal }) : exprTy(fields, b as Expr);
  if (typeof tb === "string") return tb;
  for (const t of [ta, tb]) if (t.t !== "Int" && t.t !== "Number") return `${op} needs numbers; got ${render(t)}`;
  if (op === "div") {
    const v = (b as Literal).value;
    if (typeof v !== "number" || v === 0) return `divide only by a non-zero number; "${v}" would fail at run time`;
    return T.number();
  }
  return ta.t === "Int" && tb.t === "Int" ? T.int() : T.number();
}

/** A whole pipeline's type, or the first step that does not type, by index. */
export function typePipeline(input: Ty, p: Pipeline): { ok: true; ty: Ty } | { ok: false; at: number; error: string } {
  let ty = input;
  for (const [i, c] of p.entries()) {
    const r = typeOf(ty, c);
    if (!r.ok) return { ok: false, at: i, error: r.error };
    ty = r.ty;
  }
  return { ok: true, ty };
}

// ── evaluation ────────────────────────────────────────────────────────────────

type J = unknown;
const get = (row: J, path: string): J => path.split(".").reduce<J>((v, k) => (v && typeof v === "object" ? (v as Record<string, J>)[k] ?? null : null), row);
const operand = (row: J, o: Operand): J => {
  if ("field" in o) return get(row, o.field);
  if (!("input" in o)) return o.lit.value;
  const v = CTX.values?.[o.input] ?? null;
  return o.cut === "month" && v !== null ? jqToString(v).slice(0, 7) : v;
};
/** jq's `tostring` for the scalars the types admit (strings verbatim; numbers as jq prints them). */
export function jqToString(v: J): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  return JSON.stringify(v);
}

function holds(row: J, p: Pred): boolean {
  if ("cmp" in p) {
    const l = operand(row, p.left) as number | string | boolean, r = operand(row, p.right) as number | string | boolean;
    switch (p.cmp) {
      case "eq": return l === r;
      case "ne": return l !== r;
      case "lt": return l < r;
      case "le": return l <= r;
      case "gt": return l > r;
      case "ge": return l >= r;
    }
  }
  if ("isNull" in p) return get(row, p.isNull) === null;
  if ("isBlank" in p) { const v = get(row, p.isBlank); return v === null || /^[ \t\n\r]*$/.test(String(v)); }
  if ("notNull" in p) return get(row, p.notNull) !== null;
  if ("and" in p) return p.and.every((x) => holds(row, x));
  if ("or" in p) return p.or.some((x) => holds(row, x));
  return !holds(row, p.not);
}

const fill = (row: J, parts: Part[]) =>
  parts.map((x) => ("text" in x ? x.text : "opt" in x ? (get(row, x.opt) === null ? x.else ?? "" : x.pre + jqToString(get(row, x.opt)) + x.post) : jqToString(get(row, x.field)))).join("");

export function evaluate(input: J, c: Comb): J {
  const rows = input as J[];
  switch (c.op) {
    case "filter": return rows.filter((r) => holds(r, c.where));
    case "project": {
      const val = (r: J, f: ProjectField): J =>
        "lit" in f ? f.lit.value
        : "emptyList" in f ? []
        : "listOf" in f ? f.listOf.map((o) => operand(r, o)).filter((v) => !f.compact || v !== null)
        : "list" in f ? [get(r, f.list)] : get(r, f.from);
      const one = (r: J) => Object.fromEntries(c.fields.map((f) => [f.name, val(r, f)]));
      return Array.isArray(input) ? rows.map(one) : one(input);
    }
    case "template": {
      const one = (r: J) => ({ ...(r as object), [c.as]: fill(r, c.parts) });
      return Array.isArray(input) ? rows.map(one) : one(input);
    }
    case "join_text": return { [c.as]: rows.length === 0 ? c.empty : (c.head ? fill({ count: rows.length }, c.head) : "") + rows.map((r) => fill(r, c.parts)).join(c.sep) };
    case "count": return { [c.as]: rows.length };
    case "sort": {
      const keys = Array.isArray(c.by) ? c.by : [c.by];
      const key = (r: J) => (keys.length === 1 ? get(r, keys[0]!) : keys.map((k) => get(r, k)));
      const asc = stableSort(rows, (a, b) => jqCompare(key(a), key(b)));
      return c.dir === "asc" ? asc : asc.reverse(); // jq: sort_by | reverse
    }
    case "limit": return rows.slice(0, c.n.value as number);
    case "distinct": {
      const by = Array.isArray(c.by) ? c.by[0]! : c.by;
      const sorted = stableSort(rows, (a, b) => jqCompare(get(a, by), get(b, by)));
      return sorted.filter((r, i) => i === 0 || jqCompare(get(r, by), get(sorted[i - 1], by)) !== 0);
    }
    case "first": return rows.length ? rows[0] : null;
    case "take": return get(input, c.field);
    case "keep_if": return holds(input, c.where) ? [input] : [];
    case "coalesce": {
      const alts = Array.isArray(c.with) ? c.with : [c.with];
      const one = (r: J) => ({ ...(r as object), [c.field]: [get(r, c.field), ...alts.map((a) => operand(r, a))].find((v) => v !== null && v !== false) ?? null });
      return Array.isArray(input) ? rows.map(one) : one(input);
    }
    case "convert": {
      const one = (r: J) => { const v = get(r, c.field); return { ...(r as object), [c.as]: c.to === "text" ? jqToString(v) : c.to === "date" ? jqToString(v).slice(0, 10) : c.to === "month" ? jqToString(v).slice(0, 7) : v === null ? null : (v as number) / 100 }; };
      return Array.isArray(input) ? rows.map(one) : one(input);
    }
    case "derive": {
      const one = (r: J) => ({ ...(r as object), [c.as]: evalExpr(r, c.expr) });
      return Array.isArray(input) ? rows.map(one) : one(input);
    }
    case "group": {
      const key = (r: J) => c.by.map((k) => get(r, k));
      const sorted = stableSort(rows, (a, b) => jqCompare(key(a), key(b)));
      const groups: J[][] = [];
      for (const r of sorted) {
        const last = groups[groups.length - 1];
        if (last && jqCompare(key(last[0]), key(r)) === 0) last.push(r); else groups.push([r]);
      }
      return groups.map((g) => {
        const out: Record<string, J> = Object.fromEntries(c.by.map((k) => [k, get(g[0], k)]));
        for (const a of c.aggs) out[a.as] = evalAgg(g, a);
        return out;
      });
    }
    case "summarize": return Object.fromEntries(c.aggs.map((a) => [a.as, evalAgg(rows, a)]));
  }
}

/** One aggregate over one set of rows, exactly as its lowering computes it (empty ⇒ null where the lowering yields null). */
function evalAgg(g: J[], a: Agg): J {
  if (a.where && a.fn !== "count_where" && a.fn !== "share") return evalAgg(g.filter((r) => holds(r, a.where!)), { ...a, where: undefined });
  const vals = () => g.map((r) => get(r, a.field!));
  const distinct = () => { const v = vals().filter((x) => x !== null); return stableSort(v, jqCompare).filter((x, i, xs) => i === 0 || jqCompare(x, xs[i - 1]) !== 0); };
  switch (a.fn) {
    case "count": return g.length;
    case "count_where": return g.filter((r) => holds(r, a.where!)).length;
    case "collect": return g.map((r) => Object.fromEntries((a.fields ?? []).map((f) => [f, get(r, f)])));
    case "sum": return g.length ? (vals() as number[]).reduce((x, y) => x + y) : null;
    case "avg": return g.length ? (vals() as number[]).reduce((x, y) => x + y) / g.length : null;
    case "min": return g.length ? vals().reduce((x, y) => (jqCompare(y, x) < 0 ? y : x)) : null;
    case "max": return g.length ? vals().reduce((x, y) => (jqCompare(y, x) >= 0 ? y : x)) : null;
    case "first": return g.length ? get(g[0], a.field!) : null;
    case "distinct_count": return distinct().length;
    case "collect_distinct": return distinct();
    case "share": return g.length ? g.filter((r) => holds(r, a.where!)).length / g.length : null;
    case "join": return g.map((r) => fill(r, a.parts!)).join(a.sep!);
  }
}

/** jq's total order over the values the types admit: booleans < numbers < strings < arrays, element by element. */
export function jqCompare(a: J, b: J): number {
  const rank = (v: J) => (v === null ? 0 : typeof v === "boolean" ? (v ? 2 : 1) : typeof v === "number" ? 3 : typeof v === "string" ? 4 : Array.isArray(v) ? 5 : 6);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "number") return (a as number) - (b as number);
  if (typeof a === "string") return a < (b as string) ? -1 : a > (b as string) ? 1 : 0;
  if (Array.isArray(a)) {
    const bb = b as J[];
    for (let i = 0; i < Math.min(a.length, bb.length); i++) { const d = jqCompare(a[i], bb[i]); if (d !== 0) return d; }
    return a.length - bb.length;
  }
  return 0;
}
function stableSort<X>(xs: X[], cmp: (a: X, b: X) => number): X[] {
  return xs.map((x, i) => [x, i] as const).sort((p, q) => cmp(p[0], q[0]) || p[1] - q[1]).map((p) => p[0]);
}
function evalExpr(row: J, e: Expr): J {
  if ("field" in e) return get(row, e.field);
  if ("lit" in e) return e.lit.value;
  if ("case" in e) { for (const b of e.case) if (holds(row, b.when)) return operand(row, b.then); return operand(row, e.else); }
  if ("add" in e) return (evalExpr(row, e.add[0]) as number) + (evalExpr(row, e.add[1]) as number);
  if ("sub" in e) return (evalExpr(row, e.sub[0]) as number) - (evalExpr(row, e.sub[1]) as number);
  if ("mul" in e) return (evalExpr(row, e.mul[0]) as number) * (evalExpr(row, e.mul[1]) as number);
  return (evalExpr(row, e.div[0]) as number) / (e.div[1].value as number);
}

export const evaluatePipeline = (input: J, p: Pipeline): J => p.reduce((v, c) => evaluate(v, c), input);

// ── lowering ──────────────────────────────────────────────────────────────────

/**
 * A jq string literal that can never close the Pebble single-quoted string it is embedded in: JSON, with `'` escaped
 * as `\\u0027` (valid jq). The lowering is therefore accepted by `lowerTransformProgram`'s no-`'` rule by construction.
 */
export function jqLit(v: LitScalar): string {
  return typeof v === "string" ? JSON.stringify(v).replace(/'/g, "\\u0027") : JSON.stringify(v);
}
const path = (p: string) => p.split(".").map((k) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? `.${k}` : `.${jqLit(k)}`)).join("");
/** The sentinel an input operand lowers to; `spliceInputs` turns it into Pebble concatenation. Not valid jq on its own. */
export const INPUT_SENTINEL = (id: string) => `__FOUNDRY_INPUT_${id}__`;
const lowerOperand = (o: Operand) => ("field" in o ? path(o.field) : "input" in o ? (o.cut === "month" ? `(${INPUT_SENTINEL(o.input)} | tostring | .[0:7])` : INPUT_SENTINEL(o.input)) : jqLit(o.lit.value));

/**
 * A lowered program as the ARGUMENT of Pebble's `jq(…)`: the program in single quotes, with every input sentinel replaced
 * by `' ~ (inputs.<id> | toJson) ~ '`. Measured on the engine (input-splice-probe): the value reaches jq as a JSON literal,
 * quotes and apostrophes included. A program with no inputs is returned as one quoted literal.
 */
export function spliceInputs(program: string): string {
  const parts = program.split(/__FOUNDRY_INPUT_([A-Za-z_][A-Za-z0-9_]*)__/);
  return parts.map((seg, i) => (i % 2 === 0 ? `'${seg}'` : `(inputs.${seg} | toJson)`)).join(" ~ ").replace(/'' ~ /g, "").replace(/ ~ ''$/g, "");
}
const CMP: Record<Cmp, string> = { eq: "==", ne: "!=", lt: "<", le: "<=", gt: ">", ge: ">=" };
function lowerPred(p: Pred): string {
  if ("cmp" in p) return `(${lowerOperand(p.left)} ${CMP[p.cmp]} ${lowerOperand(p.right)})`;
  if ("isNull" in p) return `(${path(p.isNull)} == null)`;
  if ("isBlank" in p) return `((${path(p.isBlank)} // "") | tostring | test("^[ \\t\\n\\r]*$"))`;
  if ("notNull" in p) return `(${path(p.notNull)} != null)`;
  if ("and" in p) return `(${p.and.map(lowerPred).join(" and ")})`;
  if ("or" in p) return `(${p.or.map(lowerPred).join(" or ")})`;
  return `(${lowerPred(p.not)} | not)`;
}
const lowerPart = (x: Part) =>
  "text" in x ? jqLit(x.text)
  : "opt" in x ? `(if ${path(x.opt)} == null then ${jqLit(x.else ?? "")} else (${jqLit(x.pre)} + (${path(x.opt)} | tostring) + ${jqLit(x.post)}) end)`
  : `(${path(x.field)} | tostring)`;
const lowerParts = (parts: Part[]) => (parts.length ? parts.map(lowerPart).join(" + ") : `""`);

/**
 * The jq vocabulary a lowering may use. ⚠ `has`, `keys`, `to_entries`, `with_entries`, `del`, `paths` are BANNED: Kestra
 * drops null-valued keys (see `dropNullKeys`), so any test of key presence gives different answers on the engine and in
 * the evaluator. `assertLoweringVocabulary` enforces it on every lowering the kit admits.
 */
export const BANNED_JQ = ["has", "keys", "to_entries", "with_entries", "from_entries", "del", "paths", "getpath", "env", "input", "inputs", "$__loc__", "debug"];
export function assertLoweringVocabulary(program: string): void {
  const stripped = program.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (const w of BANNED_JQ) if (new RegExp(`(^|[^A-Za-z0-9_$])${w.replace(/\$/g, "\\$")}([^A-Za-z0-9_]|$)`).test(stripped)) throw new Error(`lowering uses "${w}", which is banned (key presence is invisible on the engine)`);
}

export function lower(c: Comb, inputIsList: boolean): string {
  switch (c.op) {
    case "filter": return `map(select(${lowerPred(c.where)}))`;
    case "project": {
      const val = (f: ProjectField) =>
        "lit" in f ? jqLit(f.lit.value)
        : "emptyList" in f ? "[]"
        : "listOf" in f ? (f.compact ? `([${f.listOf.map(lowerOperand).join(", ")}] | map(select(. != null)))` : `[${f.listOf.map(lowerOperand).join(", ")}]`)
        : "list" in f ? `[${path(f.list)}]` : path(f.from);
      const obj = `{${c.fields.map((f) => `${jqLit(f.name)}: ${val(f)}`).join(", ")}}`;
      return inputIsList ? `map(${obj})` : obj;
    }
    case "template": {
      const add = `. + {${jqLit(c.as)}: (${lowerParts(c.parts)})}`;
      return inputIsList ? `map(${add})` : add;
    }
    case "join_text":
      return `{${jqLit(c.as)}: (if length == 0 then ${jqLit(c.empty)} else (${c.head ? `({count: length} | ${lowerParts(c.head)}) + ` : ""}(map(${lowerParts(c.parts)}) | join(${jqLit(c.sep)}))) end)}`;
    case "count": return `{${jqLit(c.as)}: length}`;
    case "sort": {
      const keys = Array.isArray(c.by) ? c.by : [c.by];
      const k = keys.length === 1 ? path(keys[0]!) : `[${keys.map(path).join(", ")}]`;
      return c.dir === "asc" ? `sort_by(${k})` : `sort_by(${k}) | reverse`;
    }
    case "limit": return `.[0:${Number(c.n.value)}]`;
    case "distinct": return `unique_by(${path(Array.isArray(c.by) ? c.by[0]! : c.by)})`;
    case "first": return `.[0]`;
    case "take": return path(c.field);
    case "keep_if": return `[.] | map(select(${lowerPred(c.where)}))`;
    case "coalesce": {
      const alts = Array.isArray(c.with) ? c.with : [c.with];
      const add = `. + {${jqLit(c.field)}: (${[path(c.field), ...alts.map(lowerOperand)].join(" // ")})}`;
      return inputIsList ? `map(${add})` : add;
    }
    case "convert": {
      const v = c.to === "text" ? `(${path(c.field)} | tostring)` : c.to === "date" ? `(${path(c.field)} | tostring | .[0:10])` : c.to === "month" ? `(${path(c.field)} | tostring | .[0:7])` : `(${path(c.field)} | if . == null then null else . / 100 end)`;
      const add = `. + {${jqLit(c.as)}: ${v}}`;
      return inputIsList ? `map(${add})` : add;
    }
    case "derive": {
      const add = `. + {${jqLit(c.as)}: ${lowerExpr(c.expr)}}`;
      return inputIsList ? `map(${add})` : add;
    }
    case "group": {
      const keyExpr = c.by.length === 1 ? path(c.by[0]!) : `[${c.by.map(path).join(", ")}]`;
      const fields = [...c.by.map((k) => `${jqLit(k)}: .[0]${path(k)}`), ...c.aggs.map((a) => `${jqLit(a.as)}: ${lowerAgg(a, false)}`)];
      return `group_by(${keyExpr}) | map({${fields.join(", ")}})`;
    }
    case "summarize": return `{${c.aggs.map((a) => `${jqLit(a.as)}: ${lowerAgg(a, true)}`).join(", ")}}`;
  }
}

/** One aggregate's jq over `.` (a group, or all rows). `mayBeEmpty` guards the divisions: jq errors on 0/0. */
function lowerAgg(a: Agg, mayBeEmpty: boolean): string {
  if (a.where && a.fn !== "count_where" && a.fn !== "share") return `(map(select(${lowerPred(a.where)})) | ${lowerAgg({ ...a, where: undefined }, true)})`;
  const vals = a.field ? `map(${path(a.field)})` : "";
  const guard = (x: string) => (mayBeEmpty ? `(if length == 0 then null else ${x} end)` : x);
  switch (a.fn) {
    case "count": return "length";
    case "count_where": return `(map(select(${lowerPred(a.where!)})) | length)`;
    case "collect": return `map({${(a.fields ?? []).map((f) => `${jqLit(f)}: ${path(f)}`).join(", ")}})`;
    case "sum": return `(${vals} | add)`;
    case "avg": return guard(`((${vals} | add) / length)`);
    case "min": return `(${vals} | min)`;
    case "max": return `(${vals} | max)`;
    case "first": return `.[0]${path(a.field!)}`;
    case "distinct_count": return `(${vals} | map(select(. != null)) | unique | length)`;
    case "collect_distinct": return `(${vals} | map(select(. != null)) | unique)`;
    case "share": return guard(`((map(select(${lowerPred(a.where!)})) | length) / length)`);
    case "join": return `(map(${lowerParts(a.parts!)}) | join(${jqLit(a.sep!)}))`;
  }
}

function lowerExpr(e: Expr): string {
  if ("field" in e) return path(e.field);
  if ("lit" in e) return jqLit(e.lit.value);
  if ("case" in e) return `(${e.case.map((b, i) => `${i === 0 ? "if" : "elif"} ${lowerPred(b.when)} then ${lowerOperand(b.then)}`).join(" ")} else ${lowerOperand(e.else)} end)`;
  if ("add" in e) return `(${lowerExpr(e.add[0])} + ${lowerExpr(e.add[1])})`;
  if ("sub" in e) return `(${lowerExpr(e.sub[0])} - ${lowerExpr(e.sub[1])})`;
  if ("mul" in e) return `(${lowerExpr(e.mul[0])} * ${lowerExpr(e.mul[1])})`;
  return `(${lowerExpr(e.div[0])} / ${jqLit(e.div[1].value)})`;
}

/**
 * A TRANSFORM's pipeline: `typePipeline`, plus the rule for its END (I-282). A null result renders as the empty string on
 * Kestra, and the step that reads it then fails on `json("")` — so a transform may not END in a value that may be null.
 * `first` is fine mid-pipeline; the pipeline must say what an empty input means before it ends.
 */
export function typeTransform(input: Ty, p: Pipeline): ReturnType<typeof typePipeline> {
  const r = typePipeline(input, p);
  if (r.ok && r.ty.t === "Option") return { ok: false, at: p.length - 1, error: `the transform may end in null (${render(r.ty)}), which the next step cannot read — say what an empty input means` };
  return r;
}

/** A whole pipeline as ONE jq program, stages joined by `|`. Needs the input type to know list-vs-record per stage. */
export function lowerPipeline(input: Ty, p: Pipeline): string {
  let ty = input;
  const stages: string[] = [];
  for (const c of p) {
    const isList = ty.t === "List" || ty.t === "Rows";
    stages.push(lower(c, isList));
    const r = typeOf(ty, c);
    if (!r.ok) throw new Error(`lowerPipeline: an ill-typed pipeline reached the lowering (${r.error}) — type it first`);
    ty = r.ty;
  }
  const program = stages.length ? stages.join(" | ") : ".";
  assertLoweringVocabulary(program);
  return program;
}
