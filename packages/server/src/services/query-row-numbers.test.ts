import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { coerceDeclaredNumbers, coerceNumberColumns, coerceSqlParams, numberColumns, pgArrayLiteral } from "./query-row-numbers.js";

describe("a number column arrives as a number (phase 7, R05)", () => {
  it("picks the columns by the driver's TYPE, not by how the value looks", () => {
    const pg = numberColumns([{ name: "rate", dataTypeID: 1700 }, { name: "n", dataTypeID: 20 }, { name: "code", dataTypeID: 25 }], "pg");
    expect([...pg]).toEqual(["rate", "n"]);
    const my = numberColumns([{ name: "amt", columnType: 246 }, { name: "id", columnType: 8 }, { name: "s", columnType: 253 }], "mysql");
    expect([...my]).toEqual(["amt", "id"]);
  });

  it("converts what parses, keeps a huge integer and non-numbers as text", () => {
    const rows = [{ rate: "7644.8", n: "12", code: "007", big: "9007199254740993", odd: "NaN", nul: null }];
    const out = coerceNumberColumns(rows, new Set(["rate", "n", "big", "odd", "nul"]));
    expect(out).toEqual([{ rate: 7644.8, n: 12, code: "007", big: "9007199254740993", odd: "NaN", nul: null }]);
    // A column not reported as a number is never touched, whatever it holds.
    expect(coerceNumberColumns(rows, new Set())[0]).toBe(rows[0]);
  });
});

describe("a param declared as a number is sent as one (phase 7, L1)", () => {
  const schema = { row_limit: { type: "number" }, n: { type: "integer" }, code: { type: "string" } };
  it("turns a FLOAT input's rendering into a number, and leaves text alone", () => {
    expect(coerceDeclaredNumbers({ row_limit: "80.0", n: "80.0", code: "80.0" }, schema)).toEqual({ row_limit: 80, n: 80, code: "80.0" });
  });
  it("an integer param keeps a non-integral value for the database to refuse by name", () => {
    expect(coerceDeclaredNumbers({ n: "80.5" }, schema)).toEqual({ n: "80.5" });
  });
  it("untouched when nothing is declared, or the value is already a number", () => {
    const p = { row_limit: 5 };
    expect(coerceDeclaredNumbers(p, schema)).toBe(p);
    expect(coerceDeclaredNumbers({ x: "1" }, null)).toEqual({ x: "1" });
  });
});

describe("every executor uses the normalisers (a helper nothing calls is I-120)", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  it("step-execution: rows for Postgres and MySQL, params for SQL and tools", () => {
    const src = read("./step-execution.service.ts");
    expect(src.length).toBeGreaterThan(1000);
    expect(src.match(/coerceNumberColumns\(/g)?.length).toBe(2);
    expect(src.match(/coerceDeclaredNumbers\(/g)?.length).toBe(1); // tools
    expect(src.match(/coerceSqlParams\(/g)?.length).toBe(1); // the SQL batch, before its paths split
  });
  it("the mock engine: rows", () => {
    expect(read("./mock-engine/pglite.driver.ts")).toMatch(/coerceNumberColumns\(/);
  });
});

describe("a param declared as an array reaches SQL as a Postgres array (phase 7, R03)", () => {
  const schema = { statuses: { type: "array" }, n: { type: "number" }, s: { type: "string" } };
  it("a list, or JSON text of one, becomes an array literal — only when declared array", () => {
    expect(coerceSqlParams({ statuses: '["active","on_leave"]', n: "3", s: '["x"]' }, schema)).toEqual({
      statuses: '{"active","on_leave"}',
      n: 3,
      s: '["x"]',
    });
    expect(coerceSqlParams({ statuses: ["a", null, 2] }, schema)).toEqual({ statuses: '{"a",NULL,2}' });
  });
  it("escapes quotes and backslashes, and leaves a nested structure for the database to refuse", () => {
    expect(pgArrayLiteral(['a"b', "c\\d"])).toBe('{"a\\"b","c\\\\d"}');
    expect(pgArrayLiteral([["x"]])).toBeNull();
    expect(coerceSqlParams({ statuses: [["x"]] }, schema)).toEqual({ statuses: [["x"]] });
  });
});
