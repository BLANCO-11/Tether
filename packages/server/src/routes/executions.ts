import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import crypto from "node:crypto";
import { z } from "zod";
import { config } from "../config/index.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import {
  flowExecutionRepo,
  flowStepRunRepo,
} from "../repositories/flow-execution.repo.js";
import { executionTokenService } from "../services/execution-token.service.js";
import { tenantBudgetService } from "../services/tenant-budget.service.js";
import { requireStepToken } from "../middleware/step-token.middleware.js";
import { kestra, KestraError } from "../services/kestra-client.service.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { triggerRepo } from "../repositories/trigger.repo.js";
import { flowApprovalService } from "../services/flow-approval.service.js";
import { reconcileRunning } from "../services/execution-reconcile.service.js";
import { parseNamespace } from "../services/execution-env.service.js";
import { flowExpectationService } from "../services/flow-expectation.service.js";
import { runRequesterRepo } from "../services/run-requester.js";
import { RUNNER_STEP_STATUSES, runnerStepResultRepo } from "../repositories/runner-step-result.repo.js";
import { flowRunnerService } from "../services/flow-runner.service.js";
import { requireRunnerReport } from "../services/runner-report-key.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Execution lifecycle — the two ends of a Kestra run.
 * archive/kestra-migration/03-architecture.md §5.4, 05-lifecycle-and-flows.md §6.1
 *
 * `begin` exists because schedule triggers moved to Kestra. Kestra now
 * INITIATES scheduled executions, so Foundry no longer has a pre-flight hook and
 * cannot mint a token up front. Instead every flow's first task calls back here,
 * and Foundry gets its gate: approval freshness, manifest fingerprint, and the
 * M3 budget. A refused `begin` fails the execution at step 1 with nothing
 * downstream having run.
 */
export const executionsRouter = Router();

const beginSchema = z.object({
  namespace: z.string().min(1).max(255),
  flowId: z.string().min(1).max(255),
  executionId: z.string().min(1).max(255),
  inputs: z.record(z.unknown()).optional(),
});

/**
 * Authenticate the ONE credential Kestra holds (R2).
 *
 * Constant-time, because this is a bearer secret compared on every scheduled
 * execution — a length-varying early exit is a usable oracle.
 *
 * It is refused outright when unset rather than treated as "no auth required":
 * an empty configured secret would otherwise mean anything that can reach
 * :4000 can mint execution tokens for any workspace.
 */
function kestraCallbackAuthorised(req: import("express").Request): boolean {
  const expected = config.kestra.callbackSecret;
  if (!expected) return false;
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7).trim(), "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Reverse a namespace to its workspace.
 *
 * `<prefix>.<tenant>.<workspace>[.draft]`. Parsed rather than trusted: the
 * result is looked up by BOTH slugs, so a namespace naming a workspace that
 * does not exist under that tenant resolves to nothing and 403s (R4).
 *
 * ⚠ The parse itself lives in `execution-env.service.ts` and is SHARED with the
 * step callback deliberately. Two copies existed and they disagreed on one case
 * — a workspace whose slug is `draft` — with the step callback then reading
 * sandbox fixtures on a live run. Which environment an execution is in decides
 * which data it reads, so it must have exactly one definition.
 */
async function resolveWorkspaceFromNamespace(namespace: string) {
  const parsed = parseNamespace(namespace);
  if (!parsed) return null;
  const ws = await workspaceRepo.getBySlugs(parsed.tenantSlug, parsed.slug);
  return ws ? { workspace: ws, env: parsed.env } : null;
}


