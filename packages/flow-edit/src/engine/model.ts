/**
 * The legal-move engine's STATE (compiled-builder phase 3, D-316): the stored `FlowModel` itself, restricted to the constructs
 * the new builder produces, plus HOLES (D-317). The checker reads exactly this object and the compiler emits exactly this
 * object, so there is no second representation between an op and what runs.
 *
 * ⚠ A hole's SITE is left empty (a port unbound, a reader's `ref` absent, no result declared). The checker then says what it
 * always says about that empty site, and `checkState` turns the diagnostic AT a hole's site into a hole (FT08xx) — while any
 * error NOT at a hole's site stays an error. That is what makes "incomplete is not invalid" (P3) checkable: a hole cannot
 * hide an error elsewhere, and an empty site cannot hide without a hole.
 */
import { checkFlow } from "../typecheck/check.js";
import { diag, sortDiagnostics, type Diagnostic } from "../typecheck/diagnostic.js";
import { portsOf, type CatalogueSnapshot, type CheckModel } from "../typecheck/signature.js";
import type { Ty } from "../typecheck/types.js";
import type { Pipeline } from "../ir/combinators.js";

export type HoleOwner = "chooser" | "person" | "catalogue";
export type HoleSite = { at: "port"; stepId: string; port: string } | { at: "reader"; stepId: string } | { at: "arm"; stepId: string } | { at: "output" };
/** Why the site is a hole — decides which op may fill it and which question asks it. */
export type HoleWhy = "required" | "scheduled_recipient" | "reader" | "result" | "arm";
export interface Hole {
  id: string;
  site: HoleSite;
  why: HoleWhy;
  /** The type a filling must have; `null` where the site is a choice of component, not of value. */
  ty: Ty | null;
  owner: HoleOwner;
  reason: string;
  options?: string[];
}

/** `drafted` (phase Z, Z8): wording a builder wrote from the goal, shown as drafted — only ever on a port declared as words a person
 *  reads (a heading or a message), never an address, a channel or a number. */
export type Provenance = "goal" | "catalogue" | "person" | "drafted";
export type EInputType = "STRING" | "INT" | "FLOAT" | "BOOLEAN" | "DATE" | "DATETIME";
/** `computed`: a value derived from the run's firing time (the compiler's `ComputedInputFn`), never typed by a person. */
export const COMPUTED_INPUTS = ["priorMonth", "currentMonth", "priorDate", "currentDate", "currentYear", "runTimestamp", "currentMonthStart", "priorMonthStart"] as const;
export interface EInput { id: string; type: EInputType; required?: boolean; defaults?: string; format?: "month"; computed?: (typeof COMPUTED_INPUTS)[number]; /** Whole days added to a computed `currentDate`. */ offsetDays?: number }

/** A stored binding source — exactly `@foundry/flow-edit`'s `Source` subset the engine writes. */
export type ESource =
  | { from: "input"; inputId: string }
  | { from: "step"; stepId: string; field: string }
  | { from: "whole"; stepId: string; transform: "text" }
  | { from: "literal"; value: string };
/** A binding, with the literal's provenance kept beside it (the constants rule: a literal is quoted, catalogue, or answered). */
export interface EBinding { name: string; source: ESource | null; provenance?: { from: Provenance; quote?: string } }

