/**
 * Live-failure regression (2026-10-08, reported turn): a banded goal whose
 * model-stated field is a bare/table column — not a `new_read`-prefixed ref —
 * must still emit. `planToSpec` used to rewrite such a field to a slug of the
 * measure's words (`…new_read.half_days`), which resolves to no column and
 * made `emitBandedSpec` return null ("could not be built from the schema").
 * The model's field now resolves against the schema first; the words-slug is
 * the last resort only. `counts` selectors ride along to the emit.
 */
import { describe, expect, it } from "vitest";
import { clauses, planToSpec, type Plan } from "./plan.js";
import { emitBandedSpec, bandSpecValid, type BandMeasureIn } from "./band-read.js";
import type { BuilderCatalogue } from "./goal-spec.js";
import type { SchemaRow } from "../../repositories/schema.repo.js";

const col = (entityName: string, columnName: string, columnType: string, pk = false): SchemaRow => ({
  id: `${entityName}.${columnName}`, datasourceId: "ds", entityType: "table", entitySchema: "main",
  entityName, columnName, columnType, isPrimaryKey: pk, isForeignKey: false, foreignKeyReference: null,
  nullable: true, characterMaximumLength: null, semanticTag: null, valueDomain: null,
  rowCountEstimate: null, nullPercentage: null, extractedAt: new Date("2026-10-07T00:00:00Z"),
});
// Live Attendance_DB shape (columns only; values never materialise here).
const ROWS = [
  col("attendance_day", "emp_id", "text", true),
  col("attendance_day", "hours_worked", "double precision"),
  col("attendance_day", "day_model", "text"),
  col("employee", "emp_id", "text", true),
  col("employee", "emp_name", "text"),
];

const CAT: BuilderCatalogue = { items: [
  { ref: "Attendance_DB.attendance_day", kind: "reader", about: "daily rows", fields: [
    { name: "emp_id", ty: "text" }, { name: "hours_worked", ty: "double precision" }, { name: "day_model", ty: "text" },
  ] },
  { ref: "Attendance_DB.employee", kind: "reader", about: "people", fields: [
    { name: "emp_id", ty: "text" }, { name: "emp_name", ty: "text" },
  ] },
  { ref: "Attendance_DB.new_read", kind: "reader", about: "a new read" },
] };

const ARMS = [
  { test: "below", value: "4.75", then: 1, words: "full day absence" },
  { test: "below", value: "9.5", then: 0.5, words: "half day absence" },
  { test: "at_least", value: "9.5", then: 0, words: "present" },
] as BandMeasureIn["bands"];

// The model's plan for the reported goal: band fields as table columns
// (the only form the strict field enum offers — `new_read` has no fields
// yet), `counts` naming each band, rows used one by one (for-each over them).
const plan = (): Plan => ({
  sources: [{ ref: "Attendance_DB.new_read", clauses: ["C1"] }],
  each: { over: 0, clauses: ["C1"] },
  rows: [],
  schedule: null,
  conditions: [],
  actions: [],
  values: [],
  missing: "",
  joining: [],
  summary: {
    quote: "", clauses: ["C1"], over: 0,
    by: [
      { field: "Attendance_DB.employee.emp_id", words: "emp id" },
      { field: "Attendance_DB.employee.emp_name", words: "name" },
    ],
    measures: [
      { fn: "band_count", field: "Attendance_DB.attendance_day.hours_worked", words: "half days", counts: "half day absence", bands: ARMS },
      { fn: "band_count", field: "Attendance_DB.attendance_day.hours_worked", words: "full days", counts: "full day absence", bands: ARMS },
      { fn: "band_count", field: "Attendance_DB.attendance_day.hours_worked", words: "total absences", counts: null, bands: ARMS },
    ],
    sort: null,
    limit: "",
  },
});