executionsRouter.post(
  "/begin",
  // ⚠ WRAPPED 2026-09-06. It was a bare `async` handler with six uncaught
  // awaits (namespace resolution, the flow row, the dedupe read, the token
  // mint, the budget). An unhandled rejection EXITS the process on Node 22 —
  // measured: one bad id on the sibling route below took the API down. This is
  // the route EVERY execution calls, so a database blip here would not fail one
  // run, it would drop the API for every tenant mid-run.
  asyncHandler(async (req, res) => {
  if (!kestraCallbackAuthorised(req)) {
    return res.status(401).json({ error: "unauthorized", message: "invalid Kestra callback credential" });
  }
  const parsed = beginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid begin body", detail: parsed.error.flatten() });
  }
  const { namespace: claimedNamespace, flowId: claimedFlowId, executionId, inputs } = parsed.data;

  // ── R4: the body's namespace is a CLAIM, not a fact ───────────────────────
  //
  // Parsing it and looking it up is not enough. `foundry.default.other-ws` parses
  // fine and resolves fine — so anything that can present the callback secret
  // could name any workspace and be handed that workspace's execution token.
  // Today only Kestra holds the secret and only the compiler emits flows (R8),
  // so it is not reachable; it is still precisely the IDOR R4 exists to forbid,
  // and Phase 5 opens client authoring. See progress/ISSUES.md I-07.
  //
  // The authority is Kestra's own record of the execution: an execution's
  // namespace is set when the flow is deployed, and a flow cannot lie about
  // where it lives. So the namespace is READ FROM KESTRA and the body is only
  // cross-checked.
  let authoritative: { namespace: string; flowId: string; labels: Record<string, string> };
  try {
    const record = await kestra.getExecution(executionId);
    authoritative = {
      namespace: record.namespace,
      flowId: record.flowId,
      labels: Object.fromEntries((record.labels ?? []).map((l) => [l.key, l.value])),
    };
  } catch (e) {
    // Fails CLOSED. An unknown execution id, or a Kestra we cannot reach, must
    // not degrade to trusting the body — that would make the check bypassable by
    // whatever can also cause a timeout.
    const status = e instanceof KestraError && e.status === 404 ? 403 : 503;
    return res.status(status).json({
      error: status === 403 ? "forbidden" : "kestra_unreachable",
      message:
        status === 403
          ? `no Kestra execution "${executionId}"`
          : "cannot verify the execution against Kestra; refusing to trust the request body",
    });
  }

  if (authoritative.namespace !== claimedNamespace || authoritative.flowId !== claimedFlowId) {
    // Loud, because the only two ways to get here are an attempt and a compiler
    // bug, and both need to be seen.
    console.warn(
      `[executions/begin] namespace claim rejected: body said ` +
        `${claimedNamespace}/${claimedFlowId}, Kestra says ` +
        `${authoritative.namespace}/${authoritative.flowId} (execution ${executionId})`,
    );
    return res.status(403).json({
      error: "forbidden",
      message: "namespace does not match the execution it claims to belong to",
    });
  }
  const namespace = authoritative.namespace;
  const flowId = authoritative.flowId;

  const resolved = await resolveWorkspaceFromNamespace(namespace);
  if (!resolved) {
    return res.status(403).json({ error: "forbidden", message: `unknown namespace "${namespace}"` });
  }
  const workspaceId = resolved.workspace.id;

  // ── Gate 2: approval freshness, on the LIVE namespace only ────────────────
  //
  // Phase 3. The primary control is structural — an unapproved flow has no
  // Schedule trigger in Kestra, so it has nothing to fire it (§5.4). This is the
  // second layer, and it is not redundant: the trigger being deployed proves an
  // approval EXISTED, and a manual live start does not go through a trigger at
  // all. The fingerprint check closes the window between a referenced tool
  // changing shape and the staleness sweep noticing (D-17).
  //
  // The DRAFT namespace is deliberately exempt. Draft runs are how gate 1 is
  // satisfied in the first place — requiring approval to perform the test run
  // that approval requires is a lifecycle with no entry point.
  //
  // A flow Foundry does not own (Phase 1's three hand-written flows) is allowed
  // through and recorded with a null `flow_id`. Refusing it would break the
  // falsifiability harness that keeps this migration honest, and it grants
  // nothing: the execution still needs the callback secret, still resolves to
  // one workspace, and still spends that workspace's budget.
  const flowRow = await flowRepo.getByKestraFlowId(workspaceId, flowId);
  let flowRevision: number | null = null;
  if (flowRow) {
    if (resolved.env === "live") {
      try {
        flowRevision = await flowApprovalService.assertMayRunLive(workspaceId, flowRow);
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode ?? 403;
        console.warn(
          `[executions/begin] refused live execution ${executionId} of "${flowRow.name}": ` +
            (e as Error).message,
        );
        return res.status(status).json({ error: "not_approved", message: (e as Error).message });
      }
    } else {
      flowRevision = flowRow.draftRevision;
    }
  }

  // Idempotent: Kestra retries a failed task with the same execution id, and a
  // second token for one execution would leave the first un-burnable.
  const existing = await flowExecutionRepo.getByKestraId(executionId);
  if (existing) {
    const token = await executionTokenService.mint({
      workspaceId,
      flowExecutionId: existing.id,
    });
    return res.json({ token: token.token, flowExecutionId: existing.id, resumed: true });
  }

  // ── M3: the per-workspace concurrency budget ──────────────────────────────
  // Checked HERE rather than in a scheduler, because Kestra owns schedule firing
  // now and `begin` is the only Foundry hook before step 1. Kestra's own
  // flow-level `concurrency` stops a flow overlapping itself; only this stops
  // one workspace starving every other one on a shared instance.
  const budget = await tenantBudgetService.resolve(workspaceId);
  let running = await flowExecutionRepo.countRunning(workspaceId);
  if (running >= budget.maxConcurrentExecutions) {
    // Reconcile before refusing. `complete` is a task in the flow, so an
    // execution that FAILS never reaches it and its row stays `running` forever
    // — each failure permanently consuming a budget slot until the workspace can
    // start nothing at all. Five failed runs against the default budget of five
    // is a workspace that is now bricked by a fairness control.
    //
    // Only on the refusal path: this is the one moment the count has to be
    // right, and Kestra is the system of record for execution state (R6).
    running = await reconcileRunning(workspaceId);
  }
  if (running >= budget.maxConcurrentExecutions) {
    return res.status(429).json({
      error: "budget_exceeded",
      message:
        `workspace has ${running} execution(s) in flight, limit is ` +
        `${budget.maxConcurrentExecutions}`,
      // Says whether this is a configured limit or the fallback, so the fix
      // ("raise the budget" vs "you never set one") is obvious.
      configured: budget.configured,
    });
  }

  // Which trigger fire started this, if any. Read from the execution's LABELS
  // rather than the request body: labels are set by Foundry when it calls
  // `startExecution`, and a flow has no way to write them — so unlike the
  // namespace (I-07), there is no claim here to distrust. Verified against the
  // workspace anyway, so a stale or wrong id links nothing rather than linking
  // across workspaces.
  let triggerFireId: string | null = null;
  const claimedFire = authoritative.labels.foundry_trigger_fire;
  if (claimedFire && UUID_RE.test(claimedFire)) {
    const fire = await triggerRepo.getFire(claimedFire);
    if (fire && fire.workspaceId === workspaceId) triggerFireId = fire.id;
  }

  // ── Who asked for this run — archive/GAPS.md §1.1b, D-70 ──────────────────────────
  //
  // Same shape as `foundry_trigger_fire` above: the label is a POINTER at a
  // Foundry row, verified against this workspace, so a stale or forged id links
  // nothing rather than linking across tenants. The person never travels to
  // Kestra — a label renders in `kestra-ui`, which has no tenant isolation.
  //
  // ⚠ **No pointer means `schedule`, and that is an inference this is entitled
  // to make.** Every Foundry route that starts an execution writes a row first;
  // the only way to reach `begin` without one is Kestra starting the flow from
  // its own Schedule trigger. It is recorded as `schedule` rather than
  // `unknown` — but note the pre-existing rows backfilled by migration 0029 are
  // `unknown`, because for those the absence means "nobody recorded it", which
  // is a different fact.
  let requestedBy: string | null = null;
  let requestedBySubject: string | null = null;
  let requestedByKind = "schedule";
  const claimedRequest = authoritative.labels.foundry_run_request;
  if (claimedRequest && UUID_RE.test(claimedRequest)) {
    const request = await runRequesterRepo.get(claimedRequest);
    if (request && request.workspaceId === workspaceId) {
      requestedBy = request.actor;
      requestedBySubject = request.subject;
      requestedByKind = request.kind;
    } else {
      // A pointer that does not resolve is NOT silently a schedule: something
      // wrote a label this deployment cannot explain, and calling it a schedule
      // would launder it into the one kind that legitimately has no row.
      requestedByKind = "unknown";
      console.warn(
        `[executions/begin] run-request label ${claimedRequest} did not resolve in workspace ${workspaceId}`,
      );
    }
  }

  // ── Per-run production opt-in (mock-data plan §4) ──────────────────────────
  //
  // Transport is the `foundry_use_prod` label the test-run request set;
  // `authoritative.labels` is Kestra's own record of the execution, verified
  // above, so this is not a client claim. It is persisted onto the row HERE
  // and the row is what the step callbacks read (`routes/steps.ts`) — the
  // label is never consulted again. Live executions never carry the label
  // (only test runs set it, and only on the draft namespace), and even a
  // labelled live run would ignore it: the executor honours the override on
  // draft runs only.
  const useProdOverride = authoritative.labels.foundry_use_prod === "1";

  const execution = await flowExecutionRepo.create({
    workspaceId,
    requestedBy,
    requestedBySubject,
    requestedByKind,
    // Copied, not looked up later: `flows.armed_revision` moves on the next
    // approval and this row has to keep saying which revision actually ran.
    flowId: flowRow?.id ?? null,
    flowRevision,
    // Same rule as `flowRevision` above: `flows.name` is editable, so a run's
    // History label must be copied now rather than joined later.
    flowNameSnapshot: flowRow?.name ?? null,
    // Same rule again, applied to the id: `flow_id` above goes NULL if the
    // flow is later deleted (`onDelete: "set null"`), and the Workflow ID
    // column must survive that the same way the name does.
    flowIdSnapshot: flowRow?.id ?? null,
    triggerFireId,
    kestraNamespace: namespace,
    kestraFlowId: flowId,
    kestraExecutionId: executionId,
    status: "running",
    inputsJson: inputs ?? {},
    useProdOverride,
  });

  const token = await executionTokenService.mint({
    workspaceId,
    flowExecutionId: execution.id,
  });

  res.json({
    token: token.token,
    flowExecutionId: execution.id,
    expiresAt: token.expiresAt.toISOString(),
  });
  }),
);

