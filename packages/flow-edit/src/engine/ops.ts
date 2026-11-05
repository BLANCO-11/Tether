/**
 * The engine's ops (compiled-builder phase 3, D-316): each is a PRECONDITION over types and an EFFECT, and the preconditions
 * are what guarantee the effect is a valid state. `apply` checks the precondition and never repairs: a refusal names what is
 * missing, and the state is unchanged.
 *
 * ⚠ The preconditions are stated here in the types' own terms — they are NOT "apply, then run the checker". The checker is
 * the property test's oracle (`legal.property.test.ts`): a state it rejects that an op admitted is a bug in that op's
 * precondition, and the fix is the precondition, never the test.
 *
 * Construction order is the one rule that makes most of the rest local: a step may read only steps BEFORE it (Kestra runs
 * tasks in emission order, and it rules out cycles), and a step may be changed or removed only while nothing reads it — so
 * no edit can move the type under a reader.
 */
import { lowerPipeline, typeTransform, withContext, type Comb, type Pipeline, type Pred } from "../ir/combinators.js";
import { outputOf, pipelineInputType, portsOf, rowOf, tyOfFlowInput, type CatalogueSnapshot, type CheckModel, type CheckStep, type PortSig } from "../typecheck/signature.js";
import { assignable, render, T, type Ty } from "../typecheck/types.js";
import { COMPUTED_INPUTS, checkState, errorsOf, armMembers, armOfStep, chainHead, chainOf, collectOf, holeAt, loopMembers, loopOfStep, type ECondition, type EBinding, type EFlow, type EInput, type EInputType, type ESource, type EStep, type Hole, type HoleOwner, type HoleSite, type Provenance } from "./model.js";

/** What a port is bound FROM, as the engine offers it — each maps to one stored `ESource`. */
export type BindSource =
  | { from: "input"; inputId: string }
  /** One row's field of the step this call fans out over, or a field of a step that produces ONE record. */
  | { from: "field"; stepId: string; field: string }
  /** Every row's field of a rows step this call does NOT fan out over — a list. */
  | { from: "column"; stepId: string; field: string }
  /** The whole output as JSON text — for a text port (a model's input). */
  | { from: "text"; stepId: string }
  | { from: "literal"; value: string; provenance: Provenance; quote?: string };

export type EngineOp =
  | { op: "declare_input"; id: string; type: EInputType; format?: "month"; required?: boolean; defaults?: string; computed?: EInput["computed"]; offsetDays?: number }
  | { op: "remove_input"; id: string }
  /** Ask for an input as a different type — the same input, every step that reads it re-judged against its new type. */
  | { op: "retype_input"; id: string; type: EInputType; format?: "month" }
  /** `under` puts the new step in a condition's arm (D-320); a step that reads a guarded one is in its arm regardless. */
  | { op: "add_reader"; id: string; ref?: string; under?: string }
  | { op: "choose_reader"; stepId: string; ref: string }
  /** `before` (phase C): placed just ahead of that top-level step, not at the end — how an else-if's test runs before its chain decides. */
  | { op: "add_transform"; id: string; from: string; pipeline: Pipeline; under?: string; before?: string }
  | { op: "append_stage"; stepId: string; stage: Comb }
  /**
   * Phase C: change what a test compares — a `filter` or a `keep_if` stage of a transform (`stage`, the last by default). Allowed while the
   * step is read, because neither stage changes what the step produces (refused if the type would move): how a Decide's value
   * or a Split's test is edited in place, its paths and what runs on them kept.
   */
  /** `stage`: which stage's test (0-based) — the last when absent. */
  | { op: "retest"; stepId: string; where: Pred; stage?: number }
  /**
   * `over` fans the call out over a transform's bounded rows, and then `row` names its FIRST binding from those rows, in the
   * same op: a fan-out that binds nothing from its rows has no per-row call to render, so the compiler emits it as ONE call.
   */
  | { op: "add_call"; id: string; ref: string; over?: string; row?: { port: string; field: string }; under?: string }
  | { op: "bind"; stepId: string; port: string; source: BindSource }
  | { op: "unbind"; stepId: string; port: string; owner?: HoleOwner }
  | { op: "add_gate"; id: string; before: string; summary: string }
  | { op: "set_output"; stepId: string }
  | { op: "set_schedule"; cron: string | null }
  | { op: "remove_step"; stepId: string }
  /** A condition (D-320): the arm runs when every `when` holds — each asks whether a list step has rows. */
  | { op: "add_branch"; id: string; when: When[] }
  /** Continue the chain's last link: an elif with `when`, the closing else without. */
  | { op: "add_otherwise"; id: string; of: string; when?: When[] }
  /** The first of `sources` that ran — transforms of one type, a value on every path. */
  | { op: "add_merge"; id: string; sources: string[] }
  /**
   * For each (phase F, D-361): the steps placed inside (`under` the loop's id, or reading its item) run once per row of `over`, a
   * top-level transform's bounded list of records. `concurrency` items at once (1…MAX_CONCURRENCY, default 5); `onError`: keep
   * going (the default) or stop the run.
   */
  | { op: "add_loop"; id: string; over: string; concurrency?: number; onError?: "continue" | "stop" }
  | { op: "set_loop"; stepId: string; concurrency?: number; onError?: "continue" | "stop" }
  /** Close the box: its output, one row per item, with `result` (a body step that runs for every item) as each row's `result`. */
  | { op: "close_loop"; id: string; loop: string; result: string }
  /** Change which body step is the result — while nothing reads the box's output, or when the type does not move. */
  | { op: "set_loop_result"; stepId: string; result: string };
export interface When { stepId: string; test: "any" | "none" }
/** At most this many conditions on one link — a conjunction, not a query language. */
export const MAX_WHEN = 3;
export const MAX_MERGE = 4;
/** At most this many items at once (D-362): the tool endpoints' own limits are the real bound, and 20 is well inside Kestra's. */
export const MAX_CONCURRENCY = 20;
export const DEFAULT_CONCURRENCY = 5;
/** The fields the box's output adds to each item's own (D-361); an item carrying one of them cannot be closed. */
/**
 * The fields a loop's output ADDS to each item (D-363, amended 2026-09-30): prefixed `ff_` ("Foundry field") so an item's own `ok`
 * or `result` never collides. Front ends label them in words (`COLLECT_FIELD_WORDS`).
 */
export const COLLECT_FIELDS = ["ff_i", "ff_ok", "ff_error", "ff_result"] as const;
/** What each added field is, in words — the one copy every front end shows beside the stored name. */
export const COLLECT_FIELD_WORDS: Record<(typeof COLLECT_FIELDS)[number], string> = { ff_i: "loop: item number", ff_ok: "loop: worked", ff_error: "loop: error", ff_result: "loop: result" };
/** A field as a person reads it: a loop's own field in words ("loop: worked"), any other field by its name. */
export const fieldLabel = (name: string): string => (COLLECT_FIELD_WORDS as Record<string, string>)[name] ?? name;

export type Applied = { ok: true; flow: EFlow } | { ok: false; error: string };

const no = (error: string): Applied => ({ ok: false, error });

export const STEP_ID = /^[a-z][a-z0-9_]{0,62}$/;
const RESERVED = new Set(["begin", "complete", "inputs", "outputs"]);
/** The step cap the save funnel enforces (D-37) — mirrored as a precondition so no walk reaches a state it refuses. */
export const MAX_STEPS = 25;
/** The fan-out bound (`stepBatchSchema.params.max(1000)`). */
export const MAX_FANOUT = 1000;

/**
 * ⚠ NEGATIVE CONTROLS ONLY (phase 3 tasks 5/8). Naming a precondition here switches it OFF in the one function that states
 * it, so both `legalMoves` and `apply` stop enforcing it — and the property test must then find a state the checker refuses.
 * Empty in every production path; a test that fills it restores it in `finally`. Greppable by design.
 */
export const DISABLED_PRECONDITIONS = new Set<"fits" | "bounded" | "literal" | "placement">();

// ── reading a state ─────────────────────────────────────────────────────────

const byId = (f: EFlow, id: string) => f.steps.find((s) => s.id === id);
const indexOf = (f: EFlow, id: string) => f.steps.findIndex((s) => s.id === id);
const asModel = (f: EFlow) => f as unknown as CheckModel;
const inputCtx = (f: EFlow) => ({ inputs: Object.fromEntries(f.inputs.map((i) => [i.id, tyOfFlowInput(i)])) });
const hasOpaque = (ty: Ty) => JSON.stringify(ty).includes('"Opaque"') || JSON.stringify(ty).includes('"Json"');

