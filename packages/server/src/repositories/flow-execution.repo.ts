import { and, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowExecutions, flowStepRuns } from "../db/schema.js";

export type NewFlowExecution = typeof flowExecutions.$inferInsert;
export type FlowExecution = typeof flowExecutions.$inferSelect;
export type NewFlowStepRun = typeof flowStepRuns.$inferInsert;
export type FlowStepRun = typeof flowStepRuns.$inferSelect;

export const flowExecutionRepo = {
  async create(data: NewFlowExecution): Promise<FlowExecution> {
    const rows = await db.insert(flowExecutions).values(data).returning();
    return rows[0];
  },

  async get(id: string): Promise<FlowExecution | undefined> {
    const rows = await db.select().from(flowExecutions).where(eq(flowExecutions.id, id)).limit(1);
    return rows[0];
  },

  async getByKestraId(kestraExecutionId: string): Promise<FlowExecution | undefined> {
    const rows = await db
      .select()
      .from(flowExecutions)
      .where(eq(flowExecutions.kestraExecutionId, kestraExecutionId))
      .limit(1);
    return rows[0];
  },

  async listByWorkspace(workspaceId: string, limit = 50, visible?: SQL): Promise<FlowExecution[]> {
    return db
      .select()
      .from(flowExecutions)
      .where(and(eq(flowExecutions.workspaceId, workspaceId), visible))
      .orderBy(desc(flowExecutions.startedAt))
      .limit(limit);
  },

  /**
   * One page of a workspace's runs, newest first (2026-10-11). The page is keyed on the LAST run shown
   * (`before`: its start time and id), never an offset, so a run that starts while someone pages does not shift
   * the next page and show a run twice. Filters run here, over every run, not over what a browser has loaded:
   * `name` is the label a run is listed under (the name frozen at its start, else the engine slug — the same chain
   * the client's `runLabel` uses), `from` a start time, `q` a piece of that label or of the run's or workflow's id.
   * Returns one row more than `limit` when there is a next page.
   */
  async listPage(
    workspaceId: string,
    opts: { limit: number; before?: { at: Date; id: string }; name?: string; from?: Date; q?: string; visible?: SQL },
  ): Promise<FlowExecution[]> {
    const label = sql`coalesce(${flowExecutions.flowNameSnapshot}, ${flowExecutions.kestraFlowId})`;
    const where: SQL[] = [eq(flowExecutions.workspaceId, workspaceId)];
    if (opts.visible) where.push(opts.visible);
    if (opts.before) where.push(sql`(${flowExecutions.startedAt}, ${flowExecutions.id}) < (${opts.before.at.toISOString()}::timestamptz, ${opts.before.id}::uuid)`);
    if (opts.name) where.push(sql`${label} = ${opts.name}`);
    if (opts.from) where.push(gte(flowExecutions.startedAt, opts.from));
    if (opts.q) {
      const like = `%${opts.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(
        sql`(${label} ilike ${like} or ${flowExecutions.id}::text ilike ${like} or ${flowExecutions.flowId}::text ilike ${like} or ${flowExecutions.flowIdSnapshot}::text ilike ${like})`,
      );
    }
    return db
      .select()
      .from(flowExecutions)
      .where(and(...where))
      .orderBy(desc(flowExecutions.startedAt), desc(flowExecutions.id))
      .limit(opts.limit + 1);
  },

  /** The labels a workspace's runs are listed under — History's workflow filter, over every run. */
  async labels(workspaceId: string, visible?: SQL): Promise<string[]> {
    const rows = await db
      .selectDistinct({ label: sql<string>`coalesce(${flowExecutions.flowNameSnapshot}, ${flowExecutions.kestraFlowId})` })
      .from(flowExecutions)
      .where(and(eq(flowExecutions.workspaceId, workspaceId), visible));
    return rows.map((r) => r.label).filter(Boolean).sort((a, b) => a.localeCompare(b));
  },

  /** Every run started since `from`, plus every run still going whenever it started — the dashboard's counts. */
  async listSinceOrRunning(workspaceId: string, from: Date, visible?: SQL): Promise<FlowExecution[]> {
    return db
      .select()
      .from(flowExecutions)
      .where(and(eq(flowExecutions.workspaceId, workspaceId), visible, sql`(${flowExecutions.startedAt} >= ${from.toISOString()}::timestamptz or ${flowExecutions.status} in ('running', 'waiting'))`))
      .orderBy(desc(flowExecutions.startedAt), desc(flowExecutions.id));
  },

  /** Executions not yet in a terminal state — the input to the M3 concurrency check. */
  async countRunning(workspaceId: string): Promise<number> {
    const rows = await db
      .select({ id: flowExecutions.id })
      .from(flowExecutions)
      .where(and(eq(flowExecutions.workspaceId, workspaceId), eq(flowExecutions.status, "running")));
    return rows.length;
  },

  /** Every `running` row for a workspace, with the Kestra id needed to reconcile it. */
  async listRunning(workspaceId: string): Promise<FlowExecution[]> {
    return db
      .select()
      .from(flowExecutions)
      .where(and(eq(flowExecutions.workspaceId, workspaceId), eq(flowExecutions.status, "running")));
  },

  /**
   * Has this flow ever completed a run — gate 1, `enableReadiness()` (§6.5).
   *
   * Deliberately ANY revision, not the current one. The gate asks "has this
   * automation ever worked", which is a question about the flow; asking it per
   * revision would re-block arming after a one-line edit and turn the gate into
   * friction, which is how gates get switched off. Gate 2 (human approval) is
   * the one that is revision-scoped, and it is the one that has to be.
   */
  async hasSucceeded(flowId: string): Promise<boolean> {
    const rows = await db
      .select({ id: flowExecutions.id })
      .from(flowExecutions)
      .where(and(eq(flowExecutions.flowId, flowId), eq(flowExecutions.status, "succeeded")))
      .limit(1);
    return rows.length > 0;
  },

  /**
   * The ids of every succeeded run of this flow — gate 1's second half
   * (archive/GAPS.md §2.3).
   *
   * `hasSucceeded` above answers "did anything ever work". Once a flow can
   * declare expectations, the gate also has to know *which* runs worked, because
   * a claim that passed during a run that then fell over has not been shown to
   * hold end to end. Two questions, two queries, rather than one that returns
   * the boolean and quietly means both.
   */
  async succeededIds(flowId: string): Promise<string[]> {
    const rows = await db
      .select({ id: flowExecutions.id })
      .from(flowExecutions)
      .where(and(eq(flowExecutions.flowId, flowId), eq(flowExecutions.status, "succeeded")));
    return rows.map((r) => r.id);
  },

  async listByFlow(flowId: string, limit = 25): Promise<FlowExecution[]> {
    return db
      .select()
      .from(flowExecutions)
      .where(eq(flowExecutions.flowId, flowId))
      .orderBy(desc(flowExecutions.startedAt))
      .limit(limit);
  },

  async update(id: string, data: Partial<NewFlowExecution>): Promise<FlowExecution | undefined> {
    const rows = await db
      .update(flowExecutions)
      .set(data)
      .where(eq(flowExecutions.id, id))
      .returning();
    return rows[0];
  },
};

export const flowStepRunRepo = {
  /**
   * Record that a step ran. Idempotent on `kestra_taskrun_id`, because Kestra
   * retries a failed task with the SAME taskrun id — a plain insert would hit
   * the unique constraint on the retry and turn a recoverable step failure into
   * a 500 from Foundry.
   */
  async record(data: NewFlowStepRun): Promise<FlowStepRun> {
    if (!data.kestraTaskrunId) {
      const rows = await db.insert(flowStepRuns).values(data).returning();
      return rows[0];
    }
    const rows = await db
      .insert(flowStepRuns)
      .values(data)
      .onConflictDoUpdate({
        target: flowStepRuns.kestraTaskrunId,
        set: {
          stepId: data.stepId,
          kind: data.kind,
          // Carried through the retry. A Kestra retry reuses the taskrun id, so
          // an agent step that failed to start and then succeeded would
          // otherwise keep the FIRST attempt's (absent) join key — and the
          // execution would stay paused with nothing pointing at the run.
          resumeTaskId: data.resumeTaskId ?? null,
          // Carried through for the same reason, and it is the more important
          // one: a retry that succeeded against production must not inherit a
          // `sandbox` stamp from the attempt before it.
          readFrom: data.readFrom ?? null,
        },
      })
      .returning();
    return rows[0];
  },

  async get(id: string): Promise<FlowStepRun | undefined> {
    const rows = await db.select().from(flowStepRuns).where(eq(flowStepRuns.id, id)).limit(1);
    return rows[0];
  },


  async listByExecution(flowExecutionId: string): Promise<FlowStepRun[]> {
    return db
      .select()
      .from(flowStepRuns)
      .where(eq(flowStepRuns.flowExecutionId, flowExecutionId))
      .orderBy(flowStepRuns.createdAt);
  },

  async update(id: string, data: Partial<NewFlowStepRun>): Promise<FlowStepRun | undefined> {
    const rows = await db.update(flowStepRuns).set(data).where(eq(flowStepRuns.id, id)).returning();
    return rows[0];
  },
};
