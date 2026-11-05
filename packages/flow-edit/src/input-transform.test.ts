/** Phase 2 task 9 (D-272): `transform: "month"|"date"` on an input — rendered in the engine-probed forms (E2.1/E2.2), typed by the checker. */
import { describe, expect, it } from "vitest";
import { buildSingleParams, buildCodeInput } from "./render.js";
import { checkFlow, TypeOf as T, type CatalogueSnapshot, type CheckModel } from "./typecheck/index.js";

describe("rendering an input conversion", () => {
  it("a call with no step sources uses the map form (E2.2), re-encoded as a JSON literal inside jq (I-288)", () => {
    const p = buildSingleParams([{ param: "period", source: { from: "input", inputId: "month", transform: "month" } }] as never);
    expect(p).toBe(`[{ "period": {{ {'v': inputs.month} | jq('.v | .[0:7] | @json') | first }} }]`);
  });
  it("a code payload uses the same forms; no transform is the escaped text literal (I-288)", () => {
    const c = buildCodeInput({} as never, [
      { name: "period", source: { kind: "input", inputId: "month", transform: "month" } },
      { name: "as_of", source: { kind: "input", inputId: "as_of" } },
    ]);
    expect(c).toContain(`"period": {{ {'v': inputs.month} | jq('.v | .[0:7] | @json') | first }}`);
    expect(c).toContain(`"as_of": {{ (inputs.as_of ~ '') | toJson }}`);
  });
});

const CAT: CatalogueSnapshot = {
  refs: { "hr.summary": { kind: "tool", params: [{ name: "period", ty: T.month(), required: true }], payload: T.opaque() } },
};
const model = (type: string, transform?: string): CheckModel =>
  ({
    id: "m",
    inputs: [{ id: "month", type }],
    steps: [{ id: "s", kind: "tool", ref: "hr.summary", inputs: [{ name: "period", source: { from: "input", inputId: "month", ...(transform ? { transform } : {}) } }] }],
  }) as never;
const codes = (m: CheckModel) => checkFlow(m, CAT).filter((d) => d.severity === "error").map((d) => d.code);

describe("typing an input conversion", () => {
  it("DATE + transform month into a Month port is clean", () => {
    expect(codes(model("DATE", "month"))).toEqual([]);
  });
  it("CONTROL: DATE with no transform into a Month port is FT0202 — no implicit conversion", () => {
    expect(codes(model("DATE"))).toContain("FT0202");
  });
  it("CONTROL: transform month over a STRING is FT0202 — a month is cut from a date only", () => {
    expect(codes(model("STRING", "month"))).toContain("FT0202");
  });
});
