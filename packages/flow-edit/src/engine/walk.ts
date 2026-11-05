/**
 * A random legal walk (compiled-builder phase 3, task 4): pick one listed move, instantiate its parameters from the enums
 * `legalMoves` returned, and apply it. Literal slots are filled with a value of the slot's type — standing in for the value
 * a goal would quote or a person would answer — so the walk explores literal-bearing states without inventing a type.
 * Deterministic for a seed, so a failing sequence is reproducible from its seed alone.
 */
import type { CatalogueSnapshot } from "../typecheck/signature.js";
import type { Ty } from "../typecheck/types.js";
import { chainOf, loopOfStep, type EFlow } from "./model.js";
import { legalMoves, type Move } from "./legal.js";
import { apply, type EngineOp } from "./ops.js";

/** mulberry32 — a tiny seeded PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <X>(r: () => number, xs: readonly X[]): X => xs[Math.floor(r() * xs.length)]!;

/**
 * A value that is WRONG for `ty` — a 30th of February, a reserved or off-list address, a template, a second line, one past a
 * limit, a value outside a `OneOf`. `apply` must refuse every one; the walk offers them so the literal precondition is
 * actually exercised (without them its negative control could not fire — it did not, the first time).
 */
export function adversarialLiteral(ty: Ty, r: () => number): string {
  const common = ["{{ inputs.x }}", "", "not a value\nsecond line"];
  const byType: Record<string, string[]> = {
    Int: ["3.5", "abc", "1e3"], Number: ["abc", "NaN"], Bool: ["yes", "1"], Month: ["2026-13", "2026-6"], Date: ["2026-02-30", "30/06/2026"],
    DateTime: ["2026-06-30", "noon"], Address: ["Weekly digest", "ops@reserved.example", "someone@elsewhere.org"],
    Text: ["x".repeat(260), "#nowhere", "urgent-ish"],
  };
  return pick(r, [...(byType[ty.t] ?? []), ...common]);
}

/** A value of `ty` that a goal could state — every type the engine takes a literal for. */
export function sampleLiteral(ty: Ty, cat: CatalogueSnapshot, r: () => number): string {
  if (r() < 0.25) return adversarialLiteral(ty, r);
  switch (ty.t) {
    case "Int": return String(1 + Math.floor(r() * 50));
    case "Number": return pick(r, ["0.5", "80", "92.5", "3"]);
    case "Bool": return pick(r, ["true", "false"]);
    case "Month": return pick(r, ["2026-06", "2025-12"]);
    case "Date": return pick(r, ["2026-06-30", "2026-02-28"]);
    case "DateTime": return "2026-06-30T09:00:00Z";
    case "Key": return "INC-1001"; // not a literal the engine takes — the walk proves it is refused
    case "Address": return `ops@${cat.mailAllowedDomains?.[0] ?? "acme-corp.com"}`;
    case "Text": {
      const oneOf = ty.refine?.find((x) => x.r === "OneOf") as { values: string[] } | undefined;
      return oneOf ? pick(r, oneOf.values) : pick(r, ["Weekly digest", "Please review", "Overdue"]);
    }
    default: return "x";
  }
}

