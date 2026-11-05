/**
 * A column compared with ANOTHER column of the same rows (2026-10-02): "devices whose latest reading is above their class's maximum"
 * could not be read — a filter compared a column with a parameter or a fixed number only, and the proposer said so (FL01, FL02).
 * Compiled by the one SQL emitter and RUN on SQLite, so the rows kept are checked, not the text.
 */
import { describe, expect, it } from "vitest";
import type { SchemaRow } from "../repositories/schema.repo.js";
import { compileOperation, dbOperationSpecSchema } from "./db-operation.service.js";
import { readback } from "./db-operation-readback.js";
import { toSqlite } from "./sqlite-dialect.js";
import { DatabaseSync } from "./sqlite-driver.js";

const col = (entityName: string, columnName: string, columnType: string): SchemaRow => ({
  id: `${entityName}.${columnName}`, datasourceId: "ds", entityType: "table", entitySchema: "main", entityName, columnName, columnType,
  isPrimaryKey: false, isForeignKey: false, foreignKeyReference: null, nullable: true, characterMaximumLength: null,
  semanticTag: null, valueDomain: null, rowCountEstimate: null, nullPercentage: null, extractedAt: new Date("2026-10-02T00:00:00Z"),
});
const ROWS = [col("device", "id", "integer"), col("device", "class_id", "integer"), col("device", "temp", "double precision"), col("device", "label", "text"), col("class", "id", "integer"), col("class", "max_temp", "double precision")];
const spec = (filter: Record<string, unknown>) => ({
  base: { table: "device" },
  columns: [{ column: "device.label", alias: "label" }],
  joins: [{ table: "class", kind: "inner", onLeft: "class_id", onRight: "id" }],
  filters: [filter], having: [], sort: [], limit: 100,
});

describe("a column against another column of the same rows", () => {
  const ABOVE = spec({ column: "temp", op: "gt", against: "max_temp" });
  it("is accepted, compiles to a column-to-column test, and takes no parameter", () => {
    expect(dbOperationSpecSchema.safeParse(ABOVE).success).toBe(true);
    const c = compileOperation(ABOVE as never, ROWS);
    expect(c.sql).toMatch(/"temp" > "[a-z0-9_]+"\."max_temp"/);
    expect(c.paramOrder).toEqual([]);
    expect(readback(ABOVE as never).map((c) => c.text).join(" ")).toMatch(/GREATER THAN its own `max_temp`/);
  });
  it("RUN on SQLite: keeps exactly the rows above their own class's maximum", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE device (id INTEGER, class_id INTEGER, temp REAL, label TEXT); CREATE TABLE class (id INTEGER, max_temp REAL)");
    db.exec("INSERT INTO class VALUES (1, 50), (2, 80); INSERT INTO device VALUES (1,1,55,'hot-a'),(2,1,45,'ok-a'),(3,2,70,'ok-b'),(4,2,90,'hot-b')");
    const rows = db.prepare(toSqlite(compileOperation(ABOVE as never, ROWS).sql.replace(/"main"\./g, "")).sql).all() as Array<{ label: string }>;
    expect(rows.map((r) => r.label).sort()).toEqual(["hot-a", "hot-b"]);
  });
  it("CONTROL: two of param/value/against, a non-comparison, or two kinds of value are refused", () => {
    expect(dbOperationSpecSchema.safeParse(spec({ column: "temp", op: "gt", against: "max_temp", param: "x" })).success).toBe(false);
    expect(dbOperationSpecSchema.safeParse(spec({ column: "temp", op: "like", against: "max_temp" })).success).toBe(false);
    expect(() => compileOperation(spec({ column: "label", op: "gt", against: "max_temp" }) as never, ROWS)).toThrow(/cannot be compared/);
  });
});
