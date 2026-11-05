import type { SQL } from "drizzle-orm";
/**
 * Gate 3 — a human decision on one execution, mid-flight.
 * 05 §6.5 · Stage 3
 *
 * `flow-approval.service.ts` had a comment where this gate should have been.
 * The two are genuinely different questions and both are needed:
 *
 *   gate 2  a REVISION may run unattended       once, before arming
 *   gate 3  THIS BATCH may proceed              every run, mid-flight
 *
 * An armed flow with an approval step still stops for a person every time. That
 * is the point — arming says the automation is trustworthy, not that today's
 * particular 11 recipients are the right ones.
 *
 * ── The wait is in Kestra's database ─────────────────────────────────────────
 *
 * A person takes hours. Holding the decision in this process — a promise, a
 * socket, an in-memory map — loses it on the next deploy, and the run is then
 * orphaned with no record of what it was waiting for. So the flow PAUSES, which
 * is engine state, and this service only ever writes a row and later posts a
 * resume. The exit criterion follows from the shape rather than from care: kill
 * the API server while a run is waiting and restart it, and the run is still
 * waiting, because nothing about the wait was ever here.
 *
 * ── ⚠ Reject KILLS, it does not resume ───────────────────────────────────────
 *
 * This is the one decision in the file that must not be got wrong. Resuming with
 * `decision: "rejected"` would un-pause the execution and every downstream step
 * would then run — the emails would go out, having been rejected. Kestra's Pause
 * has no "resume down a different branch" and the compiler emits no conditional
 * task, so there is nothing on the resume path that would read the decision and
 * stop. A rejected run is therefore KILLED, and the send never happens because
 * the execution no longer exists to perform it.
 *
 * The corollary is that a rejected run never reaches its flow's `complete` task,
 * so nothing would release its M3 budget slot (I-10) — five rejections would
 * brick a workspace through a fairness control. `decide()` closes the Foundry row
 * itself rather than leaving it to `begin`'s reconcile, which only runs on the
 * refusal path, i.e. after the damage.
 *
 * ── ⚠ Not separation of duties ───────────────────────────────────────────────
 *
 * `decidedBy` is self-asserted. One shared `PARENT_API_KEY`, no user model — the
 * same caveat as gate 2's `approverUserId` (I-13). What this provides is that the
 * action does not happen until somebody deliberately says so, and that the claim
 * is recorded. It does not authenticate anybody, and it cannot tell two people
 * apart. Do not describe it as more.
 *
 * ── One thing waits for a person, and there used to be two ──────────────────
 *
 * `kind = "gate"`     an `approval` step. The Kestra Pause IS the wait; approving
 *                     resumes it and rejecting kills the execution.
 *
 * ⚠ There was a second kind — an external agent runtime's own question, parked
 * at `awaiting_input`, whose Kestra Pause was **already open** and stayed open
 * because the answer went to that runtime rather than to Kestra. It went with
 * the runtime, and `kind` stays a column so a second such thing needs no
 * migration.
 *
 * They shared this table because they are the same thing to the person doing the
 * work — one inbox, one (execution, step) key, one already-decided 409 — and
 * they branch on a COLUMN rather than on the shape of a JSON blob, so the branch
 * is greppable and a new reader cannot mistake one for the other.
 */

import { z } from "zod";
import { and, eq, isNull, isNotNull, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowStepApprovals, flowExecutions, flows } from "../db/schema.js";
import { flowExecutionRepo, flowStepRunRepo } from "../repositories/flow-execution.repo.js";
import { kestra, KestraError } from "./kestra-client.service.js";
import { redactSecrets } from "../utils/redact.js";

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/** What the flow's registration task posts. Mirrors `agentStepSchema`. */
export const approvalStepSchema = z.object({
  stepId: z.string().min(1).max(255),
  taskrunId: z.string().max(255).optional(),
  executionId: z.string().max(255).optional(),
  resumeTaskId: z.string().min(1).max(255),
  /** builder-behaviour P7: the loop item this request is about (its row number), absent outside a loop. */
  scope: z.string().max(64).optional(),
  /** Rendered by the flow at the moment it paused. */
  summary: z.string().min(1).max(4000),
  context: z.unknown().optional(),
});

/**
 * What a CLIENT may send when deciding.
 *
 * ⚠ `decidedBy` is deliberately absent and the schema is **`.strict()`**, so a
 * body still carrying it is a 400 naming the field (Stage 9.1). The route
 * supplies it from the verified identity. Dropping an accepted field silently
 * would leave a request that looks like it worked and a record that names
 * somebody else.
 */
