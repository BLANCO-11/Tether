// The chat prompt's step inventory: ids, live values and sources in words —
// never a guess for text-mined inputs, and nothing at all for an empty flow.
import { describe, expect, it } from "vitest";
import { describeStepInventory } from "./inventory.js";
import type { AuthoredFlow } from "./index.js";

const flow: AuthoredFlow = {
  id: "chase_overdue",
  inputs: [{ id: "period", type: "DATE" }],
  steps: [
    {
      kind: "datasource",
      id: "overdue",
      ref: "q.overdue",
      paramsExpr: "[{}]",
      inputs: [
        { name: "period", source: { from: "input", inputId: "period" } },
        { name: "limit", source: null },
      ],
    },
    {
      kind: "llm",
      id: "summarise",
      model: "acme/large",
      tempPreset: "custom",
      temperature: 0.3,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      promptBlocks: [{ role: "user", text: "Summarise {{ outputs.overdue.body }}" }],
      contextStepId: null,
      outputFields: [],
      memoryEnabled: false,
      visionDetail: "low",
      reasoningSeparated: false,
      dependsOn: ["overdue"],
    },
    { kind: "transform", id: "shape", expr: "{{ . }}", dependsOn: ["overdue"] },
    {
      kind: "code",
      id: "rank",
      inputExpr: "{{ overdue }}",
      contract: {
        purpose: "rank rows",
        input: [{ name: "rows", type: "array", description: "" }],
        output: [{ name: "ranked", type: "array", description: "" }],
      },
      dependsOn: ["shape"],
    },
  ],
};

describe("describeStepInventory", () => {
  it("renders one block per step with ids, values and sources", () => {
    const text = describeStepInventory(flow);
    expect(text).toContain('"overdue"');
    expect(text).toContain('"summarise"');
    expect(text).toContain("data source");
    expect(text).toContain("LLM");
    expect(text).toContain('ref="q.overdue"');
    expect(text).toContain("temperature=0.3");
    expect(text).toContain("model=\"acme/large\"");
    expect(text).toContain("period=from run input period");
    expect(text).toContain("limit=not set");
    expect(text).toContain("outputs: body (any)");
  });

  it("reports text-mined inputs as set in the expression, never a guess", () => {
    const text = describeStepInventory(flow);
    const shape = text.split('"shape"')[1].split('"rank"')[0];
    expect(shape).toContain("set in the expression");
    const rank = text.split('"rank"')[1];
    expect(rank).toContain("set in the expression");
    expect(rank).toContain("ranked (array)");
  });

  it("reports container children as one unmined paragraph, never expanded", () => {
    const text = describeStepInventory({
      id: "nested",
      steps: [
        {
          kind: "iteration",
          id: "per_row",
          arraySource: { from: "step", stepId: "overdue", field: "body" },
          children: [
            { kind: "transform", id: "shape_each", expr: "{{ . }}" },
            {
              kind: "iteration",
              id: "inner",
              arraySource: { from: "step", stepId: "shape_each", field: "value" },
              children: [{ kind: "transform", id: "deep", expr: "{{ . }}" }],
            },
          ],
        },
        {
          kind: "loop",
          id: "retry_until",
          loopVars: [],
          maxCount: 3,
          children: [{ kind: "transform", id: "polish", expr: "{{ . }}" }],
        },
      ],
    });
    expect(text).toContain('children: contains 2 steps: "shape_each", "inner" (contained, not expanded)');
    expect(text).toContain('children: contains 1 step: "polish" (contained, not expanded)');
    // Children never get their own blocks, and nested grandchildren are never named.
    expect(text).not.toContain('- "shape_each"');
    expect(text).not.toContain('- "inner"');
    expect(text).not.toContain('"deep"');
    expect(text).not.toContain('- "polish"');
  });

  it("returns an empty string for a flow with no steps", () => {
    expect(describeStepInventory({ id: "empty", steps: [] })).toBe("");
  });
});
