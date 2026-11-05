/**
 * For each, in a run's step view (compiled-builder phase F, F3 — D-367).
 *
 * A loop's body runs once per item, so Kestra reports one taskrun PER ITEM for every body task. The step view is addressed by
 * step (R5: a client names a step, never a taskrun), and every consumer — the canvas, the strip, a flow's result, an
 * expectation — reads one view per step. So the per-item taskruns are FOLDED here:
 *
 *  - each body step appears ONCE, with `perItem` counts (ran / succeeded / failed) and a status that says what happened across
 *    the items: every item succeeded → success; some failed → warning; every item failed → failed;
 *  - the loop's own view carries `items`: one entry per item, in input order — its number, its status, the steps it ran (its
 *    path through any condition inside), the first error, and its result (from the per-item pick the compiler emits).
 *
 * ⚠ ENGINE FACTS this rests on (measured on a real loop run, 2026-09-30): a ForEach's DIRECT children carry `value` — the
 * numbered item, `_i` included; a task inside an `If` arm carries NO `value`, only `parentTaskRunId` naming the If's taskrun.
 * So an item is found by walking parents up to the ForEach's taskrun, and read off the child directly under it.
 *
 * D-370 — a BATCHED loop (one call inside, run in chunks): its ForEach runs once per CHUNK, the child's `value` an array of
 * numbered rows. A chunk is placed by its first row's number, and the chunk's pick `{is, r}` is spread back into items — item
 * `is[k]` is the batch envelope's `results[k]` — so the loop still reports one entry per ITEM, and its call's counts are items.
 *
 * Every view folded here was already redacted by `buildSteps`; nothing is read from a raw taskrun output.
 */
import type { StepStatus, StepView } from "./flow-visibility.service.js";

/** What one taskrun needs to be placed: its id, its parent, and — directly under a ForEach — the item it ran for. */
export interface RunRef { id: string; taskId: string; parentTaskRunId?: string | null; value?: string | null }

export interface LoopItem {
  /** The item's number in the list the loop ran over — input order. */
  i: number;
  status: StepStatus;
  /** The body steps that ran for this item, in the order they ran (its path through any condition inside). */
  path: string[];
  /** The first failure, named by its step. */
  error: string | null;
  /** The value of the loop's result step for this item; null when it did not finish, or the loop has no output. */
  result: unknown;
}
export interface PerItem { ran: number; succeeded: number; failed: number }

const RANK: Record<StepStatus, number> = { failed: 7, cancelled: 6, warning: 5, running: 4, paused: 3, created: 2, success: 1, skipped: 0 };
const worst = (xs: StepStatus[]): StepStatus => xs.reduce<StepStatus>((a, b) => (RANK[b] > RANK[a] ? b : a), "skipped");
const NO_RESULT = "__no_result__";
const PICK = "-pick";

/** The loop (by step id) and item number each taskrun ran for, or nothing for a taskrun outside every loop. */
export function itemsOfRuns(runs: RunRef[], isLoop: (taskId: string) => boolean): Map<string, { loop: string; i: number }> {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const out = new Map<string, { loop: string; i: number }>();
  for (const r of runs) {
    let cur: RunRef | undefined = r;
    for (let guard = 0; cur?.parentTaskRunId && guard < 64; guard++) {
      const parent = byId.get(cur.parentTaskRunId);
      if (!parent) break;
      if (isLoop(parent.taskId)) {
        const i = numberOf(cur.value);
        if (i !== null) out.set(r.id, { loop: parent.taskId, i });
        break;
      }
      cur = parent;
    }
  }
  return out;
}
function numberOf(value: string | null | undefined): number | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value) as { _i?: unknown } | Array<{ _i?: unknown }>;
    // A batch (D-370): the chunk is placed by its first row's number.
    const i = Array.isArray(v) ? v[0]?._i : v._i;
    return typeof i === "number" ? i : null;
  } catch { return null; }
}

const statusOfMany = (xs: StepStatus[]): StepStatus => {
  const failed = xs.filter((s) => s === "failed").length;
  if (failed && failed === xs.length) return "failed";
  if (failed) return "warning";
  return worst(xs);
};

/**
 * Fold per-item views into one view per step, and give each loop its `items`. `views[k]` is the view of `runs[k]`.
 * Views outside every loop pass through untouched, in their order.
 */
