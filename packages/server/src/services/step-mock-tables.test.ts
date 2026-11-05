/**
 * `mockTablesFromFixture` — the declared shape plus the stored rows.
 *
 * ⚠ **This is the unit behind the 2026-09-18 type defect.** The function used
 * to take `rows_json` alone and type every column by guessing at its JSON
 * values; `rows_json` is JSONB, so every timestamp, date and uuid arrived as a
 * string and became `text`. Measured on one live fixture: 266 of 667 columns
 * mistyped, 114 of them date/time. What these tests pin is that the types now
 * come from a declaration, and that every way the two halves can disagree is a
 * refusal rather than a guess.
 */
import { describe, expect, it } from "vitest";
import { mockTablesFromFixture } from "./step-execution.service.js";
import type { MockFileTable } from "./mock-file-store.js";

const declared = (
  name: string,
  columns: Array<[string, string]>,
): MockFileTable => ({
  name,
  columns: columns.map(([n, t]) => ({ name: n, type: t })),
  rows: [],
});

describe("mockTablesFromFixture", () => {
  it("⚠ takes each column's type from the DECLARATION, never from the row's value", () => {
    const tables = mockTablesFromFixture(
      "ML_ZERO_DB",
      [declared("public.o", [["id", "uuid"], ["joiningDate", "timestamp"]])],
      { "public.o": [{ id: "7b6f-…", joiningDate: "2026-01-15T17:00:55.403Z" }] },
    );
    // Both values are JSON strings. Guessing from them is what produced
    // `operator does not exist: text >= timestamp without time zone`.
    expect(tables[0]!.columns).toEqual([
      { name: "id", type: "uuid" },
      { name: "joiningDate", type: "timestamp" },
    ]);
  });

  it("carries the rows from the fixtures row, which stays authoritative for them", () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const tables = mockTablesFromFixture("ds", [declared("t", [["id", "integer"]])], { t: rows });
    expect(tables[0]!.rows).toEqual(rows);
  });

  it("drops the schema qualifier so a frozen `FROM users` meets `public.users`", () => {
    const tables = mockTablesFromFixture("ds", [declared("public.users", [["id", "integer"]])], {});
    expect(tables[0]!.name).toBe("users");
  });

  it("⚠ CREATES a declared table with no rows — an empty result, not a missing relation", () => {
    // It used to be absent entirely, so a correct query touching it died with
    // `relation "audit" does not exist` — a structural error for an empty table.
    const tables = mockTablesFromFixture("ds", [declared("audit", [["id", "integer"]])], {});
    expect(tables).toHaveLength(1);
    expect(tables[0]!.rows).toEqual([]);
  });

  it("⚠ declares a column no row carries a value for — the type survives an all-null column", () => {
    const tables = mockTablesFromFixture(
      "ds",
      [declared("t", [["id", "integer"], ["deleted_at", "timestamptz"]])],
      { t: [{ id: 1 }] },
    );
    expect(tables[0]!.columns.map((c) => c.name)).toEqual(["id", "deleted_at"]);
  });

  it("refuses two keys that collapse onto one bare name, naming both", () => {
    expect(() =>
      mockTablesFromFixture(
        "ds",
        [declared("public.staff", [["id", "integer"]]), declared("hr.staff", [["id", "integer"]])],
        {},
      ),
    ).toThrow(/both load as table "staff"/);
  });

  it("⚠ refuses rows for a table the shape does not declare", () => {
    expect(() =>
      mockTablesFromFixture("ds", [declared("a", [["id", "integer"]])], { a: [], b: [{ id: 1 }] }),
    ).toThrow(/"b", which its declared shape does not name/);
  });

  it("⚠ refuses a row column the shape does not declare — never loads an untyped column", () => {
    expect(() =>
      mockTablesFromFixture("ds", [declared("t", [["id", "integer"]])], {
        t: [{ id: 1, joiningDate: "2026-01-15T17:00:55.403Z" }],
      }),
    ).toThrow(/column "joiningDate" that its declared shape does not name/);
  });

  it("every refusal is a 409, like the mock-status refusals it sits beside", () => {
    try {
      mockTablesFromFixture("ds", [], { b: [{ id: 1 }] });
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as { status?: number }).status).toBe(409);
    }
  });
});
