/**
 * The spec's SHAPE (compiled-builder slice 5e): what the flow does to a reader's rows, as an ordered list of the engine's own
 * combinators (D-312) — filter, derive, group + aggregates, sort, limit, distinct, first, count. The model chooses each stage
 * under a strict schema whose field choices are ENUMS of what exists (`reader.field`, or `stage:<k>` / `stage:<k>:<j>` for what an
 * earlier stage made); code names every derived field, checks every constant is the person's words, lowers the stages into ONE
 * typed pipeline (`typePipeline` must accept it), and writes the readback.
 *
 * ⚠ AGNOSTIC: nothing here knows a table, column, tool or workspace. A stage that does not type is DROPPED and stated, never
 * repaired; a constant the goal did not say is asked once (`shape:<s>:<k>:<role>`), never supplied.
 */
import { rowOf, typePipeline, withContext, type Agg, type Comb, type Expr, type Part, type Pred, type Ty } from "@foundry/flow-edit";
import type { CondTest } from "./goal-spec.js";

/** A stage value that names a plan input (builder-inputs P1) rather than holding words. */
export const INPUT_REF = /^input:[a-z0-9_]+$/;
export const SHAPE_OPS = ["filter", "derive", "group", "sort", "limit", "distinct", "first", "count"] as const;
export const AGG_FNS = ["count", "sum", "avg", "min", "max", "distinct_count"] as const;
export const DERIVE_FNS = ["add", "sub", "mul", "div"] as const;
export const STAGE_REF = /^stage:(\d+)(?::(\d+))?$/;
/** At most this many stages per shape, and measures per group — what the stage-ref enum covers. */
export const MAX_STAGES = 8, MAX_MEASURES = 4;

export interface Stage {
  op: (typeof SHAPE_OPS)[number];
  /** The goal's own words this stage comes from, copied exactly. */
  quote: string;
  /** filter / sort / distinct: the field; derive: its left side. `reader.field` or a stage ref. */
  field?: string | null;
  test?: CondTest | null;
  /** filter: the compared value; limit: how many; derive: a number. The goal's words, or empty (asked). */
  value?: string | null;
  /** filter: another field to compare with; derive: its right side. */
  against?: string | null;
  fn?: (typeof DERIVE_FNS)[number] | null;
  by?: string[] | null;
  measures?: Array<{ fn: (typeof AGG_FNS)[number]; field: string | null }> | null;
  dir?: "asc" | "desc" | null;
  /**
   * group (P7, R24): fields each group KEEPS from its rows, by its first row — what an action per group reads that the group's key
   * does not give (the team's own address). Code's, from the plan's recipients; never the model's.
   */
  carry?: string[] | null;
  /** group (P7, R24): each group also carries its own rows, as one text (`GROUP_ROWS`) — what an action that sends them carries. */
  rows?: boolean | null;
}
/** P7 (R24): the field a group carries its own rows in, as text — one line per row. */
export const GROUP_ROWS = "group_rows";
export interface Shape { over: string; stages: Stage[] }

export const stageRefs = (): string[] => Array.from({ length: MAX_STAGES }, (_, k) => [`stage:${k}`, ...Array.from({ length: MAX_MEASURES }, (_, j) => `stage:${k}:${j}`)]).flat();

const bare = (ref: string) => ref.slice(ref.lastIndexOf(".") + 1);
const slug = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "value";

/** Names code gives what each stage makes: a derive's field, a group's measures. Deterministic, never the model's. */
export function stageNames(stages: Stage[]): Array<string[]> {
  const used = new Set<string>();
  const uniq = (n: string) => { let x = n, i = 2; while (used.has(x)) x = `${n}_${i++}`; used.add(x); return x; };
  const nameOf = (r: string | null | undefined, names: Array<string[]>): string => {
    const m = r ? STAGE_REF.exec(r) : null;
    if (!m) return r ? bare(r) : "value";
    return names[Number(m[1])]?.[Number(m[2] ?? 0)] ?? "value";
  };
  const names: Array<string[]> = [];
  for (const s of stages) {
    if (s.op === "derive") names.push([uniq(slug(`${s.fn ?? "calc"}_${nameOf(s.field, names)}_${s.against ? nameOf(s.against, names) : (s.value ?? "").trim() || "n"}`))]);
    else if (s.op === "group") names.push((s.measures ?? []).map((m) => uniq(slug(m.fn === "count" && !m.field ? "count" : `${m.fn}_${nameOf(m.field, names)}`))));
    else names.push([]);
  }
  return names;
}

