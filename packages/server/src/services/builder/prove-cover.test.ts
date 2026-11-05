import { describe, expect, it } from "vitest";
import { bandReturnContract, clausesProvenBy, shouldRewrite } from "./prove-cover.js";

describe("bandReturnContract extra columns", () => {
  it("includes shape-asked column names", () => {
    const line = bandReturnContract(["goal"], [{ words: "absences" }], [], ["emp_id", "emp_name"]);
    expect(line).toMatch(/emp_id/);
    expect(line).toMatch(/emp_name/);
  });
  it("names the group-by column and the measure column", () => {
    const line = bandReturnContract(["goal"], [{ words: "absences" }], [{ field: "emp_id", words: "employee" }]);
    expect(line).toMatch(/emp_id/);
    expect(line).toMatch(/absences/);
  });
});

describe("shouldRewrite", () => {
  it("a changed contract forces rewrite", () => {
    expect(shouldRewrite({ p: "a" }, { p: "b" })).toBe(true);
  });
  it("CONTROL: identical contracts do not rewrite", () => {
    expect(shouldRewrite({ p: "a" }, { p: "a" })).toBe(false);
  });
});

describe("clausesProvenBy", () => {
  it("a clause is proven when one of its own words appears in the evidence blob", () => {
    expect(clausesProvenBy(["full day = 0 to 4.74 hours"], { aliases: ["band_count_full_day_absences"] })).toEqual([
      "full day = 0 to 4.74 hours",
    ]);
  });
  it("CONTROL: empty evidence proves nothing", () => {
    expect(clausesProvenBy(["full day = 0 to 4.74 hours"], { aliases: [] })).toEqual([]);
  });
  it("CONTROL: a clause with no word in the blob is not proven", () => {
    expect(clausesProvenBy(["full day = 0 to 4.74 hours"], { aliases: ["zzz_qqq"] })).toEqual([]);
  });
});
