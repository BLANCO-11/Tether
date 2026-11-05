/**
 * P10 (bands, generic): an aggregate over a COMPUTED value — SUM of a per-row band weight.
 * Generic thresholded bucketing: hours → 0.5/1 AND amounts → small/large weights prove it is not one scenario's shape.
 * Compiled by the one SQL emitter, translated for SQLite, and RUN.
 */
import { describe, expect, it } from "vitest";
import type { SchemaRow } from "../repositories/schema.repo.js";
import { compileOperation, dbOperationSpecSchema, specParamOrder } from "./db-operation.service.js";
import { toSqlite, bindValues } from "./sqlite-dialect.js";
import { DatabaseSync } from "./sqlite-driver.js";

const col = (entityName: string, columnName: string, columnType: string): SchemaRow => ({
  id: `${entityName}.${columnName}`, datasourceId: "ds", entityType: "table", entitySchema: "main", entityName, columnName, columnType,
  isPrimaryKey: false, isForeignKey: false, foreignKeyReference: null, nullable: true, characterMaximumLength: null,
  semanticTag: null, valueDomain: null, rowCountEstimate: null, nullPercentage: null, extractedAt: new Date("2026-10-06T00:00:00Z"),
});
const ROWS = [col("day", "emp_id", "integer"), col("day", "hours", "double precision"), col("day", "amount", "double precision")];
const band = (field: string, edge: number, wIn: number, wOut: number) => ({
  caseWhen: { arms: [{ op: "gte", left: { column: field }, right: { number: edge }, then: { number: wIn } }], else: { number: wOut } },
});
const SPEC = {
  base: { table: "day" },
  columns: [{ column: "emp_id", alias: "emp_id" }, { column: "absence_total", alias: "absence_total" }, { column: "large_total", alias: "large_total" }],
  joins: [],
  aggregateJoins: [{
    table: "day", groupBy: "emp_id", onLeft: "emp_id", kind: "left",
    aggregates: [
      { compute: band("hours", 4.75, 0.5, 1), aggregate: "sum", alias: "absence_total" },
      { compute: band("amount", 100, 2, 0), aggregate: "sum", alias: "large_total" },
    ],
    filters: [],
  }],
  filters: [], having: [], sort: [], limit: 100,
};

describe("P10 — an aggregate over a computed band weight", () => {
  const compiled = compileOperation(SPEC as never, ROWS);
  it("accepted by the form, params ordered (aggregate-compute params last), SUM(CASE WHEN) emitted", () => {
    expect(dbOperationSpecSchema.safeParse(SPEC).success).toBe(true);
    expect(compiled.paramOrder).toEqual(specParamOrder(SPEC));
    expect(compiled.sql).toMatch(/sum\(\(CASE WHEN .* >= .* THEN \(0\.5\) ELSE \(1\) END\)\)/);
    expect(compiled.sql).toMatch(/sum\(\(CASE WHEN .* >= .* THEN \(2\) ELSE \(0\) END\)\)/);
  });

  it("RUN on SQLite: per-employee band sums", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE day (emp_id INTEGER, hours REAL, amount REAL)");
    db.exec("INSERT INTO day VALUES (1,9.5,50),(1,4.75,200),(1,4.74,200),(1,0,50),(2,9.5,500)");
    const stmt = toSqlite(compiled.sql.replace(/"main"\./g, ""));
    const rows = db.prepare(stmt.sql).all(...bindValues(stmt, [])) as Array<{ emp_id: number; absence_total: number; large_total: number }>;
    db.close();
    // emp 1: 0.5+0.5+1+1=3 absence; large: 0+2+2+0=4. emp 2: 0.5; large: 2.
    // LEFT JOIN repeats the group total on each member row: 4 emp-1 rows carry (3, 4); 1 emp-2 row carries (0.5, 2).
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => JSON.stringify(r)))).toEqual(new Set([
      JSON.stringify({ emp_id: 1, absence_total: 3, large_total: 4 }),
      JSON.stringify({ emp_id: 2, absence_total: 0.5, large_total: 2 }),
    ]));
  });

  it("CONTROL: column XOR compute — never both, never neither (unless count)", () => {
    const ok = (a: unknown) => dbOperationSpecSchema.safeParse({ ...SPEC, aggregateJoins: [{ ...(SPEC.aggregateJoins[0] as object), aggregates: [a] }] }).success;
    expect(ok({ column: "hours", compute: band("hours", 1, 1, 0), aggregate: "sum", alias: "x" })).toBe(false);
    expect(ok({ aggregate: "sum", alias: "x" })).toBe(false);
    expect(ok({ aggregate: "count", alias: "x" })).toBe(true);
    expect(ok({ compute: band("hours", 1, 1, 0), aggregate: "sum", alias: "x" })).toBe(true);
  });

  // Without a type, operationFields yields Opaque and add_reader refuses the written read (band-emit A02).
  // P7: compile assigns numeric — and refuses untyped placeable aggregates (see below).
  it("compute aggregate aliases are typed numeric — not null (builder can add_reader)", () => {
    const abs = compiled.outputColumns.find((c) => c.alias === "absence_total");
    const large = compiled.outputColumns.find((c) => c.alias === "large_total");
    expect(abs?.type).toBe("numeric");
    expect(large?.type).toBe("numeric");
  });

  it("min over an untyped column is a compile finding — not a silent Opaque reader", () => {
    const untyped = ROWS.map((r) => (r.columnName === "hours" ? { ...r, columnType: null as unknown as string } : r));
    const bad = {
      ...SPEC,
      aggregateJoins: [{
        ...(SPEC.aggregateJoins[0] as object),
        aggregates: [{ column: "hours", aggregate: "min", alias: "min_hours" }],
      }],
      columns: [{ column: "emp_id", alias: "emp_id" }, { column: "min_hours", alias: "min_hours" }],
    };
    expect(() => compileOperation(bad as never, untyped)).toThrow(/untyped|no result type|Opaque/i);
  });
  it("dimension base + compute on fact columns — COALESCE/CASE resolve in the summary subquery", () => {
    const rows = [
      col("day", "emp_id", "integer"),
      col("day", "hours", "double precision"),
      col("emp", "emp_id", "integer"),
      col("emp", "name", "text"),
    ];
    const spec = {
      base: { table: "emp" },
      columns: [{ column: "emp_id", alias: "emp_id" }, { column: "absence_total", alias: "absence_total" }],
      joins: [],
      aggregateJoins: [{
        table: "day", groupBy: "emp_id", onLeft: "emp_id", kind: "left",
        aggregates: [{
          compute: {
            caseWhen: {
              arms: [{
                op: "gte",
                left: { coalesce: [{ column: "hours" }, { number: 0 }] },
                right: { number: 4.75 },
                then: { number: 0.5 },
              }],
              else: { number: 1 },
            },
          },
          aggregate: "sum",
          alias: "absence_total",
        }],
        filters: [],
      }],
      filters: [], having: [], sort: [], limit: 100,
    };
    const compiled = compileOperation(spec as never, rows);
    expect(compiled.sql).toMatch(/COALESCE/i);
    expect(compiled.sql).toMatch(/CASE WHEN/i);
  });

});
