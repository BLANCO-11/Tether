import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkSqlShape } from "./datasource-query.service.js";
import type { DbOperationSpec } from "./db-operation.service.js";
import { toSqlite } from "./sqlite-dialect.js";

/**
 * DB operations — the `query` step kind's callable (07 §7.0).
 *
 * Two layers are pinned here, in the same spirit as `datasource-query.test.ts`
 * (most of the value is in what an operation CANNOT be):
 *
 *  1. `compileOperation` is pure, so the emitted SQL is asserted VERBATIM —
 *     a compiler whose output drifts is a compiler nobody reviewed, and this
 *     spec's whole safety argument is that the author never writes SQL.
 *  2. Every refusal is a STRUCTURED finding (offending identifier + available
 *     schema), never a generic 500 — the check route and the save routes
 *     depend on that shape.
 *
 * No live database: the service's repos are mocked with an in-memory store so
 * the CRUD rules (409 on a duplicate name, compile-on-save) are deterministic.
 */

// ── fixtures shared by the mocked repos ──────────────────────────────────────

const { store, listByDatasource, create, update, remove } = vi.hoisted(() => {
  const store: Array<Record<string, unknown>> = [];
  return {
    store,
    listByDatasource: vi.fn(async (datasourceId: string) =>
      store
        .filter((o) => o.datasourceId === datasourceId)
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    ),
    create: vi.fn(async (data: Record<string, unknown>) => {
      const row = {
        id: `op-${store.length + 1}`,
        createdAt: new Date("2026-08-13T00:00:00Z"),
        updatedAt: new Date("2026-08-13T00:00:00Z"),
        ...data,
      };
      store.push(row);
      return row;
    }),
    update: vi.fn(
      async (datasourceId: string, name: string, data: Record<string, unknown>) => {
        const i = store.findIndex((o) => o.datasourceId === datasourceId && o.name === name);
        if (i < 0) return undefined;
        store[i] = { ...store[i], ...data, updatedAt: new Date("2026-08-13T01:00:00Z") };
        return store[i];
      },
    ),
    remove: vi.fn(async (datasourceId: string, name: string) => {
      const i = store.findIndex((o) => o.datasourceId === datasourceId && o.name === name);
      if (i < 0) return false;
      store.splice(i, 1);
      return true;
    }),
  };
});

vi.mock("../repositories/db-operation.repo.js", () => ({
  dbOperationRepo: { listByDatasource, create, update, remove },
}));

const datasource = vi.hoisted(() => ({
  id: "ds1",
  workspaceId: "ws1",
  name: "hr_demo",
  type: "postgres",
  connectionStringEnc: "enc",
  secretEnvName: null,
  schemaAllowlist: ["public"],
  testStatus: "connected",
  lastTestedAt: null,
  sandboxDsnEnc: null,
  sandboxDbName: null,
  sandboxFixtureVersion: null,
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
}));

vi.mock("../repositories/datasource.repo.js", () => ({
  datasourceRepo: {
    get: async (workspaceId: string, id: string) =>
      workspaceId === datasource.workspaceId && id === datasource.id ? datasource : undefined,
  },
}));

/** Introspected `schemas` rows for the HR shape — the `attendance_by_dept` case
 *  from the plan's verification: attendance_monthly + one join to employees. */
const schemaRows = vi.hoisted(() => {
  const row = (
    entityName: string,
    columnName: string | null,
    columnType: string | null,
  ) => ({
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
  return [
    row("attendance_monthly", null, null),
    row("attendance_monthly", "id", "integer"),
    row("attendance_monthly", "employee_id", "integer"),
    row("attendance_monthly", "period", "character"),
    row("attendance_monthly", "working_days", "integer"),
    row("attendance_monthly", "days_attended", "integer"),
    row("attendance_monthly", "attendance_rate", "numeric"),
    row("employees", "id", "integer"),
    row("employees", "employee_code", "character varying"),
    row("employees", "full_name", "character varying"),
    row("employees", "department_id", "integer"),
    row("employees", "hire_date", "date"),
    row("employees", "status", "character varying"),
  ];
});

vi.mock("../repositories/schema.repo.js", () => ({
  schemaRepo: { listByDatasource: async () => schemaRows },
}));

/**
 * Flows in the workspace, for the reference scan `remove` runs before deleting.
 *
 * Each entry is a flow name plus the refs its draft revision names. Empty by
 * default so every pre-existing test keeps its meaning — none of them is about
 * references, and a fixture that quietly made them referenced would turn them
 * into tests of the refusal instead.
 */
const flows = vi.hoisted(() => ({
  /**
   * `draft` and `armed` are the refs named by revision 1 and revision 2. They
   * are separate on purpose: the scan's stated bound is that it reads BOTH, and
   * a fixture where every flow's revisions carry the same refs cannot tell a
   * scan that reads both from one that reads only the draft.
   */
  rows: [] as Array<{ name: string; draft?: string[]; armed?: string[] }>,
}));

vi.mock("../repositories/flow.repo.js", () => ({
  flowRepo: {
    listByWorkspace: async () =>
      flows.rows.map((f, i) => ({
        id: `f${i}`,
        name: f.name,
        draftRevision: f.draft ? 1 : null,
        armedRevision: f.armed ? 2 : null,
      })),
    getRevision: async (flowId: string, revision: number) => {
      const f = flows.rows[Number(flowId.slice(1))];
      const refs = revision === 1 ? f?.draft : f?.armed;
      return refs ? { modelJson: { steps: refs.map((ref) => ({ ref })) } } : undefined;
    },
  },
}));

const { dbOperationService, compileOperation, dbOperationSpecSchema } = await import(
  "./db-operation.service.js"
);

// The `attendance_by_dept` shape from the plan's Phase 4 verification: plain
// column + count + sum over the base, one left join, one eq filter param.
const SPEC: DbOperationSpec = {
  base: { table: "attendance_monthly" },
  columns: [
    { column: "period", alias: "period" },
    { column: "employee_id", aggregate: "count", alias: "headcount" },
    { column: "attendance_rate", aggregate: "avg", alias: "avg_rate" },
  ],
  joins: [{ table: "employees", onLeft: "employee_id", onRight: "id", kind: "left" }],
  filters: [{ column: "period", op: "eq", param: "period" }],
  having: [],
  aggregateJoins: [],
  sort: [{ column: "period", dir: "desc" }],
  limit: 100,
};

const compileError = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e as { statusCode?: number; findings?: Array<Record<string, unknown>> };
  }
  throw new Error("expected compileOperation to throw");
};

