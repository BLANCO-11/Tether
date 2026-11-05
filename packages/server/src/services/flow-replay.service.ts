import { RUNNER_EXECUTION_PREFIX } from "./flow-runner.service.js";
import { flowExecutionRepo, type FlowExecution } from "../repositories/flow-execution.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { kestra, KestraError, type KestraExecution } from "./kestra-client.service.js";
import { flowApprovalService } from "./flow-approval.service.js";
import { executionTokenService } from "./execution-token.service.js";
import { tenantBudgetService } from "./tenant-budget.service.js";
// The retention number is deliberately NOT read from `config` here. §6.3's whole
// point is that one module owns the window and everything that quotes it —
// this refusal, the plan below, the browser's replay control and the deploy
// script — computes it from that one place.
import { replayWindow, retentionCoupling, type ReplayWindow } from "./retention.js";
import type { FlowModel, FlowStep } from "./flow-compiler.service.js";
import { loopOf } from "./flow-compiler.service.js";
import { reconcileRunning } from "./execution-reconcile.service.js";

/**
 * Replay — *"the capability we don't have today"* (§6.3), phase 6.1.
 * archive/kestra-migration/05-lifecycle-and-flows.md §6.3
 *
 * ── R5: a client names a STEP, never a taskrun ────────────────────────────────
 *
 * §6.3's sequence diagram ends `POST /executions/{id}/replay {taskRunId}`, and a
 * taskrun id is a Kestra identifier. Clients never hold one and must not learn
 * one, so the API takes `{ fromStepId }` — the step's id in Foundry's model — and
 * resolves it against Kestra's taskrun list server-side. Executions are addressed
 * by their FOUNDRY id, workspace-scoped, so there is nothing in a replay request
 * that points at Kestra at all.
 *
 * ── The hazard that shapes everything below: `begin` does not re-run ──────────
 *
 * A Kestra replay from step N rehydrates the outputs of steps before N and starts
 * there. `begin` is task 1 (it is what mints the execution token and passes
 * Foundry's gate), so **a partial replay skips it.** Four consequences, and none
 * is obvious from the outside:
 *
 *   1. **The approval gate is not re-applied.** `begin` is where
 *      `assertMayRunLive` runs. Replay-from-step-2 of a live execution whose
 *      approval has since been revoked would otherwise execute unapproved
 *      behaviour — approval bypass by replay, and it needs no privilege beyond
 *      being able to press a button that already exists.
 *   2. **The execution token is REUSED**, from the rehydrated `outputs.begin`.
 *      A token is burned when its execution reaches a terminal state — including
 *      by `reconcileRunning` — so on the very executions replay is most useful
 *      for (failed ones) the token is usually already dead. Every replayed step
 *      then 401s, which reads as a broken credential.
 *   3. **No `flow_executions` row is created**, because `begin` creates it. The
 *      replay would be invisible in history and would not spend the M3 budget.
 *   4. **An `agent` step at or after the replay point HANGS.** The rehydrated
 *      token names the ORIGINAL execution, so `agentRunService` writes its step
 *      run under that row — and its resume path reads
 *      `flow_executions.kestra_execution_id` from it, so it resumes the original
 *      (already terminal) execution. The replay sits `PAUSED` until
 *      `pauseDuration` expires, which is the failure that looks most like "the
 *      agent is still thinking". See progress/ISSUES.md I-18.
 *
 * So the two modes are genuinely different operations rather than one with a
 * parameter, and they are named that way:
 *
 *   **full** — Kestra replays from the start. `begin` re-runs, so 1–4 all resolve
 *   themselves: the gate re-applies, a fresh token is minted, a new row appears,
 *   the budget is charged. Unconditionally safe, and therefore the default.
 *
 *   **from a step** — the useful one, and the guarded one. Foundry performs 1, 2
 *   and 3 itself and **refuses outright** for 4. Every refusal names the
 *   alternative, because "replay the whole thing" is always available.
 */

export type ReplayMode = "full" | "from_step";

export interface ReplayableStep {
  stepId: string;
  /** Kestra's state for the taskrun, e.g. SUCCESS / FAILED. */
  state: string;
  replayable: boolean;
  /** Why not, when `replayable` is false. */
  reason?: string;
}