/** Does anything in the flow read step `id`? (a binding, a pipeline, a fan-out, a dependency, the result) */
export function readersOf(f: EFlow, id: string): string[] {
  const out = new Set<string>();
  for (const s of f.steps) {
    if (s.id === id) continue;
    if (s.dependsOn.includes(id)) out.add(s.id);
    if (s.kind === "transform" && s.from === id) out.add(s.id);
    if (s.kind === "tool" && s.over?.stepId === id) out.add(s.id);
    if (s.kind === "branch" && (s.elseOf === id || s.conditions?.some((c) => c.left.stepId === id))) out.add(s.id);
    if (s.kind === "merge" && s.sources.includes(id)) out.add(s.id);
    if (s.kind === "for_each" && s.over.stepId === id) out.add(s.id);
    if (s.kind === "collect" && (s.loop === id || s.result === id)) out.add(s.id);
    if ("inputs" in s && s.inputs.some((b) => b.source && "stepId" in b.source && b.source.stepId === id)) out.add(s.id);
  }
  if (f.output?.stepId === id) out.add("(the result)");
  return [...out];
}

/**
 * The value a step gives a READER, or why it gives none: a reader with no component, an approval, a model's text consumed
 * by computation, or a type with an undeclared part (`Opaque`/`Json` — nothing downstream could check a read of it).
 */
export function readableTy(f: EFlow, cat: CatalogueSnapshot, id: string): Ty | string {
  const s = byId(f, id);
  if (!s) return `no step \`${id}\``;
  if (s.kind === "approval") return `\`${id}\` is a gate and produces nothing`;
  if (s.kind === "branch") return `\`${id}\` is a condition and produces nothing`;
  if (s.kind === "datasource" && !s.ref) return `\`${id}\` has no component yet`;
  const ty = outputOf(s as unknown as CheckStep, cat, asModel(f));
  if (!ty) return `\`${id}\` names a component this workspace does not have`;
  if (hasOpaque(ty)) return `\`${id}\` has a part with no declared type (${render(ty)})`;
  return ty;
}
/** A tool whose output the catalogue DECLARES to be a model's text (D-34, I-292) — never known by its name. */
const isModelText = (s: EStep | undefined, cat: CatalogueSnapshot) => s?.kind === "tool" && !!cat.refs[s.ref]?.modelText;

// ── arms (D-320) ─────────────────────────────────────────────────────────────

const hasBranch = (f: EFlow) => f.steps.some((s) => s.kind === "branch");
/**
 * A guarded step may read a top-level one only if it is placed BEFORE the chain's head: the compiler emits a whole chain,
 * arms included, at the opening `if`'s position, so a top-level step placed after it has not run when the arm does. And a
 * guarded step never reads a merge (the merge runs after the whole condition; the compiler refuses it by name).
 */
function guardedMayRead(f: EFlow, arm: string, read: string, arms: Map<string, string>): string | null {
  if (arms.has(read) || DISABLED_PRECONDITIONS.has("placement")) return null;
  const head = chainHead(f, arm);
  if (byId(f, read)?.kind === "merge") return `a step under the condition \`${head}\` cannot read the merge \`${read}\` — a merge runs after the whole condition`;
  if (indexOf(f, read) > indexOf(f, head)) return `\`${read}\` is placed after the condition \`${head}\` begins, and a guarded step runs where its condition is`;
  return null;
}
/**
 * The loop a step reading `reads` belongs to, or why it cannot (D-361). Reading a loop (its item) or a body step puts it in that
 * body; `under` a loop asks for it. A body step reads its own loop's body, the item, and top-level steps placed BEFORE the loop
 * (the compiler emits the whole body at the loop's position). Outside a body, nothing reads a loop or its body — the box's
 * output is its `collect`.
 */
function loopPlacement(f: EFlow, reads: string[], want: string | null): { loop: string | null } | string {
  const loops = loopOfStep(f);
  if (!loops.size && !f.steps.some((s) => s.kind === "for_each")) return { loop: want };
  const of = (id: string) => (byId(f, id)?.kind === "for_each" ? id : loops.get(id));
  const set = new Set<string>(want ? [want] : []);
  for (const r of reads) { const l = of(r); if (l) set.add(l); }
  if (set.size > 1) return `it would run inside two loops (${[...set].join(", ")})`;
  const loop = set.size ? [...set][0]! : null;
  for (const r of reads) {
    const l = of(r);
    if (l && l !== loop) return `\`${r}\` runs once per item of \`${l}\` — read the loop's output`;
    if (!loop || DISABLED_PRECONDITIONS.has("placement")) continue;
    if (byId(f, r)?.kind === "collect") return `\`${r}\` is a loop's output and runs after the loop, so a step inside \`${loop}\` cannot read it`;
    if (!l && indexOf(f, r) > indexOf(f, loop)) return `\`${r}\` is placed after the loop \`${loop}\` begins, and a step inside runs where its loop is`;
  }
  return { loop };
}
/**
 * Where a NEW step reading `reads` lands: top-level, one branch's arm, and/or one loop's body. `under` asks for an arm or a body;
 * reading a guarded step puts it in that step's arm anyway (the compiler's `armOf` is the transitive `dependsOn` closure), and
 * reading an item or a body step puts it in that loop. Two arms, or two loops, is refused.
 */
export function placement(f: EFlow, reads: string[], under?: string): { arm: string | null; loop: string | null } | string {
  const u = under !== undefined ? byId(f, under) : undefined;
  if (under !== undefined && u?.kind !== "branch" && u?.kind !== "for_each") return `\`${under}\` is not a condition or a loop`;
  const armUnder = u?.kind === "branch" ? under : undefined;
  const lp = loopPlacement(f, [...reads, ...(armUnder ? [armUnder] : [])], u?.kind === "for_each" ? under! : null);
  if (typeof lp === "string") return lp;
  if (armUnder === undefined && !hasBranch(f)) return { arm: null, loop: lp.loop };
  const arms = armOfStep(f);
  const set = new Set<string>(armUnder !== undefined ? [armUnder] : []);
  for (const r of reads) { const a = arms.get(r); if (a) set.add(a); }
  if (set.size > 1) return `it would run under two conditions (${[...set].join(", ")}); a step is guarded by one`;
  const arm = set.size ? [...set][0]! : null;
  if (arm) for (const r of reads) { const bad = guardedMayRead(f, arm, r, arms); if (bad) return bad; }
  return { arm, loop: lp.loop };
}
/** May EXISTING step `sid` read `read`? `bind` never moves a step into or out of an arm or a loop (its readers would move with it). */
function readPlacement(f: EFlow, sid: string, read: string): string | null {
  const loops = loopOfStep(f);
  const lS = loops.get(sid) ?? null;
  const lR = byId(f, read)?.kind === "for_each" ? read : (loops.get(read) ?? null);
  if (lR && lR !== lS) return lS ? `\`${read}\` is inside another loop (\`${lR}\`)` : `\`${read}\` runs once per item of \`${lR}\`; a step outside the loop cannot read it — read the loop's output`;
  if (lS && !lR && !DISABLED_PRECONDITIONS.has("placement")) {
    if (byId(f, read)?.kind === "collect") return `\`${read}\` is a loop's output, which a step inside a loop cannot read`;
    if (indexOf(f, read) > indexOf(f, lS)) return `\`${read}\` is placed after the loop \`${lS}\` begins, and a step inside runs where its loop is`;
  }
  if (!hasBranch(f)) return null;
  const arms = armOfStep(f);
  const aS = arms.get(sid), aR = arms.get(read);
  if (aR && aR !== aS) return aS ? `\`${read}\` is under another condition (\`${aR}\`)` : `\`${read}\` runs only when \`${aR}\` holds; a step outside that condition cannot read it — add the step under the condition, or merge`;
  return aS ? guardedMayRead(f, aS, read, arms) : null;
}
/** A new step's dependencies: what it reads, and the branch/loop it is in (so unbinding a read never moves it out). */
const depsWith = (reads: string[], at: { arm: string | null; loop?: string | null }) => [...new Set([...reads, ...(at.arm ? [at.arm] : []), ...(at.loop && !at.arm ? [at.loop] : [])])];
/** The arm holes, exactly: one per branch that guards nothing and one per loop whose body is empty, none elsewhere. Every op ends here. */
function syncArmHoles(f: EFlow): EFlow {
  const hasLoop = f.steps.some((s) => s.kind === "for_each");
  if (!hasBranch(f) && !hasLoop && !f.holes.some((h) => h.site.at === "arm")) return f;
  const guarded = new Set([...armOfStep(f).values(), ...loopOfStep(f).values()]);
  const holder = (id: string) => { const k = byId(f, id)?.kind; return k === "branch" || k === "for_each"; };
  let g: EFlow = { ...f, holes: f.holes.filter((h) => h.site.at !== "arm" || (holder(h.site.stepId) && !guarded.has(h.site.stepId))) };
  for (const b of f.steps) {
    if ((b.kind !== "branch" && b.kind !== "for_each") || guarded.has(b.id) || holeAt(g, { at: "arm", stepId: b.id })) continue;
    g = addHole(g, { site: { at: "arm", stepId: b.id }, why: "arm", ty: null, owner: "chooser", reason: b.kind === "for_each" ? `the loop \`${b.id}\` runs nothing yet` : `the condition \`${b.id}\` guards nothing yet` }, `${b.id}_arm`);
  }
  return g;
}
/** A link's conditions, or why not: each subject a top-level list step (a transform or a chosen reader), before `before`. */
function conditionsFor(f: EFlow, cat: CatalogueSnapshot, when: When[], before: number | null): ECondition[] | string {
  if (!when.length || when.length > MAX_WHEN) return `a condition has 1 to ${MAX_WHEN} tests`;
  if (new Set(when.map((w) => w.stepId)).size !== when.length) return "a condition tests each step once";
  const arms = hasBranch(f) ? armOfStep(f) : new Map<string, string>();
  for (const w of when) {
    if (w.test !== "any" && w.test !== "none") return `\`${w.test}\` is not a test; a condition asks whether a list has rows (\`any\` or \`none\`) — filter it first`;
    const s = byId(f, w.stepId);
    if (!s || !(s.kind === "transform" || (s.kind === "datasource" && s.ref))) return `a condition tests a transform or a chosen reader; \`${w.stepId}\` is neither`;
    if (arms.has(s.id)) return `\`${s.id}\` is itself under a condition, and a condition inside a condition is not emitted`;
    if (before !== null && indexOf(f, s.id) > before) return `\`${s.id}\` is placed after the chain begins, so it has not run when the chain is decided`;
    const ty = readableTy(f, cat, s.id);
    if (typeof ty === "string") return ty;
    const inner = ty.t === "Envelope" ? ty.of : ty;
    if (inner.t !== "List" && inner.t !== "Rows") return `\`${s.id}\` produces ${render(inner)}, not a list — a condition asks whether a list has rows`;
  }
  // A condition runs where its subjects are: all in one loop's body (then it is decided per item), or all outside. A subject
  // outside a loop must be placed before it, like any read from inside.
  const lp = loopPlacement(f, when.map((w) => w.stepId), null);
  if (typeof lp === "string") return lp;
  return when.map((w) => ({ left: { stepId: w.stepId, field: "" as const }, op: w.test }));
}

