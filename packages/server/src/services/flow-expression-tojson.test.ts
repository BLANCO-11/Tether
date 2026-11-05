/**
 * `toJson` is on D-22's allowlist because it was RUN (compiled-builder 2d, input-splice-probe): it is how a combinator
 * reads a flow input without a template inside jq. Admitting it must not admit anything else.
 */
import { describe, expect, it } from "vitest";
import { validateGeneratedExpr } from "./flow-expression.service.js";

describe("D-22 and the input splice", () => {
  it("accepts a transform that splices a flow input with toJson", () => {
    expect(validateGeneratedExpr(`{{ json(outputs.read.body).results[0].data | jq('map(select(.rate < ' ~ (inputs.threshold | toJson) ~ '))') | first }}`, "t")).toEqual([]);
  });
  it("still refuses secret(), even wrapped in toJson", () => {
    expect(validateGeneratedExpr(`{{ jq('x' ~ (secret('FOUNDRY_CALLBACK') | toJson)) }}`, "t").map((f) => f.message).join(" ")).toMatch(/secret/);
  });
  it("still refuses a filter the engine does not have", () => {
    expect(validateGeneratedExpr(`{{ inputs.x | tostring }}`, "t").length).toBeGreaterThan(0);
  });
});
