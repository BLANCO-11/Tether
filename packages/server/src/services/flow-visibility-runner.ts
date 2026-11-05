/**
 * The run view of a flow-runner execution (pi-runtime P4, plans/pi-runtime-2026-10-09).
 *
 * A runner run has no Kestra record — its `kestra_execution_id` is `fr-<uuid>` and nothing in the engine knows it. Its
 * steps are Foundry's own rows (`runner_step_results`, written by the runner as each step settles) and its status is
 * the execution row the runner closes with `complete`. Asking Kestra for it, as `flowVisibilityService.get` did, gets
 * a 404 and an empty step list — a run that worked, shown as a run with no evidence.
 *
 * Pure: rows in, view out, so the mapping is testable without a database or an engine.
 */
import type { RunnerStepResult } from "../repositories/runner-step-result.repo.js";
import type { StepLog, StepStatus, StepView } from "./flow-visibility.service.js";

/** The execution row's status → the view's live status. An unknown row status is IN DOUBT, never success. */
export function runnerEngineStatus(rowStatus: string): StepStatus {
  switch (rowStatus) {
    case "succeeded":
      return "success";
    case "failed":
      return "failed";
    case "cancelled":
    case "rejected":
    case "expired":
      return "cancelled";
    case "partial":
      return "warning";
    case "waiting":
      return "paused";
    default:
      return "running";
  }
}

const STEP_STATUS: Record<string, StepStatus> = {
  succeeded: "success",
  failed: "failed",
  skipped: "skipped",
  not_taken: "skipped",
  waiting: "paused",
  partial: "warning",
  rejected: "cancelled",
  expired: "cancelled",
};

/** A step's printed output as log lines. Blank lines are dropped; the order is the order printed. */
function logLines(logs: string | null, at: Date | null): StepLog[] {
  if (!logs) return [];
  const timestamp = (at ?? new Date(0)).toISOString();
  return logs
    .split("\n")
    .filter((l) => l.trim())
    .map((message) => ({ timestamp, level: "INFO", message }));
}

/** One record as a view. */
function viewOf(r: RunnerStepResult): StepView {
  const notRun = r.status === "skipped" || r.status === "not_taken";
  return {
    stepId: r.stepId,
    status: STEP_STATUS[r.status] ?? "running",
    outcome: r.status,
    reason: notRun ? r.error : null,
    kind: "code",
    platform: false,
    ref: null,
    readFrom: null,
    attempt: 1,
    startedAt: notRun ? null : r.startedAt?.toISOString() ?? null,
    endedAt: notRun ? null : r.endedAt?.toISOString() ?? null,
    durationMs: !notRun && r.startedAt && r.endedAt ? r.endedAt.getTime() - r.startedAt.getTime() : null,
    request: null,
    responseCode: null,
    output: (r.outputJson as StepView["output"]) ?? null,
    input: (r.inputJson as StepView["input"]) ?? null,
    checks: (r.checksJson as StepView["checks"]) ?? null,
    // A step that did not run carries its reason in `reason`, not as an error of its own.
    error: notRun ? null : r.error,
    logs: logLines(r.logs, r.endedAt),
    kestraTaskrunId: null,
    auditVerdict: null,
    oracleScore: null,
  };
}

const RANK: Record<StepStatus, number> = { failed: 7, cancelled: 6, warning: 5, running: 4, paused: 3, created: 2, success: 1, skipped: 0 };
const worst = (xs: StepStatus[]): StepStatus => xs.reduce<StepStatus>((a, b) => (RANK[b] > RANK[a] ? b : a), "skipped");

/** Whether a record is a loop's own (its output carries the item counts the runner writes for a loop). */
function isLoopRecord(r: RunnerStepResult): boolean {
  const o = r.outputJson as Record<string, unknown> | null;
  return !!o && typeof o === "object" && "count" in o && "succeeded" in o && "failed" in o;
}

/**
 * The run's steps, in the order the runner reported them (the workflow's order), in the SAME shape the run view
 * already draws a Kestra loop with (flow-visibility-loops.ts): a loop's view carries `items` — per item its status,
 * the steps that ran for it, its first error — and each step inside the loop appears once, with `perItem` counts and
 * `loop` naming its loop. Item records are scoped "1", "2" (and "1.2" inside a nested loop).
 */
export function runnerSteps(rows: RunnerStepResult[]): StepView[] {
  const top = rows.filter((r) => r.scope === "");
  const inItems = rows.filter((r) => r.scope !== "");
  const out: StepView[] = [];
  for (const r of top) {
    const v = viewOf(r);
    if (!isLoopRecord(r)) {
      out.push(v);
      continue;
    }
    // The items of THIS loop: the runner names the loop's body (every step inside it, recursively) on its record.
    const body = new Set(((r.outputJson as { body?: unknown }).body as string[] | undefined) ?? []);
    const mine = inItems.filter((x) => body.has(x.stepId));
    const byItem = new Map<number, RunnerStepResult[]>();
    for (const x of mine) {
      const i = Number(x.scope.split(".")[0]);
      if (!byItem.has(i)) byItem.set(i, []);
      byItem.get(i)!.push(x);
    }
    v.items = [...byItem.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, recs]) => {
        const ran = recs.filter((x) => x.status !== "skipped" && x.status !== "not_taken");
        const failed = recs.find((x) => x.status === "failed");
        return {
          i,
          status: worst(ran.map((x) => STEP_STATUS[x.status] ?? "running")),
          path: ran.filter((x) => x.scope === String(i)).map((x) => x.stepId),
          error: failed ? `${failed.stepId}: ${failed.error ?? "failed"}` : null,
          result: null,
        };
      });
    out.push(v);
    // Each step inside the loop once, counted over its items.
    const ids = [...new Set(mine.map((x) => x.stepId))];
    for (const id of ids) {
      const recs = mine.filter((x) => x.stepId === id);
      const ranRecs = recs.filter((x) => x.status !== "skipped" && x.status !== "not_taken");
      const body = viewOf(recs[recs.length - 1]!);
      out.push({
        ...body,
        status: ranRecs.length ? worst(ranRecs.map((x) => STEP_STATUS[x.status] ?? "running")) : "skipped",
        output: null,
        input: null,
        loop: r.stepId,
        perItem: {
          ran: ranRecs.length,
          succeeded: ranRecs.filter((x) => x.status === "succeeded").length,
          failed: ranRecs.filter((x) => x.status === "failed").length,
        },
      });
    }
  }
  return out;
}
