import type { CanvasGraph } from "@/lib/canvas-model";

/**
 * `lib/run-animation.ts` — which parts of the canvas are MOVING, derived from
 * the run's own per-step statuses. Builder programme T10 (`BD-007`).
 *
 * ── What was wrong ───────────────────────────────────────────────────────────
 *
 * `FlowCanvas` took a flow-wide `testing` boolean and animated EVERYTHING with
 * it: every node pulsed and every edge flowed for as long as the run lasted. So
 * the picture said "all eight steps are working" while one step was working and
 * seven were queued, and it said the same thing at second one and at second
 * ninety. A picture that is identical in every state carries no information —
 * and worse, it is a picture of a system that is not the one executing, which
 * is the same defect class as `BX-005`'s invented outputs, one layer up.
 *
 * ⚠ **DRIVEN BY ENGINE EVENTS, NEVER BY A TIMER.** Every input here is a status
 * the run reported through `openFlowStream`; nothing advances on its own. A
 * timed animation eventually outruns the run it depicts, and then the canvas is
 * confidently wrong — with nothing on screen to say so.
 *
 * ⚠ **Pure, and returns SETS rather than a mutated graph.** `overlayStatuses`
 * already learned this lesson for I-66: rebuilding React Flow's node array
 * resets `measured`, `parseHandles` then discards the handle bounds taken at
 * mount, and every edge in the diagram unmounts. A status-only update must not
 * rebuild nodes, so this hands back membership tests the renderer applies to
 * `className` — which changes no identity.
 */

/** Statuses that mean this step is doing something right now. */
const MOVING = new Set(["running"]);

/**
 * Statuses that mean this step is finished and its successors may begin.
 *
 * ⚠ `skipped` counts as settled, and that is deliberate: a `branch` whose
 * condition was false skips the steps under it, and the run genuinely moved
 * past them. Treating skipped as unfinished would leave the edge into the next
 * step permanently unlit on every conditional flow.
 */
const SETTLED = new Set(["success", "warning", "failed", "cancelled", "skipped"]);

/**
 * The nodes to pulse.
 *
 * ⚠ **`paused` does NOT pulse**, matching `STATUS_TONE`'s decision that paused
 * is `warn` and not `accent`. A pulse reads as "this is moving"; a paused run is
 * waiting on a PERSON and needs somebody to go and answer it. Animating it is
 * how a run sits in an inbox for a day looking busy.
 */
export function movingNodes(graph: CanvasGraph): Set<string> {
  const out = new Set<string>();
  for (const n of graph.nodes) {
    if (n.status && MOVING.has(n.status)) out.add(n.id);
  }
  return out;
}

/** The canonical id for an edge, matching what `FlowCanvas` builds. */
export function edgeId(source: string, target: string): string {
  return `${source}->${target}`;
}

/**
 * The edges the run is CROSSING — an upstream step that has settled feeding a
 * step that is now moving.
 *
 * ⚠ **Both ends are required.** Lighting every edge out of a finished step
 * would animate the whole tail of the flow the moment the first step succeeds,
 * which is the flow-wide boolean again with more steps. Requiring the target to
 * be running is what makes the animation travel.
 *
 * Returns an empty set when nothing has a status, so a graph with no run behind
 * it animates nothing at all — an idle canvas is idle.
 */
export function movingEdges(graph: CanvasGraph): Set<string> {
  const status = new Map(graph.nodes.map((n) => [n.id, n.status ?? null]));
  const out = new Set<string>();
  for (const e of graph.edges) {
    const from = status.get(e.source);
    const to = status.get(e.target);
    if (from && SETTLED.has(from) && to && MOVING.has(to)) out.add(edgeId(e.source, e.target));
  }
  return out;
}

/**
 * True when the run has told us nothing yet — no node carries a status.
 *
 * ⚠ The caller falls back to the old flow-wide animation ONLY here, and the
 * distinction matters: "the run started and no step has reported" is a real
 * state that lasts a second or two, and showing a dead canvas through it reads
 * as a run that never began. Once ONE status arrives, the per-step picture is
 * the truth and the blanket animation must stop.
 */
export function awaitingFirstStatus(graph: CanvasGraph): boolean {
  return graph.nodes.every((n) => !n.status);
}
