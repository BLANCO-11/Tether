import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderType, rowOf } from "@foundry/flow-edit";
import type { SchemaRow } from "../../repositories/schema.repo.js";
import { isTableRef, tableReaders } from "./table-readers.js";

/**
 * Readers built from the schema (D-311, slice 5d). Every fixture is NAME-FREE (`t1.c1` …): the construction may know nothing
 * about any domain, so a test with domain words could pass for a reason the product does not have.
 */
const col = (entityName: string, columnName: string, columnType: string, o: Partial<SchemaRow> = {}): SchemaRow => ({
  id: `s-${entityName}-${columnName}`, datasourceId: "ds", entityType: "table", entitySchema: "public", entityName, columnName, columnType,
  isPrimaryKey: columnName === "id", isForeignKey: false, foreignKeyReference: null, nullable: false, characterMaximumLength: null,
  semanticTag: null, valueDomain: null, rowCountEstimate: null, nullPercentage: null, extractedAt: new Date("2026-09-27T00:00:00Z"), ...o,
});
const fk = (entityName: string, columnName: string, to: string, nullable = false) => col(entityName, columnName, "integer", { isForeignKey: true, foreignKeyReference: to, nullable });

const SCHEMA: SchemaRow[] = [
  col("t1", "id", "integer"), col("t1", "c1", "text"), fk("t1", "k2", "t2.id"),
  col("t2", "id", "integer"), col("t2", "c2", "text", { semanticTag: "email" }), fk("t2", "k3", "t3.id"),
  col("t3", "id", "integer"), col("t3", "c3", "text"),
  // t4 refers to t1 once: t1 gets a count and the latest date of its t4 rows.
  col("t4", "id", "integer"), fk("t4", "k1", "t1.id"), col("t4", "d4", "timestamp with time zone"),
  // t5 has TWO keys to t2: which one a goal means is not declared, so t2 is joined by neither.
  col("t5", "id", "integer"), fk("t5", "ka", "t2.id"), fk("t5", "kb", "t2.id"),
];

const fieldsOf = (ref: string, rs = tableReaders("ds", SCHEMA).readers) => {
  const r = rs.find((x) => x.ref === ref)!;
  const row = rowOf(r.sig.payload);
  return row.t === "Record" ? Object.fromEntries(Object.entries(row.fields).map(([k, t]) => [k, renderType(t)])) : {};
};

describe("tableReaders — a table is a reader (D-311)", () => {
  it("offers every table, under a ref no saved reader can have", () => {
    const { readers, skipped } = tableReaders("ds", SCHEMA);
    expect(skipped).toEqual([]);
    expect(readers.map((r) => r.ref).sort()).toEqual(["ds.table.t1", "ds.table.t2", "ds.table.t3", "ds.table.t4", "ds.table.t5"]);
    expect(readers.every((r) => isTableRef(r.ref))).toBe(true);
    expect(isTableRef("ds.some_saved_operation")).toBe(false);
  });

  it("a column with NO declared type is left out of the reader, named — never the whole table hidden (2026-10-01)", () => {
    // A SQLite view's computed column declares no type ("any"); one used to make the engine refuse the whole reader.
    const rows = [col("v6", "id", "integer", { entityType: "view" }), col("v6", "n6", "double precision", { entityType: "view" }), col("v6", "x6", "any", { entityType: "view" })];
    const { readers, skipped } = tableReaders("ds", rows);
    expect(skipped).toEqual([]);
    const r = readers.find((x) => x.ref === "ds.table.v6")!;
    expect(JSON.stringify(r.sig.payload)).not.toMatch(/Opaque|"Json"/);
    expect(Object.keys(fieldsOf("ds.table.v6", readers)).sort()).toEqual(["id", "n6"]);
    expect(r.about).toMatch(/without x6: no declared type/);
    // CONTROL: a fully typed table says nothing about missing columns.
    expect(readers.length).toBe(1);
    expect(tableReaders("ds", SCHEMA).readers.every((x) => !/no declared type/.test(x.about))).toBe(true);
  });

  it("joins along declared keys, two hops, and types what it reads (a left join makes the far side optional)", () => {
    const f = fieldsOf("ds.table.t1");
    expect(f.c1).toBe("Text");
    expect(f.t2_c2).toMatch(/^Option<Address/); // the owner's tag, one hop out, nullable across the join
    expect(f.t3_c3).toMatch(/^Option</); // two hops
    expect(tableReaders("ds", SCHEMA).readers.find((r) => r.ref === "ds.table.t1")!.tables).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("counts the rows that refer to it and gives their latest date — an absent child is an empty count, never a guess", () => {
    const f = fieldsOf("ds.table.t1");
    expect(f.t4_count).toMatch(/^Option<Int/);
    expect(f.t4_latest_d4).toMatch(/^Option<DateTime/);
  });

  it("never joins a table two keys lead to — which one is meant is not declared", () => {
    const f = fieldsOf("ds.table.t5");
    expect(Object.keys(f).some((k) => k.startsWith("t2_"))).toBe(false);
    expect(f.ka).toBeDefined(); // the keys stay on the row
    expect(f.kb).toBeDefined();
  });

  it("NEGATIVE CONTROL: without the declared key there is no join", () => {
    const noKey = SCHEMA.map((r) => (r.entityName === "t1" && r.columnName === "k2" ? { ...r, isForeignKey: false, foreignKeyReference: null } : r));
    const f = fieldsOf("ds.table.t1", tableReaders("ds", noKey).readers);
    expect(Object.keys(f).some((k) => k.startsWith("t2_") || k.startsWith("t3_"))).toBe(false);
    expect(f.k2).toBe("Int");
  });

  it("the SQL is compileOperation's: read-only, one statement", () => {
    const r = tableReaders("ds", SCHEMA).readers.find((x) => x.ref === "ds.table.t1")!;
    expect(r.sql).toMatch(/^SELECT /);
    expect(r.sql).not.toMatch(/;\s*\S/);
    expect(r.sql).toMatch(/LEFT JOIN/);
  });

  it("the construction names no table, column or workspace (agnostic, read off its own source)", () => {
    const src = readFileSync(fileURLToPath(new URL("./table-readers.ts", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src.length).toBeGreaterThan(1000);
    const strings = [...src.matchAll(/"([^"\\]*)"|'([^'\\]*)'/g)].map((m) => m[1] ?? m[2]!).filter(Boolean);
    const allowed = new Set(["table", "view", "materialized_view", "public", "left", "count", "max", "operation", ".table.", "Record", ".", ", ", "columns", "joins", "aggregateJoins", "Opaque", "Json", "of"]); // type-index keys and joiners, not names
    expect(strings.filter((s) => !allowed.has(s) && !s.startsWith("../") && !s.startsWith("@foundry/") && !s.startsWith("./"))).toEqual([]);
  });
});
