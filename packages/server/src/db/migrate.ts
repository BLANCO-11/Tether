import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "../config/index.js";
import { reconcileMigrations } from "./migrate-reconcile.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../drizzle");

async function main() {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const db = drizzle(pool);
  console.log(`[migrate] applying migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });

  // drizzle applies only what is newer than the newest recorded row; anything older it has no hash for (a branch's migrations
  // sharing timestamps with another's, or a file edited after it ran) is applied here — see migrate-reconcile.ts.
  const client = await pool.connect();
  try {
    const { applied } = await reconcileMigrations(
      {
        exec: async (sql) => { await client.query(sql); },
        rows: async (sql, params) => (await client.query(sql, params as unknown[])).rows,
      },
      migrationsFolder,
    );
    for (const a of applied) {
      console.warn(
        `[migrate] ${a.tag} had no record and was applied now` +
          (a.skippedStatements ? ` (${a.skippedStatements} statement(s) already existed and were skipped)` : ""),
      );
    }
  } finally {
    client.release();
  }
  console.log("[migrate] done");
  await pool.end();
  // ⚠ Schema only. Nothing is seeded here (prod release, 2026-10-21): a workspace gets its platform tools
  // (`tether_email_send`, `llm_complete`) when it is created, and `pnpm --filter @foundry/server platform:tools`
  // refreshes them in every workspace on purpose (e.g. after rotating PARENT_API_KEY or OPS_API_KEY).
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
