import { describe, expect, it } from "vitest";
import { checkOutputShape, tyOfOutputShape, type OutputShape } from "./output-shape.js";
import { T } from "./types.js";

const MANAGER: OutputShape = {
  type: "object",
  fields: {
    employee_id: { type: "integer" },
    manager: { type: "object", nullable: true, fields: { full_name: { type: "string" }, work_email: { type: "string", format: "email", nullable: true } } },
    reason: { type: "string", optional: true },
  },
};

describe("tyOfOutputShape (compiled-builder 2c)", () => {
  it("types a declared tool output, with null and absence both as Option", () => {
    expect(tyOfOutputShape(MANAGER)).toEqual(T.record({
      employee_id: T.int(),
      manager: T.option(T.record({ full_name: T.text(), work_email: T.option(T.address()) })),
      reason: T.option(T.text()),
    }));
  });
  it("an array of records is a List of Record", () => {
    expect(tyOfOutputShape({ type: "array", items: { type: "object", fields: { id: { type: "integer" } } } })).toEqual(T.list(T.record({ id: T.int() })));
  });
});

describe("checkOutputShape — the contract test's judge", () => {
  it("accepts a conforming value, including a declared null and a declared absence", () => {
    expect(checkOutputShape({ employee_id: 1, manager: null }, MANAGER)).toEqual([]);
    expect(checkOutputShape({ employee_id: 1, manager: { full_name: "A", work_email: null }, reason: "x" }, MANAGER)).toEqual([]);
  });
  it("names every violation by path", () => {
    expect(checkOutputShape({ employee_id: "1", manager: { work_email: 3 } }, MANAGER)).toEqual([
      "$.employee_id: expected an integer, got \"1\"",
      "$.manager.full_name: missing",
      "$.manager.work_email: expected a string, got number",
    ]);
  });
  it("⚠ refuses a null the declaration did not allow — a forgotten `nullable` fails loudly, not silently", () => {
    expect(checkOutputShape({ employee_id: null, manager: null }, MANAGER)).toEqual(["$.employee_id: null, but not declared nullable"]);
  });
  it("allows fields the declaration does not name (a tool may return more; nothing may read them)", () => {
    expect(checkOutputShape({ employee_id: 1, manager: null, extra: true }, MANAGER)).toEqual([]);
  });
});
