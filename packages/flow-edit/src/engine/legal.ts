/**
 * `legalMoves(flow, catalogue)` — every op applicable to a state, and for parametric ops the legal VALUES (compiled-builder
 * phase 3, task 3). These are the enums phase 4 hands to the model: it chooses among them and never writes one.
 *
 * ⚠ One definition of legality. A move is listed only when `apply` would accept it: the parameter sets come from the SAME
 * functions the preconditions use (`sourceTy`/`fits`, `transformTy`, `boundedList`, `readableTy`), and every listed
 * candidate is then confirmed by `apply` itself. So "legal" can never mean one thing here and another at apply — the
 * property test's first assertion is that every listed move applies.
 *
 * A literal cannot be enumerated: its slot names the TYPE, and the value must come from the goal (quoted), a catalogue
 * default, or a person's answer (the constants rule). Nothing here invents one.
 */
import type { Comb, Pipeline } from "../ir/combinators.js";
import { pipelineInputType, portsOf, rowOf, type CatalogueSnapshot, type CheckModel, type CheckStep, type PortSig } from "../typecheck/signature.js";
import { render, type Ty } from "../typecheck/types.js";
import { armOfStep, chainHead, chainOf, collectOf, loopMembers, type EFlow, type EInputType, type EStep } from "./model.js";
import { apply, fits, readableTy, readersOf, sourceTy, transformTy, MAX_FANOUT, type BindSource, type EngineOp } from "./ops.js";

export type Move =
  /** `needsDefault`: the flow is scheduled, so a new input must carry a default (a literal slot of its type) or be optional. */
  | { op: "declare_input"; types: EInputType[]; needsDefault: boolean }
  | { op: "remove_input"; ids: string[] }
  | { op: "retype_input"; to: Array<{ id: string; type: EInputType; format?: "month" }> }
  /** `unders`: the conditions a new step of this kind may be placed under (D-320). */
  | { op: "add_reader"; refs: string[]; unchosen: boolean; unders: string[]; insides: string[] }
  | { op: "choose_reader"; stepId: string; refs: string[] }
  | { op: "add_transform"; from: string; stages: Comb[]; unders: string[]; insides: string[] }
  | { op: "append_stage"; stepId: string; stages: Comb[]; literals: Array<{ make: (value: string) => Comb; ty: Ty; what: string }> }
  | { op: "add_call"; refs: string[]; fanouts: Array<{ ref: string; over: string; row: { port: string; field: string } }>; unders: string[]; insides: string[] }
  | { op: "bind"; stepId: string; port: string; ty: Ty; sources: BindSource[]; literal: Ty | null }
  | { op: "unbind"; stepId: string; port: string }
  | { op: "add_gate"; before: string[] }
  | { op: "set_output"; steps: string[] }
  | { op: "set_schedule"; set: boolean; clear: boolean }
  | { op: "remove_step"; steps: string[] }
  /** Steps a condition may test, each with the tests that apply (both, always — a list either has rows or has none). */
  | { op: "add_branch"; subjects: string[] }
  /** Continue `of`: an elif testing one of `subjects`, or (`closes`) the closing else. */
  | { op: "add_otherwise"; of: string; subjects: string[]; closes: boolean }
  /** Legal source lists, each confirmed by `apply` — a bounded, representative set (one per link, and with a fallback). */
  | { op: "add_merge"; sources: string[][] }
  /** For each (D-361): the top-level bounded lists a loop may run over. */
  | { op: "add_loop"; overs: string[] }
  /** A loop's settings (items at once, keep going or stop) — values, confirmed by `apply` when chosen. */
  | { op: "set_loop"; stepId: string }
  /** Close a loop: the body steps that may be each row's `result`. */
  | { op: "close_loop"; loop: string; results: string[] }
  | { op: "set_loop_result"; stepId: string; results: string[] };

const asModel = (f: EFlow) => f as unknown as CheckModel;
const lit = (value: string | number | boolean) => ({ value, from: "goal" as const });
const SCALAR = new Set(["Text", "Int", "Number", "Bool", "Date", "DateTime", "Month", "Address", "Key", "Key"]);
const ORDERED = new Set(["Text", "Int", "Number", "Date", "DateTime", "Month", "Address"]);
const NUM = new Set(["Int", "Number"]);

/** The fields of the record inside a list/rows type, or of the record itself. */
function fieldsOf(ty: Ty): Record<string, Ty> | null {
  const r = ty.t === "List" || ty.t === "Rows" ? ty.of : ty;
  return r.t === "Record" ? r.fields : null;
}

