import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import {
  stepBatchSchema,
  stepExecutionService,
  StepError,
  llmStepBodySchema,
  httpStepBodySchema,
} from "../services/step-execution.service.js";
import { stepApprovalService, approvalStepSchema } from "../services/step-approval.service.js";
import { flowExecutionRepo, flowStepRunRepo } from "../repositories/flow-execution.repo.js";
import { envForExecution } from "../services/execution-env.service.js";
import { usageService } from "../services/usage.service.js";
import { refuseUndeclaredUse, type StepUse } from "../services/forge-uses.js";

/**
 * The per-run production opt-in for a step callback (mock-data plan §4).
 *
 * Read from the execution ROW written by `begin` — never from the request
 * body, which a flow authors. Honoured on draft runs only: a live execution
 * reads production regardless, so the override is not even returned there
 * (live-ignores-override, asserted by test).
 */
async function overrideForExecution(flowExecutionId: string, env: "draft" | "live"): Promise<boolean> {
  if (env !== "draft") return false;
  try {
    const row = await flowExecutionRepo.get(flowExecutionId);
    return row?.useProdOverride === true;
  } catch {
    // Fail closed: an unreadable row is a draft run that cannot prove it may
    // read production, so it reads mock (or refuses without one).
    return false;
  }
}

/**
 * `POST /api/steps/{tool,datasource,query,llm,http}` — what Kestra calls back into.
 * archive/kestra-migration/05-lifecycle-and-flows.md §6.1
 *
 * Mounted behind `requireStepToken` and NOTHING ELSE (see that middleware for
 * why the parent API key must not work here). Tenancy comes from
 * `req.stepAuth`, resolved from the execution token — never from the body, and
 * never from a header the caller controls. That is R3, and it is what makes the
 * workspace on these calls unforgeable.
 *
 * `code` and `transform` need no credential and run inside Kestra (R2), so they
 * will never appear here. `query` does appear, for the same reason `datasource`
 * does: an operation reads a tenant database through the read-only DSN, which
 * only Foundry may dial. `agent` also appears, and the reason is worth being
 * precise about: it is not that an agent run needs a tenant credential in the
 * `tool` sense, it is that the runtime is unreachable from Kestra's network and
 * must stay that way. Foundry is the only path to the runtime (R2, R5).
 *
 * `approval` also appears here, for the same reason `agent` does: the flow has to
 * tell Foundry what it is waiting for, and only Foundry can be told.
 *
 * `notify` is the one kind still unimplemented.
 */
export const stepsRouter = Router();

/**
 * A Forge workflow's run may call only what its workflow.json declares (`forge-uses.ts`). Checked here, before any
 * handler, against the job stored when the run started — the step's own library checks it too, but the step's code
 * runs beside that library holding the token, so only this check holds. A Kestra flow's callbacks pass untouched.
 */
stepsRouter.use(
  asyncHandler(async (req, res, next) => {
    const flowExecutionId = req.stepAuth?.flowExecutionId;
    if (!flowExecutionId) return next();
    const body = (req.body ?? {}) as { ref?: unknown; sql?: unknown; datasourceRef?: unknown };
    const ref = typeof body.ref === "string" ? body.ref : "";
    const use: StepUse =
      req.path === "/tool"
        ? { kind: "tool", ref }
        : req.path === "/datasource" || req.path === "/query"
          ? {
              kind: "read",
              ref,
              ...(typeof body.sql === "string" ? { sql: body.sql } : {}),
              ...(typeof body.datasourceRef === "string" ? { datasourceRef: body.datasourceRef } : {}),
            }
          : { kind: "other", what: `POST /api/steps${req.path}` };
    const refused = await refuseUndeclaredUse(flowExecutionId, use);
    if (refused) return res.status(403).json({ error: "undeclared_use", message: `Not allowed: ${refused}.` });
    next();
  }),
);

/** Shared shape so a step failure reads the same regardless of kind. */
function fail(res: import("express").Response, e: unknown) {
  if (e instanceof StepError) {
    return res.status(e.status).json({ error: e.message, detail: e.detail });
  }
  throw e;
}

/**
 * Record the pointer row for this step.
 *
 * Best-effort: a bookkeeping failure must not fail a step whose side effects
 * already happened. The step's real record is Kestra's taskrun (R6); this row
 * only carries the Foundry-side metadata Kestra has no concept of.
 */
async function recordStepRun(
  flowExecutionId: string,
  kind: string,
  body: { stepId?: string; taskrunId?: string },
  readFrom: string | null = null,
) {
  if (!body.stepId) return;
  try {
    await flowStepRunRepo.record({
      flowExecutionId,
      stepId: body.stepId,
      kind,
      kestraTaskrunId: body.taskrunId ?? null,
      ...(readFrom ? { readFrom } : {}),
    });
  } catch (e) {
    console.warn(`[steps] could not record step run ${body.stepId}:`, (e as Error).message);
  }
}