export function foldLoopItems(views: StepView[], runs: RunRef[], isLoop: (taskId: string) => boolean): StepView[] {
  const placed = itemsOfRuns(runs, isLoop);
  // A loop over an EMPTY list has no body taskruns at all — its view still says so (`items: []`), never "no items field".
  if (!placed.size && !views.some((v) => isLoop(v.stepId))) return views;
  const perStep = new Map<string, { loop: string; views: Array<{ v: StepView; i: number }> }>();
  const out: Array<StepView | { fold: string }> = [];
  views.forEach((v, k) => {
    const at = placed.get(runs[k]!.id);
    if (!at) { out.push(v); return; }
    const key = `${at.loop}\u0000${v.stepId}`;
    const g = perStep.get(key);
    if (g) g.views.push({ v, i: at.i });
    else { perStep.set(key, { loop: at.loop, views: [{ v, i: at.i }] }); out.push({ fold: key }); }
  });
  // Each loop's items, from its body's per-item views.
  type Acc = { statuses: StepStatus[]; path: string[]; error: string | null; result: unknown; batch?: Batch };
  const items = new Map<string, Map<number, Acc>>();
  for (const { loop, views: vs } of perStep.values()) {
    const m = items.get(loop) ?? new Map();
    items.set(loop, m);
    for (const { v, i } of vs) {
      const it: Acc = m.get(i) ?? { statuses: [], path: [], error: null, result: null };
      m.set(i, it);
      it.statuses.push(v.status);
      if (v.stepId === `${loop}${PICK}`) { const b = batchOf(v); if (b) it.batch = b; else it.result = resultOf(v); continue; }
      if (!v.platform && v.status !== "skipped") it.path.push(v.stepId);
      if (!it.error && v.error && (v.status === "failed" || v.status === "warning")) it.error = `${v.stepId}: ${v.error}`;
    }
  }
  // A batched loop's chunks, spread into their items: item `is[k]` gets the envelope's `results[k]`.
  const batchedLoops = new Set<string>();
  for (const [loop, m] of items) {
    if (![...m.values()].some((it) => it.batch)) continue;
    batchedLoops.add(loop);
    const spread = new Map<number, Acc>();
    for (const it of m.values()) {
      if (!it.batch) continue;
      it.batch.is.forEach((i, k) => {
        const r = it.batch!.results?.[k];
        const ok = r?.ok === true;
        spread.set(i, { statuses: [ok ? "success" : "failed"], path: it.path, result: ok ? r!.data ?? null : null,
          // A per-item failure names its step and the item's own error; a batch that failed whole keeps the call's own error.
          error: ok ? null : r?.error ? `${it.path[0] ?? "the call"}: ${r.error}` : it.error ?? `${it.path[0] ?? "the call"}: ${it.batch!.results ? "no result for this item" : "the batch call for these items did not finish"}` });
      });
    }
    items.set(loop, spread);
  }
  return out.map((x) => {
    if (!("fold" in x)) {
      const m = items.get(x.stepId) ?? (isLoop(x.stepId) ? new Map() : undefined);
      if (!m) return x;
      const list: LoopItem[] = [...m.entries()].sort(([a], [b]) => a - b).map(([i, it]) => ({ i, status: worst(it.statuses), path: it.path, error: it.error, result: it.result }));
      return { ...x, items: list, perItem: count(list.map((l) => l.status)) };
    }
    const g = perStep.get(x.fold)!;
    const vs = g.views.map((y) => y.v);
    // A batched loop's call ran once per chunk; what it did is counted per ITEM.
    const statuses = batchedLoops.has(g.loop) && !vs[0]!.platform ? [...items.get(g.loop)!.values()].map((it) => it.statuses[0]!) : vs.map((y) => y.status);
    const starts = vs.map((y) => y.startedAt).filter((t): t is string => !!t).sort();
    const ends = vs.map((y) => y.endedAt).filter((t): t is string => !!t).sort();
    const failedOne = vs.find((y) => y.error);
    return {
      ...vs[0]!,
      status: statusOfMany(statuses),
      attempt: Math.max(...vs.map((y) => y.attempt)),
      startedAt: starts[0] ?? null,
      endedAt: ends.at(-1) ?? null,
      durationMs: starts[0] && ends.at(-1) ? Date.parse(ends.at(-1)!) - Date.parse(starts[0]) : null,
      // One item's output is not the step's; per-item results are on the loop's `items`.
      output: null,
      error: failedOne?.error ?? null,
      logs: vs.filter((y) => y.error).flatMap((y) => y.logs).slice(0, 40),
      perItem: count(statuses),
      loop: g.loop,
    } as StepView;
  });
}

function count(statuses: StepStatus[]): PerItem {
  return { ran: statuses.filter((s) => s !== "skipped").length, succeeded: statuses.filter((s) => s === "success").length, failed: statuses.filter((s) => s === "failed").length };
}

/** A batch's pick (D-370): the chunk's item numbers, and the envelope's per-item results — or null results when the call failed. */
interface Batch { is: number[]; results: Array<{ ok?: boolean; data?: unknown; error?: string }> | null }
function batchOf(v: StepView): Batch | null {
  const raw = (v.output as { value?: unknown } | null)?.value;
  try {
    const pick = typeof raw === "string" ? (JSON.parse(raw) as { is?: unknown; r?: unknown }) : null;
    if (!pick || !Array.isArray(pick.is)) return null;
    const env = typeof pick.r === "string" && pick.r !== NO_RESULT ? (JSON.parse(pick.r) as { results?: Batch["results"] }) : null;
    return { is: pick.is.filter((i): i is number => typeof i === "number"), results: env?.results ?? null };
  } catch { return null; }
}

/** The per-item pick's `{i, r}` → the result, or null when the result step did not finish for this item. */
function resultOf(v: StepView): unknown {
  const raw = (v.output as { value?: unknown } | null)?.value;
  try {
    const pick = typeof raw === "string" ? (JSON.parse(raw) as { r?: unknown }) : null;
    const r = pick?.r;
    if (typeof r !== "string" || r === NO_RESULT) return null;
    return JSON.parse(r);
  } catch { return null; }
}
