/**
 * A SQLite datasource's FILE — upload, validation, storage and the read path.
 *
 * ── What a sqlite datasource is ─────────────────────────────────────────────
 *
 * There is no server to dial. The person uploads a database file (≤ 16 MiB);
 * it is stored encrypted in `datasource_files`, and the datasource's
 * `connection_string_enc` holds only a pointer, `sqlite:file/<id>`. Everything
 * downstream — introspection, named queries, DB operations, step execution —
 * is handed that pointer as its DSN, exactly as it is handed a Postgres URL,
 * and turns it into a file on disk through `pathFor`.
 *
 * ⚠ **Always opened READ-ONLY, whatever the access policy says.** The stored
 * file is a snapshot, not a live database: a write would land in a temp copy
 * and vanish on the next materialisation, a run that "succeeded" at writing
 * something nobody can ever read back. So `sqlite` datasources accept only the
 * `read` policy (`datasource.service.ts` refuses the others by name), and
 * `node:sqlite`'s `readOnly` makes the engine itself refuse a write —
 * `attempt to write a readonly database` — the same shape of control as
 * Postgres's `BEGIN READ ONLY`.
 *
 * ⚠ **The pointer is a string a caller could type**, so registration checks the
 * file belongs to the registering workspace (`assertOwned`). That is this
 * datasource type's `assertRegistrableTarget`: there is no network target to
 * classify, only a row to own.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "./sqlite-driver.js";
import { datasourceFileRepo, type DatasourceFileMeta } from "../repositories/datasource-file.repo.js";
import { encryptBytes, decryptBytes } from "../utils/encryptor.js";
import { toSqlite } from "./sqlite-dialect.js";
import { nestedScanProblem, type PlanRow } from "./sqlite-join-plan.js";

/** 16 MiB — the product's stated bound, and the migration's CHECK. */
export const MAX_SQLITE_BYTES = 50 * 1024 * 1024;

export const SQLITE_DSN_PREFIX = "sqlite:file/";

/** The one schema a SQLite database has (attached databases are not offered). */
export const SQLITE_SCHEMA = "main";

const HEADER = Buffer.from("SQLite format 3\u0000", "latin1");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE_DIR = path.join(os.tmpdir(), "foundry-sqlite");
const UNCLAIMED_TTL_MS = 24 * 60 * 60 * 1000;

export class SqliteFileError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "SqliteFileError";
  }
}

export function dsnFor(fileId: string): string {
  return `${SQLITE_DSN_PREFIX}${fileId}`;
}

/** The file id a sqlite DSN points at, or null when it is not one. */
export function fileIdOf(dsn: string): string | null {
  if (!dsn.startsWith(SQLITE_DSN_PREFIX)) return null;
  const id = dsn.slice(SQLITE_DSN_PREFIX.length);
  return UUID_RE.test(id) ? id : null;
}

export function isSqliteType(type: string | null | undefined): boolean {
  return (type ?? "").toLowerCase() === "sqlite";
}

/**
 * A WAL-mode file (header bytes 18/19 = 2) cannot be opened read-only without
 * its `-wal`/`-shm` siblings, which an upload never carries — it fails as
 * "unable to open database file", which reads like a missing file. Setting
 * both bytes to 1 is SQLite's own documented switch back to a rollback
 * journal, and it changes no page of data.
 */
function withoutWal(buf: Buffer): Buffer {
  if (buf.length > 19 && (buf[18] === 2 || buf[19] === 2)) {
    const copy = Buffer.from(buf);
    copy[18] = 1;
    copy[19] = 1;
    return copy;
  }
  return buf;
}

async function ensureCacheDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
}

async function writePrivate(target: string, bytes: Buffer) {
  await ensureCacheDir();
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, bytes, { mode: 0o600 });
  await fs.rename(tmp, target);
}

/**
 * Open the file and ask SQLite whether it is sound, before anything is stored.
 * A file that passes the header check can still be truncated or corrupt, and
 * the place to say so is the upload — not the first flow that reads it.
 */
async function inspect(bytes: Buffer): Promise<{ tables: number; views: number }> {
  await ensureCacheDir();
  const probe = path.join(CACHE_DIR, `probe-${crypto.randomUUID()}.db`);
  await fs.writeFile(probe, bytes, { mode: 0o600 });
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(probe, { readOnly: true });
    const check = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    const verdict = String(Object.values(check[0] ?? {})[0] ?? "");
    if (verdict !== "ok") {
      throw new SqliteFileError(`the database file failed SQLite's integrity check: ${verdict || "no answer"}`);
    }
    const counts = db
      .prepare(
        "SELECT type, count(*) AS n FROM sqlite_schema WHERE type IN ('table','view') " +
          "AND name NOT LIKE 'sqlite_%' GROUP BY type",
      )
      .all() as Array<{ type: string; n: number }>;
    const tables = Number(counts.find((c) => c.type === "table")?.n ?? 0);
    const views = Number(counts.find((c) => c.type === "view")?.n ?? 0);
    return { tables, views };
  } catch (e) {
    if (e instanceof SqliteFileError) throw e;
    throw new SqliteFileError(`SQLite could not open this file: ${(e as Error).message}`);
  } finally {
    try { db?.close(); } catch { /* already closed */ }
    await fs.rm(probe, { force: true });
  }
}

export interface UploadedSqliteFile extends DatasourceFileMeta {
  tables: number;
  views: number;
}