/** One output check from the runner (flow-runner/runner/checks.py). Names and counts only — never a value. */
export const stepCheckSchema = z
  .object({
    output: z.string().max(200),
    field: z.string().max(200).optional(),
    rows: z.number().int().nonnegative().nullable().optional(),
    empty: z.number().int().nonnegative().optional(),
    verdict: z.enum(["ok", "partial", "allowed", "failed"]),
    reason: z.string().max(1000).optional(),
  })
  .strict();

const stepResultSchema = z
  .object({
    status: z.enum(RUNNER_STEP_STATUSES),
    scope: z.string().max(64).optional(),
    output: z.unknown().optional(),
    input: z.unknown().optional(),
    logs: z.string().max(50_000).nullable().optional(),
    checks: z.array(stepCheckSchema).max(2000).optional(),
    error: z.string().max(20_000).nullable().optional(),
    startedAt: z.string().datetime().optional(),
    endedAt: z.string().datetime().optional(),
  })
  .strict();

/**
 * flow-runner reports ONE step's result (plans/pi-runtime-2026-10-09, migration 0082). Execution-token
 * authenticated like `complete`, and the token must own the execution — a run can only write its own record.
 * The body is capped by express's json limit; outputs are redacted in the repo before they are stored.
 */
executionsRouter.post(
  "/:id/steps/:stepId/result",
  requireStepToken,
  // A Forge run: also the runner's own key, which no step holds (runner-report-key.ts).
  asyncHandler(requireRunnerReport),
  asyncHandler(async (req, res) => {
    const { flowExecutionId } = req.stepAuth!;
    if (req.params.id !== flowExecutionId) {
      return res.status(403).json({ error: "forbidden", message: "token does not own this execution" });
    }
    const parsed = stepResultSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid body", detail: parsed.error.flatten() });
    }
    const b = parsed.data;
    await runnerStepResultRepo.record({
      flowExecutionId,
      stepId: req.params.stepId,
      scope: b.scope,
      status: b.status,
      output: b.output,
      input: b.input,
      logs: b.logs ?? null,
      checks: b.checks,
      error: b.error ?? null,
      startedAt: b.startedAt ? new Date(b.startedAt) : null,
      endedAt: b.endedAt ? new Date(b.endedAt) : null,
    });
    res.status(204).end();
  }),
);

