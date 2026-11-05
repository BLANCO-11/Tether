import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { datasourceQueries, datasources } from "../db/schema.js";

export type NewDatasourceQuery = typeof datasourceQueries.$inferInsert;
export type DatasourceQuery = typeof datasourceQueries.$inferSelect;
export type Datasource = typeof datasources.$inferSelect;

export const datasourceQueryRepo = {
  async listByDatasource(datasourceId: string): Promise<DatasourceQuery[]> {
    return db
      .select()
      .from(datasourceQueries)
      .where(eq(datasourceQueries.datasourceId, datasourceId))
      .orderBy(datasourceQueries.name);
  },

  /** Every named query in a workspace, with its datasource — what the manifest renders. */
  async listByWorkspace(
    workspaceId: string,
  ): Promise<Array<{ query: DatasourceQuery; datasource: Datasource }>> {
    const rows = await db
      .select({ query: datasourceQueries, datasource: datasources })
      .from(datasourceQueries)
      .innerJoin(datasources, eq(datasourceQueries.datasourceId, datasources.id))
      .where(eq(datasources.workspaceId, workspaceId));
    return rows;
  },

  /**
   * Resolve a `<datasource-name>.<query-name>` reference within one workspace.
   *
   * The workspace filter is the tenancy boundary, not a convenience: a step ref
   * arrives from a flow definition, and resolving it globally would let a flow
   * in one workspace name another workspace's query (risk 1c).
   */
  async resolveRef(
    workspaceId: string,
    datasourceName: string,
    queryName: string,
  ): Promise<{ query: DatasourceQuery; datasource: Datasource } | undefined> {
    const rows = await db
      .select({ query: datasourceQueries, datasource: datasources })
      .from(datasourceQueries)
      .innerJoin(datasources, eq(datasourceQueries.datasourceId, datasources.id))
      .where(
        and(
          eq(datasources.workspaceId, workspaceId),
          eq(datasources.name, datasourceName),
          eq(datasourceQueries.name, queryName),
        ),
      )
      .limit(1);
    return rows[0];
  },

  async upsertByName(data: NewDatasourceQuery): Promise<DatasourceQuery> {
    const rows = await db
      .insert(datasourceQueries)
      .values(data)
      .onConflictDoUpdate({
        target: [datasourceQueries.datasourceId, datasourceQueries.name],
        set: {
          sqlText: data.sqlText,
          paramOrder: data.paramOrder,
          paramsSchema: data.paramsSchema,
          description: data.description,
          // Only written when the caller described it: a seed that upserts without describing must not erase one.
          ...(data.describedJson !== undefined ? { describedJson: data.describedJson } : {}),
          ...(data.columnTags !== undefined ? { columnTags: data.columnTags } : {}),
          updatedAt: new Date(),
        },
      })
      .returning();
    return rows[0];
  },

  async remove(datasourceId: string, name: string): Promise<boolean> {
    const rows = await db
      .delete(datasourceQueries)
      .where(
        and(eq(datasourceQueries.datasourceId, datasourceId), eq(datasourceQueries.name, name)),
      )
      .returning({ id: datasourceQueries.id });
    return rows.length > 0;
  },
};
