import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The History label, tested at the CALL SITE and not at the mapper.
 *
 * `adapters.test.ts` proves `runLabel` picks the name over the uuid. That is not
 * the property that broke: `listFlowRuns` calls
 * `runFromFlowExecution(d, <something>)`, and the something used to be
 * `d.flowId`. Both `d.flowId` and `runLabel(d)` are strings, so swapping them
 * type-checks, renders and is wrong — a uuid in History's automation column and
 * on the dashboard's per-automation breakdown, on every row.
 *
 * That is the same shape as I-23 itself: a field whose only consumer prints it.
 * So the assertion has to run through the seam that chooses, not through the
 * function that is chosen.
 */

const listFlowExecutions = vi.fn();
const getFlowExecution = vi.fn();

vi.mock("@/lib/foundry-client", () => ({
  resolveWorkspaceId: async () => "ws-1",
  FoundryApiError: class extends Error {},
  foundryApi: {
    listFlowExecutions: (...a: unknown[]) => listFlowExecutions(...a),
    getFlowExecution: (...a: unknown[]) => getFlowExecution(...a),
  },
}));

const { listFlowRuns } = await import("./api");

const summary = {
  id: "fe-1",
  workspaceId: "ws-1",
  flowId: "3f2b9a4c-0000-4000-8000-000000000001",
  flowName: "attendance-monitoring",
  status: "succeeded",
  engineStatus: "success",
  startedAt: "2026-06-01T10:00:00.000Z",
  endedAt: "2026-06-01T10:00:07.000Z",
  durationMs: 7000,
  inputs: {},
  replayOfId: null,
  replayFromStep: null,
};

afterEach(() => {
  listFlowExecutions.mockReset();
  getFlowExecution.mockReset();
});

describe("History names a run after the flow, not after its id", () => {
  it("uses `flowName` for the automation column", async () => {
    listFlowExecutions.mockResolvedValue([summary]);
    getFlowExecution.mockResolvedValue({ ...summary, steps: [], graph: null });

    const [run] = await listFlowRuns(10);
    expect(run.automation).toBe("attendance-monitoring");
    // The regression, stated as its own assertion because the positive one above
    // passes against any non-empty string.
    expect(run.automation).not.toBe(summary.flowId);
  });

  it("still names a run whose flow has been deleted", async () => {
    // `flow_executions.flow_id` is `ON DELETE SET NULL`; the slug is copied onto
    // the row at `begin` and survives. A History page that showed "Unnamed run"
    // for every deleted flow would be a visible cost of the id fix.
    const orphan = { ...summary, id: "fe-2", flowId: null };
    listFlowExecutions.mockResolvedValue([orphan]);
    getFlowExecution.mockResolvedValue({ ...orphan, steps: [], graph: null });

    const [run] = await listFlowRuns(10);
    expect(run.automation).toBe("attendance-monitoring");
  });

  it("prefers the name-at-run-time snapshot over the slug when present", async () => {
    // The whole point of the snapshot: a run started while the flow was named
    // "Rachit V1" must show that name, not the slug, even though the slug is
    // still present on the row.
    const snapshotted = { ...summary, id: "fe-3", flowNameSnapshot: "Rachit V1" };
    listFlowExecutions.mockResolvedValue([snapshotted]);
    getFlowExecution.mockResolvedValue({ ...snapshotted, steps: [], graph: null });

    const [run] = await listFlowRuns(10);
    expect(run.automation).toBe("Rachit V1");
  });

  it("falls back to the slug when a run predates the snapshot column", async () => {
    // Old runs never had a name captured at `begin` — `flowNameSnapshot` is
    // null for them, and History must not regress to "Unnamed run" just
    // because this field is new.
    const preSnapshot = { ...summary, id: "fe-4", flowNameSnapshot: null };
    listFlowExecutions.mockResolvedValue([preSnapshot]);
    getFlowExecution.mockResolvedValue({ ...preSnapshot, steps: [], graph: null });

    const [run] = await listFlowRuns(10);
    expect(run.automation).toBe("attendance-monitoring");
  });

  it("keeps the snapshot even for a run whose flow has since been deleted", async () => {
    // The snapshot is copied onto the row at `begin`, same as the slug, so
    // deleting the flow afterward must not blank either of them out.
    const orphanWithSnapshot = {
      ...summary,
      id: "fe-5",
      flowId: null,
      flowNameSnapshot: "Rachit V1",
    };
    listFlowExecutions.mockResolvedValue([orphanWithSnapshot]);
    getFlowExecution.mockResolvedValue({ ...orphanWithSnapshot, steps: [], graph: null });

    const [run] = await listFlowRuns(10);
    expect(run.automation).toBe("Rachit V1");
  });
});

/**
 * `run.flowId`/`run.flowIdSnapshot` are plain pass-throughs (not threaded
 * through a second-argument seam the way `automation` is), so I-23's exact
 * failure shape can't repeat here — but the page-level wiring that CONSUMES
 * them (`runWorkflowId(r)` vs a bare `r.flowId ?? null`) can still drift, and
 * `history/page.test.tsx`'s "shows the FROZEN id" case is what catches that.
 * This file's job is narrower: prove the two fields actually reach `Run` at
 * all, end to end through `listFlowRuns`.
 */
describe("History carries the workflow id AND its run-time snapshot through to Run", () => {
  it("passes the live flowId through", async () => {
    listFlowExecutions.mockResolvedValue([summary]);
    getFlowExecution.mockResolvedValue({ ...summary, steps: [], graph: null });

    const [run] = await listFlowRuns(10);
    expect(run.flowId).toBe("3f2b9a4c-0000-4000-8000-000000000001");
  });

  it("passes flowIdSnapshot through when present", async () => {
    const snapshotted = {
      ...summary,
      id: "fe-6",
      flowIdSnapshot: "9e9e9e9e-0000-4000-8000-000000000009",
    };
    listFlowExecutions.mockResolvedValue([snapshotted]);
    getFlowExecution.mockResolvedValue({ ...snapshotted, steps: [], graph: null });

    const [run] = await listFlowRuns(10);
    expect(run.flowIdSnapshot).toBe("9e9e9e9e-0000-4000-8000-000000000009");
    // The live pointer is unaffected — independent copies, same as the name pair.
    expect(run.flowId).toBe("3f2b9a4c-0000-4000-8000-000000000001");
  });

  it("keeps flowIdSnapshot for a run whose flow has since been deleted", async () => {
    const orphanWithSnapshot = {
      ...summary,
      id: "fe-7",
      flowId: null,
      flowIdSnapshot: "9e9e9e9e-0000-4000-8000-000000000009",
    };
    listFlowExecutions.mockResolvedValue([orphanWithSnapshot]);
    getFlowExecution.mockResolvedValue({ ...orphanWithSnapshot, steps: [], graph: null });

    const [run] = await listFlowRuns(10);
    expect(run.flowId).toBeNull();
    expect(run.flowIdSnapshot).toBe("9e9e9e9e-0000-4000-8000-000000000009");
  });
});
