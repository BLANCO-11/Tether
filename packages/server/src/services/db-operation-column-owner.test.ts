import { describe, expect, it } from "vitest";
import { compileOperation, dbOperationSpecSchema } from "./db-operation.service.js";
import type { DbOperationSpecInput } from "./db-operation.service.js";

/**
 * Which table a bare column name belongs to — Jev programme phase 4a.3.
 *
 * ── The defect ───────────────────────────────────────────────────────────────
 *
 * `resolveColumn` walks the owner chain and the FIRST table holding the name
 * wins. That is deterministic, it is documented, and it was **invisible**: join
 * two tables that both have `id` or `status`, and the operation silently read
 * one of them with nothing anywhere saying a choice had been made. CLAUDE.md
 * records it as a real gap in the **visual** builder too, which is why it is
 * not a drafting problem and cannot be fixed in a prompt.
 *
 * ── The two halves, and why they ship together ───────────────────────────────
 *
 *  1. **The choice is reported** — `CompiledOperation.ambiguousColumns`.
 *  2. **The choice can be overridden** — `table.column` / `schema.table.column`.
 *
 * Half 1 alone is a warning with no remedy; half 2 alone is a spelling nobody
 * knows they need. Both directions are asserted here.
 *
 * ⚠ **Ambiguity is NOT a finding, and that asymmetry is the decision under
 * test.** Findings are thrown (`throw compileError(findings)`), and joining on
 * `id` is the ordinary case — a refusal would reject most correct operations in
 * the product on day one, which is the control everybody routes around (D-52).
 * The tests below therefore assert that an ambiguous operation still COMPILES,
 * and would go red if somebody "strengthened" this into a refusal.
 */

// ── fixture: two tables that genuinely share column names ───────────────────
//
// `id` is on both. `status` is on both. `full_name` is on employees alone.
// The overlap is the subject, so it is stated here rather than borrowed from a
// fixture written for something else.
const row = (entityName: string, columnName: string | null, columnType: string | null) => ({
  id: `s-${entityName}-${columnName ?? "meta"}`,
  datasourceId: "ds1",
  entityType: "table",
  entitySchema: null,
  entityName,
  columnName,
  columnType,
  isPrimaryKey: false,
  isForeignKey: false,
  foreignKeyReference: null,
  nullable: true,
  characterMaximumLength: null,
  semanticTag: null, valueDomain: null,
  rowCountEstimate: null,
  nullPercentage: null,
  extractedAt: new Date("2026-08-01T00:00:00Z"),
});

const schemaRows = [
  row("attendance_monthly", "id", "integer"),
  row("attendance_monthly", "employee_id", "integer"),
  row("attendance_monthly", "status", "character varying"),
  row("attendance_monthly", "period", "character"),
  row("employees", "id", "integer"),
  row("employees", "full_name", "character varying"),
  row("employees", "status", "character varying"),
];

/** A two-table spec whose filter column is supplied by the caller. */
const specFiltering = (column: string): DbOperationSpecInput =>
  ({
    base: { table: "attendance_monthly" },
    joins: [{ table: "employees", kind: "inner", onLeft: "employee_id", onRight: "id" }],
    columns: [{ alias: "who", column: "full_name" }],
    filters: [{ column, op: "eq", param: "want" }],
  }) as unknown as DbOperationSpecInput;

describe("a bare column name that two joined tables could have meant", () => {
  it("still compiles — it is reported, never refused", () => {
    // ⚠ The load-bearing assertion in this file. If somebody turns the report
    // into a finding, `compileOperation` throws and this goes red before the
    // reporting assertions below get a chance to.
    expect(() => compileOperation(specFiltering("status"), schemaRows)).not.toThrow();
  });

  it("names the winner and every other table that has it", () => {
    const c = compileOperation(specFiltering("status"), schemaRows);
    expect(c.ambiguousColumns).toEqual([
      { column: "status", resolvedTo: "attendance_monthly", alsoOn: ["employees"] },
    ]);
  });

  it("reads the base table, which is the behaviour that was already there", () => {
    // The SQL is unchanged by this feature. Reporting a choice must not also
    // silently change it — that would be a second, invisible behaviour change
    // arriving under cover of making the first one visible.
    const c = compileOperation(specFiltering("status"), schemaRows);
    expect(c.sql).toContain('"t0"."status" = $1');
  });

  it("says nothing when only one table has the column", () => {
    // The control. Without it, a version that reports EVERY column passes every
    // assertion above — "always ambiguous" and "correctly ambiguous" are
    // indistinguishable on a positive case alone (I-38).
    const c = compileOperation(specFiltering("full_name"), schemaRows);
    expect(c.ambiguousColumns).toEqual([]);
  });

  it("says nothing on a single-table operation, however many columns it reads", () => {
    const c = compileOperation(
      {
        base: { table: "attendance_monthly" },
        columns: [{ alias: "s", column: "status" }, { alias: "i", column: "id" }],
        filters: [{ column: "period", op: "eq", param: "p" }],
      } as unknown as DbOperationSpecInput,
      schemaRows,
    );
    expect(c.ambiguousColumns).toEqual([]);
  });
});

