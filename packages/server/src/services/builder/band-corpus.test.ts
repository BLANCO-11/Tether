/**
 * Cross-domain band corpus — the PROPERTY is that weight order is never
 * assumed: the model's own `bands`/`counts` lower generally, whatever the
 * domain or the direction of the weights. Five unrelated fixtures; at least
 * one has descending weights (heaviest weight on the lowest band).
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

interface ArmWire { op: string; left: unknown; right: { number: number }; then: { number: number } }
interface AggWire { compute: { caseWhen: { arms: ArmWire[]; else: { number: number } } }; aggregate: string; alias: string }

/** Narrow an emitted spec to its aggregates (throws on a bad shape). */
function aggregatesOf(spec: unknown): AggWire[] {
  if (!spec || typeof spec !== "object" || !("aggregateJoins" in spec)) throw new Error("no aggregateJoins");
  const joins = spec.aggregateJoins;
  if (!Array.isArray(joins)) throw new Error("aggregateJoins not an array");
  const first = joins[0] as { aggregates?: unknown };
  if (!first || !Array.isArray(first.aggregates)) throw new Error("no aggregates");
  return first.aggregates as AggWire[];
}

function armSig(a: ArmWire): [string, number, number] {
  return [a.op, a.right.number, a.then.number];
}

/** Execute an emitted spec over a fabricated in-memory fixture; key rows by the group key. */
function runFixture(
  spec: unknown,
  schema: SchemaRow[],
  ddl: string[],
  groupKey: string,
): Array<Record<string, number | string>> {
  const compiled = compileOperation(spec as never, schema, { dialect: "sqlite" });
  const db = new DatabaseSync(":memory:");
  for (const stmt of ddl) db.exec(stmt);
  const q = toSqlite(compiled.sql.replace(/"main"\./g, ""));
  const rows = db.prepare(q.sql).all(...bindValues(q, [])) as Array<Record<string, number | string>>;
  db.close();
  void groupKey;
  return rows;
}

