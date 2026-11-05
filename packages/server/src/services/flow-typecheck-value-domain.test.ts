/**
 * compiled-builder I-301: a column's KNOWN value domain types what reads it and what is compared with it. Name-free (`t1`).
 */
import { describe, expect, it } from "vitest";
import { TypeOf as T } from "@foundry/flow-edit";
import type { SchemaRow } from "../repositories/schema.repo.js";
import { compileOperation } from "./db-operation.service.js";
import { operationFields, paramsWithDomains } from "./flow-typecheck.js";

const col = (columnName: string, columnType: string, o: Partial<SchemaRow> = {}): SchemaRow => ({
  id: `s-${columnName}`, datasourceId: "ds", entityType: "table", entitySchema: "public", entityName: "t1", columnName, columnType,
  isPrimaryKey: false, isForeignKey: false, foreignKeyReference: null, nullable: false, characterMaximumLength: null,
  semanticTag: null, valueDomain: null, rowCountEstimate: null, nullPercentage: null, extractedAt: new Date("2026-09-27T00:00:00Z"), ...o,
});
const ROWS = [col("id", "integer"), col("c1", "text", { valueDomain: { values: ["a", "b"], source: "declared" } }), col("c2", "text")];
const SPEC = { base: { table: "t1" }, columns: [{ column: "id", alias: "id" }, { column: "c1", alias: "c1" }, { column: "c2", alias: "c2" }], joins: [], filters: [{ column: "c1", op: "eq", param: "p1" }, { column: "c2", op: "eq", param: "p2" }], having: [], aggregateJoins: [], sort: [], limit: 100 };

describe("value domains in the catalogue (I-301)", () => {
  const compiled = compileOperation(SPEC as never, ROWS);
  it("the compiled operation says which column each equality parameter is compared with", () => {
    expect(compiled.paramColumns).toEqual({ p1: { schema: "public", table: "t1", column: "c1" }, p2: { schema: "public", table: "t1", column: "c2" } });
  });
  it("a field with a known domain is a closed set; one without stays open text", () => {
    const f = operationFields(compiled.outputColumns, ROWS);
    expect(f.c1).toEqual(T.text([{ r: "OneOf", values: ["a", "b"] }]));
    expect(f.c2).toEqual(T.text());
  });
  it("a parameter compared with a known-domain column takes that domain; CONTROL: the other stays open", () => {
    const params = paramsWithDomains([{ name: "p1", ty: T.text(), required: true }, { name: "p2", ty: T.text(), required: true }], compiled.paramColumns!, ROWS);
    expect(params[0]!.ty).toEqual(T.text([{ r: "OneOf", values: ["a", "b"] }]));
    expect(params[1]!.ty).toEqual(T.text());
  });
});

describe("a parameter inside a summary join takes its column's values too (2026-10-01)", () => {
  // t2 rows are summarised per t1 row; the summary counts only rows of one kind — the kind is a parameter.
  const t2 = (c: string, ty: string, o: Partial<SchemaRow> = {}) => col(c, ty, { entityName: "t2", ...o });
  const ROWS2 = [...ROWS, t2("t1_id", "integer"), t2("kind", "text", { valueDomain: { values: ["Big", "Small"], source: "observed" } }), t2("n", "integer")];
  const SPEC2 = { ...SPEC, filters: [], aggregateJoins: [{ table: "t2", groupBy: "t1_id", onLeft: "id", kind: "left", aggregates: [{ column: "n", aggregate: "sum", alias: "total" }], filters: [{ column: "kind", op: "eq", param: "kind_is" }] }] };
  const compiled = compileOperation(SPEC2 as never, ROWS2);
  it("its column is recorded — and NOT its op, so it selects no output field", () => {
    expect(compiled.paramColumns?.kind_is).toEqual({ schema: "public", table: "t2", column: "kind" });
    expect(compiled.paramOps?.kind_is).toBeUndefined();
  });
  it("so the parameter is a closed set: “big” words resolve to Big, never bound raw against a case-sensitive `=`", () => {
    const [p] = paramsWithDomains([{ name: "kind_is", ty: T.text(), required: true }], compiled.paramColumns!, ROWS2);
    expect(p!.ty).toEqual(T.text([{ r: "OneOf", values: ["Big", "Small"] }]));
  });
});

describe("a summary's columns spelled with its own table's name (2026-10-01)", async () => {
  const { dbOperationSpecSchema } = await import("./db-operation.service.js");
  const t2 = (c: string, ty: string) => col(c, ty, { entityName: "t2" });
  const ROWS3 = [...ROWS, t2("t1_id", "integer"), t2("kind", "text"), t2("n", "integer")];
  const agg = (q: string) => ({ table: "t2", groupBy: `${q}t1_id`, onLeft: "id", kind: "left", aggregates: [{ column: `${q}n`, aggregate: "sum", alias: "total" }], filters: [{ column: `${q}kind`, op: "eq", param: "k" }] });
  const spec = (q: string) => ({ ...SPEC, filters: [], aggregateJoins: [agg(q)] });
  it("`t2.n` inside the t2 summary is `n` — the form stores one spelling, and it compiles to the same SQL", () => {
    const parsed = dbOperationSpecSchema.parse(spec("t2."));
    expect(parsed.aggregateJoins[0]).toMatchObject({ groupBy: "t1_id", aggregates: [{ column: "n" }], filters: [{ column: "kind" }] });
    expect(compileOperation(spec("t2.") as never, ROWS3).sql).toBe(compileOperation(spec("") as never, ROWS3).sql);
    expect(compileOperation(spec("public.t2.") as never, ROWS3).sql).toBe(compileOperation(spec("") as never, ROWS3).sql);
  });
  it("CONTROL: another table's name is refused by name — a summary reads only the tables it summarises (its own and `through`)", () => {
    // The form admits a qualified name (a `through` table's column is one, P2-D3); the COMPILER refuses a table the summary does
    // not include, by name — the same property, decided where the tables are known.
    expect(dbOperationSpecSchema.safeParse(spec("t1.")).success).toBe(true);
    let msg = "";
    try { compileOperation(spec("t1.") as never, ROWS3); } catch (e) { msg = ((e as { findings?: Array<{ message: string }> }).findings ?? []).map((f) => f.message).join("; "); }
    expect(msg).toMatch(/t1/);
    expect(msg).not.toBe("");
  });
});


describe("a result column qualified by its table (2026-10-01)", async () => {
  const { dbOperationSpecSchema } = await import("./db-operation.service.js");
  const t2 = (c: string, ty: string) => col(c, ty, { entityName: "t2" });
  const ROWS4 = [...ROWS, t2("id", "integer"), t2("label", "text")];
  const spec = (c: Record<string, unknown>) => ({ ...SPEC, filters: [], columns: [{ column: "id", alias: "id" }, { ...c, alias: "t2_label" }], joins: [{ table: "t2", onLeft: "id", onRight: "id", kind: "left" }] });
  it("`column: \"t2.label\"` is accepted and compiles exactly as `compute: { column: \"t2.label\" }`", () => {
    expect(dbOperationSpecSchema.safeParse(spec({ column: "t2.label" })).success).toBe(true);
    expect(compileOperation(spec({ column: "t2.label" }) as never, ROWS4).sql).toBe(compileOperation(spec({ compute: { column: "t2.label" } }) as never, ROWS4).sql);
  });
  it("CONTROL: a column that is not a reference is still refused", () => {
    expect(dbOperationSpecSchema.safeParse(spec({ column: "t2.label; drop" })).success).toBe(false);
  });
});