// ── holes ───────────────────────────────────────────────────────────────────

const holeId = (f: EFlow, base: string) => { let id = `h_${base}`; for (let n = 2; f.holes.some((h) => h.id === id); n++) id = `h_${base}_${n}`; return id; };
const addHole = (f: EFlow, h: Omit<Hole, "id">, base: string): EFlow => ({ ...f, holes: [...f.holes, { id: holeId(f, base), ...h }] });
const dropHole = (f: EFlow, site: HoleSite): EFlow => {
  const h = holeAt(f, site);
  return h ? { ...f, holes: f.holes.filter((x) => x !== h) } : f;
};
/** A port the receiver fills with the run's requester when unset — the one a schedule turns into a hole (I-287). */
const fallsBack = (p: PortSig) => !!p.fallsBackToRequester;

/** The holes a new call step starts with: every required port, and (on a scheduled flow) every port that would fall back to the run's requester. */
function portHoles(f: EFlow, cat: CatalogueSnapshot, s: EStep): EFlow {
  let g = f;
  for (const p of portsOf(s as unknown as CheckStep, cat) ?? []) {
    const site: HoleSite = { at: "port", stepId: s.id, port: p.name };
    if (p.required) g = addHole(g, { site, why: "required", ty: p.ty, owner: "chooser", reason: `\`${s.id}\` needs \`${p.name}\` (${render(p.ty)})` }, `${s.id}_${p.name}`);
    else if (g.schedule && fallsBack(p)) g = addHole(g, { site, why: "scheduled_recipient", ty: p.ty, owner: "person", reason: `\`${s.id}\`'s \`${p.name}\` would go to whoever started the run, and a scheduled run has nobody` }, `${s.id}_${p.name}`);
  }
  return g;
}

// ── literals ─────────────────────────────────────────────────────────────────

const ADDRESS = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const RESERVED_DOMAIN = /\.(example|test|invalid|localhost)$/i;
function validDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}
/** Is `v` a value of `ty`, and one the deployment's policy admits? `null` when it is; the reason when not. */
export function literalFits(v: string, ty: Ty, cat: CatalogueSnapshot): string | null {
  if (DISABLED_PRECONDITIONS.has("literal")) return null;
  const t = ty.t === "Option" ? ty.of : ty;
  if (v === "") return "an empty value";
  if (/\{\{|\}\}/.test(v)) return "a template, which is not a value";
  switch (t.t) {
    case "Int": return /^-?\d+$/.test(v) ? null : "not a whole number";
    case "Number": return v.trim() !== "" && Number.isFinite(Number(v)) ? null : "not a number";
    case "Bool": return v === "true" || v === "false" ? null : "not true or false";
    case "Month": return /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? null : "not a month (YYYY-MM)";
    case "Date": return validDate(v) ? null : "not a date (YYYY-MM-DD)";
    case "DateTime": return v.includes("T") && !Number.isNaN(Date.parse(v)) ? null : "not a date-time";
    case "Key": return "a row's identity, which comes from the row it names — never a typed value";
    case "Address": {
      if (!ADDRESS.test(v)) return "not an email address";
      const domain = v.split("@")[1]!.toLowerCase();
      // A reserved address is captured by a draft run and refused by a live one — a flow that cannot run live is not offered.
      if (RESERVED_DOMAIN.test(domain)) return "a reserved address, which a live run refuses";
      if (cat.mailAllowedDomains?.length && !cat.mailAllowedDomains.includes(domain)) return `not on an allowed domain (${cat.mailAllowedDomains.join(", ")})`;
      return null;
    }
    case "Text":
      for (const r of t.refine ?? []) {
        if (r.r === "SingleLine" && /[\r\n]/.test(v)) return "not one line";
        if (r.r === "NonEmpty" && !v.trim()) return "blank";
        if (r.r === "MaxLen" && v.length > r.n) return `longer than ${r.n}`;
        if (r.r === "OneOf" && !r.values.includes(v)) return `not one of ${r.values.join(", ")}`;
      }
      return null;
    case "List": return "a list, which a literal cannot be";
    default: return `a ${t.t}, which a literal cannot be`;
  }
}

// ── the type a source gives a port ───────────────────────────────────────────

