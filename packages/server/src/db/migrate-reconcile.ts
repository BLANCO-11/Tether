/**
 * Apply every migration in the repo that the database has no record of — not only the ones newer than its newest row.
 * (2026-10-03, the prod VM.)
 *
 * drizzle's `migrate()` reads ONE row — the newest `created_at` in `drizzle.__drizzle_migrations` — and applies only journal
 * entries whose `when` is greater. It never compares hashes or names. So when two branches each carry their own 0072–0076 with
 * the same `when` values and a database runs one branch first, deploying the other skips all five of its migrations: `migrate`
 * prints "done", exits 0, and the server boots on a schema missing columns its code reads (the workflows list 500'd on
 * `flows.incomplete_model`). The same happens to a migration file edited after it was applied (its hash changes).
 *
 * drizzle records the sha256 of each file it applies, so this compares EVERY journal entry's hash with the recorded set and, for
 * each one missing, runs it in its own transaction and records it — the step drizzle skipped. Three outcomes, never a silent one:
 *
 *   applied   — every statement ran.
 *   skipped   — a drizzle-split statement (one per `--> statement-breakpoint` chunk) failed only because its object already exists,
 *               i.e. a file edited after it was applied, or the same object made by another branch. The rest still ran.
 *   THROWN    — any other error, or an "already exists" in a chunk holding several statements (which part existed is unknowable).
 *               The migration is rolled back, `migrate` exits non-zero, and the server does not start on a broken schema — with a
 *               message naming the file. Booting anyway is how the VM got here.
 */
import { readFileSync } from "node:fs";
import { readMigrationFiles } from "drizzle-orm/migrator";

/** The seam: a pg client or PGlite. `exec` may carry several statements; `rows` is one statement with parameters. */
export interface MigrationDb {
  exec(sql: string): Promise<void>;
  rows<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** SQLSTATEs meaning "that object is already there": duplicate table/index/relation, column, object (constraint, type), schema, function. */
const ALREADY_EXISTS = new Set(["42P07", "42701", "42710", "42P06", "42723"]);

export interface ReconcileResult {
  /** Migrations that had no recorded hash and are now applied and recorded. */
  applied: Array<{ tag: string; skippedStatements: number }>;
}

export async function reconcileMigrations(db: MigrationDb, migrationsFolder: string): Promise<ReconcileResult> {
  const files = readMigrationFiles({ migrationsFolder });
  const tags = journalTags(migrationsFolder);
  const recorded = new Set((await db.rows<{ hash: string }>(`select hash from drizzle.__drizzle_migrations`)).map((r) => r.hash));
  const result: ReconcileResult = { applied: [] };

  for (const [i, m] of files.entries()) {
    if (recorded.has(m.hash)) continue;
    const tag = tags[i] ?? `#${i}`;
    const chunks = m.sql.filter((s) => s.trim().length > 0);
    let skippedStatements = 0;
    await db.exec("begin");
    try {
      for (const stmt of chunks) {
        await db.exec("savepoint reconcile_stmt");
        try {
          await db.exec(stmt);
          await db.exec("release savepoint reconcile_stmt");
        } catch (e) {
          await db.exec("rollback to savepoint reconcile_stmt");
          const code = (e as { code?: string }).code;
          if (code && ALREADY_EXISTS.has(code) && chunks.length > 1) { skippedStatements++; continue; }
          throw new Error(
            `migration ${tag} is not recorded in drizzle.__drizzle_migrations and could not be applied: ${(e as Error).message}` +
              (code && ALREADY_EXISTS.has(code)
                ? ` — part of it already exists and the file is one chunk, so which part is unknowable. Apply what is missing by hand, then ` +
                  `insert into drizzle.__drizzle_migrations (hash, created_at) values ('${m.hash}', ${m.folderMillis}).`
                : ""),
          );
        }
      }
      await db.rows(`insert into drizzle.__drizzle_migrations ("hash", "created_at") values ($1, $2)`, [m.hash, m.folderMillis]);
      await db.exec("commit");
      result.applied.push({ tag, skippedStatements });
    } catch (e) {
      await db.exec("rollback").catch(() => {});
      throw e;
    }
  }
  return result;
}

/** Journal tags in journal order — `readMigrationFiles` returns the same order and drops the names. */
function journalTags(folder: string): string[] {
  const j = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8")) as { entries: Array<{ tag: string }> };
  return j.entries.map((e) => e.tag);
}
