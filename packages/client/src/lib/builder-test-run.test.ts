// src/lib/builder-test-run.test.ts — T6 / BX-005.
//
// The subject is the seam that replaced a fabrication, so most of these assert
// an ABSENCE: that a field the run did not produce does not appear, and that a
// step the run does not contain does not acquire a status. A test that only
// checked the happy path would pass against the very `mockPerNode` loop this
// module exists to delete.

import { describe, it, expect } from "vitest";
import { pickTestExecution, outputsFromSteps, overlayStatuses, progressRows, finalOutputStep } from "@/lib/builder-test-run";
import { STATUS_LABEL } from "@/lib/canvas-model";
import type { CanvasGraph } from "@/lib/canvas-model";
import type { FlowExecutionSummary, StepRun } from "@/lib/types";

const FLOW = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function exec(over: Partial<FlowExecutionSummary>): FlowExecutionSummary {
  return {
    id: "e1", workspaceId: "w", flowId: FLOW, flowName: "f", flowNameSnapshot: null, flowIdSnapshot: null, status: "running",
    engineStatus: "running", startedAt: "2026-09-02T10:00:00.000Z", endedAt: null,
    durationMs: null, inputs: {}, replayOfId: null, replayFromStep: null, ...over,
  };
}

function step(over: Partial<StepRun>): StepRun {
  return {
    stepId: "fetch", status: "success", kind: "datasource", platform: false, ref: null,
    readFrom: null, attempt: 1, startedAt: null, endedAt: null, durationMs: null,
    request: null, responseCode: null, output: null, error: null, logs: [],
    kestraTaskrunId: null, auditVerdict: null, oracleScore: null, ...over,
  };
}

describe("pickTestExecution — finding the run the button just started", () => {
  const SINCE = "2026-09-02T10:00:00.000Z";

  it("takes an execution of this flow started at or after the press", () => {
    const got = pickTestExecution([exec({ id: "mine" })], FLOW, SINCE);
    expect(got?.id).toBe("mine");
  });

  it("never takes another flow's run", () => {
    expect(pickTestExecution([exec({ id: "theirs", flowId: OTHER })], FLOW, SINCE)).toBeNull();
  });

  /**
   * ⚠ The load-bearing one. The previous run of THIS flow is the most tempting
   * wrong answer: it matches the flow, it is real, and its steps are all
   * `success` — so attaching to it paints a green canvas for a run that has not
   * produced a single row yet.
   */
  it("never falls back to an EARLIER run of the same flow", () => {
    const old = exec({ id: "yesterday", startedAt: "2026-09-01T10:00:00.000Z" });
    expect(pickTestExecution([old], FLOW, SINCE)).toBeNull();
  });

  it("takes the newest when a second press produced a second run", () => {
    const got = pickTestExecution(
      [exec({ id: "first", startedAt: "2026-09-02T10:00:01.000Z" }),
       exec({ id: "second", startedAt: "2026-09-02T10:00:09.000Z" })],
      FLOW, SINCE,
    );
    expect(got?.id).toBe("second");
  });

  it("ignores a row with no startedAt rather than guessing it is ours", () => {
    expect(pickTestExecution([exec({ id: "x", startedAt: null })], FLOW, SINCE)).toBeNull();
  });

  it("returns null on an unparseable since, rather than matching everything", () => {
    expect(pickTestExecution([exec({})], FLOW, "not a date")).toBeNull();
  });

  it("returns null on an empty list", () => {
    expect(pickTestExecution([], FLOW, SINCE)).toBeNull();
  });
});