/** The type `src` gives port `port` of step `s`, or why it cannot be bound there. The one definition `bind` and `legalMoves` share. */
export function sourceTy(f: EFlow, cat: CatalogueSnapshot, s: EStep, port: PortSig, src: BindSource): Ty | string {
  // ⚠ WIRE FORM (I-285): a literal or a flow input reaches a call as TEXT (`render.ts` quotes both). The step executor coerces a
  // declared number (`coerceDeclaredNumbers`) and a SQL param by its type — and nothing coerces a TOOL's boolean, so `"true"`
  // would reach a receiver that validates a boolean. Refused until the executor coerces it; a row's boolean field is typed.
  const portBase = port.ty.t === "Option" ? port.ty.of : port.ty;
  if ((src.from === "literal" || src.from === "input") && s.kind === "tool" && portBase.t === "Bool") return "a tool's true/false input cannot take a literal or a flow input: both arrive as text, and nothing converts a tool's boolean (I-285)";
  if ((src.from === "literal" || src.from === "input") && port.fromStep) return `\`${port.name}\` takes a step's output, never a value someone states`;
  if (src.from === "literal") {
    if (!["goal", "catalogue", "person", "drafted"].includes(src.provenance)) return "a literal must be quoted from the goal, a catalogue default, or a person's answer";
    if (src.provenance === "drafted" && !port.message && !port.heading) return `\`${port.name}\` is not words a person reads, so it is never drafted — it is stated or asked`;
    // D-323: `catalogue` is a CLAIM about where the value came from, so it is checked against the one place that states it — the
    // port's declared default. Without this, "from the catalogue" is a label any literal could wear.
    if (src.provenance === "catalogue" && port.default !== src.value) return port.default === undefined ? `the catalogue states no value for \`${port.name}\`` : `the catalogue's value for \`${port.name}\` is \`${port.default}\`, not \`${src.value}\``;
    const bad = literalFits(src.value, port.liftsScalar && port.ty.t === "List" ? port.ty.of : port.ty, cat);
    return bad ? `\`${src.value}\` is ${bad}` : port.ty;
  }
  if (src.from === "input") {
    const i = f.inputs.find((x) => x.id === src.inputId);
    return i ? tyOfFlowInput(i) : `no flow input \`${src.inputId}\``;
  }
  const up = byId(f, src.stepId);
  if (!up) return `no step \`${src.stepId}\``;
  if (indexOf(f, src.stepId) >= indexOf(f, s.id)) return `\`${src.stepId}\` does not run before \`${s.id}\``;
  const moved = readPlacement(f, s.id, src.stepId);
  if (moved) return moved;
  if (isModelText(up, cat) && s.kind === "datasource") return `a model's text is for a person to read, never a query's input (D-34)`;
  // A call that fans out has one result PER CALL; read as a field it would be one record to the checker and many at run
  // time, so its results are read through a transform (whose input is every call's rows) and never bound directly.
  if (up.kind === "tool" && up.over) return `\`${src.stepId}\` fans out, so its results are many — read them through a transform`;
  const ty = readableTy(f, cat, src.stepId);
  if (typeof ty === "string") return ty;
  if (src.from === "text") return T.text();
  const inner = ty.t === "Envelope" ? ty.of : ty;
  const row = rowOf(ty);
  if (row.t !== "Record") return `\`${src.stepId}\` does not produce records`;
  const fty = row.fields[src.field];
  if (!fty) return `\`${src.stepId}\` has no field \`${src.field}\` (it has ${Object.keys(row.fields).join(", ")})`;
  const isRows = inner.t === "Rows" || inner.t === "List";
  const fansOver = s.kind === "tool" && s.over?.stepId === src.stepId;
  if (src.from === "field") {
    if (isRows && !fansOver) return `\`${src.stepId}\` has many rows; bind its column, or fan out over it`;
    return fty;
  }
  // column
  if (!isRows) return `\`${src.stepId}\` is one record, not rows`;
  if (fansOver) return `this step fans out over \`${src.stepId}\`: bind the row's field, not the column`;
  if (fty.t === "Option") return `\`${src.field}\` may be null, and a column of it would hold nulls`;
  return T.list(fty);
}

/** May a value of `have` fill `port`? Strict: no narrowing, no untyped JSON, no null into a bound port. */
export function fits(have: Ty, port: PortSig): string | null {
  if (DISABLED_PRECONDITIONS.has("fits")) return null;
  if (hasOpaque(have)) return `${render(have)} has no declared type`;
  if (have.t === "Option") return `${render(have)} may be null, and a bound port needs a value — filter it in a transform first`;
  const r = assignable(have, port.ty);
  if (r.ok && !r.unchecked?.length) return null;
  if (port.liftsScalar && port.ty.t === "List") { const one = assignable(have, port.ty.of); if (one.ok && !one.unchecked?.length) return null; }
  return r.ok ? `${render(have)} into ${render(port.ty)} leaves ${r.unchecked!.join(", ")} unchecked` : r.detail;
}

const toStored = (src: BindSource): { source: ESource; provenance?: EBinding["provenance"] } =>
  src.from === "input" ? { source: { from: "input", inputId: src.inputId } }
  : src.from === "text" ? { source: { from: "whole", stepId: src.stepId, transform: "text" } }
  : src.from === "literal" ? { source: { from: "literal", value: src.value }, provenance: { from: src.provenance, ...(src.quote ? { quote: src.quote } : {}) } }
  : { source: { from: "step", stepId: src.stepId, field: src.field } };

// ── pipelines ───────────────────────────────────────────────────────────────

/** Every literal VALUE in a pipeline (an object carrying `value` and `from` — the `Literal` shape). */
function literalsIn(x: unknown, out: Array<{ value: unknown; from: unknown }> = []): Array<{ value: unknown; from: unknown }> {
  if (Array.isArray(x)) x.forEach((y) => literalsIn(y, out));
  else if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    if ("value" in o && "from" in o) out.push({ value: o.value, from: o.from });
    Object.values(o).forEach((y) => literalsIn(y, out));
  }
  return out;
}
const literalValuesIn = (p: unknown) => literalsIn(p).map((l) => l.value);
/**
 * A pipeline's literals must carry a permitted provenance (the constants rule); `test` is for fixtures only.
 * ⚠ Only a LITERAL's `from` is a provenance (I-290): a `project` field's `from` names a column, and reading every `"from"` in
 * the JSON refused every projection — silently, because `legalMoves` filtered them out.
 */
function badLiteralIn(p: Pipeline): string | null {
  const bad = literalsIn(p).map((l) => String(l.from)).find((x) => !["goal", "catalogue", "person"].includes(x));
  if (bad) return `a pipeline literal marked "${bad}" — a literal is quoted from the goal, a catalogue default, or a person's answer`;
  // A literal is a VALUE, never a template: the lowering puts it inside a Pebble-rendered jq program, where `{{ }}` would be a
  // second template the engine never re-evaluates (I-11) — refused by D-22 at save, so refused here, where it is chosen.
  if (!DISABLED_PRECONDITIONS.has("literal") && literalValuesIn(p).some((v) => typeof v === "string" && /\{\{|\}\}|\{%|%\}/.test(v))) return "a pipeline literal is a template, which is not a value";
  return null;
}
/** The type a transform over `from` with `pipeline` would have, or why it cannot. */
export function transformTy(f: EFlow, cat: CatalogueSnapshot, from: string, pipeline: Pipeline): Ty | string {
  const src = byId(f, from);
  if (!src) return `no step \`${from}\``;
  if (isModelText(src, cat)) return `a model's text is for a person to read; computing on it is refused (D-34)`;
  const upTy = readableTy(f, cat, from);
  if (typeof upTy === "string") return upTy;
  const inTy = pipelineInputType(src as unknown as CheckStep, cat, asModel(f));
  if (!inTy || hasOpaque(inTy)) return `\`${from}\` gives the pipeline nothing typed to read`;
  const lit = badLiteralIn(pipeline);
  if (lit) return lit;
  const r = withContext(inputCtx(f), () => typeTransform(inTy, pipeline));
  if (!r.ok) return `stage ${r.at + 1}: ${r.error}`;
  try { withContext(inputCtx(f), () => lowerPipeline(inTy, pipeline)); } catch (e) { return (e as Error).message; }
  return r.ty;
}

/** A pipeline whose LAST count-changing stage is `limit n ≤ 1000`, producing a list of records: what a fan-out may run over. */
export function boundedList(p: Pipeline, ty: Ty): string | null {
  if (DISABLED_PRECONDITIONS.has("bounded")) return ty.t === "List" || ty.t === "Rows" ? null : `it produces ${render(ty)}, not a list`;
  if (ty.t !== "List" || ty.of.t !== "Record") return `it produces ${render(ty)}, not a list of records`;
  const last = p.map((c) => c.op).lastIndexOf("limit");
  if (last < 0) return "it has no `limit`, so nothing bounds how many calls it makes";
  const n = Number((p[last] as { n: { value: unknown } }).n.value);
  if (!(n <= MAX_FANOUT)) return `its limit ${n} is above ${MAX_FANOUT}`;
  // Every other stage keeps or shrinks the count; only `take` (a field of one record, as the new rows) can grow it.
  if (p.slice(last + 1).some((c) => c.op === "take")) return "a `take` after its `limit` can change the count";
  return null;
}

// ── apply ───────────────────────────────────────────────────────────────────

