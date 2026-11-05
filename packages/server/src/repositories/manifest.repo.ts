import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { workspaceManifests } from "../db/schema.js";

export type ManifestRow = typeof workspaceManifests.$inferSelect;
export type NewManifestRow = typeof workspaceManifests.$inferInsert;

export const manifestRepo = {
  async getLatest(workspaceId: string): Promise<ManifestRow | undefined> {
    const rows = await db
      .select()
      .from(workspaceManifests)
      .where(eq(workspaceManifests.workspaceId, workspaceId))
      .orderBy(desc(workspaceManifests.version))
      .limit(1);
    return rows[0];
  },

  async getVersion(workspaceId: string, version: number): Promise<ManifestRow | undefined> {
    const rows = await db
      .select()
      .from(workspaceManifests)
      .where(eq(workspaceManifests.workspaceId, workspaceId))
      .limit(50);
    return rows.find((r) => r.version === version);
  },

  async insert(row: NewManifestRow): Promise<ManifestRow> {
    const rows = await db.insert(workspaceManifests).values(row).returning();
    return rows[0];
  },
};
