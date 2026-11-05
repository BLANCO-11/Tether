/**
 * Banded labels in the read form: "half day is >= 4.75 hours (0.5), full day is 0-4.74 hours (1)"
 * had no computable shape — the plan put the bands in summary English and the form could not hold a
 * CASE. {caseWhen} labels each row by the FIRST arm whose test holds, else `else`.
 */
import { describe, expect, it } from "vitest";
import type { SchemaRow } from "../repositories/schema.repo.js";
import { compileOperation, dbOperationSpecSchema } from "./db-operation.service.js";
import { toSqlite, bindValues } from "./sqlite-dialect.js";
import { DatabaseSync } from "./sqlite-driver.js";

const col = (entityName: string, columnName: string, columnType: string): SchemaRow => ({
  id: `${entityName}.${columnName}`, datasourceId: "ds", entityType: "table", entitySchema: "main", entityName, columnName, columnType,
  isPrimaryKey: false, isForeignKey: false, foreignKeyReference: null, nullable: true, characterMaximumLength: null,
  semanticTag: null, valueDomain: null, rowCountEstimate: null, nullPercentage: null, extractedAt: new Date("2026-10-06T00:00:00Z"),
});
const ROWS = [col("day", "emp_id", "integer"), col("day", "hours", "double precision")];
// Half day: hours >= 4.75 → 0.5. Full day: hours < 4.75 → 1 (the HR absence bands; 0–4.74 band impl).
const BAND = {
  caseWhen: {
    arms: [
      { op: "gte", left: { column: "hours" }, right: { param: "half_day_hours" }, then: { number: 0.5 } },
    ],
    else: { number: 1 },
  },
};
const SPEC = {
  base: { table: "day" },
  columns: [{ column: "emp_id", alias: "emp_id" }, { compute: BAND, alias: "absence_weight" }],
  joins: [], aggregateJoins: [], filters: [], having: [], sort: [{ column: "emp_id", dir: "asc" }], limit: 100,
};

describe("a banded label, read by the form", () => {
  const compiled = compileOperation(SPEC as never, ROWS);
  it("accepted by the form, parameter numbered, CASE WHEN emitted", () => {
    expect(dbOperationSpecSchema.safeParse(SPEC).success).toBe(true);
    expect(compiled.sql).toMatch(/CASE WHEN .* >= .* THEN \(0\.5\) ELSE \(1\) END/);
  });

  it("RUN on SQLite: 9.5 → 0.5, 4.75 → 0.5 (boundary), 4.74 → 1, 0 → 1", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE day (emp_id INTEGER, hours REAL)");
    db.exec("INSERT INTO day VALUES (1,9.5),(1,4.75),(1,4.74),(1,0)");
    const stmt = toSqlite(compiled.sql.replace(/"main"\./g, ""));
    const rows = db.prepare(stmt.sql).all(...bindValues(stmt, [4.75])) as Array<{ absence_weight: number }>;
    db.close();
    expect(rows.map((r) => r.absence_weight)).toEqual([0.5, 0.5, 1, 1]);
  });

  it("CONTROL: arms need op+left+right+then, at least one arm; else optional", () => {
    const ok = (c: unknown) => dbOperationSpecSchema.safeParse({ ...SPEC, columns: [{ compute: c, alias: "w" }] }).success;
    expect(ok({ caseWhen: { arms: [] } })).toBe(false);
    expect(ok({ caseWhen: { arms: [{ op: "gte", left: { column: "hours" }, right: { number: 4.75 } }] } })).toBe(false);
    expect(ok({ caseWhen: { arms: [{ op: "gte", left: { column: "hours" }, right: { number: 4.75 }, then: { number: 0.5 } }] } })).toBe(true);
  });
});
