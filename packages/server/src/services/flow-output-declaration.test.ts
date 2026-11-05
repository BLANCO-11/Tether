/**
 * `checkFlowOutput` — a declared result must exist and must produce something.
 *
 * ⚠ **Two refusals, because there are two ways to declare a result that hands a
 * caller nothing on a run that SUCCEEDED.** A `stepId` naming no step is the
 * obvious one. The other is not obvious at all: `approval` produces no value
 * (gate 3 is a pause) and `branch` schedules other tasks rather than emitting
 * one, so naming either yields `null` for ever with every task green — the
 * "green run, wrong answer" class, arriving from a field that reads harmless.
 */
import { describe, expect, it } from "vitest";
import { checkFlowOutput } from "./flow-validator.service.js";
import { OUTPUT_STEP_KINDS } from "./flow-compiler.service.js";

const model = (steps: Array<{ id: string; kind: string }>, output?: Record<string, unknown>) =>
  ({ id: "f", steps, ...(output ? { output } : {}) }) as never;

describe("checkFlowOutput", () => {
  it("says nothing when no result is declared — every stored flow has none", () => {
    expect(checkFlowOutput(model([{ id: "a", kind: "query" }]))).toEqual([]);
  });

  it("accepts every kind that genuinely produces a value", () => {
    for (const kind of OUTPUT_STEP_KINDS) {
      expect(
        checkFlowOutput(model([{ id: "a", kind }], { stepId: "a" })),
        `kind ${kind} should be permitted`,
      ).toEqual([]);
    }
    // Control: the set is not empty, so the loop above asserts something.
    expect(OUTPUT_STEP_KINDS.size).toBeGreaterThan(3);
  });

  it("refuses a step that does not exist, and names the ones that do", () => {
    const f = checkFlowOutput(
      model([{ id: "a", kind: "query" }, { id: "b", kind: "transform" }], { stepId: "typo" }),
    );
    expect(f).toHaveLength(1);
    expect(f[0].rule).toBe("unknown_output_step");
    expect(f[0].blocking).toBe(true);
    // The list IS the finding — a redraft without it is a second guess.
    expect(f[0].facts?.steps).toEqual(["a", "b"]);
    expect(f[0].message).toContain("a, b");
  });

  for (const kind of ["approval", "branch"]) {
    it(`refuses a ${kind} step, which produces nothing`, () => {
      const f = checkFlowOutput(model([{ id: "g", kind }], { stepId: "g" }));
      expect(f).toHaveLength(1);
      expect(f[0].rule).toBe("output_step_produces_nothing");
      expect(f[0].blocking).toBe(true);
      expect(f[0].stepId).toBe("g");
      // It must say the run would SUCCEED — that is the part nobody guesses.
      expect(f[0].message).toMatch(/succeeded/i);
      expect(f[0].facts?.permitted).toEqual([...OUTPUT_STEP_KINDS]);
    });
  }

  it("is reached through assertValid, not only callable on its own", () => {
    // I-120's shape: a correct check nothing calls. Read off disk, with a
    // control that the scan can find anything at all.
    const src = require("node:fs").readFileSync(
      new URL("./flow-validator.service.ts", import.meta.url),
      "utf8",
    ) as string;
    expect(src).toContain("...checkFlowOutput(model),");
    expect(src).toContain("...checkFlowRefs(model, availableRefs),");
  });

  it("keeps `output` through flowModelSchema — an unlisted key is STRIPPED", async () => {
    // The same trap `webhook`/`api` carry a comment about: zod drops unknown
    // keys, so a declaration missing from the schema never reaches the revision
    // and the feature does nothing with no error anywhere.
    const { flowModelSchema } = await import("./flow.service.js");
    const parsed = flowModelSchema.parse({
      id: "f",
      steps: [{ id: "a", kind: "transform", expr: "{{ 1 }}" }],
      output: { stepId: "a", description: "the answer" },
    });
    expect(parsed.output).toEqual({ stepId: "a", description: "the answer", rows: [] });
  });
});