/**
 * Usage (P-OBS): one row per item a tool or read step ran — which tool or reader, test or live (from the run's own
 * namespace, never the request), how long, whether it worked, and tokens when the tool reports them (llm_complete).
 * Recorded after the call, never awaited by it.
 */
async function trackStep(
  workspaceId: string,
  flowExecutionId: string,
  kind: "tool" | "read",
  body: { ref?: string; stepId?: string },
  started: number,
  result: unknown,
): Promise<void> {
  try {
    const [env, ex] = await Promise.all([envForExecution(flowExecutionId), flowExecutionRepo.get(flowExecutionId)]);
    const items = (result as { results?: Array<{ ok?: boolean; data?: unknown }> } | null)?.results ?? [{ ok: false }];
    const each = Math.round((Date.now() - started) / Math.max(1, items.length));
    for (const it of items) {
      const usage = (it.data as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null)?.usage;
      usageService.record({
        workspaceId,
        purpose: env === "live" ? "live" : "test",
        kind,
        source: "step-api",
        actor: ex?.requestedBy ?? null,
        subject: ex?.requestedBySubject ?? null,
        flowId: ex?.flowId ?? null,
        // A builder test of an unsaved workflow has no flow yet: the conversation carries it there on first save.
        sessionId: (ex?.runnerJob as { sessionId?: string } | null)?.sessionId ?? null,
        executionId: flowExecutionId,
        stepId: body.stepId ?? null,
        tool: body.ref ?? null,
        model: (it.data as { model?: unknown } | null)?.model && typeof (it.data as { model?: unknown }).model === "string" ? ((it.data as { model: string }).model) : null,
        tokensIn: usage?.prompt_tokens,
        tokensOut: usage?.completion_tokens,
        durationMs: each,
        ok: it.ok !== false,
      });
    }
  } catch (e) {
    console.warn(`[usage] step not recorded: ${(e as Error).message}`);
  }
}

stepsRouter.post(
  "/tool",
  asyncHandler(async (req, res) => {
  const parsed = stepBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid step body", detail: parsed.error.flatten() });
  }
  const { workspaceId, flowExecutionId } = req.stepAuth!;
  await recordStepRun(flowExecutionId, "tool", parsed.data);
  const t0 = Date.now();
  try {
    const result = await stepExecutionService.tool(workspaceId, parsed.data, flowExecutionId);
    void trackStep(workspaceId, flowExecutionId, "tool", parsed.data, t0, result);
    res.json(result);
  } catch (e) {
    void trackStep(workspaceId, flowExecutionId, "tool", parsed.data, t0, (e as { detail?: unknown }).detail ?? null);
    fail(res, e);
  }
  }),
);

/**
 * `POST /api/steps/approval` — register a human decision request, from inside
 * the running flow, and return.
 *
 * Like `/agent`, the step's RESULT does not come back through this response. It
 * arrives when a person decides and `step-approval.service.ts` resumes the paired
 * `<stepId>_await` Pause. Holding this request open until somebody answered would
 * put a wait measured in HOURS on an HTTP socket.
 *
 * Also like `/agent`, there is no `recordStepRun` call: the service writes its own
 * row into `flow_step_approvals`, which is a different table with a different
 * lifetime — a step run is per taskrun, a decision is per (execution, step) and
 * outlives any retry of the task that asked for it.
 */
stepsRouter.post(
  "/approval",
  asyncHandler(async (req, res) => {
  const parsed = approvalStepSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid step body", detail: parsed.error.flatten() });
  }
  const { flowExecutionId } = req.stepAuth!;
  try {
    res.json(await stepApprovalService.register(flowExecutionId, parsed.data));
  } catch (e) {
    fail(res, e);
  }
  }),
);

/**
 * `POST /api/steps/datasource` — run a named query.
 *
 * ⚠ The environment is resolved from the EXECUTION (Stage 4, D-52), never from
 * the body: `stepBatchSchema` has no field for it, and adding one would let a
 * flow point its own draft run at production. `envForExecution` reads the
 * namespace off the row `begin` wrote from Kestra's authoritative record, so the
 * only way to read production is to be running in the live namespace, which
 * requires an approval bound to the revision.
 */
