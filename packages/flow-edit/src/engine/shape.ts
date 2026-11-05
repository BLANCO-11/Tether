/**
 * Each step's STRUCTURE, for a builder to draw as a component (compiled-builder phase Z, I-320): its declared inputs with their
 * types and what fills each, its output fields with their types, a condition's paths, and who reads it. DATA, never sentences —
 * the canvas renders it as tokens (a variable chip, an operator, a literal, a type badge), the way a workflow tool shows a node's
 * configuration. Derived from the typed state and the catalogue's declarations; nothing keyed to a tool, column or workspace.
 */
import type { CatalogueSnapshot } from "../typecheck/signature.js";
import type { Ty } from "../typecheck/types.js";
import type { Comb, Pred } from "../ir/combinators.js";
import { armOfStep, collectOf, loopMembers, loopOfStep, type EFlow, type ESource, type EStep } from "./model.js";
import { fieldLabel, readableTy, readersOf } from "./ops.js";

/** A variable: a step's whole output (`field` absent), or one field of it; `asText` when it is written out as text. */
export interface VarRef { stepId: string; field?: string; asText?: boolean }
export type SlotValue =
  | { var: VarRef }
  /** `drafted`: wording the builder wrote from the goal (Z8) — shown as drafted, for the person to keep or change. */
  | { literal: string; drafted?: true }
  | { input: string }
  /** Nothing bound: required and missing; optional and left empty; or filled by the receiver with whoever starts the run. */
  | { unset: "required" | "optional" | "requester" };
/**
 * `group`: the declared section this port is shown under (a file's rows, name and format read as one "Attachment"); `needs`: the
 * port a value here is useless without. Both are the tool's own declarations, so a builder groups by them and never by a name.
 */
export interface SlotView { name: string; type: string; required: boolean; value: SlotValue; group?: string; needs?: string }
/** An output field. `label`: how a person reads it, when that differs from the stored name (a loop's `ff_` fields). */
export interface FieldView { name: string; type: string; label?: string }
/**
 * A condition deciding on ONE value (phase C, D-371): stored as a transform ending in `keep_if` that only conditions read, and the
 * has-rows test on it. Shown as ONE test — `subject`, what is worked out from it first (`before`, e.g. a count), and the typed
 * `where` — never as "IF <transform> is not empty".
 */
export interface DecideTest {
  stepId: string; subject: string; before: Comb[]; where: Pred;
  /** The test is on each ROW of a list (a lone `filter`, not a Split side): the condition holds when SOME row passes ("read_1 has a
   * row whose name is blanco"), or — a has-none condition — when no row does. `before` is then empty. */
  anyRow?: true;
}
/**
 * One side of a Split (phase C, D-373): rows of `subject` divided by ONE test into the rows that match (`matched`) and the rest —
 * stored as two filters over the same rows, the second's test exactly `not` of the first's (generated, never hand-written), each
 * tested by its own condition. Both sides can run in one run; a side with no rows does not. `pair` is the other side's filter.
 */
export interface SplitSide { side: "matched" | "rest"; pair: string; subject: string; where: Pred; branchId: string }
export interface PathView { branchId: string; label: "IF" | "ELIF" | "ELSE"; conditions: Array<{ var: VarRef; op: "is not empty" | "is empty"; test?: DecideTest; split?: SplitSide }>; steps: string[] }
export interface StepShape {
  inputs: SlotView[];
  /** The fields a reader of this step sees, with their types; or one value's type; or null when it gives nothing readable. */
  output: { fields: FieldView[]; list: boolean } | { type: string } | null;
  /** The declared component's output is text a model wrote (the catalogue's `modelText`). */
  modelText?: boolean;
  /** A call made once per row of this step. */
  perRow?: string;
  /** The condition path this step runs on. */
  on?: { branchId: string; label: PathView["label"] };
  /** A condition's whole chain (on every link of it). */
  paths?: PathView[];
  /** This step is a condition's test (a Decide): drawn as part of that condition, not as a card of its own. */
  testFor?: string;
  /** This filter is one exit of a Split: its rows, and the condition that runs that exit's steps. */
  split?: SplitSide;
  /** For each (phase F): the loop this step runs inside, once per item. */
  inLoop?: string;
  /** For each (phase F), on the loop itself: its settings, the steps inside it, and its output step and each row's result. */
  loop?: LoopView;
  /** Who reads this step, and into which input. */
  usedBy: Array<{ stepId: string; input?: string }>;
}
export interface LoopView { over: string; concurrency: number; onError: "continue" | "stop"; members: string[]; collect: string | null; result: string | null }

/** A type as a workflow tool names it: string, number, boolean, date, email, object, array[object], … — `?` when it may be empty. */
export function typeName(ty: Ty): string {
  switch (ty.t) {
    case "Text": return "string";
    case "Int": case "Number": return "number";
    case "Bool": return "boolean";
    case "Date": return "date";
    case "DateTime": return "datetime";
    case "Month": return "month";
    case "Address": return "email";
    case "Key": return "id";
    case "Option": return `${typeName(ty.of)}?`;
    case "Record": return "object";
    case "Envelope": return typeName(ty.of);
    case "Rows": case "List": { const of = ty.of.t === "Option" ? ty.of.of : ty.of; return `array[${typeName(of).replace(/\?$/, "")}]`; }
    default: return "any";
  }
}

