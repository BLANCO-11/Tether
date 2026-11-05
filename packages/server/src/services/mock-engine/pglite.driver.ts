/**
 * PGlite mock engine driver — postgres/postgresql test runs.
 *
 * Each `prepare` boots a fresh in-process Postgres inside a dedicated
 * `worker_threads` Worker, creates one table per `MockTable`, inserts the
 * fixture rows, and hands back a small serializable handle. `query` runs the
 * frozen step SQL read-only (shape guard + preemptive timeout + row cap).
 * `destroy` terminates the worker — teardown runs on success AND failure at
 * the call site, and `destroy` itself is idempotent.
 *
 * Why a worker: PGlite executes synchronously on its thread, so a JS-side
 * timer on the same thread can never interrupt a runaway query (measured:
 * a 50M-row `generate_series` sum ran 9s straight through a 100ms `SET
 * statement_timeout` and a 100ms `Promise.race`). PGlite also ignores
 * `statement_timeout`. The only real control is `worker.terminate()` — a
 * timed-out handle is therefore dead afterwards (its worker is gone), and any
 * later `query` on it fails with "already destroyed". The caller re-prepares
 * from the fingerprint-gated fixture; a timeout never leaves a lingering
 * instance behind.
 *
 * The read-only guard mirrors `WRITE_KEYWORDS` in
 * `datasource-query.service.ts` deliberately: the engine is the second
 * control behind `checkSqlShape`, and two different keyword lists is where a
 * write-shaped statement would slip through exactly one of them.
 */

import { Worker } from "node:worker_threads";
import { coerceNumberColumns, numberColumns, type ColumnField } from "../query-row-numbers.js";
import { createRequire } from "node:module";
import {
  MockEngineTimeoutError,
  MockEngineWriteRejectedError,
  type MockEngineDriver,
  type MockHandle,
  type MockTable,
} from "./types.js";

/** Rows returned per query are capped — a mock is a shape check, not a dump. */
export const MOCK_MAX_ROWS = 1000;
/** Per-query execution budget, enforced by terminating the handle's worker. */
export const MOCK_STATEMENT_TIMEOUT_MS = 2000;
/** Worker boot + fixture load budget — hangs there fail the prepare, never the suite. */
export const MOCK_LOAD_TIMEOUT_MS = 30_000;

export interface PGliteDriverOptions {
  maxRows?: number;
  statementTimeoutMs?: number;
}

const require = createRequire(import.meta.url);
const PGLITE_CJS = require.resolve("@electric-sql/pglite");

interface PGliteHandle extends MockHandle {
  readonly handleId: string;
}

interface WorkerResponse {
  id?: number;
  type?: string;
  ok?: boolean;
  rows?: Record<string, unknown>[];
  /** Each column's name and type OID, so a number column can be returned as a number. */
  fields?: ColumnField[];
  error?: string;
}

interface LiveWorker {
  worker: Worker;
  dead: boolean;
  nextId: number;
  pending: Map<number, (msg: WorkerResponse) => void>;
}

/**
 * Live workers, keyed by handle id. The handle itself stays small and
 * serializable (formatting a resolved handle — e.g. in a test failure — must
 * never walk a database instance); only this driver maps id back to a worker.
 */
const instances = new Map<string, LiveWorker>();
/** Ids this process created and already tore down — destroy stays idempotent for them. */
const deadIds = new Set<string>();
let nextHandleId = 1;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function assertIdent(kind: string, value: string): void {
  if (!IDENT.test(value)) {
    throw new Error(`mock engine cannot load ${kind} "${value}" — not a plain identifier`);
  }
}

/**
 * Map a generator column type onto a Postgres type. Known base types pass
 * through (with their length/precision suffix where the syntax allows it);
 * anything unrecognised becomes TEXT rather than failing the load — the mock
 * checks row shape, not DDL fidelity.
 */