export type EStep =
  /** `paramsExpr` is `"[{}]"` exactly when nothing is bound: the funnel refuses a call with no params at all (`validateModel`). */
  | { id: string; kind: "datasource"; ref?: string; inputs: EBinding[]; dependsOn: string[]; paramsExpr?: "[{}]" }
  | { id: string; kind: "tool"; ref: string; inputs: EBinding[]; dependsOn: string[]; over?: { stepId: string; field: "" }; paramsExpr?: "[{}]" }
  | { id: string; kind: "transform"; from: string; pipeline: Pipeline; expr: string; dependsOn: string[] }
  | { id: string; kind: "approval"; summary: string; dependsOn: string[] }
  /**
   * A condition (D-320): every `conditions` entry asks whether a list has rows (`any`/`none`), a conjunction. `elseOf` names
   * the link this one continues (an elif with conditions, the closing else without). Its ARM is everything that depends on
   * it, transitively, stopping at a merge — the compiler's `armOf`, computed identically by `armOfStep` below.
   */
  | { id: string; kind: "branch"; conditions?: ECondition[]; elseOf?: string; dependsOn: string[] }
  /** The first of `sources` that ran (D-320: transforms of one type, exhaustive over the chain, so never empty). */
  | { id: string; kind: "merge"; sources: string[]; dependsOn: string[] }
  /**
   * For each (phase F, D-361): the steps inside run once per row of `over` (a top-level transform's bounded list of records).
   * Inside, this step's VALUE is the current item — one record, read like any one-record step. Its BODY is everything that
   * depends on it, transitively (with an else-if's continuation where its chain is), stopping at a `collect` — the arm rule one
   * level out (`loopOfStep`). Nothing outside reads it or its body: the box's output is its `collect`.
   */
  | { id: string; kind: "for_each"; over: { stepId: string; field: "" }; concurrency: number; onError: "continue" | "stop"; dependsOn: string[] }
  /**
   * The box's output (D-361): one row per item, in input order — the item's own fields plus `i` (its number), `ok`, `error` and
   * `result` (the value of `result`, a body step that runs for every item). Depends on `result` only; `loop` names the box.
   */
  | { id: string; kind: "collect"; loop: string; result: string; dependsOn: string[] };

/** The stored `BranchCondition` shape, restricted to the two tests the engine offers (`field` is unused by both). */
export interface ECondition { left: { stepId: string; field: "" }; op: "any" | "none" }

export interface EFlow {
  id: string;
  inputs: EInput[];
  steps: EStep[];
  output?: { stepId: string };
  schedule?: { cron: string; timezone?: string };
  holes: Hole[];
}

export const emptyFlow = (id: string): EFlow => ({ id, inputs: [], steps: [], holes: [{ id: "h_result", site: { at: "output" }, why: "result", ty: null, owner: "chooser", reason: "no step is the flow's result yet" }] });

const sameSite = (a: HoleSite, b: HoleSite) =>
  a.at === b.at && (a.at === "output" || (a.stepId === (b as { stepId: string }).stepId && (a.at !== "port" || a.port === (b as { port: string }).port)));

// ── arms (D-320) ─────────────────────────────────────────────────────────────

/**
 * Which branch's arm each step is in — the compiler's `armOf`, exactly: the transitive `dependsOn` closure from a branch,
 * never entering a merge. A step reached from two branches appears under the FIRST; the engine never builds one (and the
 * compiler refuses it), so the map is total and single-valued on every state the engine reaches.
 */
export function armOfStep(f: EFlow): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of f.steps) {
    if (b.kind !== "branch") continue;
    const inArm = new Set([b.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of f.steps) {
        if (inArm.has(s.id) || s.kind === "merge") continue;
        if (s.dependsOn.some((d) => inArm.has(d))) { inArm.add(s.id); grew = true; }
      }
    }
    for (const id of inArm) if (id !== b.id && !out.has(id)) out.set(id, b.id);
  }
  return out;
}
/**
 * Which loop's body each step is in (D-361): the transitive `dependsOn` closure from a loop, plus an else-if's continuation
 * (which depends on nothing) when its chain's head is inside, never entering a `collect`. Loops never nest (the engine refuses
 * it), so the map is single-valued on every state the engine reaches.
 */
export function loopOfStep(f: EFlow): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of f.steps) {
    if (l.kind !== "for_each") continue;
    const inside = new Set([l.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of f.steps) {
        if (inside.has(s.id) || s.kind === "collect") continue;
        if (s.dependsOn.some((d) => inside.has(d)) || (s.kind === "branch" && s.elseOf && inside.has(s.elseOf))) { inside.add(s.id); grew = true; }
      }
    }
    for (const id of inside) if (id !== l.id && !out.has(id)) out.set(id, l.id);
  }
  return out;
}
/** The steps in loop `id`'s body, in model order. */
export const loopMembers = (f: EFlow, id: string): string[] => { const m = loopOfStep(f); return f.steps.filter((s) => m.get(s.id) === id).map((s) => s.id); };
/** The `collect` that closes loop `id`, if any. */
export const collectOf = (f: EFlow, id: string) => f.steps.find((s): s is EStep & { kind: "collect" } => s.kind === "collect" && s.loop === id);

