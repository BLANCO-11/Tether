/**
 * The SQLite mock engine — a draft run against a `sqlite` datasource reads its
 * generated mock rows here, never the uploaded file.
 *
 * Same contract as `pglite.driver.ts`: the fixture's tables are loaded into a
 * private in-memory database per handle, the step's SQL runs against that, and
 * nothing else is reachable. Two things differ, both because SQLite is the
 * PRODUCTION dialect for these datasources:
 *
 *   - The step SQL is translated by `sqlite-dialect.ts`, the same translator the
 *     production read uses — so a draft run and a live run fail or succeed on
 *     the same statement. Running it on pglite instead would let a draft pass a
 *     Postgres spelling that the live run then refuses.
 *   - Read-only is `PRAGMA query_only`, set after the load. SQLite then refuses
 *     any write itself; the refusal is surfaced as `MockEngineWriteRejectedError`.
 *
 * ⚠ **The row cap is applied while stepping, not after.** Mock tables hold ten
 * rows each, but a join across several of them multiplies, and `.all()` would
 * materialise every row before the cap could discard them. `iterate()` stops
 * at `maxRows`. There is no statement timeout — node:sqlite offers no
 * interrupt — and that cap is the bound that stands in for one.
 */
import { DatabaseSync } from "../sqlite-driver.js";
import { toSqlite, bindValues, toSqliteValue } from "../sqlite-dialect.js";
import { MOCK_MAX_ROWS } from "./pglite.driver.js";
import { MockEngineWriteRejectedError } from "./types.js";
import type { MockEngineDriver, MockHandle, MockTable } from "./types.js";

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * A declared column type SQLite will accept as a type name. The fixture's types
 * are the Postgres names the shape deriver emits (`integer`, `numeric(10,2)`,
 * `timestamp`, `text[]`); SQLite takes any word sequence and derives an
 * affinity from it, so only characters its grammar rejects are removed.
 */
function sqliteTypeName(type: string): string {
  const cleaned = type.replace(/\[\]/g, "").replace(/[^A-Za-z0-9 (),]/g, "").trim();
  return cleaned || "TEXT";
}

const instances = new Map<string, DatabaseSync>();
let nextHandleId = 1;

export function createSqliteMockDriver(opts: { maxRows?: number } = {}): MockEngineDriver {
  const maxRows = opts.maxRows ?? MOCK_MAX_ROWS;

  return {
    dialect: "sqlite",

    async prepare(workspaceId: string, datasourceId: string, fingerprint: string, tables: MockTable[]): Promise<MockHandle> {
      const db = new DatabaseSync(":memory:");
      try {
        for (const t of tables) {
          if (t.columns.length === 0) continue;
          const defs = t.columns.map((c) => `${quoteIdent(c.name)} ${sqliteTypeName(c.type)}`).join(", ");
          db.exec(`CREATE TABLE ${quoteIdent(t.name)} (${defs})`);
          const cols = t.columns.map((c) => quoteIdent(c.name)).join(", ");
          const insert = db.prepare(
            `INSERT INTO ${quoteIdent(t.name)} (${cols}) VALUES (${t.columns.map(() => "?").join(", ")})`,
          );
          for (const row of t.rows) insert.run(...t.columns.map((c) => toSqliteValue(row[c.name])));
        }
        db.exec("PRAGMA query_only = 1");
      } catch (e) {
        db.close();
        throw new Error(`mock engine could not load the mock data: ${(e as Error).message}`);
      }
      const handleId = `sqlite-mock-${nextHandleId++}`;
      instances.set(handleId, db);
      return { driver: "sqlite", workspaceId, datasourceId, fingerprint, handleId };
    },

    async query(handle: MockHandle, sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
      const db = handle.driver === "sqlite" ? instances.get(handle.handleId) : undefined;
      if (!db) throw new Error("mock engine handle does not belong to the sqlite driver");
      const stmt = toSqlite(sql);
      const rows: Record<string, unknown>[] = [];
      try {
        for (const r of db.prepare(stmt.sql).iterate(...bindValues(stmt, params))) {
          rows.push({ ...(r as Record<string, unknown>) });
          if (rows.length >= maxRows) break;
        }
      } catch (e) {
        const message = (e as Error).message;
        if (/readonly|query_only|read-only/i.test(message)) throw new MockEngineWriteRejectedError(message);
        throw new Error(`mock engine query failed: ${message}`);
      }
      return { rows };
    },

    async destroy(handle: MockHandle): Promise<void> {
      const db = instances.get(handle.handleId);
      if (!db) return;
      instances.delete(handle.handleId);
      db.close();
    },
  };
}

export const sqliteMockDriver: MockEngineDriver = createSqliteMockDriver();
