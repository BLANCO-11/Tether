/**
 * Arithmetic in the read form (2026-10-01): "employees whose attendance is below 85% of working days" could not be read — the form
 * computed dates and nothing else. Two summaries of one table (each its own filter), a percentage over their aliases, and a filter on
 * it against a parameter — compiled by the one SQL emitter, translated for SQLite, and RUN, so the numbers are checked, not the text.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
const ROWS = [col("emp", "id", "integer"), col("emp", "name", "text"), col("day", "emp_id", "integer"), col("day", "work_date", "date"), col("day", "hours", "double precision")];
const day = (filters: unknown[], alias: string) => ({ table: "day", groupBy: "emp_id", onLeft: "id", kind: "left", aggregates: [{ aggregate: "count", alias }], filters: [{ column: "work_date", op: "gte", param: "from_date" }, { column: "work_date", op: "lte", param: "to_date" }, ...filters] });
const SPEC = {
  base: { table: "emp" },
  columns: [
    { column: "name", alias: "name" },
    { column: "present_days", alias: "present_days" },
    { column: "working_days", alias: "working_days" },
    { compute: { percent: { part: { column: "present_days" }, whole: { column: "working_days" } } }, alias: "attendance_pct" },
  ],
  joins: [],
  aggregateJoins: [day([{ column: "hours", op: "gte", param: "full_day_hours" }], "present_days"), day([], "working_days")],
  filters: [{ compute: { percent: { part: { column: "present_days" }, whole: { column: "working_days" } } }, op: "lt", param: "max_attendance_pct" }],
  having: [], sort: [{ column: "name", dir: "asc" }], limit: 100,
};

describe("a rate below a threshold, read by the form", () => {
  const compiled = compileOperation(SPEC as never, ROWS);
  it("accepted by the form, its parameters numbered in the compiler's order, the threshold typed a number", () => {
    expect(dbOperationSpecSchema.safeParse(SPEC).success).toBe(true);
    expect(compiled.paramOrder).toEqual(specParamOrder(SPEC));
    expect(compiled.paramOrder).toEqual(["from_date", "to_date", "full_day_hours", "max_attendance_pct"]);
    expect((compiled.paramsSchema as Record<string, { type: string }>).max_attendance_pct!.type).toBe("number");
    expect(compiled.sql).toMatch(/\* 100\.0 \/ NULLIF\(/);
    expect(compiled.sql).not.toMatch(/::/); // no cast: the same statement runs on SQLite
  });

  it("RUN on SQLite: 2 of 3 working days present is 66.7% — below 85, kept; 3 of 3 is not; a person with no working days is not", () => {
    const db = new DatabaseSync(":memory:");
    db.exec('CREATE TABLE emp (id INTEGER, name TEXT); CREATE TABLE day (emp_id INTEGER, work_date TEXT, hours REAL)');
    db.exec("INSERT INTO emp VALUES (1,'Asha'),(2,'Ben'),(3,'Cy')");
    db.exec("INSERT INTO day VALUES (1,'2026-08-03',9.5),(1,'2026-08-04',4),(1,'2026-08-05',10),(2,'2026-08-03',9.5),(2,'2026-08-04',9.6),(2,'2026-08-05',10),(1,'2026-09-01',0)");
    const stmt = toSqlite(compiled.sql.replace(/"main"\./g, ""));
    const values = { from_date: "2026-08-01", to_date: "2026-08-31", full_day_hours: 9.5, max_attendance_pct: 85 } as Record<string, unknown>;
    const rows = db.prepare(stmt.sql).all(...bindValues(stmt, compiled.paramOrder.map((n) => values[n]))) as Array<{ name: string; attendance_pct: number }>;
    db.close();
    expect(rows.map((r) => [r.name, Math.round(r.attendance_pct * 10) / 10])).toEqual([["Asha", 66.7]]);
  });

  it("the readback says it in words", () => {
    const text = readback(SPEC as never).map((c) => `${c.label}: ${c.text}`).join("\n");
    expect(text).toMatch(/present_days as a percentage of working_days/);
  });

  it("CONTROL: a filter names a column OR a computed value — never both, never neither; and a computed one only compares", () => {
    const f = (x: Record<string, unknown>) => dbOperationSpecSchema.safeParse({ ...SPEC, filters: [x] }).success;
    expect(f({ column: "name", compute: { column: "name" }, op: "eq", param: "p" })).toBe(false);
    expect(f({ op: "eq", param: "p" })).toBe(false);
    expect(f({ compute: { column: "name" }, op: "like", param: "p" })).toBe(false);
  });

  it("a division never truncates and never fails on zero", () => {
    const div = compileOperation({ ...SPEC, filters: [], columns: [{ compute: { arith: { op: "divide", left: { column: "present_days" }, right: { column: "working_days" } } }, alias: "ratio" }] } as never, ROWS).sql;
    expect(div).toMatch(/\* 1\.0 \/ NULLIF\(/);
  });
});

describe("whole numbers are widened before they are combined (builder-behaviour R16, B19)", () => {
  // A quantity × a price in cents: both `integer`. Postgres keeps `integer × integer` an integer and refused ordinary data with
  // "integer out of range" (B19's draft run). RUN on PGlite (the mock engine) and on SQLite (through the same translation).
  const LINES = [col("line", "qty", "integer"), col("line", "unit_price_cents", "integer")];
  const SPEC2 = { base: { table: "line" }, columns: [{ compute: { arith: { op: "multiply", left: { column: "qty" }, right: { column: "unit_price_cents" } } }, alias: "value_cents" }], joins: [], aggregateJoins: [], filters: [], having: [], sort: [], limit: 10 };
  const compiled = compileOperation(SPEC2 as never, LINES);
  const plain = (sql: string) => sql.replace(/CAST\((.+?) AS BIGINT\)/g, "$1");
  it("on Postgres the product is exact; NEGATIVE CONTROL: the same SQL without the widening overflows", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    await db.exec(`CREATE SCHEMA IF NOT EXISTS main; CREATE TABLE main.line (qty integer, unit_price_cents integer); INSERT INTO main.line VALUES (100000, 100000);`);
    const got = await db.query<{ value_cents: string | number }>(compiled.sql);
    expect(String(got.rows[0]!.value_cents)).toBe("10000000000");
    await expect(db.query(plain(compiled.sql))).rejects.toThrow(/integer out of range/);
  });
  it("SQLite takes it as it is", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE line (qty integer, unit_price_cents integer); INSERT INTO line VALUES (100000, 100000);`);
    const st = toSqlite(compiled.sql.replace(/"main"\./g, ""));
    expect(db.prepare(st.sql).all()).toEqual([{ value_cents: 10000000000 }]);
  });
});

describe("a total of a computed value per group (builder-behaviour P7, B08: “the total value of the lines for each segment”)", () => {
  const LINES = [col("line", "id", "integer"), col("line", "segment", "text"), col("line", "qty", "integer"), col("line", "unit_price_cents", "integer")];
  const S = {
    base: { table: "line" },
    columns: [
      { column: "segment", alias: "segment" },
      { compute: { arith: { op: "multiply", left: { column: "qty" }, right: { column: "unit_price_cents" } } }, aggregate: "sum", alias: "total_value_cents" },
    ],
    joins: [], aggregateJoins: [], filters: [], having: [], sort: [{ column: "segment", dir: "asc" }], limit: 100,
  };
  it("is accepted by the form and RUN: the SUM of each line's product, grouped by the other column", () => {
    expect(dbOperationSpecSchema.safeParse(S).success).toBe(true);
    const c = compileOperation(S as never, LINES);
    expect(c.sql).toMatch(/sum\(/i);
    expect(c.sql).toMatch(/group by/i);
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE line (id INTEGER, segment TEXT, qty INTEGER, unit_price_cents INTEGER);
      INSERT INTO line VALUES (1, 'a', 2, 500), (2, 'a', 1, 300), (3, 'b', 4, 100);`);
    const sqlite = toSqlite(c.sql.replace(/"main"\./g, ""));
    const rows = db.prepare(sqlite.sql).all() as Array<{ segment: string; total_value_cents: number }>;
    expect(rows.map((r) => [r.segment, Number(r.total_value_cents)])).toEqual([["a", 1300], ["b", 400]]);
  });
});

describe("the read writer is told the form can total a computed value (P7-I4: it said it cannot, and refused a right read)", () => {
  // The form's own description is the writer's only knowledge of the form. A capability the schema accepts (above) and the
  // description omits is one the writer reports as missing — read off the source, so the two cannot drift apart silently.
  const src = readFileSync(fileURLToPath(new URL("./db-operation-proposal.service.ts", import.meta.url)), "utf8");
  it("the computed-value line offers `aggregate`, as the plain column's does", () => {
    // Worded since 2.9.0 as "An aggregate may summarise a COMPUTED value…" (it was "A column may COMPUTE a value…").
    const line = src.split("\n").find((l) => l.includes("An aggregate may summarise a COMPUTED value"));
    expect(line, "CONTROL: the line exists").toBeDefined();
    expect(line).toContain('"aggregate"');
    expect(line).toContain('"compute"');
  });
});