/**
 * A runner run reached an approval (pi-runtime P5). It hands back its state and exits: the run WAITS — not running, so
 * it holds no concurrency slot and no token — until someone decides in the approvals inbox, which starts it again with
 * the decision (`flowRunnerService.resume`). The memo is what that replay uses instead of running steps again.
 */
const pauseSchema = z
  .object({
    stepId: z.string().min(1).max(255),
    title: z.string().min(1).max(500),
    preview: z.unknown().optional(),
    ahead: z.array(z.string().max(2000)).max(200),
    memo: z.record(z.string(), z.unknown()),
  })
  .strict();

executionsRouter.post(
  "/:id/pause",
  requireStepToken,
  // A Forge run: also the runner's own key, which no step holds (runner-report-key.ts).
  asyncHandler(requireRunnerReport),
  asyncHandler(async (req, res) => {
    const { flowExecutionId } = req.stepAuth!;
    if (req.params.id !== flowExecutionId) {
      return res.status(403).json({ error: "forbidden", message: "token does not own this execution" });
    }
    const parsed = pauseSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "invalid body", detail: parsed.error.flatten() });
    const b = parsed.data;
    await flowRunnerService.recordPause(flowExecutionId, b);
    res.status(204).end();
  }),
);

const completeSchema = z.object({
  // `partial`: a loop where some items failed; `rejected` / `expired`: an approval nobody gave (runner runs, P5).
  status: z.enum(["succeeded", "failed", "cancelled", "partial", "rejected", "expired"]).default("succeeded"),
});

