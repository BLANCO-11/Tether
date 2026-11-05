/**
 * A compiled operation says which of its columns can be NULL, and the checker's types follow it
 * (compiled-builder programme, phase 2a: E0.7 G4, G5, G7; I-270).
 *
 * The property: a column typed non-null is never NULL on data that conforms to the schema. Each case below is a
 * way the old typing broke that — an aggregate over zero rows, the outer side of a LEFT JOIN — and each goes red
 * if the rule is removed.
 */
import { describe, expect, it } from "vitest";
import { compileOperation } from "./db-operation.service.js";
import { operationFields } from "./flow-typecheck.js";
import type { SchemaRow } from "../repositories/schema.repo.js";

function row(entityName: string, columnName: string | null, columnType: string | null, nullable = true, entitySchema = "public"): SchemaRow {
  return {
    id: `${entitySchema}.${entityName}.${columnName ?? ""}`,
    datasourceId: "ds",
    entityType: "table",
    entityName,
    entitySchema,
    columnName,
    columnType,
    isPrimaryKey: false,
    isForeignKey: false,
    foreignKeyReference: null,
    nullable,
    characterMaximumLength: null,
    rowCountEstimate: null,
    nullPercentage: null,
    extractedAt: new Date("2026-09-26T00:00:00Z"),
  } as SchemaRow;
}

// devices(device_id NOT NULL, label NOT NULL, owner_email NULL) · readings(device_id NOT NULL, temperature NOT NULL)
const SCHEMA: SchemaRow[] = [
  row("devices", null, null),
  row("devices", "device_id", "text", false),
  row("devices", "label", "text", false),
  row("devices", "owner_email", "text", true),
  row("readings", null, null),
  row("readings", "device_id", "text", false),
  row("readings", "temperature", "numeric", false),
];

const nullableOf = (cols: ReturnType<typeof compileOperation>["outputColumns"]) => Object.fromEntries(cols.map((c) => [c.alias, c.nullable]));

describe("compileOperation — which output columns can be NULL", () => {
  it("a bare column keeps the schema's NOT NULL, and a nullable column stays nullable", () => {
    const c = compileOperation({ base: { table: "devices" }, columns: [{ column: "label", alias: "label" }, { column: "owner_email", alias: "owner" }] }, SCHEMA);
    expect(nullableOf(c.outputColumns)).toEqual({ label: false, owner: true });
  });

  it("⚠ G5: a NOT NULL column on the outer side of a LEFT JOIN is nullable — an unmatched row reads NULL", () => {
    const c = compileOperation({
      base: { table: "devices" },
      columns: [{ column: "devices.device_id", alias: "device" }, { column: "readings.temperature", alias: "temp" }],
      joins: [{ table: "readings", onLeft: "devices.device_id", onRight: "device_id", kind: "left" }],
    }, SCHEMA);
    expect(nullableOf(c.outputColumns)).toEqual({ device: false, temp: true });
  });

  it("an INNER join keeps the joined column's NOT NULL", () => {
    const c = compileOperation({
      base: { table: "devices" },
      columns: [{ column: "readings.temperature", alias: "temp" }],
      joins: [{ table: "readings", onLeft: "devices.device_id", onRight: "device_id", kind: "inner" }],
    }, SCHEMA);
    expect(nullableOf(c.outputColumns)).toEqual({ temp: false });
  });

  it("⚠ G4: an aggregate with NO GROUP BY is nullable — over zero rows it returns one row of NULLs", () => {
    const c = compileOperation({ base: { table: "readings" }, columns: [{ column: "temperature", aggregate: "avg", alias: "avg_temp" }] }, SCHEMA);
    expect(nullableOf(c.outputColumns)).toEqual({ avg_temp: true });
  });

  it("a grouped aggregate over a NOT NULL column is not nullable — every group has at least one row", () => {
    const c = compileOperation({ base: { table: "readings" }, columns: [{ column: "device_id", alias: "device" }, { column: "temperature", aggregate: "max", alias: "max_temp" }] }, SCHEMA);
    expect(nullableOf(c.outputColumns)).toEqual({ device: false, max_temp: false });
  });

  it("count is never NULL, grouped or not", () => {
    const c = compileOperation({ base: { table: "readings" }, columns: [{ column: "device_id", aggregate: "count", alias: "n" }] }, SCHEMA);
    expect(nullableOf(c.outputColumns)).toEqual({ n: false });
  });
});

describe("operationFields — the checker's types follow the compiler", () => {
  it("types an outer-joined NOT NULL column as Option", () => {
    const c = compileOperation({
      base: { table: "devices" },
      columns: [{ column: "devices.label", alias: "label" }, { column: "readings.temperature", alias: "temp" }],
      joins: [{ table: "readings", onLeft: "devices.device_id", onRight: "device_id", kind: "left" }],
    }, SCHEMA);
    const f = operationFields(c.outputColumns, SCHEMA);
    expect(f.label).toEqual({ t: "Text" });
    expect(f.temp?.t).toBe("Option");
  });

  it("types an ungrouped avg as Option<Number>, not Number", () => {
    const c = compileOperation({ base: { table: "readings" }, columns: [{ column: "temperature", aggregate: "avg", alias: "avg_temp" }] }, SCHEMA);
    expect(operationFields(c.outputColumns, SCHEMA).avg_temp).toEqual({ t: "Option", of: { t: "Number" } });
  });

  it("⚠ G7: the schema-row fallback matches on the schema qualifier, so hr.devices is not public.devices", () => {
    const two = [...SCHEMA, row("devices", "owner_email", "text", false, "hr")];
    // No `nullable` from the compiler → the fallback lookup decides. `hr.devices.owner_email` is NOT NULL.
    const f = operationFields([{ alias: "owner", source: "hr.devices.owner_email", type: "text" }], two);
    expect(f.owner).toEqual({ t: "Text" });
    const g = operationFields([{ alias: "owner", source: "public.devices.owner_email", type: "text" }], two);
    expect(g.owner?.t).toBe("Option");
  });
});
