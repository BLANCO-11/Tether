import { describe, expect, it } from "vitest";
import { bandArmsConsistent, type BandArm } from "./plan.js";
import { editShapeOf, type EditDecision } from "./chat-edit.js";
import type { CanvasAction } from "@foundry/flow-edit";
import { emitBandedSpec, evalBandWeight, type BandMeasureIn } from "./band-read.js";
import type { SchemaRow } from "../../repositories/schema.repo.js";

const act = (): CanvasAction => ({ id: "a", label: "reshape", where: { at: "flow" } });
const col = (entityName: string, columnName: string, columnType: string, pk = false): SchemaRow => ({
  id: `${entityName}.${columnName}`, datasourceId: "ds", entityType: "table", entitySchema: "main",
  entityName, columnName, columnType, isPrimaryKey: pk, isForeignKey: false, foreignKeyReference: null,
  nullable: true, characterMaximumLength: null, semanticTag: null, valueDomain: null,
  rowCountEstimate: null, nullPercentage: null, extractedAt: new Date("2026-10-07T00:00:00Z"),
});
const ROWS = [
  col("attendance_day", "emp_id", "text", true),
  col("attendance_day", "hours_worked", "double precision"),
  col("attendance_day", "day_model", "text"),
  col("employee", "emp_id", "text", true),
  col("employee", "emp_name", "text"),
];

// Simulated conversation d5a48977 turns 1-5 (2026-10-08): the user's exact
// words replayed offline through capture -> emit -> edit-classify. Turn 3's
// crash (view.model null) is covered by the R2 presence-check contract:
// drafted-confirm with no incomplete returns asks-with-payload, never derefs.
//
// Step 8 (builder-IR): band arms are model-supplied, never mined from the
// goal by code — so the arms below are stated literally (the contiguous
// partition the conversation settled on), and the assertions guard the kept
// properties: partition contiguity via evalBandWeight, per-arm indicators
// via emitBandedSpec, and typed shape decisions via editShapeOf.
describe("SIM conversation d5a48977 (offline replay)", () => {
  // Model-supplied arms for the d5a48977 goal: full-day below 4.75 counts 1,
  // half-day below 9.5 counts 0.5, present at/above 9.5 counts 0.
  // First-match order, contiguous: every hour value fires exactly one arm.
  const ARMS: BandArm[] = [
    { test: "below", value: "4.75", then: 1, words: "full day absence" },
    { test: "below", value: "9.5", then: 0.5, words: "half day absence" },
    { test: "at_least", value: "9.5", then: 0, words: "present" },
  ];

  it("TURN1: stated arms are live and contiguous, weights not day-counts", () => {
    expect(bandArmsConsistent(ARMS)).toBe(true);
    // Contiguous single-fire across the whole line.
    expect(evalBandWeight(0, ARMS)).toBe(1);
    expect(evalBandWeight(4.74, ARMS)).toBe(1);
    expect(evalBandWeight(4.75, ARMS)).toBe(0.5);
    expect(evalBandWeight(7, ARMS)).toBe(0.5);
    expect(evalBandWeight(9.49, ARMS)).toBe(0.5);
    expect(evalBandWeight(9.5, ARMS)).toBe(0);
    expect(evalBandWeight(12, ARMS)).toBe(0);
  });

  it("TURN1: emit gives half/full their own indicators, not weight-sums", () => {
    // Model-supplied measures: each names its band by identity (`counts` is
    // that band's `words`).
    const measures: BandMeasureIn[] = [
      { words: "half day absences", field: "hours_worked", bands: ARMS, counts: "half day absence" },
      { words: "full day absences", field: "hours_worked", bands: ARMS, counts: "full day absence" },
    ];
    const spec = emitBandedSpec(ROWS, measures, [{ field: "emp_id", words: "employee" }]);
    expect(spec).not.toBeNull();
    const aggs = (spec as { aggregateJoins: Array<{ aggregates: Array<{ alias: string; compute: { caseWhen: { arms: Array<{ then: { number: number }; op: string; right: { number: number } }> } } }> }> }).aggregateJoins[0]!.aggregates;
    const half = aggs.find((a) => /half/.test(a.alias))!;
    const full = aggs.find((a) => /full/.test(a.alias) && !/half/.test(a.alias))!;
    // Half counts its own arm only: <4.75 -> 0 guard, <9.5 -> 1 (else 0 covers present).
    expect(half.compute.caseWhen.arms.map((a) => a.then.number)).toEqual([0, 1]);
    // Full counts its own arm only: <4.75 -> 1 (else 0 covers the rest).
    expect(full.compute.caseWhen.arms.map((a) => a.then.number)).toEqual([1]);
    expect(full.compute.caseWhen.arms[0]).toMatchObject({ op: "lt", right: { number: 4.75 } });
  });

  it("TURNS2-4: column-shape edit names its columns (delta-check input)", () => {
    const d: EditDecision = { status: "apply", action: act(), shapeColumns: ["emp_id", "emp_name", "half day absence", "full day absence", "total absence"] };
    const cols = editShapeOf(d);
    expect(cols).not.toBeNull();
    expect(cols!.join(" ")).toMatch(/emp_name/);
    expect(cols!.join(" ")).toMatch(/total/);
  });

  it("TURN5: email-add is not a shape edit (routes to rebuild, never no-op applied)", () => {
    const d: EditDecision = { status: "apply", action: act() };
    expect(editShapeOf(d)).toBeNull();
  });
});