export interface ReplayPlan {
  executionId: string;
  /** Kestra's state for the whole execution. */
  engineState: string | null;
  /** False when the execution cannot be replayed at all; `reason` says why. */
  replayable: boolean;
  reason?: string;
  steps: ReplayableStep[];
  /**
   * **How long this run stays replayable, at the point of use** — GAPS §6.3.
   *
   * Retention and the replay window are the same number and nothing said so
   * anywhere a person would see it: the coupling was documented, and the only
   * place it surfaced was the 410 you get after it is already too late.
   *
   * Computed from `flow_executions.started_at` and
   * `config.kestra.retentionDays`, so it is present even when the plan itself is
   * a refusal — a run that cannot be replayed *because* the engine no longer has
   * it should still be able to say what the window was.
   */
  retention: ReplayWindow;
}

export interface ReplayResult {
  mode: ReplayMode;
  /** The Foundry execution row for the replay. */
  execution: FlowExecution | null;
  /**
   * False when a `full` replay started but `begin` had not yet written its row
   * when we stopped waiting — or refused to. Never reported as a silent null.
   */
  lineageRecorded: boolean;
  note?: string;
}

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = statusCode;
  return e;
}

/** Kestra states from which a replay makes sense. Anything else is still going. */
const TERMINAL = new Set(["SUCCESS", "WARNING", "FAILED", "KILLED", "CANCELLED"]);

/**
 * Tasks the compiler emits that are not model steps. A client naming one of
 * these is either confused or probing, and neither deserves a replay: `begin` is
 * a full replay under another name, `complete` runs nothing, and `<id>_await` is
 * half of an agent step whose other half would not have started.
 */
function isReservedTask(taskId: string): boolean {
  return taskId === "begin" || taskId === "complete" || taskId.endsWith("_await");
}

/**
 * Every step that would re-run if the replay started at `from` — the target plus
 * its transitive dependents.
 *
 * Computed from `dependsOn` rather than from ordinal position. Ordinals happen to
 * agree for a linear flow and stop agreeing the moment a flow branches, and the
 * whole point of this set is to decide whether an `agent` step is inside it.
 */
export function downstreamOf(model: FlowModel, from: string): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const s of model.steps) {
    for (const d of s.dependsOn ?? []) {
      dependents.set(d, [...(dependents.get(d) ?? []), s.id]);
    }
  }
  const out = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    for (const next of dependents.get(queue.shift()!) ?? []) {
      if (!out.has(next)) {
        out.add(next);
        queue.push(next);
      }
    }
  }
  return out;
}

/**
 * The Foundry execution row, scoped to one workspace.
 *
 * A missing row and another workspace's row are the SAME answer — 404. Returning
 * 403 for the second would confirm the execution exists, which is a cross-tenant
 * existence oracle over a guessable id space.
 */
async function ownedExecution(workspaceId: string, executionId: string): Promise<FlowExecution> {
  const row = await flowExecutionRepo.get(executionId);
  if (!row || row.workspaceId !== workspaceId) throw httpError("execution not found", 404);
  // A flow-runner run has no Kestra execution to replay from (pi-runtime P3) — refused by name, not a Kestra 404.
  if (row.kestraExecutionId.startsWith(RUNNER_EXECUTION_PREFIX)) {
    throw httpError("this run was made by Foundry's runner (a workflow built with Forge); replaying it is not available yet", 409);
  }
  return row;
}

async function engineExecution(row: FlowExecution): Promise<KestraExecution> {
  try {
    return await kestra.getExecution(row.kestraExecutionId);
  } catch (e) {
    if (e instanceof KestraError && e.status === 404) {
      // Gone, not missing. Retention purges terminal executions after
      // KESTRA_RETENTION_DAYS (O4), and the replay window IS that number — so
      // the useful message names it rather than saying "not found" about a row
      // the client can plainly see in its own history.
      throw httpError(
        `this execution is no longer in the engine. ${retentionCoupling()} ` +
          `(R6 — that is why the two windows are one number.)`,
        410,
      );
    }
    if (e instanceof KestraError) {
      throw httpError(`cannot reach the engine to replay: ${e.message}`, 503);
    }
    throw e;
  }
}

async function modelFor(row: FlowExecution): Promise<FlowModel | null> {
  if (!row.flowId || row.flowRevision == null) return null;
  const rev = await flowRepo.getRevision(row.flowId, row.flowRevision);
  return rev ? (rev.modelJson as FlowModel) : null;
}

/**
 * What a replay of this execution could do — the read a `ReplayControl` renders
 * before anything is started.
 *
 * Every reason a step is not replayable is computed here and shown, rather than
 * discovered by pressing the button. A disabled control with no explanation is
 * how people conclude the feature is broken.
 */