let n = 0;
/** One concrete op from a move, or `null` when the move has no instantiation to offer. */
export function instantiate(f: EFlow, m: Move, cat: CatalogueSnapshot, r: () => number): EngineOp | null {
  const id = (base: string) => { let x = `${base}_${++n % 1000}`; while (f.steps.some((s) => s.id === x) || f.inputs.some((i) => i.id === x)) x = `${base}_${++n % 1000}`; return x; };
  switch (m.op) {
    case "declare_input": {
      const type = pick(r, m.types);
      const format = type === "STRING" && r() < 0.3 ? "month" as const : undefined;
      const tyOf: Record<string, Ty> = { STRING: format ? { t: "Month" } : { t: "Text" }, INT: { t: "Int" }, FLOAT: { t: "Number" }, BOOLEAN: { t: "Bool" }, DATE: { t: "Date" }, DATETIME: { t: "DateTime" } };
      const withDefault = m.needsDefault || r() < 0.3;
      return { op: "declare_input", id: id("in"), type, ...(format ? { format } : {}), ...(withDefault ? (r() < 0.7 ? { defaults: sampleLiteral(tyOf[type]!, cat, r) } : { required: false }) : {}) };
    }
    case "remove_input": return { op: "remove_input", id: pick(r, m.ids) };
    case "retype_input": return { op: "retype_input", ...pick(r, m.to) };
    case "add_reader": {
      const places = [...m.unders, ...m.insides];
      const under = places.length && r() < 0.4 ? { under: pick(r, places) } : {};
      return m.refs.length && (r() < 0.85 || !m.unchosen) ? { op: "add_reader", id: id("read"), ref: pick(r, m.refs), ...under } : { op: "add_reader", id: id("read"), ...under };
    }
    case "choose_reader": return m.refs.length ? { op: "choose_reader", stepId: m.stepId, ref: pick(r, m.refs) } : null;
    case "add_transform": return { op: "add_transform", id: id("shape"), from: m.from, pipeline: [pick(r, m.stages)], ...(m.unders.length + m.insides.length && r() < 0.5 ? { under: pick(r, [...m.unders, ...m.insides]) } : {}) };
    case "append_stage": {
      if (m.literals.length && (r() < 0.35 || !m.stages.length)) { const l = pick(r, m.literals); return { op: "append_stage", stepId: m.stepId, stage: l.make(sampleLiteral(l.ty, cat, r)) }; }
      return m.stages.length ? { op: "append_stage", stepId: m.stepId, stage: pick(r, m.stages) } : null;
    }
    case "add_call": return m.fanouts.length && r() < 0.7 ? { op: "add_call", id: id("call"), ...pick(r, m.fanouts) } : { op: "add_call", id: id("call"), ref: pick(r, m.refs), ...(m.unders.length + m.insides.length && r() < 0.5 ? { under: pick(r, [...m.unders, ...m.insides]) } : {}) };
    case "bind": {
      if (m.literal && (r() < 0.3 || !m.sources.length)) return { op: "bind", stepId: m.stepId, port: m.port, source: { from: "literal", value: sampleLiteral(m.literal, cat, r), provenance: "goal" } };
      return m.sources.length ? { op: "bind", stepId: m.stepId, port: m.port, source: pick(r, m.sources) } : null;
    }
    case "unbind": return { op: "unbind", stepId: m.stepId, port: m.port };
    case "add_gate": return { op: "add_gate", id: id("gate"), before: pick(r, m.before), summary: "Proceed with this send?" };
    case "set_output": return { op: "set_output", stepId: pick(r, m.steps) };
    case "set_schedule": return { op: "set_schedule", cron: m.clear && (!m.set || r() < 0.5) ? null : pick(r, ["0 9 * * 1", "30 6 * * *"]) };
    case "remove_step": return { op: "remove_step", stepId: pick(r, m.steps) };
    case "add_branch": {
      const a = pick(r, m.subjects), b = m.subjects.length > 1 && r() < 0.25 ? pick(r, m.subjects.filter((x) => x !== a)) : undefined;
      const t = () => (r() < 0.5 ? "any" as const : "none" as const);
      const one: EngineOp = { op: "add_branch", id: id("when"), when: [{ stepId: a, test: t() }] };
      if (!b || one.op !== "add_branch") return one;
      // Two subjects is the walk's OWN combination — the move lists each subject alone. Keep the pair only when it applies: two
      // subjects in different places (inside a loop, and a top-level step placed after it begins) are legal alone, not together.
      const two: EngineOp = { ...one, when: [...one.when, { stepId: b, test: t() }] };
      return apply(f, two, cat).ok ? two : one;
    }
    case "add_otherwise":
      return m.closes && (!m.subjects.length || r() < 0.6) ? { op: "add_otherwise", id: id("otherwise"), of: m.of } : { op: "add_otherwise", id: id("elif"), of: m.of, when: [{ stepId: pick(r, m.subjects), test: r() < 0.5 ? "any" : "none" }] };
    case "add_merge": return { op: "add_merge", id: id("merged"), sources: pick(r, m.sources) };
    case "add_loop": return { op: "add_loop", id: id("each"), over: pick(r, m.overs), ...(r() < 0.3 ? { concurrency: pick(r, [1, 5, 20]) } : {}), ...(r() < 0.3 ? { onError: pick(r, ["continue", "stop"] as const) } : {}) };
    case "set_loop": return { op: "set_loop", stepId: m.stepId, concurrency: pick(r, [1, 2, 5, 20]), onError: pick(r, ["continue", "stop"] as const) };
    case "close_loop": return { op: "close_loop", id: id("results"), loop: m.loop, result: pick(r, m.results) };
    case "set_loop_result": return { op: "set_loop_result", stepId: m.stepId, result: pick(r, m.results) };
  }
}

