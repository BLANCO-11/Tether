/** A question says a read's identifiers in a person's words (2026-10-04: "sum of attendance_day.hours_worked" in a chat question). */
import { describe, expect, it } from "vitest";
import { plainWords } from "./builder.service.js";

describe("plainWords", () => {
  it("a table.column is the column's words; any other snake_case name is its words", () => {
    expect(plainWords("the monthly count of attendance_day rows and sum of attendance_day.hours_worked"))
      .toBe("the monthly count of attendance day rows and sum of hours worked");
    expect(plainWords("loans.due_date before today")).toBe("due date before today");
  });
  it("CONTROL: an address, a dotted name with no underscore, and plain words are left as they are", () => {
    expect(plainWords("email first_name.last@lib.example")).toBe("email first_name.last@lib.example");
    expect(plainWords("see lib.example and the loans")).toBe("see lib.example and the loans");
  });
});