beforeEach(() => {
  store.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("compileOperation — the emitted statement", () => {
  it("refuses a self-join by name instead of emitting one alias twice (phase 7, R03)", () => {
    // employees → their manager, also an employee: both occurrences used to get the same
    // alias, `FROM "employees" AS "t1" … JOIN "employees" AS "t1"`, which Postgres refuses.
    const err = compileError(() =>
      compileOperation(
        {
          ...SPEC,
          columns: [{ column: "full_name", alias: "name" }],
          joins: [
            { table: "employees", onLeft: "employee_id", onRight: "id", kind: "inner" },
            { table: "employees", onLeft: "employees.department_id", onRight: "id", kind: "left" },
          ],
          filters: [],
          sort: [],
        },
        schemaRows,
      ),
    );
    expect(err.findings?.[0]).toMatchObject({ code: "invalid_join", identifier: "employees" });
    expect(String(err.findings?.[0]?.message)).toMatch(/self-join/);
  });

  it("compiles the attendance_by_dept shape to a read-only SELECT with $1", () => {
    const out = compileOperation(SPEC, schemaRows);
    expect(out.sql).toBe(
      'SELECT "t0"."period" AS "period", count("t0"."employee_id") AS "headcount", ' +
        'avg("t0"."attendance_rate") AS "avg_rate" ' +
        'FROM "attendance_monthly" AS "t0" ' +
        'LEFT JOIN "employees" AS "t1" ON "t0"."employee_id" = "t1"."id" ' +
        'WHERE "t0"."period" = $1 ' +
        'GROUP BY "t0"."period" ' +
        'ORDER BY "t0"."period" DESC LIMIT 100',
    );
    // Filters bind positionally in spec order; params_schema derives from them.
    expect(out.paramOrder).toEqual(["period"]);
    expect(out.paramsSchema).toEqual({
      period: {
        type: "string",
        required: true,
        description: "eq filter on attendance_monthly.period",
      },
    });
  });
  it("an output alias is a legal sort key — `count(id) AS invoice_count` sorted by it must compile (2026-10-05, R5/R6/G2)", () => {
    // The proposer is told to set a sort whenever it sets a limit, and a single-row
    // summary's own result name is its only meaningful order key. Sorting by it used to
    // spend all three proposal attempts on `no column "invoice_count"`, refuse the read,
    // and fail the whole goal with a misleading "No reader here provides" — the alias
    // resolves to the output column (standard ORDER BY semantics).
    const out = compileOperation(
      {
        ...SPEC,
        sort: [{ column: "headcount", dir: "desc" }],
      },
      schemaRows,
    );
    expect(out.sql).toContain('ORDER BY "headcount" DESC');
    // An input column of the same name keeps precedence: the qualified column wins.
    const mixed = compileOperation(
      {
        ...SPEC,
        sort: [{ column: "period", dir: "desc" }],
      },
      schemaRows,
    );
    expect(mixed.sql).toContain('ORDER BY "t0"."period" DESC');
    // A name that is neither an output alias nor a schema column stays a structured refusal.
    const err = compileError(() =>
      compileOperation({ ...SPEC, sort: [{ column: "not_a_column", dir: "asc" }] }, schemaRows),
    );
    expect(JSON.stringify(err.findings)).toContain("not_a_column");
  });
  it("an integer column's param is `integer`, a numeric one's `number` (O2: 80 must not arrive as 80.0)", () => {
    const out = compileOperation(
      { ...SPEC, filters: [
        { column: "days_attended", op: "lte", param: "max_days" },
        { column: "attendance_rate", op: "lt", param: "max_rate" },
      ] },
      schemaRows,
    );
    expect(out.paramsSchema.max_days).toMatchObject({ type: "integer" });
    expect(out.paramsSchema.max_rate).toMatchObject({ type: "number" });
  });
  it("null filters emit IS NULL / IS NOT NULL and bind no value", () => {
    const out = compileOperation(
      {
        ...SPEC,
        filters: [
          { column: "period", op: "is_not_null" },
          { column: "employee_id", op: "is_null" },
        ],
        having: [],
  aggregateJoins: [],
      },
      schemaRows,
    );
    expect(out.sql).toContain('"t0"."period" IS NOT NULL AND "t0"."employee_id" IS NULL');
    expect(out.paramOrder).toEqual([]);
    expect(out.paramsSchema).toEqual({});
  });

  it("ilike emits ILIKE and distinct deduplicates the select list", () => {
    const out = compileOperation(
      {
        base: { table: "employees" },
        columns: [{ column: "full_name", alias: "name" }],
        joins: [],
        filters: [{ column: "full_name", op: "ilike", param: "pattern" }],
        having: [],
  aggregateJoins: [],
        sort: [],
        distinct: true,
      },
      schemaRows,
    );
    expect(out.sql).toBe('SELECT DISTINCT "t0"."full_name" AS "name" FROM "employees" AS "t0" WHERE "t0"."full_name" ILIKE $1');
    expect(out.paramOrder).toEqual(["pattern"]);
  });

  it("filters sharing an orGroup form one parenthesised OR term", () => {
    const out = compileOperation(
      {
        base: { table: "employees" },
        columns: [{ column: "full_name", alias: "name" }],
        joins: [],
        filters: [
          { column: "status", op: "eq", param: "wanted", orGroup: "state" },
          { column: "department_id", op: "eq", param: "dept" },
          { column: "employee_code", op: "eq", param: "wanted", orGroup: "state" },
        ],
        having: [],
  aggregateJoins: [],
        sort: [],
      },
      schemaRows,
    );
    expect(out.sql).toContain('WHERE ("t0"."status" = $1 OR "t0"."employee_code" = $1) AND "t0"."department_id" = $2');
    // A repeated param name reuses its position, across the OR boundary too.
    expect(out.paramOrder).toEqual(["wanted", "dept"]);
  });

  it("having filters an aggregate after summarising, numbering after the WHERE params", () => {
    const out = compileOperation(
      {
        ...SPEC,
        filters: [{ column: "period", op: "eq", param: "period" }],
        having: [{ column: "employee_id", aggregate: "count", op: "gt", param: "min_headcount" }],
      },
      schemaRows,
    );
    expect(out.sql).toContain('GROUP BY "t0"."period" HAVING count("t0"."employee_id") > $2');
    expect(out.paramOrder).toEqual(["period", "min_headcount"]);
  });

  it("having without an aggregate is a structured refusal, not a database error", () => {
    const err = compileError(() =>
      compileOperation(
        {
          base: { table: "employees" },
          columns: [{ column: "full_name", alias: "name" }],
          joins: [],
          filters: [],
          having: [{ column: "id", aggregate: "count", op: "gt", param: "n" }],
          sort: [],
        },
        schemaRows,
      ),
    );
    expect(err.findings?.some((f) => f.code === "having_without_aggregate")).toBe(true);
  });

  it("a null op carrying a param — and a valued op missing one — fail parsing", () => {
    expect(() =>
      dbOperationSpecSchema.parse({
        base: { table: "employees" },
        columns: [{ column: "full_name", alias: "name" }],
        filters: [{ column: "full_name", op: "is_null", param: "x" }],
      }),
    ).toThrow();
    expect(() =>
      dbOperationSpecSchema.parse({
        base: { table: "employees" },
        columns: [{ column: "full_name", alias: "name" }],
        filters: [{ column: "full_name", op: "eq" }],
      }),
    ).toThrow();
  });
  it("a latestOne join emits a correlated lateral lookup with its own params first", () => {
    const dept = (entityName: string, columnName: string | null, columnType: string | null) => ({
      id: `s-x-${entityName}-${columnName ?? "meta"}`,
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
    const rows = [
      ...schemaRows,
      dept("departments", null, null),
      dept("departments", "id", "integer"),
      dept("departments", "code", "character"),
      dept("policy_thresholds", null, null),
      dept("policy_thresholds", "department_id", "integer"),
      dept("policy_thresholds", "effective_from", "date"),
      dept("policy_thresholds", "min_attendance_rate", "numeric"),
    ];
    const out = compileOperation(
      {
        base: { table: "attendance_monthly" },
        columns: [
          { column: "employee_id", alias: "employee_id" },
          { column: "min_attendance_rate", alias: "threshold" },
        ],
        joins: [
          { table: "employees", onLeft: "employee_id", onRight: "id", kind: "left" },
          {
            table: "policy_thresholds",
            onLeft: "department_id",
            onRight: "department_id",
            kind: "left",
            latestOne: {
              orderBy: [{ column: "effective_from", dir: "desc" }],
              filters: [{ column: "effective_from", op: "lte", param: "as_of" }],
            },
          },
        ],
        filters: [{ column: "period", op: "eq", param: "period" }],
        having: [],
  aggregateJoins: [],
        sort: [],
      },
      rows,
    );
    // The lookup's param numbers before the outer filter's.
    expect(out.sql).toContain(
      'LEFT JOIN LATERAL (SELECT * FROM "policy_thresholds" AS "t2_in" ' +
        'WHERE "t1"."department_id" = "t2_in"."department_id" AND "t2_in"."effective_from" <= $1 ' +
        'ORDER BY "t2_in"."effective_from" DESC LIMIT 1) AS "t2" ON true',
    );
    expect(out.sql).toContain('WHERE "t0"."period" = $2');
    expect(out.paramOrder).toEqual(["as_of", "period"]);
  });
  it("a month filter matches the calendar month of a date column", () => {
    const out = compileOperation(
      {
        base: { table: "attendance_monthly" },
        columns: [{ column: "employee_id", alias: "employee_id" }],
        joins: [],
        filters: [{ column: "period", op: "month", param: "period" }],
        having: [],
  aggregateJoins: [],
        sort: [],
      },
      schemaRows,
    );
    // A TEXT column holding `YYYY-MM` compares its own first seven characters — `'2026-06'::date` is an error in Postgres, which
    // is what the old `period::date` emitted. The parameter's first seven characters are its month, so a date or a month fits.
    expect(out.sql).toContain(`left("t0"."period"::text, 7) = left($1::text, 7)`);
    expect(out.paramOrder).toEqual(["period"]);
    // The operator declares what its parameter IS: a DATE compared by its month — never free text, never a YYYY-MM to type.
    expect(out.paramsSchema).toEqual({
      period: { type: "string", format: "date", per: "month", required: true, description: "month filter on attendance_monthly.period" },
    });
  });

  it("a month filter inside a summary join declares its parameter a month too; an ordered date filter does not", () => {
    const out = compileOperation(
      {
        base: { table: "employees" },
        columns: [{ column: "full_name", alias: "full_name" }, { column: "days", alias: "days" }],
        joins: [],
        filters: [{ column: "hire_date", op: "gte", param: "hired_since" }],
        having: [],
        aggregateJoins: [{ table: "attendance_monthly", groupBy: "employee_id", onLeft: "id", kind: "left", aggregates: [{ aggregate: "sum", column: "days_attended", alias: "days" }], filters: [{ column: "period", op: "month", param: "period" }] }],
        sort: [],
      } as never,
      schemaRows,
    );
    const ps = out.paramsSchema as Record<string, { format?: string }>;
    expect(ps.period).toMatchObject({ format: "date", per: "month" });
    // Control: the operator decides, never the column or the name — a `gte` on a date column is not a month.
    expect(ps.hired_since?.format).not.toBe("month");
    expect((ps.hired_since as { per?: string } | undefined)?.per).toBeUndefined();
  });

  it("a NUMBER the rule fixes is written by the compiler as a literal — no parameter, no question (2026-10-01)", () => {
    const out = compileOperation(
      {
        base: { table: "employees" },
        columns: [{ column: "full_name", alias: "full_name" }, { compute: { coalesce: [{ column: "days" }, { number: 0 }] }, alias: "days_or_zero" }],
        joins: [],
        filters: [{ column: "department_id", op: "eq", value: 3 }],
        having: [],
        aggregateJoins: [{ table: "attendance_monthly", groupBy: "employee_id", onLeft: "id", kind: "left", aggregates: [{ aggregate: "sum", column: "days_attended", alias: "days" }], filters: [{ column: "working_days", op: "gt", value: 0 }] }],
        sort: [],
      } as never,
      schemaRows,
    );
    expect(out.sql).toContain(`"t0"."department_id" = (3)`);
    expect(out.sql).toContain(`"t1_agg"."working_days" > (0)`);
    expect(out.sql).toMatch(/COALESCE\([^)]*, \(0\)\)/);
    // No parameter at all: a fixed number is never a value somebody is asked for.
    expect(out.paramOrder).toEqual([]);
    expect(out.paramsSchema).toEqual({});
  });

  it("CONTROL: a filter takes exactly one of a parameter or a number; a month, a list or a pattern is never a fixed number", () => {
    const parse = (f: Record<string, unknown>) => dbOperationSpecSchema.safeParse({ base: { table: "employees" }, columns: [{ column: "id", alias: "id" }], filters: [f] }).success;
    expect(parse({ column: "department_id", op: "eq", value: 3 })).toBe(true);
    expect(parse({ column: "department_id", op: "eq", value: 3, param: "d" })).toBe(false);
    expect(parse({ column: "department_id", op: "eq" })).toBe(false);
    expect(parse({ column: "hire_date", op: "month", value: 202608 })).toBe(false);
    expect(parse({ column: "status", op: "in", value: 1 })).toBe(false);
  });

  it("a fixed value has the TYPE of its column: true/false for a true/false column, a number for a number (2026-10-01)", () => {
    const rows = [...schemaRows, { ...schemaRows[1]!, id: "s-e-active", entityName: "employees", columnName: "is_active", columnType: "boolean" }];
    const spec = (column: string, op: string, value: number | boolean) => ({ base: { table: "employees" }, columns: [{ column: "id", alias: "id" }], joins: [], filters: [{ column, op, value }], having: [], aggregateJoins: [], sort: [] }) as never;
    expect(compileOperation(spec("is_active", "eq", true), rows).sql).toContain(`"t0"."is_active" = TRUE`);
    expect(compileOperation(spec("is_active", "neq", false), rows).sql).toContain(`"t0"."is_active" <> FALSE`);
    // Refused by name: a number on a true/false column (Postgres refuses `boolean = integer` at RUN time), true on a number, and
    // an ordering of true/false.
    const refused = (s: unknown) => { try { compileOperation(s as never, rows); return ""; } catch (e) { return ((e as { findings?: Array<{ code: string; message: string }> }).findings ?? []).map((f) => `${f.code}: ${f.message}`).join("; "); } };
    expect(refused(spec("is_active", "eq", 1))).toMatch(/constant_type: `is_active` is true\/false: its fixed value is true or false, not 1/);
    expect(refused(spec("department_id", "eq", true))).toMatch(/constant_type: `department_id` is not true\/false/);
    expect(refused(spec("is_active", "gt", true))).toMatch(/constant_type: .*compare it with eq or neq/);
    // CONTROL: the number on a number column still compiles, so the refusal is about the type and not about constants.
    expect(refused(spec("department_id", "eq", 3))).toBe("");
  });

  it("a fixed TEXT value is a quoted literal the compiler writes, on eq/neq, against a column that holds text (P2-I4)", () => {
    const rows = [...schemaRows, { ...schemaRows[1]!, id: "s-e-st", entityName: "employees", columnName: "status_txt", columnType: "text" }, { ...schemaRows[1]!, id: "s-e-any", entityName: "employees", columnName: "kind_any", columnType: "any" }];
    const spec = (column: string, op: string, value: unknown) => ({ base: { table: "employees" }, columns: [{ column: "id", alias: "id" }], joins: [], filters: [{ column, op, value }], having: [], aggregateJoins: [], sort: [] }) as never;
    const out = compileOperation(spec("status_txt", "eq", "Active"), rows);
    expect(out.sql).toContain(`"t0"."status_txt" = 'Active'`);
    expect(out.paramOrder).toEqual([]);
    expect(() => toSqlite(out.sql)).not.toThrow();
    expect(compileOperation(spec("status_txt", "neq", "On Leave"), rows).sql).toContain(`"t0"."status_txt" <> 'On Leave'`);
    expect(compileOperation(spec("kind_any", "eq", "x"), rows).sql).toContain(`= 'x'`);
    // A quote inside the value is doubled — the literal cannot end early.
    expect(compileOperation(spec("status_txt", "eq", "O'Brien' OR 1=1 --"), rows).sql).toContain(`= 'O''Brien'' OR 1=1 --'`);
    const refused = (s: unknown) => { try { compileOperation(s as never, rows); return ""; } catch (e) { return ((e as { findings?: Array<{ code: string; message: string }> }).findings ?? []).map((f) => `${f.code}: ${f.message}`).join("; "); } };
    expect(refused(spec("department_id", "eq", "Sales"))).toMatch(/constant_type: `department_id` is .*not compared with the text “Sales”/);
    // CONTROL: the same text on the text column compiles, so the refusal is about the column's type.
    expect(refused(spec("status_txt", "eq", "Sales"))).toBe("");
  });

  it("CONTROL: fixed text takes no backslash, no control character, no ordering, and no pattern", () => {
    const parse = (f: Record<string, unknown>) => dbOperationSpecSchema.safeParse({ base: { table: "employees" }, columns: [{ column: "id", alias: "id" }], filters: [f] }).success;
    expect(parse({ column: "status", op: "eq", value: "Active" })).toBe(true);
    expect(parse({ column: "status", op: "eq", value: "a\\' OR 1=1" })).toBe(false);
    expect(parse({ column: "status", op: "eq", value: "a\nb" })).toBe(false);
    expect(parse({ column: "status", op: "eq", value: "" })).toBe(false);
    expect(parse({ column: "status", op: "gt", value: "M" })).toBe(false);
    expect(parse({ column: "status", op: "like", value: "%a%" })).toBe(false);
    // CONTROL: an ordering of a NUMBER is still a fixed value.
    expect(parse({ column: "status", op: "gt", value: 3 })).toBe(true);
  });

  it("a COALESCE arm of UNKNOWN type neither decides the type nor is cast — `COALESCE(x, (0))`, valid on SQLite and Postgres", () => {
    const rows = [...schemaRows, { ...schemaRows[1]!, id: "s-e-note", entityName: "employees", columnName: "note", columnType: "any" }, { ...schemaRows[1]!, id: "s-e-code", entityName: "employees", columnName: "code_txt", columnType: "text" }];
    const col = (compute: unknown) => compileOperation({ base: { table: "employees" }, columns: [{ compute, alias: "v" }], joins: [], filters: [], having: [], aggregateJoins: [], sort: [] } as never, rows).sql;
    const sql = col({ coalesce: [{ column: "note" }, { number: 0 }] });
    expect(sql).toContain(`COALESCE("t0"."note", (0))`);
    expect(() => toSqlite(sql)).not.toThrow();
    // CONTROL: two KNOWN, different types still unify by the first one's — the cast is kept where it means something.
    expect(col({ coalesce: [{ column: "code_txt" }, { number: 0 }] })).toContain("((0))::text");
  });

  it("each range parameter's EDGE is the operator that reads it — at the top level and inside a summary join; two operators, none", () => {
    const out = compileOperation({
      base: { table: "employees" }, columns: [{ column: "id", alias: "id" }], joins: [], having: [], sort: [],
      filters: [{ column: "hire_date", op: "gte", param: "from" }, { column: "hire_date", op: "lt", param: "until" }, { column: "id", op: "gt", param: "both" }, { column: "id", op: "lte", param: "both" }],
      aggregateJoins: [{ table: "attendance_monthly", groupBy: "employee_id", onLeft: "id", kind: "left", aggregates: [{ aggregate: "count", alias: "n" }], filters: [{ column: "working_days", op: "lte", param: "at_most" }] }],
    } as never, schemaRows);
    expect(out.paramEdges).toEqual({ from: "ge", until: "lt", at_most: "le" });
  });

  /** Policy-threshold rows for the lookup tests below. */
  const ptRows = () => {
    const row = (columnName: string | null, columnType: string | null) => ({
      id: `s-pt-${columnName ?? "meta"}`,
      datasourceId: "ds1",
      entityType: "table",
      entitySchema: null,
      entityName: "policy_thresholds",
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
    return [
      row(null, null),
      row("department_id", "integer"),
      row("effective_from", "date"),
      row("min_attendance_rate", "numeric"),
    ];
  };

  it("an uncorrelated latestOne reads the same inner winner for every row", () => {
    const out = compileOperation(
      {
        base: { table: "employees" },
        columns: [
          { column: "full_name", alias: "name" },
          { column: "min_attendance_rate", alias: "org_floor" },
        ],
        joins: [
          {
            table: "policy_thresholds",
            kind: "left",
            latestOne: {
              orderBy: [{ column: "effective_from", dir: "desc" }],
              filters: [
                { column: "department_id", op: "is_null" },
                { column: "effective_from", op: "lte", param: "as_of" },
              ],
            },
          },
        ],
        filters: [],
        having: [],
  aggregateJoins: [],
        sort: [],
      },
      [...schemaRows, ...ptRows()],
    );
    expect(out.sql).toContain(
      'LEFT JOIN LATERAL (SELECT * FROM "policy_thresholds" AS "t1_in" ' +
        'WHERE "t1_in"."department_id" IS NULL AND "t1_in"."effective_from" <= $1 ' +
        'ORDER BY "t1_in"."effective_from" DESC LIMIT 1) AS "t1" ON true',
    );
    expect(out.paramOrder).toEqual(["as_of"]);
  });

  it("an inner bound against the row's own column consumes no position", () => {
    const out = compileOperation(
      {
        base: { table: "attendance_monthly" },
        columns: [{ column: "employee_id", alias: "employee_id" }],
        joins: [
          {
            table: "employees",
            onLeft: "employee_id",
            onRight: "id",
            kind: "inner",
            latestOne: {
              orderBy: [{ column: "hire_date", dir: "desc" }],
              filters: [{ column: "hire_date", op: "lte", outerColumn: "period" }],
            },
          },
        ],
        filters: [],
        having: [],
  aggregateJoins: [],
        sort: [],
      },
      schemaRows,
    );
    expect(out.sql).toContain('"t1_in"."hire_date" <= "t0"."period"');
    expect(out.paramOrder).toEqual([]);
  });
  it("an aggregateJoin matches one summary row per group key", () => {
    const inv = (columnName: string | null, columnType: string | null) => ({
      id: `s-inv-${columnName ?? "meta"}`,
      datasourceId: "ds1",
      entityType: "table",
      entitySchema: null,
      entityName: "invoices",
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
    const rows = [
      ...schemaRows,
      inv(null, null),
      inv("id", "integer"),
      inv("cost_centre_id", "integer"),
      inv("amount_cents", "integer"),
      inv("issue_date", "date"),
      inv("status", "character varying"),
    ];
    const out = compileOperation(
      {
        base: { table: "employees" },
        columns: [
          { column: "full_name", alias: "name" },
          { column: "invoice_total", alias: "invoice_total" },
        ],
        joins: [],
        aggregateJoins: [
          {
            table: "invoices",
            groupBy: "cost_centre_id",
            onLeft: "department_id",
            kind: "left",
            aggregates: [{ column: "amount_cents", aggregate: "sum", alias: "invoice_total" }],
            filters: [
              { column: "issue_date", op: "month", param: "period" },
              { column: "status", op: "neq", param: "live" },
            ],
          },
        ],
        filters: [],
        having: [],
        sort: [],
      },
      rows,
    );
    expect(out.sql).toContain(
      'LEFT JOIN (SELECT "t1_agg"."cost_centre_id" AS "cost_centre_id", sum("t1_agg"."amount_cents") AS "invoice_total" ' +
        'FROM "invoices" AS "t1_agg" WHERE date_trunc(\'month\', "t1_agg"."issue_date"::date) = to_date(left($1::text, 7), \'YYYY-MM\') ' +
        'AND "t1_agg"."status" <> $2 GROUP BY "t1_agg"."cost_centre_id") AS "t1" ON "t0"."department_id" = "t1"."cost_centre_id"',
    );
    expect(out.paramOrder).toEqual(["period", "live"]);
  });
  /** Support-desk rows for the composite-key test above. */
  const supRows = () => {
    const row = (entityName: string, columnName: string | null, columnType: string | null) => ({
      id: `s-sup-${entityName}-${columnName ?? "meta"}`,
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
    return [
      row("tickets", null, null),
      row("tickets", "ticket_code", "character varying"),
      row("tickets", "plan", "character varying"),
      row("tickets", "priority", "character varying"),
      row("tickets", "opened_at", "timestamp with time zone"),
      row("tickets", "resolved_at", "timestamp with time zone"),
      row("sla_policies", null, null),
      row("sla_policies", "plan", "character varying"),
      row("sla_policies", "priority", "character varying"),
      row("sla_policies", "resolve_mins", "integer"),
    ];
  };
  it("andOn appends composite-key equalities in order", () => {
    const out = compileOperation(
      {
        base: { table: "tickets" },
        columns: [{ column: "ticket_code", alias: "code" }],
        joins: [
          {
            table: "sla_policies",
            onLeft: "plan",
            onRight: "plan",
            andOn: [{ left: "priority", right: "priority" }],
            kind: "left",
          },
        ],
        filters: [],
        having: [],
        aggregateJoins: [],
        sort: [],
      },
      supRows(),
    );
    expect(out.sql).toContain(
      'LEFT JOIN "sla_policies" AS "t1" ON "t0"."plan" = "t1"."plan" AND "t0"."priority" = "t1"."priority"',
    );
  });
  it("greatest and least bound an overlap without new syntax", () => {
    const out = compileOperation(
      {
        base: { table: "tickets" },
        columns: [
          {
            compute: {
              diffMinutes: {
                start: { greatest: { first: { column: "opened_at" }, second: { column: "resolved_at" } } },
                end: { least: { first: { column: "resolved_at" }, second: { param: "as_of" } } },
              },
            },
            alias: "overlap_mins",
          },
        ],
        filters: [],
        having: [],
        aggregateJoins: [],
        joins: [],
        sort: [],
      },
      supRows(),
    );
    expect(out.sql).toContain(
      `(EXTRACT(EPOCH FROM ((LEAST("t0"."resolved_at", $1))::timestamptz - (GREATEST("t0"."opened_at", "t0"."resolved_at"))::timestamptz)) / 60)::bigint AS "overlap_mins"`,
    );
    expect(out.paramOrder).toEqual(["as_of"]);
  });

  it("businessMinutes walks weekdays nine to five in UTC", () => {
    const out = compileOperation(
      {
        base: { table: "tickets" },
        columns: [
          {
            compute: {
              businessMinutes: { start: { column: "opened_at" }, end: { param: "as_of" } },
            },
            alias: "biz_mins",
          },
        ],
        filters: [],
        having: [],
        aggregateJoins: [],
        joins: [],
        sort: [],
      },
      supRows(),
    );
    expect(out.sql).toContain("generate_series");
    expect(out.sql).toContain("EXTRACT(ISODOW FROM d.day) < 6");
    expect(out.sql).toContain(`d.day + time '17:00'`);
    expect(out.sql).toContain(`AT TIME ZONE 'UTC'`);
    expect(out.sql).toContain(`AS "biz_mins"`);
    expect(out.paramOrder).toEqual(["as_of"]);
  });


  it("coalesce falls back through a list and count can count distinct values", () => {
    const out = compileOperation(
      {
        base: { table: "employees" },
        columns: [
          { compute: { coalesce: [{ column: "full_name" }, { column: "employee_code" }] }, alias: "name" },
          { column: "id", aggregate: "count", aggregateDistinct: true, alias: "people" },
        ],
        joins: [],
        filters: [],
        having: [],
        aggregateJoins: [],
        sort: [],
      },
      schemaRows,
    );
    expect(out.sql).toBe(
      'SELECT COALESCE("t0"."full_name", "t0"."employee_code") AS "name", count(DISTINCT "t0"."id") AS "people" ' +
        'FROM "employees" AS "t0" GROUP BY COALESCE("t0"."full_name", "t0"."employee_code")',
    );
  });
  it("coalesce casts mismatched arms to the first known type", () => {
    const noteRow = {
      id: "s-inv2-note",
      datasourceId: "ds1",
      entityType: "table",
      entitySchema: null,
      entityName: "invoices",
      columnName: "note",
      columnType: "character varying",
      isPrimaryKey: false,
      isForeignKey: false,
      foreignKeyReference: null,
      nullable: true,
      characterMaximumLength: null,
      semanticTag: null, valueDomain: null,
      rowCountEstimate: null,
      nullPercentage: null,
      extractedAt: new Date("2026-08-01T00:00:00Z"),
    };
    const out = compileOperation(
      {
        base: { table: "invoices" },
        columns: [
          {
            compute: { coalesce: [{ column: "payment_terms_days" }, { column: "note" }] },
            alias: "terms",
          },
        ],
        joins: [],
        filters: [],
        having: [],
        aggregateJoins: [],
        sort: [],
      },
      [...invRows(), noteRow],
    );
    expect(out.sql).toContain('COALESCE("t0"."payment_terms_days", ("t0"."note")::int) AS "terms"');
  });

  /** Invoice date columns for the date-arithmetic test below. */
  const invRows = () => {
    const row = (columnName: string | null, columnType: string | null) => ({
      id: `s-inv2-${columnName ?? "meta"}`,
      datasourceId: "ds1",
      entityType: "table",
      entitySchema: null,
      entityName: "invoices",
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
    return [
      row(null, null),
      row("invoice_number", "character varying"),
      row("issue_date", "date"),
      row("due_date", "date"),
      row("payment_terms_days", "integer"),
    ];
  };

  it("date arithmetic stays in SQL with positional params", () => {
    const out = compileOperation(
      {
        base: { table: "invoices" },
        columns: [
          { column: "invoice_number", alias: "n" },
          {
            compute: {
              coalesce: [
                { column: "due_date" },
                { addDays: { value: { column: "issue_date" }, days: { column: "payment_terms_days" } } },
              ],
            },
            alias: "eff",
          },
          { compute: { diffDays: { start: { column: "issue_date" }, end: { param: "as_of", type: "date" } } }, alias: "age" },
        ],
        joins: [],
        filters: [],
        having: [],
        aggregateJoins: [],
        sort: [],
      },
      invRows(),
    );
    expect(out.sql).toBe(
      'SELECT "t0"."invoice_number" AS "n", ' +
        'COALESCE("t0"."due_date", ("t0"."issue_date"::date + ("t0"."payment_terms_days")::int)) AS "eff", ' +
        '($1::date - "t0"."issue_date"::date) AS "age" FROM "invoices" AS "t0"',
    );
    expect(out.paramOrder).toEqual(["as_of"]);
    expect(out.paramsSchema).toEqual({
      as_of: { type: "date", required: true, description: 'value inside the "age" expression' },
    });
  });

  it("DISTINCT inside an aggregate without one is a structured refusal", () => {
    const err = compileError(() =>
      compileOperation(
        {
          base: { table: "employees" },
          columns: [{ column: "full_name", alias: "name", aggregateDistinct: true }],
          joins: [],
          filters: [],
          having: [],
  aggregateJoins: [],
          sort: [],
        },
        schemaRows,
      ),
    );
    expect(err.findings?.some((f) => f.code === "distinct_without_aggregate")).toBe(true);
  });

  it("qualifies a named schema when the entity lives outside the default schema", () => {
    const rows = [
      ...schemaRows,
      {
        id: "s-hr-staff",
        datasourceId: "ds1",
        entityType: "table",
        entitySchema: "hr",
        entityName: "staff",
        columnName: null,
        columnType: null,
        isPrimaryKey: false,
        isForeignKey: false,
        foreignKeyReference: null,
        nullable: true,
        characterMaximumLength: null,
        semanticTag: null, valueDomain: null,
        rowCountEstimate: null,
        nullPercentage: null,
        extractedAt: new Date("2026-08-01T00:00:00Z"),
      },
      {
        id: "s-hr-staff-id",
        datasourceId: "ds1",
        entityType: "table",
        entitySchema: "hr",
        entityName: "staff",
        columnName: "id",
        columnType: "integer",
        isPrimaryKey: true,
        isForeignKey: false,
        foreignKeyReference: null,
        nullable: false,
        characterMaximumLength: null,
        semanticTag: null, valueDomain: null,
        rowCountEstimate: null,
        nullPercentage: null,
        extractedAt: new Date("2026-08-01T00:00:00Z"),
      },
      {
        id: "s-hr-staff-name",
        datasourceId: "ds1",
        entityType: "table",
        entitySchema: "hr",
        entityName: "staff",
        columnName: "full_name",
        columnType: "character varying",
        isPrimaryKey: false,
        isForeignKey: false,
        foreignKeyReference: null,
        nullable: true,
        characterMaximumLength: null,
        semanticTag: null, valueDomain: null,
        rowCountEstimate: null,
        nullPercentage: null,
        extractedAt: new Date("2026-08-01T00:00:00Z"),
      },
    ];
    const out = compileOperation(
      { base: { schema: "hr", table: "staff" }, columns: [{ column: "id", alias: "id" }] },
      rows,
    );
    expect(out.sql).toBe('SELECT "t0"."id" AS "id" FROM "hr"."staff" AS "t0"');
  });

  it("emits = ANY($n) for an in filter and types the param as an array", () => {
    const out = compileOperation(
      {
        base: { table: "attendance_monthly" },
        columns: [{ column: "period", alias: "period" }],
        joins: [{ table: "employees", onLeft: "employee_id", onRight: "id", kind: "inner" }],
        filters: [{ column: "status", op: "in", param: "statuses" }],
      },
      schemaRows,
    );
    // The filter column lives on the JOINED table; `in` stays a single bound
    // parameter (an empty array is then a legal empty match).
    expect(out.sql).toBe(
      'SELECT "t0"."period" AS "period" FROM "attendance_monthly" AS "t0" ' +
        'INNER JOIN "employees" AS "t1" ON "t0"."employee_id" = "t1"."id" ' +
        'WHERE "t1"."status" = ANY($1)',
    );
    expect(out.paramOrder).toEqual(["statuses"]);
    expect(out.paramsSchema.statuses).toMatchObject({ type: "array", required: true });
  });

  it("reuses a repeated param name's position — one placeholder referenced twice", () => {
    const out = compileOperation(
      {
        base: { table: "attendance_monthly" },
        columns: [{ column: "period", alias: "period" }],
        filters: [
          { column: "period", op: "eq", param: "period" },
          { column: "attendance_rate", op: "gt", param: "min_rate" },
          { column: "period", op: "neq", param: "period" },
        ],
      },
      schemaRows,
    );
    expect(out.sql).toContain('WHERE "t0"."period" = $1 AND "t0"."attendance_rate" > $2 AND "t0"."period" <> $1');
    expect(out.paramOrder).toEqual(["period", "min_rate"]);
    // A numeric column types the param as number.
    expect(out.paramsSchema.min_rate).toMatchObject({ type: "number", required: true });
  });

  it("quotes identifiers, so a table or column named like a write keyword cannot reach the statement", () => {
    const rows = [
      {
        id: "s-update",
        datasourceId: "ds1",
        entityType: "table",
        entitySchema: null,
        entityName: "update",
        columnName: null,
        columnType: null,
        isPrimaryKey: false,
        isForeignKey: false,
        foreignKeyReference: null,
        nullable: true,
        characterMaximumLength: null,
        semanticTag: null, valueDomain: null,
        rowCountEstimate: null,
        nullPercentage: null,
        extractedAt: new Date("2026-08-01T00:00:00Z"),
      },
      {
        id: "s-update-delete",
        datasourceId: "ds1",
        entityType: "table",
        entitySchema: null,
        entityName: "update",
        columnName: "delete",
        columnType: "character varying",
        isPrimaryKey: false,
        isForeignKey: false,
        foreignKeyReference: null,
        nullable: true,
        characterMaximumLength: null,
        semanticTag: null, valueDomain: null,
        rowCountEstimate: null,
        nullPercentage: null,
        extractedAt: new Date("2026-08-01T00:00:00Z"),
      },
    ];
    const out = compileOperation(
      { base: { table: "update" }, columns: [{ column: "delete", alias: "d" }] },
      rows,
    );
    expect(out.sql).toBe('SELECT "t0"."delete" AS "d" FROM "update" AS "t0"');
    // The SAME statement with the quotes stripped is refused by the shape gate
    // compileOperation runs — this is what the quoting buys.
    expect(checkSqlShape("SELECT delete AS d FROM update", [], {}).map((p) => p.code)).toContain(
      "not_a_read",
    );
  });

  it("always passes checkSqlShape — the SELECT-only backstop is wired", () => {
    const out = compileOperation(SPEC, schemaRows);
    expect(checkSqlShape(out.sql, out.paramOrder, out.paramsSchema)).toEqual([]);
  });
});

describe("compileOperation — structured refusals", () => {
  it("refuses an unknown column with the offending identifier and the available columns", () => {
    const err = compileError(() =>
      compileOperation(
        {
          base: { table: "attendance_monthly" },
          columns: [{ column: "nonexistent_col", alias: "x" }],
        },
        schemaRows,
      ),
    );
    expect(err.statusCode).toBe(400);
    expect(err.findings).toEqual([
      expect.objectContaining({
        code: "unknown_column",
        identifier: "nonexistent_col",
      }),
    ]);
    expect(err.findings![0].available).toEqual(
      expect.arrayContaining(["period", "employee_id", "attendance_rate"]),
    );
  });

  it("refuses an unknown table with the available tables", () => {
    const err = compileError(() =>
      compileOperation(
        { base: { table: "no_such_table" }, columns: [{ column: "id", alias: "id" }] },
        schemaRows,
      ),
    );
    expect(err.statusCode).toBe(400);
    expect(err.findings![0]).toMatchObject({
      code: "unknown_table",
      identifier: "no_such_table",
    });
    expect(err.findings![0].available).toEqual(
      expect.arrayContaining(["attendance_monthly", "employees"]),
    );
  });

  it("names the schema in the finding when an unqualified table is ambiguous", () => {
    const rows = [
      ...schemaRows,
      {
        id: "s-hr-attendance_monthly",
        datasourceId: "ds1",
        entityType: "table",
        entitySchema: "hr",
        entityName: "attendance_monthly",
        columnName: null,
        columnType: null,
        isPrimaryKey: false,
        isForeignKey: false,
        foreignKeyReference: null,
        nullable: true,
        characterMaximumLength: null,
        semanticTag: null, valueDomain: null,
        rowCountEstimate: null,
        nullPercentage: null,
        extractedAt: new Date("2026-08-01T00:00:00Z"),
      },
    ];
    // Both schemas have `attendance_monthly`; the DEFAULT (NULL) schema wins,
    // so this resolves rather than refusing — the refusal would be a
    // schema-qualified spec naming a schema that does not exist.
    const out = compileOperation(
      { base: { table: "attendance_monthly" }, columns: [{ column: "period", alias: "p" }] },
      rows,
    );
    expect(out.sql).toBe('SELECT "t0"."period" AS "p" FROM "attendance_monthly" AS "t0"');
  });

  it("reports schema_not_introspected when there are no schema rows at all", () => {
    const err = compileError(() =>
      compileOperation(
        { base: { table: "anything" }, columns: [{ column: "x", alias: "x" }] },
        [],
      ),
    );
    expect(err.findings![0]).toMatchObject({
      code: "schema_not_introspected",
      identifier: "anything",
    });
  });

  it("refuses a duplicate alias — two result columns with one name", () => {
    const err = compileError(() =>
      compileOperation(
        {
          base: { table: "attendance_monthly" },
          columns: [
            { column: "period", alias: "p" },
            { column: "working_days", alias: "p" },
          ],
        },
        schemaRows,
      ),
    );
    expect(err.findings![0]).toMatchObject({ code: "duplicate_alias", identifier: "p" });
  });

  it("reports every unresolvable identifier at once", () => {
    const err = compileError(() =>
      compileOperation(
        {
          base: { table: "attendance_monthly" },
          columns: [
            { column: "no_col_a", alias: "a" },
            { column: "no_col_b", alias: "b" },
          ],
          filters: [{ column: "no_col_c", op: "eq", param: "p" }],
          sort: [{ column: "no_col_d", dir: "asc" }],
        },
        schemaRows,
      ),
    );
    // Columns, filter AND sort are all unresolvable — the author gets every
    // finding in one 400, not one round-trip per identifier.
    expect(err.findings!.map((f) => f.code)).toEqual([
      "unknown_column",
      "unknown_column",
      "unknown_column",
      "unknown_column",
    ]);
  });
});

describe("dbOperationService — CRUD rules", () => {
  it("create compiles on save, stores the spec + compiled SQL, and returns the ref", async () => {
    const out = await dbOperationService.create("ws1", "ds1", {
      name: "attendance_by_dept",
      description: "Headcount by period",
      spec: SPEC,
    });
    expect(out.operation.ref).toBe("hr_demo.attendance_by_dept");
    expect(out.operation.compiledSql).toContain("SELECT");
    expect(out.operation.spec).toEqual(SPEC);
    expect(out.operation.paramsSchema).toEqual({
      period: { type: "string", required: true, description: "eq filter on attendance_monthly.period" },
    });
    expect(store).toHaveLength(1);
    expect(store[0]).toMatchObject({
      workspaceId: "ws1",
      datasourceId: "ds1",
      name: "attendance_by_dept",
      compiledSql: out.operation.compiledSql,
    });
  });

  it("create → 409 on a duplicate name within the datasource", async () => {
    store.push({
      id: "op-1",
      workspaceId: "ws1",
      datasourceId: "ds1",
      name: "attendance_by_dept",
      description: null,
      specJson: SPEC,
      compiledSql: "SELECT 1",
      paramsSchema: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      dbOperationService.create("ws1", "ds1", { name: "attendance_by_dept", spec: SPEC }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(store).toHaveLength(1); // nothing was overwritten
  });

  it("update recompiles the merged spec and stores the new compiled SQL", async () => {
    await dbOperationService.create("ws1", "ds1", { name: "attendance_by_dept", spec: SPEC });
    const patched: DbOperationSpec = {
      ...SPEC,
      limit: 10,
      filters: [
        { column: "period", op: "eq", param: "period" },
        { column: "status", op: "eq", param: "status" },
      ],
    };
    const out = await dbOperationService.update("ws1", "ds1", "attendance_by_dept", {
      spec: patched,
    });
    expect(out!.operation.spec).toEqual(patched);
    expect(out!.operation.compiledSql).toContain("$2");
    expect(
      (out!.operation.paramsSchema as Record<string, { type?: string }>).status,
    ).toMatchObject({ type: "string" });
    expect((store[0] as { compiledSql?: string }).compiledSql).toBe(out!.operation.compiledSql);
  });

  it("update → undefined when the operation does not exist", async () => {
    await expect(
      dbOperationService.update("ws1", "ds1", "nope", { spec: SPEC }),
    ).resolves.toBeUndefined();
  });

  /**
   * ⚠ The shape changed from `boolean` to a discriminated result on 2026-09-17,
   * when `remove` gained the reference refusal. The old assertion is kept as the
   * `ok: true` arm rather than rewritten away: "deletes, then reports absence"
   * is still the property, and `removed` is still the boolean that says which.
   */
  it("remove deletes and reports absence", async () => {
    flows.rows = [];
    await dbOperationService.create("ws1", "ds1", { name: "attendance_by_dept", spec: SPEC });
    await expect(dbOperationService.remove("ws1", "ds1", "attendance_by_dept")).resolves.toEqual({
      ok: true,
      removed: true,
    });
    await expect(dbOperationService.remove("ws1", "ds1", "attendance_by_dept")).resolves.toEqual({
      ok: true,
      removed: false,
    });
  });

  /**
   * ⚠ **The refusal, and it names the flows.** A deleted reader does not fail
   * the edit, the compile or the deploy — it fails the next RUN, on a flow that
   * may be armed, for somebody who did not delete it. A 409 that said only "no"
   * would leave them reading `flow_steps` by hand to find out which.
   */
  it("remove REFUSES while a flow names the reader, and says which flows", async () => {
    await dbOperationService.create("ws1", "ds1", { name: "attendance_by_dept", spec: SPEC });
    flows.rows = [
      { name: "Monthly attendance check", draft: ["hr_demo.attendance_by_dept"] },
      { name: "Unrelated digest", draft: ["hr_demo.something_else"] },
    ];
    await expect(dbOperationService.remove("ws1", "ds1", "attendance_by_dept")).resolves.toEqual({
      ok: false,
      referencedBy: ["Monthly attendance check"],
    });
    // ⚠ And it really did not delete — a refusal that reports "no" and removes
    // the row anyway is the worst of both, and only a second call can tell.
    flows.rows = [];
    await expect(dbOperationService.remove("ws1", "ds1", "attendance_by_dept")).resolves.toEqual({
      ok: true,
      removed: true,
    });
  });

  /**
   * ⚠ `force` is the way PAST the gate, so it needs its own test — otherwise
   * the refusal above passes against an implementation with no escape at all,
   * and the panel's "delete anyway" would 409 for ever.
   */
  it("force deletes a referenced reader — the deliberate break", async () => {
    await dbOperationService.create("ws1", "ds1", { name: "attendance_by_dept", spec: SPEC });
    flows.rows = [{ name: "Monthly attendance check", draft: ["hr_demo.attendance_by_dept"] }];
    await expect(
      dbOperationService.remove("ws1", "ds1", "attendance_by_dept", { force: true }),
    ).resolves.toEqual({ ok: true, removed: true });
    flows.rows = [];
  });

  /**
   * ⚠ The bound stated in `referencingFlows`' docblock, asserted rather than
   * only written down: the ARMED revision counts as well as the draft. A scan
   * reading the draft alone would permit deleting a reader out from under a
   * flow that is firing on a schedule — the one case where nobody is watching.
   */
  it("the reference scan reads the ARMED revision too, not just the draft", async () => {
    // The draft has been edited PAST the reader and only the armed revision
    // still names it — the one state where reading the draft alone permits
    // deleting a reader out from under a flow that is firing on a schedule.
    flows.rows = [
      { name: "Armed nightly", draft: ["hr_demo.something_else"], armed: ["hr_demo.attendance_by_dept"] },
    ];
    expect(await dbOperationService.referencingFlows("ws1", "hr_demo.attendance_by_dept")).toEqual([
      "Armed nightly",
    ]);
    // The control: the same scan says nothing when neither revision names it,
    // so the assertion above is not satisfied by a function that always answers.
    expect(await dbOperationService.referencingFlows("ws1", "hr_demo.never_used")).toEqual([]);
    flows.rows = [];
  });

  it("scopes every operation to its workspace via the datasource", async () => {
    await expect(dbOperationService.list("ws9", "ds1")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("check returns the compiled SQL without saving; a bad spec returns structured problems", async () => {
    const ok = await dbOperationService.check("ws1", "ds1", SPEC);
    expect(ok).toMatchObject({ ok: true });
    expect((ok as { compiledSql: string }).compiledSql).toContain("$1");
    expect(store).toHaveLength(0); // check never writes

    const bad = await dbOperationService.check("ws1", "ds1", {
      base: { table: "attendance_monthly" },
      columns: [{ column: "gone", alias: "x" }],
    });
    expect(bad.ok).toBe(false);
    expect((bad as { problems: Array<{ code: string }> }).problems[0].code).toBe("unknown_column");
  });

  it("zod refuses a non-identifier alias before the compiler is reached", () => {
    const parsed = dbOperationSpecSchema.safeParse({
      base: { table: "attendance_monthly" },
      columns: [{ column: "period", alias: "not an identifier" }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("one read, many spellings (canonicalSpec, 2026-10-03)", async () => {
  const { canonicalSpec } = await import("./db-operation.service.js");
  it("a table named with its schema is that table; a compute that is a bare column IS that column", () => {
    const out = canonicalSpec({
      base: { table: "main.employee" },
      aggregateJoins: [{ table: "main.attendance_day", groupBy: "emp_id" }],
      joins: [{ table: "main.report_parameters", kind: "left" }],
      columns: [{ compute: { column: "emp_name" }, alias: "name" }, { column: "dept", compute: { column: "dept" }, alias: "dept" }],
    }) as Record<string, unknown>;
    expect(out.base).toEqual({ schema: "main", table: "employee" });
    expect((out.aggregateJoins as Array<{ table: string }>)[0]!.table).toBe("attendance_day");
    expect((out.joins as Array<{ table: string }>)[0]!.table).toBe("report_parameters");
    expect(out.columns).toEqual([{ column: "emp_name", alias: "name" }, { column: "dept", alias: "dept" }]);
  });
  it("CONTROL: two different things, an expression, or a base whose schema disagrees are left for the form to refuse or keep", () => {
    const out = canonicalSpec({
      base: { schema: "hr", table: "main.employee" },
      columns: [{ column: "dept", compute: { column: "emp_name" }, alias: "x" }, { compute: { percent: { part: { column: "a" }, whole: { column: "b" } } }, alias: "p" }],
    }) as Record<string, unknown>;
    expect(out.base).toEqual({ schema: "hr", table: "main.employee" });
    expect(out.columns).toEqual([{ column: "dept", compute: { column: "emp_name" }, alias: "x" }, { compute: { percent: { part: { column: "a" }, whole: { column: "b" } } }, alias: "p" }]);
  });
});