export async function replayPlan(workspaceId: string, executionId: string): Promise<ReplayPlan> {
  const row = await ownedExecution(workspaceId, executionId);

  // §6.3. Computed BEFORE the engine is consulted and attached to every return
  // path below, including the refusals: the run whose window matters most is the
  // one that has already fallen out of it, and a refusal that cannot say what
  // the window was is how "why did this stop working?" gets asked.
  const retention = replayWindow(row.startedAt);

  let engine: KestraExecution;
  try {
    engine = await engineExecution(row);
  } catch (e) {
    return {
      executionId,
      engineState: null,
      replayable: false,
      reason: (e as Error).message,
      steps: [],
      retention,
    };
  }

  const state = engine.state.current;
  if (!TERMINAL.has(state)) {
    return {
      executionId,
      engineState: state,
      replayable: false,
      reason:
        `this execution is still ${state}. Replaying it now would run two copies of the same ` +
        `automation at once — wait for it to finish, or cancel it first.`,
      steps: [],
      retention,
    };
  }

  const model = await modelFor(row);
  // Every step that PAUSES the execution — `agent` and `approval` both compile to
  // an `<id>_await` task, and a partial replay past one hangs (see
  // `partialReplayObstacle`). Kept as a map keyed by id → kind so the refusal can
  // name which kind it is; there was a second pausing kind and there may be one
  // again, and a `Set<string>` here would have to be widened back.
  const pausingSteps = new Map<string, "approval">(
    (model?.steps ?? [])
      .filter((s: FlowStep) => s.kind === "approval")
      .map((s) => [s.id, s.kind as "approval"]),
  );
  const tokenLive = await executionTokenService.hasLiveToken(row.id);

  const steps: ReplayableStep[] = [];
  for (const tr of engine.taskRunList ?? []) {
    if (isReservedTask(tr.taskId)) continue;
    const reason = partialReplayObstacle(model, pausingSteps, tokenLive, tr.taskId, row.status);
    steps.push({
      stepId: tr.taskId,
      state: tr.state.current,
      replayable: !reason,
      ...(reason ? { reason } : {}),
    });
  }

  return { executionId, engineState: state, replayable: true, steps, retention };
}

/**
 * The single place the four hazards in this file's header are turned into a
 * refusal, so `replayPlan` (which explains) and `replay` (which enforces) cannot
 * disagree about what is allowed.
 */
export function partialReplayObstacle(
  model: FlowModel | null,
  pausingSteps: Map<string, "approval">,
  tokenLive: boolean,
  stepId: string,
  /** Foundry's own status for the run, used only to word the credential refusal. */
  foundryStatus: string,
): string | undefined {
  if (!model) {
    return (
      `Foundry does not hold this flow's model — the execution predates the flow being ` +
      `registered, or its revision has been removed — so it cannot check whether a partial ` +
      `replay is safe. Replay the whole execution instead.`
    );
  }
  if (!model.steps.some((s) => s.id === stepId)) {
    return `"${stepId}" is not a step of the revision that ran.`;
  }
  // For each (D-367): a step inside a loop ran once PER ITEM — there is no one taskrun to resume from, and Kestra's replay of
  // one iteration's task would re-run it for that item alone. From the loop itself is allowed: the whole box runs again.
  const inLoop = model.steps.filter((s) => s.kind === "for_each").find((l) => loopOf(model, l.id).some((m) => m.id === stepId));
  if (inLoop) {
    return `"${stepId}" is inside the loop "${inLoop.id}" and ran once per item, so a replay cannot start there. ` +
      `Replay from "${inLoop.id}" — the whole loop runs again — or replay the whole execution.`;
  }
  if (!tokenLive) {
    // Two different situations, and saying "expired" for both reads as a bug when
    // it is the design. A SUCCEEDED run closed its own credential on the way out
    // — `complete` burns it — so a completed run is never partially replayable,
    // permanently and correctly. A failed run's credential is still live until its
    // TTL, which is exactly the §6.3 case this feature exists for.
    return foundryStatus === "succeeded"
      ? `this run completed, and completing closes its execution credential. A partial replay ` +
          `reuses that credential rather than re-running \`begin\`, so there is nothing left to ` +
          `authenticate the replayed steps with. Replay the whole run instead — that mints a ` +
          `fresh one. (Resuming mid-way is for a run that FAILED.)`
      : `this execution's credential has expired, and a partial replay reuses it (the engine ` +
          `rehydrates it rather than re-running \`begin\`). Every replayed step would be ` +
          `rejected. Replay the whole execution instead — that mints a fresh one.`;
  }
  const downstream = downstreamOf(model, stepId);
  const pausingAhead = [...downstream].filter((id) => pausingSteps.has(id));
  if (pausingAhead.length) {
    const id = pausingAhead[0];
    const kind = pausingSteps.get(id);
    // Both kinds pause, and both resume paths are keyed to the ORIGINAL
    // execution — a partial replay rehydrates that execution's credential rather
    // than running `begin`, so the replayed step reports itself under the old id.
    // The failure is the worst-looking kind: the run pauses and simply never
    // continues, which reads as "the agent is still thinking" or "nobody has
    // approved it yet" rather than as a refusal that should have happened here.
    return kind === "approval"
      ? `replaying from here would re-run approval step "${id}", and a partially replayed ` +
          `approval cannot be resumed: the registration resolves to the ORIGINAL execution, whose ` +
          `decision is already recorded and closed, while the new Pause waits for a decision that ` +
          `nobody can now make. The run would wait until its pauseDuration expired. Replay the ` +
          `whole execution instead — that asks the question again, properly.`
      : `replaying from here would re-run agent step "${id}", and a partially replayed ` +
          `agent step cannot be resumed: its resume path is keyed to the original execution, so the ` +
          `replay would pause and never continue (ISSUES.md I-18). Replay the whole execution instead.`;
  }
  return undefined;
}

