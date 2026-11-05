import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { datasources } from "../db/schema.js";
import { decrypt } from "../utils/encryptor.js";

/**
 * Decrypt a datasource DSN, or `null` when the row is mock-only
 * (no production credential attached). Never throws on `null` — callers
 * branch on the result instead of catching malformed-ciphertext.
 */
export function decryptDsnIfPresent(enc: string | null | undefined): string | null {
  if (!enc) return null;
  return decrypt(enc);
}

export type NewDatasource = typeof datasources.$inferInsert;
export type Datasource = typeof datasources.$inferSelect;

export const datasourceRepo = {
  listByWorkspace(workspaceId: string): Promise<Datasource[]> {
    return db
      .select()
      .from(datasources)
      .where(eq(datasources.workspaceId, workspaceId))
      .orderBy(desc(datasources.createdAt));
  },

  async get(workspaceId: string, id: string): Promise<Datasource | undefined> {
    const rows = await db
      .select()
      .from(datasources)
      .where(and(eq(datasources.id, id), eq(datasources.workspaceId, workspaceId)))
      .limit(1);
    return rows[0];
  },

  /** By NAME within a workspace — the identifier the credentials seam resolves
   * database refs by (Phase 5). */
  async getByName(workspaceId: string, name: string): Promise<Datasource | undefined> {
    const rows = await db
      .select()
      .from(datasources)
      .where(and(eq(datasources.name, name), eq(datasources.workspaceId, workspaceId)))
      .limit(1);
    return rows[0];
  },

  async create(data: NewDatasource): Promise<Datasource> {
    const rows = await db.insert(datasources).values(data).returning();
    return rows[0];
  },

  async update(
    workspaceId: string,
    id: string,
    data: Partial<NewDatasource>,
  ): Promise<Datasource | undefined> {
    const rows = await db
      .update(datasources)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(datasources.id, id), eq(datasources.workspaceId, workspaceId)))
      .returning();
    return rows[0];
  },

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const rows = await db
      .delete(datasources)
      .where(and(eq(datasources.id, id), eq(datasources.workspaceId, workspaceId)))
      .returning({ id: datasources.id });
    return rows.length > 0;
  },
};
