/**
 * `describePostgresQuery` against a real database (compiled-builder phase 2b: I-271, G13, I-278).
 *
 * Runs against `fleet_demo` as its read-only role. ⚠ Skips LOUDLY, naming the seed, when that database is absent —
 * an unrun seed is not a product defect, and a silent skip would read as coverage.
 */
import { beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { describePostgresQuery } from "./postgres.introspector.js";
import { domainRoUrl } from "../../demo/generic/domain.js";
import { FLEET_DOMAIN } from "../../demo/heldout/fleet.js";

const url = domainRoUrl(FLEET_DOMAIN);
let present = false;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 4000 });
  try { await c.connect(); present = true; } catch (e) {
    console.warn(`[describe-query] SKIPPING — fleet_demo not reachable. Run \`pnpm --filter @foundry/server heldout:seed\` (${(e as Error).message})`);
  } finally { await c.end().catch(() => {}); }
});

describe("describePostgresQuery — what the database says, without reading a row", () => {
  it("gives each parameter its REAL type (G13): a date comparison makes $1 a date, not the declared string", async () => {
    if (!present) return;
    const d = await describePostgresQuery(url, "SELECT device_id, read_at FROM readings WHERE read_at::date = $1", ["day"]);
    expect(d?.params).toEqual([{ name: "day", type: "date" }]);
  });

  it("types result columns and reads the source column's NOT NULL", async () => {
    if (!present) return;
    const d = await describePostgresQuery(url, "SELECT device_id, owner_email FROM devices", []);
    expect(d?.columns).toEqual([
      { name: "device_id", type: "text", nullable: false, tag: null },
      { name: "owner_email", type: "text", nullable: true, tag: "email" },
    ]);
  });

  it("reads a declared tag through a join, and a computed column is nullable", async () => {
    if (!present) return;
    const d = await describePostgresQuery(url, "SELECT s.contact_email, count(*) AS n FROM devices d JOIN sites s USING (site_code) GROUP BY 1", []);
    expect(d?.columns).toEqual([
      { name: "contact_email", type: "text", nullable: false, tag: "email" },
      { name: "n", type: "bigint", nullable: true, tag: null },
    ]);
  });

  it("⚠ any LEFT JOIN makes every sourced column nullable — the database does not say which side a column came from", async () => {
    if (!present) return;
    const d = await describePostgresQuery(url, "SELECT d.device_id, r.temperature FROM devices d LEFT JOIN readings r USING (device_id)", []);
    expect(d?.columns.map((c) => [c.name, c.nullable])).toEqual([["device_id", true], ["temperature", true]]);
  });

  it("answers null, not a throw, for a statement the database cannot describe", async () => {
    if (!present) return;
    expect(await describePostgresQuery(url, "SELECT no_such_column FROM devices", [])).toBeNull();
  });
});