/** A call with nothing bound carries the one canonical empty params blob; a call with bindings carries none (FT0206). */
function withParams(s: EStep): EStep {
  if (s.kind !== "tool" && s.kind !== "datasource") return s;
  const { paramsExpr: _p, ...rest } = s;
  return rest.inputs.some((b) => b.source) ? (rest as EStep) : ({ ...rest, paramsExpr: "[{}]" } as EStep);
}
const replace = (f: EFlow, s: EStep): EFlow => ({ ...f, steps: f.steps.map((x) => (x.id === s.id ? withParams(s) : x)) });
/** Does every declared input have a value on a run nobody starts? (`unresolvedRequiredInputs`'s rule: required unless `false`, resolved by a default.) */
export const inputResolvable = (i: EInput) => i.required === false || i.defaults !== undefined || i.computed !== undefined;
const freshId = (f: EFlow, id: string): string | null =>
  !STEP_ID.test(id) || RESERVED.has(id) ? `\`${id}\` is not a valid step id` : f.steps.some((s) => s.id === id) ? `\`${id}\` is already a step` : f.inputs.some((i) => i.id === id) ? `\`${id}\` is already an input` : f.steps.length >= MAX_STEPS ? `a flow has at most ${MAX_STEPS} steps` : null;
const CRON_FIELD = /^(\*|\d+|\d+-\d+|\*\/\d+|\d+(,\d+)*)$/;
const CRON_RANGES: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
export function cronProblem(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "a schedule is five fields: minute hour day month weekday";
  for (const [i, p] of parts.entries()) {
    if (!CRON_FIELD.test(p)) return `field ${i + 1} (\`${p}\`) is not a cron field`;
    const nums = p.replace("*/", "").split(/[-,]/).filter((x) => x !== "*").map(Number);
    const [lo, hi] = CRON_RANGES[i]!;
    if (nums.some((n) => n < lo || n > hi) || (p.startsWith("*/") && nums[0] === 0)) return `field ${i + 1} (\`${p}\`) is out of range ${lo}–${hi}`;
  }
  return null;
}

export function apply(f: EFlow, op: EngineOp, cat: CatalogueSnapshot): Applied {
  const r = applyOp(f, op, cat);
  return r.ok ? { ok: true, flow: syncArmHoles(insideBeforeOutput(f, r.flow)) } : r;
}

/**
 * For each (phase F, F4): a step added inside a loop that already has its output goes in just BEFORE that output, never after it
 * — a step reads only steps placed before it, so a body step placed after the output could never become each row's result. It
 * reads only the loop, the loop's other steps and steps ahead of the loop, all already before the output, so the move is safe.
 */
function insideBeforeOutput(before: EFlow, g: EFlow): EFlow {
  const added = g.steps.filter((s) => !before.steps.some((x) => x.id === s.id));
  if (added.length !== 1 || !g.steps.some((s) => s.kind === "collect")) return g;
  const id = added[0]!.id, loop = loopOfStep(g).get(id), c = loop ? collectOf(g, loop) : undefined;
  if (!c || indexOf(g, id) < indexOf(g, c.id)) return g;
  const rest = g.steps.filter((s) => s.id !== id);
  const at = rest.findIndex((s) => s.id === c.id);
  return { ...g, steps: [...rest.slice(0, at), added[0]!, ...rest.slice(at)] };
}

