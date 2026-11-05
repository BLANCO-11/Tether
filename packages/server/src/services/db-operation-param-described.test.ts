/**
 * Every parameter a read takes is DESCRIBED, wherever the form uses it (2026-10-04). A filter on a computed value ("placed more than
 * 5 days ago" = the days between the order date and the run day, above 5) holds a parameter INSIDE the computation (the run day), and
 * descriptors were written only for the select list's computations — so the compiler's own output failed its own shape check
 * ("no descriptor for run_day"), three times over, and a valid read could not be written. A parameter allocated anywhere gets its
 * descriptor from the same place, or the compiler refuses by name — never a statement whose schema disagrees with its placeholders.
 */
import { describe, expect, it } from "vitest";
import type { SchemaRow } from "../repositories/schema.repo.js";
import { compileOperation } from "./db-operation.service.js";

const col = (entityName: string, columnName: string, columnType: string): SchemaRow => ({
  id: `${entityName}.${columnName}`, datasourceId: "ds", entityType: "table", entitySchema: "public", entityName, columnName, columnType,
  isPrimaryKey: false, isForeignKey: false, foreignKeyReference: null, nullable: true, characterMaximumLength: null,
  semanticTag: null, valueDomain: null, rowCountEstimate: null, nullPercentage: null, extractedAt: new Date("2026-10-01T00:00:00Z"),
});
const ROWS = [col("orders", "id", "integer"), col("orders", "placed_at", "date"), col("orders", "total", "integer")];
const spec = (filters: unknown[], having: unknown[] = []) => ({ base: { table: "orders" }, columns: [{ column: "id", alias: "id" }], joins: [], aggregateJoins: [], filters, having, sort: [{ column: "id", dir: "asc" }], limit: 100 });
const age = { diffDays: { start: { column: "placed_at" }, end: { param: "run_day", type: "date" } } };

describe("a parameter inside a filter's computation is described", () => {
  it("a filter on 'days since' the run day compiles, and describes run_day as a date", () => {
    const c = compileOperation(spec([{ compute: age, op: "gt", param: "min_days" }]) as never, ROWS);
    expect(c.paramOrder).toEqual(expect.arrayContaining(["run_day", "min_days"]));
    expect(c.paramsSchema.run_day).toMatchObject({ type: "date", required: true });
    expect(Object.keys(c.paramsSchema).sort()).toEqual([...c.paramOrder].sort());
  });
  it("the same computation in the select list still does (the control: that path was already described)", () => {
    const s = { ...spec([]), columns: [{ column: "id", alias: "id" }, { compute: age, alias: "age" }] };
    const c = compileOperation(s as never, ROWS);
    expect(c.paramsSchema.run_day).toMatchObject({ type: "date" });
  });
});

/** The rule, over every computation and every place one can sit — not the one case that was reported. */
describe("every computation × every place: the compiled statement passes its own shape check", () => {
  const P = (type: string) => ({ param: "p_in", type });
  const computes: Record<string, unknown> = {
    addDays: { addDays: { value: { column: "placed_at" }, days: P("number") } },
    addDaysParamDate: { addDays: { value: P("date"), days: { number: 3 } } },
    diffDays: { diffDays: { start: { column: "placed_at" }, end: P("date") } },
    diffMinutes: { diffMinutes: { start: { column: "placed_at" }, end: P("datetime") } },
    greatest: { greatest: { first: { column: "total" }, second: P("number") } },
    least: { least: { first: { column: "total" }, second: P("number") } },
    coalesce: { coalesce: [{ column: "total" }, P("number")] },
  };
  for (const [name, node] of Object.entries(computes)) {
    it(`${name}: in the select list, and in a filter`, () => {
      for (const where of ["select", "filter"] as const) {
        const s = where === "select"
          ? { ...spec([]), columns: [{ column: "id", alias: "id" }, { compute: node, alias: "x" }] }
          : spec([{ compute: node, op: "gt", param: "cmp_value" }]);
        let c; try { c = compileOperation(s as never, ROWS); } catch (e) { expect(String((e as Error).message)).not.toMatch(/paramsSchema must describe|no descriptor/); continue; }
        expect(Object.keys(c.paramsSchema).sort(), `${name} in ${where}`).toEqual([...c.paramOrder].sort());
      }
    });
  }
});
