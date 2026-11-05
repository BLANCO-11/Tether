/**
 * Start a run of a Pi-built workflow on Foundry's own runner (plans/pi-runtime-2026-10-09, option A).
 *
 * This is `begin` without Kestra. Everything a step does afterwards goes through the EXISTING step API with the
 * execution token minted here, so tenancy (R3), mock-vs-production (D-52) and captured-vs-delivered mail are all
 * decided exactly as they are for a Kestra run — by the server, from the execution row, never by the request.
 *
 * ⚠ P1 scope: DRAFT runs only. The row's namespace is the workspace's draft namespace, which is what
 * `envForExecution` reads, so a run started here cannot read production or deliver mail however its bundle is
 * written. A live run needs the approval gate and lands in P4/P5.
 */
import { piChatRepo } from "../repositories/pi-chat.repo.js";
import { actsAsSubjectOf, effectiveAccounts, runAsProblems, runsAsEachPerson, type PiRunAs } from "./run-as.service.js";
import { randomUUID } from "node:crypto";
import { config } from "../config/index.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { runnerReportKey } from "./runner-report-key.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { executionTokenService } from "./execution-token.service.js";
import { tenantBudgetService } from "./tenant-budget.service.js";
import { tenantMapper } from "./tenant-mapper.service.js";
import type { RunRequester } from "./run-requester.js";
import { runnerStepResultRepo, type RunnerStepResult } from "../repositories/runner-step-result.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { checkSqlShape, dialectProblems } from "./datasource-query.service.js";
import { runInputsOf } from "./run-inputs.js";
import { auditService } from "./audit.service.js";
import { stepApprovalService } from "./step-approval.service.js";
import { db } from "../db/index.js";
import { flowExecutions, flowStepApprovals, flows } from "../db/schema.js";
import { and, eq, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";
export { runInputsOf, RUN_INPUT_TYPES } from "./run-inputs.js";

/** What Pi's sandbox produces and a revision will store (P3): `workflow.json` plus the step files it names. */
export type PiBundle = {
  workflow: {
    name?: string;
    inputs?: Record<string, unknown>;
    reads?: Record<string, unknown>;
    /** When it runs on its own once approved (P5): a 5-field cron, in `timezone` (default UTC). */
    schedule?: { cron: string; timezone?: string };
    steps: Array<Record<string, unknown>>;
  };
  files: Record<string, string>;
};

export class FlowRunnerError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

/** The prefix that marks an execution as the runner's, in the column Kestra executions use for their own id. */
export const RUNNER_EXECUTION_PREFIX = "fr-";

/** How long a run waits at an approval before it stops as `expired` (agreed 2026-10-10). */
export const APPROVAL_WAIT_MS = Number(process.env.FLOW_APPROVAL_WAIT_MS ?? 7 * 86_400_000);

type Decision = { decision: string; by: string; note: string | null; at: string };
/** What a runner run is started from — stored on its execution row so a paused run can be started again (0088). */
export type RunnerJob = {
  workflow: PiBundle["workflow"];
  files: PiBundle["files"];
  inputs: Record<string, unknown>;
  decisions: Record<string, Decision>;
  /** The builder conversation it came from (usage attribution, P-OBS). */
  sessionId?: string;
  /** The saved chat a TEST run came from: its steps may read that chat's files by name (`foundry.file`). */
  chatId?: string;
  /** Per connected service, the connection the run acts as (run-as.service.ts). Never sent to the runner. */
  runAs?: Record<string, PiRunAs>;
};

/**
 * Hand a run to the runner with a fresh token. A run the runner never accepted is closed here — a `running` row
 * nobody will complete holds a concurrency slot for ever (I-10).
 */
async function dispatch(workspaceId: string, flowExecutionId: string, job: RunnerJob, memo?: Record<string, unknown>): Promise<void> {
  const token = await executionTokenService.mint({ workspaceId, flowExecutionId });
  let res: Response;
  try {
    res = await fetch(`${config.flowRunner.url}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-runner-secret": config.flowRunner.secret },
      body: JSON.stringify({
        flowExecutionId,
        token: token.token,
        // The runner's own key for this run's record — never given to a step (runner-report-key.ts).
        reportKey: runnerReportKey(flowExecutionId),
        serverBase: config.flowRunner.callbackBase,
        workflow: job.workflow,
        files: job.files,
        inputs: job.inputs,
        ...(memo ? { resume: { memo, decisions: job.decisions } } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    await flowExecutionRepo.update(flowExecutionId, { status: "failed", endedAt: new Date() });
    await executionTokenService.burnForExecution(flowExecutionId);
    throw new FlowRunnerError(`the flow runner is unreachable: ${(e as Error).message}`, 503);
  }
  if (res.status !== 202) {
    await flowExecutionRepo.update(flowExecutionId, { status: "failed", endedAt: new Date() });
    await executionTokenService.burnForExecution(flowExecutionId);
    throw new FlowRunnerError(`the flow runner refused the run (${res.status}): ${(await res.text()).slice(0, 300)}`, 502);
  }
}

/**
 * Parameter types a read may declare — exactly the descriptor types the executor binds by (`coerceSqlParams`:
 * integer/number coerced from strings, array → engine array, the rest passed through). A type outside this set
 * would be a descriptor the executor silently ignores.
 */
export const READ_PARAM_TYPES = ["string", "integer", "number", "boolean", "date", "array"] as const;

type ReadDecl = {
  ref?: string;
  kind?: string;
  datasource?: string;
  sql?: string;
  params?: unknown;
};

/**
 * Every declared read, checked by the SAME rules the executor applies when the read runs (pi-runtime, I-1 of the
 * 2026-10-09 failure): `checkSqlShape` (one read-only statement, `$n` contiguous and matching the declared
 * parameters, each parameter described) plus the dialect check a named-query save runs. Before this, a statement
 * the executor always refuses passed verification and failed only at run time — three runs in a row, because the
 * one place a parameter's type was declared did not exist in the workflow format.
 *
 * Problems are returned, not thrown, and each names its read — the person and Pi fix them in workflow.json's terms.
 */
export async function readProblems(workspaceId: string, workflow: PiBundle["workflow"]): Promise<string[]> {
  const problems: string[] = [];
  const reads = (workflow.reads ?? {}) as Record<string, ReadDecl>;
  for (const [name, decl] of Object.entries(reads)) {
    const at = `read "${name}"`;
    if (!decl || typeof decl !== "object") {
      problems.push(`${at}: must be an object`);
      continue;
    }
    if (decl.ref) continue; // a saved reader was checked when it was saved; existence is the verifier's job
    if (!decl.datasource || !decl.sql) {
      problems.push(`${at}: needs either "ref", or "datasource" + "sql"`);
      continue;
    }
    const params = parseReadParams(decl.params);
    if (typeof params === "string") {
      problems.push(`${at}: ${params}`);
      continue;
    }
    const ds = await datasourceRepo.getByName(workspaceId, decl.datasource);
    if (!ds) {
      problems.push(`${at}: there is no datasource "${decl.datasource}" in this workspace`);
      continue;
    }
    const order = params.map((p) => p.name);
    const schema = Object.fromEntries(params.map((p) => [p.name, { type: p.type }]));
    for (const p of checkSqlShape(decl.sql, order, schema)) problems.push(`${at}: ${p.message}`);
    for (const p of await dialectProblems(ds, decl.sql)) problems.push(`${at}: ${p.message}`);
  }
  return problems;
}

/**
 * A read's `params` — an ORDERED list of `{name, type}`, the one place a parameter is declared ($1 is the first).
 * A list, never an object: Postgres `jsonb` re-orders object keys when a revision is stored, which would silently
 * re-map `$1`/`$2` between the test run and the saved flow.
 */
export function parseReadParams(raw: unknown): Array<{ name: string; type: string }> | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return `"params" must be a list of {"name", "type"} in $1, $2 … order`;
  const out: Array<{ name: string; type: string }> = [];
  for (const [i, p] of raw.entries()) {
    if (!p || typeof p !== "object" || typeof (p as { name?: unknown }).name !== "string") {
      return `"params"[${i}] must be {"name": "...", "type": "..."} — got ${JSON.stringify(p)}`;
    }
    const { name, type } = p as { name: string; type?: unknown };
    if (!(READ_PARAM_TYPES as readonly string[]).includes(String(type))) {
      return `parameter "${name}" needs a "type", one of ${READ_PARAM_TYPES.join(", ")} — got ${JSON.stringify(type ?? null)}`;
    }
    out.push({ name, type: String(type) });
  }
  return out;
}


/**
 * Who asked for a runner run. A Forge workflow's schedule is evaluated by Foundry (not Kestra), so a scheduled run
 * DOES pass through here and can say so: `schedule`, stored on the execution row. (`flow_run_requests`, which only
 * Kestra-bound starts write, keeps its own narrower set.)
 */
export type RunnerRequester = Omit<RunRequester, "kind"> & { kind: RunRequester["kind"] | "schedule" };

type StartInput = {
    workspaceId: string;
    flowId?: string | null;
    bundle: PiBundle;
    inputs?: Record<string, unknown>;
    requester: RunnerRequester;
    /**
     * The per-run production opt-in (the same one the old builder's test drawer has). The CALLER gates it to a
     * workspace admin — it needs the person, which only the route has. Here it is recorded on the execution row,
     * which is what every step read consults (`routes/steps.ts` overrideForExecution), and audited. Reads only: a
     * draft run's mail is still captured, never delivered.
     */
    useProductionData?: boolean;
    /** The builder's automatic test after a build turn — labelled so run history can tell it from a person's run. */
    autoTest?: boolean;
    /** A live run of the armed revision (startLiveRun) — the live namespace, and the revision and fire it ran for. */
    live?: { revision: number; triggerFireId: string | null };
    /** The builder conversation a test run came from — so its usage follows the conversation onto its workflow. */
    sessionId?: string | null;
    /** The saved chat a test run came from — its files are readable by the run's steps, before they are saved. */
    chatId?: string | null;
    /** Whose account each connected service is called as (plugins 8.6): the chat's choice, or the approved one. */
    runAs?: Record<string, PiRunAs>;
};

/** Start a run on the runner — the one path a test and a live run share; `live` is the only difference. */
async function start(input: StartInput): Promise<{ flowExecutionId: string; usedProductionData: boolean }> {
  if (!config.flowRunner.secret) {
    throw new FlowRunnerError("the flow runner is not configured — set FLOW_RUNNER_SECRET on the server and the runner", 503);
  }
  if (!input.bundle.workflow?.steps?.length) {
    throw new FlowRunnerError("the workflow has no steps", 400);
  }
  // Refused BEFORE a row or a token exists: a read the executor will refuse is a finding, not a failed run.
  const reads = await readProblems(input.workspaceId, input.bundle.workflow);
  if (reads.length) throw new FlowRunnerError(`the workflow's reads do not pass their checks:\n- ${reads.join("\n- ")}`, 422);
  const runInputs = runInputsOf(input.bundle.workflow, input.inputs, { live: !!input.live });
  if (runInputs.problems.length) {
    throw new FlowRunnerError(`the run's inputs do not fit the workflow:\n- ${runInputs.problems.join("\n- ")}`, 422);
  }
  const ws = await workspaceRepo.get(input.workspaceId);
  if (!ws) throw new FlowRunnerError("workspace not found", 404);
  // The namespace IS the environment (D-52): the step API reads production and the mail route delivers only on the
  // live one — nothing in a request can choose it.
  const namespaces = tenantMapper.namespacesFor(ws);
  const namespace = input.live ? namespaces.live.value : namespaces.draft.value;

  const flowRow = input.flowId ? await flowRepo.get(input.workspaceId, input.flowId) : null;
  if (input.flowId && !flowRow) throw new FlowRunnerError("flow not found", 404);
  // ⚠ Where it lives decides what it runs as (Q3): in My space, its owner's own accounts, whatever was stored. A draft
  // with no workflow yet lives where its chat does — My space unless the chat is in a project.
  const place = flowRow ?? {
    visibility: "private",
    projectId: input.chatId ? ((await piChatRepo.get(input.workspaceId, input.chatId))?.projectId ?? null) : null,
    ownerSubject: input.requester.subject ?? null,
  };
  input = { ...input, runAs: await effectiveAccounts(input.workspaceId, place, { workflow: input.bundle.workflow, files: input.bundle.files, accounts: input.runAs }) };

  // M3 — the same per-workspace budget `begin` enforces. One resource, one limit.
  const budget = await tenantBudgetService.resolve(input.workspaceId);
  const running = await flowExecutionRepo.countRunning(input.workspaceId);
  if (running >= budget.maxConcurrentExecutions) {
    throw new FlowRunnerError(
      `workspace has ${running} execution(s) in flight, limit is ${budget.maxConcurrentExecutions}`,
      429,
    );
  }

  const execution = await flowExecutionRepo.create({
    workspaceId: input.workspaceId,
    requestedBy: input.requester.actor,
    requestedBySubject: input.requester.subject,
    requestedByKind: input.requester.kind,
    actsAsSubject: actsAsSubjectOf(input.runAs, { live: !!input.live, requester: input.requester.subject ?? null, owner: flowRow?.ownerSubject ?? null }),
    flowId: flowRow?.id ?? null,
    flowRevision: input.live ? input.live.revision : (flowRow?.draftRevision ?? null),
    flowNameSnapshot: flowRow?.name ?? null,
    flowIdSnapshot: flowRow?.id ?? null,
    triggerFireId: input.live?.triggerFireId ?? null,
    kestraNamespace: namespace,
    kestraFlowId: flowRow?.kestraFlowId ?? "pi-adhoc",
    kestraExecutionId: `${RUNNER_EXECUTION_PREFIX}${randomUUID()}`,
    status: "running",
    inputsJson: runInputs.values,
    // A live run reads production by its namespace; the override is a test run's opt-in only.
    useProdOverride: !input.live && input.useProductionData === true,
    autoTest: input.autoTest === true,
  });
  if (input.useProductionData === true) {
    // Recorded where the person is known: the step callbacks carry an execution token, not an identity.
    await auditService.record({
      workspaceId: input.workspaceId,
      actor: input.requester.actor,
      operation: "access",
      entity: "datasource",
      description:
        `Production-data test run of ${flowRow ? `flow "${flowRow.name}"` : "an unsaved Pi draft"}: ` +
        `its reads use production instead of test data.`,
      whereText: flowRow ? `Flows · ${flowRow.name}` : "Flows · new automation",
      ...(flowRow ? { whereEntityType: "flow", whereEntityId: flowRow.id } : {}),
      raw: { flowId: flowRow?.id ?? null, flowExecutionId: execution.id, useProductionData: true },
    });
  }
  // Kept (minus the token) so a run that pauses at an approval can be started again exactly as it was (P5).
  const job: RunnerJob = {
    workflow: input.bundle.workflow,
    files: input.bundle.files,
    inputs: runInputs.values,
    decisions: {},
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    // Only a test run reads a chat's files; a live run reads the workspace's Files alone.
    ...(input.chatId && !input.live ? { chatId: input.chatId } : {}),
    ...(input.runAs && Object.keys(input.runAs).length ? { runAs: input.runAs } : {}),
  };
  await flowExecutionRepo.update(execution.id, { runnerJob: job });
  await dispatch(input.workspaceId, execution.id, job);
  return { flowExecutionId: execution.id, usedProductionData: input.useProductionData === true };
}

/**
 * The member an approval step names as its decider (`approval.decider`, an email — sharing-boundaries P1-I3), as their
 * identity subject — read from the run's OWN workflow, resolved against this workspace's members now. An email that is
 * no member's names nobody (the run's own decider still applies), and is logged.
 */
async function namedDecider(flowExecutionId: string, stepId: string): Promise<string | null> {
  const ex = await flowExecutionRepo.get(flowExecutionId);
  const { allNodes } = await import("../pi-builder/types.js");
  const steps = (ex?.runnerJob as RunnerJob | null)?.workflow?.steps as Parameters<typeof allNodes>[0];
  const email = allNodes(steps).find((n) => n.id === stepId)?.approval?.decider?.trim().toLowerCase();
  if (!ex || !email) return null;
  const { workspaceMembers } = await import("../db/schema.js");
  const rows = await db.select({ subject: workspaceMembers.subject, email: workspaceMembers.email }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, ex.workspaceId));
  const hit = rows.find((r) => r.email?.toLowerCase() === email);
  if (!hit) console.warn(`[flow-runner] approval ${stepId} names ${email}, who is not a member of this workspace; its run's own decider decides it`);
  return hit?.subject ?? null;
}

/**
 * A schedule refused to start because the workflow cannot run (409 — something it needs is missing, or its approval
 * no longer holds), counted per workflow (and per person, for "Turn on for me"). After STOP_AFTER in a row it is
 * stopped — the owner's schedule turned off, a person's copy turned off — and they are TOLD, with why, rather than
 * failing silently every tick for ever (sharing-boundaries phase 4, D7). A busy workspace (429) is not counted. In
 * memory: a restart starts the count again, which only delays the stop.
 */
const STOP_AFTER = 3;
const scheduleRefusals = new Map<string, number>();
export async function scheduleRefused(
  r: { key: string; workspaceId: string; flowId: string; flowName: string; person: string | null },
  e: unknown,
): Promise<boolean> {
  if ((e as { statusCode?: number }).statusCode !== 409) return false;
  const n = (scheduleRefusals.get(r.key) ?? 0) + 1;
  scheduleRefusals.set(r.key, n);
  if (n < STOP_AFTER) return false;
  scheduleRefusals.delete(r.key);
  const why = (e as Error).message;
  const { notificationService } = await import("./notification.service.js");
  if (r.person) {
    const { flowActivationService } = await import("./flow-activation.service.js");
    await flowActivationService.set(r.workspaceId, r.flowId, { subject: r.person, actor: "schedule" }, { on: false });
    await notificationService.add({ workspaceId: r.workspaceId, subject: r.person, kind: "schedule_stopped", title: `"${r.flowName}" stopped running for you`, body: `It could not start ${STOP_AFTER} times in a row, so it was turned off for you: ${why}`, href: `/flows/${r.flowId}` });
    return true;
  }
  const flow = await flowRepo.get(r.workspaceId, r.flowId);
  const { flowApprovalService } = await import("./flow-approval.service.js");
  await flowApprovalService.revoke(r.workspaceId, r.flowId, { reason: `Its schedule could not start ${STOP_AFTER} times in a row: ${why}`, revokedBy: "schedule" });
  if (flow?.ownerSubject) {
    await notificationService.add({ workspaceId: r.workspaceId, subject: flow.ownerSubject, kind: "schedule_stopped", title: `"${r.flowName}" was turned off`, body: `Its schedule could not start ${STOP_AFTER} times in a row: ${why}`, href: `/flows/${r.flowId}` });
  }
  return true;
}

export const flowRunnerService = {
  /** A TEST run (draft namespace): test data, mail held. The builder's Test and its automatic test after a build. */
  async startDraftRun(input: Omit<StartInput, "live">): Promise<{ flowExecutionId: string; usedProductionData: boolean }> {
    return start(input);
  },

  /**
   * A LIVE run of a Forge workflow's ARMED revision (pi-runtime P5): production data, mail delivered. Only an approved
   * revision runs — the same gate a compiled flow's live start passes (`assertMayRunLive`: approved, not stale).
   * Started by a person (Run now), a trigger fire or the schedule; `requester` says which.
   */
  async startLiveRun(input: {
    workspaceId: string;
    flowId: string;
    inputs?: Record<string, unknown>;
    requester: RunnerRequester;
    triggerFireId?: string | null;
  }): Promise<{ flowExecutionId: string; revision: number }> {
    const flow = await flowRepo.get(input.workspaceId, input.flowId);
    if (!flow) throw new FlowRunnerError("flow not found", 404);
    if (flow.runtime !== "foundry") throw new FlowRunnerError("only a workflow built with Forge runs on Foundry's runner", 409);
    const { flowApprovalService } = await import("./flow-approval.service.js");
    const revision = await flowApprovalService.assertMayRunLive(input.workspaceId, flow);
    const row = await flowRepo.getRevision(flow.id, revision);
    const model = row?.modelJson as { workflow?: PiBundle["workflow"]; files?: PiBundle["files"]; accounts?: Record<string, PiRunAs> } | undefined;
    if (!model?.workflow || !model.files) throw new FlowRunnerError(`revision ${revision} has no workflow to run`, 409);
    // ⚠ Whose account it acts as must still hold — never a fall back to another connection (plugins 8.6).
    // In My space, its owner's own accounts whatever was stored (Q3) — checked, recorded and run the same way.
    model.accounts = await effectiveAccounts(input.workspaceId, flow, model);
    const runAs = await runAsProblems(input.workspaceId, model.accounts, flow.ownerSubject ?? null);
    if (runAs.length) throw new FlowRunnerError(`this workflow cannot run: ${runAs.join("; ")}. Choose its connection again on the workflow's page.`, 409);
    // ⚠ Each person's own account needs a person: a schedule or a trigger has nobody to act as (sharing-boundaries D4).
    if (runsAsEachPerson(model.accounts) && !input.requester.subject) {
      throw new FlowRunnerError("this workflow runs on each person's own account, and nobody started this run. Run it yourself, or change Runs as on the workflow's page.", 409);
    }
    // ⚠ Everything it needs, checked BEFORE a run exists — never found out at a step after earlier ones sent (phase 4).
    const { readinessOf, needsSentence } = await import("./readiness.service.js");
    const ready = await readinessOf(input.workspaceId, flow.id, { person: input.requester.subject ?? null, revision });
    if (ready && !ready.ready) throw Object.assign(new FlowRunnerError(`it cannot run yet: ${needsSentence(ready)} Nothing ran.`, 409), { needs: ready.needs });
    const r = await start({
      workspaceId: input.workspaceId,
      flowId: flow.id,
      bundle: { workflow: model.workflow, files: model.files },
      runAs: model.accounts,
      inputs: input.inputs,
      requester: input.requester,
      live: { revision, triggerFireId: input.triggerFireId ?? null },
    });
    return { flowExecutionId: r.flowExecutionId, revision };
  },


  /**
   * A run reached an approval (its runner called `/pause`): it now WAITS — no concurrency slot, no live token — with
   * its replay state stored, and an entry in the approvals inbox saying what is about to happen.
   */
  async recordPause(
    flowExecutionId: string,
    p: { stepId: string; title: string; preview?: unknown; ahead: string[]; memo: Record<string, unknown> },
  ): Promise<void> {
    await flowExecutionRepo.update(flowExecutionId, { status: "waiting", runnerMemo: p.memo });
    await stepApprovalService.register(
      flowExecutionId,
      { stepId: p.stepId, resumeTaskId: p.stepId, summary: p.title, context: { preview: p.preview ?? null, ahead: p.ahead } },
      { deciderSubject: await namedDecider(flowExecutionId, p.stepId) },
    );
    await executionTokenService.burnForExecution(flowExecutionId);
  },

  /**
   * Start a waiting run again with a decision (approved, rejected or expired). The runner replays the workflow with
   * the stored outputs — nothing before the approval runs twice — and carries on, or records the refusal and stops.
   * Not subject to the concurrency limit: it continues a run that was already admitted.
   */
  async resume(flowExecutionId: string, decision: { stepId: string; decision: "approved" | "rejected" | "expired"; by: string; note?: string | null }) {
    const ex = await flowExecutionRepo.get(flowExecutionId);
    if (!ex) throw new FlowRunnerError("run not found", 404);
    if (ex.status !== "waiting") throw new FlowRunnerError(`the run is not waiting for a decision (it is ${ex.status})`, 409);
    const job = ex.runnerJob as RunnerJob | null;
    if (!job) throw new FlowRunnerError("this run has no stored job to resume from", 409);
    const next: RunnerJob = {
      ...job,
      decisions: {
        ...(job.decisions ?? {}),
        [decision.stepId]: { decision: decision.decision, by: decision.by, note: decision.note ?? null, at: new Date().toISOString() },
      },
    };
    await flowExecutionRepo.update(flowExecutionId, { status: "running", runnerJob: next });
    await dispatch(ex.workspaceId, flowExecutionId, next, (ex.runnerMemo as Record<string, unknown> | null) ?? {});
  },

  /**
   * Armed Forge workflows whose schedule matches this minute get one live run (pi-runtime P5). Called from the
   * scheduler's tick, so a minute is seen several times: a run already started by the schedule in this minute — in
   * this process or before a restart — is what stops a second, so the check is in the database, not in memory.
   */
  async tickSchedules(now = new Date()): Promise<number> {
    const { cronMatches, minuteOf } = await import("./cron.js");
    const armed = await db
      .select({ id: flows.id, workspaceId: flows.workspaceId, name: flows.name, armedRevision: flows.armedRevision })
      .from(flows)
      .where(and(eq(flows.runtime, "foundry"), isNotNull(flows.armedRevision), inArray(flows.status, ["armed", "draft_pending"])));
    let started = 0;
    for (const f of armed) {
      const row = await flowRepo.getRevision(f.id, f.armedRevision!);
      const schedule = (row?.modelJson as { workflow?: PiBundle["workflow"] } | undefined)?.workflow?.schedule;
      if (!schedule?.cron) continue;
      // ⚠ Runs on each person's own account: its schedule is each person's who turned it on, below — never one run
      // with nobody to act as (sharing-boundaries D4).
      if (runsAsEachPerson((row?.modelJson as { accounts?: Record<string, PiRunAs> } | undefined)?.accounts)) continue;
      let due = false;
      try {
        due = cronMatches(schedule.cron, now, schedule.timezone ?? "UTC");
      } catch (e) {
        console.warn(`[schedule] "${f.name}" has a schedule that cannot be read: ${(e as Error).message}`);
        continue;
      }
      if (!due) continue;
      const already = await db
        .select({ id: flowExecutions.id })
        .from(flowExecutions)
        .where(and(eq(flowExecutions.flowId, f.id), eq(flowExecutions.requestedByKind, "schedule"), gte(flowExecutions.startedAt, minuteOf(now))))
        .limit(1);
      if (already.length) continue;
      try {
        await this.startLiveRun({
          workspaceId: f.workspaceId,
          flowId: f.id,
          requester: { subject: null, actor: "schedule", kind: "schedule" },
        });
        started++;
        scheduleRefusals.delete(f.id);
      } catch (e) {
        // A schedule that cannot start (approval gone stale, budget full) says so where an operator looks.
        console.warn(`[schedule] "${f.name}" did not start: ${(e as Error).message}`);
        await scheduleRefused({ key: f.id, workspaceId: f.workspaceId, flowId: f.id, flowName: f.name, person: null }, e);
      }
    }
    // "Turn on for me" (sharing-boundaries phase 3): each person's copy, on their schedule or the workflow's, as them.
    const { flowActivationService } = await import("./flow-activation.service.js");
    for (const a of await flowActivationService.running()) {
      const when = a.cron ? { cron: a.cron, timezone: a.timezone ?? "UTC" } : a.schedule;
      if (!when) continue;
      let due = false;
      try {
        due = cronMatches(when.cron, now, when.timezone);
      } catch (e) {
        console.warn(`[schedule] "${a.flowName}" for ${a.actor} has a schedule that cannot be read: ${(e as Error).message}`);
        continue;
      }
      if (!due) continue;
      const already = await db
        .select({ id: flowExecutions.id })
        .from(flowExecutions)
        .where(
          and(
            eq(flowExecutions.flowId, a.flowId),
            eq(flowExecutions.requestedByKind, "schedule"),
            eq(flowExecutions.requestedBySubject, a.subject),
            gte(flowExecutions.startedAt, minuteOf(now)),
          ),
        )
        .limit(1);
      if (already.length) continue;
      try {
        await this.startLiveRun({
          workspaceId: a.workspaceId,
          flowId: a.flowId,
          requester: { subject: a.subject, actor: a.actor, kind: "schedule" },
        });
        started++;
        scheduleRefusals.delete(`${a.flowId}:${a.subject}`);
      } catch (e) {
        console.warn(`[schedule] "${a.flowName}" for ${a.actor} did not start: ${(e as Error).message}`);
        await scheduleRefused({ key: `${a.flowId}:${a.subject}`, workspaceId: a.workspaceId, flowId: a.flowId, flowName: a.flowName, person: a.subject }, e);
      }
    }
    return started;
  },

  /** Approvals nobody decided within the wait limit: the run is resumed as `expired` and stops there. */
  async expireStaleApprovals(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - APPROVAL_WAIT_MS);
    const stale = await db
      .select({ a: flowStepApprovals, e: flowExecutions })
      .from(flowStepApprovals)
      .innerJoin(flowExecutions, eq(flowStepApprovals.flowExecutionId, flowExecutions.id))
      .where(
        and(
          eq(flowExecutions.status, "waiting"),
          isNull(flowStepApprovals.decidedAt),
          isNull(flowStepApprovals.expiredAt),
          lt(flowStepApprovals.createdAt, cutoff),
        ),
      );
    const days = Math.round(APPROVAL_WAIT_MS / 86_400_000);
    for (const { a, e } of stale) {
      const note = `No decision within ${days} days`;
      await stepApprovalService.expire(e.id, a.stepId, note);
      await this.resume(e.id, { stepId: a.stepId, decision: "expired", by: "system", note }).catch((err) => {
        console.warn(`[flow-runner] could not expire run ${e.id}: ${(err as Error).message}`);
      });
    }
    return stale.length;
  },

  /**
   * Wait for a run to settle and return its recorded step results. Reads Foundry's own rows — the execution's
   * `status` (closed by the runner's `complete`) and `runner_step_results` — so a test run's verdict is the same
   * record the run page will show, not a second account of it.
   */
  async waitForRun(
    flowExecutionId: string,
    timeoutMs = 300_000,
  ): Promise<{ status: string; timedOut: boolean; steps: RunnerStepResult[] }> {
    const deadline = Date.now() + timeoutMs;
    let status = "running";
    while (Date.now() < deadline) {
      const row = await flowExecutionRepo.get(flowExecutionId);
      status = row?.status ?? "missing";
      if (status !== "running") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return {
      status,
      timedOut: status === "running",
      steps: await runnerStepResultRepo.listForExecution(flowExecutionId),
    };
  },
};

type Check = { output: string; field?: string; rows?: number | null; empty?: number; verdict: string; reason?: string };

/** A passed step's check findings worth stating: a field empty in some rows, and an emptiness the step declared. */
function checkNotes(s: RunnerStepResult): string[] {
  const checks = (Array.isArray(s.checksJson) ? s.checksJson : []) as Check[];
  return checks.flatMap((c) => {
    const what = c.field ? `"${c.output}.${c.field}" empty in ${c.empty} of ${c.rows} rows` : `"${c.output}" empty`;
    if (c.verdict === "partial") return [`note: ${what}`];
    if (c.verdict === "allowed") return [`note: ${what} — allowed by the step: ${c.reason ?? ""}`];
    return [];
  });
}

/**
 * A run that failed ONLY because a step returned empty data — no crash, no refused call (checks.py). The builder
 * treats it differently from a code failure: on an automatic test with default inputs, empty data is as likely to
 * mean "the test data has nothing for these values" as a fault, so it goes to the person, not into Pi's fix loop.
 */
export function failedOnEmptyData(run: { status: string; steps: RunnerStepResult[] }): boolean {
  if (run.status !== "failed") return false;
  const failed = run.steps.filter((s) => s.status === "failed");
  return failed.length > 0 && failed.every((s) => ((Array.isArray(s.checksJson) ? s.checksJson : []) as Check[]).some((c) => c.verdict === "failed"));
}

/** One line per step, for a person and for Pi's fix turn alike. Outputs are previewed, never dumped. */
const RUN_WORD: Record<string, string> = {
  waiting: "is waiting for an approval",
  partial: "finished, but some loop items failed",
  rejected: "stopped — the approval was rejected",
  expired: "stopped — nobody approved it in time",
};

export function describeRun(run: { status: string; timedOut: boolean; steps: RunnerStepResult[] }): string {
  const lines = [run.timedOut ? "Test run did not finish in time." : `Test run ${RUN_WORD[run.status] ?? run.status}.`];
  // The workflow's own level; a loop's items are summarised under it (a thousand items are not a thousand lines).
  const itemFailures = run.steps.filter((s) => s.scope !== "" && s.status === "failed");
  for (const s of run.steps.filter((x) => x.scope === "")) {
    const ms = s.startedAt && s.endedAt ? ` (${s.endedAt.getTime() - s.startedAt.getTime()} ms)` : "";
    const out = s.outputJson as Record<string, unknown> | null;
    if (s.status === "succeeded" || s.status === "partial") {
      const parts = Object.entries(out ?? {})
        .filter(([k]) => k !== "body")
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? `${v.length} item(s)` : JSON.stringify(v)?.slice(0, 120)}`);
      lines.push(`${s.status === "partial" ? "◐" : "✓"} ${s.stepId}${ms} → ${parts.join(", ") || "no outputs"}`);
      for (const note of checkNotes(s)) lines.push(`    ${note}`);
      const body = new Set(((out?.body as string[] | undefined) ?? []));
      for (const f of itemFailures.filter((x) => body.has(x.stepId)).slice(0, 3)) {
        lines.push(`    item ${f.scope}: ${f.stepId} failed — ${(f.error ?? "").split("\n")[0]?.slice(0, 300)}`);
      }
    } else if (s.status === "waiting") {
      lines.push(`⏸ ${s.stepId}: waiting for approval — "${String(out?.title ?? s.stepId)}"`);
    } else if (s.status === "not_taken") {
      lines.push(`↷ ${s.stepId}: not taken (${s.error ?? "another path ran"})`);
    } else if (s.status === "skipped") {
      lines.push(`– ${s.stepId}: ${s.error ?? "not run"}`);
    } else if (s.status === "rejected" || s.status === "expired") {
      lines.push(`✗ ${s.stepId}: ${s.status}${s.error ? ` — ${s.error}` : ""}`);
    } else {
      lines.push(`✗ ${s.stepId}${ms}: ${s.error ?? s.status}`);
    }
  }
  return lines.join("\n");
}

/**
 * The ONE sentence a person reads about a test (2026-10-13). `describeRun` and the verifier's output are written for
 * Forge — step ids, check codes, "VERIFY FAIL" — and they used to be the banner itself, so a refused read reached the
 * person as a paragraph about SQLite plans. They stay available behind "Details"; this is what is shown.
 */
export const CHECKS_REFUSED =
  "The workflow did not pass its checks, so the test did not start. Forge is told what failed.";

export function summariseRun(run: { status: string; timedOut: boolean; steps: RunnerStepResult[] }, emptyData = false): string {
  if (run.timedOut) return "The test run did not finish in time.";
  if (run.status === "succeeded") return "The test run passed.";
  if (run.status === "waiting") return "The test run is waiting for an approval.";
  if (run.status === "rejected") return "The test run stopped: the approval was rejected.";
  if (run.status === "expired") return "The test run stopped: nobody approved it in time.";
  if (run.status === "partial") return "The test run finished, but some items failed.";
  const failed = [...new Set(run.steps.filter((s) => s.scope === "" && s.status === "failed").map((s) => s.stepId))];
  const at = failed.length ? ` at step ${failed.join(", ")}` : "";
  return emptyData ? `The test ran, but a step returned empty data${at}.` : `The test run failed${at}.`;
}