/** A field ref's name in the rows at stage `k`: a reader field's own name, or the name code gave an earlier stage's output. */
export function refName(ref: string, names: Array<string[]>): string | null {
  const m = STAGE_REF.exec(ref);
  if (!m) return bare(ref);
  return names[Number(m[1])]?.[Number(m[2] ?? 0)] ?? null;
}

const n = (s: string | null | undefined) => (s ?? "").trim();
const NUM = /-?\d+(?:\.\d+)?/;

/**
 * The code half for shapes: over a reader this goal reads; every stage's quote is the person's words; every field ref names this
 * reader or an EARLIER stage's output; every constant is the goal's words (or empty — asked). The first stage that fails ends the
 * shape there (later stages build on it), stated.
 */
export function checkShapes(raw: Shape[] | undefined, ctx: {
  sources: string[]; fields: Set<string>; quoted: (q: string) => boolean; quotedWord: (v: string) => boolean;
  /** What the stage's own words make a count (“not … any” → 0), whatever the model wrote — a value equal to it is the goal's. */
  counted?: (field: string | null | undefined, test: string | null | undefined, quote: string) => string | null;
  valued: ReadonlySet<CondTest>; ordering: ReadonlySet<CondTest>; vague: (v: string) => string | null;
  /** I-301: a compared value against the field's known values — the member, or the values when it is none of them; `null`: unknown. */
  domain?: (field: string, test: CondTest, value: string) => { member: string } | { outside: string[] } | null;
  /** Whether a reader field may be null — `true` when unknown. A count of a field that never is, IS the count of the rows. */
  nullable: (field: string) => boolean;
}): { shapes: Shape[]; dropped: Array<{ what: string; why: string }> } {
  const dropped: Array<{ what: string; why: string }> = [];
  const shapes: Shape[] = [];
  for (const sh of raw ?? []) {
    if (!ctx.sources.includes(sh.over)) { dropped.push({ what: `shape over ${sh.over}`, why: "not a reader this goal uses" }); continue; }
    const kept: Stage[] = [];
    const made: Array<{ op: Stage["op"]; measures: number }> = [];
    const refOk = (r: string | null | undefined) => {
      if (!r) return false;
      const m = STAGE_REF.exec(r);
      if (m) { const k = Number(m[1]), j = Number(m[2] ?? 0); const s = made[k]; return !!s && ((s.op === "derive" && j === 0) || (s.op === "group" && j < s.measures)); }
      return ctx.fields.has(r) && r.slice(0, r.lastIndexOf(".")) === sh.over;
    };
    for (const [k, raw0] of (sh.stages ?? []).slice(0, MAX_STAGES).entries()) {
      const s: Stage = { ...raw0 };
      const why = ((): string | null => {
        if (!ctx.quoted(s.quote)) return `“${s.quote}” is not in the goal`;
        switch (s.op) {
          case "filter": {
            if (!refOk(s.field) || !s.test) return "names no field of these rows, or no test";
            if (s.against && s.against !== "none") { if (!refOk(s.against)) return `\`${s.against}\` is not a field of these rows`; if (!ctx.valued.has(s.test)) return "a presence or true/false test compares with nothing"; s.value = ""; return null; }
            s.against = null;
            // builder-inputs P1: a comparison with a plan INPUT (`input:<id>`) is not words to check — the input is typed and placed by code.
            if (INPUT_REF.test(n(s.value))) return ctx.valued.has(s.test) ? null : "a presence or true/false test compares with no input";
            if (!ctx.valued.has(s.test)) { if (n(s.value)) return "a presence or true/false test takes no value"; return null; }
            // I-301: on a field whose values are known, the value is one of them (the words mapped onto it, shown in the readback),
            // or — naming none — cleared, stated, and asked with the real values.
            const dom = n(s.value) ? ctx.domain?.(s.field!, s.test, n(s.value)) ?? null : null;
            if (dom && "member" in dom) { s.value = dom.member; return null; }
            if (dom && "outside" in dom) { dropped.push({ what: `“${s.quote}” → value “${n(s.value)}”`, why: `\`${s.field!.slice(s.field!.lastIndexOf(".") + 1)}\` holds only ${dom.outside.map((v) => `“${v}”`).join(", ")} — the person is asked which` }); s.value = ""; return null; }
            if (n(s.value) && !ctx.quotedWord(n(s.value)) && ctx.counted?.(s.field, s.test, s.quote) !== n(s.value)) return `its value “${n(s.value)}” is not the goal's words`;
            // A value that states no amount ("a while") compares with nothing yet: cleared, and the person is asked what counts.
            if (n(s.value) && ctx.ordering.has(s.test) && ctx.vague(n(s.value))) { dropped.push({ what: `“${s.quote}” → value “${n(s.value)}”`, why: `${ctx.vague(n(s.value))} — the person is asked what counts` }); s.value = ""; }
            return null;
          }
          case "derive":
            if (!s.fn || !refOk(s.field)) return "names no calculation or no field";
            if (s.against && s.against !== "none") { if (!refOk(s.against)) return `\`${s.against}\` is not a field of these rows`; if (s.fn === "div") return "a division is by a number the goal states, never by a field (a field can hold 0)"; s.value = ""; return null; }
            s.against = null;
            if (!NUM.test(n(s.value)) || !ctx.quotedWord(n(s.value))) return "a calculation with a number needs the goal's own number";
            return null;
          case "group":
            // No key is a total over ALL the rows — one record (phase C: "the total outstanding", the value a Decide compares).
            if (s.by?.length && !s.by.every(refOk)) return "groups by no field of these rows";
            if (!s.measures?.length) return "a group with nothing counted or totalled";
            if (s.measures.some((m) => (m.fn === "count" ? m.field && m.field !== "none" && !refOk(m.field) : !refOk(m.field)))) return "totals a field these rows do not have";
            // One spelling for one number: counting a reader field that is never null counts the rows, so it is written as that count
            // (no field) — what a Decide's count and the superseded-shape rule recognise, whichever way the goal was read.
            s.measures = s.measures.slice(0, MAX_MEASURES).map((m) => ({ fn: m.fn, field: m.field && m.field !== "none" && !(m.fn === "count" && !STAGE_REF.test(m.field) && !ctx.nullable(m.field)) ? m.field : null }));
            return null;
          case "sort": if (!refOk(s.field) || !s.dir) return "sorts by no field of these rows"; return null;
          case "limit": if (n(s.value) && !(NUM.test(n(s.value)) && ctx.quotedWord(n(s.value)))) return `“${n(s.value)}” is not the goal's own number`; return null;
          case "distinct": if (!refOk(s.field)) return "names no field of these rows"; return null;
          case "first": case "count": return null;
          default: return `\`${String((s as Stage).op)}\` is not a stage`;
        }
      })();
      if (why) { dropped.push({ what: `stage ${k + 1} of the shape over ${sh.over} (“${s.quote}”)${(sh.stages ?? []).length > k + 1 ? " and the stages after it" : ""}`, why }); break; }
      kept.push(s);
      made.push({ op: s.op, measures: s.measures?.length ?? 0 });
    }
    if (kept.length) shapes.push({ over: sh.over, stages: kept });
  }
  return { shapes, dropped };
}