/** The steps in branch `id`'s arm, in model order. */
export const armMembers = (f: EFlow, id: string): string[] => { const m = armOfStep(f); return f.steps.filter((s) => m.get(s.id) === id).map((s) => s.id); };
/** The opening `if` of the chain `id` is in (itself, when it continues nothing). */
export function chainHead(f: EFlow, id: string): string {
  let cur = id;
  for (let guard = 0; guard < f.steps.length; guard++) {
    const s = f.steps.find((x) => x.id === cur);
    if (!s || s.kind !== "branch" || !s.elseOf) return cur;
    cur = s.elseOf;
  }
  return cur;
}
/**
 * The order the COMPILER emits steps in — the order Kestra runs them: top-level steps in model order, and a whole chain at
 * its opening `if`'s position (each link, then its arm's members in model order). The fuzz evaluates in this order, so a
 * read the engine would make before its source ran is a read of nothing there too.
 */
export function emissionOrder(f: EFlow): string[] {
  const arms = armOfStep(f);
  const loops = loopOfStep(f);
  const out: string[] = [];
  // One level: a list of steps in model order, a chain emitted whole at its head. A loop's body is emitted right after the loop
  // (the compiler nests it in the ForEach), in model order, with its own chains the same way.
  const level = (ids: string[]) => {
    for (const id of ids) {
      const s = f.steps.find((x) => x.id === id)!;
      if (arms.has(s.id) || (s.kind === "branch" && s.elseOf)) continue;
      if (s.kind === "branch") { for (const link of chainOf(f, s.id)) { out.push(link); for (const x of f.steps) if (arms.get(x.id) === link) out.push(x.id); } continue; }
      out.push(s.id);
      if (s.kind === "for_each") level(f.steps.filter((x) => loops.get(x.id) === s.id).map((x) => x.id));
    }
  };
  level(f.steps.filter((s) => !loops.has(s.id)).map((s) => s.id));
  return out;
}
/** Every link of the chain opened by `head`, in order: if, elif…, else. */
export function chainOf(f: EFlow, head: string): string[] {
  const out = [head];
  for (let next = f.steps.find((s) => s.kind === "branch" && s.elseOf === head); next; next = f.steps.find((s) => s.kind === "branch" && s.elseOf === out.at(-1))) out.push(next.id);
  return out;
}

/** The hole at a site, if any. */
export const holeAt = (f: EFlow, site: HoleSite): Hole | undefined => f.holes.find((h) => sameSite(h.site, site));

/**
 * Is a hole's site EMPTY? A port: no binding with a source. A reader: no ref. The result: none declared. A hole whose site is
 * filled is a stale claim, and an invariant breach.
 */
export function siteEmpty(f: EFlow, site: HoleSite): boolean {
  if (site.at === "output") return !f.output;
  const s = f.steps.find((x) => x.id === site.stepId);
  if (!s) return false; // a hole on a step that does not exist is an invariant breach, reported as such
  if (site.at === "reader") return s.kind === "datasource" && !s.ref;
  if (site.at === "arm") return (s.kind === "branch" && armMembers(f, s.id).length === 0) || (s.kind === "for_each" && loopMembers(f, s.id).length === 0);
  return !("inputs" in s) || !s.inputs.some((b) => b.name === site.port && b.source);
}

/**
 * The engine's verdict on a state: the checker's diagnostics, with the ones AT a hole's site turned into holes, plus the two
 * hole invariants. A state is VALID when this has no `error`; COMPLETE when it has no `hole` either.
 */
