/**
 * Phase 2 — the progress socket's two load-bearing properties.
 * archive/kestra-migration/progress/phase-2.md 2.8
 *
 * 1. **The ticket is the authorisation.** The socket carries the same data as an
 *    API-key-authenticated REST route while the browser holds no API key, so
 *    everything that makes a ticket weak — reuse, a long life, a guessable value
 *    — turns the one channel into the way around the gate.
 * 2. **A step is sent when it CHANGES, not when it is polled.** The whole reason
 *    2.8 exists is a Phase 4 `agent` step that sits for minutes; if an unchanged
 *    step re-sends every tick, the push is a poll with extra steps.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("./flow-visibility.service.js", () => ({
  flowVisibilityService: { get: vi.fn() },
}));

import { flowProgressService, type ProgressEvent } from "./flow-progress.service.js";
import { flowVisibilityService } from "./flow-visibility.service.js";

const WS = "20406b2e-1c7c-43eb-a1c8-2b7238b73a84";
const EX = "6318bb21-7fe9-4243-a6c2-dcbedac37c0d";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getMock = flowVisibilityService.get as any;

function step(id: string, over: Record<string, unknown> = {}) {
  return {
    stepId: id, status: "success", kind: null, attempt: 1,
    startedAt: null, endedAt: null, durationMs: 10,
    request: null, responseCode: 200, output: null, error: null, logs: [],
    kestraTaskrunId: null, auditVerdict: null, oracleScore: null,
    ...over,
  };
}

function view(engineStatus: string, steps: ReturnType<typeof step>[]) {
  return {
    id: EX, workspaceId: WS, flowId: "hr_screening", status: "running",
    engineStatus, startedAt: null, endedAt: null, durationMs: null,
    inputs: {}, steps, graph: null,
  };
}

/** Let the 1s poll timer fire `n` more times. */
async function ticks(n: number) {
  for (let i = 0; i < n; i++) {
    await vi.advanceTimersByTimeAsync(1000);
  }
}

beforeEach(() => {
  flowProgressService._reset();
  getMock.mockReset();
});