/**
 * Terminal. Authenticated with the EXECUTION TOKEN, not the callback secret —
 * so only the execution that owns the token can close it, and the token burns
 * itself in the process.
 */
executionsRouter.post(
  "/:id/complete",
  requireStepToken,
  // A Forge run: also the runner's own key, which no step holds (runner-report-key.ts).
  asyncHandler(requireRunnerReport),
  // ⚠ `asyncHandler`: a bare async handler here exits the process on a bad id.
  asyncHandler(async (req, res) => {
  const { flowExecutionId } = req.stepAuth!;
  if (req.params.id !== flowExecutionId) {
    // The token names an execution. Closing a different one would let any live
    // execution terminate any other.
    return res.status(403).json({ error: "forbidden", message: "token does not own this execution" });
  }
  const parsed = completeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid body", detail: parsed.error.flatten() });
  }

  await flowExecutionRepo.update(flowExecutionId, {
    status: parsed.data.status,
    endedAt: new Date(),
    // A runner run's replay state is unredacted step output: it lives only while the run waits.
    runnerMemo: null,
  });
  const burned = await executionTokenService.burnForExecution(flowExecutionId);

  // ── The flow's own claims about its output, checked now — archive/GAPS.md §2.3 ─────
  //
  // Here because this is the moment the run's outputs are freshest and Kestra
  // is demonstrably reachable (it just called us). The read paths evaluate
  // lazily as well, so an engine hiccup at this instant is a delay and not a
  // permanent hole.
  //
  // ⚠ Awaited but never allowed to throw: `evaluate` catches everything and
  // returns. This handler burns the execution token and writes the terminal
  // row — a throw after those would leave a `running` row holding an M3
  // concurrency slot for ever, which is I-10 arriving through a feature that has
  // nothing to do with budgets. Fire-and-forget would be worse still: an
  // unhandled rejection after `res.json` takes the process down.
  const expectations = await flowExpectationService.evaluate(flowExecutionId);

  res.json({
    ok: true,
    status: parsed.data.status,
    tokensBurned: burned,
    // Reported, so a harness can see the verdicts without a second call — and so
    // "declared nothing" and "declared something that has not been checked" are
    // visibly different at the wire.
    expectations: {
      evaluated: expectations.verdicts.length,
      failed: expectations.verdicts.filter((v) => v.status !== "passed").length,
      ...(expectations.deferred ? { deferred: expectations.deferred } : {}),
    },
  });
  }),
);

/** Read-back for tests and the step-graph UI. Pointers only — Kestra holds the I/O. */
executionsRouter.get(
  "/:id",
  requireStepToken,
  // ⚠ `asyncHandler`: a bare async handler here exits the process on a bad id.
  asyncHandler(async (req, res) => {
  const { flowExecutionId } = req.stepAuth!;
  if (req.params.id !== flowExecutionId) {
    return res.status(403).json({ error: "forbidden" });
  }
  const execution = await flowExecutionRepo.get(flowExecutionId);
  if (!execution) return res.status(404).json({ error: "not found" });
  res.json({ execution, stepRuns: await flowStepRunRepo.listByExecution(flowExecutionId) });
  }),
);