export function checkState(f: EFlow, cat: CatalogueSnapshot): Diagnostic[] {
  const raw = checkFlow(f as unknown as CheckModel, cat);
  const out: Diagnostic[] = [];
  for (const d of raw) {
    const s = d.span;
    const site: HoleSite | null =
      (d.code === "FT0201" || d.code === "FT0508") && s.stepId && s.port ? { at: "port", stepId: s.stepId, port: s.port }
      : d.code === "FT0105" && s.stepId ? { at: "reader", stepId: s.stepId }
      : null;
    const h = site ? holeAt(f, site) : undefined;
    out.push(h ? diag("FT0801", d.span, `undecided: ${h.reason}`, { note: `hole \`${h.id}\`, the ${h.owner}'s to fill` }) : d);
  }
  // Invariant 1: every hole's site is empty (a filled site with a hole left behind is a stale claim).
  const ids = new Set<string>();
  for (const h of f.holes) {
    if (ids.has(h.id)) out.push(diag("FT0802", {}, `two holes share the id \`${h.id}\``));
    ids.add(h.id);
    if (!siteEmpty(f, h.site)) out.push(diag("FT0802", h.site.at === "output" ? {} : { stepId: h.site.stepId }, `hole \`${h.id}\` names a site that is not empty`));
    // The checker says nothing about these two sites (an empty arm is the COMPILER's refusal), so the hole speaks for itself.
    else if (h.site.at === "output" || h.site.at === "arm") out.push(diag("FT0801", h.site.at === "arm" ? { stepId: h.site.stepId } : {}, `undecided: ${h.reason}`, { note: `hole \`${h.id}\`, the ${h.owner}'s to fill` }));
  }
  // Invariant 2: every empty required site has a hole (no silent gap).
  for (const s of f.steps) {
    if (s.kind === "branch" && !armMembers(f, s.id).length && !holeAt(f, { at: "arm", stepId: s.id })) out.push(diag("FT0802", { stepId: s.id }, `the condition \`${s.id}\` guards nothing and no hole says so`));
    if (s.kind === "for_each" && !loopMembers(f, s.id).length && !holeAt(f, { at: "arm", stepId: s.id })) out.push(diag("FT0802", { stepId: s.id }, `the loop \`${s.id}\` runs nothing and no hole says so`));
    if (s.kind === "datasource" && !s.ref && !holeAt(f, { at: "reader", stepId: s.id })) out.push(diag("FT0802", { stepId: s.id }, `the reader \`${s.id}\` has no component and no hole says so`));
    if (s.kind !== "datasource" && s.kind !== "tool") continue;
    for (const p of portsOf(s as never, cat) ?? []) {
      if (p.required && siteEmpty(f, { at: "port", stepId: s.id, port: p.name }) && !holeAt(f, { at: "port", stepId: s.id, port: p.name }))
        out.push(diag("FT0802", { stepId: s.id, port: p.name }, `required \`${p.name}\` is unbound and no hole says so`));
    }
  }
  if (!f.output && !holeAt(f, { at: "output" })) out.push(diag("FT0802", {}, "no result is declared and no hole says so"));
  return sortDiagnostics(out);
}

export const errorsOf = (ds: Diagnostic[]) => ds.filter((d) => d.severity === "error");
export const holesOf = (ds: Diagnostic[]) => ds.filter((d) => d.severity === "hole");

/**
 * The engine models every reader as a `datasource` step; the COMPILER distinguishes a named query (`datasource`, resolved by the
 * named-query route) from a DB operation (`query`, run by `runOperation`). These two functions are the one boundary between them
 * (I-297): the save funnel stores an operation read as `query` — or it is resolved as a named query and 404s at run time — and an
 * edit reads a stored flow back as the engine's `datasource`. Nothing else in the engine needs to know the difference.
 */
export function storedReaderKinds<M extends { steps: Array<{ kind: string; ref?: string }> }>(model: M, cat: CatalogueSnapshot): M {
  return { ...model, steps: model.steps.map((s) => (s.kind === "datasource" && s.ref && cat.refs[s.ref]?.kind === "operation" ? { ...s, kind: "query" } : s)) };
}
export function engineReaderKinds<M extends { steps: Array<{ kind: string }> }>(model: M): M {
  return { ...model, steps: model.steps.map((s) => (s.kind === "query" ? { ...s, kind: "datasource" } : s)) };
}

