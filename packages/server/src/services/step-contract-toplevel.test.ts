/**
 * r12 R10: `result: object` with nested keys `count` produced a fragment that
 * returned `{"count": …}`. A nested block must not read as the top level.
 */
import { describe, expect, it } from "vitest";
import { buildFragmentPrompt, type StepContract } from "./step-contract.service.js";

const base: StepContract = {
  stepId: "count_below",
  purpose: "count the rows below threshold",
  input: [{ name: "rows", type: "array" }],
  output: [{ name: "result", type: "object" }],
} as StepContract;

describe("fragment prompt — top-level output keys", () => {
  it("names the top level when an output field is nested", () => {
    const p = buildFragmentPrompt({ ...base, output: [{ name: "result", type: "object", fields: [{ name: "count", type: "number" }] }] } as StepContract);
    expect(p).toContain("TOP-LEVEL keys are exactly: result");
  });
  it("CONTROL: a flat output adds nothing", () => {
    expect(buildFragmentPrompt(base)).not.toContain("TOP-LEVEL");
  });
});