/** Whether stage `k` still needs the person's answer: a compared value or a count the goal did not say. */
export const shapeNeeds = (s: Stage, valued: ReadonlySet<CondTest>): "threshold" | "count" | null =>
  s.op === "filter" && s.test && valued.has(s.test) && !s.against && !n(s.value) ? "threshold" : s.op === "limit" && !n(s.value) ? "count" : null;

/** A shape stage's value test as the comparison it is — ONE map, read by the lowering, the solver and the wiring. */
export const CMP: Partial<Record<CondTest, "eq" | "ne" | "lt" | "gt" | "le" | "ge">> = { equals: "eq", not_equals: "ne", below: "lt", above: "gt", at_most: "le", at_least: "ge" };

export interface Lowered {
  pipeline: Comb[];
  /** Stage indexes placed; the first one that did not type ends the lowering, named in `problems`. */
  placed: number[];
  problems: string[];
  /** Stages waiting on the person's answer (asked, unanswered) — skipped, and everything after them, stated unmet. */
  waiting: number[];
  /** Fields whose empty rows were left out before a comparison, a group key, a total or an order. */
  narrowed: string[];
}

/**
 * Lower a checked shape over rows of type `rows`. `filterStages` is the solver's own condition lowering (the date tests' computed
 * inputs, a number's parsing), reused so a filter stage and a legacy condition cannot disagree. `inputs` types the computed inputs.
 */
