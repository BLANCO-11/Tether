import { and, count, desc, eq, isNull, isNotNull, inArray, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowApprovals, flowRevisions, flowSteps, flows } from "../db/schema.js";
import { cronOfModel, firingRevisionOf } from "../services/flow-schedule.js";
import { usageContext } from "../services/usage-context.js";

/**
 * `flows`, `flow_revisions`, `flow_steps`, `flow_approvals`.
 * archive/kestra-migration/07-refactor-inventory.md §7.4 · 05 §6.5
 *
 * Two invariants live here rather than in the service, because they are what
 * makes approval mean anything and a caller must not be able to opt out:
 *
 *  * **Revisions and steps are INSERT-ONLY.** There is no `updateRevision`. An
 *    editable revision would make "approved revision 3" a statement about
 *    whatever revision 3 later became.
 *  * **Approvals are closed, never deleted.** `revoke` and `markStale` stamp a
 *    timestamp; nothing removes a row. An approval history that can be erased is
 *    not an approval history.
 */

export type Flow = typeof flows.$inferSelect;
export type NewFlow = typeof flows.$inferInsert;
export type FlowRevision = typeof flowRevisions.$inferSelect;
export type FlowStepRow = typeof flowSteps.$inferSelect;
export type FlowApproval = typeof flowApprovals.$inferSelect;

