import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { flowVisibilityService, statusOnly } from "../services/flow-visibility.service.js";
import { decodeCursor, flowRunList } from "../services/flow-run-list.js";
import { flowProgressService } from "../services/flow-progress.service.js";
import { flowReplayService } from "../services/flow-replay.service.js";
import { flowExpectationService } from "../services/flow-expectation.service.js";
import { flowResultOf, emptyRowSteps } from "../services/flow-result.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { emailSendRepo } from "../repositories/email-send.repo.js";
import { contentVisibility } from "../services/content-visibility.service.js";
import { HEALTH_RANGES, type HealthRange } from "../services/runs-health.js";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { usageEvents, webFetches } from "../db/schema.js";
import { WEB_FETCH_TOOL_NAME } from "../services/platform-tool-names.js";
import { requireIdentity } from "../middleware/identity.middleware.js";
import { FlowRunnerError, flowRunnerService, RUNNER_EXECUTION_PREFIX } from "../services/flow-runner.service.js";
import { KestraError } from "../services/kestra-client.service.js";
import { stepApprovalService } from "../services/step-approval.service.js";

/**
 * `GET /api/workspaces/:workspaceId/flow-executions` — the step graph's data,
 * plus **replay** (phase 6.1).
 * archive/kestra-migration/progress/phase-2.md · 05 §6.3
 *
 * Parent-API-key authenticated, workspace-scoped.
 *
 * ⚠ **Phase 2 wrote that this router has no write verb "on purpose", because
 * starting, resuming and replaying belong with the flow rather than its
 * history.** Phase 6 revises the replay half of that, and the reason is worth
 * keeping rather than quietly deleting the sentence: a replay's subject is an
 * EXECUTION, not a flow. Its authorisation question is *"does this tenant own
 * this execution?"* — the same question `get()` below already answers — and an
 * execution may have no flow at all (`flow_id` is nullable; Phase 1's
 * hand-written flows still produce real history). Routing it under
 * `/flows/:flowId/...` would need two ids to express one operation and would
 * leave the flowless executions unreachable.
 *
 * Starting and resuming stay where they were. Neither is here.
 *
 * ── Why the client never gets a Kestra id ────────────────────────────────────
 *
 * Executions are addressed by their FOUNDRY id. The Kestra execution id is an
 * internal detail: exposing it invites a client to use it, and the only thing it
 * is useful for is calling Kestra — which no client may do (R5). The workspace
 * check then has exactly one place to live, here, on a Foundry-owned row.
 *
 * Replay honours the same rule at one more level down: §6.3's diagram ends
 * `POST /executions/{id}/replay {taskRunId}`, and a **taskrun id is a Kestra
 * identifier**. This API takes `{ fromStepId }` — the step's id in Foundry's
 * model — and resolves the taskrun server-side.
 */
export const flowExecutionsRouter = Router({ mergeParams: true });

flowExecutionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
    // Only the runs this person may see (rbac-observability): their own, those of their automations, the live runs
    // of published automations — or every run, for an Admin or a Reviewer.
    const viewer = await contentVisibility.viewer(req.user, workspaceId);
    const visible = contentVisibility.runsWhere(viewer);
    // ⚠ A run that acted as another person's own account is listed with its status only (sharing-boundaries D4).
    const shown = <T extends { actsAsSubject: string | null; inputs: Record<string, unknown>; steps?: never[] | unknown[] }>(rows: T[]): T[] =>
      rows.map((r) => (contentVisibility.runDataVisible(viewer, r) ? r : (statusOnly(r as never) as T)));
    const date = (v: string | undefined) => {
      const d = v ? new Date(v) : null;
      return d && !Number.isNaN(d.getTime()) ? d : undefined;
    };
    // The dashboard (2026-10-11): counts and the last few runs, computed here — a mode of this route rather than a
    // route of its own, because it is the same resource read the same way and needs the same permission.
    // "Runs and health" (2026-10-23): a period, live or test runs, and — for those who see beyond their own work —
    // mine or everyone. Anybody else's "everyone" is already only what they may see, so they get no choice.
    if (q.view === "summary") {
      const range = HEALTH_RANGES.includes(q.range as HealthRange) ? (q.range as HealthRange) : "7d";
      const env = q.env === "test" ? "test" : "live";
      const chooses = contentVisibility.choosesRunScope(viewer);
      const scope = chooses && q.scope === "mine" ? "mine" : "everyone";
      const summary = await flowRunList.summary(workspaceId, {
        dayStart: date(q.dayStart) ?? new Date(new Date().setHours(0, 0, 0, 0)),
        recent: Math.min(Number(q.recent ?? 10) || 10, 50),
        range,
        env,
        mine: scope === "mine" ? contentVisibility.runsMineWhere(viewer) : undefined,
        visible,
      });
      return res.json({ ...summary, recent: shown(summary.recent), running: shown(summary.running), scope, choosesScope: chooses });
    }
    // History (2026-10-11): one page of runs, each with its steps in light form, filtered over EVERY run.
    if (q.view === "page") {
      const [page, labels] = await Promise.all([
        flowRunList.page(workspaceId, {
          limit,
          before: decodeCursor(q.before),
          name: q.name?.trim() || undefined,
          from: date(q.from),
          q: q.q?.trim().slice(0, 200) || undefined,
          visible,
        }),
        q.before ? Promise.resolve(undefined) : flowRunList.labels(workspaceId, visible),
      ]);
      return res.json({ ...page, executions: shown(page.executions), ...(labels ? { labels } : {}) });
    }
    res.json({ executions: shown(await flowVisibilityService.list(workspaceId, limit, visible)) });
  }),
);

flowExecutionsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const view = await flowVisibilityService.get(workspaceId, id);
    // 404 for both "no such execution" and "belongs to another workspace". One
    // answer, so this cannot be used to enumerate which ids exist.
    if (!view) return res.status(404).json({ error: "not found" });
    // ⚠ The content guard found this run acted as ANOTHER person's own account: its status, nothing it did.
    if (res.locals.runStatusOnly) return res.json(statusOnly(view));

    // The flow's own claims about this run — archive/GAPS.md §2.3. Lazily evaluated and
    // then stored, so a run whose `complete` callback could not reach the engine
    // is checked the first time anybody opens it rather than never.
    //
    // ⚠ On this route and not inside `flowVisibilityService.get`, deliberately:
    // that function is also called by the progress socket and by `evaluate()`
    // itself, and evaluating inside it would be a re-entrant call.
    const expectations = await flowExpectationService.evaluate(id);

    /**
     * THE RESULT — which step is the answer, and its value.
     *
     * ⚠ Read from the revision THIS execution ran, never the flow's current
     * draft: approval binds to a revision (§6.5), so an armed flow's draft can
     * be several edits ahead and would describe this run by a declaration it
     * never had. `getRevision` is deliberately the unfiltered read — a chat
     * turn writes its revision already `hidden_at`, and an execution of a
     * hidden revision is still a real execution.
     *
     * ⚠ On the route rather than inside `flowVisibilityService.get`, for that
     * function's own stated reason: it also serves the progress socket, where
     * a per-frame revision read would be a query per message.
     *
     * ⚠ It never fails the view. A result is an annotation on a run; a run
     * whose revision cannot be read still has steps, a status and a graph, and
     * losing all of that to report the result is the wrong trade. The failure
     * surfaces as `available: false` with a sentence, which is the module's
     * whole discipline — and it is LOGGED, because a silent catch here is how
     * "the result is just missing sometimes" becomes the reported symptom.
     */
    let declared: { stepId?: unknown; description?: unknown } | null = null;
    let requester: string | null = null;
    try {
      // ⚠ The revision is read off the EXECUTION ROW, not from `view`.
      // `ExecutionView` deliberately does not carry it: the engine revision was
      // taken off every screen on 2026-09-07 (a version is an approval), and
      // putting it back on the public view is an invitation to render it again.
      const row = await flowExecutionRepo.get(id);
      requester = row?.requestedBySubject ?? null;
      if (row?.flowId && row.flowRevision != null) {
        const rev = await flowRepo.getRevision(row.flowId, row.flowRevision);
        const model = (rev?.modelJson ?? {}) as { output?: { stepId?: unknown } };
        declared = model.output ?? null;
      }
    } catch (e) {
      console.warn(
        `[flow-executions] could not read the declared result for execution ${id}: ` +
          `${(e as Error).message}`,
      );
    }
    const result = flowResultOf(declared, view.steps);

    // I-301 (C): a step that ran and produced no rows is said so, beside the steps — never as a failure.
    const viewer = await contentVisibility.viewer(req.user, workspaceId);
    const sharedWithMe = !!(viewer.sharedRuns?.has(id) && requester !== viewer.subject);
    const canShare = !!(viewer.all || (viewer.subject != null && requester === viewer.subject));
    res.json({
      ...view,
      expectations: expectations.verdicts,
      result,
      noRows: emptyRowSteps(view.steps),
      sharedWithMe,
      canShare,
    });
  }),
);

/** Per-person read shares on a run (Phase 5) — People-listed members only; no public links. */
flowExecutionsRouter.get(
  "/:id/shares",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { itemShareService } = await import("../services/item-share.service.js");
    const id = z.string().uuid().parse(req.params.id);
    const viewer = await contentVisibility.viewer(req.user, req.params.workspaceId!);
    res.json({ shares: await itemShareService.list(req.params.workspaceId!, "run", id, viewer) });
  }),
);