/**
 * Candidate next stages over a pipeline's current type: a FINITE set built from the fields that type has, so the choice is
 * a closed enum. Stages that need a constant (a comparison with a value, a limit) are offered as literal SLOTS instead.
 * Every candidate is later confirmed by `transformTy`, so a candidate the typing refuses is never offered.
 */
export function candidateStages(ty: Ty): { stages: Comb[]; literals: Array<{ make: (v: string) => Comb; ty: Ty; what: string }> } {
  const stages: Comb[] = [];
  const literals: Array<{ make: (v: string) => Comb; ty: Ty; what: string }> = [];
  const fields = fieldsOf(ty);
  const isList = ty.t === "List" || ty.t === "Rows";
  if (!fields) return { stages, literals };
  const names = Object.keys(fields);
  const base = (t: Ty) => (t.t === "Option" ? t.of : t);
  if (isList) {
    for (const n of names) {
      const t = fields[n]!;
      if (t.t === "Option") { stages.push({ op: "filter", where: { notNull: n } }, { op: "filter", where: { isNull: n } }); }
      const b = base(t);
      if (b.t === "Text" || b.t === "Address" || b.t === "Key") stages.push({ op: "filter", where: { isBlank: n } }, { op: "filter", where: { not: { isBlank: n } } });
      if (t.t !== "Option" && ORDERED.has(b.t)) {
        stages.push({ op: "sort", by: n, dir: "asc" }, { op: "sort", by: n, dir: "desc" }, { op: "distinct", by: n });
        for (const cmp of ["lt", "gt", "eq"] as const)
          literals.push({ make: (v) => ({ op: "filter", where: { cmp, left: { field: n }, right: { lit: lit(NUM.has(b.t) ? Number(v) : v) } } }), ty: b, what: `${n} ${cmp} …` });
      }
      if (t.t !== "Option" && b.t === "Bool") stages.push({ op: "filter", where: { cmp: "eq", left: { field: n }, right: { lit: lit(true) } } });
      // column against column: both non-null and comparable
      for (const m of names) {
        const u = fields[m]!;
        if (m <= n || t.t === "Option" || u.t === "Option" || !ORDERED.has(b.t)) continue;
        if (NUM.has(b.t) ? NUM.has(u.t) : u.t === b.t) stages.push({ op: "filter", where: { cmp: "lt", left: { field: n }, right: { field: m } } });
      }
      if (t.t === "Option" && SCALAR.has(b.t) && b.t !== "Bool") literals.push({ make: (v) => ({ op: "coalesce", field: n, with: { lit: lit(NUM.has(b.t) ? Number(v) : v) } }), ty: b, what: `${n}, or …` });
      if (t.t !== "Option" && SCALAR.has(b.t)) stages.push({ op: "group", by: [n], aggs: [{ as: "n", fn: "count" }] });
      if (t.t !== "Option" && NUM.has(b.t)) stages.push({ op: "summarize", aggs: [{ as: "n", fn: "count" }, { as: "total", fn: "sum", field: n }] });
    }
    literals.push({ make: (v) => ({ op: "limit", n: lit(Number(v)) }), ty: { t: "Int" }, what: "at most … rows" });
    // The deployment's own fan-out bound is a CATALOGUE value, not an invented one: offering it is what lets a builder make
    // a list fan-out-able without asking a person for a number the policy already fixes.
    stages.push({ op: "limit", n: { value: MAX_FANOUT, from: "catalogue" } });
    stages.push({ op: "count", as: "n" });
    const printable = names.filter((n) => fields[n]!.t !== "Option" && SCALAR.has(fields[n]!.t));
    if (printable.length) stages.push({ op: "join_text", as: "text", parts: printable.slice(0, 3).flatMap((n, i) => (i ? [{ text: " · " }, { field: n }] : [{ field: n }])), sep: "\n", empty: "Nothing to report." });
  }
  if (!isList) {
    // Phase C (D-371): ONE record — a count, a total, a step's one row — is tested with `keep_if`, which leaves it or nothing, so the
    // existing has-rows condition on this step decides on the value. The same tests `filter` offers over rows, one record at a time.
    for (const n of names) {
      const t = fields[n]!;
      const b = base(t);
      if (t.t === "Option") stages.push({ op: "keep_if", where: { notNull: n } }, { op: "keep_if", where: { isNull: n } });
      if (t.t !== "Option" && ORDERED.has(b.t))
        for (const cmp of ["gt", "ge", "lt", "le", "eq", "ne"] as const)
          literals.push({ make: (v) => ({ op: "keep_if", where: { cmp, left: { field: n }, right: { lit: lit(NUM.has(b.t) ? Number(v) : v) } } }), ty: b, what: `keep it if ${n} ${cmp} …` });
      if (t.t !== "Option" && b.t === "Bool") stages.push({ op: "keep_if", where: { cmp: "eq", left: { field: n }, right: { lit: lit(true) } } }, { op: "keep_if", where: { cmp: "eq", left: { field: n }, right: { lit: lit(false) } } });
    }
  }
  // Projections: keep one field, or the first three; and a template over printable fields.
  for (const n of names) stages.push({ op: "project", fields: [{ name: n, from: n }] });
  if (names.length > 1) stages.push({ op: "project", fields: names.slice(0, 3).map((n) => ({ name: n, from: n })) });
  const printable = names.filter((n) => fields[n]!.t !== "Option" && SCALAR.has(fields[n]!.t));
  if (printable.length && !fields["line"]) stages.push({ op: "template", as: "line", parts: [{ text: "Item " }, { field: printable[0]! }] });
  const addr = names.filter((n) => fields[n]!.t === "Address");
  if (addr.length) stages.push({ op: "project", fields: [{ name: "to", list: addr[0]! }, ...(printable.filter((p) => p !== addr[0]).slice(0, 1).map((p) => ({ name: "subject", from: p })))] });
  for (const n of names) if (fields[n]!.t !== "Option" && fields[n]!.t === "List") stages.push({ op: "take", field: n });
  if (!isList) for (const n of names) if (base(fields[n]!).t === "List" && fields[n]!.t !== "Option") stages.push({ op: "take", field: n });
  return { stages, literals };
}

