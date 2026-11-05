import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { config } from "../config/index.js";
import { datasourcePrivilegeService } from "./datasource-privilege.service.js";

/**
 * The read-only gate, proven against a credential that CAN write — Stage 9.2.
 *
 * Stage 9's exit criterion is explicit about why: *"the refusal is proven by
 * planting one — a check that has never seen a writable credential is a check
 * that has never run."* So the two DSNs the demo already provides are used as a
 * matched pair, and neither half is optional:
 *
 *   owner (`config.databaseUrl` user, on `hr_demo`)  → MUST be refused
 *   `foundry_ro`                                     → MUST pass
 *
 * Without the second, "refuses everything" scores 100%.
 *
 * The third test is I-27 as a test, and it is the reason this file exists rather
 * than a one-line `default_transaction_read_only` read: an owner DSN that ASKS
 * for a read-only session must still be refused, because a session setting is a
 * preference and `SET transaction_read_only = off` turns it back on. The demo's
 * own note says the primary control is the absent grants; this proves the check
 * agrees.
 */

function dsnFor(user: string, password: string, db: string): string {
  const base = new URL(config.databaseUrl.replace(/^postgres(ql)?:\/\//, "http://"));
  return `postgres://${user}:${encodeURIComponent(password)}@${base.hostname}:${base.port || 5432}/${db}`;
}

const OWNER_DSN = (() => {
  const u = new URL(config.databaseUrl.replace(/^postgres(ql)?:\/\//, "http://"));
  return dsnFor(u.username, decodeURIComponent(u.password), config.demo.dbName);
})();
const RO_DSN = dsnFor(config.demo.roRole, config.demo.roPassword, config.demo.dbName);

/** Both halves must be reachable, or the pair proves nothing. */
const reachable = await (async () => {
  for (const dsn of [OWNER_DSN, RO_DSN]) {
    const c = new pg.Client({ connectionString: dsn, connectionTimeoutMillis: 4000 });
    try {
      await c.connect();
      await c.end();
    } catch (e) {
      console.warn(
        `\n[stage-9] SKIPPING the read-only gate tests — ${config.demo.dbName} unreachable ` +
          `(${(e as Error).message}). Run \`pnpm --filter @foundry/server demo:seed\` first.\n`,
      );
      return false;
    }
  }
  return true;
})();

afterAll(async () => {
  /* no shared pool here — each check opens and closes its own client */
});

describe.skipIf(!reachable)("the read-only gate", () => {
  it("REFUSES the owner credential, and says what it can do", async () => {
    const v = await datasourcePrivilegeService.verify("postgres", OWNER_DSN, ["public"]);
    expect(v.readOnly).toBe(false);
    expect(v.findings.map((f) => f.rule)).toContain("writable_relations");
    // The message has to name the fix, not just the fault.
    expect(v.findings.map((f) => f.message).join(" ")).toMatch(/INSERT|write/i);
  });

  it("ACCEPTS foundry_ro — the control, without which 'refuse everything' scores 100%", async () => {
    const v = await datasourcePrivilegeService.verify("postgres", RO_DSN, ["public"]);
    expect(v.findings).toEqual([]);
    expect(v.readOnly).toBe(true);
    // And it actually looked at something. A verdict over zero relations reads
    // exactly like a verdict over a clean database.
    expect(v.checked.relations).toBeGreaterThan(0);
    expect(v.checked.role).toBe(config.demo.roRole);
  });

  it("still refuses an owner DSN that asks for a read-only SESSION (I-27)", async () => {
    // The confusion that made a check pass for the wrong reason. This connection
    // genuinely is read-only for as long as nobody says otherwise — and anybody
    // can say otherwise, with one statement.
    const v = await datasourcePrivilegeService.verify(
      "postgres",
      `${OWNER_DSN}?options=-c%20default_transaction_read_only%3Don`,
      ["public"],
    );
    expect(v.readOnly).toBe(false);
    expect(v.findings.map((f) => f.rule)).toContain("writable_relations");
  });

  it("reports a schema it was not asked about as out of scope rather than clean", async () => {
    // Scope is the allowlist. Checking `public` says nothing about `hr`, which is
    // why `update` re-verifies when the allowlist widens.
    const v = await datasourcePrivilegeService.verify("postgres", RO_DSN, ["information_schema"]);
    expect(v.checked.schemas).toEqual(["information_schema"]);
  });

  it("only claims to gate the types it understands", () => {
    expect(datasourcePrivilegeService.supports("postgres")).toBe(true);
    expect(datasourcePrivilegeService.supports("mysql")).toBe(true);
    // Not a gap: only postgres and mysql can be introspected, so only they can
    // host a named query, and only a named query is reachable from a step.
    expect(datasourcePrivilegeService.supports("mongodb")).toBe(false);
  });
});