const varOf = (s: ESource): SlotValue => {
  switch (s.from) {
    case "input": return { input: s.inputId };
    case "literal": return { literal: s.value };
    case "step": return { var: { stepId: s.stepId, field: s.field } };
    case "whole": return { var: { stepId: s.stepId, asText: true } };
  }
};

function outputOf(f: EFlow, cat: CatalogueSnapshot, s: EStep): StepShape["output"] {
  if (s.kind === "branch" || s.kind === "approval") return null;
  const ty = readableTy(f, cat, s.id);
  if (typeof ty === "string") return null;
  const inner = ty.t === "Envelope" ? ty.of : ty;
  const list = inner.t === "Rows" || inner.t === "List";
  const rec = list ? (inner.of.t === "Option" ? inner.of.of : inner.of) : inner;
  if (rec.t === "Record") return { list, fields: Object.entries(rec.fields).map(([name, t]) => ({ name, type: typeName(t), ...(fieldLabel(name) !== name ? { label: fieldLabel(name) } : {}) })) };
  return { type: typeName(ty) };
}

/**
 * The Decide test a step is, or null: a transform whose every reader is a condition that tests it, ending in `keep_if` (one value
 * compared) — or ONE `filter` that is not a Split side (a row test: some row passes). From structure alone, never a stored flag.
 */
export function decideTest(f: EFlow, stepId: string): DecideTest | null {
  const s = f.steps.find((x) => x.id === stepId);
  if (!s || s.kind !== "transform") return null;
  const last = s.pipeline.at(-1);
  const anyRow = s.pipeline.length === 1 && last?.op === "filter";
  if (!last || (last.op !== "keep_if" && !anyRow) || (anyRow && splitSide(f, stepId))) return null;
  // Who reads it is the engine's ONE definition (`readersOf`): an else-if depends on nothing and reads its test only through its
  // condition, which a second copy here missed — so an else-if's Decide was never recognised (drawn as "is not empty", not editable).
  // A reader that is not a step (the flow's result) is not a condition either, so such a step is no Decide's test.
  const readers = readersOf(f, stepId).map((id) => f.steps.find((x) => x.id === id));
  if (!readers.length || !readers.every((r) => r?.kind === "branch" && (r.conditions ?? []).some((c) => c.left.stepId === stepId))) return null;
  return { stepId, subject: s.from, before: s.pipeline.slice(0, -1), where: last.where, ...(anyRow ? { anyRow: true as const } : {}) };
}

/**
 * The Split side `stepId` is, from structure alone — never a stored flag: a filter whose pipeline is ONE `filter`, paired with
 * another filter over the same rows whose test is exactly `not` of its own, each tested ("has rows") by a condition that opens
 * its own chain. Edit either filter and the pair is two ordinary filters again, shown as such.
 */
export function splitSide(f: EFlow, stepId: string): SplitSide | null {
  const one = (id: string) => { const s = f.steps.find((x) => x.id === id); return s?.kind === "transform" && s.pipeline.length === 1 && s.pipeline[0]!.op === "filter" ? { s, where: (s.pipeline[0] as { where: Pred }).where } : null; };
  const me = one(stepId);
  if (!me) return null;
  const guard = (id: string) => f.steps.find((x) => x.kind === "branch" && !x.elseOf && x.conditions?.length === 1 && x.conditions[0]!.left.stepId === id && x.conditions[0]!.op === "any")?.id;
  const same = (a: Pred, b: Pred) => JSON.stringify(a) === JSON.stringify(b);
  for (const x of f.steps) {
    if (x.id === stepId) continue;
    const other = one(x.id);
    if (!other || other.s.from !== me.s.from) continue;
    const side = "not" in other.where && same(other.where.not, me.where) ? "matched" : "not" in me.where && same(me.where.not, other.where) ? "rest" : null;
    if (!side) continue;
    const mine = guard(stepId), theirs = guard(x.id);
    if (!mine || !theirs) continue;
    return { side, pair: x.id, subject: me.s.from, where: side === "matched" ? me.where : other.where, branchId: mine };
  }
  return null;
}

