import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, itemsOf, lightStep, outcomeOfStatus } from "./flow-run-list.js";
import type { StepView } from "./flow-visibility.service.js";

const step = (over: Partial<StepView> = {}): StepView =>
  ({
    stepId: "load", status: "failed", outcome: "failed", reason: null, kind: "code", platform: false, ref: null, readFrom: null,
    attempt: 2, startedAt: "2026-10-11T09:00:00.000Z", endedAt: "2026-10-11T09:00:01.000Z", durationMs: 1000, request: null,
    responseCode: null, output: { rows: Array(1000).fill({ a: 1 }) } as never, input: { secretish: "x" } as never, checks: null,
    error: "boom", logs: [{ timestamp: "t", level: "INFO", message: "lots" }], kestraTaskrunId: null, auditVerdict: null, oracleScore: null,
    ...over,
  }) as StepView;

describe("the run list's light steps", () => {
  it("keeps what a row prints and never the inputs, outputs or logs", () => {
    const l = lightStep(step({ items: [{ index: 0 } as never], perItem: { ran: 3, failed: 1 } as never, loop: "each" }));
    expect(l).toMatchObject({ stepId: "load", status: "failed", attempt: 2, error: "boom", durationMs: 1000, perItem: { ran: 3, failed: 1 }, loop: "each" });
    expect(l.items).toEqual([]); // a loop marker, not its per-item records
    expect(JSON.stringify(l)).not.toMatch(/rows|secretish|lots/);
  });

  it("cuts a long error", () => {
    expect(lightStep(step({ error: "x".repeat(2000) })).error!.length).toBeLessThan(410);
  });
});

describe("the page cursor", () => {
  it("round-trips the last run shown, and refuses anything else", () => {
    const at = new Date("2026-10-11T09:00:00.000Z");
    const id = "76d8538f-cf5e-4f27-8797-d650accbf7d2";
    expect(decodeCursor(encodeCursor({ startedAt: at, id }))).toEqual({ at, id });
    expect(decodeCursor("not-a-cursor")).toBeUndefined();
    expect(decodeCursor("2026-10-11T09:00:00Z|1; drop table")).toBeUndefined();
    expect(decodeCursor(undefined)).toBeUndefined();
  });
});

describe("a run on the dashboard", () => {
  it("is partly done when the engine says warning, never done", () => {
    expect(outcomeOfStatus("success")).toBe("done");
    expect(outcomeOfStatus("warning")).toBe("partial");
    expect(outcomeOfStatus("failed")).toBe("stopped");
    expect(outcomeOfStatus("cancelled")).toBe("stopped");
    expect(outcomeOfStatus("paused")).toBe("running");
    expect(outcomeOfStatus(null)).toBe("running");
  });

  it("counts its first loop's items that succeeded, out of all of them", () => {
    const loop = step({ stepId: "each", status: "warning", items: [{ status: "success" }, { status: "failed" }, { status: "success" }] as never });
    expect(itemsOf([step({ status: "success" }), loop])).toEqual({ done: 2, total: 3 });
  });

  it("has no item count without a loop", () => {
    expect(itemsOf([step({ status: "success" })])).toBeNull();
  });
});