function mapColumnType(type: string): string {
  /**
   * ⚠ An ARRAY is `<base>[]` and the scalar regex below cannot see it — the
   * bracket makes the whole string unmatchable, so `text[]` used to fall
   * through to the `default` and become a scalar `TEXT`. Inserting a JS array
   * into a text column is not a fidelity loss, it is a load failure.
   * `deriveShape` already maps `array:_text` to `text[]`, so the declared
   * spelling arrives here exactly like this.
   */
  const arr = type.trim().match(/^(.*?)\s*\[\s*\]$/);
  if (arr) return `${mapColumnType(arr[1]!)}[]`;
  const m = type.trim().match(/^([A-Za-z ]+?)(\s*\(\s*\d+(\s*,\s*\d+)?\s*\))?$/);
  const base = (m?.[1] ?? type).trim().toLowerCase().replace(/\s+/g, " ");
  const suffix = m?.[2] ?? "";
  switch (base) {
    case "text":
      return "TEXT";
    case "varchar":
    case "character varying":
    case "char":
    case "character":
      return `${base.toUpperCase()}${suffix}`;
    case "integer":
    case "int":
    case "int4":
      return "INTEGER";
    case "bigint":
    case "int8":
      return "BIGINT";
    case "smallint":
    case "int2":
      return "SMALLINT";
    case "numeric":
    case "decimal":
      return `NUMERIC${suffix}`;
    case "real":
    case "float4":
      return "REAL";
    case "double precision":
    case "float8":
      return "DOUBLE PRECISION";
    case "boolean":
    case "bool":
      return "BOOLEAN";
    case "date":
      return "DATE";
    case "time":
      return "TIME";
    case "timestamp":
      return "TIMESTAMP";
    case "timestamptz":
    case "timestamp with time zone":
      return "TIMESTAMPTZ";
    case "interval":
      return "INTERVAL";
    case "uuid":
      return "UUID";
    case "json":
      return "JSON";
    case "jsonb":
      return "JSONB";
    case "bytea":
      return "BYTEA";
    default:
      return "TEXT";
  }
}

function toCell(value: unknown, columnType: string): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  const base = columnType.trim().toLowerCase();
  if ((base === "json" || base === "jsonb") && typeof value === "object") {
    return JSON.stringify(value);
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

// ── read-only guard ──────────────────────────────────────────────────────────
// Word-boundary matched against literal-stripped SQL, same as checkSqlShape.

const WRITE_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "truncate",
  "drop",
  "alter",
  "create",
  "grant",
  "revoke",
  "copy",
  "merge",
  "call",
  "do",
  "set",
  "vacuum",
  "analyze",
  "reindex",
  "listen",
  "notify",
  "lock",
  "prepare",
  "execute",
  "begin",
  "commit",
  "rollback",
  "savepoint",
];

/** Blank out string literals, quoted identifiers and comments. */
function stripLiterals(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function assertReadOnly(sql: string): void {
  const bare = stripLiterals(sql);
  if (/\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$/.test(bare)) {
    throw new MockEngineWriteRejectedError(
      "dollar-quoted blocks ($$ … $$) are not allowed — a step query is a single read statement",
    );
  }
  if (bare.replace(/;\s*$/, "").includes(";")) {
    throw new MockEngineWriteRejectedError(
      "multiple statements are not allowed — a step query is a single read statement",
    );
  }
  const firstWord = bare.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!["select", "with", "table", "values"].includes(firstWord)) {
    throw new MockEngineWriteRejectedError(
      `a step query must begin with SELECT, WITH, TABLE or VALUES — this one begins with "${firstWord || "(nothing)"}"`,
    );
  }
  const found = WRITE_KEYWORDS.filter((k) => new RegExp(`\\b${k}\\b`, "i").test(bare));
  if (found.length > 0) {
    throw new MockEngineWriteRejectedError(
      `a step query must only read; found ${found.map((f) => f.toUpperCase()).join(", ")}`,
    );
  }
}

// ── worker plumbing ──────────────────────────────────────────────────────────

