import { describe, expect, it } from "vitest";
import { DatabaseSync } from "./sqlite-driver.js";
import { MAX_NESTED_SCAN_COMPARISONS, nestedScanProblem, tableAliases, type PlanRow } from "./sqlite-join-plan.js";

/** A real SQLite plan over an in-memory database: the shape of chat 8d7e37dc (TEXT ids, an index, a CAST join). */
function plan(sql: string): PlanRow[] {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE muster (employee_id TEXT, work_date_iso TEXT); CREATE TABLE headcount (employee_id TEXT, band TEXT);
           CREATE INDEX ix_hc ON headcount (employee_id);`);
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as unknown as PlanRow[];
  db.close();
  return rows;
}

const SIZES: Record<string, number> = { muster: 107_755, headcount: 4_130 };
const join = (on: string) =>
  `SELECT m.employee_id, h.band FROM main.muster AS m LEFT JOIN main.headcount AS h ON ${on} WHERE m.work_date_iso >= ?`;

describe("a join that cannot use an index is refused before it runs", () => {
  it("refuses a CAST on both join columns, with the size of the work and the cause", () => {
    const sql = join("CAST(m.employee_id AS TEXT) = CAST(h.employee_id AS TEXT)");
    const p = nestedScanProblem(plan(sql), sql, (t) => SIZES[t] ?? null);
    expect(p).toMatch(/headcount \(4,130 rows\) once for every row of muster \(107,755 rows\)/);
    expect(p).toMatch(/445 million/);
    expect(p).toMatch(/CAST/);
  });

  it("CONTROL: the plain join searches the index and passes", () => {
    const sql = join("m.employee_id = h.employee_id");
    expect(plan(sql).some((r) => /SEARCH h USING INDEX/.test(r.detail))).toBe(true);
    expect(nestedScanProblem(plan(sql), sql, (t) => SIZES[t] ?? null)).toBeNull();
  });

  it("small tables pass: a nested scan under the threshold is not slow", () => {
    const sql = join("CAST(m.employee_id AS TEXT) = CAST(h.employee_id AS TEXT)");
    expect(nestedScanProblem(plan(sql), sql, () => 1000)).toBeNull();
    expect(1000 * 1000).toBeLessThan(MAX_NESTED_SCAN_COMPARISONS);
  });

  it("an unknown table size refuses nothing", () => {
    const sql = join("CAST(m.employee_id AS TEXT) = CAST(h.employee_id AS TEXT)");
    expect(nestedScanProblem(plan(sql), sql, () => null)).toBeNull();
  });

  it("reads aliases and the older 'SCAN TABLE x AS y' wording", () => {
    expect(tableAliases(`SELECT * FROM "main"."muster" m JOIN headcount AS h ON 1 WHERE 1`).get("h")).toBe("headcount");
    const older: PlanRow[] = [
      { id: 2, parent: 0, detail: "SCAN TABLE muster AS m" },
      { id: 3, parent: 0, detail: "SCAN TABLE headcount AS h" },
    ];
    expect(nestedScanProblem(older, "SELECT * FROM muster AS m JOIN headcount AS h ON 1", (t) => SIZES[t] ?? null)).toMatch(/cannot use an index/);
  });
});
