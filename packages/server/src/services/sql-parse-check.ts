/**
 * Does a compiled read PARSE on the engine that will run it? (2026-10-02, FL02.)
 *
 * A read written for a goal compiled, was accepted and saved, and its first draft run died in the mock engine with
 * `syntax error at or near "$"` — after the person had been told it was built. The compiler is the authority over what may be saved,
 * so a statement its runtime cannot parse is a compile-time finding, never a run-time failure: this asks the same engine family the
 * read runs on (PGlite for Postgres — the mock engine — and SQLite through the same translation execution uses) to PARSE it, against
 * an empty database.
 *
 * Only a SYNTAX problem is reported. On an empty database every relation is missing, so "relation does not exist" / "no such table"
 * is expected and says nothing about the statement; a wrong column or type is the compiler's own check, against the real schema.
 * Parameters are bound as NULL so a well-formed `$n` never reads as a problem. One in-process PGlite, created on first use.
 */
import { isSqliteType } from "./sqlite-file.service.js";
import { toSqlite, SqliteDialectError } from "./sqlite-dialect.js";
import { DatabaseSync } from "./sqlite-driver.js";

type PG = { query: (sql: string, params?: unknown[]) => Promise<unknown> };
let pg: Promise<PG> | null = null;
const pglite = (): Promise<PG> => (pg ??= import("@electric-sql/pglite").then(({ PGlite }) => new PGlite() as unknown as PG));

/** The highest `$n` a statement uses — how many parameters to bind. */
const placeholders = (sql: string) => Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));

/** `null` when the statement parses on its engine; else what the engine said, in its words. */
export async function syntaxProblem(sql: string, datasourceType: string): Promise<string | null> {
  if (isSqliteType(datasourceType)) {
    let stmt: string;
    try { stmt = toSqlite(sql).sql; } catch (e) { if (e instanceof SqliteDialectError) return null; throw e; } // the dialect check reports it
    const db = new DatabaseSync(":memory:");
    try { db.prepare(stmt); return null; }
    catch (e) { const m = (e as Error).message; return /syntax error|unrecognized token|incomplete input/i.test(m) ? m : null; }
    finally { db.close(); }
  }
  try {
    await (await pglite()).query(`EXPLAIN ${sql}`, Array.from({ length: placeholders(sql) }, () => null));
    return null;
  } catch (e) {
    // SQLSTATE 42601 syntax_error, 42P02 undefined_parameter (a `$` that binds nothing): the statement itself is broken.
    const code = (e as { code?: string }).code;
    return code === "42601" || code === "42P02" ? (e as Error).message : null;
  }
}
