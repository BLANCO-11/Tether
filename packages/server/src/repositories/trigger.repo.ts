import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { triggers, triggerFires, flowExecutions } from "../db/schema.js";

export type Trigger = typeof triggers.$inferSelect;
export type NewTrigger = typeof triggers.$inferInsert;
export type NewTriggerFire = typeof triggerFires.$inferInsert;

export const triggerRepo = {
  listByFlow(flowId: string): Promise<Trigger[]> {
    return db.select().from(triggers).where(eq(triggers.flowId, flowId)).orderBy(desc(triggers.createdAt));
  },
  listByWorkspace(workspaceId: string): Promise<Trigger[]> {
    return db
      .select()
      .from(triggers)
      .where(eq(triggers.workspaceId, workspaceId))
      .orderBy(desc(triggers.createdAt));
  },
  listEnabledByType(type: string): Promise<Trigger[]> {
    return db.select().from(triggers).where(and(eq(triggers.type, type), eq(triggers.enabled, true)));
  },
  async get(id: string): Promise<Trigger | undefined> {
    const rows = await db.select().from(triggers).where(eq(triggers.id, id)).limit(1);
    return rows[0];
  },
  async getByWebhookToken(token: string): Promise<Trigger | undefined> {
    const rows = await db.select().from(triggers).where(eq(triggers.webhookToken, token)).limit(1);
    return rows[0];
  },
  /**
   * By trigger NAME within a workspace — the identifier the credentials seam
   * resolves webhook/api refs by (Phase 5).
   */
  async getByName(workspaceId: string, name: string): Promise<Trigger | undefined> {
    const rows = await db
      .select()
      .from(triggers)
      .where(and(eq(triggers.workspaceId, workspaceId), eq(triggers.name, name)))
      .limit(1);
    return rows[0];
  },
  async create(data: NewTrigger): Promise<Trigger> {
    const rows = await db.insert(triggers).values(data).returning();
    return rows[0];
  },
  async update(id: string, data: Partial<NewTrigger>): Promise<Trigger | undefined> {
    const rows = await db
      .update(triggers)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(triggers.id, id))
      .returning();
    return rows[0];
  },
  async remove(id: string): Promise<boolean> {
    const rows = await db.delete(triggers).where(eq(triggers.id, id)).returning({ id: triggers.id });
    return rows.length > 0;
  },
  /**
   * One fire, with the workspace of the trigger that owns it.
   *
   * The workspace comes from the JOIN rather than from the caller, so a fire id
   * arriving on an execution callback can be checked against the workspace that
   * callback resolved to. `trigger_fires` has no `workspace_id` of its own and
   * should not grow one — a denormalised copy is a second answer to a question
   * that already has one.
   */
  async getFire(id: string): Promise<{ id: string; triggerId: string; workspaceId: string } | undefined> {
    const rows = await db
      .select({ id: triggerFires.id, triggerId: triggerFires.triggerId, workspaceId: triggers.workspaceId })
      .from(triggerFires)
      .innerJoin(triggers, eq(triggerFires.triggerId, triggers.id))
      .where(eq(triggerFires.id, id))
      .limit(1);
    return rows[0];
  },
  async recordFire(data: NewTriggerFire) {
    const rows = await db.insert(triggerFires).values(data).returning();
    return rows[0];
  },
  /**
   * The fire audit trail, newest first, with the run each fire started.
   *
   * ⚠ The join is the whole point and it is not `trigger_fires.execution_id`.
   * That column is a leftover from the deleted `execution_results` table and a
   * flow fire always leaves it NULL (see the schema's own note), so a listing
   * built on it says "started nothing" for every row — including the ones that
   * ran perfectly. A flow execution is linked the OTHER way round, by
   * `flow_executions.trigger_fire_id`, which `begin` sets from the execution's
   * labels.
   *
   * So a row with `flowExecutionId: null` genuinely means *this fire started
   * nothing* — refused by the approval gate, or the engine never accepted it —
   * which is exactly the question the audit trail exists to answer.
   */
  listFires(triggerId: string) {
    return db
      .select({
        id: triggerFires.id,
        triggerId: triggerFires.triggerId,
        firedBy: triggerFires.firedBy,
        firedAt: triggerFires.firedAt,
        payload: triggerFires.payload,
        executionId: triggerFires.executionId,
        flowExecutionId: flowExecutions.id,
        flowExecutionStatus: flowExecutions.status,
      })
      .from(triggerFires)
      .leftJoin(flowExecutions, eq(flowExecutions.triggerFireId, triggerFires.id))
      .where(eq(triggerFires.triggerId, triggerId))
      .orderBy(desc(triggerFires.firedAt))
      .limit(50);
  },
};