export function flowShape(f: EFlow, cat: CatalogueSnapshot): Record<string, StepShape> {
  const out: Record<string, StepShape> = {};
  const arms = armOfStep(f);
  const loops = f.steps.some((x) => x.kind === "for_each") ? loopOfStep(f) : new Map<string, string>();
  const branches = f.steps.filter((x): x is Extract<EStep, { kind: "branch" }> => x.kind === "branch");
  const pathOf = new Map<string, PathView["label"]>();
  const chains = new Map<string, PathView[]>();
  for (const head of branches.filter((b) => !b.elseOf)) {
    const chain: typeof branches = [];
    for (let cur: (typeof branches)[number] | undefined = head; cur && !chain.includes(cur); cur = branches.find((b) => b.elseOf === cur!.id)) chain.push(cur);
    const paths = chain.map((b, i): PathView => ({
      branchId: b.id,
      label: i === 0 ? "IF" : b.conditions?.length ? "ELIF" : "ELSE",
      conditions: (b.conditions ?? []).map((c) => { const test = decideTest(f, c.left.stepId), split = splitSide(f, c.left.stepId); return { var: { stepId: c.left.stepId }, op: c.op === "any" ? "is not empty" : "is empty", ...(test ? { test } : {}), ...(split ? { split } : {}) }; }),
      steps: f.steps.filter((x) => arms.get(x.id) === b.id).map((x) => x.id),
    }));
    for (const p of paths) { pathOf.set(p.branchId, p.label); chains.set(p.branchId, paths); }
  }
  for (const s of f.steps) {
    let inputs: SlotView[] = [];
    if (s.kind === "datasource" || s.kind === "tool") {
      const declared = s.ref ? cat.refs[s.ref]?.params ?? [] : [];
      const bound = new Map(s.inputs.map((b) => [b.name, b]));
      inputs = declared.map((p) => {
        const b = bound.get(p.name);
        const value: SlotValue = b?.source ? varOf(b.source) : { unset: p.fallsBackToRequester ? "requester" : p.required ? "required" : "optional" };
        return { name: p.name, type: typeName(p.ty), required: p.required, value: "literal" in value && b?.provenance?.from === "drafted" ? { ...value, drafted: true } : value, ...(p.group ? { group: p.group } : {}), ...(p.needs ? { needs: p.needs } : {}) };
      });
      for (const b of s.inputs) if (b.source && !declared.some((p) => p.name === b.name)) inputs.push({ name: b.name, type: "any", required: false, value: varOf(b.source) });
    } else if (s.kind === "transform") {
      inputs = [{ name: "rows", type: "array[object]", required: true, value: { var: { stepId: s.from } } }];
    } else if (s.kind === "merge") {
      inputs = s.sources.map((src, i) => ({ name: `path ${i + 1}`, type: "any", required: false, value: { var: { stepId: src } } }));
    } else if (s.kind === "for_each") {
      inputs = [{ name: "items", type: "array[object]", required: true, value: { var: { stepId: s.over.stepId } } }];
    } else if (s.kind === "collect") {
      inputs = [{ name: "result", type: "any", required: true, value: { var: { stepId: s.result } } }];
    }
    const arm = arms.get(s.id);
    const c = s.kind === "for_each" ? collectOf(f, s.id) : undefined;
    out[s.id] = {
      inputs,
      output: outputOf(f, cat, s),
      ...(s.kind === "tool" && cat.refs[s.ref]?.modelText ? { modelText: true } : {}),
      ...(s.kind === "tool" && s.over ? { perRow: s.over.stepId } : {}),
      ...(arm && pathOf.has(arm) ? { on: { branchId: arm, label: pathOf.get(arm)! } } : {}),
      ...(chains.has(s.id) ? { paths: chains.get(s.id)! } : {}),
      ...(loops.has(s.id) ? { inLoop: loops.get(s.id)! } : {}),
      ...(s.kind === "for_each" ? { loop: { over: s.over.stepId, concurrency: s.concurrency, onError: s.onError, members: loopMembers(f, s.id), collect: c?.id ?? null, result: c?.result ?? null } } : {}),
      ...(() => { const sp = splitSide(f, s.id); return sp ? { split: sp } : {}; })(),
      ...(() => { const t = decideTest(f, s.id); const by = t && f.steps.find((x) => x.kind === "branch" && (x.conditions ?? []).some((c) => c.left.stepId === s.id)); return by ? { testFor: by.id } : {}; })(),
      usedBy: [],
    };
  }
  // Who reads whom — the same reads `readersOf` counts, with the input named where there is one.
  const use = (from: string, to: string, input?: string) => {
    const o = out[from];
    if (o && !o.usedBy.some((u) => u.stepId === to && u.input === input)) o.usedBy.push({ stepId: to, ...(input ? { input } : {}) });
  };
  for (const s of f.steps) {
    if (s.kind === "transform") use(s.from, s.id);
    if (s.kind === "tool" && s.over) use(s.over.stepId, s.id);
    if (s.kind === "merge") for (const src of s.sources) use(src, s.id);
    if (s.kind === "for_each") use(s.over.stepId, s.id, "items");
    if (s.kind === "collect") use(s.result, s.id, "result");
    if (s.kind === "branch") for (const c of s.conditions ?? []) use(c.left.stepId, s.id);
    if ("inputs" in s) for (const b of s.inputs) if (b.source && (b.source.from === "step" || b.source.from === "whole")) use(b.source.stepId, s.id, b.name);
  }
  return out;
}
