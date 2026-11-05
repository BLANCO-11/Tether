import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { workspaceSecrets } from "../db/schema.js";

export type WorkspaceSecret = typeof workspaceSecrets.$inferSelect;
export type NewWorkspaceSecret = typeof workspaceSecrets.$inferInsert;

export const workspaceSecretRepo = {
  listByWorkspace(workspaceId: string): Promise<WorkspaceSecret[]> {
    return db
      .select()
      .from(workspaceSecrets)
      .where(eq(workspaceSecrets.workspaceId, workspaceId))
      .orderBy(asc(workspaceSecrets.name));
  },

  async get(workspaceId: string, id: string): Promise<WorkspaceSecret | undefined> {
    const rows = await db
      .select()
      .from(workspaceSecrets)
      .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.id, id)))
      .limit(1);
    return rows[0];
  },

  /** By env-var NAME — the key tools and datasources reference. */
  async getByName(workspaceId: string, name: string): Promise<WorkspaceSecret | undefined> {
    const rows = await db
      .select()
      .from(workspaceSecrets)
      .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.name, name)))
      .limit(1);
    return rows[0];
  },

  async create(data: NewWorkspaceSecret): Promise<WorkspaceSecret> {
    const rows = await db.insert(workspaceSecrets).values(data).returning();
    return rows[0];
  },

  /** Idempotent upsert by (workspaceId, name) — what provisioning needs. */
  async upsertByName(data: NewWorkspaceSecret): Promise<WorkspaceSecret> {
    const rows = await db
      .insert(workspaceSecrets)
      .values(data)
      .onConflictDoUpdate({
        target: [workspaceSecrets.workspaceId, workspaceSecrets.name],
        set: {
          valueEnc: data.valueEnc,
          sandboxValueEnc: data.sandboxValueEnc ?? null,
          description: data.description ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return rows[0];
  },

  async update(
    workspaceId: string,
    id: string,
    data: Partial<NewWorkspaceSecret>,
  ): Promise<WorkspaceSecret | undefined> {
    const rows = await db
      .update(workspaceSecrets)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.id, id)))
      .returning();
    return rows[0];
  },

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const rows = await db
      .delete(workspaceSecrets)
      .where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.id, id)))
      .returning({ id: workspaceSecrets.id });
    return rows.length > 0;
  },

  markUsed(id: string) {
    return db
      .update(workspaceSecrets)
      .set({ lastUsedAt: new Date() })
      .where(eq(workspaceSecrets.id, id));
  },
};
