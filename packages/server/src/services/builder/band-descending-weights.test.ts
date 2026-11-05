/**
 * Descending-weight partitions — the property that the old scorer rejected:
 * a goal may put its heaviest weight on its lowest band. The model's own
 * `bands`/`counts` lower generally; no weight-order assumption is examined.
 */
import { describe, expect, it } from "vitest";
import type { SchemaRow } from "../../repositories/schema.repo.js";
import { compileOperation } from "../db-operation.service.js";
import { toSqlite, bindValues } from "../sqlite-dialect.js";
import { DatabaseSync } from "../sqlite-driver.js";
import {
  bandSpecValid,
  emitBandedSpec,
  evalBandWeight,
  type BandMeasureIn,
} from "./band-read.js";
import type { BandArm } from "./plan.js";

const mkCol = (entityName: string, columnName: string, columnType: string, pk = false): SchemaRow => ({
  id: `${entityName}.${columnName}`,
  datasourceId: "ds",
  entityType: "table",
  entitySchema: "main",
  entityName,
  columnName,
  columnType,
  isPrimaryKey: pk,
  isForeignKey: false,
  foreignKeyReference: null,
  nullable: true,
  characterMaximumLength: null,
  semanticTag: null,
  valueDomain: null,
  rowCountEstimate: null,
  nullPercentage: null,
  extractedAt: new Date("2026-10-07T00:00:00Z"),
});

describe("band descending weights — heaviest weight on the lowest band", () => {
  it("emits the model's arms verbatim and scores them on SQLite", () => {
    // Cold-chain urgency: the coldest readings matter most.
    const schema = [
      mkCol("reading", "truck_id", "text", true),
      mkCol("truck", "truck_id", "text", true),
      mkCol("reading", "temp_c", "double precision"),
    ];
    const bands: BandArm[] = [
      { test: "below", value: "2", then: 8, words: "critical" },
      { test: "below", value: "8", then: 3, words: "watch" },
      { test: "at_least", value: "8", then: 0, words: "fine" },
    ];
    const measures: BandMeasureIn[] = [
      { words: "critical readings", field: "Cold_DB.new_read.temp_c", counts: "critical", bands },
      { words: "urgency", field: "Cold_DB.new_read.temp_c", counts: null, bands },
    ];
    const spec = emitBandedSpec(schema, measures, [{ field: "truck_id", words: "truck" }]);
    expect(spec).not.toBeNull();
    // Descending weights are structurally valid — never rejected or inverted.
    expect(bandSpecValid(spec as never, measures)).toBe(true);
    const joins = (spec as unknown as {
      aggregateJoins: Array<{ aggregates: Array<{ compute: { caseWhen: { arms: Array<{ op: string; right: { number: number }; then: { number: number } }> } }; alias: string }> }>;
    }).aggregateJoins;
    const sig = (i: number) =>
      joins[0]!.aggregates[i]!.compute.caseWhen.arms.map((a) => [a.op, a.right.number, a.then.number]);
    expect(joins[0]!.aggregates[0]!.alias).toBe("band_critical_readings");
    expect(sig(0)).toEqual([["lt", 2, 1]]);
    expect(joins[0]!.aggregates[1]!.alias).toBe("band_urgency");
    expect(sig(1)).toEqual([
      ["lt", 2, 8],
      ["lt", 8, 3],
      ["gte", 8, 0],
    ]);
    const compiled = compileOperation(spec as never, schema, { dialect: "sqlite" });
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE reading (truck_id TEXT, temp_c REAL)");
    db.exec("CREATE TABLE truck (truck_id TEXT)");
    db.exec("INSERT INTO reading VALUES ('T',-5),('T',1.99),('T',2),('T',7.99),('T',8),('T',30)");
    db.exec("INSERT INTO truck VALUES ('T')");
    const q = toSqlite(compiled.sql.replace(/"main"\./g, ""));
    const row = db.prepare(q.sql).get(...bindValues(q, [])) as Record<string, number>;
    db.close();
    // First-match: -5 and 1.99 hit the critical arm; 2 and 7.99 the watch arm.
    expect(Number(row.band_critical_readings)).toBe(2);
    const expected = [-5, 1.99, 2, 7.99, 8, 30].reduce((s, v) => s + evalBandWeight(v, bands), 0);
    expect(expected).toBe(8 + 8 + 3 + 3 + 0 + 0);
    expect(Number(row.band_urgency)).toBe(expected);
  });
});