describe("the qualified spelling — the remedy the report points at", () => {
  it("reads the table the author named, not the first one in the chain", () => {
    const c = compileOperation(specFiltering("employees.status"), schemaRows);
    expect(c.sql).toContain('"t1"."status" = $1');
    // ⚠ Both halves matter. Emitting `t1` while still reporting the column as
    // ambiguous would tell a person a choice was made on their behalf when they
    // made it themselves — a warning that fires on the fix for it is I-62.
    expect(c.ambiguousColumns).toEqual([]);
  });

  it("emits the BARE name, never the qualifier", () => {
    // `"t1"."employees.status"` is not a column. It would compile here and fail
    // at the database, which is the worst place for this to surface.
    const c = compileOperation(specFiltering("employees.status"), schemaRows);
    expect(c.sql).not.toContain("employees.status");
  });

  it("accepts a schema-qualified spelling", () => {
    const schemaed = schemaRows.map((r) => ({ ...r, entitySchema: "public" }));
    const c = compileOperation(specFiltering("public.employees.status"), schemaed);
    expect(c.sql).toContain('"t1"."status" = $1');
  });

  it("refuses a qualifier naming a table the operation does not read", () => {
    // ⚠ NOT a fallback to bare resolution. A qualifier that resolves nowhere is
    // a typo or a missing join; resolving it somewhere else anyway would be
    // exactly the silent wrong answer this whole task exists to remove,
    // arriving through the fix for it.
    expect(() => compileOperation(specFiltering("departments.status"), schemaRows)).toThrow(
      /names table "departments", which this operation does not read/,
    );
  });

  it("refuses a qualifier whose column is not on the table it names", () => {
    expect(() => compileOperation(specFiltering("employees.period"), schemaRows)).toThrow(
      /no column "period" on employees/,
    );
  });

  it("qualifies a sort column and a join correlation too, not only a filter", () => {
    const c = compileOperation(
      {
        base: { table: "attendance_monthly" },
        joins: [
          { table: "employees", kind: "inner", onLeft: "attendance_monthly.employee_id", onRight: "id" },
        ],
        columns: [{ alias: "who", column: "full_name" }],
        sort: [{ column: "employees.status", dir: "asc" }],
      } as unknown as DbOperationSpecInput,
      schemaRows,
    );
    expect(c.sql).toContain('"t0"."employee_id" = "t1"."id"');
    expect(c.sql).toContain('ORDER BY "t1"."status" ASC');
  });

  it("is REJECTED BY THE SCHEMA where a qualifier could not disambiguate anything", () => {
    // ⚠ The scoping control lives on zod, not in `compileOperation` — the
    // compiler is handed an already-parsed spec, and its resolver would accept
    // `employees.id` against a one-table chain quite happily. So it is asserted
    // where it actually is. `onRight` resolves against the single table being
    // joined, where a qualifier answers no question; keeping `IDENTIFIER` there
    // is what stops the spelling being decorative in most positions and
    // load-bearing in a few.
    const withQualifiedOnRight = {
      base: { table: "attendance_monthly" },
      joins: [{ table: "employees", kind: "inner", onLeft: "employee_id", onRight: "employees.id" }],
      columns: [{ alias: "who", column: "full_name" }],
    };
    expect(dbOperationSpecSchema.safeParse(withQualifiedOnRight).success).toBe(false);

    // The control for that assertion: the SAME spec with a bare `onRight`
    // parses. Without it, a schema that rejected everything would pass above.
    expect(
      dbOperationSpecSchema.safeParse({
        ...withQualifiedOnRight,
        joins: [{ table: "employees", kind: "inner", onLeft: "employee_id", onRight: "id" }],
      }).success,
    ).toBe(true);
  });

  it("accepts a qualifier on the fields that resolve against the whole chain", () => {
    // The other direction of the same rule: `filters[].column` IS chain-resolved,
    // so the qualifier must survive parsing to reach the compiler at all.
    expect(
      dbOperationSpecSchema.safeParse({
        base: { table: "attendance_monthly" },
        joins: [{ table: "employees", kind: "inner", onLeft: "employee_id", onRight: "id" }],
        columns: [{ alias: "who", column: "full_name" }],
        filters: [{ column: "employees.status", op: "eq", param: "want" }],
        sort: [{ column: "public.employees.status", dir: "asc" }],
      }).success,
    ).toBe(true);
  });

  it("still refuses a fourth dotted segment, and an empty one", () => {
    const bad = (column: string) =>
      dbOperationSpecSchema.safeParse({
        base: { table: "attendance_monthly" },
        columns: [{ alias: "s", column: "status" }],
        filters: [{ column, op: "eq", param: "want" }],
      }).success;
    expect(bad("a.b.c.d")).toBe(false);
    expect(bad("employees.")).toBe(false);
    expect(bad(".status")).toBe(false);
    expect(bad("employees..status")).toBe(false);
  });
});

