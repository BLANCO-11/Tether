/**
 * The runner's own credential for a run's RECORD (plugins phase 9, P9-I2, 2026-10-29).
 *
 * A Forge run's execution token reaches the step's code: the `foundry` library needs it to read and call. So the token
 * alone cannot also be what writes the run's record — with it a step could post another step's result, pause its run
 * at an approval it made up, or close the run as succeeded. Those three calls (`/api/executions/:id/steps/:stepId/result`,
 * `/pause`, `/complete`) also need this key, which the runner's coordinating process holds and never hands a step
 * (`run_one.py` builds the step's context without it; steps run as another uid under `hidepid`).
 *
 * Derived, not stored: HMAC of the execution id under the runner secret, so nothing new is kept and a key works for
 * one run only. A Kestra flow's callbacks are untouched — its tasks are compiled YAML, not a person's code.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config/index.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { RUNNER_EXECUTION_PREFIX } from "./flow-runner.service.js";

export const RUNNER_REPORT_HEADER = "x-runner-report";

export function runnerReportKey(flowExecutionId: string, secret = config.flowRunner.secret): string {
  return createHmac("sha256", secret).update(`report:${flowExecutionId}`).digest("hex");
}

/** Constant-time; an unset secret or a missing header never matches. */
export function reportKeyMatches(flowExecutionId: string, presented: string | undefined, secret = config.flowRunner.secret): boolean {
  if (!secret || !presented) return false;
  const want = Buffer.from(runnerReportKey(flowExecutionId, secret));
  const got = Buffer.from(presented);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** After `requireStepToken`: a runner execution's record is written only with its report key. */
export async function requireRunnerReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  const flowExecutionId = req.stepAuth?.flowExecutionId;
  if (!flowExecutionId) return next();
  const ex = await flowExecutionRepo.get(flowExecutionId);
  if (!ex || !ex.kestraExecutionId.startsWith(RUNNER_EXECUTION_PREFIX)) return next();
  if (reportKeyMatches(flowExecutionId, req.header(RUNNER_REPORT_HEADER))) return next();
  res.status(403).json({ error: "forbidden", message: "only the runner writes a run's record — a step cannot" });
}