export const sqliteFileService = {
  /** Validate and store an upload. Nothing is stored unless every check passes. */
  async store(workspaceId: string, raw: Buffer, filename?: string | null): Promise<UploadedSqliteFile> {
    if (!Buffer.isBuffer(raw) || raw.length === 0) {
      throw new SqliteFileError("no file was received — send the database as the request body");
    }
    if (raw.length > MAX_SQLITE_BYTES) {
      throw new SqliteFileError(
        `the file is ${(raw.length / 1024 / 1024).toFixed(1)} MB; a SQLite datasource may be at most 50 MB`,
        413,
      );
    }
    if (raw.length < 100 || !raw.subarray(0, HEADER.length).equals(HEADER)) {
      throw new SqliteFileError(
        "this is not a SQLite database — the file does not start with the SQLite header. " +
          "Upload the .db / .sqlite file itself, not an export or an archive.",
      );
    }
    const bytes = withoutWal(raw);
    const counts = await inspect(bytes);
    if (counts.tables + counts.views === 0) {
      throw new SqliteFileError("the database holds no tables or views, so there is nothing a workflow could read");
    }
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    void datasourceFileRepo.sweepUnclaimed(new Date(Date.now() - UNCLAIMED_TTL_MS)).catch(() => {});
    const meta = await datasourceFileRepo.create({
      workspaceId,
      kind: "sqlite",
      filename: filename ? filename.slice(0, 255) : null,
      sizeBytes: bytes.length,
      sha256,
      contentEnc: encryptBytes(bytes),
    });
    return { ...meta, ...counts };
  },

  /**
   * Refuse a pointer to a file this workspace does not own — the sqlite
   * equivalent of refusing a DSN aimed at somebody else's database.
   */
  async assertOwned(workspaceId: string, fileId: string): Promise<DatasourceFileMeta> {
    const meta = UUID_RE.test(fileId) ? await datasourceFileRepo.getMeta(fileId) : undefined;
    if (!meta || meta.workspaceId !== workspaceId) {
      throw new SqliteFileError("that database file was not uploaded to this workspace — upload it again");
    }
    return meta;
  },

  claim(workspaceId: string, fileId: string, datasourceId: string) {
    return datasourceFileRepo.claim(fileId, workspaceId, datasourceId);
  },

  removeOthers(datasourceId: string, keepId: string) {
    return datasourceFileRepo.removeOthers(datasourceId, keepId);
  },

  /**
   * The on-disk path of the file a DSN points at, materialising it if needed.
   * Keyed by id AND content hash, so a replaced file can never be served from
   * a stale cache entry.
   */
  async pathFor(dsn: string): Promise<string> {
    const id = fileIdOf(dsn);
    if (!id) throw new SqliteFileError(`not a sqlite connection string: expected ${SQLITE_DSN_PREFIX}<file id>`);
    const meta = await datasourceFileRepo.getMeta(id);
    if (!meta) throw new SqliteFileError("the database file behind this datasource no longer exists — upload it again", 409);
    const target = path.join(CACHE_DIR, `${id}-${meta.sha256}.db`);
    try {
      await fs.access(target);
      return target;
    } catch {
      /* not cached yet */
    }
    const row = await datasourceFileRepo.getWithContent(id);
    if (!row) throw new SqliteFileError("the database file behind this datasource no longer exists — upload it again", 409);
    const bytes = decryptBytes(Buffer.from(row.contentEnc));
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    if (sha !== row.sha256) throw new SqliteFileError("the stored database file does not match its recorded hash", 500);
    await writePrivate(target, bytes);
    return target;
  },

  /**
   * Would this Postgres-dialect statement RUN on this SQLite datasource?
   * Translated, then `prepare`d against the uploaded file — compiled, never
   * stepped, so no row is read. `null` means it would; otherwise SQLite's (or
   * the translator's) own reason.
   *
   * ⚠ This is what moves a dialect failure from the first run — after a person
   * approved the flow — to the save. Every reader a workflow can call on a
   * sqlite datasource (a named query, a DB operation, a proposed query) passes
   * through it before it is stored.
   */
  async statementProblem(dsn: string, pgSql: string): Promise<string | null> {
    let sql: string;
    try {
      sql = toSqlite(pgSql).sql;
    } catch (e) {
      return (e as Error).message;
    }
    const db = await this.open(dsn);
    try {
      db.prepare(sql);
    } catch (e) {
      db.close();
      return `SQLite cannot run this statement: ${(e as Error).message}`;
    }
    try {
      // How SQLite would run it (sqlite-join-plan.ts): EXPLAIN reads no rows; the sizes are the tables' counts.
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as unknown as PlanRow[];
      const counts = new Map<string, number | null>();
      const rowsOf = (table: string) => {
        if (!counts.has(table)) {
          try {
            const r = db.prepare(`SELECT count(*) AS n FROM "${table.replace(/"/g, '""')}"`).get() as { n: number } | undefined;
            counts.set(table, r ? Number(r.n) : null);
          } catch {
            counts.set(table, null);
          }
        }
        return counts.get(table)!;
      };
      return nestedScanProblem(plan, sql, rowsOf);
    } catch {
      return null; // a plan that cannot be read refuses nothing: the statement itself prepared
    } finally {
      db.close();
    }
  },

  /** A read-only handle. The caller closes it. */
  async open(dsn: string): Promise<DatabaseSync> {
    return new DatabaseSync(await this.pathFor(dsn), { readOnly: true });
  },
};