describe("a bare name still wins outright where one exists", () => {
  it("prefers a real column containing a dot over reading it as a qualifier", () => {
    // Postgres permits `"a.b"` as a column name, and every spec written before
    // qualifiers existed used bare names only. Trying the whole string first is
    // what makes this change incapable of reinterpreting an identifier that
    // already resolves.
    const odd = [...schemaRows, row("attendance_monthly", "employees.status", "text")];
    const c = compileOperation(specFiltering("employees.status"), odd);
    expect(c.sql).toContain('"t0"."employees.status" = $1');
  });
});

/**
 * ⚠ **One entry per ambiguous column, not per place it is read** — added
 * 2026-09-22 after `ambiguity:measure` printed `status`, `cve` and `id` TWICE
 * each against real saved operations. Found by measuring, not by reading.
 */
describe("the report is per column, not per resolution site", () => {
  const readTwice: DbOperationSpecInput = {
    base: { table: "attendance_monthly" },
    joins: [{ table: "employees", kind: "inner", onLeft: "employee_id", onRight: "id" }],
    columns: [{ alias: "who", column: "full_name" }],
    // `status` is on BOTH tables and is read in a filter AND a sort.
    filters: [{ column: "status", op: "eq", param: "want" }],
    sort: [{ column: "status", dir: "asc" }],
  } as unknown as DbOperationSpecInput;

  it("lists a column read in two clauses once", () => {
    const c = compileOperation(readTwice, schemaRows);
    expect(c.ambiguousColumns).toEqual([
      { column: "status", resolvedTo: "attendance_monthly", alsoOn: ["employees"] },
    ]);
  });

  it("the control: it is still reported at all", () => {
    // Without this, a dedupe that dropped everything passes the assertion above
    // only if you read it carefully — an empty array is not one entry.
    expect(compileOperation(readTwice, schemaRows).ambiguousColumns).toHaveLength(1);
  });

  it("a qualified read is not reported, so it cannot pad the list", () => {
    const split = {
      ...(readTwice as unknown as Record<string, unknown>),
      filters: [{ column: "status", op: "eq", param: "want" }],
      sort: [{ column: "employees.status", dir: "asc" }],
    } as unknown as DbOperationSpecInput;
    expect(compileOperation(split, schemaRows).ambiguousColumns).toEqual([
      { column: "status", resolvedTo: "attendance_monthly", alsoOn: ["employees"] },
    ]);
  });
});

/**
 * ⚠ **STATED, NOT TESTED: the dedupe key's `resolvedTo` half is currently
 * UNREACHABLE, and keying on the column alone passes every test above.**
 *
 * Found by perturbing, not by reading — the perturbation that should have gone
 * red did not. For one name to be reported twice with two different winners,
 * two `resolveColumn` calls would have to see different first-holders; but
 * `owners` only ever GROWS during a compile and its order is stable, so the
 * first holder of a given name cannot change within one operation.
 *
 * The composite key is kept deliberately, as the `conjoinConditions` unreachable
 * throw is kept: it is the assertion that a merge never collapses two genuinely
 * different answers, and it becomes reachable the day anything resolves against
 * a re-ordered or narrowed chain. Recording it as unreachable is the honest
 * alternative to a test that fabricates the state — `platform-user.test.ts`'s
 * lesson, where an assertion passed over a successful write.
 */