function workerSource(): string {
  return `
const { parentPort } = require("node:worker_threads");
const { PGlite } = require(${JSON.stringify(PGLITE_CJS)});
(async () => {
  const db = new PGlite();
  await db.waitReady;
  parentPort.postMessage({ type: "ready" });
  parentPort.on("message", async (msg) => {
    if (msg && msg.type === "query") {
      try {
        const r = await db.query(msg.sql, msg.params);
        parentPort.postMessage({ id: msg.id, ok: true, rows: r.rows, fields: (r.fields || []).map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })) });
      } catch (e) {
        parentPort.postMessage({ id: msg.id, ok: false, error: String((e && e.message) || e) });
      }
    }
  });
})().catch((e) => {
  try { parentPort.postMessage({ type: "fatal", error: String((e && e.message) || e) }); } catch {}
});
`;
}

function recordOf(handle: MockHandle): LiveWorker {
  const h = handle as Partial<PGliteHandle>;
  if (h?.driver !== "pglite" || typeof h?.handleId !== "string") {
    throw new Error("mock engine handle does not belong to the pglite driver");
  }
  const rec = instances.get(h.handleId);
  if (!rec) {
    if (deadIds.has(h.handleId)) throw new Error("mock engine handle is already destroyed");
    throw new Error("mock engine handle does not belong to the pglite driver");
  }
  return rec;
}

function kill(rec: LiveWorker, handleId: string): void {
  rec.dead = true;
  instances.delete(handleId);
  deadIds.add(handleId);
  for (const resolve of rec.pending.values()) {
    resolve({ ok: false, error: "mock engine handle is already destroyed" });
  }
  rec.pending.clear();
  rec.worker.terminate().catch(() => {});
}

/** Send one statement to the handle's worker and await its response. */
function exec(rec: LiveWorker, sql: string, params: unknown[], budgetMs: number): Promise<WorkerResponse> {
  const id = rec.nextId++;
  return new Promise<WorkerResponse>((resolve) => {
    const timer = setTimeout(() => {
      rec.pending.delete(id);
      resolve({ ok: false, error: `mock engine load exceeded ${budgetMs}ms` });
    }, budgetMs);
    rec.pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    rec.worker.postMessage({ type: "query", id, sql, params });
  });
}