/**
 * Start a replay.
 *
 * `fromStepId` omitted → a `full` replay, and that is the safe default rather
 * than a lesser one: `begin` re-runs, so the approval gate, the token and the
 * budget all re-apply on their normal paths and nothing here has to reproduce
 * them.
 */
export async function replay(
  workspaceId: string,
  executionId: string,
  opts: { fromStepId?: string } = {},
): Promise<ReplayResult> {
  const row = await ownedExecution(workspaceId, executionId);
  const engine = await engineExecution(row);

  if (!TERMINAL.has(engine.state.current)) {
    throw httpError(
      `this execution is still ${engine.state.current}; replaying it would run two copies at once`,
      409,
    );
  }

  if (!opts.fromStepId) return fullReplay(row, engine);
  return partialReplay(workspaceId, row, engine, opts.fromStepId);
}

/**
 * A full replay. `begin` re-runs, which is what makes this the safe mode — and
 * also means the `flow_executions` row is created by `begin`, not here.
 *
 * So the lineage is stamped afterwards, on the row `begin` wrote. The wait is
 * bounded and its failure is REPORTED (`lineageRecorded: false`) rather than
 * left as a null nobody notices: the two reasons the row never appears are "the
 * engine is slow" and "`begin` refused because the approval was revoked", and the
 * second is something a caller very much wants to hear about.
 */
