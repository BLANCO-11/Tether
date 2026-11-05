/**
 * A read of an uploaded SQLite file, run OFF the server's main thread (2026-10-12).
 *
 * ⚠ `node:sqlite` is synchronous: a statement runs to completion on the thread that called it. On the main thread a
 * read over a large file (a 70k-row production table, a minute of work) froze the whole API server — every page, every
 * request, every other workspace — until it finished. So each batch opens the file in its own worker thread, runs
 * there, and posts the rows back; the main thread only waits.
 *
 * The time limit is the second half. `node:sqlite` has no interrupt, so a timer cannot stop a statement; terminating
 * the worker can. A read past `timeoutMs` ends with a sentence naming the limit, never a hang. The worker is
 * terminated on every path, so nothing lingers holding the file open.
 *
 * The flag rule (`sqlite-flags.ts`) stays one definition: the worker sends back the schema and each result column's
 * origin as data, and the caller decides which columns are flags.
 */
import { Worker } from "node:worker_threads";
import type { FlagSchemaTable } from "./introspect/sqlite-flags.js";

export type SqliteRowResult = { ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string };

export type SqliteReadResult = {
  /** Each result column and the table column it comes from (null when computed). */
  origins: Array<{ name: string; table: string | null; column: string | null }>;
  schema: FlagSchemaTable[];
  /** One per bound parameter set, in order. */
  results: SqliteRowResult[];
};

export class SqliteReadTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(
      `The read took longer than ${describeMs(timeoutMs)} and was stopped. ` +
        `The usual cause is a join that cannot use an index (a CAST or function around a join column); otherwise ` +
        `narrow it (a filter, a shorter period) or read fewer rows.`,
    );
    this.name = "SqliteReadTimeoutError";
  }
}

function describeMs(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return ms === 60_000 ? "1 minute" : `${ms / 60_000} minutes`;
  return `${Math.round(ms / 1000)} seconds`;
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { path, sql, bindings } = workerData;
let db;
try {
  db = new DatabaseSync(path, { readOnly: true });
  const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  const schema = tables.map((t) => ({ name: t.name, sql: t.sql, cols: db.prepare("SELECT name, type FROM pragma_table_info(?)").all(t.name).map((c) => ({ name: c.name, type: c.type })) }));
  const prepared = db.prepare(sql);
  const origins = prepared.columns().map((c) => ({ name: c.name, table: c.table ?? null, column: c.column ?? null }));
  const results = bindings.map((values) => {
    try {
      return { ok: true, rows: prepared.all(...values).map((r) => ({ ...r })) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  parentPort.postMessage({ ok: true, origins, schema, results });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
} finally {
  try { db && db.close(); } catch {}
}
`;

/**
 * Open `path` read-only in a worker, prepare `sql` once and run it for each set of `bindings`. A statement the file
 * cannot prepare (or a file that cannot be opened) rejects with SQLite's own message; a read past `timeoutMs`
 * rejects with `SqliteReadTimeoutError`.
 */
export function readSqliteInWorker(input: {
  path: string;
  sql: string;
  bindings: unknown[][];
  timeoutMs: number;
}): Promise<SqliteReadResult> {
  return new Promise<SqliteReadResult>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { path: input.path, sql: input.sql, bindings: input.bindings },
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new SqliteReadTimeoutError(input.timeoutMs))), input.timeoutMs);
    worker.once("message", (msg: ({ ok: true } & SqliteReadResult) | { ok: false; error: string }) => {
      finish(() => {
        if (msg.ok) resolve({ origins: msg.origins, schema: msg.schema, results: msg.results });
        else reject(new Error(msg.error));
      });
    });
    worker.once("error", (e) => finish(() => reject(e)));
    worker.once("exit", (code) => finish(() => reject(new Error(`the SQLite read stopped unexpectedly (exit ${code})`))));
  });
}
