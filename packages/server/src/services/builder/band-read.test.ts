/**
 * Banded reads lower the model's own `band_count` arms — contiguous partition
 * shape: <4.75→0 (floor), <9.5→0.5, ≥9.5→1. Each measure states its band by
 * identity (`counts` is that band's `words`); empty `counts` weight-sums.
 */
import { describe, expect, it, afterEach } from "vitest";
import type { SchemaRow } from "../../repositories/schema.repo.js";
import { compileOperation } from "../db-operation.service.js";
import { toSqlite, bindValues } from "../sqlite-dialect.js";
import { DatabaseSync } from "../sqlite-driver.js";
import {
  bandEmitEnabled,
  bandSpecValid,
  bareField,
  dimensionOwnerFor,
  emitBandedSpec,
  indicatorCompute,
  resolveBandFieldOwner,
  weightCompute,
  evalBandWeight,
  type BandMeasureIn,
} from "./band-read.js";
import type { BandArm } from "./plan.js";

const col = (entityName: string, columnName: string, columnType: string, pk = false): SchemaRow => ({
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

const ROWS = [
  col("attendance_day", "emp_id", "text", true),
  col("attendance_day", "work_date", "date"),
  col("attendance_day", "hours_worked", "double precision"),
  col("attendance_day", "day_model", "text"),
  col("employee", "emp_id", "text", true),
  col("employee", "emp_name", "text"),
];

const ARMS: BandArm[] = [
  { test: "below", value: "4.75", then: 0, words: "band 0" },
  { test: "below", value: "9.5", then: 0.5, words: "band 1" },
  { test: "at_least", value: "9.5", then: 1, words: "band 2" },
];

const MEASURES: BandMeasureIn[] = [
  { words: "half day absences", field: "Attendance_DB.new_read.hours_worked", counts: "band 1", bands: ARMS },
  { words: "full day absences", field: "Attendance_DB.new_read.hours_worked", counts: "band 2", bands: ARMS },
  { words: "total absences", field: "Attendance_DB.new_read.hours_worked", counts: null, bands: ARMS },
];

afterEach(() => {
  delete process.env.BUILDER_INTENT_IR;
});

describe("bandEmitEnabled", () => {
  it("on by default (Intent IR ship default)", () => {
    expect(bandEmitEnabled()).toBe(true);
  });
  it("off with BUILDER_INTENT_IR=0", () => {
    process.env.BUILDER_INTENT_IR = "0";
    expect(bandEmitEnabled()).toBe(false);
  });
  it("on with BUILDER_INTENT_IR=1", () => {
    process.env.BUILDER_INTENT_IR = "1";
    expect(bandEmitEnabled()).toBe(true);
  });
});

describe("bareField", () => {
  it("takes the last path segment", () => {
    expect(bareField("Attendance_DB.new_read.hours_worked")).toBe("hours_worked");
  });
});

describe("weight / indicator computes", () => {
  it("weight: 9.5→1, 4.75→0.5, below→0; left coalesces NULL to 0", () => {
    const w = weightCompute("hours_worked", ARMS);
    expect(w.caseWhen.arms.map((a) => a.then.number)).toEqual([0, 0.5, 1]);
    expect(w.caseWhen.arms[0]!.left).toEqual({ coalesce: [{ column: "hours_worked" }, { number: 0 }] });
  });
  it("half indicator is 1 only on the half arm under first-match", () => {
    const ind = indicatorCompute("hours_worked", ARMS, 0.5)!;
    expect(ind.caseWhen.arms.map((a) => a.then.number)).toEqual([0, 1]);
  });
  it("evalBandWeight treats null/undefined as 0 (floor band)", () => {
    expect(evalBandWeight(null, ARMS)).toBe(0);
    expect(evalBandWeight(undefined, ARMS)).toBe(0);
    expect(evalBandWeight(4.75, ARMS)).toBe(0.5);
    expect(evalBandWeight(9.5, ARMS)).toBe(1);
  });
});

describe("dimensionOwnerFor", () => {
  it("prefers a non-fact PK owner of the group key", () => {
    expect(dimensionOwnerFor(ROWS, "emp_id", "attendance_day")?.table).toBe("employee");
  });
});

describe("emitBandedSpec", () => {
  it("compiles and scores the three-band oracle on SQLite", () => {
    const spec = emitBandedSpec(ROWS, MEASURES, [
      { field: "Attendance_DB.new_read.emp_id", words: "employee" },
      { field: "Attendance_DB.new_read.emp_name", words: "name" },
    ]);
    expect(spec).not.toBeNull();
    // Dimension base — not the fact table (that fans out one row per day).
    expect((spec as { base: { table: string } }).base.table).toBe("employee");
    expect((spec as { distinct?: boolean }).distinct).toBeUndefined();
    expect(bandSpecValid(spec as never, MEASURES)).toBe(true);
    const compiled = compileOperation(spec as never, ROWS, { dialect: "sqlite" });
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE attendance_day (emp_id TEXT, hours_worked REAL, day_model TEXT)");
    db.exec("CREATE TABLE employee (emp_id TEXT, emp_name TEXT)");
    db.exec("INSERT INTO attendance_day VALUES ('A',9.5,NULL),('A',4.75,NULL),('A',4.74,NULL),('A',0,NULL)");
    db.exec("INSERT INTO attendance_day VALUES ('B',9.5,NULL),('B',9.5,NULL)");
    db.exec("INSERT INTO employee VALUES ('A','Ada'),('B','Bob')");
    const stmt = toSqlite(compiled.sql.replace(/"main"\./g, ""));
    const rows = db.prepare(stmt.sql).all(...bindValues(stmt, [])) as Array<Record<string, number | string>>;
    db.close();
    expect(rows).toHaveLength(2); // one row per employee, not per day
    const by = Object.fromEntries(rows.map((r) => [String(r.emp_id), r]));
    // Indicators count their own arm: A has one half-day (4.75), one full-day
    // (9.5); 4.74 and 0 fall in the floor band. Total weight-sums.
    expect(Number(by.A!.band_half_day_absences)).toBe(1);
    expect(Number(by.A!.band_full_day_absences)).toBe(1);
    expect(Number(by.A!.band_total_absences)).toBe(1.5);
    expect(Number(by.B!.band_half_day_absences)).toBe(0);
    expect(Number(by.B!.band_full_day_absences)).toBe(2);
    expect(Number(by.B!.band_total_absences)).toBe(2);
  });
  it("CONTROL: returns null when the banded column is missing", () => {
    expect(emitBandedSpec(ROWS.filter((r) => r.columnName !== "hours_worked"), MEASURES, [])).toBeNull();
  });

  it("a words-slug field (planToSpec's last resort) still emits via the type fallback", () => {
    // A blank/`new_read` field — the model could not name the column — keeps
    // the type-based fallback (prefer a numeric column). An explicit slug of
    // the measure's words names no column and refuses (next case).
    const blankField: BandMeasureIn[] = MEASURES.map((m) => ({ ...m, field: "Attendance_DB.new_read" }));
    const spec = emitBandedSpec(ROWS, blankField, [{ field: "emp_id", words: "employee" }]);
    expect(spec).not.toBeNull();
    expect(bandSpecValid(spec as never, blankField)).toBe(true);
  });

  it("an explicit field naming no column refuses (no silent other-column emit)", () => {
    const oddField: BandMeasureIn[] = MEASURES.map((m) => ({
      ...m,
      field: "Attendance_DB.new_read.half_day_absences",
    }));
    expect(emitBandedSpec(ROWS, oddField, [{ field: "emp_id", words: "employee" }])).toBeNull();
  });

  it("skips unresolvable group labels instead of aborting emit", () => {
    const spec = emitBandedSpec(ROWS, MEASURES, [
      { field: "emp_id", words: "employee" },
      { field: "Attendance_DB.new_read.not_a_real_column", words: "mystery" },
    ]);
    expect(spec).not.toBeNull();
  });

  it("P8: period dateColumn emits period_start/period_end filters on the aggregate join", () => {
    const spec = emitBandedSpec(ROWS, MEASURES, [{ field: "emp_id", words: "employee" }], { dateColumn: "work_date" });
    expect(spec).not.toBeNull();
    const aj = (spec as { aggregateJoins: Array<{ filters: Array<{ column: string; param: string }> }> }).aggregateJoins[0]!;
    expect(aj.filters).toEqual([
      { column: "work_date", op: "gte", param: "period_start" },
      { column: "work_date", op: "lt", param: "period_end" },
    ]);
    const compiled = compileOperation(spec as never, ROWS);
    expect(compiled.paramOrder).toEqual(expect.arrayContaining(["period_start", "period_end"]));
  });

  it("CONTROL: no dateColumn → no period params", () => {
    const spec = emitBandedSpec(ROWS, MEASURES, [{ field: "emp_id", words: "employee" }]);
    const compiled = compileOperation(spec as never, ROWS);
    expect(compiled.paramOrder).not.toContain("period_start");
  });

  it("CONTROL: three-measure emit is structurally valid", () => {
    const spec = emitBandedSpec(ROWS, MEASURES, [
      { field: "emp_id", words: "employee" },
      { field: "emp_name", words: "name" },
    ]);
    expect(bandSpecValid(spec as never, MEASURES)).toBe(true);
  });

  it("counts naming no band is refused at emit; the refusal names the selector", () => {
    const badName: BandMeasureIn[] = [{
      words: "offband tally",
      field: "hours_worked",
      counts: "no such band",
      bands: ARMS,
    }];
    expect(emitBandedSpec(ROWS, badName, [{ field: "emp_id", words: "employee" }])).toBeNull();
    // bandSpecValid states the same reason structurally (without an emit).
    const verdict = bandSpecValid({ aggregateJoins: [{ aggregates: [{}] }] }, badName);
    expect(typeof verdict).toBe("string");
    expect(verdict).toMatch(/not one of its bands/);

    // The selector is identity: counting "band 0" (the floor) tallies rows
    // first-matching the floor arm — not the rows the oracle weights 1 / 0.5.
    const wrong: BandMeasureIn[] = [{
      words: "misc tally",
      field: "hours_worked",
      counts: "band 0",
      bands: ARMS,
    }];
    const specWrong = emitBandedSpec(ROWS, wrong, [{ field: "emp_id", words: "employee" }]);
    expect(specWrong).not.toBeNull();
    expect(bandSpecValid(specWrong as never, wrong)).toBe(true);
    const compiled = compileOperation(specWrong as never, ROWS, { dialect: "sqlite" });
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE attendance_day (emp_id TEXT, hours_worked REAL, day_model TEXT)");
    db.exec("CREATE TABLE employee (emp_id TEXT)");
    db.exec("INSERT INTO employee VALUES ('E')");
    db.exec("INSERT INTO attendance_day VALUES ('E',9.5,NULL),('E',4.75,NULL)");
    const stmt = toSqlite(compiled.sql.replace(/"main"\./g, ""));
    const row = db.prepare(stmt.sql).get(...bindValues(stmt, [])) as Record<string, number>;
    db.close();
    // Neither row first-matches the floor arm (9.5→arm 2, 4.75→arm 1): 0.
    expect(Number(row.band_misc_tally)).toBe(0);
    // The independent oracle weights them 1 + 0.5 — the column disagrees.
    expect(evalBandWeight(9.5, ARMS) + evalBandWeight(4.75, ARMS)).toBe(1.5);
  });

  it("T15 oracle: fixed hours → first-match weights (9.5→1, 4.75→0.5, 4.74→0)", () => {
    expect(evalBandWeight(9.5, ARMS)).toBe(1);
    expect(evalBandWeight(4.75, ARMS)).toBe(0.5);
    expect(evalBandWeight(4.74, ARMS)).toBe(0);
    expect(evalBandWeight(0, ARMS)).toBe(0);
    expect([9.5, 4.75, 4.74, 0].reduce((s, h) => s + evalBandWeight(h, ARMS), 0)).toBe(1.5);
  });

  it("one result row per group key even when the fact table has many days", () => {
    const spec = emitBandedSpec(ROWS, MEASURES, [{ field: "emp_id", words: "employee" }]);
    const compiled = compileOperation(spec as never, ROWS, { dialect: "sqlite" });
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE attendance_day (emp_id TEXT, hours_worked REAL, day_model TEXT)");
    db.exec("CREATE TABLE employee (emp_id TEXT, emp_name TEXT)");
    db.exec("INSERT INTO employee VALUES ('X','X')");
    for (let i = 0; i < 10; i++) db.exec(`INSERT INTO attendance_day VALUES ('X',9.5,NULL)`);
    const stmt = toSqlite(compiled.sql.replace(/"main"\./g, ""));
    const out = db.prepare(stmt.sql).all(...bindValues(stmt, [])) as unknown[];
    db.close();
    expect(out).toHaveLength(1);
  });

  it("NULL hours coalesce to the floor band (weight 0, still counted as rows)", () => {
    const totalOnly: BandMeasureIn[] = [{
      words: "total absences",
      field: "hours_worked",
      counts: null,
      bands: ARMS,
    }];
    const spec = emitBandedSpec(ROWS, totalOnly, [{ field: "emp_id", words: "employee" }]);
    expect(spec).not.toBeNull();
    const filters = (spec as { aggregateJoins: Array<{ filters: unknown[] }> }).aggregateJoins[0]!.filters;
    expect(filters).toEqual([]);
    const compiled = compileOperation(spec as never, ROWS, { dialect: "sqlite" });
    expect(compiled.sql).toMatch(/COALESCE/i);
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE attendance_day (emp_id TEXT, hours_worked REAL, day_model TEXT)");
    db.exec("CREATE TABLE employee (emp_id TEXT)");
    db.exec("INSERT INTO employee VALUES ('E')");
    // 5 NULLs (floor→0) + 1 full (9.5→1) → total 1
    for (let i = 0; i < 5; i++) db.exec(`INSERT INTO attendance_day VALUES ('E',NULL,'General')`);
    db.exec(`INSERT INTO attendance_day VALUES ('E',9.5,'General')`);
    const stmt = toSqlite(compiled.sql.replace(/"main"\./g, ""));
    const row = db.prepare(stmt.sql).get(...bindValues(stmt, [])) as Record<string, number>;
    db.close();
    expect(Number(row.band_total_absences)).toBe(1);
  });

  it("no dimension table → distinct:true on the fact-as-base emit", () => {
    const factOnly = ROWS.filter((r) => r.entityName === "attendance_day");
    const spec = emitBandedSpec(factOnly, MEASURES, [{ field: "emp_id", words: "employee" }]);
    expect(spec).not.toBeNull();
    expect((spec as { base: { table: string } }).base.table).toBe("attendance_day");
    expect((spec as { distinct?: boolean }).distinct).toBe(true);
  });
});