flowExecutionsRouter.post(
  "/:id/shares",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { itemShareService } = await import("../services/item-share.service.js");
    const id = z.string().uuid().parse(req.params.id);
    const { subject } = z.object({ subject: z.string().min(1).max(320) }).strict().parse(req.body ?? {});
    const viewer = await contentVisibility.viewer(req.user, req.params.workspaceId!);
    const share = await itemShareService.grant(
      req.params.workspaceId!,
      "run",
      id,
      viewer,
      req.user!.email ?? req.user!.subject,
      subject,
    );
    res.status(201).json({ share });
  }),
);

flowExecutionsRouter.delete(
  "/:id/shares/:subject",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { itemShareService } = await import("../services/item-share.service.js");
    const id = z.string().uuid().parse(req.params.id);
    const viewer = await contentVisibility.viewer(req.user, req.params.workspaceId!);
    await itemShareService.revoke(req.params.workspaceId!, "run", id, viewer, req.params.subject!);
    res.status(204).end();
  }),
);

/**
 * Mint a ticket for `ws://…/ws/flow-execution?ticket=…`.
 *
 * The authorisation happens HERE, on an API-key-authenticated request, by the
 * same `get()` that serves the REST view — so the socket can never reach an
 * execution this route would 404. The ticket is single-use and expires in a
 * minute; it grants a subscription to one execution and nothing else.
 */
flowExecutionsRouter.post(
  "/:id/watch",
  asyncHandler(async (req, res) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const view = await flowVisibilityService.get(workspaceId, id);
    if (!view) return res.status(404).json({ error: "not found" });
    res.json(flowProgressService.mintTicket(workspaceId, id));
  }),
);

// ── Replay (6.1) ─────────────────────────────────────────────────────────────

/**
 * What a replay could do — per step, with the reason when it could not.
 *
 * A GET, and a control renders it BEFORE offering anything. Every obstacle in
 * `flow-replay.service.ts` is computed here and shown: an expired credential, an
 * agent step downstream, a purged execution, a run still in flight. A disabled
 * button with no explanation is how a working feature gets reported as broken.
 */
flowExecutionsRouter.get(
  "/:id/replay",
  asyncHandler(async (req, res) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    res.json(await flowReplayService.replayPlan(workspaceId, id));
  }),
);

/**
 * `GET /:id/calls` — what this run called (2026-10-30). Read from Foundry's own records: every tool call and read a
 * step made through the step API (`usage_events`) and every web address it read (`web_fetches`, with the address and
 * the answer). It replaced ops-api's `api_call_log`, which only ever saw ops-api's own simulated tools — so a connector
 * call, a real email and a web read were never in it. Email delivery itself is `/:id/emails`.
 */
flowExecutionsRouter.get(
  "/:id/calls",
  asyncHandler(async (req, res) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const view = await flowVisibilityService.get(workspaceId, id);
    if (!view) return res.status(404).json({ error: "not found" });
    const [uses, webs] = await Promise.all([
      db
        .select({ id: usageEvents.id, kind: usageEvents.kind, tool: usageEvents.tool, stepId: usageEvents.stepId, ok: usageEvents.ok, durationMs: usageEvents.durationMs, at: usageEvents.at })
        .from(usageEvents)
        .where(and(eq(usageEvents.workspaceId, workspaceId), eq(usageEvents.executionId, id), inArray(usageEvents.kind, ["tool", "read"])))
        .orderBy(desc(usageEvents.at))
        .limit(1000),
      db
        .select()
        .from(webFetches)
        .where(and(eq(webFetches.workspaceId, workspaceId), eq(webFetches.executionId, id)))
        .orderBy(desc(webFetches.at))
        .limit(500),
    ]);
    const calls = [
      // A web read is listed once, with its address, from its own record.
      ...uses
        .filter((u) => u.tool !== WEB_FETCH_TOOL_NAME)
        .map((u) => ({ id: u.id, kind: u.kind as "tool" | "read", name: u.tool ?? "—", stepId: u.stepId, ok: u.ok, durationMs: u.durationMs, at: u.at.toISOString(), detail: null as string | null })),
      ...webs.map((w) => ({
        id: w.id,
        kind: "web" as const,
        name: WEB_FETCH_TOOL_NAME,
        stepId: w.stepId,
        ok: w.ok,
        durationMs: w.durationMs,
        at: w.at.toISOString(),
        detail: w.ok ? `${w.url} · ${w.status ?? "?"} · ${w.bytes ?? 0} bytes` : `${w.url} · ${w.error ?? "refused"}`,
      })),
    ].sort((a, b) => b.at.localeCompare(a.at));
    res.json({ calls, truncated: uses.length >= 1000 || webs.length >= 500 });
  }),
);

