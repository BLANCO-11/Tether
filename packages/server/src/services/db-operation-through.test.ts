/**
 * A summary grouped by a column one join away (builder-stability P2-I1/P2-I3, 2026-10-02): "each department and how many sick
 * leave days its people took" sums absence rows grouped by their EMPLOYEE's department. The summary is joined THROUGH `emp`
 * inside the subquery — compiled by the one SQL emitter, translated for SQLite, and RUN, so the totals are checked, not the text.
 */
import { describe, expect, it } from "vitest";
import type { SchemaRow } from "../repositories/schema.repo.js";
import { compileOperation, dbOperationSpecSchema, specParamOrder } from "./db-operation.service.js";
import { readback } from "./db-operation-readback.js";
import { toSqlite, bindValues } from "./sqlite-dialect.js";
import { DatabaseSync } from "./sqlite-driver.js";

const col = (entityName: string, columnName: string, columnType: string): SchemaRow => ({
  id: `${entityName}.${columnName}`, datasourceId: "ds", entityType: "table", entitySchema: "main", entityName, columnName, columnType,
  isPrimaryKey: false, isForeignKey: false, foreignKeyReference: null, nullable: true, characterMaximumLength: null,
  semanticTag: null, valueDomain: null, rowCountEstimate: null, nullPercentage: null, extractedAt: new Date("2026-10-01T00:00:00Z"),
});
const ROWS = [
  col("dept", "id", "integer"), col("dept", "name", "text"),
  col("emp", "id", "integer"), col("emp", "dept_id", "integer"),
  col("absence", "emp_id", "integer"), col("absence", "kind", "text"), col("absence", "days", "integer"), col("absence", "on_date", "date"),
];
const SPEC = {
  base: { table: "dept" },
  columns: [{ column: "name", alias: "department" }, { column: "sick_days", alias: "sick_days" }],
  joins: [],
  aggregateJoins: [{
    table: "absence", through: [{ table: "emp", onLeft: "emp_id", onRight: "id" }],
    groupBy: "emp.dept_id", onLeft: "id", kind: "left",
    aggregates: [{ aggregate: "sum", column: "days", alias: "sick_days" }],
    filters: [{ column: "kind", op: "eq", value: "Sick" }, { column: "on_date", op: "month", param: "period" }],
  }],
  filters: [], having: [], sort: [{ column: "name", dir: "asc" }], limit: 100,
};

describe("a summary grouped by a column one join away", () => {
  const compiled = compileOperation(SPEC as never, ROWS);
  it("accepted by the form; the join is INNER and inside the summary; grouped by the joined table's column", () => {
    expect(dbOperationSpecSchema.safeParse(SPEC).success).toBe(true);
    expect(compiled.paramOrder).toEqual(specParamOrder(SPEC));
    expect(compiled.sql).toMatch(/FROM "main"\."absence" AS "t1_agg" INNER JOIN "main"\."emp" AS "t1_agg1" ON "t1_agg"\."emp_id" = "t1_agg1"\."id"/);
    expect(compiled.sql).toContain(`GROUP BY "t1_agg1"."dept_id"`);
    expect(compiled.sql).toContain(`"t1_agg"."kind" = 'Sick'`);
  });

  it("RUN on SQLite: each department's sick days in the month — another kind, another month and a department with none excluded", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE dept (id INTEGER, name TEXT); CREATE TABLE emp (id INTEGER, dept_id INTEGER); CREATE TABLE absence (emp_id INTEGER, kind TEXT, days INTEGER, on_date TEXT)");
    db.exec("INSERT INTO dept VALUES (1,'Ops'),(2,'Sales'),(3,'Legal')");
    db.exec("INSERT INTO emp VALUES (10,1),(11,1),(20,2)");
    db.exec("INSERT INTO absence VALUES (10,'Sick',2,'2026-08-03'),(11,'Sick',1,'2026-08-10'),(20,'Sick',4,'2026-08-12'),(20,'Annual',5,'2026-08-13'),(10,'Sick',7,'2026-09-01'),(99,'Sick',3,'2026-08-05')");
    const stmt = toSqlite(compiled.sql.replace(/"main"\./g, ""));
    const values = { period: "2026-08" } as Record<string, unknown>;
    const rows = db.prepare(stmt.sql).all(...bindValues(stmt, compiled.paramOrder.map((n) => values[n]))) as Array<{ department: string; sick_days: number | null }>;
    db.close();
    // Ops 2+1, Sales 4 (not the Annual 5), Legal none; September's 7 and the absence of an unknown employee (99) never counted.
    expect(rows.map((r) => [r.department, r.sick_days])).toEqual([["Legal", null], ["Ops", 3], ["Sales", 4]]);
  });

  it("the readback names the hop", () => {
    const text = readback(SPEC as never).map((c) => `${c.label}: ${c.text}`).join("\n");
    expect(text).toMatch(/each absence row joined to its emp \(emp_id = emp\.id\), and counted only where it has one — grouped by emp\.dept_id/);
  });

  it("CONTROL: without `through`, a group key on another table is refused by name; a table joined twice inside is refused", () => {
    const refused = (s: unknown) => { try { compileOperation(s as never, ROWS); return ""; } catch (e) { return ((e as { findings?: Array<{ message: string }> }).findings ?? []).map((f) => f.message).join("; "); } };
    const aj = SPEC.aggregateJoins[0]!;
    expect(refused({ ...SPEC, aggregateJoins: [{ ...aj, through: [] }] })).toMatch(/emp/);
    expect(refused({ ...SPEC, aggregateJoins: [{ ...aj, through: [aj.through[0]!, aj.through[0]!] }] })).toMatch(/already inside it/);
    expect(refused(SPEC)).toBe("");
  });
});

describe("a through table's key named with its own table (2026-10-02, a proposer's `absence_type.absence_type_id`)", async () => {
  const { ownNamesBare } = await import("./db-operation.service.js");
  it("is that column — and a key naming ANOTHER table is left for the schema to refuse", () => {
    const e = { table: "absence", groupBy: "emp.dept_id", through: [{ table: "absence_type", onLeft: "type_id", onRight: "absence_type.absence_type_id" }, { table: "emp", onLeft: "emp_id", onRight: "other.id" }] };
    expect((ownNamesBare(e) as typeof e).through.map((t) => t.onRight)).toEqual(["absence_type_id", "other.id"]);
  });
});
