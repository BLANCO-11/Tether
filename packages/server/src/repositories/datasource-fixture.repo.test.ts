import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import {
  datasourceFixtures,
  datasources,
  flowExecutions,
  MOCK_STATUSES,
} from "../db/schema.js";
import { isReadyStatus, READY_MOCK_STATUS } from "./datasource-fixture.repo.js";
import { decryptDsnIfPresent } from "./datasource.repo.js";
import { encrypt } from "../utils/encryptor.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("mock readiness (migration 0066 — was 0062 on release/beta)", () => {
  it("only 'ready' satisfies readiness — building, failed, and absent are all unusable", () => {
    expect(isReadyStatus("ready")).toBe(true);
    expect(READY_MOCK_STATUS).toBe("ready");
    expect(isReadyStatus("building")).toBe(false);
    expect(isReadyStatus("failed")).toBe(false);
    expect(isReadyStatus(null)).toBe(false);
    expect(isReadyStatus(undefined)).toBe(false);
    expect(isReadyStatus("")).toBe(false);
    expect(isReadyStatus("READY")).toBe(false);
    expect(isReadyStatus("unknown-status")).toBe(false);
  });

  it("MOCK_STATUSES is exactly the CHECK union", () => {
    expect(MOCK_STATUSES).toEqual(["building", "ready", "failed"]);
  });

  it("schema carries the readiness columns with the migration's shape", () => {
    const fx = getTableColumns(datasourceFixtures);
    expect(fx.mockStatus.notNull).toBe(true);
    expect(fx.mockStatus.hasDefault).toBe(true);
    expect(fx.mockError.notNull).toBe(false);
    const exec = getTableColumns(flowExecutions);
    expect(exec.useProdOverride.notNull).toBe(true);
    expect(exec.useProdOverride.hasDefault).toBe(true);
  });

  it("connection_string_enc is nullable for mock-only-until-linked rows", () => {
    expect(getTableColumns(datasources).connectionStringEnc.notNull).toBe(false);
  });

  /**
   * ⚠ **THIS MIGRATION WAS `0062` ON `release/beta` AND IS `0066` HERE.** Both branches
   * minted an `0062` independently — beta's `0062_mock_readiness` and this branch's
   * `0062_workspace_roles` — so the merge on 2026-09-14 had two files and two journal
   * entries claiming idx 62 and the same `when`.
   *
   * The RBAC migrations 0062–0065 were **already applied** on this deployment (watermark
   * `1789500000000`), and drizzle's test is `created_at < folderMillis` against a
   * watermark of `max(created_at)` — so renumbering an APPLIED migration makes it look
   * new and re-runs it for ever. That is the incident CLAUDE.md records for `0033`. So
   * the applied ones kept their numbers untouched and the incoming one moved up to
   * `0066`, with a `when` above the watermark.
   *
   * ⚠ Renumbering the incoming file is only safe because its SQL is **idempotent**
   * throughout — `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` before the ADD,
   * `CREATE INDEX IF NOT EXISTS`, and a `DROP NOT NULL`. On a deployment where it already
   * ran as `0062`, it runs once more as `0066` and changes nothing. That was checked
   * before renaming, not assumed.
   */
  it("migration 0066 applies the columns, the CHECK, and the nullability", () => {
    const sql = readFileSync(resolve(here, "../../drizzle/0066_mock_readiness.sql"), "utf8");
    expect(sql).toContain('"mock_status"');
    expect(sql).toContain("'building'");
    expect(sql).toContain("'ready'");
    expect(sql).toContain("'failed'");
    expect(sql).toContain('"mock_error"');
    expect(sql).toContain('"use_prod_override"');
    expect(sql).toContain('ALTER COLUMN "connection_string_enc" DROP NOT NULL');
  });

  it("journal carries the 0066 entry so the migrator sees the file", () => {
    const journal = JSON.parse(
      readFileSync(resolve(here, "../../drizzle/meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === "0066_mock_readiness");
    expect(entry, "the journal must name the file, or the migrator never runs it").toBeDefined();
    expect(entry!.idx).toBe(66);

    /**
     * ⚠ **The half that actually protects the deployment**: its `when` must EXCEED every
     * migration applied BEFORE it, or drizzle sorts it below the watermark and skips it
     * silently — the mirror of the re-run bug, and quieter.
     *
     * ⚠ Compared against EARLIER entries only. This read `e.tag !== "0066…"`, i.e. every
     * other entry in the file, which asserted that 0066 is the NEWEST migration in the
     * repo — true on the day it was written and false the moment 0067 landed. It has been
     * red ever since, for a reason that says nothing about 0066, and it would go red again
     * on every future migration. The property worth pinning is the ordering against what
     * came before.
     */
    const earlier = journal.entries.filter((e) => e.idx < entry!.idx);
    expect(entry!.when).toBeGreaterThan(Math.max(...earlier.map((e) => e.when)));

    // CONTROL: idx is unique across the journal, which is what the two colliding 0062s
    // violated in the first place.
    const idxs = journal.entries.map((e) => e.idx);
    expect(new Set(idxs).size).toBe(idxs.length);
  });
});

describe("decryptDsnIfPresent", () => {
  it("returns null for absent ciphertexts without throwing", () => {
    expect(decryptDsnIfPresent(null)).toBeNull();
    expect(decryptDsnIfPresent(undefined)).toBeNull();
    expect(decryptDsnIfPresent("")).toBeNull();
  });

  it("round-trips a real ciphertext", () => {
    const plaintext = "postgres://mockuser:mockpass@localhost:5432/mockdb";
    expect(decryptDsnIfPresent(encrypt(plaintext))).toBe(plaintext);
  });
});