export function createPgliteDriver(opts: PGliteDriverOptions = {}): MockEngineDriver {
  const maxRows = opts.maxRows ?? MOCK_MAX_ROWS;
  const timeoutMs = opts.statementTimeoutMs ?? MOCK_STATEMENT_TIMEOUT_MS;

  return {
    dialect: "postgres",

    async prepare(
      workspaceId: string,
      datasourceId: string,
      fingerprint: string,
      tables: MockTable[],
    ): Promise<MockHandle> {
      for (const t of tables) {
        assertIdent("table", t.name);
        for (const c of t.columns) {
          assertIdent("column", c.name);
          if (!c.type || typeof c.type !== "string") {
            throw new Error(`mock engine cannot load column "${t.name}.${c.name}" — missing type`);
          }
        }
      }

      const worker = new Worker(workerSource(), { eval: true });
      const rec: LiveWorker = { worker, dead: false, nextId: 1, pending: new Map() };
      const handleId = `mock-${nextHandleId++}`;
      const fail = (e: unknown): never => {
        kill(rec, handleId);
        throw e instanceof Error ? e : new Error(String(e));
      };

      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("mock engine worker did not boot")), MOCK_LOAD_TIMEOUT_MS);
          const onMessage = (msg: WorkerResponse) => {
            if (msg?.type === "ready") {
              clearTimeout(timer);
              worker.off("message", onMessage);
              resolve();
            } else if (msg?.type === "fatal") {
              clearTimeout(timer);
              worker.off("message", onMessage);
              reject(new Error(`mock engine worker failed to boot: ${msg.error}`));
            }
          };
          worker.on("message", onMessage);
          worker.once("error", (e) => {
            clearTimeout(timer);
            reject(e);
          });
        });

        worker.on("message", (msg: WorkerResponse) => {
          const resolve = typeof msg?.id === "number" ? rec.pending.get(msg.id) : undefined;
          if (resolve) {
            rec.pending.delete(msg.id as number);
            resolve(msg);
          }
        });
        worker.once("error", () => kill(rec, handleId));

        for (const t of tables) {
          const defs = t.columns.map((c) => `${quoteIdent(c.name)} ${mapColumnType(c.type)}`).join(", ");
          const created = await exec(rec, `CREATE TABLE ${quoteIdent(t.name)} (${defs})`, [], MOCK_LOAD_TIMEOUT_MS);
          if (!created.ok) throw new Error(`mock engine could not load table "${t.name}": ${created.error}`);
          // Chunked multi-row INSERTs; a 10-rows/table fixture is one chunk.
          const CHUNK = 100;
          for (let i = 0; i < t.rows.length; i += CHUNK) {
            const chunk = t.rows.slice(i, i + CHUNK);
            const placeholders: string[] = [];
            const values: unknown[] = [];
            chunk.forEach((row, ri) => {
              const rowPh = t.columns.map((c, ci) => {
                values.push(toCell(row[c.name], c.type));
                return `$${ri * t.columns.length + ci + 1}`;
              });
              placeholders.push(`(${rowPh.join(", ")})`);
            });
            const cols = t.columns.map((c) => quoteIdent(c.name)).join(", ");
            const inserted = await exec(
              rec,
              `INSERT INTO ${quoteIdent(t.name)} (${cols}) VALUES ${placeholders.join(", ")}`,
              values,
              MOCK_LOAD_TIMEOUT_MS,
            );
            if (!inserted.ok) throw new Error(`mock engine could not load table "${t.name}": ${inserted.error}`);
          }
        }
      } catch (e) {
        fail(e);
      }

      instances.set(handleId, rec);
      return { driver: "pglite", workspaceId, datasourceId, fingerprint, handleId };
    },

    async query(
      handle: MockHandle,
      sql: string,
      params: unknown[],
    ): Promise<{ rows: Record<string, unknown>[] }> {
      const h = handle as Partial<PGliteHandle>;
      const rec = recordOf(handle);
      const handleId = h.handleId as string;
      assertReadOnly(sql);

      const id = rec.nextId++;
      const answer = new Promise<WorkerResponse>((resolve) => {
        rec.pending.set(id, resolve);
        rec.worker.postMessage({ type: "query", id, sql, params });
      });
      const refused = new Promise<WorkerResponse>((resolve) => {
        setTimeout(() => resolve({ ok: false, error: "timeout" }), timeoutMs);
      });
      const msg = await Promise.race([answer, refused]);
      if (!msg.ok && msg.error === "timeout") {
        // Preemptive and absolute: the worker is gone, so nothing lingers.
        // The handle is dead — a later query fails with "already destroyed".
        kill(rec, handleId);
        throw new MockEngineTimeoutError(timeoutMs);
      }
      if (!msg.ok) throw new Error(`mock engine query failed: ${msg.error}`);
      // The same normaliser the real executors use: a number column is a number.
      const cols = numberColumns(msg.fields, "pg");
      return { rows: coerceNumberColumns((msg.rows as Record<string, unknown>[]).slice(0, maxRows), cols) };
    },

    async destroy(handle: MockHandle): Promise<void> {
      const h = handle as Partial<PGliteHandle>;
      if (h?.driver !== "pglite" || typeof h?.handleId !== "string") {
        throw new Error("mock engine handle does not belong to the pglite driver");
      }
      const rec = instances.get(h.handleId);
      if (!rec) {
        if (deadIds.has(h.handleId)) return;
        throw new Error("mock engine handle does not belong to the pglite driver");
      }
      kill(rec, h.handleId);
    },
  };
}

/** Shared driver — stateless across handles (every prepare boots its own worker). */
export const pgliteDriver: MockEngineDriver = createPgliteDriver();
