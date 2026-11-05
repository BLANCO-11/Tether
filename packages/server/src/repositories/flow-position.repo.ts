import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowStepPositions } from "../db/schema.js";

/**
 * `flow_step_positions` — the DAG arrangement mirror, OUTSIDE the revision
 * (plan decision ②, D-150).
 *
 * Deliberately dumb: `getByFlow` reads rows, `replace` swaps the flow's whole
 * set in one transaction. Nothing here touches `flow_revisions` — the pin test
 * in `flow-position.service.test.ts` proves a positions write never crosses
 * into `writeRevision`, because approval binds to a revision and a cosmetic
 * drag must not create one.
 */
export type FlowStepPosition = typeof flowStepPositions.$inferSelect;
export type NewFlowStepPosition = typeof flowStepPositions.$inferInsert;

export const flowStepPositionRepo = {
  async getByFlow(flowId: string): Promise<FlowStepPosition[]> {
    return db
      .select()
      .from(flowStepPositions)
      .where(eq(flowStepPositions.flowId, flowId))
      .orderBy(flowStepPositions.stepId);
  },

  /**
   * Wholesale replace — the server is dumb (D-150(f)): the client reconciles
   * (drops deleted-step rows, re-keys renamed ones) and sends the whole set.
   * Delete-then-insert in one transaction so a GET never sees a half state.
   */
  async replace(flowId: string, rows: NewFlowStepPosition[]): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.delete(flowStepPositions).where(eq(flowStepPositions.flowId, flowId));
      if (rows.length > 0) {
        await tx.insert(flowStepPositions).values(rows);
      }
    });
  },
};