export function lowerShape(stages: Stage[], rows: Ty, opts: {
  answers: Map<number, string>; valued: ReadonlySet<CondTest>; inputs: Record<string, Ty>;
  /** P7 (R24): one row's line, as parts of its fields — a group's own rows are carried as these lines (the per-row message's form). */
  rowParts?: (fields: Record<string, Ty>) => Part[];
  filterStages: (field: string, fty: Ty | undefined, test: CondTest, value: string, quote: string, from: "goal" | "person") => Comb[] | string;
}): Lowered {
  const names = stageNames(stages);
  const out: Lowered = { pipeline: [], placed: [], problems: [], waiting: [], narrowed: [] };
  const typed = (p: Comb[]) => withContext({ inputs: opts.inputs }, () => typePipeline(rows, p));
  const fieldsNow = (): Record<string, Ty> => { const r = typed(out.pipeline); if (!r.ok) return {}; const row = rowOf(r.ty); return row.t === "Record" ? (row.fields as Record<string, Ty>) : {}; };
  const narrow = (f: string): Comb[] => { const t = fieldsNow()[f]; if (t?.t !== "Option") return []; if (!out.narrowed.includes(f)) out.narrowed.push(f); return [{ op: "filter", where: { notNull: f } }]; };
  for (const [k, s] of stages.entries()) {
    const need = shapeNeeds(s, opts.valued);
    const answered = need ? opts.answers.get(k)?.trim() : undefined;
    if (need && !answered) { out.waiting.push(k); break; }
    const name = (r: string | null | undefined) => (r ? refName(r, names) : null);
    let add: Comb[] | string;
    switch (s.op) {
      case "filter": {
        const f = name(s.field)!;
        if (s.against) {
          const g = name(s.against)!;
          const cmp = CMP[s.test!];
          if (!cmp) { add = "compares two fields with no order or equality"; break; }
          add = [...narrow(f), ...narrow(g), { op: "filter", where: { cmp, left: { field: f }, right: { field: g } } as Pred }];
        } else add = opts.filterStages(f, fieldsNow()[f], s.test!, answered ?? n(s.value), s.quote, answered ? "person" : "goal");
        break;
      }
      case "derive": {
        const f = name(s.field)!;
        const left: Expr = { field: f };
        const right: Expr = s.against ? { field: name(s.against)! } : { lit: { value: Number(NUM.exec(n(s.value))![0]), from: "goal", quote: s.quote } };
        const expr: Expr = s.fn === "add" ? { add: [left, right] } : s.fn === "sub" ? { sub: [left, right] } : s.fn === "mul" ? { mul: [left, right] } : { div: [left, (right as { lit: never }).lit] };
        add = [...narrow(f), ...(s.against ? narrow(name(s.against)!) : []), { op: "derive", as: names[k]![0]!, expr }];
        break;
      }
      case "group": {
        const keys = (s.by ?? []).map((b) => name(b)!);
        const pre = keys.flatMap(narrow);
        const aggs: Agg[] = (s.measures ?? []).map((m, j) => ({ as: names[k]![j]!, fn: m.fn, ...(m.field ? { field: name(m.field)! } : {}) }));
        // A total over a field that may be empty is over the rows where it is present (SQL's own rule for SUM/AVG/MIN/MAX).
        const fields = fieldsNow();
        const withWhere = aggs.map((a) => (a.field && fields[a.field]?.t === "Option" && a.fn !== "count" ? { ...a, where: { notNull: a.field } as Pred } : a));
        // P7 (R24): what each group keeps from its rows (by its first row — the group's own address), and its rows as text.
        if (keys.length) for (const c of s.carry ?? []) { const f = name(c)!; if (fields[f] && !keys.includes(f) && !withWhere.some((a) => a.as === f)) withWhere.push({ as: f, fn: "first", field: f }); }
        if (keys.length && s.rows && opts.rowParts) {
          const own = Object.fromEntries(Object.entries(fields).filter(([n]) => !keys.includes(n)));
          const parts = opts.rowParts(own);
          if (parts.length) withWhere.push({ as: GROUP_ROWS, fn: "join", parts, sep: "\n" });
        }
        // No key: the engine's `summarize` — ONE record over all the rows (empty rows: a total is null, a count 0).
        add = keys.length ? [...pre, { op: "group", by: keys, aggs: withWhere }] : [{ op: "summarize", aggs: withWhere }];
        break;
      }
      case "sort": { const f = name(s.field)!; add = [...narrow(f), { op: "sort", by: f, dir: s.dir! }]; break; }
      case "limit": { const v = Number(NUM.exec(answered ?? n(s.value))?.[0]); add = Number.isInteger(v) && v > 0 ? [{ op: "limit", n: { value: v, from: answered ? "person" : "goal", quote: s.quote } }] : `“${answered ?? n(s.value)}” is not a whole number of rows`; break; }
      case "distinct": { const f = name(s.field)!; add = [{ op: "distinct", by: f }]; break; }
      case "first": add = [{ op: "first" }]; break;
      case "count": add = [{ op: "count", as: "count" }]; break;
      default: add = "not a stage";
    }
    if (typeof add === "string") { out.problems.push(`“${s.quote}”: ${add}`); break; }
    const r = typed([...out.pipeline, ...add]);
    if (!r.ok) { out.problems.push(`“${s.quote}”: ${r.error}`); break; }
    out.pipeline.push(...add);
    out.placed.push(k);
  }
  return out;
}