export const decideSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    note: z.string().max(2000).optional(),
    /**
     * ⚠ **Refused, never ignored.** It belonged to the second kind of row this
     * table used to carry and is accepted by no kind now — so a caller sending
     * it is one that believes otherwise, and a field that is accepted and
     * discarded reads, to the next person, as a field that works.
     */
    answers: z
      .record(z.union([z.string().max(4000), z.array(z.string().max(400)).max(50)]))
      .optional(),
  })
  .strict();

/** The service's input: the client's fields plus the identity the route verified. */
export type DecideInput = z.infer<typeof decideSchema> & { decidedBy: string };

export type PendingApproval = {
  id: string;
  flowExecutionId: string;
  stepId: string;
  /** `gate` — the only kind. The second one went with the agent runtime. */
  kind: string;
  summary: string;
  context: unknown;
  answers: unknown;
  decision: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  appliedAt: Date | null;
  /** Closed with no decision — the run stopped waiting. See the column comment. */
  expiredAt: Date | null;
  note: string | null;
  createdAt: Date | null;
};

/**
 * Redacted on the way OUT, never on the way in (D-07's rule, applied here).
 *
 * The context is already inside Foundry's database and Kestra already persisted
 * the task output it came from, so scrubbing at write time would destroy the
 * audit trail without closing anything. `resumeTaskId` is dropped from the public
 * shape for R5: it is Kestra addressing, and a client decides by naming the
 * APPROVAL, never the task.
 *
 */
function toPublic(r: typeof flowStepApprovals.$inferSelect): PendingApproval {
  return {
    id: r.id,
    flowExecutionId: r.flowExecutionId,
    stepId: r.stepId,
    kind: r.kind,
    summary: r.summary,
    context: redactSecrets(r.context),
    answers: redactSecrets(r.answers),
    decision: r.decision,
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt,
    appliedAt: r.appliedAt,
    expiredAt: r.expiredAt,
    note: r.note,
    createdAt: r.createdAt,
  };
}

/** The paused taskrun to resume — resolved by NAME against the execution. */
export function pausedTaskrunId(
  ex: { taskRunList?: Array<{ id: string; taskId: string; parentTaskRunId?: string | null; value?: string | null; state: { current: string } }> },
  resumeTaskId: string,
  registeredBy?: string | null,
): string | undefined {
  const runs = ex.taskRunList ?? [];
  // builder-behaviour P7 (P4-I4): inside a loop every item has a paused task of this name — the one this request is about is the
  // task of THE SAME ITEM as the task that registered it: the same parent, and the same item `value` (measured 2026-10-04: in a loop
  // body every item's tasks share ONE parent, the loop's own run, told apart only by `value` — matching the parent alone resumed
  // whichever item's pause came first, so a decision landed on another item). Never "the first by name".
  const reg = registeredBy ? runs.find((t) => t.id === registeredBy) : undefined;
  if (reg?.parentTaskRunId) return runs.find((t) => t.taskId === resumeTaskId && t.parentTaskRunId === reg.parentTaskRunId && (t.value ?? null) === (reg.value ?? null))?.id;
  return runs.find((t) => t.taskId === resumeTaskId)?.id;
}