/**
 * Weights: construction moves dominate so walks build real flows; removal and scheduling appear often enough to be exercised.
 */
const WEIGHT: Record<Move["op"], number> = { declare_input: 1, remove_input: 0.3, retype_input: 0.3, add_reader: 2, choose_reader: 3, add_transform: 3, append_stage: 4, add_call: 2, bind: 6, unbind: 0.5, add_gate: 0.6, set_output: 1, set_schedule: 0.4, remove_step: 0.5, add_branch: 0.8, add_otherwise: 0.8, add_merge: 1.5, add_loop: 2.5, set_loop: 0.2, close_loop: 3, set_loop_result: 0.3 };

export interface WalkStep { op: EngineOp; flow: EFlow }
/** A walk of `len` moves from `start`. Throws if a LISTED move is refused by `apply` — that is a legality bug, not a walk end. */
export function walk(start: EFlow, cat: CatalogueSnapshot, len: number, seed: number): WalkStep[] {
  const r = rng(seed);
  const out: WalkStep[] = [];
  let f = start;
  for (let i = 0; i < len; i++) {
    const moves = legalMoves(f, cat);
    const total = moves.reduce((a, m) => a + WEIGHT[m.op], 0);
    let x = r() * total, m = moves[0]!;
    for (const c of moves) { x -= WEIGHT[c.op]; if (x <= 0) { m = c; break; } }
    const op = instantiate(f, m, cat, r);
    if (!op) continue;
    const res = apply(f, op, cat);
    if (!res.ok) {
      // A literal slot is typed, not validated per value (a literal's own rule is `literalFits`); a refusal there is legal.
      // A LITERAL's value is not enumerable, so a refused literal is a legal outcome (and the adversarial ones must be refused).
      if (((op.op === "append_stage" || op.op === "bind") && JSON.stringify(op).includes('"goal"')) || (op.op === "declare_input" && op.defaults !== undefined)) continue;
      // Settings are values, not enumerated: choosing the ones a loop already has is refused, legally.
      if (op.op === "set_loop" && res.error === "those are already its settings") continue;
      throw new Error(`listed move refused (seed ${seed}, step ${i}): ${JSON.stringify(op)} — ${res.error}`);
    }
    f = res.flow;
    out.push({ op, flow: f });
  }
  return out;
}

