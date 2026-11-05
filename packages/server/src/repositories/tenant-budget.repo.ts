import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenantBudgets } from "../db/schema.js";

export type NewTenantBudget = typeof tenantBudgets.$inferInsert;
export type TenantBudget = typeof tenantBudgets.$inferSelect;

export const tenantBudgetRepo = {
  async getByWorkspace(workspaceId: string): Promise<TenantBudget | undefined> {
    const rows = await db
      .select()
      .from(tenantBudgets)
      .where(eq(tenantBudgets.workspaceId, workspaceId))
      .limit(1);
    return rows[0];
  },

  async list(): Promise<TenantBudget[]> {
    return db.select().from(tenantBudgets);
  },

  /**
   * Insert or update the single row for a workspace.
   *
   * `onConflictDoUpdate` rather than read-then-write: two concurrent budget
   * edits would otherwise race on the unique constraint and one would surface as
   * a 500 rather than as a later write winning.
   */
  async upsert(
    workspaceId: string,
    data: Omit<Partial<NewTenantBudget>, "id" | "workspaceId">,
  ): Promise<TenantBudget> {
    const rows = await db
      .insert(tenantBudgets)
      .values({ workspaceId, ...data })
      .onConflictDoUpdate({
        target: tenantBudgets.workspaceId,
        set: { ...data, updatedAt: new Date() },
      })
      .returning();
    return rows[0];
  },

  async remove(workspaceId: string): Promise<boolean> {
    const rows = await db
      .delete(tenantBudgets)
      .where(eq(tenantBudgets.workspaceId, workspaceId))
      .returning({ id: tenantBudgets.id });
    return rows.length > 0;
  },
};
