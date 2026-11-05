import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { schemas } from "../db/schema.js";

export type NewSchemaRow = typeof schemas.$inferInsert;
export type SchemaRow = typeof schemas.$inferSelect;

export const schemaRepo = {
  listByDatasource(datasourceId: string): Promise<SchemaRow[]> {
    return db
      .select()
      .from(schemas)
      .where(eq(schemas.datasourceId, datasourceId))
      .orderBy(asc(schemas.entityName), asc(schemas.columnName));
  },

  async replaceForDatasource(datasourceId: string, rows: NewSchemaRow[]): Promise<number> {
    // Atomic refresh: drop old rows, insert the fresh introspection.
    return db.transaction(async (tx) => {
      await tx.delete(schemas).where(eq(schemas.datasourceId, datasourceId));
      if (rows.length > 0) {
        // chunk to stay well under parameter limits
        const CHUNK = 500;
        for (let i = 0; i < rows.length; i += CHUNK) {
          await tx.insert(schemas).values(rows.slice(i, i + CHUNK));
        }
      }
      return rows.length;
    });
  },
};
