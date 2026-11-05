// src/lib/builder-test-run.ts — turning a builder test run into what the canvas shows.
// T6 · BD-... · closes BX-005 (builder programme, closed; record removed 2026-09-11)
//
// ── What this replaces, and why it is a separate module ──────────────────────
//
// `flows/[id]/builder/page.tsx` used to open with:
//
//     const mockPerNode = {};
//     for (const s of steps ?? []) {
//       mockPerNode[s.stepId] = { rows: [{ id: 1, result: `output for ${s.stepId}` }], … };
//     }
//     await testRunFlow(id);        // a REAL run
//     setTestOutputs(mockPerNode);  // and then the invented one on screen
//
// So the button really started a draft execution, threw the result away, and
// showed `output for step_1` for every step of every flow. ⚠ **That is worse
// than showing nothing**, and worse in a specific direction: the fabrication is
// uniformly SUCCESSFUL, so a step that failed, was skipped, or never ran at all
// rendered as a step that worked. `runs/[id]` had the same class of defect
// (`UXI-032`) and it at least invented a *failure*, which sends somebody to look.
// This one sends nobody.
//
// These functions are pure — no fetch, no React, no clock beyond what is handed
// in — for the reason `lib/canvas-model.ts` and `lib/flow-authoring.ts` are pure:
// the rules are the part worth asserting, and a rule inside a component can only
// be tested through a render.
//
// ⚠ **THE ONE RULE ALL THREE OBEY: an absent field draws NOTHING.** Never a
// placeholder, never a zero, never an empty object standing in for a value the
// run did not produce. Every field below comes off `StepRun`, which is already
// the server's REDACTED assembly (`flow-visibility.service.ts`) — so there is
// nothing here to redact and nothing here to invent.

import { STATUS_LABEL, type CanvasGraph } from "@/lib/canvas-model";
import type { FlowExecutionSummary, StepRun } from "@/lib/types";

/**
 * Which execution did the Test button just start?
 *
 * ⚠ **`POST …/test-run` DELIBERATELY DOES NOT TELL US.** It answers
 * `{ revision }` and nothing else — no Kestra execution id, no namespace (R5,
 * I-22), and the route's own docblock says a client finds the run "the way the
 * UI already does — by listing executions". So this is a search, not a lookup,
 * and it has to be a careful one: the wrong answer here attaches the canvas to
 * somebody else's run.
 *
 * Three conditions, all required:
 * - the execution belongs to THIS flow (`flowId`, Foundry's uuid — since I-23
 *   this is an identifier rather than the Kestra slug, which is what finally
 *   makes this filter expressible at all);
 * - it started at or after the moment we pressed the button;
 * - it has a `startedAt` to compare. A row without one is not "probably ours".
 *
 * Newest wins, so a second press supersedes the first.
 *
 * ⚠ **Returns null rather than a best guess.** A caller that gets null must say
 * it could not find the run — see the note on `sinceIso` below. Falling back to
 * "the newest execution of this flow" would silently attach to the PREVIOUS
 * test run, whose steps are all `success`, which is exactly the reassuring lie
 * this whole module exists to remove.
 *
 * @param sinceIso when the test run was requested. Taken BEFORE the POST by the
 *   caller — taking it after leaves a window in which a fast run has already
 *   started and is then filtered out for being too old.
 */
export function pickTestExecution(
  executions: FlowExecutionSummary[],
  flowId: string,
  sinceIso: string,
): FlowExecutionSummary | null {
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) return null;
  const mine = executions.filter((e) => {
    if (e.flowId !== flowId) return false;
    if (!e.startedAt) return false;
    const t = Date.parse(e.startedAt);
    return !Number.isNaN(t) && t >= since;
  });
  if (mine.length === 0) return null;
  return mine.reduce((newest, e) =>
    Date.parse(e.startedAt!) > Date.parse(newest.startedAt!) ? e : newest,
  );
}

/**
 * What the output panel shows for each step — REAL fields only.
 *
 * The panel takes `Record<stepId, Record<string, unknown>>` and renders it as
 * JSON, so the shape is fixed and the only question is what goes in it. The
 * answer is: whatever this step actually has, and nothing else.
 *
 * ⚠ **`output` is included ONLY when the step really has one.** A step that has
 * not run yet, a `code` step whose fragment produced nothing, and a step whose
 * output was withheld are three different things, and none of them is `{}`.
 * Where there is no output the entry still exists — carrying `status`, and
 * `error` if there is one — because "this step ran and failed" is precisely the
 * thing a person opened the panel to read.
 *
 * ⚠ **`readFrom` travels.** `"production"` on a draft run means the test just
 * read the tenant's real data (D-52), and the person pressing Test in a builder
 * is the one who most needs to know that. It is rendered on the step and never
 * inferred from configuration.
 */