const ok = (f: EFlow, op: EngineOp, cat: CatalogueSnapshot) => apply(f, op, cat).ok;

/** The type a step's pipeline READS (its source's rows), for the stage enumerator. */
function stageInputTy(f: EFlow, cat: CatalogueSnapshot, s: EStep & { kind: "transform" }): Ty | null {
  const ty = transformTy(f, cat, s.from, s.pipeline);
  return typeof ty === "string" ? null : ty;
}

export function legalMoves(f: EFlow, cat: CatalogueSnapshot): Move[] {
  const moves: Move[] = [];
  const probe = "zz_probe";
  moves.push({ op: "declare_input", types: ["STRING", "INT", "FLOAT", "BOOLEAN", "DATE", "DATETIME"], needsDefault: !!f.schedule });
  const unread = f.inputs.map((i) => i.id).filter((id) => ok(f, { op: "remove_input", id }, cat));
  if (unread.length) moves.push({ op: "remove_input", ids: unread });
  // Each (input, type) a person may switch to, confirmed by \`apply\` — the same type set \`declare_input\` offers.
  const asTypes: Array<{ type: EInputType; format?: "month" }> = [{ type: "STRING", format: "month" }, { type: "STRING" }, { type: "INT" }, { type: "FLOAT" }, { type: "BOOLEAN" }, { type: "DATE" }, { type: "DATETIME" }];
  const to = f.inputs.flatMap((i) => asTypes.map((t) => ({ id: i.id, ...t })).filter((t) => ok(f, { op: "retype_input", ...t }, cat)));
  if (to.length) moves.push({ op: "retype_input", to });

  const branches = f.steps.filter((s) => s.kind === "branch").map((s) => s.id);
  // For each (D-361): the loops a new step may be placed INSIDE — apart from `unders` (conditions), so every front end that
  // words a placement says the right thing, and one that does not know loops yet offers exactly what it did.
  const loops = f.steps.filter((s) => s.kind === "for_each").map((s) => s.id);
  const readers = Object.entries(cat.refs).filter(([ref]) => ok(f, { op: "add_reader", id: probe, ref }, cat)).map(([r]) => r);
  const canAdd = ok(f, { op: "add_reader", id: probe }, cat);
  const readerUnders = branches.filter((b) => ok(f, { op: "add_reader", id: probe, ...(readers[0] ? { ref: readers[0] } : {}), under: b }, cat));
  const readerInsides = loops.filter((b) => ok(f, { op: "add_reader", id: probe, ...(readers[0] ? { ref: readers[0] } : {}), under: b }, cat));
  if (readers.length || canAdd) moves.push({ op: "add_reader", refs: readers, unchosen: canAdd, unders: readerUnders, insides: readerInsides });
  for (const s of f.steps) if (s.kind === "datasource" && !s.ref) moves.push({ op: "choose_reader", stepId: s.id, refs: readers });

  for (const s of f.steps) {
    const inTy = (() => { const r = readableTy(f, cat, s.id); if (typeof r === "string") return null; return pipelineInputType(s as unknown as CheckStep, cat, asModel(f)); })();
    if (inTy) {
      const { stages } = candidateStages(inTy);
      const good = stages.filter((st) => ok(f, { op: "add_transform", id: probe, from: s.id, pipeline: [st] }, cat));
      const unders = good.length ? branches.filter((b) => ok(f, { op: "add_transform", id: probe, from: s.id, pipeline: [good[0]!], under: b }, cat)) : [];
      const insides = good.length ? loops.filter((b) => ok(f, { op: "add_transform", id: probe, from: s.id, pipeline: [good[0]!], under: b }, cat)) : [];
      if (good.length) moves.push({ op: "add_transform", from: s.id, stages: good, unders, insides });
    }
    if (s.kind === "transform" && !readersOf(f, s.id).length) {
      const ty = stageInputTy(f, cat, s);
      if (ty) {
        const c = candidateStages(ty);
        const stages = c.stages.filter((st) => ok(f, { op: "append_stage", stepId: s.id, stage: st }, cat));
        if (stages.length || c.literals.length) moves.push({ op: "append_stage", stepId: s.id, stages, literals: c.literals });
      }
    }
  }

  const tools = Object.entries(cat.refs).filter(([, r]) => r.kind === "tool").map(([ref]) => ref).filter((ref) => ok(f, { op: "add_call", id: probe, ref }, cat));
  // A fan-out is offered as (tool, rows, first row binding) triples — every one confirmed by `apply`.
  const fanouts: Array<{ ref: string; over: string; row: { port: string; field: string } }> = [];
  for (const t of f.steps.filter((x) => x.kind === "transform")) {
    const rows = readableTy(f, cat, t.id);
    if (typeof rows === "string") continue;
    const row = rowOf(rows);
    if (row.t !== "Record") continue;
    for (const ref of tools) for (const p of cat.refs[ref]!.params) for (const field of Object.keys(row.fields)) {
      const cand = { ref, over: t.id, row: { port: p.name, field } };
      if (ok(f, { op: "add_call", id: probe, ...cand }, cat)) fanouts.push(cand);
    }
  }
  const callUnders = tools.length ? branches.filter((b) => ok(f, { op: "add_call", id: probe, ref: tools[0]!, under: b }, cat)) : [];
  const callInsides = tools.length ? loops.filter((b) => ok(f, { op: "add_call", id: probe, ref: tools[0]!, under: b }, cat)) : [];
  if (tools.length) moves.push({ op: "add_call", refs: tools, fanouts, unders: callUnders, insides: callInsides });

  for (const s of f.steps) {
    if (s.kind !== "tool" && !(s.kind === "datasource" && s.ref)) continue;
    for (const p of portsOf(s as unknown as CheckStep, cat) ?? []) {
      const bound = s.inputs.some((b) => b.name === p.name && b.source);
      if (bound) { if (ok(f, { op: "unbind", stepId: s.id, port: p.name }, cat)) moves.push({ op: "unbind", stepId: s.id, port: p.name }); continue; }
      const sources = bindSources(f, cat, s, p).filter((src) => ok(f, { op: "bind", stepId: s.id, port: p.name, source: src }, cat));
      const literal = literalSlot(p);
      if (sources.length || literal) moves.push({ op: "bind", stepId: s.id, port: p.name, ty: p.ty, sources, literal });
    }
  }
  const gates = f.steps.filter((s) => s.kind === "tool" || s.kind === "for_each").map((s) => s.id).filter((id) => ok(f, { op: "add_gate", id: probe, before: id, summary: "Proceed?" }, cat));
  if (gates.length) moves.push({ op: "add_gate", before: gates });
  const outs = f.steps.map((s) => s.id).filter((id) => ok(f, { op: "set_output", stepId: id }, cat));
  if (outs.length) moves.push({ op: "set_output", steps: outs });
  const canSet = ok(f, { op: "set_schedule", cron: "0 9 * * 1" }, cat), canClear = !!f.schedule;
  if (canSet || canClear) moves.push({ op: "set_schedule", set: canSet, clear: canClear });
  const removable = f.steps.map((s) => s.id).filter((id) => ok(f, { op: "remove_step", stepId: id }, cat));
  if (removable.length) moves.push({ op: "remove_step", steps: removable });

  // ── conditions (D-320) ──
  const subjects = f.steps.map((s) => s.id).filter((id) => ok(f, { op: "add_branch", id: probe, when: [{ stepId: id, test: "any" }] }, cat));
  if (subjects.length) moves.push({ op: "add_branch", subjects });
  for (const b of branches) {
    const closes = ok(f, { op: "add_otherwise", id: probe, of: b }, cat);
    const elifs = subjects.filter((id) => ok(f, { op: "add_otherwise", id: probe, of: b, when: [{ stepId: id, test: "any" }] }, cat));
    if (closes || elifs.length) moves.push({ op: "add_otherwise", of: b, subjects: elifs, closes });
  }
  const merges = mergeCandidates(f, cat).filter((src) => ok(f, { op: "add_merge", id: probe, sources: src }, cat));
  if (merges.length) moves.push({ op: "add_merge", sources: merges });

  // ── for each (D-361) ──
  const overs = f.steps.filter((s) => s.kind === "transform").map((s) => s.id).filter((id) => ok(f, { op: "add_loop", id: probe, over: id }, cat));
  if (overs.length) moves.push({ op: "add_loop", overs });
  for (const l of f.steps.filter((s) => s.kind === "for_each")) {
    moves.push({ op: "set_loop", stepId: l.id });
    const c = collectOf(f, l.id);
    const results = loopMembers(f, l.id).filter((id) => (c ? c.result !== id && ok(f, { op: "set_loop_result", stepId: c.id, result: id }, cat) : ok(f, { op: "close_loop", id: probe, loop: l.id, result: id }, cat)));
    if (!results.length) continue;
    moves.push(c ? { op: "set_loop_result", stepId: c.id, results } : { op: "close_loop", loop: l.id, results });
  }
  return moves;
}

