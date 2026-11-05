/**
 * D-272 / D-273 at the server's own hops. Both fields were once dropped silently
 * between a checked model and what runs: storage's zod schema stripped an input's
 * `transform`, and the compiler's code-payload converter dropped it and `onNull`.
 */
import { describe, expect, it } from "vitest";
import { stepSchema } from "./flow.service.js";
import { displayCodeInput } from "./flow-compiler.service.js";
import { deriveContractInputs } from "./contract-derive.js";
import { TypeOf as T } from "@foundry/flow-edit";

const code = {
  id: "group", kind: "code", code: "def run(p): return {}", inputExpr: "", outputKeys: ["out"],
  dependsOn: ["read"],
  inputs: [
    { name: "rows", source: { from: "whole", stepId: "read", onNull: { vendor_email: "skip" } } },
    { name: "period", source: { from: "input", inputId: "month", transform: "month" } },
  ],
};
const read = { id: "read", kind: "datasource", ref: "fin.past_due", paramsExpr: "", inputs: [] };

describe("storage keeps both fields", () => {
  it("an input's transform and a whole source's onNull survive stepSchema", () => {
    const parsed = stepSchema.parse(code) as { inputs: Array<{ source: unknown }> };
    expect(parsed.inputs[0]!.source).toMatchObject({ onNull: { vendor_email: "skip" } });
    expect(parsed.inputs[1]!.source).toMatchObject({ transform: "month" });
  });
});

describe("the compiled code payload carries both", () => {
  it("skip filters the rows; the month is cut and re-encoded as a JSON literal (I-288)", () => {
    const payload = displayCodeInput(code as never, [read, code] as never)!;
    expect(payload).toContain("select(.vendor_email != null)");
    // In a JSON body the input is an escaped literal (render.ts inputJsonLiteral): the quote-free form it used to be
    // broke the body for an input holding a quote or a backslash.
    expect(payload).toContain(`"period": {{ {'v': inputs.month} | jq('.v | .[0:7] | @json') | first }}`);
  });
});

describe("the fragment is told the null is gone and the month is a month", () => {
  it("F1-style: vendor_email derives non-null; period derives month-shaped", () => {
    const cat = { refs: { "fin.past_due": { kind: "operation", params: [], payload: T.rows(T.record({ vendor_email: T.option(T.address()), amount: T.int() })) } } } as never;
    const model = { id: "f", inputs: [{ id: "month", type: "DATE" }], steps: [read, code] } as never;
    const c = deriveContractInputs(
      { stepId: "group", purpose: "p", input: [{ name: "rows", type: "array" }, { name: "period", type: "string" }], output: [{ name: "out", type: "array" }] },
      model,
      cat,
    );
    const rows = c.input.find((f) => f.name === "rows")!;
    expect(rows.fields?.find((f) => f.name === "vendor_email")).not.toHaveProperty("nullable");
    expect(c.input.find((f) => f.name === "period")).toMatchObject({ format: "month" });
  });
});
