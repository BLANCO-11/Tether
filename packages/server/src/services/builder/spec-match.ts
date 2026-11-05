/**
 * Spec match (compiled-builder phase 5 task 7, D-303) — TRANSLATION VALIDATION. A pure function derives, from the compiled flow
 * alone, what it does, and compares that with the GoalSpec the person confirmed. A mismatch is a builder bug, not the person's:
 * `writeRevision` refuses the revision and names the stage that produced it.
 *
 * What is derived, and from WHAT RUNS rather than from the builder's own notes:
 * - the actions: the `tool` steps' refs; the readers: the `datasource`/`query` steps' refs;
 * - the filters: every `.field <op> <literal>` comparison in a transform's lowered `expr` — the jq Kestra executes, never the
 *   `pipeline` it was lowered from, so a lowering that changes an operator is caught here (the negative control) — plus a
 *   reader parameter bound to a literal, which is a filter the database applies;
 * - the schedule: the flow's cron.
 * Each is compared both ways: everything the spec asks is there, and nothing is there the spec (or the edit's starting flow) did
 * not ask for — an action nobody asked for is the "get me a list became an email" failure (2026-09-27).
 *
 * NOT covered, stated: per-row vs per-group fan-out, where a recipient comes from, the result step. Those are typed by the engine
 * and read back to the person; this check does not re-derive them.
 */
import { BY_FLOW, FILLS_NONE, NONE_FIT, UNSAID, type CondTest, type GoalSpec } from "./goal-spec.js";
import { refName, stageNames } from "./shape.js";
import { inUnit, numberOfWords, rowOf, timeOfWords, type Ty } from "@foundry/flow-edit";
import { durationTest, isNumberTy } from "./solver.js";
import { restatedCuts, sameShapes, supersededShapes, unreadShapes } from "./wiring.js";
import { INPUT_REF } from "./shape.js";
import { askedFor, operandsFor, type Operand } from "./inputs.js";

/** What the builder stores with a revision (`save`'s `build`): the confirmed spec, and the trace (its questions and answers, the edit's base). */
export interface StoredBuild {
  goalSpec: { spec: GoalSpec } | null | undefined;
  trace?: { questions?: Array<{ holeId: string; answer?: string }>; base?: Array<{ kind: string; ref?: string; id?: string }> } | null;
}
interface ModelLike { steps: Array<{ id: string; kind: string; ref?: string; expr?: string; inputs?: Array<{ name: string; source: { from: string; value?: unknown } | null }> }>; schedule?: { cron: string } | null }