/**
 * Representative merge source lists: per chain and per output type, one guarded transform from each link that has one — alone
 * (legal when the chain closes with an else and every link has a source) and followed by each top-level transform of that
 * type (the fallback). `apply` confirms each; this only proposes.
 */
function mergeCandidates(f: EFlow, cat: CatalogueSnapshot): string[][] {
  if (!f.steps.some((s) => s.kind === "branch")) return [];
  const arms = armOfStep(f);
  const tyKey = (id: string) => { const t = readableTy(f, cat, id); return typeof t === "string" ? null : JSON.stringify(t); };
  const transforms = f.steps.filter((s) => s.kind === "transform").map((s) => ({ id: s.id, key: tyKey(s.id), arm: arms.get(s.id) }));
  const out: string[][] = [];
  for (const head of f.steps.filter((s) => s.kind === "branch" && !s.elseOf).map((s) => s.id)) {
    const chain = chainOf(f, head);
    for (const key of new Set(transforms.filter((t) => t.arm && chainHead(f, t.arm) === head).map((t) => t.key))) {
      if (!key) continue;
      const perLink = chain.map((b) => transforms.find((t) => t.arm === b && t.key === key)?.id).filter((x): x is string => !!x);
      if (!perLink.length) continue;
      if (perLink.length >= 2) out.push(perLink);
      for (const fb of transforms.filter((t) => !t.arm && t.key === key).slice(0, 2)) out.push([...perLink, fb.id]);
    }
  }
  return out.slice(0, 12);
}

