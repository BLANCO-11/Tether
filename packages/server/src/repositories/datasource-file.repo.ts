import { and, eq, isNull, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { datasourceFiles } from "../db/schema.js";

export type DatasourceFile = typeof datasourceFiles.$inferSelect;
export type NewDatasourceFile = typeof datasourceFiles.$inferInsert;

/** Metadata only — every reader but the materialiser leaves the bytes behind. */
const META = {
  id: datasourceFiles.id,
  workspaceId: datasourceFiles.workspaceId,
  datasourceId: datasourceFiles.datasourceId,
  kind: datasourceFiles.kind,
  filename: datasourceFiles.filename,
  sizeBytes: datasourceFiles.sizeBytes,
  sha256: datasourceFiles.sha256,
  createdAt: datasourceFiles.createdAt,
};
export type DatasourceFileMeta = Omit<DatasourceFile, "contentEnc">;

export const datasourceFileRepo = {
  async create(row: NewDatasourceFile): Promise<DatasourceFileMeta> {
    const [r] = await db.insert(datasourceFiles).values(row).returning(META);
    return r;
  },

  async getMeta(id: string): Promise<DatasourceFileMeta | undefined> {
    const rows = await db.select(META).from(datasourceFiles).where(eq(datasourceFiles.id, id)).limit(1);
    return rows[0];
  },

  async getWithContent(id: string): Promise<DatasourceFile | undefined> {
    const rows = await db.select().from(datasourceFiles).where(eq(datasourceFiles.id, id)).limit(1);
    return rows[0];
  },

  async claim(id: string, workspaceId: string, datasourceId: string): Promise<void> {
    await db
      .update(datasourceFiles)
      .set({ datasourceId })
      .where(and(eq(datasourceFiles.id, id), eq(datasourceFiles.workspaceId, workspaceId)));
  },

  /** Uploads nobody registered a datasource against, older than `before`. */
  async sweepUnclaimed(before: Date): Promise<void> {
    await db
      .delete(datasourceFiles)
      .where(and(isNull(datasourceFiles.datasourceId), lt(datasourceFiles.createdAt, before)));
  },

  /** A replaced file: every other file this datasource held. */
  async removeOthers(datasourceId: string, keepId: string): Promise<void> {
    const rows = await db
      .select({ id: datasourceFiles.id })
      .from(datasourceFiles)
      .where(eq(datasourceFiles.datasourceId, datasourceId));
    for (const r of rows) {
      if (r.id !== keepId) await db.delete(datasourceFiles).where(eq(datasourceFiles.id, r.id));
    }
  },
};
