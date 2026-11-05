import { describe, expect, it, vi } from "vitest";
import { rowOf, renderType } from "@foundry/flow-edit";
import type { SchemaRow } from "../repositories/schema.repo.js";

/**
 * D-311 (slice 5d): the save funnel types a schema-built reader from the spec it carries — and ONLY when that spec compiles to
 * the step's own statement. A spec whose SQL differs from the step's cannot lend the step typed columns it does not return.
 * Name-free fixture (`t1`, `t2`).
 */
const col = (entityName: string, columnName: string, columnType: string, o: Partial<SchemaRow> = {}): SchemaRow => ({
  id: `s-${entityName}-${columnName}`, datasourceId: "ds-id", entityType: "table", entitySchema: "public", entityName, columnName, columnType,
  isPrimaryKey: false, isForeignKey: false, foreignKeyReference: null, nullable: false, characterMaximumLength: null,
  semanticTag: null, valueDomain: null, rowCountEstimate: null, nullPercentage: null, extractedAt: new Date("2026-09-27T00:00:00Z"), ...o,
});
const ROWS = [col("t1", "id", "integer"), col("t1", "c1", "text"), col("t1", "k2", "integer", { isForeignKey: true, foreignKeyReference: "t2.id" }), col("t2", "id", "integer"), col("t2", "c2", "text", { semanticTag: "email" })];

vi.mock("./manifest-builder.service.js", () => ({ manifestBuilderService: { refInterfaces: vi.fn(async () => ({})) } }));
vi.mock("../repositories/db-operation.repo.js", () => ({ dbOperationRepo: { listByWorkspace: vi.fn(async () => []) } }));
vi.mock("../repositories/datasource.repo.js", () => ({ datasourceRepo: { listByWorkspace: vi.fn(async () => [{ id: "ds-id", name: "ds" }]) } }));
vi.mock("../repositories/schema.repo.js", () => ({ schemaRepo: { listByDatasource: vi.fn(async () => ROWS) } }));

const { buildCatalogueSnapshot } = await import("./flow-typecheck.js");
const { tableReaders } = await import("./builder/table-readers.js");

const reader = () => tableReaders("ds", ROWS).readers.find((r) => r.table === "t1")!;
const model = (sql: string) => ({ steps: [{ id: "read", kind: "query", ref: reader().ref, sql, datasourceRef: "ds", sqlSpec: reader().spec, dependsOn: [] }] });
const fieldsAt = (cat: Awaited<ReturnType<typeof buildCatalogueSnapshot>>) => {
  const sig = cat.refs[reader().ref];
  if (!sig) return null;
  const r = rowOf(sig.payload);
  return r.t === "Record" ? Object.fromEntries(Object.entries(r.fields).map(([k, t]) => [k, renderType(t)])) : null;
};

describe("buildCatalogueSnapshot types a schema-built reader from its own spec (D-311)", () => {
  it("the spec's columns, typed as a saved operation's would be, when the spec compiles to the step's statement", async () => {
    const cat = await buildCatalogueSnapshot("ws", model(reader().sql) as never);
    expect(fieldsAt(cat)).toMatchObject({ c1: "Text", t2_c2: expect.stringMatching(/^Option<Address/) });
    expect(cat.stepColumns?.read).toBeUndefined(); // typed by the spec, not by names
  });

  it("NEGATIVE CONTROL: a statement that is not the spec's — the spec lends it nothing", async () => {
    const cat = await buildCatalogueSnapshot("ws", model(`${reader().sql} `) as never);
    expect(fieldsAt(cat)).toBeNull();
  });
});