/** Every non-literal source that could fill a port, by the same `sourceTy`/`fits` the `bind` precondition uses. */
export function bindSources(f: EFlow, cat: CatalogueSnapshot, s: EStep, p: PortSig): BindSource[] {
  const out: BindSource[] = [];
  for (const i of f.inputs) out.push({ from: "input", inputId: i.id });
  for (const up of f.steps) {
    if (up.id === s.id) continue;
    const ty = readableTy(f, cat, up.id);
    if (typeof ty === "string") continue;
    const row = rowOf(ty);
    if (row.t === "Record") for (const field of Object.keys(row.fields)) out.push({ from: "field", stepId: up.id, field }, { from: "column", stepId: up.id, field });
    out.push({ from: "text", stepId: up.id });
  }
  return out.filter((src) => { const have = sourceTy(f, cat, s, p, src); return typeof have !== "string" && !fits(have, p); });
}

/** A port a literal could fill (a scalar, or an element of a lifting list). `null` when no literal can. */
function literalSlot(p: PortSig): Ty | null {
  if (p.fromStep) return null;
  const t = p.ty.t === "Option" ? p.ty.of : p.ty;
  if (SCALAR.has(t.t)) return t;
  if (p.liftsScalar && t.t === "List" && SCALAR.has(t.of.t)) return t.of;
  return null;
}

export const describeMove = (m: Move): string => `${m.op}${"stepId" in m ? ` ${m.stepId}` : ""}${"port" in m ? `.${m.port}` : ""}${"ty" in m ? ` : ${render(m.ty)}` : ""}`;
export { MAX_FANOUT };
export type { Pipeline };
