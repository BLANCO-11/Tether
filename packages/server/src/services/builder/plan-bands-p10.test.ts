/**
 * P10 (bands, generic): a band_count measure survives findings and lowers its bands into the spec summary.
 * Generic bucketing — hours and amounts prove no scenario tailoring.
 */
import { describe, expect, it } from "vitest";
import { checkSpec, type BuilderCatalogue } from "./goal-spec.js";
import {
  clauses, planFindings, planToSpec, type Plan,
} from "./plan.js";

const CAT: BuilderCatalogue = { items: [
  { ref: "ds.attendance", kind: "reader", about: "attendance rows", fields: [{ name: "hours", ty: "number" }, { name: "emp", ty: "text" }] },
  { ref: "ds.attendance.new_read", kind: "reader", about: "a NEW read of ds", fields: [{ name: "hours", ty: "number" }, { name: "emp", ty: "text" }] },
] };
const GOAL = "for each employee, count half-day absences for hours at least 4.75 and full-day absences below 4.74";
const CS = clauses(GOAL);
const band = (): Plan => ({
  sources: [{ ref: "ds.attendance.new_read", clauses: ["C1"], quote: "for each employee", also: [] }],
  each: null, rows: [], schedule: null, conditions: [], actions: [], values: [], missing: "", joining: [],
  summary: {
    quote: "count half-day absences and full-day absences", clauses: ["C1"], over: 0,
    by: [{ field: "ds.attendance.emp", words: "for each employee" }],
    measures: [{ fn: "band_count", field: "ds.attendance.hours", words: "absences", bands: [
      { test: "at_least", value: "4.75", then: 0.5, words: "half-day" },
      { test: "below", value: "4.74", then: 1, words: "full-day" },
    ] }],
    sort: null, limit: "",
  },
});

describe("P10 — band_count measure", () => {
  it("a well-formed band measure over a written read raises no band findings", () => {
    const f = planFindings(band(), CS, CAT).join(" ");
    expect(f).not.toMatch(/counts by bands/);
  });

  it("a bandless / edgeless band measure is flagged", () => {
    const p = band();
    p.summary!.measures = [{ fn: "band_count", field: "", words: "absences" }];
    const f = planFindings(p, CS, CAT).join(" ");
    expect(f).toMatch(/names no field/);
    expect(f).toMatch(/with no bands/);
  });

  it("CONTROL: band findings are clause-free (structural — no :again churn)", () => {
    const p = band();
    p.summary!.measures = [{ fn: "band_count", field: "", words: "absences" }];
    const f = planFindings(p, CS, CAT).filter((x) => /band/i.test(x));
    expect(f.length).toBeGreaterThan(0);
    expect(f.some((x) => /^C\d+ /.test(x))).toBe(false);
  });
  it("2026-10-06, retired 2026-10-08: bands over a table/saved source lower spec.summary with no scope planGap — emit reads table sources directly", () => {
    const p = band();
    p.sources = [{ ref: "ds.attendance", clauses: ["C1"], quote: "for each employee", also: [] }];
    const { spec } = planToSpec(p, CS, CAT);
    expect(spec.summary?.measures[0]).toMatchObject({ fn: "band_count", field: "ds.attendance.hours" });
    expect(spec.summary?.by).toEqual(["ds.attendance.emp"]);
    expect((spec.planGaps ?? []).join(" ")).not.toMatch(/bands compute in a written read/);
  });
  it("2026-10-06: the lowered band summary's grouping words survive checkSpec — no unclear on them", () => {
    const p = band();
    p.sources = [{ ref: "ds.attendance", clauses: ["C1"], quote: "for each employee", also: [] }];
    const { spec } = planToSpec(p, CS, CAT);
    const goal = "for each employee count half-day absences for hours at least 4.75";
    const c = checkSpec({ ...spec, unclear: [{ quote: "for each employee", about: "action" }] }, [goal], CAT);
    expect(c.spec.unclear ?? []).toEqual([]);
  });
  /**
   * Live 2026-10-07: builder asked "What do you mean by for each employee / Weight half = 0.5 / full = 1 / present = 0"
   * over a plan that already had band_count + by. Summary clauses were not in `claimed`, so they became
   * "implemented by nothing" → unclear questions. Never ask settled grouping / band weights.
   */
  it("2026-10-07: band weight + for-each clauses are claimed — never “implemented by nothing”", () => {
    const goal = "for each employee. Weight half = 0.5. full = 1. present = 0. email Absence days per employee to me";
    const cs = clauses(goal);
    const p = band();
    p.summary = {
      ...p.summary!,
      clauses: [], // model forgot to cite them — still claimed from arms / by
      by: [{ field: "ds.attendance.emp", words: "for each employee" }],
      measures: [{ fn: "band_count", field: "ds.attendance.hours", words: "Absence days", bands: [
        { test: "equals", value: "0.5", then: 0.5, words: "half" },
        { test: "equals", value: "1", then: 1, words: "full" },
        { test: "equals", value: "0", then: 0, words: "present" },
      ] }],
    };
    p.sources = [{ ref: "ds.attendance.new_read", clauses: [], quote: "attendance", also: [] }];
    p.actions = [{ ref: "mail_send", clauses: cs.filter((c) => /email/i.test(c.text)).map((c) => c.id), quote: "email", on: "always", per_item: false, approve_first: null, recipient: { from: "requester", words: "me", field: "n/a" }, heading: "", sends: "rows" } as Plan["actions"][number]];
    const f = planFindings(p, cs, CAT).join("\n");
    expect(f).not.toMatch(/for each employee/);
    expect(f).not.toMatch(/Weight half|full = 1|present = 0/);
    expect(f).not.toMatch(/implemented by nothing/);
  });
});

