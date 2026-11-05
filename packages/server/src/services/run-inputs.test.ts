import { describe, expect, it } from "vitest";
import { relativeDate, runInputsOf } from "./run-inputs.js";

const wf = {
  inputs: {
    month: { type: "integer", description: "Month", default: 6 },
    year: { type: "integer", description: "Year" },
    as_of: { type: "date", description: "Day", default: "2026-06-30" },
    vip: { type: "boolean", description: "VIP only", default: false },
  },
};

describe("a run's inputs", () => {
  it("what a person typed wins, coerced to the declared type — a step receives 2024, never \"2024\"", () => {
    const r = runInputsOf(wf, { month: "1", year: "2024", vip: "true" });
    expect(r.problems).toEqual([]);
    expect(r.values).toEqual({ month: 1, year: 2024, as_of: "2026-06-30", vip: true });
  });

  it("a blank box falls back to the default", () => {
    expect(runInputsOf(wf, { month: " ", year: 2024 }).values.month).toBe(6);
  });

  it("a required input nobody gave is refused by name, before any run", () => {
    expect(runInputsOf(wf, {}).problems).toEqual(['input "year" has no default and was not given a value']);
  });

  it("a value of the wrong type is refused, never guessed", () => {
    const r = runInputsOf(wf, { year: "twenty", as_of: "30/06/2026" });
    expect(r.problems).toHaveLength(2);
    expect(r.problems[0]).toMatch(/year.*whole number/);
    expect(r.problems[1]).toMatch(/as_of.*YYYY-MM-DD/);
  });

  it("a value for an input the workflow does not declare is refused (a key ignored reads as one that works)", () => {
    expect(runInputsOf(wf, { year: 2024, monht: 3 }).problems[0]).toMatch(/"monht" is not an input/);
  });

  it("control: no declared inputs and none given is a clean, empty run", () => {
    expect(runInputsOf({}, undefined)).toEqual({ values: {}, problems: [] });
  });
});

describe("a date relative to the run day (2026-10-11)", () => {
  // Saturday 11 October 2026, 22:30 UTC — already Sunday the 12th in Kolkata.
  const now = new Date("2026-10-11T22:30:00Z");
  it("works out every anchor, weeks starting on Monday", () => {
    expect(relativeDate("today", now)).toBe("2026-10-11");
    expect(relativeDate("yesterday", now)).toBe("2026-10-10");
    expect(relativeDate("this_week_start", now)).toBe("2026-10-05");
    expect(relativeDate("last_week_start", now)).toBe("2026-09-28");
    expect(relativeDate("last_week_end", now)).toBe("2026-10-04");
    expect(relativeDate("this_month_start", now)).toBe("2026-10-01");
    expect(relativeDate("last_month_start", now)).toBe("2026-09-01");
    expect(relativeDate("last_month_end", now)).toBe("2026-09-30");
    expect(relativeDate("fortnight", now)).toBeNull();
  });
  it("in the schedule's timezone, not the server's", () => {
    expect(relativeDate("today", now, "Asia/Kolkata")).toBe("2026-10-12");
    expect(relativeDate("this_week_start", now, "Asia/Kolkata")).toBe("2026-10-12");
  });
  const wf = { inputs: { week: { type: "date", relative: "last_week_start", default: "2026-06-01" } } };
  it("⚠ a REAL run uses the relative date; a TEST run uses the default the test data has", () => {
    expect(runInputsOf(wf, {}, { live: true, now }).values.week).toBe("2026-09-28");
    expect(runInputsOf(wf, {}, { now }).values.week).toBe("2026-06-01");
  });
  it("a value given wins over both", () => {
    expect(runInputsOf(wf, { week: "2026-01-05" }, { live: true, now }).values.week).toBe("2026-01-05");
  });
});