async function fullReplay(row: FlowExecution, engine: KestraExecution): Promise<ReplayResult> {
  const started = await kestra.replayExecution(row.kestraExecutionId);

  for (let i = 0; i < 40; i++) {
    const created = await flowExecutionRepo.getByKestraId(started.id);
    if (created) {
      const updated = await flowExecutionRepo.update(created.id, {
        replayOfId: row.id,
        replayFromStep: null,
      });
      return { mode: "full", execution: updated ?? created, lineageRecorded: true };
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return {
    mode: "full",
    execution: null,
    lineageRecorded: false,
    note:
      `the engine accepted the replay (${started.id}) but no Foundry row appeared within 10s. ` +
      `Either the engine is slow, or the flow's first task was refused — a revoked or stale ` +
      `approval refuses \`begin\`, which is the gate working. Check the flow's approval state.`,
  };
}

/**
 * A replay from one step. Everything `begin` would have done, done here, and a
 * refusal where it cannot be.
 */
async function partialReplay(
  workspaceId: string,
  row: FlowExecution,
  engine: KestraExecution,
  fromStepId: string,
): Promise<ReplayResult> {
  const model = await modelFor(row);
  // Every step that PAUSES the execution — `agent` and `approval` both compile to
  // an `<id>_await` task, and a partial replay past one hangs (see
  // `partialReplayObstacle`). Kept as a map keyed by id → kind so the refusal can
  // name which kind it is; there was a second pausing kind and there may be one
  // again, and a `Set<string>` here would have to be widened back.
  const pausingSteps = new Map<string, "approval">(
    (model?.steps ?? [])
      .filter((s: FlowStep) => s.kind === "approval")
      .map((s) => [s.id, s.kind as "approval"]),
  );
  const tokenLive = await executionTokenService.hasLiveToken(row.id);

  const obstacle = partialReplayObstacle(model, pausingSteps, tokenLive, fromStepId, row.status);
  if (obstacle) throw httpError(obstacle, 409);

  // Resolve the STEP to a taskrun. The client never sent, and is never told, this
  // identifier (R5).
  const taskRun = (engine.taskRunList ?? []).find((t) => t.taskId === fromStepId);
  if (!taskRun) {
    const ran = (engine.taskRunList ?? [])
      .map((t) => t.taskId)
      .filter((id) => !isReservedTask(id))
      .join(", ");
    throw httpError(
      `step "${fromStepId}" did not run in this execution, so there is nothing to replay from. ` +
        `Steps that ran: ${ran || "(none)"}.`,
      409,
    );
  }
  if (isReservedTask(taskRun.taskId)) {
    throw httpError(
      `"${fromStepId}" is part of the flow's scaffolding rather than a step of the automation. ` +
        `Omit fromStepId to replay the whole execution.`,
      400,
    );
  }

  // ── Gate 2, because `begin` will not run ──────────────────────────────────
  //
  // And the check is sharper than `begin`'s, deliberately. `begin` asks "may the
  // ARMED revision run"; a replay re-runs the revision that ran originally, so
  // the question is whether THAT revision is the approved one. A flow edited and
  // re-approved since would otherwise let an old, superseded revision be
  // re-executed under the new revision's approval.
  //
  // The draft namespace is exempt, exactly as in `begin`: a draft run is how
  // gate 1 is satisfied, and replaying a failed draft run is ordinary authoring.
  const isLive = !row.kestraNamespace.endsWith(".draft");
  if (isLive && row.flowId) {
    const flow = await flowRepo.get(workspaceId, row.flowId);
    if (!flow) throw httpError("the flow this execution belongs to no longer exists", 409);
    const armed = await flowApprovalService.assertMayRunLive(workspaceId, flow);
    if (row.flowRevision != null && row.flowRevision !== armed) {
      throw httpError(
        `this execution ran revision ${row.flowRevision} and revision ${armed} is the approved ` +
          `one. Replaying from a step re-runs the revision that originally ran, and that ` +
          `revision is no longer approved. Start a new run of the approved revision instead.`,
        403,
      );
    }
  }

  // ── M3, because `begin` will not charge it ─────────────────────────────────
  //
  // ⚠ Reconcile before refusing, exactly as `begin` does. `complete` is a task
  // in the flow, so a FAILED execution never reaches it and its row stays
  // `running` for ever (I-10) — and a replay is, by definition, something you do
  // to a failed run. Without this, the fifth failed run in a workspace makes
  // every subsequent replay a 429 that never clears, and the message ("5 in
  // flight") is true and points nowhere.
  //
  // This path had no reconciliation until Stage 5, when `kestra:phase6` hit it:
  // the harness deliberately creates failed runs and then replays them, so it
  // walked straight into the state the reconciliation exists for. `begin` had
  // been masking it — most runs go through `begin` first, and its reconcile
  // cleared the rows before a replay ever asked.
  const budget = await tenantBudgetService.resolve(workspaceId);
  let running = await flowExecutionRepo.countRunning(workspaceId);
  if (running >= budget.maxConcurrentExecutions) {
    running = await reconcileRunning(workspaceId);
  }
  if (running >= budget.maxConcurrentExecutions) {
    throw httpError(
      `workspace has ${running} execution(s) in flight, limit is ` +
        `${budget.maxConcurrentExecutions}`,
      429,
    );
  }

  const started = await kestra.replayExecution(row.kestraExecutionId, taskRun.id);

  // The row Foundry would otherwise never get. Its `kestra_execution_id` is the
  // NEW one, which is what makes the replay render correctly: the step view is
  // assembled from the engine by that id (`flow-visibility.service.ts`), so the
  // page shows the replay's own steps rather than a copy of the original's.
  //
  // ⚠ `flow_step_runs` rows written by the replayed steps still attach to the
  // ORIGINAL row, because the rehydrated token names it. Harmless for display
  // (which reads the engine) and the one path where it is not — agent resume — is
  // refused above. ISSUES.md I-18.
  const execution = await flowExecutionRepo.create({
    workspaceId,
    flowId: row.flowId,
    flowRevision: row.flowRevision,
    kestraNamespace: row.kestraNamespace,
    kestraFlowId: row.kestraFlowId,
    kestraExecutionId: started.id,
    status: "running",
    inputsJson: row.inputsJson,
    replayOfId: row.id,
    replayFromStep: fromStepId,
  });

  return { mode: "from_step", execution, lineageRecorded: true };
}

export const flowReplayService = { replayPlan, replay, downstreamOf };