stepsRouter.post(
  "/datasource",
  asyncHandler(async (req, res) => {
  const parsed = stepBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid step body", detail: parsed.error.flatten() });
  }
  const { workspaceId, flowExecutionId } = req.stepAuth!;
  const env = await envForExecution(flowExecutionId);
  const useProdOverride = await overrideForExecution(flowExecutionId, env);
  const t0 = Date.now();
  try {
    const result = await stepExecutionService.datasource(workspaceId, parsed.data, env, { workspaceId, useProdOverride });
    await recordStepRun(flowExecutionId, "datasource", parsed.data, result.readFrom ?? null);
    void trackStep(workspaceId, flowExecutionId, "read", parsed.data, t0, result);
    res.json(result);
  } catch (e) {
    void trackStep(workspaceId, flowExecutionId, "read", parsed.data, t0, (e as { detail?: unknown }).detail ?? null);
    // The pointer row is still written on failure — a step that failed is a step
    // that ran, and its absence from the run view reads as a step that never
    // started. `readFrom` comes off the error when the service knew it.
    const detail = (e as { detail?: { readFrom?: string } }).detail;
    await recordStepRun(flowExecutionId, "datasource", parsed.data, detail?.readFrom ?? null);
    fail(res, e);
  }
  }),
);

/**
 * `POST /api/steps/query` — run a DB operation.
 *
 * The execution twin of `/datasource` with one difference of origin: an
 * operation's `compiled_sql` was COMPILED server-side from its visual spec
 * (identifiers resolved against the introspected schema, never
 * raw-interpolated, `checkSqlShape`-checked read-only). A request may also
 * carry frozen step SQL (`sql`, approved at build and re-checked here) —
 * otherwise only `<datasource>.<operation>` and the parameter values to bind.
 *
 * Same contract as `/datasource` in every other respect: array batch, mock
 * vs production chosen by execution row and namespace (never by request),
 * `readFrom` reported on every batch, and the pointer row written on failure too.
 */
stepsRouter.post(
  "/query",
  asyncHandler(async (req, res) => {
  const parsed = stepBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid step body", detail: parsed.error.flatten() });
  }
  const { workspaceId, flowExecutionId } = req.stepAuth!;
  const env = await envForExecution(flowExecutionId);
  const useProdOverride = await overrideForExecution(flowExecutionId, env);
  const t0 = Date.now();
  try {
    const result = await stepExecutionService.operation(workspaceId, parsed.data, env, { workspaceId, useProdOverride });
    await recordStepRun(flowExecutionId, "query", parsed.data, result.readFrom ?? null);
    void trackStep(workspaceId, flowExecutionId, "read", parsed.data, t0, result);
    res.json(result);
  } catch (e) {
    void trackStep(workspaceId, flowExecutionId, "read", parsed.data, t0, (e as { detail?: unknown }).detail ?? null);
    // Same pointer-row rule as `/datasource`: a failed step still ran, and its
    // absence from the run view would read as a step that never started.
    const detail = (e as { detail?: { readFrom?: string } }).detail;
    await recordStepRun(flowExecutionId, "query", parsed.data, detail?.readFrom ?? null);
    fail(res, e);
  }
  }),
);

/**
 * `POST /api/steps/llm` — answer a model call from inside the running flow.
 *
 * The step's model and sampling params arrive rendered (Kestra already applied
 * the prompt template); Foundry calls the deployment's gateway and answers the
 * `{text, reasoning_content, …}` envelope the registry's ports read. Tenancy
 * from `req.stepAuth`, never the body (R3) — same contract as `/tool`.
 */
stepsRouter.post(
  "/llm",
  asyncHandler(async (req, res) => {
  const parsed = llmStepBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid step body", detail: parsed.error.flatten() });
  }
  const { workspaceId, flowExecutionId } = req.stepAuth!;
  await recordStepRun(flowExecutionId, "llm", parsed.data);
  try {
    res.json(await stepExecutionService.llm(workspaceId, parsed.data, flowExecutionId));
  } catch (e) {
    fail(res, e);
  }
  }),
);

/**
 * `POST /api/steps/http` — dial a URL from inside the running flow.
 *
 * Foundry classifies the host (`STRICT`) and dials; the engine never sees the
 * URL, the headers, or the secret. Answers `{body, status_code, headers, size}`.
 * Tenancy from `req.stepAuth`, never the body (R3).
 */
stepsRouter.post(
  "/http",
  asyncHandler(async (req, res) => {
  const parsed = httpStepBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid step body", detail: parsed.error.flatten() });
  }
  const { workspaceId, flowExecutionId } = req.stepAuth!;
  await recordStepRun(flowExecutionId, "http", parsed.data);
  try {
    res.json(await stepExecutionService.http(workspaceId, parsed.data, flowExecutionId));
  } catch (e) {
    fail(res, e);
  }
  }),
);
