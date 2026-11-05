/**
 * The bridge's database credential must be a deployment decision, not a default.
 *
 * ── What this is defending ──────────────────────────────────────────────────
 *
 * `schema-store.ts` used to fall back to
 * `postgres://foundry:foundry@localhost:5433/foundry_parent` — the parent
 * database's OWNER credential — for a service that reads structural metadata.
 * A deployment that forgot to configure it therefore got FULL read access to
 * `foundry_parent` (which holds `workspace_secrets`) instead of an error naming
 * the variable. The failure direction was the wrong one: silence meant more
 * privilege, not less.
 *
 * ⚠ This does NOT prove the bridge is least-privilege — `docker-compose.yml`
 * still hands it the owner DSN. It proves the credential can no longer arrive by
 * accident. See the note beside the compose service for what is still open.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

const REAL = process.env.DATABASE_URL;

beforeEach(() => vi.resetModules());
afterEach(() => {
  if (REAL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = REAL;
});

describe("the bridge's DSN is required, never defaulted", () => {
  it("refuses to load with no DATABASE_URL, rather than reaching for owner credentials", async () => {
    delete process.env.DATABASE_URL;

    await expect(import("./schema-store.js")).rejects.toThrow(/DATABASE_URL is required/);
  });

  it("refuses an empty DATABASE_URL too — a blank value is not a configured one", async () => {
    process.env.DATABASE_URL = "";

    await expect(import("./schema-store.js")).rejects.toThrow(/DATABASE_URL is required/);
  });

  /**
   * ⚠ THE CONTROL. Without this, a module that always threw would satisfy the
   * two tests above and take the bridge down with it.
   */
  it("CONTROL — loads and exposes its four read-only tools when the DSN is configured", async () => {
    process.env.DATABASE_URL = "postgres://reader:pw@localhost:5433/foundry_parent";

    const { schemaStore } = await import("./schema-store.js");

    expect(Object.keys(schemaStore).sort()).toEqual([
      "describeRelationships",
      "getColumnStats",
      "listTables",
      "readTableSchema",
    ]);
  });

  /**
   * The message has to name the variable and say why there is no default, or the
   * next person restores the default as "a sensible fallback" — which is exactly
   * what it was.
   */
  it("says what to set and why it is not defaulted", async () => {
    delete process.env.DATABASE_URL;

    await expect(import("./schema-store.js")).rejects.toThrow(/owner credential/);
  });
});
