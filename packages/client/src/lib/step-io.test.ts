import { describe, it, expect } from "vitest";
import { brokenReferences } from "./step-io";
import type { AuthoredStep } from "@foundry/flow-edit";

// A `tool` step whose stored bindings point at a removed step. `inputs` is
// the Stage 3 dual representation `typedInputsOf` reads; the cast carries it
// because the registry type does not name stage fields.
const catalogue = {
  entries: [{ ref: "mail_send", params: [{ name: "to", type: "string", required: true, description: null }] }],
  outputs: {
    tool: { template: "json(outputs.<id>.body)", describes: null, caution: null },
    datasource: { template: "json(outputs.<id>.body)", describes: null, caution: null },
  },
};

function toolStep(bindings: Array<{ name: string; source: unknown }>): AuthoredStep {
  return {
    kind: "tool",
    id: "send",
    ref: "mail_send",
    paramsExpr: "[{}]",
    inputs: bindings,
  } as unknown as AuthoredStep;
}

const fetchStep = { kind: "datasource", id: "fetch", ref: "q", paramsExpr: "[{}]" } as unknown as AuthoredStep;

describe("brokenReferences", () => {
  it("names inputs bound to a step that is gone", () => {
    const step = toolStep([{ name: "to", source: { from: "step", stepId: "gone", field: "email" } }]);
    expect(brokenReferences(step, [step, fetchStep], catalogue)).toEqual([
      { name: "to", stepId: "gone", field: "email" },
    ]);
  });

  it("is empty when every bound step is present", () => {
    const step = toolStep([{ name: "to", source: { from: "step", stepId: "fetch", field: "email" } }]);
    expect(brokenReferences(step, [step, fetchStep], catalogue)).toEqual([]);
  });

  it("reports a whole-step read with an empty field", () => {
    const step = toolStep([{ name: "to", source: { from: "whole", stepId: "gone" } }]);
    expect(brokenReferences(step, [step], catalogue)).toEqual([{ name: "to", stepId: "gone", field: "" }]);
  });

  it("ignores unbound inputs and run inputs", () => {
    const step = toolStep([
      { name: "to", source: null },
      { name: "cc", source: { from: "input", inputId: "period" } },
    ]);
    expect(brokenReferences(step, [step], catalogue)).toEqual([]);
  });
});