describe("band corpus — weight order is never assumed", () => {
  it("descending weights: heaviest weight on the lowest band", () => {
    // Shipment priority: lightest parcels score highest.
    const schema = [
      mkCol("parcel", "hub_id", "text", true),
      mkCol("hub", "hub_id", "text", true),
      mkCol("hub", "hub_name", "text"),
      mkCol("parcel", "weight_kg", "double precision"),
    ];
    const bands: BandArm[] = [
      { test: "below", value: "5", then: 10, words: "light" },
      { test: "below", value: "20", then: 3, words: "mid" },
      { test: "at_least", value: "20", then: 1, words: "heavy" },
    ];
    const measures: BandMeasureIn[] = [
      { words: "light parcels", field: "Ship_DB.new_read.weight_kg", counts: "light", bands },
      { words: "priority score", field: "Ship_DB.new_read.weight_kg", counts: null, bands },
    ];
    const spec = emitBandedSpec(schema, measures, [
      { field: "Ship_DB.new_read.hub_id", words: "hub" },
      { field: "Ship_DB.new_read.hub_name", words: "name" },
    ]);
    expect(spec).not.toBeNull();
    expect(bandSpecValid(spec as never, measures)).toBe(true);
    const aggs = aggregatesOf(spec);
    // Indicator for arm 0: one arm, then 1 on a first-match of the light band.
    expect(aggs[0]!.alias).toBe("band_light_parcels");
    expect(aggs[0]!.compute.caseWhen.arms.map(armSig)).toEqual([["lt", 5, 1]]);
    // Total: all three arms with the model's own descending weights.
    expect(aggs[1]!.alias).toBe("band_priority_score");
    expect(aggs[1]!.compute.caseWhen.arms.map(armSig)).toEqual([
      ["lt", 5, 10],
      ["lt", 20, 3],
      ["gte", 20, 1],
    ]);
    const rows = runFixture(spec, schema, [
      "CREATE TABLE parcel (hub_id TEXT, weight_kg REAL)",
      "CREATE TABLE hub (hub_id TEXT, hub_name TEXT)",
      "INSERT INTO parcel VALUES ('H',2),('H',4.99),('H',5),('H',19.9),('H',20),('H',99)",
      "INSERT INTO hub VALUES ('H','Harbor')",
    ], "hub_id");
    expect(rows).toHaveLength(1);
    // Light arm first-matches 2 and 4.99 only; the oracle agrees per row.
    expect(Number(rows[0]!.band_light_parcels)).toBe(2);
    const expected = [2, 4.99, 5, 19.9, 20, 99].reduce((s, v) => s + evalBandWeight(v, bands), 0);
    expect(expected).toBe(10 + 10 + 3 + 3 + 1 + 1);
    expect(Number(rows[0]!.band_priority_score)).toBe(expected);
  });

  it("ascending weights: lightest weight on the lowest band", () => {
    // Loan risk: larger exposures score higher.
    const schema = [
      mkCol("loan", "branch_id", "text", true),
      mkCol("branch", "branch_id", "text", true),
      mkCol("loan", "exposure", "numeric"),
    ];
    const bands: BandArm[] = [
      { test: "below", value: "1000", then: 1, words: "small" },
      { test: "below", value: "10000", then: 5, words: "medium" },
      { test: "at_least", value: "10000", then: 9, words: "large" },
    ];
    const measures: BandMeasureIn[] = [
      { words: "large exposures", field: "Loan_DB.new_read.exposure", counts: "large", bands },
      { words: "risk score", field: "Loan_DB.new_read.exposure", counts: null, bands },
    ];
    const spec = emitBandedSpec(schema, measures, [{ field: "branch_id", words: "branch" }]);
    expect(spec).not.toBeNull();
    expect(bandSpecValid(spec as never, measures)).toBe(true);
    const aggs = aggregatesOf(spec);
    // Indicator for arm 2: arms before the match yield 0, the match yields 1.
    expect(aggs[0]!.compute.caseWhen.arms.map(armSig)).toEqual([
      ["lt", 1000, 0],
      ["lt", 10000, 0],
      ["gte", 10000, 1],
    ]);
    expect(aggs[1]!.compute.caseWhen.arms.map(armSig)).toEqual([
      ["lt", 1000, 1],
      ["lt", 10000, 5],
      ["gte", 10000, 9],
    ]);
    const rows = runFixture(spec, schema, [
      "CREATE TABLE loan (branch_id TEXT, exposure REAL)",
      "CREATE TABLE branch (branch_id TEXT)",
      "INSERT INTO loan VALUES ('B',10),('B',999.99),('B',1000),('B',9999.99),('B',10000),('B',50000)",
      "INSERT INTO branch VALUES ('B')",
    ], "branch_id");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.band_large_exposures)).toBe(2);
    const expected = [10, 999.99, 1000, 9999.99, 10000, 50000].reduce((s, v) => s + evalBandWeight(v, bands), 0);
    expect(expected).toBe(1 + 1 + 5 + 5 + 9 + 9);
    expect(Number(rows[0]!.band_risk_score)).toBe(expected);
  });

  it("point band: an equals arm beside a catch-all", () => {
    // Quiz scoring: exactly 7 earns a bonus, everything else the base mark.
    const schema = [
      mkCol("attempt", "student_id", "text", true),
      mkCol("student", "student_id", "text", true),
      mkCol("attempt", "score", "integer"),
    ];
    const bands: BandArm[] = [
      { test: "equals", value: "7", then: 5, words: "lucky seven" },
      { test: "at_least", value: "0", then: 1, words: "other" },
    ];
    const measures: BandMeasureIn[] = [
      { words: "lucky sevens", field: "Quiz_DB.new_read.score", counts: "lucky seven", bands },
      { words: "marks", field: "Quiz_DB.new_read.score", counts: null, bands },
    ];
    const spec = emitBandedSpec(schema, measures, [{ field: "student_id", words: "student" }]);
    expect(spec).not.toBeNull();
    expect(bandSpecValid(spec as never, measures)).toBe(true);
    const aggs = aggregatesOf(spec);
    expect(aggs[0]!.compute.caseWhen.arms.map(armSig)).toEqual([["eq", 7, 1]]);
    expect(aggs[1]!.compute.caseWhen.arms.map(armSig)).toEqual([
      ["eq", 7, 5],
      ["gte", 0, 1],
    ]);
    const rows = runFixture(spec, schema, [
      "CREATE TABLE attempt (student_id TEXT, score REAL)",
      "CREATE TABLE student (student_id TEXT)",
      "INSERT INTO attempt VALUES ('S',7),('S',7),('S',6),('S',0),('S',-3)",
      "INSERT INTO student VALUES ('S')",
    ], "student_id");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.band_lucky_sevens)).toBe(2);
    const expected = [7, 7, 6, 0, -3].reduce((s, v) => s + evalBandWeight(v, bands), 0);
    expect(expected).toBe(5 + 5 + 1 + 1 + 0);
    expect(Number(rows[0]!.band_marks)).toBe(expected);
  });

  it("single-boundary pair: below vs at_least", () => {
    // Sensor flags: readings below the threshold need review, the rest block.
    const schema = [
      mkCol("reading", "site_id", "text", true),
      mkCol("site", "site_id", "text", true),
      mkCol("reading", "ppm", "double precision"),
    ];
    const bands: BandArm[] = [
      { test: "below", value: "500", then: 2, words: "review" },
      { test: "at_least", value: "500", then: 7, words: "block" },
    ];
    const measures: BandMeasureIn[] = [
      { words: "blocks", field: "Sensor_DB.new_read.ppm", counts: "block", bands },
      { words: "severity", field: "Sensor_DB.new_read.ppm", counts: null, bands },
    ];
    const spec = emitBandedSpec(schema, measures, [{ field: "site_id", words: "site" }]);
    expect(spec).not.toBeNull();
    expect(bandSpecValid(spec as never, measures)).toBe(true);
    const aggs = aggregatesOf(spec);
    expect(aggs[0]!.compute.caseWhen.arms.map(armSig)).toEqual([
      ["lt", 500, 0],
      ["gte", 500, 1],
    ]);
    expect(aggs[1]!.compute.caseWhen.arms.map(armSig)).toEqual([
      ["lt", 500, 2],
      ["gte", 500, 7],
    ]);
    const rows = runFixture(spec, schema, [
      "CREATE TABLE reading (site_id TEXT, ppm REAL)",
      "CREATE TABLE site (site_id TEXT)",
      "INSERT INTO reading VALUES ('W',499.9),('W',500),('W',500.1),('W',0)",
      "INSERT INTO site VALUES ('W')",
    ], "site_id");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.band_blocks)).toBe(2);
    const expected = [499.9, 500, 500.1, 0].reduce((s, v) => s + evalBandWeight(v, bands), 0);
    expect(expected).toBe(2 + 7 + 7 + 2);
    expect(Number(rows[0]!.band_severity)).toBe(expected);
  });

  it("three-band set with a zero-weight band", () => {
    // Game scoring: misses score nothing but the band is still stated.
    const schema = [
      mkCol("throw", "player_id", "text", true),
      mkCol("player", "player_id", "text", true),
      mkCol("throw", "distance_m", "double precision"),
    ];
    const bands: BandArm[] = [
      { test: "below", value: "10", then: 0, words: "miss" },
      { test: "below", value: "50", then: 2, words: "near" },
      { test: "at_least", value: "50", then: 5, words: "far" },
    ];
    const measures: BandMeasureIn[] = [
      { words: "near throws", field: "Game_DB.new_read.distance_m", counts: "near", bands },
      { words: "far throws", field: "Game_DB.new_read.distance_m", counts: "far", bands },
      { words: "points", field: "Game_DB.new_read.distance_m", counts: null, bands },
    ];
    const spec = emitBandedSpec(schema, measures, [{ field: "player_id", words: "player" }]);
    expect(spec).not.toBeNull();
    expect(bandSpecValid(spec as never, measures)).toBe(true);
    const aggs = aggregatesOf(spec);
    expect(aggs[0]!.compute.caseWhen.arms.map(armSig)).toEqual([
      ["lt", 10, 0],
      ["lt", 50, 1],
    ]);
    expect(aggs[1]!.compute.caseWhen.arms.map(armSig)).toEqual([
      ["lt", 10, 0],
      ["lt", 50, 0],
      ["gte", 50, 1],
    ]);
    expect(aggs[2]!.compute.caseWhen.arms.map(armSig)).toEqual([
      ["lt", 10, 0],
      ["lt", 50, 2],
      ["gte", 50, 5],
    ]);
    const rows = runFixture(spec, schema, [
      "CREATE TABLE throw (player_id TEXT, distance_m REAL)",
      "CREATE TABLE player (player_id TEXT)",
      "INSERT INTO throw VALUES ('P',0),('P',9.99),('P',10),('P',49.99),('P',50),('P',120)",
      "INSERT INTO player VALUES ('P')",
    ], "player_id");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.band_near_throws)).toBe(2);
    expect(Number(rows[0]!.band_far_throws)).toBe(2);
    const expected = [0, 9.99, 10, 49.99, 50, 120].reduce((s, v) => s + evalBandWeight(v, bands), 0);
    expect(expected).toBe(0 + 0 + 2 + 2 + 5 + 5);
    expect(Number(rows[0]!.band_points)).toBe(expected);
  });
});
