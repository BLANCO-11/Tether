import { describe, expect, it } from "vitest";
import { runnerEngineStatus, runnerSteps } from "./flow-visibility-runner.js";
import type { RunnerStepResult } from "../repositories/runner-step-result.repo.js";

const t0 = new Date("2026-10-09T10:00:00.000Z");
const t1 = new Date("2026-10-09T10:00:01.500Z");

function row(over: Partial<RunnerStepResult>): RunnerStepResult {
  return {
    id: "r",
    flowExecutionId: "e",
    stepId: "s",
    scope: "",
    status: "succeeded",
    outputJson: null,
    inputJson: null,
    logs: null,
    checksJson: null,
    error: null,
    startedAt: t0,
    endedAt: t1,
    createdAt: t1,
    ...over,
  };
}

describe("runner run view", () => {
  it("shows what each step was given, returned and printed", () => {
    const [v] = runnerSteps([
      row({
        stepId: "load",
        outputJson: { rows: [{ id: 1 }] },
        inputJson: { params: { month: 6 }, inputs: {} },
        logs: "fetched 1 row\n\n",
      }),
    ]);
    expect(v.status).toBe("success");
    expect(v.durationMs).toBe(1500);
    expect(v.output).toEqual({ rows: [{ id: 1 }] });
    expect(v.input).toEqual({ params: { month: 6 }, inputs: {} });
    expect(v.logs.map((l) => l.message)).toEqual(["fetched 1 row"]);
  });

  it("carries what the runner's output checks found, so a hollow step shows its numbers", () => {
    const checks = [{ output: "employees", field: "hours", rows: 3387, empty: 3387, verdict: "failed" }];
    const [v] = runnerSteps([row({ status: "failed", checksJson: checks, error: "step s returned empty data" })]);
    expect(v.checks).toEqual(checks);
    expect(runnerSteps([row({})])[0].checks).toBeNull();
  });

  it("a step skipped after a failure reads as skipped, with no error and no duration of its own", () => {
    const [failed, skipped] = runnerSteps([
      row({ stepId: "a", status: "failed", error: "boom" }),
      row({ stepId: "b", status: "skipped", error: "not run: step a failed" }),
    ]);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("boom");
    expect(skipped.status).toBe("skipped");
    expect(skipped.error).toBeNull();
    expect(skipped.durationMs).toBeNull();
  });

  it("per-item rows (inside a loop) are not drawn as steps of their own", () => {
    expect(runnerSteps([row({ stepId: "a" }), row({ stepId: "a", scope: "0" })])).toHaveLength(1);
  });

  it("the row's status is the run's status — and an unknown one is in doubt, never success", () => {
    expect(runnerEngineStatus("succeeded")).toBe("success");
    expect(runnerEngineStatus("failed")).toBe("failed");
    expect(runnerEngineStatus("running")).toBe("running");
    // control: a status this code does not know must not render green
    expect(runnerEngineStatus("whatever")).toBe("running");
  });
});

describe("loops, branches and approvals in the run view (pi-runtime P5/P7)", () => {
  const loopRecord = row({ stepId: "each", status: "partial", outputJson: { count: 3, succeeded: 2, failed: 1, body: ["write", "send"] }, error: "1 of 3 items failed" });
  const rows = [
    row({ stepId: "find", outputJson: { rows: [1, 2, 3] } }),
    row({ stepId: "write", scope: "1" }),
    row({ stepId: "send", scope: "1" }),
    row({ stepId: "write", scope: "2", status: "failed", error: "bad row" }),
    row({ stepId: "send", scope: "2", status: "skipped", error: "not run: write failed" }),
    row({ stepId: "write", scope: "3" }),
    row({ stepId: "send", scope: "3" }),
    loopRecord,
    row({ stepId: "escalate", status: "not_taken", error: "route took path 2" }),
    row({ stepId: "route", outputJson: { taken: "path 2", why: "total (5) > 0" } }),
    row({ stepId: "ok_to_send", status: "waiting" }),
  ];

  it("draws a loop the way the run view already draws one: items with their path, body steps counted per item", () => {
    const v = runnerSteps(rows);
    const each = v.find((s) => s.stepId === "each")!;
    expect(each.status).toBe("warning");
    expect(each.outcome).toBe("partial");
    expect(each.items?.map((i) => [i.i, i.status, i.path.join(">")])).toEqual([
      [1, "success", "write>send"],
      [2, "failed", "write"],
      [3, "success", "write>send"],
    ]);
    expect(each.items?.[1]?.error).toBe("write: bad row");
    const send = v.find((s) => s.stepId === "send")!;
    expect(send.loop).toBe("each");
    expect(send.perItem).toEqual({ ran: 2, succeeded: 2, failed: 0 });
    expect(v.filter((s) => s.stepId === "send")).toHaveLength(1); // once, not once per item
  });

  it("a branch's other side reads not taken, with why; a waiting approval reads paused", () => {
    const v = runnerSteps(rows);
    const esc = v.find((s) => s.stepId === "escalate")!;
    expect([esc.status, esc.outcome, esc.reason, esc.error]).toEqual(["skipped", "not_taken", "route took path 2", null]);
    expect(v.find((s) => s.stepId === "ok_to_send")?.status).toBe("paused");
  });

  it("run statuses: waiting is paused, partial a warning, rejected and expired cancelled — never success", () => {
    expect(["waiting", "partial", "rejected", "expired"].map(runnerEngineStatus)).toEqual(["paused", "warning", "cancelled", "cancelled"]);
  });
});
