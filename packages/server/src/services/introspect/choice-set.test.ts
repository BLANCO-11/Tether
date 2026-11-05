/**
 * The one rule for which column values Foundry may know without reading rows (2026-10-10). A column qualifies when the
 * DATA is a set of choices; its NAME can only exclude it. Each exclusion has a firing case and a control.
 */
import { describe, expect, it } from "vitest";
import { identifyingName, isChoiceSet, OBSERVE_MAX } from "./choice-set.js";

describe("identifyingName — a name can only EXCLUDE a column", () => {
  it("columns named for a person, an identifier or free text are never read", () => {
    for (const n of ["email", "work_email", "full_name", "emp_name", "phone", "address", "notes", "invoice_number", "vendor_code", "user_id",
      "referrerEmployeeId", "agencyName", "created_by", "error", "owner_status", "candidateStatus", "badge", "hostname"])
      expect(identifyingName(n), n).toBe(true);
  });
  it("⚠ a category NOT named like one is read — dept, division, geo, level, location (they were mock before)", () => {
    for (const n of ["dept", "division", "geo", "level", "location", "function", "leave_type", "leave_kind", "half", "region", "tier", "status", "jobStatus"])
      expect(identifyingName(n), n).toBe(false);
  });
});

describe("isChoiceSet — the DATA decides", () => {
  it("few values, each recurring, is a set of choices", () => {
    expect(isChoiceSet(["Finance", "HR", "Engineering"], 60)).toBe(true);
  });
  it("too many distinct values is not", () => {
    expect(isChoiceSet(Array.from({ length: OBSERVE_MAX + 1 }, (_, i) => `v${i}`), 1000)).toBe(false);
  });
  it("⚠ a tiny table's unique values are not (12 rows, 12 names), though 12 is under the cap", () => {
    expect(isChoiceSet(Array.from({ length: 12 }, (_, i) => `Person ${i}`), 12)).toBe(false);
  });
  it("one identifying-looking value taints the column — an email or a long number", () => {
    expect(isChoiceSet(["active", "ops@acme.example"], 40)).toBe(false);
    expect(isChoiceSet(["active", "4400123456"], 40)).toBe(false);
    expect(isChoiceSet(["active", "closed"], 40)).toBe(true); // control
  });
  it("prose and blanks are not choices", () => {
    expect(isChoiceSet(["a".repeat(65), "b"], 40)).toBe(false);
    expect(isChoiceSet(["", "b"], 40)).toBe(false);
  });
  it("nothing is not a set", () => {
    expect(isChoiceSet([], 0)).toBe(false);
  });
});
