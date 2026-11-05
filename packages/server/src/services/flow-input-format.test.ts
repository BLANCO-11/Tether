/**
 * ⚠ The load-bearing test here is the LAST one: the expression `checkConstructedDates`
 * calls a bug is the same expression this reads a month out of. They are separate
 * functions on purpose, and separate functions reading one pattern is how the two
 * readings drift apart in silence.
 */
import { describe, it, expect } from "vitest";
import { flowInputFormat } from "./flow-input-format.js";
import { checkConstructedDates } from "./flow-date-params.js";

const NO_STEPS: Array<Record<string, unknown>> = [];

describe("a declared type is trusted where it is specific", () => {
  it.each([
    ["DATE", "date"],
    ["DATETIME", "datetime"],
    ["INT", "number"],
    ["FLOAT", "number"],
    ["BOOLEAN", "boolean"],
  ])("%s → %s", (type, want) => {
    expect(flowInputFormat({ id: "x", type }, NO_STEPS)).toBe(want);
  });

  it("beats the value's shape — a declaration knows more than a coincidence", () => {
    // A DATE input whose current value happens to look like a month.
    expect(flowInputFormat({ id: "x", type: "DATE" }, NO_STEPS, "2026-06")).toBe("date");
  });
});

describe("STRING keeps looking, because the drafter emits it when it has not decided", () => {
  it("is text with nothing to go on — the honest answer, not a failure", () => {
    expect(flowInputFormat({ id: "period", type: "STRING" }, NO_STEPS)).toBe("text");
  });

  it("⚠ is NOT read from the name: `period` alone proves nothing", () => {
    expect(flowInputFormat({ id: "period", type: "STRING" }, NO_STEPS)).not.toBe("month");
    expect(flowInputFormat({ id: "as_of", type: "STRING" }, NO_STEPS)).not.toBe("date");
  });

  it("reads the flow's own use of it: a day pasted onto the template means a month", () => {
    const steps = [{ id: "read", paramsExpr: '{"period_end": "{{ inputs.period }}-31"}' }];
    expect(flowInputFormat({ id: "period", type: "STRING" }, steps)).toBe("month");
  });

  it("names the RIGHT input — a sibling's use is not evidence about this one", () => {
    const steps = [{ id: "read", paramsExpr: '{"a": "{{ inputs.period }}-01"}' }];
    expect(flowInputFormat({ id: "as_of", type: "STRING" }, steps)).toBe("text");
  });

  it("does not read a month out of an input merely MENTIONED in an expression", () => {
    const steps = [{ id: "read", paramsExpr: '{"who": "{{ inputs.period }}"}' }];
    expect(flowInputFormat({ id: "period", type: "STRING" }, steps)).toBe("text");
  });

  it("falls back to the shape of the value it can see", () => {
    expect(flowInputFormat({ id: "a", type: "STRING" }, NO_STEPS, "2026-06")).toBe("month");
    expect(flowInputFormat({ id: "a", type: "STRING" }, NO_STEPS, "2026-06-29")).toBe("date");
    // The two live STRING defaults on this deployment, which `type` calls text.
    expect(flowInputFormat({ id: "a", type: "STRING" }, NO_STEPS, "2026-06-29T10:00:00Z")).toBe("datetime");
    expect(flowInputFormat({ id: "a", type: "STRING" }, NO_STEPS, "2026-09-04T11:21:39.237Z")).toBe("datetime");
    expect(flowInputFormat({ id: "a", type: "STRING" }, NO_STEPS, "12")).toBe("number");
    expect(flowInputFormat({ id: "a", type: "STRING" }, NO_STEPS, "true")).toBe("boolean");
    expect(flowInputFormat({ id: "a", type: "STRING" }, NO_STEPS, "Engineering")).toBe("text");
  });

  it("refuses a month that is not a month", () => {
    expect(flowInputFormat({ id: "a", type: "STRING" }, NO_STEPS, "2026-13")).toBe("text");
    expect(flowInputFormat({ id: "a", type: "STRING" }, NO_STEPS, "2026-6")).toBe("text");
  });

  it("treats an id with regex characters as a name, not a pattern", () => {
    const steps = [{ id: "read", paramsExpr: '{"x": "{{ inputs.aXb }}-31"}' }];
    expect(flowInputFormat({ id: "a.b", type: "STRING" }, steps)).toBe("text");
  });
});

/**
 * ⚠ ONE PATTERN, TWO READINGS. D-205's check calls `{{ inputs.period }}-31` a
 * defect because June has 30 days; this module reads the same expression as
 * proof that `period` renders `YYYY-MM`. Both are true and both must stay true
 * of the same string — if one stops matching, a person gets a text box on the
 * input whose typing D-205 exists to stop.
 */
describe("the month reading and D-205's finding agree about the same expression", () => {
  const steps = [{ id: "read", paramsExpr: '{"period_end": "{{ inputs.period }}-31"}' }];

  it("both fire on it", () => {
    expect(checkConstructedDates(steps)).toHaveLength(1); // control: the finding still fires
    expect(flowInputFormat({ id: "period", type: "STRING" }, steps)).toBe("month");
  });

  it("and the month reading survives the expression D-205 deliberately allows", () => {
    // `-01` is correct in every month, so there is no finding — and it is still
    // proof the input is a month.
    const ok = [{ id: "read", paramsExpr: '{"period_start": "{{ inputs.period }}-01"}' }];
    expect(checkConstructedDates(ok)).toHaveLength(0);
    expect(flowInputFormat({ id: "period", type: "STRING" }, ok)).toBe("month");
  });
});

describe("a declared format wins (phase 5, D-255)", () => {
  it("format month renders a month control even when nothing in the steps says so", () => {
    expect(flowInputFormat({ id: "p", type: "STRING", format: "month" }, [], null)).toBe("month");
  });
  it("CONTROL: the same input without it is text", () => {
    expect(flowInputFormat({ id: "p", type: "STRING" }, [], null)).toBe("text");
  });
});
