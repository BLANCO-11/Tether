/**
 * Phase 5 task 1 (D-254): a typed code input's contract is derived from its
 * source. F1 refused "not which fields each grouped vendor must contain" over
 * a contract that said only `rows: array`.
 */
import { describe, expect, it } from "vitest";
import { TypeOf as T, type CatalogueSnapshot } from "@foundry/flow-edit";
import { deriveContractInputs } from "./contract-derive.js";
import { buildFragmentPrompt, type StepContract } from "./step-contract.service.js";
import type { FlowModel } from "./flow-compiler.service.js";

const cat: CatalogueSnapshot = {
  refs: {
    "fin.invoices_past_due": {
      kind: "operation",
      params: [],
      payload: T.rows(T.record({ vendor_name: T.text(), amount_cents: T.int(), due_date: T.option(T.date()) })),
    },
    some_tool: { kind: "tool", params: [], payload: T.opaque() },
  },
  stepColumns: {},
} as never;

const model = (inputs: unknown[], extra: Record<string, unknown> = {}): FlowModel =>
  ({
    id: "f",
    inputs: [{ id: "as_of", type: "DATE", required: true }],
    steps: [
      { id: "read", kind: "datasource", ref: "fin.invoices_past_due", paramsExpr: "", inputs: [] },
      { id: "call", kind: "tool", ref: "some_tool", paramsExpr: "", inputs: [] },
      { id: "rank", kind: "code", code: "", inputExpr: "", outputKeys: ["out"], inputs, ...extra },
    ],
  }) as unknown as FlowModel;

const contract: StepContract = {
  stepId: "rank",
  purpose: "group by vendor",
  input: [
    { name: "rows", type: "array", description: "the invoices" },
    { name: "amounts", type: "array" },
    { name: "as_of", type: "string" },
    { name: "blob", type: "object" },
  ],
  output: [{ name: "out", type: "array" }],
};

const bound = [
  { name: "rows", source: { from: "whole", stepId: "read" } },
  { name: "amounts", source: { from: "step", stepId: "read", field: "amount_cents" } },
  { name: "as_of", source: { from: "input", inputId: "as_of" } },
  { name: "blob", source: { from: "whole", stepId: "call" } },
];

describe("deriveContractInputs", () => {
  const d = deriveContractInputs(contract, model(bound), cat);
  const by = (n: string) => d.input.find((f) => f.name === n)!;

  it("whole rows of an operation → array<object> with its typed keys, description kept", () => {
    expect(by("rows")).toEqual({
      name: "rows",
      type: "array",
      description: "the invoices",
      items: "object",
      fields: [
        { name: "vendor_name", type: "string" },
        { name: "amount_cents", type: "number" },
        { name: "due_date", type: "string", format: "date", nullable: true },
      ],
    });
  });
  it("one column across the rows → array<number>", () => expect(by("amounts")).toMatchObject({ type: "array", items: "number" }));
  it("a DATE flow input → string (date)", () => expect(by("as_of")).toMatchObject({ type: "string", format: "date" }));
  it("CONTROL: a tool's opaque body changes nothing", () => expect(by("blob")).toEqual(contract.input[3]));
  it("CONTROL: a hand-written inputExpr is not derived (same reference back)", () => {
    expect(deriveContractInputs(contract, model(bound, { inputExpr: '{"rows": 1}' }), cat)).toBe(contract);
  });
  it("CONTROL: no catalogue → same reference back", () => expect(deriveContractInputs(contract, model(bound), undefined)).toBe(contract));

  it("the fragment prompt names every key of the row", () => {
    const p = buildFragmentPrompt(d);
    expect(p).toContain("rows: array<object>   # the invoices\n    each element has exactly these keys:\n      vendor_name: string\n      amount_cents: number\n      due_date: string (date YYYY-MM-DD) or null");
    expect(buildFragmentPrompt(contract)).not.toContain("each element has exactly");
  });
});
