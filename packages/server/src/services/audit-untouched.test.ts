import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";

/**
 * SC-014 / INV-16 — `audit_events` is STRUCTURALLY UNTOUCHED by this feature.
 *
 * ⚠ **Why it matters enough to have its own file.** The workspace audit view is what a
 * tenant reads to find out what happened, and this feature writes to that table for the
 * first time. If it had also *altered* the table, every pre-existing row's meaning would
 * be in question and FR-028 ("existing audit history is unchanged") would need a
 * migration-by-migration argument instead of a one-line one.
 *
 * It needed no migration because `operation: "access"` and `entity: "member" | "policy"`
 * were ALREADY in that table's CHECK constraints (research M-2). This asserts that is
 * still true, in both directions.
 */

const DRIZZLE = join(import.meta.dirname, "..", "..", "drizzle");

/** The migrations this feature added. */
const OURS = ["0062_workspace_roles", "0063_platform_roles", "0064_platform_audit", "0065_capability_rename"];

describe("SC-014: no RBAC migration alters audit_events", () => {
  it("CONTROL: the scan finds our four migrations", () => {
    const files = readdirSync(DRIZZLE).filter((f) => f.endsWith(".sql"));
    for (const tag of OURS) {
      expect(files, `${tag}.sql is missing`).toContain(`${tag}.sql`);
    }
  });

  it("not one of them mentions audit_events at all", () => {
    for (const tag of OURS) {
      const sqlText = readFileSync(join(DRIZZLE, `${tag}.sql`), "utf8");
      // ⚠ Comments included, deliberately — the opposite of the usual rule. Here a
      // MENTION would mean somebody was reasoning about changing it, and this assertion
      // is the place that conversation should happen.
      const code = sqlText
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("--"))
        .join("\n");
      expect(code, `${tag} touches audit_events`).not.toMatch(/\baudit_events\b/);
    }
  });

  it("⚠ and `platform_audit_events` is NOT the same table — the name is close on purpose", () => {
    // 0064 creates `platform_audit_events`. A regex for `audit_events` matches inside it,
    // which is why the assertion above uses a word boundary. This pins that the new table
    // is the one being created and the old one is not being altered.
    const sqlText = readFileSync(join(DRIZZLE, "0064_platform_audit.sql"), "utf8");
    expect(sqlText).toMatch(/CREATE TABLE IF NOT EXISTS "platform_audit_events"/);
    expect(sqlText).not.toMatch(/ALTER TABLE "audit_events"/);
  });
});

describe("SC-014: the live table still accepts what it always did", () => {
  it("`operation: access` and `entity: member|policy` were already legal", async () => {
    // ⚠ Read from `pg_constraint` rather than from `schema.ts`, because the question is
    // what the DATABASE permits — the same reason `demo:verify` re-derives privileges
    // from `pg_catalog` instead of reading back what it wrote.
    const rows = await db.execute<{ conname: string; def: string }>(sql`
      select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
      where conrelid = 'audit_events'::regclass and contype = 'c'
    `);
    const defs = (rows as unknown as { rows?: Array<{ def: string }> }).rows ?? (rows as unknown as Array<{ def: string }>);
    const all = defs.map((r) => r.def).join(" ");
    expect(all.length, "no CHECK constraints found on audit_events").toBeGreaterThan(0);
    expect(all).toContain("'access'");
    expect(all).toContain("'member'");
    expect(all).toContain("'policy'");
  });

  it("⚠ and the RBAC feature added NO new value to either vocabulary", async () => {
    // If this ever fails, somebody widened a tenant-visible audit vocabulary, and every
    // existing consumer of that table now has a value it has never seen.
    const rows = await db.execute<{ def: string }>(sql`
      select pg_get_constraintdef(oid) as def
      from pg_constraint
      where conrelid = 'audit_events'::regclass and contype = 'c'
    `);
    const defs = (rows as unknown as { rows?: Array<{ def: string }> }).rows ?? (rows as unknown as Array<{ def: string }>);
    const all = defs.map((r) => r.def).join(" ");
    for (const invented of ["'deny'", "'grant'", "'revoke'", "'permission'", "'platform_role'"]) {
      expect(all, `audit_events gained ${invented} — that vocabulary belongs to platform_audit_events`).not.toContain(
        invented,
      );
    }
  });
});
