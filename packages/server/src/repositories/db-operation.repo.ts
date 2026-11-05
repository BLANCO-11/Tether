import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { datasourceOperations, datasources } from "../db/schema.js";

export type NewDbOperation = typeof datasourceOperations.$inferInsert;
export type DbOperation = typeof datasourceOperations.$inferSelect;
export type Datasource = typeof datasources.$inferSelect;

export const dbOperationRepo = {
  async listByDatasource(datasourceId: string): Promise<DbOperation[]> {
    return db
      .select()
      .from(datasourceOperations)
      .where(eq(datasourceOperations.datasourceId, datasourceId))
      .orderBy(datasourceOperations.name);
  },

  /** Every operation in a workspace, with its datasource — what the manifest renders. */
  async listByWorkspace(
    workspaceId: string,
  ): Promise<Array<{ operation: DbOperation; datasource: Datasource }>> {
    const rows = await db
      .select({ operation: datasourceOperations, datasource: datasources })
      .from(datasourceOperations)
      .innerJoin(datasources, eq(datasourceOperations.datasourceId, datasources.id))
      .where(eq(datasources.workspaceId, workspaceId));
    return rows;
  },

  /**
   * Resolve a `<datasource-name>.<operation-name>` reference within one workspace.
   *
   * The workspace filter is the tenancy boundary, not a convenience: a step ref
   * arrives from a flow definition, and resolving it globally would let a flow
   * in one workspace name another workspace's operation (risk 1c). Mirrors
   * `datasourceQueryRepo.resolveRef` exactly.
   */
  async resolveRef(
    workspaceId: string,
    datasourceName: string,
    operationName: string,
  ): Promise<{ operation: DbOperation; datasource: Datasource } | undefined> {
    const rows = await db
      .select({ operation: datasourceOperations, datasource: datasources })
      .from(datasourceOperations)
      .innerJoin(datasources, eq(datasourceOperations.datasourceId, datasources.id))
      .where(
        and(
          eq(datasources.workspaceId, workspaceId),
          eq(datasources.name, datasourceName),
          eq(datasourceOperations.name, operationName),
        ),
      )
      .limit(1);
    return rows[0];
  },

  /**
   * Resolve a whole `<datasource-name>.<operation-name>` ref, split at the FIRST
   * dot — the same boundary `runNamedQuery` uses for query refs. A dot on either
   * side of the boundary therefore cannot resolve, exactly as for a query.
   */
  async getByRef(
    workspaceId: string,
    ref: string,
  ): Promise<{ operation: DbOperation; datasource: Datasource } | undefined> {
    const dot = ref.indexOf(".");
    if (dot <= 0 || dot === ref.length - 1) return undefined;
    return this.resolveRef(workspaceId, ref.slice(0, dot), ref.slice(dot + 1));
  },

  async create(data: NewDbOperation): Promise<DbOperation> {
    const rows = await db.insert(datasourceOperations).values(data).returning();
    return rows[0];
  },

  /** Update by (datasourceId, name) — the name IS the ref, so it never changes. */
  async update(
    datasourceId: string,
    name: string,
    data: Partial<NewDbOperation>,
  ): Promise<DbOperation | undefined> {
    const rows = await db
      .update(datasourceOperations)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(eq(datasourceOperations.datasourceId, datasourceId), eq(datasourceOperations.name, name)),
      )
      .returning();
    return rows[0];
  },

  async remove(datasourceId: string, name: string): Promise<boolean> {
    const rows = await db
      .delete(datasourceOperations)
      .where(
        and(eq(datasourceOperations.datasourceId, datasourceId), eq(datasourceOperations.name, name)),
      )
      .returning({ id: datasourceOperations.id });
    return rows.length > 0;
  },
};