function applyOp(f: EFlow, op: EngineOp, cat: CatalogueSnapshot): Applied {
  switch (op.op) {
    case "declare_input": {
      if (!STEP_ID.test(op.id) || RESERVED.has(op.id)) return no(`\`${op.id}\` is not a valid input id`);
      if (f.inputs.some((i) => i.id === op.id) || f.steps.some((s) => s.id === op.id)) return no(`\`${op.id}\` is already declared`);
      if (op.format && op.type !== "STRING") return no("only a STRING input has a format");
      const i: EInput = { id: op.id, type: op.type, ...(op.format ? { format: op.format } : {}), ...(op.required !== undefined ? { required: op.required } : {}) };
      if (op.computed !== undefined) {
        if (!COMPUTED_INPUTS.includes(op.computed)) return no(`\`${op.computed}\` is not a computed value`);
        if (op.defaults !== undefined) return no("an input has one answer: a default or a computed value, not both");
        i.computed = op.computed;
      }
      if (op.offsetDays !== undefined) {
        if (op.computed !== "currentDate" || !Number.isInteger(op.offsetDays) || Math.abs(op.offsetDays) > 3650) return no("a day offset is a whole number of days within ten years, on a computed currentDate only");
        i.offsetDays = op.offsetDays;
      }
      if (op.defaults !== undefined) {
        const bad = literalFits(op.defaults, tyOfFlowInput(i), cat);
        if (bad) return no(`the default \`${op.defaults}\` is ${bad}`);
        i.defaults = op.defaults;
      }
      if (f.schedule && !inputResolvable(i)) return no(`this flow runs on a schedule, so \`${op.id}\` needs a default or must be optional`);
      return { ok: true, flow: { ...f, inputs: [...f.inputs, i] } };
    }
    case "remove_input": {
      if (!f.inputs.some((i) => i.id === op.id)) return no(`no input \`${op.id}\``);
      const reads = f.steps.filter((s) => ("inputs" in s && s.inputs.some((b) => b.source?.from === "input" && b.source.inputId === op.id)) || (s.kind === "transform" && JSON.stringify(s.pipeline).includes(`"input":"${op.id}"`)));
      if (reads.length) return no(`\`${op.id}\` is read by ${reads.map((s) => s.id).join(", ")}`);
      return { ok: true, flow: { ...f, inputs: f.inputs.filter((i) => i.id !== op.id) } };
    }
    case "retype_input": {
      const cur = f.inputs.find((i) => i.id === op.id);
      if (!cur) return no(`no input \`${op.id}\``);
      if (cur.computed !== undefined) return no(`\`${op.id}\` is computed when the flow runs; its type is its computation's`);
      if (op.format && op.type !== "STRING") return no("only a STRING input has a format");
      if (cur.type === op.type && (cur.format ?? undefined) === (op.format ?? undefined)) return no(`\`${op.id}\` is already asked that way`);
      const { format: _f, defaults: _d, ...rest } = cur;
      const i: EInput = { ...rest, type: op.type, ...(op.format ? { format: op.format } : {}) };
      // A default of the old type is not one of the new: kept only when it still fits.
      if (cur.defaults !== undefined && !literalFits(cur.defaults, tyOfFlowInput(i), cat)) {
        if (f.schedule && !inputResolvable(i)) return no(`this flow runs on a schedule, and \`${op.id}\`'s default \`${cur.defaults}\` is not ${render(tyOfFlowInput(i))}`);
      } else if (cur.defaults !== undefined) i.defaults = cur.defaults;
      const next: EFlow = { ...f, inputs: f.inputs.map((x) => (x.id === op.id ? i : x)) };
      // Every step that reads it is re-judged by the rule a binding is made by — the same input can stop fitting where it is read.
      for (const st of next.steps) {
        if (st.kind !== "tool" && st.kind !== "datasource") continue;
        for (const b of st.inputs) {
          if (b.source?.from !== "input" || b.source.inputId !== op.id) continue;
          const port = portsOf(st as unknown as CheckStep, cat)?.find((p) => p.name === b.name);
          if (!port) continue;
          const have = sourceTy(next, cat, st, port, { from: "input", inputId: op.id });
          const misfit = typeof have === "string" ? have : fits(have, port);
          if (misfit) return no(`\`${st.id}\`'s \`${b.name}\` reads \`${op.id}\`, and as ${render(tyOfFlowInput(i))} it does not fit: ${misfit}`);
        }
      }
      // …and anything else that reads it (a filter comparing with it): no new error may appear.
      const before = new Set(errorsOf(checkState(f, cat)).map((d) => d.message));
      const added = errorsOf(checkState(next, cat)).find((d) => !before.has(d.message));
      if (added) return no(`as ${render(tyOfFlowInput(i))}, \`${op.id}\` breaks the flow: ${added.message}`);
      return { ok: true, flow: next };
    }
    case "add_reader": {
      const bad = freshId(f, op.id);
      if (bad) return no(bad);
      if (op.ref !== undefined) {
        const r = cat.refs[op.ref];
        if (!r || (r.kind !== "query" && r.kind !== "operation")) return no(`\`${op.ref}\` is not a reader in this workspace`);
        if (hasOpaque(r.payload)) return no(`\`${op.ref}\`'s rows have no declared type — describe it first`);
      }
      const at = placement(f, [], op.under);
      if (typeof at === "string") return no(at);
      const s: EStep = { id: op.id, kind: "datasource", ...(op.ref ? { ref: op.ref } : {}), inputs: [], dependsOn: depsWith([], at), paramsExpr: "[{}]" };
      let g: EFlow = { ...f, steps: [...f.steps, s] };
      g = op.ref ? portHoles(g, cat, s) : addHole(g, { site: { at: "reader", stepId: op.id }, why: "reader", ty: null, owner: "chooser", reason: `which data \`${op.id}\` reads is not chosen` }, `${op.id}_reader`);
      return { ok: true, flow: g };
    }
    case "choose_reader": {
      const s = byId(f, op.stepId);
      if (!s || s.kind !== "datasource" || s.ref) return no(`\`${op.stepId}\` is not a reader waiting for a component`);
      const r = cat.refs[op.ref];
      if (!r || (r.kind !== "query" && r.kind !== "operation")) return no(`\`${op.ref}\` is not a reader in this workspace`);
      if (hasOpaque(r.payload)) return no(`\`${op.ref}\`'s rows have no declared type — describe it first`);
      const next: EStep = { ...s, ref: op.ref };
      return { ok: true, flow: portHoles(dropHole(replace(f, next), { at: "reader", stepId: s.id }), cat, next) };
    }
    case "add_transform": {
      const bad = freshId(f, op.id);
      if (bad) return no(bad);
      const ty = transformTy(f, cat, op.from, op.pipeline);
      if (typeof ty === "string") return no(ty);
      const at = placement(f, [op.from], op.under);
      if (typeof at === "string") return no(at);
      const step: EStep = { id: op.id, kind: "transform", from: op.from, pipeline: op.pipeline, expr: "", dependsOn: depsWith([op.from], at) };
      if (op.before === undefined) return { ok: true, flow: { ...f, steps: [...f.steps, step] } };
      // Ahead of a step IN THE SAME PLACE — the same condition arm and the same loop body (top level being one such place), reading
      // only what runs before it — so nothing about what depends on what changes, only when it runs. Phase F: inside a loop this is
      // how an else-if's test runs ahead of its chain there, exactly as at the top level (D-382).
      const i = indexOf(f, op.before);
      if (i < 0) return no(`no step \`${op.before}\``);
      const armB = (hasBranch(f) ? armOfStep(f) : new Map<string, string>()).get(op.before) ?? null, loopB = loopOfStep(f).get(op.before) ?? null;
      if (at.arm !== armB || at.loop !== loopB) return no(`\`${op.before}\` runs ${loopB ? `inside the loop \`${loopB}\`` : "outside any loop"}${armB ? ` under \`${armB}\`` : ""}, and this step would not — a step is placed ahead of another in the same place`);
      if (indexOf(f, op.from) > i) return no(`\`${op.from}\` runs after \`${op.before}\`, so a step reading it cannot run ahead of \`${op.before}\``);
      return { ok: true, flow: { ...f, steps: [...f.steps.slice(0, i), step, ...f.steps.slice(i)] } };
    }
    case "append_stage": {
      const s = byId(f, op.stepId);
      if (!s || s.kind !== "transform") return no(`\`${op.stepId}\` is not a transform`);
      const readers = readersOf(f, s.id);
      if (readers.length) return no(`\`${s.id}\` is read by ${readers.join(", ")}; change it before anything reads it`);
      const pipeline = [...s.pipeline, op.stage];
      const ty = transformTy(f, cat, s.from, pipeline);
      if (typeof ty === "string") return no(ty);
      return { ok: true, flow: replace(f, { ...s, pipeline }) };
    }
    case "retest": {
      const s = byId(f, op.stepId);
      if (!s || s.kind !== "transform") return no(`\`${op.stepId}\` is not a transform`);
      const at = op.stage ?? s.pipeline.length - 1;
      const last = s.pipeline[at];
      if (!last || (last.op !== "filter" && last.op !== "keep_if")) return no(op.stage === undefined ? `\`${s.id}\` does not end in a test (a filter or a keep-if)` : `stage ${at + 1} of \`${s.id}\` is not a test (a filter or a keep-if)`);
      if (JSON.stringify(last.where) === JSON.stringify(op.where)) return no("that is already the test");
      const before = transformTy(f, cat, s.from, s.pipeline);
      const pipeline = s.pipeline.map((c, i) => (i === at ? { ...last, where: op.where } : c));
      const ty = transformTy(f, cat, s.from, pipeline);
      if (typeof ty === "string") return no(ty);
      if (typeof before !== "string" && JSON.stringify(before) !== JSON.stringify(ty)) return no(`the new test changes what \`${s.id}\` produces`);
      return { ok: true, flow: replace(f, { ...s, pipeline }) };
    }
    case "add_call": {
      const bad = freshId(f, op.id);
      if (bad) return no(bad);
      const r = cat.refs[op.ref];
      if (!r || r.kind !== "tool") return no(`\`${op.ref}\` is not a tool in this workspace`);
      const at = placement(f, op.over !== undefined ? [op.over] : [], op.under);
      if (typeof at === "string") return no(at);
      const s: EStep = { id: op.id, kind: "tool", ref: op.ref, inputs: [], dependsOn: depsWith([], at), paramsExpr: "[{}]" };
      if (op.over !== undefined) {
        const src = byId(f, op.over);
        if (!src || src.kind !== "transform") return no(`a call fans out over a transform's bounded list; \`${op.over}\` is not a transform`);
        const ty = readableTy(f, cat, op.over);
        if (typeof ty === "string") return no(ty);
        const unbounded = boundedList(src.pipeline, ty);
        if (unbounded) return no(`\`${op.over}\` cannot be fanned out over: ${unbounded}`);
        s.over = { stepId: op.over, field: "" };
        s.dependsOn = depsWith([op.over], at);
        if (!op.row) return no(`a fan-out names its first binding from \`${op.over}\`'s rows (a fan-out that binds nothing from them is one call)`);
        const g = portHoles({ ...f, steps: [...f.steps, s] }, cat, s);
        const bound = apply(g, { op: "bind", stepId: s.id, port: op.row.port, source: { from: "field", stepId: op.over, field: op.row.field } }, cat);
        return bound.ok ? bound : no(`the first row binding does not fit: ${bound.error}`);
      }
      if (op.row) return no("`row` is for a fan-out");
      return { ok: true, flow: portHoles({ ...f, steps: [...f.steps, s] }, cat, s) };
    }
    case "bind": {
      const s = byId(f, op.stepId);
      if (!s || (s.kind !== "tool" && s.kind !== "datasource")) return no(`\`${op.stepId}\` takes no inputs`);
      if (s.kind === "datasource" && !s.ref) return no(`choose \`${s.id}\`'s component first`);
      const port = portsOf(s as unknown as CheckStep, cat)?.find((p) => p.name === op.port);
      if (!port) return no(`\`${s.ref}\` has no input \`${op.port}\``);
      if (s.inputs.some((b) => b.name === op.port && b.source)) return no(`\`${op.port}\` is already bound — unbind it first`);
      const have = sourceTy(f, cat, s, port, op.source);
      if (typeof have === "string") return no(have);
      const misfit = fits(have, port);
      if (misfit) return no(misfit);
      const stored = toStored(op.source);
      const binding: EBinding = { name: op.port, ...stored };
      const upstream = "stepId" in op.source ? op.source.stepId : null;
      // ⚠ The compiler renders ONE jq program per call (E3.1): a fan-out reads only the rows it fans out over, and any other
      // call reads at most one upstream step. Anything else has no rendering, so it is not a binding the engine offers.
      if (upstream) {
        const over = s.kind === "tool" ? s.over?.stepId : undefined;
        if (over && upstream !== over) return no(`\`${s.id}\` fans out over \`${over}\`, so it reads only that step's rows — put \`${upstream}\`'s value into \`${over}\` in a transform`);
        const others = new Set(s.inputs.flatMap((b) => (b.source && "stepId" in b.source ? [b.source.stepId] : [])));
        if (!over && others.size && !others.has(upstream)) return no(`\`${s.id}\` already reads \`${[...others][0]}\`; one call reads one upstream step — combine them in a transform first`);
      }
      const next: EStep = { ...s, inputs: [...s.inputs.filter((b) => b.name !== op.port), binding], dependsOn: upstream && !s.dependsOn.includes(upstream) ? [...s.dependsOn, upstream] : s.dependsOn };
      let g = dropHole(replace(f, next), { at: "port", stepId: s.id, port: op.port });
      // The renderer is the one definition of "these bindings render"; where the catalogue carries it, it has the last word.
      if (cat.renderInputs) {
        const steps = g.steps as unknown as CheckStep[];
        if (cat.renderInputs(steps.find((x) => x.id === s.id)!, steps) === null) return no(`these bindings of \`${s.id}\` do not render to one call`);
      }
      // A port that NEEDS another is never filled with its partner left empty — a file's format with no rows
      // attaches nothing (2026-10-03: "send it as a csv" set the format, and the email went with no file). One call reads ONE upstream
      // step (above), so the partner's only source is that step, whole; a call reading none gets the partner as an open hole, asked
      // — never a value nobody connected. Every path that binds (the builder, the chat editor, the canvas) passes here.
      const needs = (port as { needs?: string }).needs;
      if (needs && !next.inputs.some((b) => b.name === needs && b.source)) {
        const reads = [...new Set(next.inputs.flatMap((b) => (b.source && "stepId" in b.source ? [b.source.stepId] : [])))];
        const via = s.kind === "tool" && !s.over && reads.length === 1 ? apply(g, { op: "bind", stepId: s.id, port: needs, source: { from: "text", stepId: reads[0]! } }, cat) : null;
        if (via?.ok) g = via.flow;
        else {
          const partner = portsOf(s as unknown as CheckStep, cat)?.find((p) => p.name === needs);
          if (partner && !holeAt(g, { at: "port", stepId: s.id, port: needs })) g = addHole(g, { site: { at: "port", stepId: s.id, port: needs }, why: "required", ty: partner.ty, owner: "chooser", reason: `\`${s.id}\`'s \`${op.port}\` needs \`${needs}\` — which data goes in it` }, `${s.id}_${needs}`);
        }
      }
      return { ok: true, flow: g };
    }
    case "unbind": {
      const s = byId(f, op.stepId);
      if (!s || (s.kind !== "tool" && s.kind !== "datasource")) return no(`\`${op.stepId}\` takes no inputs`);
      const b = s.inputs.find((x) => x.name === op.port && x.source);
      if (!b) return no(`\`${op.port}\` is not bound`);
      if (s.kind === "tool" && s.over && b.source?.from === "step" && s.inputs.filter((x) => x.source?.from === "step").length === 1)
        return no(`\`${op.port}\` is \`${s.id}\`'s last binding from the rows it fans out over; a fan-out with none is one call`);
      const port = portsOf(s as unknown as CheckStep, cat)?.find((p) => p.name === op.port);
      const upstream = b.source && "stepId" in b.source ? b.source.stepId : null;
      const stillReads = upstream && (s.inputs.some((x) => x !== b && x.source && "stepId" in x.source && x.source.stepId === upstream) || (s.kind === "tool" && s.over?.stepId === upstream));
      let g = replace(f, { ...s, inputs: s.inputs.filter((x) => x !== b), dependsOn: upstream && !stillReads ? s.dependsOn.filter((d) => d !== upstream) : s.dependsOn });
      if (port?.required) g = addHole(g, { site: { at: "port", stepId: s.id, port: op.port }, why: "required", ty: port.ty, owner: op.owner ?? "chooser", reason: `\`${s.id}\` needs \`${op.port}\` (${render(port.ty)})` }, `${s.id}_${op.port}`);
      else if (port && g.schedule && fallsBack(port)) g = addHole(g, { site: { at: "port", stepId: s.id, port: op.port }, why: "scheduled_recipient", ty: port.ty, owner: "person", reason: `\`${s.id}\`'s \`${op.port}\` would go to whoever started the run, and a scheduled run has nobody` }, `${s.id}_${op.port}`);
      return { ok: true, flow: g };
    }
    case "add_gate": {
      const bad = freshId(f, op.id);
      if (bad) return no(bad);
      const target = byId(f, op.before);
      // Before a call, or before a LOOP (2026-10-01): one approval for every item it will send — the place this op's own refusal of a
      // gate inside a loop has always pointed to, and which it did not admit.
      if (!target || (target.kind !== "tool" && target.kind !== "for_each")) return no("a gate stands before a call or a loop");
      // builder-behaviour P5: an approval INSIDE a loop is refused again. Kestra v1.3.29 resumes an execution's FIRST paused task — its resume takes no taskrun id (measured 2026-10-04, phase-5 probe: item 1's rejection landed on item 0) — so one item's decision cannot be delivered to
      // that item; a person's rejection would act on another. One approval before the loop, until a per-item delivery is measured.
      if (loopOfStep(f).has(target.id)) return no(`\`${target.id}\` runs once per item of \`${loopOfStep(f).get(target.id)}\`; an approval inside a loop cannot be delivered to its own item — put the approval before the loop`);
      if (target.dependsOn.some((d) => byId(f, d)?.kind === "approval")) return no(`\`${op.before}\` already has a gate`);
      if (!op.summary.trim() || /[\r\n]/.test(op.summary) || /\{\{/.test(op.summary)) return no("a gate's question is one line of plain text");
      const at = indexOf(f, op.before);
      const gate: EStep = { id: op.id, kind: "approval", summary: op.summary, dependsOn: [...target.dependsOn] };
      // Spliced, never appended: the gate is emitted BEFORE its target and the target waits on it (Kestra runs in order).
      const steps = [...f.steps.slice(0, at), gate, { ...target, dependsOn: [...target.dependsOn, op.id] }, ...f.steps.slice(at + 1)];
      return { ok: true, flow: { ...f, steps } };
    }
    case "set_output": {
      if (f.output) return no("a result is already declared");
      const inLoop = loopOfStep(f).get(op.stepId) ?? (byId(f, op.stepId)?.kind === "for_each" ? op.stepId : undefined);
      if (inLoop) return no(`\`${op.stepId}\` runs once per item of \`${inLoop}\` — the flow's result is the loop's output, or a step after it`);
      const guard = hasBranch(f) ? armOfStep(f).get(op.stepId) : undefined;
      if (guard) return no(`\`${op.stepId}\` runs only when \`${guard}\` holds, so some runs would have no result — merge it first`);
      const ty = readableTy(f, cat, op.stepId);
      if (typeof ty === "string") return no(ty);
      return { ok: true, flow: dropHole({ ...f, output: { stepId: op.stepId } }, { at: "output" }) };
    }
    case "set_schedule": {
      if (op.cron === null) {
        if (!f.schedule) return no("no schedule is set");
        const { schedule: _drop, ...rest } = f;
        return { ok: true, flow: { ...rest, holes: f.holes.filter((h) => h.why !== "scheduled_recipient") } };
      }
      const bad = cronProblem(op.cron);
      if (bad) return no(bad);
      const unresolved = f.inputs.filter((i) => !inputResolvable(i));
      if (unresolved.length) return no(`a scheduled run has nobody to supply ${unresolved.map((i) => `\`${i.id}\``).join(", ")} — give each a default or make it optional first`);
      let g: EFlow = { ...f, schedule: { cron: op.cron.trim() } };
      for (const s of g.steps) {
        if (s.kind !== "tool") continue;
        for (const p of portsOf(s as unknown as CheckStep, cat) ?? []) {
          const site: HoleSite = { at: "port", stepId: s.id, port: p.name };
          if (!p.required && fallsBack(p) && !s.inputs.some((b) => b.name === p.name && b.source) && !holeAt(g, site))
            g = addHole(g, { site, why: "scheduled_recipient", ty: p.ty, owner: "person", reason: `\`${s.id}\`'s \`${p.name}\` would go to whoever started the run, and a scheduled run has nobody` }, `${s.id}_${p.name}`);
        }
      }
      return { ok: true, flow: g };
    }
    case "remove_step": {
      const s = byId(f, op.stepId);
      if (!s) return no(`no step \`${op.stepId}\``);
      // A gate is read only by its target's dependency on it; removing it unsplices.
      // A gate produces nothing, so its only reader is its target's dependency on it; removing it unsplices.
      const readers = s.kind === "approval" ? [] : readersOf(f, s.id);
      if (readers.length) return no(`\`${s.id}\` is read by ${readers.join(", ")} — remove or rebind those first`);
      const steps = f.steps.filter((x) => x.id !== s.id).map((x) => (x.dependsOn.includes(s.id) ? { ...x, dependsOn: x.dependsOn.filter((d) => d !== s.id) } : x));
      return { ok: true, flow: { ...f, steps, holes: f.holes.filter((h) => h.site.at === "output" || h.site.stepId !== s.id) } };
    }
    case "add_branch": {
      const bad = freshId(f, op.id);
      if (bad) return no(bad);
      const conditions = conditionsFor(f, cat, op.when, null);
      if (typeof conditions === "string") return no(conditions);
      return { ok: true, flow: { ...f, steps: [...f.steps, { id: op.id, kind: "branch", conditions, dependsOn: op.when.map((w) => w.stepId) }] } };
    }
    case "add_otherwise": {
      const bad = freshId(f, op.id);
      if (bad) return no(bad);
      const of = byId(f, op.of);
      if (!of || of.kind !== "branch") return no(`\`${op.of}\` is not a condition`);
      if (!of.conditions?.length) return no(`\`${op.of}\` is an otherwise, and nothing continues one — there is nothing left to be false`);
      if (f.steps.some((s) => s.kind === "branch" && s.elseOf === of.id)) return no(`\`${op.of}\` is already continued`);
      let conditions: ECondition[] | undefined;
      if (op.when) {
        const c = conditionsFor(f, cat, op.when, indexOf(f, chainHead(f, of.id)));
        if (typeof c === "string") return no(c);
        const loops = loopOfStep(f);
        const headLoop = loops.get(chainHead(f, of.id)) ?? null;
        for (const w of op.when) { const l = loops.get(w.stepId) ?? (byId(f, w.stepId)?.kind === "for_each" ? w.stepId : null); if (l && l !== headLoop) return no(`\`${w.stepId}\` runs once per item of \`${l}\`, and this condition does not`); }
        conditions = c;
      }
      // ⚠ A continuation depends on NOTHING — not even the step its condition tests (the compiler refuses one that does: `armOf`
      // is transitive, so a dependency would put it inside an arm it is the alternative to). Its subject is read through
      // `conditions`, which `readersOf` counts, and is placed before the chain's head, so it has run when the chain is decided.
      return { ok: true, flow: { ...f, steps: [...f.steps, { id: op.id, kind: "branch", elseOf: of.id, ...(conditions ? { conditions } : {}), dependsOn: [] }] } };
    }
    case "add_merge": {
      const bad = freshId(f, op.id);
      if (bad) return no(bad);
      const src = op.sources;
      if (src.length < 2 || src.length > MAX_MERGE) return no(`a merge combines 2 to ${MAX_MERGE} steps`);
      if (new Set(src).size !== src.length) return no("a merge names each source once");
      const arms = armOfStep(f);
      let first: string | undefined;
      for (const id of src) {
        const s = byId(f, id);
        if (!s || s.kind !== "transform") return no(`a merge combines transforms; \`${id}\` is not one`);
        const ty = readableTy(f, cat, id);
        if (typeof ty === "string") return no(ty);
        const key = JSON.stringify(ty);
        if (first !== undefined && key !== first) return no(`the sources produce different types (${render(JSON.parse(first) as Ty)} vs ${render(ty)})`);
        first = key;
      }
      const top = src.filter((id) => !arms.has(id));
      if (top.length > 1) return no(`\`${top.join("`, `")}\` all always run, so only the first could ever win`);
      if (top.length && src.at(-1) !== top[0]) return no(`\`${top[0]}\` always runs, so it can only be the LAST source — the fallback — or it shadows the rest`);
      const links = src.filter((id) => arms.has(id)).map((id) => arms.get(id)!);
      if (new Set(links).size !== links.length) return no("two sources run under the same condition, so the second never wins");
      const heads = new Set(links.map((b) => chainHead(f, b)));
      if (heads.size !== 1) return no("a merge joins the arms of ONE condition");
      if (!top.length) {
        const chain = chainOf(f, [...heads][0]!);
        const last = byId(f, chain.at(-1)!) as EStep & { kind: "branch" };
        if (last.conditions?.length) return no(`on a run where no condition of \`${chain[0]}\` holds, nothing here runs — add an otherwise, or end with a step outside the condition`);
        const missing = chain.find((b) => !links.includes(b));
        if (missing) return no(`on a run where \`${missing}\`'s arm runs, no source here runs`);
      }
      const lp = loopPlacement(f, src, null);
      if (typeof lp === "string") return no(lp);
      return { ok: true, flow: { ...f, steps: [...f.steps, { id: op.id, kind: "merge", sources: src, dependsOn: [...src] }] } };
    }
    case "add_loop": {
      const bad = freshId(f, op.id);
      if (bad) return no(bad);
      const src = byId(f, op.over);
      if (!src || src.kind !== "transform") return no(`a loop runs over a transform's bounded list; \`${op.over}\` is not a transform`);
      if ((hasBranch(f) && armOfStep(f).has(src.id)) || loopOfStep(f).has(src.id)) return no(`\`${src.id}\` is under a condition or inside a loop; a loop runs over a top-level list — a loop inside a loop is not emitted`);
      const ty = readableTy(f, cat, op.over);
      if (typeof ty === "string") return no(ty);
      const unbounded = boundedList(src.pipeline, ty);
      if (unbounded) return no(`\`${op.over}\` cannot be looped over: ${unbounded}`);
      const settings = loopSettings(op.concurrency ?? DEFAULT_CONCURRENCY, op.onError ?? "continue");
      if (typeof settings === "string") return no(settings);
      const step: EStep = { id: op.id, kind: "for_each", over: { stepId: op.over, field: "" }, ...settings, dependsOn: [op.over] };
      return { ok: true, flow: { ...f, steps: [...f.steps, step] } };
    }
    case "set_loop": {
      const s = byId(f, op.stepId);
      if (!s || s.kind !== "for_each") return no(`\`${op.stepId}\` is not a loop`);
      const settings = loopSettings(op.concurrency ?? s.concurrency, op.onError ?? s.onError);
      if (typeof settings === "string") return no(settings);
      if (settings.concurrency === s.concurrency && settings.onError === s.onError) return no("those are already its settings");
      return { ok: true, flow: { ...f, steps: f.steps.map((x) => (x.id === s.id ? { ...s, ...settings } : x)) } };
    }
    case "close_loop": {
      const bad = freshId(f, op.id);
      if (bad) return no(bad);
      const l = byId(f, op.loop);
      if (!l || l.kind !== "for_each") return no(`\`${op.loop}\` is not a loop`);
      if (collectOf(f, l.id)) return no(`\`${l.id}\` already has an output`);
      const why = loopResultProblem(f, cat, l.id, op.result);
      if (why) return no(why);
      return { ok: true, flow: { ...f, steps: [...f.steps, { id: op.id, kind: "collect", loop: l.id, result: op.result, dependsOn: [op.result] }] } };
    }
    case "set_loop_result": {
      const c = byId(f, op.stepId);
      if (!c || c.kind !== "collect") return no(`\`${op.stepId}\` is not a loop's output`);
      if (c.result === op.result) return no("that is already its result");
      const why = loopResultProblem(f, cat, c.loop, op.result);
      if (why) return no(why);
      const next: EFlow = { ...f, steps: f.steps.map((x) => (x.id === c.id ? { ...c, result: op.result, dependsOn: [op.result] } : x)) };
      if (readersOf(f, c.id).length && JSON.stringify(readableTy(f, cat, c.id)) !== JSON.stringify(readableTy(next, cat, c.id))) return no(`\`${c.id}\` is read by ${readersOf(f, c.id).join(", ")}, and this result changes what it gives them`);
      // The result must still be placed before its collect (a step reads only steps before it).
      if (indexOf(f, op.result) > indexOf(f, c.id)) return no(`\`${op.result}\` is placed after the loop's output`);
      return { ok: true, flow: next };
    }
  }
}

