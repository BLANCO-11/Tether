// src/lib/flow-graph.ts — pure layout maths over a flow's declared topology.
//
// Extracted from the old `components/flow/StepGraph.tsx` so the graph and the strip
// (phase-2.md 2.1, 2.7) order steps the SAME way. Two orderings of one flow —
// the strip saying `begin › screen › notify` while the graph draws `screen`
// first — is the kind of disagreement that makes a UI untrustworthy for
// diagnosis, which is the one thing Phase 2's view has to be.
import type { StepGraphShape, StepRun } from "@/lib/types";

/**
 * Longest-path depth per node, so a step sits after everything it depends on.
 *
 * Longest path rather than shortest: with a diamond (`a → b → d`, `a → c → d`),
 * shortest-path would place `d` at the same depth as `b`, drawing an edge that
 * appears to run backwards. Cycle-guarded — a flow graph is a DAG, but a bad
 * graph must not hang a browser tab.
 */
export function depths(nodes: string[], edges: Array<{ source: string; target: string }>): Map<string, number> {
  const depth = new Map(nodes.map((n) => [n, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const e of edges) {
      const from = depth.get(e.source);
      const to = depth.get(e.target);
      if (from === undefined || to === undefined) continue;
      if (to < from + 1) {
        depth.set(e.target, from + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return depth;
}

/**
 * Every step id this execution should show, in graph order.
 *
 * The graph is the flow's DECLARED shape, so it contains steps that have not run
 * yet — which is exactly what a live execution needs. Steps present in the run
 * but not the graph are appended rather than dropped: a step the UI cannot place
 * is still a step that happened.
 */
export function orderedStepIds(graph: StepGraphShape | null, steps: StepRun[]): string[] {
  const nodeIds = graph?.nodes.map((n) => n.id) ?? steps.map((s) => s.stepId);
  const extra = steps.map((s) => s.stepId).filter((id) => !nodeIds.includes(id));
  const all = [...nodeIds, ...extra];
  const depth = depths(all, graph?.edges ?? []);
  // Stable within a depth: ties keep declaration order, so the strip does not
  // reshuffle itself between polls.
  return all
    .map((id, i) => ({ id, d: depth.get(id) ?? 0, i }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.id);
}

// ⚠ `stepColumns()` lived here and is GONE, with `components/flow/StepGraph.tsx`
// that was its only caller. Both were the column-per-depth graph the canvas
// replaced in programme 3 Stage 2; layout is now dagre's job
// (`lib/canvas-layout.ts`), computed from the same edges.
//
// `depths()` above did NOT go with it — `orderedStepIds` still needs it, so the
// strip and the canvas continue to derive their ordering from one function. That
// was the reason this file was extracted in the first place and it survives the
// renderer it was extracted from.