export function outputsFromSteps(steps: StepRun[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const s of steps) {
    const entry: Record<string, unknown> = { status: s.status };
    if (s.kind != null) entry.kind = s.kind;
    if (s.ref != null) entry.ref = s.ref;
    // The closest thing a step has to an "input": the call it actually made.
    // ⚠ Already redacted server-side (`flow-visibility.service.ts`) — the URI is
    // the assembled one minus credentials. There is nothing to strip here and
    // nothing to add.
    if (s.request != null) entry.request = s.request;
    if (s.output != null) entry.output = s.output;
    if (s.error != null) entry.error = s.error;
    if (s.durationMs != null) entry.durationMs = s.durationMs;
    if (s.readFrom != null) entry.readFrom = s.readFrom;
    if (s.responseCode != null) entry.responseCode = s.responseCode;
    if (s.attempt > 1) entry.attempt = s.attempt;
    out[s.stepId] = entry;
  }
  return out;
}

/**
 * Paint a live run's step states onto the graph the builder is already showing.
 *
 * ⚠ **OVERLAY, never rebuild.** The builder's graph is the DRAFT — including
 * unsaved local edits, which are the whole reason `edited` wins over the
 * server's copy. Rebuilding it from the execution would silently discard those
 * edits the moment somebody pressed Test, and would also renumber the nodes,
 * because an execution's task list carries the platform tasks (`begin`,
 * `complete`, an agent step's `_await`) that the person never wrote.
 *
 * So: same nodes, same ids, same order, same edges. Only `status`, `attempt`
 * and — where the draft had nothing to say — `meta` change.
 *
 * ⚠ **A node with no matching step keeps `status: null`, which draws as no ring
 * at all.** It must NOT become `created`: "the engine has not reached this yet"
 * and "this step is not in the run" look identical on screen and are not the
 * same fact, and the second one means the canvas and the execution disagree
 * about what the flow is — which is worth noticing rather than smoothing over.
 *
 * Returns the SAME object when nothing matched, so a caller can keep the
 * identity check that stops React Flow discarding measured handle bounds (I-66).
 */
export function overlayStatuses(graph: CanvasGraph, steps: StepRun[]): CanvasGraph {
  if (steps.length === 0) return graph;
  const by = new Map(steps.map((s) => [s.stepId, s]));
  let hit = false;
  const nodes = graph.nodes.map((n) => {
    const s = by.get(n.id);
    if (!s) return n;
    hit = true;
    return {
      ...n,
      status: s.status,
      attempt: s.attempt,
      // The draft's own meta (a retry policy, a pause budget) is a statement
      // about the flow and stays; a duration is a statement about THIS run and
      // only fills a gap the draft left.
      meta: n.meta ?? (s.durationMs != null ? `${s.durationMs} ms` : null),
    };
  });
  return hit ? { ...graph, nodes } : graph;
}

/**
 * One row per node for the inspector's progress list, in graph order.
 *
 * ⚠ **This replaces a list that said `running…` for EVERY node** for as long as
 * `testing` was true — including nodes the engine had not reached, nodes it had
 * already finished, and (had a run ever failed) nodes that had failed. The words
 * come from `STATUS_LABEL`, the same ones the canvas ring uses, so the list and
 * the picture beside it cannot disagree.
 *
 * ⚠ **A node with no status reads "no report yet", NOT "not started".**
 * `created` is a state the engine reports — it means the task exists and has not
 * begun. A null means the execution said nothing about this node at all, which
 * is a different thing and, when it persists, means the canvas and the run
 * disagree about what the flow is.
 */
export function progressRows(graph: CanvasGraph): Array<{ id: string; label: string; status: string | null }> {
  return graph.nodes.map((n) => ({
    id: n.id,
    label: n.status ? STATUS_LABEL[n.status] : "no report yet",
    status: n.status,
  }));
}

/**
 * The last step in graph order that actually produced an output.
 *
 * ⚠ **The panel above this used to render
 * `Object.values(testOutputs)[length - 1]` under the heading "Final output" and
 * the summary "Aggregated final output from last test run".** Nothing was
 * aggregated — it was whichever entry happened to be last in object insertion
 * order — and on a branching flow the last-inserted step is not the terminal
 * one. A claim about aggregation that no code performs is the same class of
 * defect as the invented rows, one level up: the VALUES were real and the
 * SENTENCE about them was not.
 *
 * So this returns the step and its output, and the caller names it for what it
 * is — the last step that produced output. Null when no step produced any,
 * which renders as nothing rather than as an empty final result.
 */
export function finalOutputStep(
  graph: CanvasGraph,
  outputs: Record<string, Record<string, unknown>> | null,
): { stepId: string; output: Record<string, unknown> } | null {
  if (!outputs) return null;
  for (let i = graph.nodes.length - 1; i >= 0; i--) {
    const id = graph.nodes[i].id;
    const entry = outputs[id];
    // `outputsFromSteps` only ever writes `StepRun.output` here, which is a
    // record. The guard is for a caller passing a hand-built map: a non-record
    // is skipped rather than rendered, because the panel would show it as an
    // empty object — a result that looks produced and empty rather than absent.
    const value = entry?.output;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { stepId: id, output: value as Record<string, unknown> };
    }
  }
  return null;
}