/** A loop's settings, or why not. */
function loopSettings(concurrency: number, onError: string): { concurrency: number; onError: "continue" | "stop" } | string {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) return `a loop runs 1 to ${MAX_CONCURRENCY} items at once`;
  if (onError !== "continue" && onError !== "stop") return "when an item fails, a loop keeps going or stops the run";
  return { concurrency, onError };
}
/**
 * May `result` be loop `loop`'s result? A body step that runs for EVERY item (never under a condition inside — merge it
 * first) and produces something readable; and the item's own fields must not collide with the ones the output adds.
 */
function loopResultProblem(f: EFlow, cat: CatalogueSnapshot, loop: string, result: string): string | null {
  if (loopOfStep(f).get(result) !== loop) return `\`${result}\` is not a step inside \`${loop}\``;
  const guard = hasBranch(f) ? armOfStep(f).get(result) : undefined;
  if (guard) return `\`${result}\` runs only for items where \`${guard}\` holds — merge the paths first, or pick a step that runs for every item`;
  const ty = readableTy(f, cat, result);
  if (typeof ty === "string") return ty;
  const item = readableTy(f, cat, loop);
  if (typeof item === "string") return item;
  const row = rowOf(item);
  if (row.t !== "Record") return `\`${loop}\`'s items are not records`;
  const clash = COLLECT_FIELDS.find((k) => k in row.fields);
  if (clash) return `the items already have a field \`${clash}\`, which the loop's output adds (its \`ff_\` fields are Foundry's) — rename it in \`${(byId(f, loop) as EStep & { kind: "for_each" }).over.stepId}\` first`;
  return null;
}
