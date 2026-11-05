import { asc, eq, inArray } from "drizzle-orm";
import { redactSecrets } from "@foundry/redact";
import { db } from "../db/index.js";
import { runnerStepResults, type RunnerStepResult } from "../db/schema.js";

export type { RunnerStepResult };

/** flow-runner's per-step results (migration 0082). Redaction happens HERE, on the way in, never on the way out. */
/** What a runner step record can say (0082, widened by 0088 for loops, branches and approvals). */
export const RUNNER_STEP_STATUSES = ["succeeded", "failed", "skipped", "not_taken", "waiting", "partial", "rejected", "expired"] as const;
export type RunnerStepStatus = (typeof RUNNER_STEP_STATUSES)[number];

export const runnerStepResultRepo = {
  /** Upsert on (execution, step, scope): a retried report replaces, never duplicates. */
  async record(row: {
    flowExecutionId: string;
    stepId: string;
    scope?: string;
    status: RunnerStepStatus;
    output?: unknown;
    /** `{params, inputs}` the step was called with, after binding. */
    input?: unknown;
    /** What the step printed. Free text: the runner masks the run's token in it (the one secret a step can reach). */
    logs?: string | null;
    /** The runner's output checks (checks.py) — field names and counts, never a value. */
    checks?: unknown;
    error?: string | null;
    startedAt?: Date | null;
    endedAt?: Date | null;
  }): Promise<void> {
    const values = {
      flowExecutionId: row.flowExecutionId,
      stepId: row.stepId,
      scope: row.scope ?? "",
      status: row.status,
      outputJson: row.output === undefined ? null : (redactSecrets(row.output) as object),
      inputJson: row.input === undefined ? null : (redactSecrets(row.input) as object),
      logs: row.logs ?? null,
      checksJson: row.checks === undefined ? null : (row.checks as object),
      error: row.error ?? null,
      startedAt: row.startedAt ?? null,
      endedAt: row.endedAt ?? null,
    };
    await db
      .insert(runnerStepResults)
      .values(values)
      .onConflictDoUpdate({
        target: [runnerStepResults.flowExecutionId, runnerStepResults.stepId, runnerStepResults.scope],
        set: { status: values.status, outputJson: values.outputJson, inputJson: values.inputJson, logs: values.logs, checksJson: values.checksJson, error: values.error, startedAt: values.startedAt, endedAt: values.endedAt },
      });
  },

  /** The step records of many runs in one query — a page of the run list, never one query per run. */
  async listForExecutions(flowExecutionIds: string[]): Promise<RunnerStepResult[]> {
    if (!flowExecutionIds.length) return [];
    return db
      .select()
      .from(runnerStepResults)
      .where(inArray(runnerStepResults.flowExecutionId, flowExecutionIds))
      .orderBy(asc(runnerStepResults.createdAt));
  },

  async listForExecution(flowExecutionId: string): Promise<RunnerStepResult[]> {
    return db
      .select()
      .from(runnerStepResults)
      .where(eq(runnerStepResults.flowExecutionId, flowExecutionId))
      .orderBy(asc(runnerStepResults.createdAt));
  },
};
