// @vitest-environment node
//
// src/lib/flow-input-form.test.ts — turning declared inputs into a usable form.
//
// ⚠ Reported from use: a support flow asked for `as_of` and showed
// "Defaults to 2026-09-04T11:21:39.237Z". Both accurate, neither usable.
import { describe, expect, it } from "vitest";
import { hintFor, humanLabel } from "@/lib/flow-input-form";
import { formatFor } from "@/components/automation/TypedInput";

describe("humanLabel", () => {
  it("prefers what the flow declared", () => {
    expect(humanLabel({ id: "as_of", label: "As of date" })).toBe("As of date");
  });

  it("humanises the id when no label was declared — the case every old flow is in", () => {
    expect(humanLabel({ id: "as_of" })).toBe("As of");
    expect(humanLabel({ id: "period" })).toBe("Period");
    expect(humanLabel({ id: "min-rate" })).toBe("Min rate");
  });

  /**
   * ⚠ The id must stay RECOGNISABLE. It is what appears in the flow's
   * expressions and in the engine's error messages, so a label that renamed it
   * would leave a person unable to match a failure to a field.
   */
  it("reshapes and never renames", () => {
    expect(humanLabel({ id: "as_of" }).toLowerCase().replace(" ", "_")).toBe("as_of");
  });

  it("falls back to the id rather than an empty label", () => {
    expect(humanLabel({ id: "x", label: "   " })).toBe("X");
  });
});

describe("formatFor", () => {
  it("gives a picker for the types that mean a moment in time", () => {
    expect(formatFor({ type: "DATE" })).toBe("date");
    expect(formatFor({ type: "DATETIME" })).toBe("datetime");
  });

  it("numbers and booleans get their own formats", () => {
    expect(formatFor({ type: "INT" })).toBe("number");
    expect(formatFor({ type: "FLOAT" })).toBe("number");
    expect(formatFor({ type: "BOOLEAN" })).toBe("boolean");
  });

  it("the server's derived format wins over the declared type", () => {
    expect(formatFor({ type: "STRING", format: "month" })).toBe("month");
    expect(formatFor({ type: "STRING", format: "date" })).toBe("date");
  });

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * ⚠ THE GUESS THIS MODULE REFUSES, AND IT IS THE LOAD-BEARING TEST HERE
   * ─────────────────────────────────────────────────────────────────────────
   *
   * It is tempting to notice that `as_of` defaults to an ISO timestamp and give
   * it a date picker anyway — it would fix the reported flow today, without
   * re-drafting it.
   *
   * It would also break the HR flows. `period` is `"2026-06"`: a MONTH, which
   * matches a date-ish regex and is not a date. A picker there writes
   * `2026-06-01` into a query expecting `YYYY-MM`, and the run goes green
   * against the wrong window — a wrong answer nobody is watching for, which is
   * the exact failure class this repo keeps recording.
   *
   * So the declared type decides, and only the declared type — unless the
   * server derived a format from the flow's own use of the input. An existing
   * flow declaring a date as STRING is fixed by re-drafting it, now that the
   * prompt teaches DATE/DATETIME.
   */
  it("⚠ never infers a date from a value or an id — STRING stays a text box", () => {
    expect(formatFor({ type: "STRING" })).toBe("text");
    expect(formatFor({})).toBe("text");
    // The reported field, exactly as stored today: still text, deliberately.
    expect(formatFor({ type: "STRING" })).toBe("text");
  });
});

describe("hintFor", () => {
  it("the flow's own sentence wins", () => {
    expect(
      hintFor({ id: "as_of", type: "DATE", description: "The day to report from." }),
    ).toBe("The day to report from.");
  });

  /** ⚠ No invented prose. Absent description → a fact, never a guess at meaning. */
  it("says what to do with the default rather than what the field means", () => {
    expect(hintFor({ id: "period", type: "STRING", defaults: "2026-06" })).toBe(
      "Leave as it is to use 2026-06.",
    );
  });

  it("a picker is not told what a date is", () => {
    // The control has its own affordance; a sentence explaining it is noise.
    expect(hintFor({ id: "as_of", type: "DATE", defaults: "2026-09-04" })).toBe(
      "A value is already filled in.",
    );
  });

  it("required and optional are distinguishable with no default", () => {
    expect(hintFor({ id: "a", type: "STRING" })).toBe("Required");
    expect(hintFor({ id: "a", type: "STRING", required: false })).toBe("Optional");
  });

  it("a server-derived month is a picker, not a text box with a default", () => {
    expect(hintFor({ id: "period", type: "STRING", format: "month", defaults: "2026-06" })).toBe(
      "A value is already filled in.",
    );
  });
});