/**
 * `GET /:id/emails` — what this run actually emailed, to whom, and whether it worked.
 * email-send-tool T037
 *
 * ── Why this exists as its own read ──────────────────────────────────────────
 *
 * `ToolActivity.tsx` answers "did this run actually do anything?" by reading
 * `api_call_log` **through ops-api** — the simulation. `tether_email_send` is a
 * Foundry route and writes no `api_call_log` row, so without this endpoint a real
 * message to a real mailbox appears **nowhere** on the run page.
 *
 * That is exactly the failure the run page was built to end: a script that emailed
 * 0 of 11 people and exited `clean`. A sender that reports nothing would restage it
 * with a live blast radius.
 *
 * ⚠ A separate route rather than a field on `flowVisibilityService.get`, matching
 * how `/:id/replay` is separated: the run page's main payload is read on every
 * poll, and email rows are read once when a panel opens. Widening the polled
 * payload for a rarely-present list would make every poll pay for it.
 *
 * ⚠ **No body is returned, because none is stored** (FR-009). See
 * `email_sends`'s docblock: the row answers "sent, to whom, did it work" without
 * holding the script's output. There is no redaction pass to apply here for the
 * same reason — recipients, subject and an outcome are the whole payload.
 *
 * 404 for both "no such execution" and "belongs to another workspace", the same
 * single answer `get()` gives, so this cannot enumerate which ids exist.
 */
flowExecutionsRouter.get(
  "/:id/emails",
  asyncHandler(async (req, res) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const view = await flowVisibilityService.get(workspaceId, id);
    if (!view) return res.status(404).json({ error: "not found" });

    const rows = await emailSendRepo.listByExecution(workspaceId, id);
    res.json({
      emails: rows.map((r) => ({
        id: r.id,
        stepId: r.stepId,
        recipients: r.recipients ?? [],
        cc: r.cc ?? [],
        resolvedFrom: r.resolvedFrom,
        subject: r.subject,
        outcome: r.outcome,
        /** The Graph correlation id — NOT an RFC 5322 Message-ID. See mail.service.ts. */
        graphMessageId: r.graphMessageId,
        failureReason: r.failureReason,
        createdAt: r.createdAt,
      })),
    });
  }),
);

const replaySchema = z.object({
  /**
   * A step id from Foundry's model — never a Kestra taskrun id, which a client
   * does not have and must not be given (R5). Omitted → replay the whole
   * execution, which is the safe default: it re-runs `begin`, so the approval
   * gate, a fresh execution token and the M3 budget all re-apply on their normal
   * paths rather than being reproduced by the replay code.
   */
  fromStepId: z.string().min(1).max(255).optional(),
});

flowExecutionsRouter.post(
  "/:id/replay",
  asyncHandler(async (req, res) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const input = replaySchema.parse(req.body ?? {});
    const result = await flowReplayService.replay(
      workspaceId,
      id,
      input.fromStepId ? { fromStepId: input.fromStepId } : {},
    );
    res.status(202).json(result);
  }),
);

/**
 * Stop a live run (personal Phase 2). Foundry id only — never a Kestra id (R5).
 *
 * Forge (`fr-…`) runs go through the flow-runner cancel; compiled Kestra runs reuse the same kill path a
 * rejected gate uses. Identity required: stopping a run records who asked.
 */
flowExecutionsRouter.post(
  "/:id/cancel",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const view = await flowVisibilityService.get(workspaceId, id);
    if (!view) return res.status(404).json({ error: "not found" });
    const row = await flowExecutionRepo.get(id);
    if (!row || row.workspaceId !== workspaceId) return res.status(404).json({ error: "not found" });

    if (row.kestraExecutionId.startsWith(RUNNER_EXECUTION_PREFIX)) {
      try {
        const out = await flowRunnerService.cancel(id);
        return res.status(202).json(out);
      } catch (e) {
        if (e instanceof FlowRunnerError) return res.status(e.statusCode).json({ error: "cancel_refused", message: e.message });
        throw e;
      }
    }

    if (row.status !== "running" && row.status !== "waiting") {
      return res.status(202).json({ cancelled: false, status: row.status });
    }
    try {
      await stepApprovalService._killRejected(id, row.kestraExecutionId);
    } catch (e) {
      // Kill already mirrors 404/409 inside _killRejected; anything else is a real failure.
      if (!(e instanceof KestraError)) throw e;
      await flowExecutionRepo.update(id, { status: "cancelled", endedAt: new Date() });
    }
    return res.status(202).json({ cancelled: true, status: "cancelled" });
  }),
);
