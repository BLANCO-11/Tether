/**
 * One kind of time input (2026-10-01): a DATE, compared at the granularity its filter declares. `per: "month"` is a date compared by
 * its month — any day of the month is the month — so a month is never a second type with its own string format to get wrong.
 */
import { describe, expect, it } from "vitest";
import { T, assignable, render, tyOfParam } from "../typecheck/types.js";
import { runTimeChoices } from "./options.js";
import { emptyFlow } from "./model.js";

describe("a date compared by its month", () => {
  it("is declared by the parameter (`format: date`, `per: month`) and reads in words", () => {
    expect(tyOfParam("string", "date", "month")).toEqual({ t: "Date", per: "month" });
    expect(render(T.date("month"))).toBe("Date<by month>");
    // CONTROL: without the declaration it is a plain date — a day.
    expect(tyOfParam("string", "date")).toEqual({ t: "Date" });
  });
  it("accepts a date and a month; a plain date does NOT accept a month", () => {
    expect(assignable(T.date(), T.date("month")).ok).toBe(true);
    expect(assignable(T.month(), T.date("month")).ok).toBe(true);
    // CONTROL: a month is not a day — "August" names no date to compare a day with.
    expect(assignable(T.month(), T.date()).ok).toBe(false);
  });
  it("is offered the month it runs and the month before — as months, and only those", () => {
    const f = emptyFlow("x");
    expect(runTimeChoices(f, "read_1", "period", T.date("month")).map((c) => c.label)).toEqual([
      "the month it runs (worked out when it runs)",
      "the month before it runs (worked out when it runs)",
    ]);
    // CONTROL: a plain date is offered days.
    expect(runTimeChoices(f, "read_1", "on", T.date()).map((c) => c.label)).toContain("the day it runs (worked out when it runs)");
  });
});