const OP: Partial<Record<CondTest, string>> = { equals: "==", not_equals: "!=", below: "<", above: ">", at_most: "<=", at_least: ">=", is_true: "==", is_false: "==" };
/** A comparison as the lowering writes it: `(.field OP literal)` — a JSON literal, never an input (a computed date) or `null` (a narrowing). */
const ATOM = /\(\.([A-Za-z_][A-Za-z0-9_]*) (==|!=|<=|>=|<|>) ("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false)\)/g;

/** Two fields of one row compared (`(.spend > .budget)`) — written by a Decide with `against`. */
const FIELD_ATOM = /\(\.([A-Za-z_][A-Za-z0-9_]*) (==|!=|<=|>=|<|>) \.([A-Za-z_][A-Za-z0-9_]*)\)/g;
/** A value converted from minor units under a new name (`{"spend_whole": (.spend | … / 100 …)}`) — compared, it is still `spend`. */
const CONVERTED = /\{"([A-Za-z_][A-Za-z0-9_]*)": \(\.([A-Za-z_][A-Za-z0-9_]*) \| if \. == null then null else \. \/ 100 end\)\}/g;

interface Filter { field: string; op: string; value: string | number | boolean | { field: string }; where: string }
/** A comparison with a run input (builder-inputs P1), as the lowering splices it: `(.field OP ' ~ (inputs.<id> | toJson) ~ ')`. */
const INPUT_ATOM = /\(\.([A-Za-z_][A-Za-z0-9_]*) (==|!=|<=|>=|<|>) ' ~ \(inputs\.([A-Za-z_][A-Za-z0-9_]*) \| toJson\) ~ '\)/g;
/** The comparisons with run inputs a flow applies, from what runs. */
/** The same comparison against a date input read by its MONTH — the input cut to its year and month inside jq. */
const MONTH_INPUT_ATOM = /\(\.([A-Za-z_][A-Za-z0-9_]*) (==|!=|<=|>=|<|>) \(' ~ \(inputs\.([A-Za-z_][A-Za-z0-9_]*) \| toJson\) ~ ' \| tostring \| \.\[0:7\]\)\)/g;
export function derivedInputFilters(model: ModelLike): Array<{ field: string; op: string; input: string; where: string; cut?: "month" }> {
  return model.steps.flatMap((s) => (s.kind === "transform" && s.expr ? [
    ...[...s.expr.matchAll(INPUT_ATOM)].map((m) => ({ field: m[1]!, op: m[2]!, input: m[3]!, where: s.id })),
    ...[...s.expr.matchAll(MONTH_INPUT_ATOM)].map((m) => ({ field: m[1]!, op: m[2]!, input: m[3]!, where: s.id, cut: "month" as const })),
  ] : []));
}
const CMP_OF: Partial<Record<CondTest, Operand["cmp"]>> = { equals: "eq", not_equals: "ne", below: "lt", above: "gt", at_most: "le", at_least: "ge" };

/**
 * The field a reader's input SELECTS rows by (`PortSig.selects`, from the reader's own definition) — a catalogue fact, so it is
 * handed in; absent, an input is compared by its own name (a named query declares none).
 */
export type SelectsOf = (ref: string, input: string) => string | undefined;

/** The literal comparisons a flow applies, from what runs. */
export function derivedFilters(model: ModelLike, selectsOf?: SelectsOf): Filter[] {
  const out: Filter[] = [];
  for (const s of model.steps) {
    if (s.kind === "transform" && s.expr) {
      // The expr is jq inside a Pebble single-quoted string; the lowering escapes `'` as ' and nothing else needs undoing.
      for (const m of s.expr.matchAll(ATOM)) out.push({ field: m[1]!, op: m[2]!, value: JSON.parse(m[3]!.replace(/\\u0027/g, "'")) as string | number | boolean, where: s.id });
      // A comparison of two fields, each read back to the field it was converted from.
      const from = new Map([...s.expr.matchAll(CONVERTED)].map((m) => [m[1]!, m[2]!]));
      const src = (n: string) => from.get(n) ?? n;
      for (const m of s.expr.matchAll(FIELD_ATOM)) out.push({ field: src(m[1]!), op: m[2]!, value: { field: src(m[3]!) }, where: s.id });
    }
    if ((s.kind === "datasource" || s.kind === "query") && s.inputs) {
      for (const b of s.inputs) if (b.source?.from === "literal" && typeof b.source.value === "string") out.push({ field: (s.ref && selectsOf?.(s.ref, b.name)) || b.name, op: "==", value: b.source.value, where: `${s.id} (its \`${b.name}\` parameter)` });
    }
  }
  return out;
}

/** A spec field's declared type (`<ref>.<field>`), from the catalogue the flow was checked against. */
export type FieldTyOf = (field: string) => Ty | undefined;
export const fieldTyIn = (refs: Record<string, { payload: Ty } | undefined>): FieldTyOf => (field) => {
  const at = field.lastIndexOf("."), p = at > 0 ? refs[field.slice(0, at)]?.payload : undefined;
  const r = p ? rowOf(p) : undefined;
  return r?.t === "Record" ? r.fields[field.slice(at + 1)] : undefined;
};

/**
 * The value a spec filter compares with: the goal's words, else the person's answer — as the SOLVER types it: a number on a field
 * declared a number, whatever the test (2026-10-02, H07: `== "0"` against the built `== 0` read as two different filters). Only where
 * the field's type is not known (a field a shape stage computes) does an ordering alone make it a number.
 */
const expectedValue = (test: CondTest, value: string | undefined, answer: string | undefined, fty?: Ty): string | number | boolean | null => {
  if (test === "is_true") return true;
  if (test === "is_false") return false;
  const v = (value?.trim() || answer?.trim()) ?? "";
  if (!v) return null;
  const numeric = fty ? isNumberTy(fty) : ["below", "above", "at_most", "at_least"].includes(test);
  // P7 (R23): a length of time on a number declaring its time unit — in that unit, by the engine's one rule (the solver's too).
  const b = fty?.t === "Option" ? (fty as { of: Ty }).of : fty;
  const tu = b && "unit" in b && b.unit && b.unit !== "minor" ? b.unit : undefined;
  const said = numeric && tu ? timeOfWords(v) : null;
  if (tu && said) { const c = inUnit(said, tu); return typeof c === "string" ? v : c; }
  return numeric && /\d/.test(v) ? Number(v.replace(/[^0-9.\-]/g, "")) : v;
};

/** The mismatches between a compiled flow and its confirmed spec; empty when it does what the spec says. */
export function specMatch(model: ModelLike, build: StoredBuild, selectsOf?: SelectsOf, fieldTy?: FieldTyOf): string[] {
  const spec = build.goalSpec?.spec;
  if (!spec) return [];
  const problems: string[] = [];
  const base = build.trace?.base ?? [];
  const answer = (holeId: string) => build.trace?.questions?.find((q) => q.holeId === holeId || q.holeId.startsWith(`${holeId}:`))?.answer;
  const real = (r: string) => r !== NONE_FIT && r !== UNSAID;

  // ── actions and readers, both ways ──
  const refsOf = (kinds: string[]) => model.steps.filter((s) => kinds.includes(s.kind) && s.ref).map((s) => s.ref!);
  const baseRefs = (kinds: string[]) => new Set(base.filter((b) => kinds.includes(b.kind) && b.ref).map((b) => b.ref!));
  for (const [what, kinds, asked] of [["action", ["tool"], spec.sinks], ["reader", ["datasource", "query"], spec.sources]] as const) {
    const have = refsOf([...kinds]), had = baseRefs([...kinds]);
    for (const x of asked) if (real(x.ref) && !have.includes(x.ref)) problems.push(`the spec asks for the ${what} ${x.ref} (“${x.quote}”), and the flow has no step for it`);
    for (const r of new Set(have)) if (!asked.some((x) => x.ref === r) && !had.has(r)) problems.push(`the flow has ${what === "action" ? "an" : "a"} ${what} step for ${r}, which the spec does not ask for`);
  }

  // ── filters: every literal comparison the flow applies is a spec filter, and every spec filter is applied ──
  // A want is one set of comparisons — the model's ISO value, compared as stated.
  // What the flow applies is still read from the jq that runs.
  type Atom = { fields: string[]; op: string; value: string | number | boolean };
  const want: Array<{ field: string; op: string; value: string | number | boolean; quote: string; alts?: Atom[][] }> = [];
  const inputWants: Array<{ fields: string[]; op: string; input: string; quote: string; cut?: "month" }> = [];
  const OPS: Record<string, string> = { eq: "==", ne: "!=", lt: "<", gt: ">", le: "<=", ge: ">=" };
  const datedWant = (field: string, op: string, _raw: string | undefined, v: string | number | boolean, quote: string) => {
    want.push({ field, op, value: v, quote });
  };
  spec.conditions.forEach((c, i) => {
    if ((c.by && c.by !== BY_FLOW) || !c.field || c.field === FILLS_NONE || !c.test || !OP[c.test]) return;
    const v = expectedValue(c.test, c.value, answer(`cond:${i}`), fieldTy?.(c.field));
    if (v !== null) datedWant(c.field.slice(c.field.lastIndexOf(".") + 1), OP[c.test]!, c.value?.trim() || answer(`cond:${i}`), v, c.quote);
  });
  const superseded = supersededShapes(spec); // a split's hand-written side, a Decide's count: the condition's, counted below
  const cuts = restatedCuts(spec), same = sameShapes(spec); // stages after a total restate a condition; a repeated shape is built once
  // A list NOTHING reads is not built (the solver's rule, `unreadShapes`): it is not the flow's to apply. Whether its words are done
  // by something that was built is the solver's to judge — a stage nothing covers is stated unmet, so no revision is written.
  const unread = unreadShapes(spec);
  (spec.shapes ?? []).forEach((sh, si) => {
    if (superseded.has(si) || same.has(si) || unread.has(si)) return;
    const names = stageNames(sh.stages);
    sh.stages.forEach((st, k) => {
      if (k >= (cuts.get(si) ?? Infinity)) return;
      // P7 (R23): a days-ago test on an age (a number counting time) is the age compared in its unit — the solver's own rule.
      // A GIVEN input is its stated words — the solver lowers them as a literal, this rule included (B20, cp3: "3 days" as an input).
      const given = INPUT_REF.test(st.value ?? "") ? spec.inputs?.find((i) => `input:${i.id}` === st.value && i.fill === "given")?.words : undefined;
      if (st.op === "filter" && st.field && st.test && !st.against && (given !== undefined || !INPUT_REF.test(st.value ?? ""))) {
        const age = durationTest(st.test, fieldTy?.(st.field), given ?? st.value ?? "");
        const f0 = st.field.startsWith(`${sh.over}.`) ? st.field.slice(sh.over.length + 1) : refName(st.field, names);
        if (age && typeof age !== "string" && f0) { want.push({ field: f0, op: age.cmp === "gt" ? ">" : "<=", value: age.value, quote: st.quote }); return; }
      }
      if (st.op !== "filter" || !st.field || !st.test || !OP[st.test]) return;
      const field = st.field.startsWith(`${sh.over}.`) ? st.field.slice(sh.over.length + 1) : refName(st.field, names);
      // Compared with another field of the row: the want is that field (matched by the shared rule, so its exact name holds).
      if (st.against && st.against !== "none") {
        const other = st.against.startsWith(`${sh.over}.`) ? st.against.slice(sh.over.length + 1) : refName(st.against, names);
        if (field && other) want.push({ field, op: OP[st.test]!, value: other, quote: st.quote });
        return;
      }
      // builder-inputs P1: a comparison with a plan input. Given: its words, as any stated value. Otherwise the run inputs the solver's
      // own rule (`operandsFor`) says it reads — required from what runs.
      if (field && INPUT_REF.test(st.value ?? "")) {
        const inp = spec.inputs?.find((i) => `input:${i.id}` === st.value);
        if (!inp) { problems.push(`a step of the spec compares \`${field}\` with ${st.value}, which the spec does not declare`); return; }
        if (inp.fill === "given") { const gv = expectedValue(st.test, inp.words, undefined, fieldTy?.(st.field)); if (gv !== null) datedWant(field, OP[st.test]!, inp.words, gv, st.quote); return; }
        const t0 = fieldTy?.(st.field), t1 = t0 && t0.t === "Option" ? (t0 as { of: Ty }).of : t0;
        const ops = operandsFor(inp, askedFor(spec.inputs ?? []), CMP_OF[st.test], !t1 || t1.t === "Date" || t1.t === "DateTime");
        if (typeof ops !== "string") for (const o of ops) inputWants.push({ fields: o.cut ? [`${field}_month`] : [field, `${field}_day`], op: OPS[o.cmp], input: o.id, quote: st.quote, ...(o.cut ? { cut: o.cut } : {}) });
        return;
      }
      const v = expectedValue(st.test, st.value ?? undefined, answer(`shape:${si}:${k}`), fieldTy?.(st.field));
      if (field && v !== null) datedWant(field, OP[st.test]!, st.value?.trim() || answer(`shape:${si}:${k}`), v, st.quote);
    });
  });
  // Phase C: a condition the wiring states on ONE value (a Decide) is one comparison; a Split is two — its test, and the same
  // comparison inside the `not` of its rest. The field of a `value` measure is the list's one number, known only to the flow.
  const CMP: Record<string, string> = { gt: ">", ge: ">=", lt: "<", le: "<=", eq: "==", ne: "!=" };
  // builder-behaviour P1 (R10): an item's tests, each wanted from what runs — by the same rules the solver lowers them with, derived
  // here from the SPEC: another field; a run input; a yes/no test of a number is a count's truth (> 0, or none: <= 0); else the value.
  const loopKey = spec.wiring?.each?.over;
  const loopRef = loopKey?.startsWith("reader:") ? spec.sources[Number(loopKey.slice(7))]?.ref : loopKey?.startsWith("list:") ? spec.shapes?.[Number(loopKey.slice(5))]?.over : undefined;
  for (const p of spec.wiring?.paths ?? []) {
    if (p.subject !== "item" || !p.where?.length) continue;
    for (const t of p.where) {
      const test = t.test as CondTest;
      const fty = loopRef ? fieldTy?.(`${loopRef}.${t.field}`) : undefined;
      const base = fty?.t === "Option" ? (fty as { of: Ty }).of : fty;
      if (t.against) { if (OP[test]) want.push({ field: t.field, op: OP[test]!, value: t.against, quote: p.quote }); continue; }
      if (t.input) {
        const inp = spec.inputs?.find((i) => i.id === t.input);
        if (!inp) { problems.push(`a condition of the spec compares \`${t.field}\` with the input ${t.input}, which the spec does not declare`); continue; }
        if (inp.fill === "given") { const gv = expectedValue(test, inp.words, undefined, fty); if (gv !== null && OP[test]) datedWant(t.field, OP[test]!, inp.words, gv, p.quote); continue; }
        const ops = operandsFor(inp, askedFor(spec.inputs ?? []), CMP_OF[test], !base || base.t === "Date" || base.t === "DateTime");
        if (typeof ops !== "string") for (const o of ops) inputWants.push({ fields: o.cut ? [`${t.field}_month`] : [t.field, `${t.field}_day`], op: OPS[o.cmp], input: o.id, quote: p.quote, ...(o.cut ? { cut: o.cut } : {}) });
        continue;
      }
      if ((test === "is_true" || test === "is_false") && base && isNumberTy(base)) { want.push({ field: t.field, op: test === "is_true" ? ">" : "<=", value: 0, quote: p.quote }); continue; }
      if (!OP[test]) continue;
      const v = expectedValue(test, t.value, undefined, fty);
      if (v !== null) datedWant(t.field, OP[test]!, t.value, v, p.quote);
    }
  }
  for (const p of spec.wiring?.paths ?? []) {
    if (p.where?.length) continue; // stated as its tests (above)
    if ((p.test !== "compare" && p.test !== "split") || !p.cmp || !p.value || !p.measure) continue;
    const v = numberOfWords(p.value) ?? p.value;
    // A count of a READER's rows is `n`; of a list that is already one number, that number (its name is the flow's); a value, the list's one number.
    const field = p.test === "compare" ? (p.measure === "count" ? (p.subject.startsWith("list:") ? "*" : "n") : p.measure === "value" ? "*" : p.measure) : p.measure;
    for (let k = 0; k < (p.test === "split" ? 2 : 1); k++) want.push({ field, op: CMP[p.cmp]!, value: v, quote: p.quote });
  }
  // An edit's starting steps are not this spec's to account for (D-321: an edit only adds).
  const kept = new Set(base.map((b) => b.id).filter((x): x is string => !!x));
  const got = derivedFilters({ ...model, steps: model.steps.filter((s) => !kept.has(s.id)) }, selectsOf);
  const used = new Set<number>();
  // A field compared with another: the other field must be the one the spec's words name — by the SAME rule the solver used.
  const sameValue = (a: Atom, g: Filter) => typeof g.value === "object" ? a.value === g.value.field : g.value === a.value;
  const hits = (a: Atom, g: Filter) => (a.fields.includes(g.field) || a.fields.includes("*")) && g.op === a.op && sameValue(a, g);
  const formsOf = (w: (typeof want)[number]): Atom[][] => w.alts ?? [[{ fields: [w.field], op: w.op, value: w.value }]];
  for (const w of want) {
    let met = false;
    for (const form of formsOf(w)) {
      const take: number[] = [];
      for (const a of form) { const i = got.findIndex((g, j) => !used.has(j) && !take.includes(j) && hits(a, g)); if (i < 0) break; take.push(i); }
      if (take.length === form.length) { take.forEach((i) => used.add(i)); met = true; break; }
    }
    if (!met) problems.push(`the spec keeps rows where \`${w.field}\` ${w.op} ${JSON.stringify(w.value)} (“${w.quote}”), and no step of the flow applies that`);
  }
  if (inputWants.length) {
    const gotIn = derivedInputFilters({ ...model, steps: model.steps.filter((s) => !kept.has(s.id)) });
    for (const w of inputWants) if (!gotIn.some((g) => w.fields.includes(g.field) && g.op === w.op && g.input === w.input && g.cut === w.cut))
      problems.push(`the spec keeps rows where \`${w.fields[0]}\` ${w.op} the run input \`${w.input}\` (“${w.quote}”), and no step of the flow applies that`);
  }
  // A reader's literal parameter may also be a value the goal stated for it (`fills`) or the catalogue's — those are not filters to account for.
  // "Not asked for" is a comparison the spec does not contain — a second step applying one it DOES (a reader's input and a list's
  // filter both keeping the open tickets) is that filter again, not an extra one.
  const wanted = (g: Filter) => want.some((w) => formsOf(w).some((form) => form.some((a) => hits(a, g))));
  for (const [j, g] of got.entries()) if (!used.has(j) && !g.where.includes("parameter") && !wanted(g)) problems.push(`${g.where} keeps rows where \`${g.field}\` ${g.op} ${JSON.stringify(g.value)}, which the spec does not ask for`);

  // ── schedule ──
  // An edit that says nothing of when keeps the schedule it started with.
  const cron = model.schedule?.cron ?? null, asked = spec.schedule?.cron ?? null;
  if (cron !== asked && !(base.length && !asked)) problems.push(asked ? `the spec runs “${spec.schedule!.quote}” (${asked}), and the flow ${cron ? `runs ${cron}` : "has no schedule"}` : `the flow runs ${cron}, and the spec states no schedule`);
  return problems;
}
