/**
 * The compiler writes for the database the read runs on (2026-10-04). A read for a SQLite datasource used "days between" and the
 * compiler wrote `(b::date - a::date)` — Postgres — which `toSqlite` rightly refused ("a Postgres cast"), so a valid read could NEVER
 * be written there: three attempts, then the whole automation refused. With `dialect: "sqlite"` each computed value is spelled
 * natively, and RUN here against SQLite, so the numbers are checked, not the text.
 */
import { describe, expect, it } from "vitest";
import type { SchemaRow } from "../repositories/schema.repo.js";
import { compileOperation, dialectOf } from "./db-operation.service.js";
import { toSqlite, bindValues } from "./sqlite-dialect.js";
import { DatabaseSync } from "./sqlite-driver.js";

const col = (entityName: string, columnName: string, columnType: string): SchemaRow => ({
  id: `${entityName}.${columnName}`, datasourceId: "ds", entityType: "table", entitySchema: "main", entityName, columnName, columnType,
  isPrimaryKey: false, isForeignKey: false, foreignKeyReference: null, nullable: true, characterMaximumLength: null,
  semanticTag: null, valueDomain: null, rowCountEstimate: null, nullPercentage: null, extractedAt: new Date("2026-10-01T00:00:00Z"),
});
const ROWS = [col("loan", "id", "integer"), col("loan", "lent", "date"), col("loan", "back", "date"), col("loan", "fine", "integer"), col("loan", "note", "text"), col("loan", "out_at", "timestamp"), col("loan", "in_at", "timestamp")];
const SPEC = {
  base: { table: "loan" },
  columns: [
    { column: "id", alias: "id" },
    { compute: { diffDays: { start: { column: "lent" }, end: { column: "back" } } }, alias: "days_out" },
    { compute: { addDays: { value: { column: "lent" }, days: { param: "loan_days", type: "number" } } }, alias: "due" },
    { compute: { diffMinutes: { start: { column: "out_at" }, end: { column: "in_at" } } }, alias: "minutes_out" },
    { compute: { greatest: { first: { column: "fine" }, second: { number: 5 } } }, alias: "fine_at_least_5" },
    { compute: { least: { first: { column: "fine" }, second: { number: 5 } } }, alias: "fine_at_most_5" },
    { compute: { coalesce: [{ column: "fine" }, { column: "note" }] }, alias: "fine_or_note" },
  ],
  joins: [], aggregateJoins: [],
  filters: [{ compute: { diffDays: { start: { column: "lent" }, end: { column: "back" } } }, op: "gt", param: "min_days" }],
  having: [], sort: [{ column: "id", dir: "asc" }], limit: 100,
};

const run = (sql: string, order: string[], values: Record<string, unknown>) => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE loan (id INTEGER, lent TEXT, back TEXT, fine INTEGER, note TEXT, out_at TEXT, in_at TEXT)");
  db.exec(`INSERT INTO loan VALUES (1,'2026-02-27','2026-03-02',NULL,'7','2026-03-01 10:00:00','2026-03-01 12:30:00'),
                                  (2,'2026-01-01','2026-01-31',9,NULL,'2026-01-01 00:00:00','2026-01-02 00:00:00'),
                                  (3,'2026-05-01','2026-05-02',1,'x','2026-05-01 00:00:00','2026-05-01 00:00:59')`);
  const stmt = toSqlite(sql.replace(/"main"\./g, ""));
  const rows = db.prepare(stmt.sql).all(...bindValues(stmt, order.map((n) => values[n])));
  db.close();
  return rows as Array<Record<string, unknown>>;
};

describe("computed values on SQLite", () => {
  it("dialectOf: a SQLite datasource is sqlite; anything else is the Postgres default", () => {
    expect(dialectOf("sqlite")).toBe("sqlite");
    expect(dialectOf("postgres")).toBe("postgres");
    expect(dialectOf(undefined)).toBe("postgres");
  });

  it("CONTROL: the Postgres spelling is unchanged, and SQLite refuses it — the defect", () => {
    const pg = compileOperation(SPEC as never, ROWS);
    expect(pg.sql).toContain("::date");
    expect(() => toSqlite(pg.sql)).toThrow(/Postgres cast/);
  });

  it("RUN: days between, a date plus days, minutes between, greatest / least ignoring a NULL, coalesce across types — each as Postgres would", () => {
    const c = compileOperation(SPEC as never, ROWS, { dialect: "sqlite" });
    expect(c.sql).not.toMatch(/::|GREATEST|LEAST|EXTRACT/);
    const rows = run(c.sql, c.paramOrder, { loan_days: 14, min_days: 0 });
    expect(rows.map((r) => [r.id, r.days_out, r.due, r.minutes_out, r.fine_at_least_5, r.fine_at_most_5, String(r.fine_or_note)])).toEqual([
      [1, 3, "2026-03-13", 150, 5, 5, "7"],        // across a month end (Feb 2026 has 28 days); fine NULL → greatest/least take the other
      [2, 30, "2026-01-15", 1440, 9, 5, "9"],
      [3, 1, "2026-05-15", 1, 5, 1, "1"],           // 59 seconds rounds to one minute, as the cast to bigint does
    ]);
  });

  it("a negative number of days goes back, and the filter on a computed value works", () => {
    const c = compileOperation(SPEC as never, ROWS, { dialect: "sqlite" });
    const rows = run(c.sql, c.paramOrder, { loan_days: -1, min_days: 2 });
    expect(rows.map((r) => [r.id, r.due])).toEqual([[1, "2026-02-26"], [2, "2025-12-31"]]);
  });

  it("business minutes has no faithful SQLite spelling: a finding naming it, never an approximation", () => {
    const spec = { ...SPEC, columns: [{ compute: { businessMinutes: { start: { column: "out_at" }, end: { column: "in_at" } } }, alias: "bm" }], filters: [] };
    expect(() => compileOperation(spec as never, ROWS, { dialect: "sqlite" })).toThrow();
    expect(() => compileOperation(spec as never, ROWS)).not.toThrow();
  });
});

describe("the moment it runs, compared with a timestamp column (2026-10-04)", () => {
  const SPEC2 = { base: { table: "loan" }, columns: [{ column: "id", alias: "id" }], joins: [], aggregateJoins: [],
    filters: [{ column: "in_at", op: "gt", param: "run_time" }], having: [], sort: [{ column: "id", dir: "asc" }], limit: 100 };
  it("is typed an instant, never cut to its day — on either engine", () => {
    for (const dialect of ["postgres", "sqlite"] as const) {
      const c = compileOperation(SPEC2 as never, ROWS, { dialect });
      expect((c.paramsSchema as Record<string, { format?: string }>).run_time!.format).toBe("datetime");
    }
    // CONTROL: any other parameter on the same column keeps its own type
    const other = compileOperation({ ...SPEC2, filters: [{ column: "in_at", op: "gt", param: "since" }] } as never, ROWS);
    expect((other.paramsSchema as Record<string, { format?: string }>).since!.format).not.toBe("datetime");
  });
  it("RUN on SQLite: compared as instants, so a text timestamp and an ISO instant on the same day order correctly", () => {
    const c = compileOperation(SPEC2 as never, ROWS, { dialect: "sqlite" });
    const rows = run(c.sql, c.paramOrder, { run_time: "2026-03-01T11:00:00Z" });
    // loan 1 came back at 12:30 that day — after 11:00; as plain text "2026-03-01 12:30:00" < "2026-03-01T11:00:00Z" and it was lost
    expect(rows.map((r) => r.id)).toEqual([1, 3]);
  });
});