describe("outputsFromSteps — real fields only", () => {
  it("carries the output a step actually produced", () => {
    const o = outputsFromSteps([step({ output: { rows: [{ id: 7 }] } })]);
    expect(o.fetch.output).toEqual({ rows: [{ id: 7 }] });
  });

  /**
   * ⚠ The whole point of BX-005. The deleted code wrote
   * `rows: [{ id: 1, result: "output for fetch" }]` for every step whether or
   * not it had run. An absent output must be absent.
   */
  it("OMITS output entirely when the step produced none", () => {
    const o = outputsFromSteps([step({ output: null })]);
    expect("output" in o.fetch).toBe(false);
    expect(o.fetch).not.toHaveProperty("rows");
  });

  it("still reports a step that has no output, because status is the fact", () => {
    const o = outputsFromSteps([step({ status: "failed", output: null, error: "boom" })]);
    expect(o.fetch.status).toBe("failed");
    expect(o.fetch.error).toBe("boom");
  });

  it("carries the request a tool step actually made — the step's input", () => {
    const o = outputsFromSteps([step({ request: { uri: "https://ops.example/hr/attendance", method: "GET" } })]);
    expect(o.fetch.request).toEqual({ uri: "https://ops.example/hr/attendance", method: "GET" });
  });

  it("omits request when the step made none", () => {
    expect("request" in outputsFromSteps([step({ request: null })]).fetch).toBe(false);
  });

  it("omits error, duration, responseCode and readFrom when null", () => {
    const o = outputsFromSteps([step({})]);
    for (const k of ["error", "durationMs", "responseCode", "readFrom"]) {
      expect(k in o.fetch).toBe(false);
    }
  });

  /** D-52 — a draft run that read production is the thing the tester must see. */
  it("carries readFrom production", () => {
    const o = outputsFromSteps([step({ readFrom: "production" })]);
    expect(o.fetch.readFrom).toBe("production");
  });

  it("shows attempt only when a retry actually fired", () => {
    expect("attempt" in outputsFromSteps([step({ attempt: 1 })]).fetch).toBe(false);
    expect(outputsFromSteps([step({ attempt: 3 })]).fetch.attempt).toBe(3);
  });

  it("is keyed by stepId and covers every step", () => {
    const o = outputsFromSteps([step({ stepId: "a" }), step({ stepId: "b" })]);
    expect(Object.keys(o).sort()).toEqual(["a", "b"]);
  });

  it("is empty for no steps — not a placeholder entry", () => {
    expect(outputsFromSteps([])).toEqual({});
  });
});

describe("overlayStatuses — paint the run onto the draft, do not rebuild it", () => {
  const graph: CanvasGraph = {
    nodes: [
      { id: "fetch", kind: "datasource", ref: null, status: null, seam: null, meta: null, attempt: null, generated: false, platform: false },
      { id: "notify", kind: "tool", ref: null, status: null, seam: null, meta: null, attempt: null, generated: false, platform: false },
    ],
    edges: [{ source: "fetch", target: "notify" }],
    hasSeam: false,
    hasUnknownSeam: false,
  };

  it("sets the status of a node the run reached", () => {
    const g = overlayStatuses(graph, [step({ stepId: "fetch", status: "running" })]);
    expect(g.nodes.find((n) => n.id === "fetch")!.status).toBe("running");
  });

  /**
   * ⚠ "not reached yet" and "not in this run" must not look the same. A node the
   * execution says nothing about keeps null, which draws no ring at all.
   */
  it("leaves an unmatched node at null rather than defaulting it to created", () => {
    const g = overlayStatuses(graph, [step({ stepId: "fetch", status: "success" })]);
    expect(g.nodes.find((n) => n.id === "notify")!.status).toBeNull();
  });

  it("keeps the draft's own nodes, ids, order and edges", () => {
    const g = overlayStatuses(graph, [step({ stepId: "fetch" })]);
    expect(g.nodes.map((n) => n.id)).toEqual(["fetch", "notify"]);
    expect(g.edges).toEqual(graph.edges);
  });

  it("never adds a platform task the person did not write", () => {
    const g = overlayStatuses(graph, [step({ stepId: "begin", platform: true }), step({ stepId: "fetch" })]);
    expect(g.nodes.map((n) => n.id)).toEqual(["fetch", "notify"]);
  });

  it("fills meta with a duration only where the draft left it empty", () => {
    const withMeta: CanvasGraph = { ...graph, nodes: [{ ...graph.nodes[0], meta: "retries 3x" }, graph.nodes[1]] };
    const g = overlayStatuses(withMeta, [step({ stepId: "fetch", durationMs: 42 })]);
    expect(g.nodes[0].meta).toBe("retries 3x");
    const g2 = overlayStatuses(graph, [step({ stepId: "fetch", durationMs: 42 })]);
    expect(g2.nodes[0].meta).toBe("42 ms");
  });

  /** I-66 — a rebuilt node array resets `measured` and every edge unmounts. */
  it("returns the SAME object when nothing matched, preserving identity", () => {
    expect(overlayStatuses(graph, [])).toBe(graph);
    expect(overlayStatuses(graph, [step({ stepId: "nobody" })])).toBe(graph);
  });

  it("does not mutate the caller's graph", () => {
    overlayStatuses(graph, [step({ stepId: "fetch", status: "failed" })]);
    expect(graph.nodes[0].status).toBeNull();
  });
});