export const flowRepo = {
  /**
   * `undefined` means `(workspaceId, kestraFlowId)` already exists.
   *
   * `onConflictDoNothing` rather than a plain insert: `flow.service.ts`
   * pre-checks by `getByKestraFlowId`, but that is a TOCTOU race — two
   * near-simultaneous submissions (a double-click, two tabs) can both pass the
   * check before either inserts, and the loser used to hit the raw
   * `uq_flows_workspace_flow_id` constraint directly, surfacing as an
   * unhandled Postgres error instead of the same clean 409 the pre-check
   * already produces for the non-race case.
   */
  async create(data: NewFlow): Promise<Flow | undefined> {
    // The owner is the person whose request created it (rbac-observability, 2026-10-15). Read from the request
    // context every workspace route already carries, so no create site can forget it; a harness or background job
    // has no person and leaves it NULL (Admins and Reviewers see those).
    const ownerSubject = data.ownerSubject ?? usageContext.getStore()?.subject ?? null;
    const rows = await db
      .insert(flows)
      .values({ ...data, ownerSubject })
      .onConflictDoNothing({ target: [flows.workspaceId, flows.kestraFlowId] })
      .returning();
    return rows[0];
  },

  /** Give an ownerless automation an owner. Never moves one that already has an owner. */
  async claimOwner(workspaceId: string, flowId: string, subject: string | null): Promise<void> {
    if (!subject) return;
    await db
      .update(flows)
      .set({ ownerSubject: subject })
      .where(and(eq(flows.workspaceId, workspaceId), eq(flows.id, flowId), isNull(flows.ownerSubject)));
  },

  /** An Admin moves an automation to another owner (or to nobody). */
  async setOwner(workspaceId: string, flowId: string, subject: string | null): Promise<Flow | undefined> {
    const rows = await db
      .update(flows)
      .set({ ownerSubject: subject, updatedAt: new Date() })
      .where(and(eq(flows.workspaceId, workspaceId), eq(flows.id, flowId)))
      .returning();
    return rows[0];
  },

  /**
   * Workspace-scoped by construction. Every read takes the workspace id, so a
   * flow id from a request cannot address another workspace's flow (risk 1c) —
   * the same reason `datasourceQueryRepo.resolveRef` takes one.
   */
  async get(workspaceId: string, id: string): Promise<Flow | undefined> {
    const rows = await db
      .select()
      .from(flows)
      .where(and(eq(flows.workspaceId, workspaceId), eq(flows.id, id)))
      .limit(1);
    return rows[0];
  },

  async getByKestraFlowId(workspaceId: string, kestraFlowId: string): Promise<Flow | undefined> {
    const rows = await db
      .select()
      .from(flows)
      .where(and(eq(flows.workspaceId, workspaceId), eq(flows.kestraFlowId, kestraFlowId)))
      .limit(1);
    return rows[0];
  },

  async listByWorkspace(workspaceId: string): Promise<Flow[]> {
    return db
      .select()
      .from(flows)
      .where(eq(flows.workspaceId, workspaceId))
      .orderBy(desc(flows.updatedAt));
  },

  /**
   * Every flow with something deployed LIVE — the staleness sweep's work list.
   *
   * Keyed on `armed_revision IS NOT NULL`, deliberately NOT on `status = 'armed'`.
   * `status` is a UI-facing summary and it moves for reasons that have nothing to
   * do with what is live: editing an armed flow sets it to `draft_pending`, and
   * a sweep filtering on the string would then skip every flow anyone had edited
   * — i.e. almost all of them, permanently, leaving the armed revision firing
   * against a manifest nobody re-checked. See ISSUES.md I-14.
   */
  async listLive(): Promise<Flow[]> {
    return db.select().from(flows).where(isNotNull(flows.armedRevision));
  },

  async update(
    id: string,
    patch: Partial<Pick<Flow, "name" | "description" | "draftRevision" | "armedRevision" | "status" | "designSelection" | "chatConfig" | "incompleteModel" | "visibility" | "reviewRequestedRevision" | "reviewRequestedBy" | "reviewRequestedAt" | "othersMayEdit">>,
  ): Promise<Flow | undefined> {
    const rows = await db
      .update(flows)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(flows.id, id))
      .returning();
    return rows[0];
  },

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const rows = await db
      .delete(flows)
      .where(and(eq(flows.workspaceId, workspaceId), eq(flows.id, id)))
      .returning({ id: flows.id });
    return rows.length > 0;
  },

  // ── revisions ──────────────────────────────────────────────────────────────

  async insertRevision(data: typeof flowRevisions.$inferInsert): Promise<FlowRevision> {
    const rows = await db.insert(flowRevisions).values(data).returning();
    return rows[0];
  },

  async getRevision(flowId: string, revision: number): Promise<FlowRevision | undefined> {
    const rows = await db
      .select()
      .from(flowRevisions)
      .where(and(eq(flowRevisions.flowId, flowId), eq(flowRevisions.revision, revision)))
      .limit(1);
    return rows[0];
  },

  async getRevisionById(id: string): Promise<FlowRevision | undefined> {
    const rows = await db.select().from(flowRevisions).where(eq(flowRevisions.id, id)).limit(1);
    return rows[0];
  },

  /**
   * The revisions a person sees.
   *
   * ⚠ **The ONE place `hidden_at` is honoured.** `getRevision` and
   * `getRevisionById` above are deliberately unfiltered: a hidden revision must
   * still be readable by id, or a replay of a run that used it, a diff against
   * it, and the approval row pointing at it all break — and each would break far
   * from here. Hiding is a list operation, not a deletion.
   */
  async listRevisions(flowId: string): Promise<FlowRevision[]> {
    return db
      .select()
      .from(flowRevisions)
      .where(and(eq(flowRevisions.flowId, flowId), isNull(flowRevisions.hiddenAt)))
      .orderBy(desc(flowRevisions.revision));
  },

  /** Hide one revision from the list. Insert-only is preserved — nothing is removed. */
  async hideRevision(flowId: string, revision: number): Promise<void> {
    await db
      .update(flowRevisions)
      .set({ hiddenAt: new Date() })
      .where(and(eq(flowRevisions.flowId, flowId), eq(flowRevisions.revision, revision)));
  },

  /**
   * Put one revision BACK in the list.
   *
   * WARNING The other half of a chat turn writing hidden revisions: "Save draft"
   * is this, on the current draft. It is deliberately a separate method rather
   * than `hideRevision(…, false)` - a boolean argument at the call site reads
   * identically whichever way it points, and these two do opposite things to
   * what a reviewer sees.
   */
  async unhideRevision(flowId: string, revision: number): Promise<void> {
    await db
      .update(flowRevisions)
      .set({ hiddenAt: null })
      .where(and(eq(flowRevisions.flowId, flowId), eq(flowRevisions.revision, revision)));
  },

  // ── steps ──────────────────────────────────────────────────────────────────

  async insertSteps(rows: Array<typeof flowSteps.$inferInsert>): Promise<void> {
    if (rows.length) await db.insert(flowSteps).values(rows);
  },

  async listSteps(flowId: string, revision: number): Promise<FlowStepRow[]> {
    return db
      .select()
      .from(flowSteps)
      .where(and(eq(flowSteps.flowId, flowId), eq(flowSteps.revision, revision)))
      .orderBy(flowSteps.ordinal);
  },

  /**
   * Every `code` step of every flow in a workspace, **at that flow's CURRENT
   * DRAFT revision only** — the input to fragment-promotion tracking (6.5).
   *
   * The revision restriction is the whole query. Scanning `flow_steps` outright
   * would count one flow edited ten times as ten occurrences, and the signal
   * being looked for is *"this fragment recurs across DIFFERENT automations"* —
   * so a history-inflated count does not just exaggerate it, it inverts it: the
   * flow that has been iterated most looks like the most reusable one.
   */
  /** `visible` narrows to the workflows a viewer may see (`contentVisibility.flowsWhere`); omitted, every workflow. */
  async listCodeStepsAtDraft(
    workspaceId: string,
    visible?: SQL,
  ): Promise<Array<{ flowId: string; flowName: string; revision: number; step: FlowStepRow }>> {
    const rows = await db
      .select({ flow: flows, step: flowSteps })
      .from(flowSteps)
      .innerJoin(
        flows,
        and(eq(flowSteps.flowId, flows.id), eq(flowSteps.revision, flows.draftRevision)),
      )
      .where(and(eq(flows.workspaceId, workspaceId), eq(flowSteps.kind, "code"), visible))
      .orderBy(flows.name, flowSteps.ordinal);
    return rows.map((r) => ({
      flowId: r.flow.id,
      flowName: r.flow.name,
      revision: r.step.revision,
      step: r.step,
    }));
  },

  // ── approvals ──────────────────────────────────────────────────────────────

  async insertApproval(data: typeof flowApprovals.$inferInsert): Promise<FlowApproval> {
    const rows = await db.insert(flowApprovals).values(data).returning();
    return rows[0];
  },

  /**
   * The LIVE approval for a revision: not revoked, not stale.
   *
   * Both conditions are in the query rather than filtered by the caller. A
   * caller that forgot one would let a revoked approval keep a schedule armed,
   * and that is a control failing open.
   */
  async currentApproval(flowId: string, revision: number): Promise<FlowApproval | undefined> {
    const rows = await db
      .select()
      .from(flowApprovals)
      .where(
        and(
          eq(flowApprovals.flowId, flowId),
          eq(flowApprovals.revision, revision),
          isNull(flowApprovals.revokedAt),
          isNull(flowApprovals.staleAt),
        ),
      )
      .orderBy(desc(flowApprovals.approvedAt))
      .limit(1);
    return rows[0];
  },

  async listApprovals(flowId: string): Promise<FlowApproval[]> {
    return db
      .select()
      .from(flowApprovals)
      .where(eq(flowApprovals.flowId, flowId))
      .orderBy(desc(flowApprovals.approvedAt));
  },

  /** Close every open approval for a flow (optionally one revision). */
  /** `revokedBy` is null for an automatic suspension — see the column comment. */
  async revokeApprovals(
    flowId: string,
    reason: string,
    revision?: number,
    revokedBy?: string,
  ): Promise<number> {
    const rows = await db
      .update(flowApprovals)
      .set({ revokedAt: new Date(), revokedReason: reason, revokedBy: revokedBy ?? null })
      .where(
        and(
          eq(flowApprovals.flowId, flowId),
          isNull(flowApprovals.revokedAt),
          ...(revision === undefined ? [] : [eq(flowApprovals.revision, revision)]),
        ),
      )
      .returning({ id: flowApprovals.id });
    return rows.length;
  },

  async markStale(flowId: string, revision: number, reason: string): Promise<number> {
    const rows = await db
      .update(flowApprovals)
      .set({ staleAt: new Date(), staleReason: reason })
      .where(
        and(
          eq(flowApprovals.flowId, flowId),
          eq(flowApprovals.revision, revision),
          isNull(flowApprovals.revokedAt),
          isNull(flowApprovals.staleAt),
        ),
      )
      .returning({ id: flowApprovals.id });
    return rows.length;
  },

  /** Approvals for several flows at once — the Triggers page reads this per row. */
  /**
   * How many approvals each flow has ever had — i.e. its VERSION number.
   *
   * ⚠ **A version is an approval, not a revision** (reported from use:
   * *"increment revision only on approval, without that there won't be any
   * versioning"*). `flow_revisions` is written on every edit — a chat turn, a
   * canvas save, a seed, a harness — so its number climbed while somebody was
   * still typing. `flow_approvals` is insert-only and closed by timestamp, never
   * deleted, so the COUNT is exactly the ordinal of the newest approval and it
   * moves only when a person approves something.
   *
   * ⚠ **Revoked and stale rows are COUNTED.** They are the audit artefact: a
   * version that ran and was turned off still happened, and excluding it would
   * renumber every version above it the moment somebody revoked one — silently
   * changing which version an audit trail refers to.
   *
   * One grouped query for the whole list, so the flows page does not become
   * N+1 to show a number.
   */
  async approvalCountsFor(flowIds: string[]): Promise<Map<string, number>> {
    if (!flowIds.length) return new Map();
    const rows = await db
      .select({ flowId: flowApprovals.flowId, n: count() })
      .from(flowApprovals)
      .where(inArray(flowApprovals.flowId, flowIds))
      .groupBy(flowApprovals.flowId);
    return new Map(rows.map((r) => [r.flowId, Number(r.n)]));
  },

  /**
   * **The cron each flow FIRES ON — the armed revision's when one is armed, the
   * draft's otherwise.**
   *
   * ── ⚠ THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────
   *
   * `FlowSummary.schedule` has six readers in `packages/client` — the flows
   * list's Schedule column, `/flows/[id]`'s Details row, `/live`, the
   * dashboard's scheduled section, `ApprovalPanel`'s Schedule stat, and
   * `VIEWS.scheduled`'s predicate — and **the server had never sent the field.**
   * The flows list route spreads the `flows` ROW, which has no such column (a
   * cron lives on the model, D-18), so every one of those read `undefined`:
   * every workflow printed *"Not scheduled"* whatever its cron said, and the
   * **Scheduled tab could not match a single flow, ever.** The flows page's own
   * comment describes the value as *"real, from the armed revision's model
   * (D-18)"* — a consumer written against a producer that was never built, which
   * is I-120 pointed the other way round.
   *
   * ⚠ **The armed revision when armed, and that is the whole reason this is not
   * just "the draft's cron".** The question every one of those surfaces asks is
   * *does a timer fire this, and when* — and what fires is the approved
   * revision, not the draft somebody is editing on top of it (§6.5). A flow
   * with nothing armed has no live answer, so the draft's cron is reported
   * instead: that is what publishing would deploy, and `status`/`armedRevision`
   * sit beside it on every one of those surfaces to say it is not live yet.
   *
   * ⚠ **One query for the page.** Read per flow it would be N+1 on the list
   * route, which is the shape `approvalCountsFor` above was written to avoid.
   * `null` for a flow with no such revision row and for a model declaring no
   * schedule — the two are the same answer to the caller's question, and
   * neither is an error.
   */
  async firingCronsFor(
    rows: Array<{ id: string; armedRevision: number | null; draftRevision: number }>,
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>(rows.map((r) => [r.id, null]));
    // ⚠ Both rules live in `flow-schedule.ts`, as pure functions with their own
    // tests. Inlining "armed ?? draft" here would bury the one decision in this
    // function that anybody could get wrong, in the one place a test cannot
    // reach without a database.
    const want = new Map<string, number>();
    for (const r of rows) {
      const revision = firingRevisionOf(r);
      if (revision !== null) want.set(r.id, revision);
    }
    if (!want.size) return out;
    const found = await db
      .select({
        flowId: flowRevisions.flowId,
        revision: flowRevisions.revision,
        modelJson: flowRevisions.modelJson,
      })
      .from(flowRevisions)
      .where(inArray(flowRevisions.flowId, [...want.keys()]));
    for (const row of found) {
      if (want.get(row.flowId) !== row.revision) continue;
      out.set(row.flowId, cronOfModel(row.modelJson));
    }
    return out;
  },

  async currentApprovalsFor(flowIds: string[]): Promise<FlowApproval[]> {
    if (!flowIds.length) return [];
    return db
      .select()
      .from(flowApprovals)
      .where(
        and(
          inArray(flowApprovals.flowId, flowIds),
          isNull(flowApprovals.revokedAt),
          isNull(flowApprovals.staleAt),
        ),
      );
  },
};
