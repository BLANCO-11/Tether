/**
 * Spec-grounded step answers (2026-10-08): "what does read_1 do" / "what does the query return" is answered from the
 * STORED step's own form — never the "reads a read" template. Synthetic specs only; no domain fixtures.
 */
import { describe, expect, it } from "vitest";
import { answerStepAbout, resolveStepRef, stepFacts } from "./chat-answers.js";

// A synthetic two-band measure over a fake column — the shape `emitBandedSpec` emits, hand-built.
const columnOf = (name: string) => ({ coalesce: [{ column: "widget_size" }, { number: 0 }] });
const STEP = {
  id: "read_1",
  kind: "datasource",
  ref: "store.query.sizes",
  datasourceRef: "store",
  sqlSpec: {
    base: { table: "widget_batch" },
    columns: [
      { column: "owner_id", alias: "owner_id" },
      { column: "band_minor_parcels", alias: "band_minor_parcels" },
      { column: "band_priority_score", alias: "band_priority_score" },
    ],
    aggregateJoins: [{
      table: "widget_batch",
      groupBy: "owner_id",
      onLeft: "owner_id",
      kind: "left",
      aggregates: [
        {
          alias: "band_minor_parcels",
          aggregate: "sum",
          compute: { caseWhen: { arms: [{ op: "lt", left: columnOf("widget_size"), right: { number: 5 }, then: { number: 1 } }], else: { number: 0 } } },
        },
        {
          alias: "band_priority_score",
          aggregate: "sum",
          compute: {
            caseWhen: {
              arms: [
                { op: "lt", left: columnOf("widget_size"), right: { number: 5 }, then: { number: 10 } },
                { op: "lt", left: columnOf("widget_size"), right: { number: 20 }, then: { number: 3 } },
                { op: "gte", left: columnOf("widget_size"), right: { number: 20 }, then: { number: 1 } },
              ],
              else: { number: 0 },
            },
          },
        },
      ],
      filters: [{ column: "discarded", op: "eq", value: 0 }],
    }],
    filters: [],
  },
};
const SUMMARY = {
  measures: [
    { words: "minor parcels", counts: "minor", bands: [{ test: "below", value: "5", then: 1, words: "minor" }] },
    {
      words: "priority score",
      counts: null,
      bands: [
        { test: "below", value: "5", then: 10, words: "minor" },
        { test: "below", value: "20", then: 3, words: "major" },
        { test: "at_least", value: "20", then: 1, words: "bulk" },
      ],
    },
  ],
};

describe("spec-grounded step answers", () => {
  it("what does read_1 do names each output with its edges from the stored spec", () => {
    const lines = answerStepAbout("what does read_1 do", [STEP as never], SUMMARY as never);
    expect(lines).not.toBeNull();
    const text = lines!.join("\n");
    expect(text).toContain("read_1 reads widget_batch");
    expect(text).toContain("band_minor_parcels");
    expect(text).toContain("< 5 → 1");
    expect(text).toContain("band_priority_score");
    expect(text).toContain("< 20 → 3");
    expect(text).toContain("leaves out rows where discarded = 0");
    expect(text).toContain("One row per owner_id");
    expect(text).not.toMatch(/reads a read|a read written for/i);
  });
  it("what does the query return resolves the query step without an id", () => {
    const lines = answerStepAbout("what does the query return?", [STEP as never], SUMMARY as never);
    expect(lines).not.toBeNull();
    expect(lines!.join("\n")).toContain("read_1 reads widget_batch");
  });
  it("unknown step falls back to null — the caller keeps the summary path", () => {
    expect(answerStepAbout("what does read_9 do", [STEP as never], SUMMARY as never)).toBeNull();
    expect(resolveStepRef("what does read_9 do", [{ id: "read_1" }])).toBeNull();
    expect(stepFacts("read_1", { id: "read_1" } as never, SUMMARY as never)).toBeNull();
  });
});