describe("progressRows — the inspector's list while a run is in flight", () => {
  const g = (statuses: Array<string | null>): CanvasGraph => ({
    nodes: statuses.map((st, i) => ({
      id: `s${i}`, kind: "tool" as const, ref: null, status: st as never,
      seam: null, meta: null, attempt: null, generated: false, platform: false,
    })),
    edges: [], hasSeam: false, hasUnknownSeam: false,
  });

  /**
   * ⚠ The defect this replaces: the panel printed `running…` for every node for
   * as long as the button was busy, regardless of what any of them was doing.
   */
  it("gives each node its OWN state, not one shared word", () => {
    const rows = progressRows(g(["success", "running", "created"]));
    expect(rows.map((r) => r.label)).toEqual([STATUS_LABEL.success, STATUS_LABEL.running, STATUS_LABEL.created]);
  });

  it("says 'waiting' for paused, never 'running'", () => {
    expect(progressRows(g(["paused"]))[0].label).toBe("waiting");
    expect(progressRows(g(["paused"]))[0].label).not.toBe(STATUS_LABEL.running);
  });

  it("distinguishes 'no report yet' from 'not started'", () => {
    expect(progressRows(g([null]))[0].label).toBe("no report yet");
    expect(progressRows(g(["created"]))[0].label).toBe(STATUS_LABEL.created);
  });

  it("uses the canvas's own words, so the list and the rings agree", () => {
    for (const st of Object.keys(STATUS_LABEL)) {
      expect(progressRows(g([st]))[0].label).toBe(STATUS_LABEL[st as keyof typeof STATUS_LABEL]);
    }
  });

  it("keeps graph order", () => {
    expect(progressRows(g(["success", "failed"])).map((r) => r.id)).toEqual(["s0", "s1"]);
  });
});

describe("finalOutputStep — the last step that produced output", () => {
  const g: CanvasGraph = {
    nodes: ["a", "b", "c"].map((id) => ({
      id, kind: "tool" as const, ref: null, status: null, seam: null,
      meta: null, attempt: null, generated: false, platform: false,
    })),
    edges: [], hasSeam: false, hasUnknownSeam: false,
  };

  it("takes the last node in GRAPH order that has an output", () => {
    const got = finalOutputStep(g, { a: { status: "success", output: { n: 1 } }, b: { status: "success", output: { n: 2 } } });
    expect(got).toEqual({ stepId: "b", output: { n: 2 } });
  });

  /**
   * ⚠ The deleted version took `Object.values(outputs)[length - 1]` — insertion
   * order, which is the order the STEPS arrived in and not the order of the
   * graph. Here `c` was inserted first and is last in the graph.
   */
  it("does not use object insertion order", () => {
    const got = finalOutputStep(g, { c: { status: "success", output: { n: 3 } }, a: { status: "success", output: { n: 1 } } });
    expect(got?.stepId).toBe("c");
  });

  it("skips a step that ran but produced nothing", () => {
    const got = finalOutputStep(g, { a: { status: "success", output: { n: 1 } }, c: { status: "failed", error: "boom" } });
    expect(got?.stepId).toBe("a");
  });

  it("returns null when no step produced output — never an empty result", () => {
    expect(finalOutputStep(g, { a: { status: "running" } })).toBeNull();
    expect(finalOutputStep(g, {})).toBeNull();
    expect(finalOutputStep(g, null)).toBeNull();
  });
});
