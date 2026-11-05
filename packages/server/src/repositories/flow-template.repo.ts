import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowTemplates } from "../db/schema.js";

/**
 * The per-tenant template library (phase 6.4).
 *
 * Every read takes a `workspaceId` and there is deliberately **no unscoped
 * getter** — not even a `getById`. A template holds ref NAMES and step contracts
 * written against one tenant's data, so a lookup that resolved a template id
 * without a workspace would be one careless route away from leaking another
 * tenant's schema vocabulary. The same reason `flowRepo.get` takes one.
 */

export type FlowTemplate = typeof flowTemplates.$inferSelect;
export type NewFlowTemplate = typeof flowTemplates.$inferInsert;

export const flowTemplateRepo = {
  async create(data: NewFlowTemplate): Promise<FlowTemplate> {
    const rows = await db.insert(flowTemplates).values(data).returning();
    return rows[0];
  },

  async get(workspaceId: string, id: string): Promise<FlowTemplate | undefined> {
    const rows = await db
      .select()
      .from(flowTemplates)
      .where(and(eq(flowTemplates.workspaceId, workspaceId), eq(flowTemplates.id, id)))
      .limit(1);
    return rows[0];
  },

  async listByWorkspace(workspaceId: string): Promise<FlowTemplate[]> {
    return db
      .select()
      .from(flowTemplates)
      .where(eq(flowTemplates.workspaceId, workspaceId))
      .orderBy(desc(flowTemplates.createdAt));
  },

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const rows = await db
      .delete(flowTemplates)
      .where(and(eq(flowTemplates.workspaceId, workspaceId), eq(flowTemplates.id, id)))
      .returning({ id: flowTemplates.id });
    return rows.length > 0;
  },
};