const TEST_WORDS: Record<string, string> = { is_true: "is true", is_false: "is false", equals: "is", not_equals: "is not", below: "is below", above: "is above", at_most: "is at most", at_least: "is at least", is_empty: "is empty", not_empty: "is present", date_passed: "is before the day it runs", date_not_passed: "is the day it runs or later", older_than_days: "is more days before the day it runs than", within_days: "is within this many days before the day it runs:" };
const FN_WORDS: Record<string, string> = { count: "the number of rows", sum: "the total of", avg: "the average of", min: "the smallest", max: "the largest", distinct_count: "how many different", add: "plus", sub: "minus", mul: "times", div: "divided by" };

/** The readback for a shape: one line per stage, from the enums, code's names and the person's quoted words. */
export function shapeReadback(sh: Shape, valued: ReadonlySet<CondTest>): string[] {
  const names = stageNames(sh.stages);
  const nm = (r: string | null | undefined) => `\`${(r && refName(r, names)) ?? "?"}\``;
  return sh.stages.map((s) => {
    const why = `for “${s.quote}”`;
    switch (s.op) {
      case "filter": return `Keeps rows where ${nm(s.field)} ${TEST_WORDS[s.test!] ?? s.test}${s.against ? ` ${nm(s.against)}` : n(s.value) ? ` “${n(s.value)}”` : shapeNeeds(s, valued) ? " — I will ask you what counts" : ""} — ${why}`;
      case "derive": return `Works out ${nm(`stage:${sh.stages.indexOf(s)}`)} = ${nm(s.field)} ${FN_WORDS[s.fn!]} ${s.against ? nm(s.against) : `“${n(s.value)}”`} — ${why}`;
      case "group": return `${s.by?.length ? `Groups the rows by ${(s.by ?? []).map(nm).join(" and ")}, with` : "Over all the rows,"} ${(s.measures ?? []).map((m, j) => `${m.fn === "count" && !m.field ? FN_WORDS.count : `${FN_WORDS[m.fn]} ${nm(m.field)}`} (as \`${names[sh.stages.indexOf(s)]![j]}\`)`).join(", ")}${s.carry?.length ? `, keeping each group's ${s.carry.map(nm).join(" and ")}` : ""}${s.rows ? ", and each group's own rows" : ""} — ${why}`;
      case "sort": return `Sorts by ${nm(s.field)}, ${s.dir === "desc" ? "largest first" : "smallest first"} — ${why}`;
      case "limit": return `Keeps the first ${n(s.value) ? `“${n(s.value)}”` : "N — I will ask you how many"} — ${why}`;
      case "distinct": return `One row per ${nm(s.field)} — ${why}`;
      case "first": return `Keeps the first row — ${why}`;
      case "count": return `Counts the rows — ${why}`;
      default: return `(${s.op}) — ${why}`;
    }
  });
}

