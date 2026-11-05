/**
 * builder-behaviour P7 (R23): a length of time said with its unit, compared with a number that DECLARES its time unit, is converted
 * exactly — or refused with why. A number that declares no unit takes the number as said (as before).
 */
import { describe, expect, it } from "vitest";
import { inUnit, timeOfWords } from "./value-tests.js";
import { render, tyOfColumn } from "../typecheck/types.js";

describe("time units", () => {
  it("reads the unit a value's words say; none when there is none", () => {
    expect(timeOfWords("3 days")).toEqual({ n: 3, unit: "days" });
    expect(timeOfWords("2 weeks")).toEqual({ n: 14, unit: "days" });
    expect(timeOfWords("90 mins")).toEqual({ n: 90, unit: "minutes" });
    expect(timeOfWords("4 business hours")).toEqual({ n: 240, unit: "business_minutes" });
    expect(timeOfWords("5")).toBeNull();
    expect(timeOfWords("10 tickets")).toBeNull();
  });
  it("converts calendar time exactly; working time only to working time", () => {
    expect(inUnit({ n: 3, unit: "days" }, "minutes")).toBe(4320);
    expect(inUnit({ n: 90, unit: "minutes" }, "hours")).toBe(1.5);
    expect(inUnit({ n: 240, unit: "business_minutes" }, "business_minutes")).toBe(240);
    expect(inUnit({ n: 3, unit: "days" }, "business_minutes")).toMatch(/working minutes/);
    expect(inUnit({ n: 240, unit: "business_minutes" }, "minutes")).toMatch(/working time/);
  });
  it("a schema tag declares a number's time unit; other tags (a temperature's unit) do not", () => {
    expect(render(tyOfColumn("integer", false, "unit=minutes"))).toBe("Int<minutes>");
    expect(render(tyOfColumn("numeric", true, "duration;unit=hours"))).toBe("Option<Number<hours>>");
    expect(render(tyOfColumn("numeric", false, "temperature;unit=C"))).toBe("Number");
  });
});