/** The ops that join one chain into a merge, each a LISTED move applied in turn; `[]` when no chain can be joined. */
function joinAChain(start: EFlow, cat: CatalogueSnapshot, r: () => number): WalkStep[] {
  const heads = start.steps.filter((s) => s.kind === "branch" && !s.elseOf).map((s) => s.id);
  if (!heads.length) return [];
  const chain = chainOf(start, pick(r, heads));
  const closed = !(start.steps.find((s) => s.id === chain.at(-1)) as { conditions?: unknown[] }).conditions?.length;
  // A top-level step and one stage, listed as legal under EVERY link (so the transforms share one type).
  const cands = legalMoves(start, cat).filter((m): m is Move & { op: "add_transform" } => m.op === "add_transform" && chain.every((b) => m.unders.includes(b)));
  if (!cands.length) return [];
  const m = pick(r, cands), stage = pick(r, m.stages);
  const out: WalkStep[] = [];
  let f = start;
  const ids: string[] = [];
  const step = (op: EngineOp): boolean => { const res = apply(f, op, cat); if (!res.ok) return false; f = res.flow; out.push({ op, flow: f }); return true; };
  for (const [k, b] of chain.entries()) {
    const id = `join_${b}`.slice(0, 58) + `_${k}`;
    if (f.steps.some((s) => s.id === id)) return [];
    if (!step({ op: "add_transform", id, from: m.from, pipeline: [stage], under: b })) return [];
    ids.push(id);
  }
  if (!closed || r() < 0.3) {
    const id = `join_${chain[0]}_fallback`.slice(0, 62);
    if (!f.steps.some((s) => s.id === id) && legalMoves(f, cat).some((x) => x.op === "add_transform" && x.from === m.from)) { if (step({ op: "add_transform", id, from: m.from, pipeline: [stage] })) ids.push(id); }
  }
  const merge = legalMoves(f, cat).find((x): x is Move & { op: "add_merge" } => x.op === "add_merge");
  const src = merge?.sources.find((xs) => xs.every((x) => ids.includes(x)));
  if (!src) return [];
  const mid = `merged_${chain[0]}`.slice(0, 62);
  if (f.steps.some((s) => s.id === mid) || !step({ op: "add_merge", id: mid, sources: src })) return [];
  return out;
}

/**
 * A loop over a bounded list (D-361): a listed `limit` stage on a step that has rows (when no bounded list exists yet), the
 * listed loop over it, and one listed step inside. Random walks rarely line these up, and a loop the property test never
 * reaches is untested. Every op is a listed move applied in turn; `[]` when none fits.
 */
function loopAList(start: EFlow, cat: CatalogueSnapshot, r: () => number): WalkStep[] {
  const out: WalkStep[] = [];
  let f = start;
  const step = (op: EngineOp): boolean => { const res = apply(f, op, cat); if (!res.ok) return false; f = res.flow; out.push({ op, flow: f }); return true; };
  const fresh = (base: string) => { let x = base.slice(0, 58); for (let k = 2; f.steps.some((s) => s.id === x) || f.inputs.some((i) => i.id === x); k++) x = `${base.slice(0, 56)}_${k}`; return x; };
  let loopMove = legalMoves(f, cat).find((m): m is Move & { op: "add_loop" } => m.op === "add_loop");
  if (!loopMove) {
    const bound = legalMoves(f, cat).filter((m): m is Move & { op: "add_transform" } => m.op === "add_transform" && m.stages.some((st) => st.op === "limit"));
    if (!bound.length) return [];
    const m = pick(r, bound);
    if (!step({ op: "add_transform", id: fresh("some"), from: m.from, pipeline: [m.stages.find((st) => st.op === "limit")!] })) return [];
    loopMove = legalMoves(f, cat).find((x): x is Move & { op: "add_loop" } => x.op === "add_loop");
    if (!loopMove) return [];
  }
  const loop = fresh("each");
  if (!step({ op: "add_loop", id: loop, over: pick(r, loopMove.overs) })) return [];
  const moves = legalMoves(f, cat);
  const call = moves.find((m): m is Move & { op: "add_call" } => m.op === "add_call" && m.insides.includes(loop));
  const shape = moves.find((m): m is Move & { op: "add_transform" } => m.op === "add_transform" && m.from === loop);
  if (call && (r() < 0.6 || !shape)) {
    const id = fresh(`call_${loop}`);
    if (!step({ op: "add_call", id, ref: pick(r, call.refs), under: loop })) return [];
    // D-370: the shape the compiler runs in BATCHES — one call fed from the item, and the loop closed on it. Each input takes a
    // listed source from the item where one is offered; half the time the loop is closed on the call right away.
    for (const b of legalMoves(f, cat).filter((m): m is Move & { op: "bind" } => m.op === "bind" && m.stepId === id)) {
      const src = b.sources.find((x) => "stepId" in x && x.stepId === loop);
      if (src) step({ op: "bind", stepId: id, port: b.port, source: src });
    }
    const close = legalMoves(f, cat).find((m): m is Move & { op: "close_loop" } => m.op === "close_loop" && m.loop === loop && m.results.includes(id));
    if (close && r() < 0.5) step({ op: "close_loop", id: fresh(`${loop}_rows`), loop, result: id });
  }
  else if (shape) { if (!step({ op: "add_transform", id: fresh(`shape_${loop}`), from: loop, pipeline: [pick(r, shape.stages)] })) return []; }
  else return [];
  return out;
}

