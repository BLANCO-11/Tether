/** Phase 5 task 4 (D-255): a run's supplied inputs are checked before any execution exists. */
import { describe, expect, it } from "vitest";
import { checkRunInputs, coerceTypedInput } from "./flow-run-inputs.js";

describe("checkRunInputs", () => {
  const declared = [
    { id: "period", type: "STRING", format: "month" },
    { id: "as_of", type: "DATE" },
    { id: "at", type: "DATETIME" },
    { id: "note", type: "STRING" },
  ];
  it("the historical failures are refused, naming the input and the shape", () => {
    for (const bad of ["01/08/2026", "2026/08", "2026-06-30", "2026-13"]) {
      expect(checkRunInputs(declared, { period: bad })[0]?.message).toBe(`input "period" must be a month (YYYY-MM), got ${JSON.stringify(bad)}`);
    }
    expect(checkRunInputs(declared, { as_of: "01/08/2026" })[0]?.message).toMatch(/must be a date \(YYYY-MM-DD\)/);
    expect(checkRunInputs(declared, { at: "2026-06-30" })).toHaveLength(1);
  });
  it("CONTROL: well-formed values pass, a plain STRING takes anything, an unknown id is named", () => {
    expect(checkRunInputs(declared, { period: "2026-06", as_of: "2026-06-30", at: "2026-06-30T12:00:00Z", note: "01/08/2026" })).toEqual([]);
    expect(checkRunInputs(declared, { nope: "x" })[0]?.message).toMatch(/not declared/);
  });
  it("DATE used to accept anything new Date() parses — no longer", () => {
    expect(coerceTypedInput("DATE", "01/08/2026")).toBeNull();
    expect(coerceTypedInput("DATE", "2026-06-30")).toBe("2026-06-30");
  });
});
