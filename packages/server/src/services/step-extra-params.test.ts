import { describe, expect, it } from "vitest";
import { mergeExtraParams } from "./step-execution.service.js";
import { StepError } from "./step-error.js";

/**
 * The merge behind a tool step's adjustable inputs: caller-supplied values
 * join every params object before the dial. Last wins on collision.
 */
describe("mergeExtraParams", () => {
  it("returns params untouched when nothing extra was authored", () => {
    const params = [{ to: "a" }];
    expect(mergeExtraParams(params, undefined)).toBe(params);
    expect(mergeExtraParams(params, [])).toBe(params);
  });

  it("merges into every item, last wins", () => {
    expect(
      mergeExtraParams(
        [{ to: "a", cc: "old" }, { to: "b" }],
        [
          { name: "cc", value: "new" },
          { name: "priority", value: "high" },
        ],
      ),
    ).toEqual([
      { to: "a", cc: "new", priority: "high" },
      { to: "b", cc: "new", priority: "high" },
    ]);
  });

  it("refuses nameless entries and non-object params items", () => {
    expect(() => mergeExtraParams([{ to: "a" }], [{ value: "x" }] as never)).toThrow(StepError);
  });
});
