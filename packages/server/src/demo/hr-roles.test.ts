import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { config } from "../config/index.js";
import { hrDbUrl, hrRoDbUrl, hrDbUrlForScripts } from "./seed-hr-db.js";
import { verifyReadOnlyRole } from "./hr-roles.js";

/**
 * WS-A.5 — the negative tests that are the point of the workstream
 * (plans/production-substitution-plan.md §4.5).
 *
 * These assert what the credential handed to generated scripts CANNOT do. If a
 * future GRANT, a reseed, or a refactor restores write access, these fail — which
 * is the only reason the read-only role is worth anything. Asserting the positive
 * ("SELECT works") would pass just as happily against the old superuser.
 *
 * Requires a seeded `hr_demo` (`pnpm demo:seed`). Skipped, loudly, when the
 * database is unreachable — an absent database is not a privilege regression, so
 * failing here would just teach people to ignore the suite.
 */

let ro: Client;

/**
 * The probe runs at MODULE level, not in beforeAll. `describe.skipIf(...)` is
 * evaluated during collection — before any hook runs — so a flag set in
 * beforeAll is still its initial value when skipIf reads it, and every test
 * silently skips even against a healthy database. Top-level await resolves
 * before collection reaches the describe.
 */
const { reachable, skipReason } = await (async () => {
  const c = new Client({ connectionString: hrRoDbUrl(), connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
    await c.query("SELECT 1 FROM employees LIMIT 1");
    await c.end();
    return { reachable: true, skipReason: "" };
  } catch (e) {
    await c.end().catch(() => {});
    return { reachable: false, skipReason: (e as Error).message };
  }
})();

if (!reachable) {
  console.warn(
    `\n[WS-A] SKIPPING privilege tests — cannot connect to ${config.demo.dbName} as ` +
      `${config.demo.roRole}: ${skipReason}\n` +
      "        Run `pnpm demo:seed` first. These tests are the enforcement of least\n" +
      "        privilege; a skipped run proves nothing.\n",
  );
}

beforeAll(async () => {
  if (!reachable) return;
  ro = new Client({ connectionString: hrRoDbUrl() });
  await ro.connect();
});

afterAll(async () => {
  await ro?.end().catch(() => {});
});

/**
 * Run a statement that must be refused. Each runs in its own aborted
 * transaction: a failed statement poisons the session until ROLLBACK, so without
 * this every test after the first would fail for the wrong reason.
 */
async function mustBeRefused(sql: string): Promise<string> {
  await ro.query("BEGIN");
  try {
    await ro.query(sql);
    await ro.query("ROLLBACK");
    throw new Error(`SECURITY: "${sql}" was PERMITTED for ${config.demo.roRole}`);
  } catch (e) {
    const msg = (e as Error).message;
    await ro.query("ROLLBACK").catch(() => {});
    if (msg.startsWith("SECURITY:")) throw e;
    return msg;
  }
}

describe.skipIf(!reachable)("WS-A read-only datasource role", () => {
  it("1. can SELECT from every introspected table", async () => {
    const { rows } = await ro.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const { tablename } of rows) {
      // Identifier is read straight out of pg_tables, so it is already trusted.
      const r = await ro.query(`SELECT count(*) FROM public.${tablename}`);
      expect(r.rows[0]).toBeDefined();
    }
  });

  it("2. cannot UPDATE employees", async () => {
    const msg = await mustBeRefused("UPDATE employees SET full_name = 'x' WHERE id = 1");
    expect(msg).toMatch(/permission denied|read-only/i);
  });

  it("3. cannot DELETE from employees", async () => {
    const msg = await mustBeRefused("DELETE FROM employees WHERE id = 1");
    expect(msg).toMatch(/permission denied|read-only/i);
  });

  it("4. cannot TRUNCATE employees", async () => {
    const msg = await mustBeRefused("TRUNCATE employees");
    expect(msg).toMatch(/permission denied|must be owner|read-only/i);
  });

  it("5. cannot DROP employees", async () => {
    const msg = await mustBeRefused("DROP TABLE employees");
    expect(msg).toMatch(/permission denied|must be owner|read-only/i);
  });

  it("6. cannot CREATE a table", async () => {
    // The one most easily left open: PG14 and earlier grant CREATE on schema
    // public to PUBLIC, so this passes unless the grant is explicitly revoked.
    const msg = await mustBeRefused("CREATE TABLE foundry_ro_probe (i int)");
    expect(msg).toMatch(/permission denied|read-only/i);
  });

  it("7. cannot reach a capture table at all", async () => {
    // The property: a script cannot satisfy "send the email" with an INSERT.
    // The capture tables have never been in `hr_demo`, and the credential under
    // test here only reaches `hr_demo` — so this refusal is "no such table".
    //
    // ⚠ Read what this does and does not prove. It is a check on the SCRIPT
    // credential's reach, and it got stronger in Stage 5 without this line
    // changing: `mail_outbox` used to be `stub_mail_outbox` one database away in
    // `foundry_parent`, and it is now in a different service's database behind a
    // network hop and an API key. But that additional distance is asserted by
    // `kestra:check`'s ops-api boundary block, not here — a "does not exist"
    // reads identically whether the table is one database away or three.
    const msg = await mustBeRefused("INSERT INTO mail_outbox (id) VALUES (1)");
    expect(msg).toMatch(/does not exist|permission denied|read-only/i);
  });

  it("8. is cut off by statement_timeout on a runaway query", async () => {
    const started = Date.now();
    await expect(
      ro.query(
        "SELECT count(*) FROM attendance_daily a, attendance_daily b, attendance_daily c",
      ),
    ).rejects.toThrow(/statement timeout|canceling statement/i);
    // The configured ceiling is 30s; allow slack but prove it was bounded.
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 90_000);

  it("9. holds no write privilege on any table, per the catalogue", async () => {
    // Asked of pg_catalogue as the OWNER, so a missing grant cannot be confused
    // with a failed connection. This is the assertion demo:verify also runs.
    const owner = new Client({ connectionString: hrDbUrl() });
    await owner.connect();
    try {
      const { problems, selectableTables } = await verifyReadOnlyRole(owner);
      expect(problems).toEqual([]);
      expect(selectableTables.length).toBeGreaterThan(0);
    } finally {
      await owner.end();
    }
  });

  it("10. is not a superuser and does not own the database", async () => {
    const { rows } = await ro.query<{ user: string; super: boolean; owner: string }>(
      `SELECT current_user AS user,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super,
              (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) AS owner`,
    );
    expect(rows[0].user).toBe(config.demo.roRole);
    expect(rows[0].super).toBe(false);
    expect(rows[0].owner).not.toBe(config.demo.roRole);
  });
});

describe("WS-A credential hygiene", () => {
  it("registers the read-only role, never the owner, in the script-facing DSN", () => {
    // Pure string check — runs even without a database, because getting this
    // wrong is exactly the regression that would silently re-open G1.
    const scripts = new URL(hrDbUrlForScripts());
    expect(decodeURIComponent(scripts.username)).toBe(config.demo.roRole);
    expect(decodeURIComponent(scripts.username)).not.toBe(new URL(hrDbUrl()).username);
  });

  it("never exposes the read-only password through demoStatus", async () => {
    const { demoStatus } = await import("./provision.js");
    const body = JSON.stringify(await demoStatus());
    expect(body).not.toContain(config.demo.roPassword);
    expect(body).not.toMatch(/:\/\/[^@"]*:[^@"*]+@/); // no user:pass@host anywhere
  });
});