describe("live regression: bare/table band field still emits", () => {
  it("planToSpec keeps the model's schema column (no words-slug rewrite)", () => {
    const { spec } = planToSpec(plan(), clauses("x"), CAT, "x");
    for (const m of spec.summary?.measures ?? []) {
      expect(m.field).toBe("Attendance_DB.new_read.hours_worked");
    }
  });

  it("emit lowers by identity: per-band indicators + weight-sum total", () => {
    const { spec } = planToSpec(plan(), clauses("x"), CAT, "x");
    const measures: BandMeasureIn[] = (spec.summary?.measures ?? []).flatMap((m) =>
      (m.fn as string) === "band_count"
        ? [{ words: m.words, field: m.field, bands: (m.bands ?? []) as BandMeasureIn["bands"], ...(m.counts != null ? { counts: m.counts } : {}) }]
        : [],
    );
    const emitted = emitBandedSpec(ROWS, measures, [
      { field: "Attendance_DB.employee.emp_id", words: "emp id" },
      { field: "Attendance_DB.employee.emp_name", words: "name" },
    ]);
    expect(emitted).not.toBeNull();
    expect(bandSpecValid(emitted as never, measures)).toBe(true);
    const aggs = emitted!.aggregateJoins[0]!.aggregates;
    expect(aggs).toHaveLength(3);
    // half (arm 1): [0, 1, ELSE 0]; full (arm 0): [1, ELSE 0]; total: [1, 0.5, 0, ELSE 0].
    expect(aggs[0]!.compute.caseWhen.arms.map((a: { then: { number?: number } }) => a.then.number)).toEqual([0, 1]);
    expect(aggs[1]!.compute.caseWhen.arms.map((a: { then: { number?: number } }) => a.then.number)).toEqual([1]);
    expect(aggs[2]!.compute.caseWhen.arms.map((a: { then: { number?: number } }) => a.then.number)).toEqual([1, 0.5, 0]);
  });

  it("CONTROL: an unresolvable field still refuses (no silent words-slug column)", () => {
    const p = plan();
    p.summary!.measures = [{ fn: "band_count", field: "Attendance_DB.attendance_day.no_such_col", words: "half days", counts: "half day absence", bands: ARMS }];
    const { spec } = planToSpec(p, clauses("x"), CAT, "x");
    const measures: BandMeasureIn[] = (spec.summary?.measures ?? []).flatMap((m) =>
      (m.fn as string) === "band_count"
        ? [{ words: m.words, field: m.field, bands: (m.bands ?? []) as BandMeasureIn["bands"], ...(m.counts != null ? { counts: m.counts } : {}) }]
        : [],
    );
    // Schema has no such column: emit must refuse, never invent one.
    expect(emitBandedSpec(ROWS, measures, [{ field: "Attendance_DB.employee.emp_id", words: "emp id" }])).toBeNull();
  });
  it("every emit refusal names its structural reason (no generic null)", () => {
    const noBands: BandMeasureIn[] = [{ words: "x", field: "hours_worked", bands: [] }];
    const why1: { reason?: string } = {};
    expect(emitBandedSpec(ROWS, noBands, [], { why: why1 })).toBeNull();
    expect(why1.reason).toMatch(/no banded measure states bands/);
    const badField: BandMeasureIn[] = [{ words: "x", field: "Attendance_DB.new_read.nope", bands: ARMS, counts: null }];
    const why2: { reason?: string } = {};
    expect(emitBandedSpec(ROWS, badField, [{ field: "emp_id", words: "e" }], { why: why2 })).toBeNull();
    expect(why2.reason).toMatch(/matches no column/);
    const badCounts: BandMeasureIn[] = [{ words: "x", field: "hours_worked", bands: ARMS, counts: "ghost" }];
    const why3: { reason?: string } = {};
    expect(emitBandedSpec(ROWS, badCounts, [{ field: "emp_id", words: "e" }], { why: why3 })).toBeNull();
    expect(why3.reason).toMatch(/not one of its bands/);
    const noGroup: BandMeasureIn[] = [{ words: "x", field: "hours_worked", bands: ARMS, counts: null }];
    const noPkRows = ROWS.map((r) => ({ ...r, isPrimaryKey: false }));
    const why4: { reason?: string } = {};
    expect(emitBandedSpec(noPkRows, noGroup, [{ field: "Attendance_DB.new_read.mystery", words: "m" }], { why: why4 })).toBeNull();
    expect(why4.reason).toMatch(/none of the groupings resolves/);
  });
});