/**
 * A condition PER ITEM (D-361): inside an open loop, a one-record test on the item (a listed `keep_if` stage, or a listed
 * `keep_if` literal slot after a first stage), then a listed condition on it, and a step under it. Random walks almost never
 * assemble this by chance, and it is the loop's reason to exist. Every op is a listed move applied in turn; `[]` when none fits.
 */
function decideInALoop(start: EFlow, cat: CatalogueSnapshot, r: () => number): WalkStep[] {
  const loops = start.steps.filter((s) => s.kind === "for_each").map((s) => s.id);
  if (!loops.length) return [];
  const loop = pick(r, loops);
  const out: WalkStep[] = [];
  let f = start;
  const step = (op: EngineOp): boolean => { const res = apply(f, op, cat); if (!res.ok) return false; f = res.flow; out.push({ op, flow: f }); return true; };
  const fresh = (base: string) => { let x = base.slice(0, 58); for (let k = 2; f.steps.some((s) => s.id === x) || f.inputs.some((i) => i.id === x); k++) x = `${base.slice(0, 56)}_${k}`; return x; };
  const add = legalMoves(f, cat).find((m): m is Move & { op: "add_transform" } => m.op === "add_transform" && m.from === loop);
  if (!add) return [];
  const test = fresh(`test_${loop}`);
  const keep = add.stages.filter((st) => st.op === "keep_if");
  if (keep.length) { if (!step({ op: "add_transform", id: test, from: loop, pipeline: [pick(r, keep)] })) return []; }
  else {
    if (!step({ op: "add_transform", id: test, from: loop, pipeline: [pick(r, add.stages)] })) return [];
    const app = legalMoves(f, cat).find((m): m is Move & { op: "append_stage" } => m.op === "append_stage" && m.stepId === test);
    const slot = app?.literals.find((l) => l.what.startsWith("keep it if"));
    if (!slot || !step({ op: "append_stage", stepId: test, stage: slot.make(sampleLiteral(slot.ty, cat, () => 0.9)) })) return [];
  }
  const when = fresh(`when_${loop}`);
  if (!step({ op: "add_branch", id: when, when: [{ stepId: test, test: r() < 0.5 ? "any" : "none" }] })) return [];
  if (r() < 0.5) step({ op: "add_otherwise", id: fresh(`else_${loop}`), of: when });
  return out;
}

/**
 * Fill holes with LEGAL moves only, until none is fillable: choose a reader, bind a required port (a listed source first, a
 * typed literal slot otherwise), declare a result. Stands in for the chooser/person answering, so the property test reaches
 * COMPLETE states (which the save funnel judges) often, not by luck. It can only do what `legalMoves` lists.
 */
