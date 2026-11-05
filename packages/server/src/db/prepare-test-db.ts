// Creates the tests' own database if it is missing, then applies every migration to it.
// `pnpm --filter @foundry/server test:db`. See vitest.config.ts for why tests have their own database.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL ?? "postgres://foundry:foundry@localhost:5433/foundry_test";
const target = new URL(url);
const name = target.pathname.replace(/^\//, "");
if (!name.endsWith("_test") || !/^[a-z0-9_]+$/.test(name)) {
  console.error(`[test-db] refusing "${name}": the tests' database name must be lowercase and end in "_test".`);
  process.exit(1);
}

const admin = new URL(url);
admin.pathname = "/postgres";
const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
if (exists.rowCount === 0) {
  await client.query(`CREATE DATABASE "${name}"`);
  console.log(`[test-db] created ${name}`);
} else {
  console.log(`[test-db] ${name} exists`);
}
await client.end();

const here = path.dirname(fileURLToPath(import.meta.url));
const migrate = spawnSync("npx", ["tsx", path.join(here, "migrate.ts")], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: url },
});
process.exit(migrate.status ?? 1);