export const stepApprovalService = {
  /**
   * Register a request, from inside the running flow.
   *
   * Idempotent on (execution, step): Kestra retries a failed `http.Request`, so
   * this endpoint can legitimately be called twice for the same taskrun. Without
   * the upsert an approver sees the same question twice and answering one leaves
   * the other pending for ever.
   *
   * An already-DECIDED row is returned untouched rather than reopened — a retry
   * arriving after somebody answered must not silently discard their answer.
   */
  async register(flowExecutionId: string, input: z.infer<typeof approvalStepSchema>, opts: { deciderSubject?: string | null } = {}) {
    const rows = await db
      .insert(flowStepApprovals)
      .values({
        flowExecutionId,
        stepId: input.stepId,
        resumeTaskId: input.resumeTaskId,
        scope: input.scope ?? "",
        ...(input.taskrunId ? { taskrunId: input.taskrunId } : {}),
        summary: input.summary,
        context: (input.context ?? null) as never,
        ...(opts.deciderSubject ? { deciderSubject: opts.deciderSubject } : {}),
      })
      .onConflictDoUpdate({
        target: [flowStepApprovals.flowExecutionId, flowStepApprovals.stepId, flowStepApprovals.scope],
        set: { summary: input.summary, context: (input.context ?? null) as never },
        where: isNull(flowStepApprovals.decidedAt),
      })
      .returning();

    const row = rows[0] ?? (await this._get(flowExecutionId, input.stepId, input.scope ?? ""));
    // A small acknowledgement. The step's real "result" is the decision, and it
    // arrives by resuming the paired Pause — not through this response.
    return { approvalId: row?.id, pending: !row?.decidedAt };
  },

  /**
   * Expire every undecided approval on a flow being deleted.
   *
   * A gate that can never be decided (its flow and engine deployment are
   * gone) must not sit in the inbox for ever — an inbox with permanent
   * residents is one nobody reads. Rows stay as history (expired, with the
   * reason); only the undecided state is closed. Called by flow remove BEFORE
   * the flow row goes, while executions still point at it.
   */
  async expireForFlow(flowId: string, reason: string) {
    const execs = await flowExecutionRepo.listByFlow(flowId, 500);
    for (const ex of execs) {
      await db
        .update(flowStepApprovals)
        .set({ expiredAt: new Date(), note: reason.slice(0, 2000) })
        .where(
          and(
            eq(flowStepApprovals.flowExecutionId, ex.id),
            isNull(flowStepApprovals.decidedAt),
            isNull(flowStepApprovals.expiredAt),
          ),
        );
    }
  },

  /**
   * Close a pending row with no decision, because the thing it was waiting on
   * stopped waiting (Stage 8.1 — the poller's deadline).
   *
   * Not a rejection: nobody refused anything. A row that stays pending against a
   * dead run is worse than either, because the inbox then accumulates entries
   * that cannot be acted on and the person learns to ignore it.
   */
  async expire(flowExecutionId: string, stepId: string, reason: string) {
    await db
      .update(flowStepApprovals)
      .set({ expiredAt: new Date(), note: reason.slice(0, 2000) })
      .where(
        and(
          eq(flowStepApprovals.flowExecutionId, flowExecutionId),
          eq(flowStepApprovals.stepId, stepId),
          isNull(flowStepApprovals.decidedAt),
          isNull(flowStepApprovals.expiredAt),
        ),
      );
  },

  async _get(flowExecutionId: string, stepId: string, scope = "") {
    const rows = await db
      .select()
      .from(flowStepApprovals)
      .where(
        and(
          eq(flowStepApprovals.flowExecutionId, flowExecutionId),
          eq(flowStepApprovals.stepId, stepId),
          eq(flowStepApprovals.scope, scope),
        ),
      )
      .limit(1);
    return rows[0];
  },

  /**
   * The inbox — everything in this workspace still waiting on a person.
   *
   * Joined through `flow_executions` so the workspace filter is a real tenancy
   * boundary rather than a filter the caller supplies. Selected on `decided_at
   * IS NULL`, the FACT, not on a status string — the I-14 lesson.
   *
   * ⚠ **And on `expired_at IS NULL`.** Missing that half was the whole point of
   * giving expiry its own column: a question whose run died would otherwise sit
   * in the inbox for ever, un-answerable, and an inbox with permanent residents
   * is an inbox nobody reads.
   */
  async listPending(workspaceId: string, visible?: SQL) {
    const rows = await db
      .select({ a: flowStepApprovals, e: flowExecutions })
      .from(flowStepApprovals)
      .innerJoin(flowExecutions, eq(flowStepApprovals.flowExecutionId, flowExecutions.id))
      .where(
        and(
          eq(flowExecutions.workspaceId, workspaceId),
          isNull(flowStepApprovals.decidedAt),
          isNull(flowStepApprovals.expiredAt),
          // ⚠ Executions outlive their flow by design ("deleted flows keep
          // their history") — but a gate on a flowless execution can never be
          // decided, so the inbox hides it. History stays on the run page.
          isNotNull(flowExecutions.flowId),
          // Only the runs this person may see (rbac-observability) — `contentVisibility.runsWhere`.
          visible,
        ),
      )
      .orderBy(desc(flowStepApprovals.createdAt));
    return rows.map((r) => ({
      ...toPublic(r.a),
      flowId: r.e.flowId,
      startedAt: r.e.startedAt,
    }));
  },

  /** Every approval on one execution, decided or not — what `/runs/[id]` shows. */
  async listForExecution(workspaceId: string, flowExecutionId: string) {
    const ex = await flowExecutionRepo.get(flowExecutionId);
    if (!ex || ex.workspaceId !== workspaceId) return undefined;
    const rows = await db
      .select()
      .from(flowStepApprovals)
      .where(eq(flowStepApprovals.flowExecutionId, flowExecutionId))
      .orderBy(flowStepApprovals.createdAt);
    return rows.map(toPublic);
  },

  /**
   * Record a decision and deliver it.
   *
   * Order matters and is deliberate: the row is stamped FIRST, then Kestra is
   * called. The reverse would let a resume succeed against a row that then fails
   * to write, and the flow would carry on with no record of who allowed it —
   * worse than a recorded decision that failed to deliver, which is at least
   * visible as `decidedAt` set with `appliedAt` NULL.
   */
  /**
   * Who asked for the run this approval belongs to — archive/GAPS.md §1.1b, D-70.
   *
   * Read by `requireNotRunRequester` at the route. It lives here rather than in
   * the middleware because the (approval → execution) join and its workspace
   * scoping are this service's business: a second copy of that join is a second
   * chance to forget the `workspace_id` predicate, which is the difference
   * between a 404 and a cross-tenant read.
   */
  async requesterOfRun(workspaceId: string, approvalId: string) {
    const found = await db
      .select({
        subject: flowExecutions.requestedBySubject,
        actor: flowExecutions.requestedBy,
        kind: flowExecutions.requestedByKind,
        // Who decides the pause (sharing-boundaries P1-D1/D2): the workflow's owner.
        owner: flows.ownerSubject,
        flowName: flows.name,
        // A run on somebody's own account is theirs to decide (sharing-boundaries P3-I2), and a named member too (P1-I3).
        actsAs: flowExecutions.actsAsSubject,
        named: flowStepApprovals.deciderSubject,
      })
      .from(flowStepApprovals)
      .innerJoin(flowExecutions, eq(flowStepApprovals.flowExecutionId, flowExecutions.id))
      .leftJoin(flows, eq(flowExecutions.flowId, flows.id))
      .where(and(eq(flowStepApprovals.id, approvalId), eq(flowExecutions.workspaceId, workspaceId)))
      .limit(1);
    return found[0];
  },

  async decide(workspaceId: string, approvalId: string, input: DecideInput) {
    const found = await db
      .select({ a: flowStepApprovals, e: flowExecutions })
      .from(flowStepApprovals)
      .innerJoin(flowExecutions, eq(flowStepApprovals.flowExecutionId, flowExecutions.id))
      .where(and(eq(flowStepApprovals.id, approvalId), eq(flowExecutions.workspaceId, workspaceId)))
      .limit(1);
    const row = found[0]?.a;
    const execution = found[0]?.e;
    if (!row || !execution) throw httpError("approval not found", 404);

    if (row.decidedAt) {
      // Closed, never reopened — the same discipline as `flow_approvals`. A
      // second decision is refused rather than overwriting the first, because an
      // approval history that can be edited is not an approval history.
      throw httpError(
        `this step was already ${row.decision} by "${row.decidedBy}" at ` +
          `${row.decidedAt.toISOString()}. A decision is recorded once; to stop a run that is ` +
          "still going, cancel the execution",
        409,
      );
    }

    if (row.expiredAt) {
      // Distinct from the 409 above, because the fix is different: nobody
      // decided this, the run stopped waiting. Saying "already decided" here
      // would send the reader looking for a colleague who does not exist.
      throw httpError(
        `this run stopped waiting at ${row.expiredAt.toISOString()} and can no longer be ` +
          `answered${row.note ? ` — ${row.note}` : ""}. Start the run again`,
        409,
      );
    }

    // ⚠ `answers` is a 400 rather than a silent drop. It used to select a second
    // kind of row — a runtime agent's own question, delivered to that runtime
    // instead of to Kestra — and with that runtime gone there is exactly one
    // kind left. A caller still sending `answers` is one that believes
    // otherwise, and telling it so beats accepting a field and ignoring it.
    if (input.answers) {
      throw httpError(
        `"answers" is not accepted on an approval gate — this step is asking whether to proceed, ` +
          "not asking a question. Send only a decision and an optional note",
        400,
      );
    }
    const decidedAt = new Date();
    await db
      .update(flowStepApprovals)
      .set({
        decision: input.decision,
        decidedBy: input.decidedBy,
        note: input.note ?? null,
        answers: (input.answers ?? null) as never,
        decidedAt,
      })
      .where(eq(flowStepApprovals.id, approvalId));

    // A run on Foundry's runner (pi-runtime P5) is not paused in an engine: it handed its state back and exited. The
    // decision — approve or reject — starts it again; the runner replays to the approval and goes on, or records the
    // refusal and runs nothing after it. One path for both, so a rejection is recorded by the run itself.
    if (execution.kestraExecutionId?.startsWith("fr-")) {
      const { flowRunnerService } = await import("./flow-runner.service.js");
      await flowRunnerService.resume(execution.id, {
        stepId: row.stepId,
        decision: input.decision === "approved" ? "approved" : "rejected",
        by: input.decidedBy,
        note: input.note ?? null,
      });
      await db.update(flowStepApprovals).set({ appliedAt: new Date() }).where(eq(flowStepApprovals.id, approvalId));
      const done = await db.select().from(flowStepApprovals).where(eq(flowStepApprovals.id, approvalId)).limit(1);
      return toPublic(done[0]);
    }

    if (!execution.kestraExecutionId) {
      throw httpError(
        "this approval has no engine execution to act on — the decision was recorded but " +
          "cannot be delivered",
        502,
      );
    }

    if (input.decision === "rejected" && !row.scope) {
      // ⚠ KILL, do not resume. Resuming un-pauses the execution and every
      // downstream step runs — the send would happen, having been rejected.
      await this._killRejected(execution.id, execution.kestraExecutionId);
    } else {
      // builder-behaviour P7 (P4-I4): a gate INSIDE a loop is one item's. Its rejection is delivered as a decision, never a kill: the
      // steps it guards run only when that item was approved (`runIf`), so this item's send is skipped and the OTHER items go on.
      await this._resumeApproved(execution.kestraExecutionId, row.resumeTaskId, input, row.taskrunId);
    }

    await db
      .update(flowStepApprovals)
      .set({ appliedAt: new Date() })
      .where(eq(flowStepApprovals.id, approvalId));

    const after = await db
      .select()
      .from(flowStepApprovals)
      .where(eq(flowStepApprovals.id, approvalId))
      .limit(1);
    return toPublic(after[0]);
  },

  async _resumeApproved(
    kestraExecutionId: string,
    resumeTaskId: string,
    input: z.infer<typeof decideSchema>,
    registeredBy?: string | null,
  ) {
    // The request registers a moment BEFORE its pause opens (the register task runs, then the Pause): a decision made in between
    // finds the item's pause not yet paused, and the engine refuses the resume — recorded, never delivered, the run stuck (measured
    // 2026-10-04: a decision 2s after registering). So wait, briefly, for THAT item's pause to be paused.
    let taskRunId: string | undefined;
    for (let k = 0; k < 20; k++) {
      const ex = await kestra.getExecution(kestraExecutionId);
      taskRunId = pausedTaskrunId(ex, resumeTaskId, registeredBy);
      if (ex.taskRunList?.find((t) => t.id === taskRunId)?.state.current === "PAUSED") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    try {
      // Multipart, because `resumeExecution` builds a FormData. Kestra accepts a
      // JSON body with a 2xx and SILENTLY DROPS the inputs (D-21) — so a resume
      // that "worked" would deliver an empty decision to the flow.
      await kestra.resumeExecution(
        kestraExecutionId,
        { decision: input.decision, note: input.note ?? "" },
        taskRunId,
      );
    } catch (e) {
      if (e instanceof KestraError && (e.status === 404 || e.status === 409)) {
        // Gone, or no longer paused — the pauseDuration expired, or somebody
        // cancelled it. The decision stays recorded; `appliedAt` is what says
        // whether it landed.
        throw httpError(
          `the run is no longer waiting for this decision (engine said ${e.status}). It may have ` +
            "timed out or been cancelled. The decision has been recorded",
          409,
        );
      }
      throw e;
    }
  },

  async _killRejected(flowExecutionId: string, kestraExecutionId: string) {
    try {
      await kestra.killExecution(kestraExecutionId);
    } catch (e) {
      if (!(e instanceof KestraError && (e.status === 404 || e.status === 409))) throw e;
    }
    // Close the Foundry row ourselves. A killed execution never reaches its
    // flow's `complete` task, so nothing else would move it off `running` — and
    // a `running` row holds an M3 budget slot, so five rejections would brick the
    // workspace through a FAIRNESS control (I-10). `begin` reconciles, but only
    // on the refusal path, which is to say after somebody has already been
    // refused.
    //
    // `cancelled`, not `failed`: a rejected run did not break. D-14 made
    // `Run.outcome` three-valued and `lib/stats.ts` divides rates by SETTLED
    // runs, so filing a deliberate human decision as a failure would show the
    // gate working as a falling success rate — which is the reading that gets a
    // gate switched off.
    //
    // The REASON is deliberately not copied here. There is no `error` column on
    // this table, and adding one would duplicate what the approval row already
    // holds — decision, decidedBy, decidedAt, note — in a second place that can
    // drift from it (R6). The run page reads both.
    await flowExecutionRepo.update(flowExecutionId, {
      status: "cancelled",
      endedAt: new Date(),
    });
  },
};
