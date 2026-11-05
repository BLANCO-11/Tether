import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

const { Pool } = pg;

/** ops-api's own database. Read-write, four tables, all synthetic. */
export const pool = new Pool({ connectionString: config.databaseUrl });
export const db = drizzle(pool, { schema });
export { schema };

/**
 * `hr_demo`, through the **read-only** role.
 *
 * A separate pool rather than a second schema on the same connection, because
 * the two need different credentials and that is the point: this service serves
 * a directory API and must not be able to write employee data even by mistake.
 * The privilege is what enforces it — `foundry_ro` holds `CONNECT` + `USAGE` +
 * `SELECT` and nothing else — not `default_transaction_read_only`, which a
 * session can turn off.
 */
export const hrPool = new Pool({ connectionString: config.hrDatabaseUrl, max: 8 });

export async function hrQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const r = await hrPool.query<T>(text, values);
  return r.rows;
}
