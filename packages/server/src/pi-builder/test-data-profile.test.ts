import { describe, expect, it } from "vitest";
import { profileFixture, profileTable } from "./test-data-profile.js";

describe("the test-data profile Pi reads", () => {
  it("states a date column's range — what Pi needed to choose a month that has rows", () => {
    const p = profileTable([{ work_date: "2024-03-09" }, { work_date: "2024-01-15" }, { work_date: "2024-02-01" }]);
    expect(p.rows).toBe(3);
    expect(p.columns.work_date).toEqual({ empty: 0, min: "2024-01-15", max: "2024-03-09" });
  });

  it("numbers get a range, a column with few values lists them, one with many gives a sample and the count", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ hours: i + 0.5, dept: i % 2 ? "Ops" : "HR", id: `e${i}` }));
    const p = profileTable(rows);
    expect(p.columns.hours).toMatchObject({ min: 0.5, max: 11.5 });
    expect(p.columns.dept).toEqual({ empty: 0, distinct: 2, values: ["HR", "Ops"] });
    expect(p.columns.id).toMatchObject({ distinct: 12 });
    expect(p.columns.id.values).toHaveLength(3);
  });

  it("counts empty values, and a column empty everywhere says only that", () => {
    const p = profileTable([{ a: null, b: " " }, { a: 1, b: "" }]);
    expect(p.columns.a).toEqual({ empty: 1, min: 1, max: 1 });
    expect(p.columns.b).toEqual({ empty: 2 });
  });

  it("keys a fixture's tables as the fixture does", () => {
    expect(Object.keys(profileFixture({ "main.employee": [{ id: 1 }], "main.attendance_day": [] }))).toEqual(["main.employee", "main.attendance_day"]);
  });
});