export function complete(start: EFlow, cat: CatalogueSnapshot, seed: number): WalkStep[] {
  const r = rng(seed);
  const out: WalkStep[] = [];
  let f = start;
  for (let guard = 0; guard < 60 && f.holes.length; guard++) {
    const moves = legalMoves(f, cat);
    const holeSites = new Set(f.holes.map((h) => (h.site.at === "port" ? `${h.site.stepId}.${h.site.port}` : h.site.at === "reader" ? `${h.site.stepId}@` : h.site.at === "arm" ? `${h.site.stepId}#arm` : "output")));
    const emptyArm = f.holes.find((h) => h.site.at === "arm")?.site as { stepId: string } | undefined;
    // An empty arm is filled by a step placed under it: a transform when one is legal there, else a call.
    const placeable = (m: Move, id: string) => (m.op === "add_transform" || m.op === "add_call") && (m.unders.includes(id) || m.insides.includes(id));
    const armFill = emptyArm && (moves.find((m) => m.op === "add_transform" && placeable(m, emptyArm.stepId)) ?? moves.find((m) => m.op === "add_call" && placeable(m, emptyArm.stepId)));
    // Before the result is declared, sometimes JOIN a chain (D-320): the same listed transform under every link (and a
    // top-level fallback when the chain has no else), then the listed merge of them — which becomes the result. Random walks
    // almost never build two same-typed guarded transforms by chance, and a merge the walk never reaches is untested.
    if (holeSites.size === 1 && holeSites.has("output") && !f.steps.some((s) => s.kind === "merge") && r() < 0.7) {
      const joined = joinAChain(f, cat, r);
      if (joined.length) { out.push(...joined); f = joined.at(-1)!.flow; continue; }
    }
    // For each (D-361): an open loop with a body is usually CLOSED before the result is declared, and its output preferred as the
    // result — random walks rarely pick close_loop at the right moment, and a box output nothing reaches is untested.
    if (holeSites.size === 1 && holeSites.has("output") && !f.steps.some((s) => s.kind === "for_each") && r() < 0.35) {
      const looped = loopAList(f, cat, r);
      if (looped.length) { out.push(...looped); f = looped.at(-1)!.flow; continue; }
    }
    if (holeSites.has("output") && f.steps.some((s) => s.kind === "for_each") && !f.steps.some((s) => s.kind === "branch" && loopOfStep(f).has(s.id)) && r() < 0.6) {
      const decided = decideInALoop(f, cat, r);
      if (decided.length) { out.push(...decided); f = decided.at(-1)!.flow; continue; }
    }
    const closeMove = moves.find((m): m is Move & { op: "close_loop" } => m.op === "close_loop");
    if (holeSites.has("output") && closeMove && r() < 0.8) {
      const op: EngineOp = { op: "close_loop", id: `results_${closeMove.loop}`.slice(0, 62), loop: closeMove.loop, result: pick(r, closeMove.results) };
      const res = apply(f, op, cat);
      if (res.ok) { f = res.flow; out.push({ op, flow: f }); continue; }
    }
    const outMove = moves.find((m) => m.op === "set_output") as (Move & { op: "set_output" }) | undefined;
    const merged = outMove?.steps.find((id) => ["merge", "collect"].includes(f.steps.find((s) => s.id === id)?.kind ?? ""));
    const fill = moves.find((m) => m.op === "choose_reader" && m.refs.length)
      ?? moves.find((m) => m.op === "bind" && holeSites.has(`${m.stepId}.${m.port}`) && (m.sources.length || m.literal))
      ?? armFill
      ?? (holeSites.has("output") ? (merged ? { op: "set_output" as const, steps: [merged] } : outMove) : undefined);
    if (!fill) break;
    let op: EngineOp | null;
    const armId = () => { let x = `arm_${emptyArm!.stepId}`.slice(0, 56); for (let k = 2; f.steps.some((s) => s.id === x) || f.inputs.some((i) => i.id === x); k++) x = `arm_${emptyArm!.stepId}`.slice(0, 56) + `_${k}`; return x; };
    if (fill === armFill && emptyArm) op = fill.op === "add_transform" ? { op: "add_transform", id: armId(), from: fill.from, pipeline: [pick(r, fill.stages)], under: emptyArm.stepId } : fill.op === "add_call" ? { op: "add_call", id: armId(), ref: pick(r, fill.refs), under: emptyArm.stepId } : null;
    else if (fill.op === "bind") op = fill.sources.length && r() < 0.8 ? { op: "bind", stepId: fill.stepId, port: fill.port, source: pick(r, fill.sources) } : fill.literal ? { op: "bind", stepId: fill.stepId, port: fill.port, source: { from: "literal", value: sampleLiteral(fill.literal, cat, r), provenance: "goal" } } : null;
    else op = instantiate(f, fill, cat, r);
    if (!op) break;
    const res = apply(f, op, cat);
    if (!res.ok) { if (op.op === "bind" && op.source.from === "literal") continue; throw new Error(`listed fill refused (seed ${seed}): ${JSON.stringify(op)} — ${res.error}`); }
    f = res.flow;
    out.push({ op, flow: f });
  }
  return out;
}
