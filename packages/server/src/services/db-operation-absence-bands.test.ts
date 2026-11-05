/**
 * Three-band absence weights for Attendance_DB hours_worked:
 *   [0, 4.74] → 1 (full day absence)
 *   [4.75, 9.49] → 0.5 (half day)
 *   ≥ 9.5 → 0 (present)
 *
 * The older two-arm form (gte 4.75 → 0.5 else 1) wrongly scores 9.5h as half-day.
 */
import { describe, expect, it } from "vitest";
import type { SchemaRow } from "../repositories/schema.repo.js";
import { compileOperation, dbOperationSpecSchema } from "./db-operation.service.js";
import { toSqlite, bindValues } from "./sqlite-dialect.js";
import { DatabaseSync } from "./sqlite-driver.js";

const col = (entityName: string, columnName: string, columnType: string): SchemaRow => ({
  id: `${entityName}.${columnName}`,
  datasourceId: "ds",
  entityType: "table",
  entitySchema: "main",
  entityName,
  columnName,
  columnType,
  isPrimaryKey: false,
  isForeignKey: false,
  foreignKeyReference: null,
  nullable: true,
  characterMaximumLength: null,
  semanticTag: null,
  valueDomain: null,
  rowCountEstimate: null,
  nullPercentage: null,
  extractedAt: new Date("2026-10-07T00:00:00Z"),
});

const ROWS = [
  col("attendance_day", "emp_id", "text"),
  col("attendance_day", "hours_worked", "double precision"),
  col("employee", "emp_id", "text"),
  col("employee", "emp_name", "text"),
];

/** Weight per day — three arms, present day is 0. */
const ABSENCE_WEIGHT = {
  caseWhen: {
    arms: [
      { op: "gte" as const, left: { column: "hours_worked" }, right: { number: 9.5 }, then: { number: 0 } },
      { op: "gte" as const, left: { column: "hours_worked" }, right: { number: 4.75 }, then: { number: 0.5 } },
    ],
    else: { number: 1 },
  },
};

const SPEC = {
  base: { table: "attendance_day" },
  columns: [
    { column: "emp_id", alias: "emp_id" },
    { column: "half_day_absences", alias: "half_day_absences" },
    { column: "full_day_absences", alias: "full_day_absences" },
    { column: "total_absences", alias: "total_absences" },
  ],
  joins: [],
  aggregateJoins: [
    {
      table: "attendance_day",
      groupBy: "emp_id",
      onLeft: "emp_id",
      kind: "left",
      aggregates: [
        {
          compute: {
            caseWhen: {
              arms: [
                {
                  op: "gte",
                  left: { column: "hours_worked" },
                  right: { number: 4.75 },
                  then: {
                    caseWhen: {
                      arms: [{ op: "lt", left: { column: "hours_worked" }, right: { number: 9.5 }, then: { number: 1 } }],
                      else: { number: 0 },
                    },
                  },
                },
              ],
              else: { number: 0 },
            },
          },
          aggregate: "sum",
          alias: "half_day_absences",
        },
        {
          compute: {
            caseWhen: {
              arms: [{ op: "lt", left: { column: "hours_worked" }, right: { number: 4.75 }, then: { number: 1 } }],
              else: { number: 0 },
            },
          },
          aggregate: "sum",
          alias: "full_day_absences",
        },
        { compute: ABSENCE_WEIGHT, aggregate: "sum", alias: "total_absences" },
      ],
      filters: [],
    },
  ],
  filters: [],
  having: [],
  sort: [],
  limit: 100,
};

describe("HR absence three-band (Attendance_DB hours_worked)", () => {
  it("form accepts the three-band aggregates", () => {
    expect(dbOperationSpecSchema.safeParse(SPEC).success).toBe(true);
  });

  it("RUN: 9.5→0, 4.75→0.5, 4.74→1, 0→1; half/full counts and total weight", () => {
    const compiled = compileOperation(SPEC as never, ROWS);
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE attendance_day (emp_id TEXT, hours_worked REAL)");
    // emp A: present, half, full, full → half_count=1, full_count=2, total=0+0.5+1+1=2.5
    db.exec("INSERT INTO attendance_day VALUES ('A',9.5),('A',4.75),('A',4.74),('A',0)");
    // emp B: two present → 0
    db.exec("INSERT INTO attendance_day VALUES ('B',9.5),('B',9.5)");
    const stmt = toSqlite(compiled.sql.replace(/"main"\./g, ""));
    const rows = db.prepare(stmt.sql).all(...bindValues(stmt, [])) as Array<{
      emp_id: string;
      half_day_absences: number;
      full_day_absences: number;
      total_absences: number;
    }>;
    db.close();
    const by = Object.fromEntries(rows.map((r) => [r.emp_id, r]));
    // LEFT JOIN repeats group totals on member rows — unique by emp.
    expect(by.A!.half_day_absences).toBe(1);
    expect(by.A!.full_day_absences).toBe(2);
    expect(by.A!.total_absences).toBe(2.5);
    expect(by.B!.half_day_absences).toBe(0);
    expect(by.B!.full_day_absences).toBe(0);
    expect(by.B!.total_absences).toBe(0);
  });

  it("CONTROL: two-arm gte 4.75→0.5 else 1 wrongly scores 9.5 as half-day", () => {
    const wrong = {
      caseWhen: {
        arms: [{ op: "gte", left: { column: "hours_worked" }, right: { number: 4.75 }, then: { number: 0.5 } }],
        else: { number: 1 },
      },
    };
    const spec = {
      ...SPEC,
      aggregateJoins: [
        {
          ...(SPEC.aggregateJoins[0] as object),
          aggregates: [{ compute: wrong, aggregate: "sum", alias: "total_absences" }],
        },
      ],
      columns: [{ column: "emp_id", alias: "emp_id" }, { column: "total_absences", alias: "total_absences" }],
    };
    const compiled = compileOperation(spec as never, ROWS);
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE attendance_day (emp_id TEXT, hours_worked REAL)");
    db.exec("INSERT INTO attendance_day VALUES ('P',9.5)");
    const stmt = toSqlite(compiled.sql.replace(/"main"\./g, ""));
    const rows = db.prepare(stmt.sql).all(...bindValues(stmt, [])) as Array<{ total_absences: number }>;
    db.close();
    expect(rows[0]!.total_absences).toBe(0.5); // defect the three-band rule exists to prevent
  });
});
