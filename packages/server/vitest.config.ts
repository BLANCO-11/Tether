import { defineConfig } from "vitest/config";

/**
 * ⚠ **TESTS NEVER TOUCH THE APP'S DATABASE** (admin simplify, phase 1). Server tests that open Postgres used to read
 * the repo-root `.env` and write into the database the app itself uses — on a workstation the people list filled with
 * hundreds of test identities, and on the deployment host it was the LIVE database. `test.env` is applied before any
 * test imports `config`, and dotenv never overrides a variable already set, so this wins over `.env`.
 *
 * Create and migrate it once with `pnpm --filter @foundry/server test:db`. Point elsewhere with TEST_DATABASE_URL —
 * its database name must end in `_test`, or nothing runs.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://foundry:foundry@localhost:5433/foundry_test";
const testDbName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "");
if (!testDbName.endsWith("_test")) {
  throw new Error(
    `TEST_DATABASE_URL names the database "${testDbName}". Tests write to their database, so it must be one that exists ` +
      `only for tests: its name must end in "_test".`,
  );
}

/**
 * Deliberately minimal — every other vitest default stands.
 */
export default defineConfig({
  test: {
    // `GENERATION_PIPELINE=single`: the job tests mock `draftFlow` and pin THAT path;
    // the skeleton pipeline (the product default, D-275) has its own tests.
    env: { DATABASE_URL: TEST_DATABASE_URL, GENERATION_PIPELINE: "single", BUILDER_CHAT: "", BUILDER_PLAN_STAGES: "" }, // BUILDER_CHAT: the old chat path's tests read the repo .env too
  },
});
