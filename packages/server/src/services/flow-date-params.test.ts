/**
 * `checkConstructedDates` — the control on execution `7cwL1ris`.
 *
 * ⚠ Every test below that asserts a finding has a NEGATIVE twin, because the
 * whole risk in this check is the other direction: a date check that fires on
 * `-01` would fire on almost every correct flow in the repo, and a finding a
 * reader learns to scroll past is worse than no finding at all (I-38).
 */
import { describe, expect, it } from "vitest";
import { checkConstructedDates } from "./flow-date-params.js";
import { EXPRESSION_FIELDS } from "./flow-expression.service.js";
import { PURE_MODEL_CHECKS, pureModelFindings } from "./flow-model-findings.js";

/** The failing step from execution `7cwL1ris`, as close as the record allows. */
const REAL_FAILURE = [
  {
    id: "fetch_leave_requests",
    kind: "query",
    ref: "hr_demo.approved_leave_requests",
    paramsExpr:
      '[{"status":"approved","period_start":"{{ inputs.period }}-01","period_end":"{{ inputs.period }}-31"}]',
  },
];

describe("the date a month cannot have", () => {
  it("catches the real failure — a day pasted onto a month", () => {
    const found = checkConstructedDates(REAL_FAILURE);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('step "fetch_leave_requests".paramsExpr');
    expect(found[0]).toContain("-31");
  });

  /**
   * ⚠ The load-bearing negative. `period_start` in the fixture above is
   * `{{ inputs.period }}-01` — the SAME concatenation, and correct, because every
   * month has a first. A check that flagged both would have no signal in it.
   */
  it("leaves `-01` alone, and every other day every month has", () => {
    for (const day of ["01", "05", "15", "28"]) {
      expect(
        checkConstructedDates([
          { id: "s", paramsExpr: `[{"d":"{{ inputs.period }}-${day}"}]` },
        ]),
        `-${day} is a real day in every month`,
      ).toEqual([]);
    }
  });

  it("flags 29, 30 and 31 — the three days some month lacks", () => {
    for (const day of ["29", "30", "31"]) {
      expect(
        checkConstructedDates([
          { id: "s", paramsExpr: `[{"d":"{{ inputs.period }}-${day}"}]` },
        ]),
        `-${day} is not in every month`,
      ).toHaveLength(1);
    }
  });

  it("says both remedies, never one", () => {
    const [f] = checkConstructedDates(REAL_FAILURE);
    expect(f).toContain("declare the flow input AS a date");
    expect(f).toContain("`code` step");
  });

  /**
   * The finding has to explain why the model cannot simply write the expression
   * better — `ALLOWED_CALLS` is the reason, and without it the remedy reads as
   * arbitrary.
   */
  it("says WHY the expression cannot be fixed in place", () => {
    const [f] = checkConstructedDates(REAL_FAILURE);
    expect(f).toContain("no date function");
    expect(f).toContain("`json`, `jq`, `first` and `length`");
  });
});

describe("a literal month and day, where the answer is decidable outright", () => {
  it("flags a template with an impossible literal tail", () => {
    expect(
      checkConstructedDates([{ id: "s", paramsExpr: '[{"d":"{{ inputs.year }}-02-30"}]' }]),
    ).toHaveLength(1);
  });

  /** December has 31 days, so this expression cannot fail. */
  it("leaves `-12-31` alone", () => {
    expect(
      checkConstructedDates([{ id: "s", paramsExpr: '[{"d":"{{ inputs.year }}-12-31"}]' }]),
    ).toEqual([]);
  });
});

describe("fully literal dates", () => {
  it("flags one that is not a real date", () => {
    for (const bad of ["2026-06-31", "2026-02-30", "2026-13-01", "2026-04-31"]) {
      expect(
        checkConstructedDates([{ id: "s", paramsExpr: `[{"d":"${bad}"}]` }]),
        `${bad} is not a date`,
      ).toHaveLength(1);
    }
  });

  it("leaves real ones alone, leap day included", () => {
    for (const ok of ["2026-06-30", "2024-02-29", "2026-12-31", "2026-01-01"]) {
      expect(
        checkConstructedDates([{ id: "s", paramsExpr: `[{"d":"${ok}"}]` }]),
        `${ok} is a date`,
      ).toEqual([]);
    }
  });

  /**
   * ⚠ 2026 is not a leap year and 2024 is. Both are in the test above, so a
   * check that ignored the year would fail one of them.
   */
  it("is leap-year aware rather than allowing 02-29 always", () => {
    expect(
      checkConstructedDates([{ id: "s", paramsExpr: '[{"d":"2026-02-29"}]' }]),
    ).toHaveLength(1);
  });
});

describe("where it looks", () => {
  /**
   * ⚠ The D-197 assertion. `checkConstructedDates` and `validateModelExpressions`
   * read the SAME exported list; a step kind whose new expression field is added
   * to one consumer and not the other is the silent failure that list's docblock
   * describes.
   */
  it("scans every field in the shared list, not a copy of it", () => {
    expect(EXPRESSION_FIELDS.length).toBeGreaterThan(1);
    for (const field of EXPRESSION_FIELDS) {
      expect(
        checkConstructedDates([{ id: "s", [field]: '"{{ inputs.period }}-31"' }]),
        `${field} is not scanned`,
      ).toHaveLength(1);
    }
  });

  it("ignores a non-string field rather than throwing", () => {
    expect(checkConstructedDates([{ id: "s", paramsExpr: 31 }])).toEqual([]);
    expect(checkConstructedDates([{ paramsExpr: null }])).toEqual([]);
  });

  it("names an unnamed step rather than saying undefined", () => {
    const [f] = checkConstructedDates([{ paramsExpr: '"{{ x }}-31"' }]);
    expect(f).toContain("<unnamed step>");
  });

  it("reports one finding per distinct mistake, not one per match", () => {
    // The same wrong suffix twice in one field is one thing to fix.
    const found = checkConstructedDates([
      { id: "s", paramsExpr: '[{"a":"{{ inputs.p }}-31","b":"{{ inputs.p }}-31"}]' },
    ]);
    expect(found).toHaveLength(1);
  });
});

describe("it reaches the paths that accept a model", () => {
  it("is registered, so refine and chat run it too", () => {
    expect(PURE_MODEL_CHECKS.map((c) => c.name)).toContain("checkConstructedDates");
  });

  it("the real failure survives into pureModelFindings", () => {
    expect(pureModelFindings(REAL_FAILURE, []).join("\n")).toContain("date/time field value out of range");
  });
});