describe("watch tickets", () => {
  it("redeems exactly once", () => {
    const { ticket } = flowProgressService.mintTicket(WS, EX);
    expect(flowProgressService.redeemTicket(ticket)).toEqual({ workspaceId: WS, flowExecutionId: EX });
    // A captured socket URL is worthless after the page has used it.
    expect(flowProgressService.redeemTicket(ticket)).toBeNull();
  });

  it("rejects unknown and empty tickets without saying which", () => {
    expect(flowProgressService.redeemTicket("nope")).toBeNull();
    expect(flowProgressService.redeemTicket("")).toBeNull();
  });

  it("expires", () => {
    vi.useFakeTimers();
    try {
      const { ticket } = flowProgressService.mintTicket(WS, EX);
      vi.advanceTimersByTime(61_000);
      expect(flowProgressService.redeemTicket(ticket)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds to one execution, so a ticket cannot be pointed elsewhere", () => {
    const a = flowProgressService.mintTicket(WS, EX);
    const b = flowProgressService.mintTicket(WS, "other-execution");
    expect(flowProgressService.redeemTicket(a.ticket)?.flowExecutionId).toBe(EX);
    expect(flowProgressService.redeemTicket(b.ticket)?.flowExecutionId).toBe("other-execution");
  });

  it("is long and from the CSPRNG, not a uuid", () => {
    const { ticket } = flowProgressService.mintTicket(WS, EX);
    // 32 random bytes as base64url. A uuidv4 carries 122 bits and announces its
    // own structure; this is 256 and does not.
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ticket).not.toMatch(/^[0-9a-f]{8}-/);
  });
});

describe("the progress stream", () => {
  beforeEach(() => vi.useFakeTimers());

  it("opens with a full snapshot, then sends only what changed", async () => {
    getMock
      .mockResolvedValueOnce(view("running", [step("begin")]))
      .mockResolvedValueOnce(view("running", [step("begin")])) // nothing moved
      .mockResolvedValue(view("running", [step("begin"), step("screen", { status: "running", durationMs: null })]));

    const events: ProgressEvent[] = [];
    const off = flowProgressService.subscribe(WS, EX, (e) => events.push(e));
    await ticks(3);
    off();

    expect(events[0].type).toBe("snapshot");
    // The identical second poll produced nothing at all — the property that makes
    // this cheaper than polling, not just differently shaped.
    const steps = events.filter((e) => e.type === "step");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ step: { stepId: "screen" } });

    vi.useRealTimers();
  });

  it("re-sends a step whose error arrives after its status", async () => {
    // Kestra sets FAILED before the error log is queryable. Fingerprinting on
    // status alone would leave a red step with no reason in the panel — the one
    // thing the exit criterion needs.
    getMock
      .mockResolvedValueOnce(view("running", [step("notify", { status: "failed", error: null })]))
      .mockResolvedValue(view("running", [step("notify", { status: "failed", error: "HTTP 422 invalid recipient" })]));

    const events: ProgressEvent[] = [];
    const off = flowProgressService.subscribe(WS, EX, (e) => events.push(e));
    await ticks(2);
    off();

    const updates = events.filter((e): e is Extract<ProgressEvent, { type: "step" }> => e.type === "step");
    expect(updates).toHaveLength(1);
    expect(updates[0].step.error).toContain("422");

    vi.useRealTimers();
  });

  it("stops itself when the execution reaches a terminal state", async () => {
    getMock
      .mockResolvedValueOnce(view("running", [step("begin")]))
      .mockResolvedValue({ ...view("failed", [step("begin")]), status: "failed" });

    const events: ProgressEvent[] = [];
    flowProgressService.subscribe(WS, EX, (e) => events.push(e));
    await ticks(2);

    expect(events.at(-1)).toEqual({ type: "end", engineStatus: "failed" });
    // No lingering poll against an execution that will never change again.
    expect(flowProgressService._activeWatches()).toBe(0);
    const callsAtEnd = getMock.mock.calls.length;
    await ticks(3);
    expect(getMock.mock.calls.length).toBe(callsAtEnd);

    vi.useRealTimers();
  });

  it("polls once for many watchers of the same execution", async () => {
    getMock.mockResolvedValue(view("running", [step("begin")]));

    const a: ProgressEvent[] = [];
    const b: ProgressEvent[] = [];
    const offA = flowProgressService.subscribe(WS, EX, (e) => a.push(e));
    await ticks(2);
    const callsBeforeSecondWatcher = getMock.mock.calls.length;
    const offB = flowProgressService.subscribe(WS, EX, (e) => b.push(e));
    await ticks(2);
    offA();
    offB();

    expect(flowProgressService._activeWatches()).toBe(1);
    // Three engineers on one broken run cost what one costs: the second watcher
    // added subscribers, not polls.
    expect(getMock.mock.calls.length).toBeLessThanOrEqual(callsBeforeSecondWatcher + 3);
    // ...and it still gets the current state immediately, rather than an empty
    // run until something next changes.
    expect(b[0]).toMatchObject({ type: "snapshot" });

    vi.useRealTimers();
  });

  it("survives the engine being unreachable and keeps trying", async () => {
    getMock
      .mockRejectedValueOnce(new Error("Kestra is unreachable"))
      .mockResolvedValue(view("running", [step("begin")]));

    const events: ProgressEvent[] = [];
    const off = flowProgressService.subscribe(WS, EX, (e) => events.push(e));
    await ticks(2);
    off();

    expect(events[0]).toMatchObject({ type: "error" });
    // A restarting engine is exactly when someone is watching; the watch must not
    // die on the first failure.
    expect(events.some((e) => e.type === "snapshot")).toBe(true);

    vi.useRealTimers();
  });

  it("gives up polling once nobody is listening", async () => {
    getMock.mockResolvedValue(view("running", [step("begin")]));

    const off = flowProgressService.subscribe(WS, EX, () => {});
    await ticks(1);
    off();
    // The grace period tolerates a page refresh, then the loop stops on its own.
    await ticks(8);
    expect(flowProgressService._activeWatches()).toBe(0);

    vi.useRealTimers();
  });
});
