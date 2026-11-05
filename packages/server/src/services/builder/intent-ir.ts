/**
 * Intent IR — durable decisions for Strategy B (BUILDER_INTENT_IR).
 *
 * The conversation's memory is pinned nodes, not restated goal words. A patch
 * merges into the prior IR; nodes with `pinned: true` are never overwritten by a
 * re-plan sample. Domain-agnostic: only catalogue refs / quotes / structure.
 */
import type { GoalSpec } from "./goal-spec.js";

export type IntentNodeKind =
  | "source"
  | "sink"
  | "condition"
  | "schedule"
  | "value"
  | "summary"
  | "joining"
  | "gap";

export interface IntentNode {
  id: string;
  kind: IntentNodeKind;
  /** Catalogue ref or structural payload (JSON-serialisable). */
  payload: unknown;
  quote?: string;
  pinned: boolean;
}

export interface IntentIR {
  goal: string;
  nodes: IntentNode[];
  /** Accepted gaps (content keys) — never re-asked. */
  acceptedGaps: string[];
  version: number;
}

/** Default ON after ship gate (2026-10-07). Opt out with `BUILDER_INTENT_IR=0`. */
export function intentIrEnabled(): boolean {
  const v = (process.env.BUILDER_INTENT_IR ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off") return false;
  return true;
}

/** Stable id for a GoalSpec slot — position + kind, not volatile model wording. */
export function nodeId(kind: IntentNodeKind, index: number): string {
  return `${kind}:${index}`;
}

/** Lower a GoalSpec into an Intent IR (unpinned unless `pinAll`). */
export function irFromSpec(goal: string, spec: GoalSpec, opts: { pinAll?: boolean; acceptedGaps?: string[] } = {}): IntentIR {
  const pin = !!opts.pinAll;
  const nodes: IntentNode[] = [];
  (spec.sources ?? []).forEach((s, i) => nodes.push({ id: nodeId("source", i), kind: "source", payload: s, quote: s.quote, pinned: pin }));
  (spec.sinks ?? []).forEach((s, i) => nodes.push({ id: nodeId("sink", i), kind: "sink", payload: s, quote: s.quote, pinned: pin }));
  (spec.conditions ?? []).forEach((c, i) => nodes.push({ id: nodeId("condition", i), kind: "condition", payload: c, quote: (c as { quote?: string }).quote, pinned: pin }));
  (spec.values ?? []).forEach((v, i) => nodes.push({ id: nodeId("value", i), kind: "value", payload: v, quote: (v as { quote?: string }).quote, pinned: pin }));
  if (spec.summary) nodes.push({ id: nodeId("summary", 0), kind: "summary", payload: spec.summary, quote: spec.summary.quote, pinned: pin });
  if (spec.joining?.length) nodes.push({ id: nodeId("joining", 0), kind: "joining", payload: spec.joining, pinned: pin });
  if (spec.schedule) nodes.push({ id: nodeId("schedule", 0), kind: "schedule", payload: spec.schedule, quote: spec.schedule.quote, pinned: pin });
  return { goal, nodes, acceptedGaps: [...(opts.acceptedGaps ?? [])], version: 1 };
}

/** Raise IR back to a GoalSpec (for solver / checkSpec). */
export function specFromIr(ir: IntentIR): GoalSpec {
  const by = (k: IntentNodeKind) => ir.nodes.filter((n) => n.kind === k).sort((a, b) => a.id.localeCompare(b.id));
  const sources = by("source").map((n) => n.payload) as GoalSpec["sources"];
  const sinks = by("sink").map((n) => n.payload) as GoalSpec["sinks"];
  const conditions = by("condition").map((n) => n.payload) as NonNullable<GoalSpec["conditions"]>;
  const values = by("value").map((n) => n.payload) as NonNullable<GoalSpec["values"]>;
  const summary = by("summary")[0]?.payload as GoalSpec["summary"];
  const joining = by("joining")[0]?.payload as GoalSpec["joining"];
  const schedule = (by("schedule")[0]?.payload as GoalSpec["schedule"]) ?? null;
  return {
    sources: sources ?? [],
    sinks: sinks ?? [],
    values: values ?? [],
    conditions: conditions ?? [],
    schedule,
    missing: null,
    ...(summary ? { summary } : {}),
    ...(joining ? { joining } : {}),
  };
}

/**
 * Merge a proposed IR into the prior one. Pinned prior nodes win always.
 * Unpinned prior nodes are replaced by proposal when present; new proposal
 * nodes are added. `touchIds` marks which prior pins may be overwritten
 * (the answer's holes) — they are unpinned then replaced.
 */
export function mergeIntent(prev: IntentIR, proposal: IntentIR, touchIds: string[] = []): { ir: IntentIR; restored: string[] } {
  const touch = new Set(touchIds);
  const restored: string[] = [];
  const map = new Map<string, IntentNode>();
  for (const n of prev.nodes) map.set(n.id, { ...n });
  for (const n of proposal.nodes) {
    const prior = map.get(n.id);
    if (prior?.pinned && !touch.has(n.id)) {
      if (JSON.stringify(prior.payload) !== JSON.stringify(n.payload)) restored.push(n.id);
      continue;
    }
    map.set(n.id, {
      ...n,
      pinned: prior?.pinned && !touch.has(n.id) ? true : n.pinned,
    });
  }
  const acceptedGaps = [...new Set([...prev.acceptedGaps, ...proposal.acceptedGaps])];
  return {
    ir: { goal: proposal.goal || prev.goal, nodes: [...map.values()], acceptedGaps, version: prev.version + 1 },
    restored,
  };
}
/**
 * Render pinned decisions as compact working memory (S7). One line per pinned
 * node — id, kind, the catalogue ref it settled, its quote — plus accepted
 * gaps. Unpinned nodes are proposals, not memory: never rendered. Empty when
 * nothing is pinned, so a first build sends no memory block at all.
 */
export function irToMemory(ir: IntentIR): string {
  const lines = ir.nodes
    .filter((n) => n.pinned)
    .map((n) => {
      const ref = typeof n.payload === "object" && n.payload !== null && "ref" in n.payload ? String((n.payload as { ref: unknown }).ref) : JSON.stringify(n.payload);
      return `[${n.id}] ${n.kind} ${ref}${n.quote ? ` — "${n.quote}"` : ""}`;
    });
  for (const g of ir.acceptedGaps) lines.push(`[accepted] ${g}`);
  return lines.join("\n");
}

/** Pin every node (e.g. after confirm / accept-with-gaps). */
export function pinAll(ir: IntentIR): IntentIR {
  return { ...ir, nodes: ir.nodes.map((n) => ({ ...n, pinned: true })), version: ir.version + 1 };
}

/** Accept gaps — append keys and pin current nodes. */
export function acceptGaps(ir: IntentIR, keys: string[]): IntentIR {
  return pinAll({ ...ir, acceptedGaps: [...new Set([...ir.acceptedGaps, ...keys])] });
}

/**
 * Which prior IR nodes a correction's words touch — so a pin freezes everything ELSE.
 * Without this, Intent IR's empty touch set made every correction a full structural freeze:
 * the plan could not revise the summary/reader the person was correcting, and the write loop
 * never saw a changed contract (stale SQL + false unmet on already-built clauses).
 */
export function touchIdsFromAnswer(prev: GoalSpec, answerWords: string, goal: string): string[] {
  const low = answerWords.toLowerCase();
  // Words (≥3 letters) and numbers (incl. decimals like 4.75) — splitting on `\W` would drop "4.75" to "4"/"75".
  const ws = [...new Set([...(low.match(/[a-z][a-z0-9]{2,}/g) ?? []), ...(low.match(/\d+(?:\.\d+)?/g) ?? [])])];
  if (!ws.length) return [];
  const touches = (s: unknown) => {
    const x = (typeof s === "string" ? s : JSON.stringify(s ?? "")).toLowerCase();
    return ws.some((w) => x.includes(w));
  };
  return irFromSpec(goal, prev, { pinAll: true }).nodes
    .filter((n) => touches(n.quote) || touches(n.payload))
    .map((n) => n.id);
}

/**
 * Pin-by-construction on GoalSpec: convert both to IR, merge, return raised spec.
 * Pass `touchIds` (from `touchIdsFromAnswer`) so the correction may overwrite only what it names.
 */
export function pinSpecByIr(prev: GoalSpec, next: GoalSpec, goal: string, touchIds: string[] = []): { spec: GoalSpec; pinned: string[] } {
  const a = irFromSpec(goal, prev, { pinAll: true });
  const b = irFromSpec(goal, next, { pinAll: false });
  const { ir, restored } = mergeIntent(a, b, touchIds);
  let spec = specFromIr(ir);
  // A schedule that appears only on the re-plan while the prior had none is collateral — freeze it off unless touched.
  if (!prev.schedule && spec.schedule && !touchIds.includes("schedule:0")) {
    spec = { ...spec, schedule: null };
    restored.push("schedule:0");
  }
  // US1 / T13: a re-plan that drops every source (empty []) while the prior had readers is collateral — restore unless a
  // source node was explicitly touched. mergeIntent already keeps pinned prior nodes when the proposal omits them; this
  // covers a proposal that shipped `sources: []` after catalogue stripping (MEM3 / rewriteReads) wiped the reader.
  if ((prev.sources?.length ?? 0) > 0 && (spec.sources?.length ?? 0) === 0 && !touchIds.some((id) => id.startsWith("source:"))) {
    spec = { ...spec, sources: prev.sources };
    for (let i = 0; i < prev.sources!.length; i++) restored.push(nodeId("source", i));
  }
  // IR lowers structure only — bookkeeping the solver/accounting needs must not vanish on re-plan.
  if (prev.covered?.length && !touchIds.includes("summary:0")) {
    spec = { ...spec, covered: prev.covered };
  }
  if (prev.inputs?.length && !spec.inputs?.length) spec = { ...spec, inputs: prev.inputs };
  if (prev.planGaps?.length && !spec.planGaps?.length) spec = { ...spec, planGaps: prev.planGaps };
  if (prev.wiring && !spec.wiring) spec = { ...spec, wiring: prev.wiring };
  return { spec, pinned: restored };
}

/**
 * Phase 5: edit/delete share the IR — remove named nodes then re-lower.
 * Untouched pinned nodes stay. Used when BUILDER_INTENT_IR is on.
 */
export function removeNodes(ir: IntentIR, ids: string[]): IntentIR {
  const drop = new Set(ids);
  return { ...ir, nodes: ir.nodes.filter((n) => !drop.has(n.id)), version: ir.version + 1 };
}

/** Patch only touched node ids from a proposal; pin the rest. */
export function patchIr(prev: IntentIR, proposal: IntentIR, touchIds: string[]): IntentIR {
  return mergeIntent(pinAll(prev), proposal, touchIds).ir;
}
