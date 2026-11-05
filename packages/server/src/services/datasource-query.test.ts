import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { checkSqlShape } from "./datasource-query.service.js";
import { hrRoDbUrl } from "../demo/seed-hr-db.js";

/**
 * Stage 2 — named queries became authorable over HTTP, which made them a SQL
 * authoring surface. These are the negative tests that make that acceptable.
 *
 * The suite is shaped the way `hr-roles.test.ts` is shaped, and for the same
 * reason: most of the value is in what a named query **cannot** be. Asserting
 * only that a good query passes would pass just as happily with every rule
 * deleted, which is the failure mode this repo keeps running into
 * (`generation-audit` marking a broken script `clean`).
 */

const codes = (sql: string, order: string[] = [], schema: Record<string, unknown> = {}) =>
  checkSqlShape(sql, order, schema).map((p) => p.code);

describe("checkSqlShape — a named query is one read statement", () => {
  it("accepts the shape the Phase 1 screening queries actually use", () => {
    // Lifted from `kestra/hr-screening.queries.ts`: a parameterised read with a
    // COALESCE to a policy default and an ORDER BY. If the rules reject this,
    // they reject the flow the whole migration was proven with.
    const sql = `
      SELECT e.id AS employee_id, e.full_name, am.attendance_rate::float8 AS attendance_rate,
             COALESCE(pt.min_attendance_rate,
                      (SELECT min_attendance_rate FROM policy_thresholds
                        WHERE department_id IS NULL LIMIT 1))::float8 AS min_attendance_rate
        FROM attendance_monthly am
        JOIN employees e ON e.id = am.employee_id
        LEFT JOIN policy_thresholds pt ON pt.department_id = e.department_id
       WHERE am.period = $1::bpchar AND e.status NOT IN ('exited', 'on_leave')
       ORDER BY e.id
    `;
    expect(
      checkSqlShape(sql, ["period"], { period: { type: "string", required: true } }),
    ).toEqual([]);
  });

  it("rejects a second statement", () => {
    // MEASURED, not theoretical: against the live HR datasource,
    // `client.query("SELECT 1; SELECT 2", [])` is ACCEPTED and runs both, because
    // pg uses the simple protocol for an empty values array. With one parameter
    // the same SQL is refused — so the protection exists only for queries that
    // happen to take a param, and vanishes when the last one is removed.
    expect(codes("SELECT 1; SELECT 2")).toContain("multiple_statements");
  });

  it("allows a single trailing semicolon", () => {
    // A rule that fired on `SELECT 1;` would be a formatting rule wearing a
    // safety rule's message, and people learn to ignore those.
    expect(codes("SELECT 1;")).toEqual([]);
    expect(codes("SELECT 1;\n  ")).toEqual([]);
  });

  it("rejects a write, including one hidden behind WITH", () => {
    // The case a leading-keyword check passes: a data-modifying CTE is a write
    // whose first word is WITH.
    expect(codes("WITH x AS (INSERT INTO t VALUES (1) RETURNING 1) SELECT * FROM x")).toContain(
      "not_a_read",
    );
    expect(codes("UPDATE employees SET status = 'exited'")).toContain("not_a_read");
    expect(codes("DELETE FROM employees")).toContain("not_a_read");
    expect(codes("TRUNCATE employees")).toContain("not_a_read");
    expect(codes("SELECT 1 FROM t; DROP TABLE t")).toContain("not_a_read");
  });

  it("rejects statements that change session state a later read would inherit", () => {
    expect(codes("SET transaction_read_only = off")).toContain("not_a_read");
    expect(codes("BEGIN")).toContain("not_a_read");
  });

  it("rejects a dollar-quoted block outright", () => {
    // Its contents are not SQL at this level, so every other rule here would be
    // reading a body it cannot parse — and reporting a pass.
    const p = checkSqlShape("SELECT 1 FROM (SELECT $$ DELETE FROM t $$) s", [], {});
    expect(p.map((x) => x.code)).toEqual(["dollar_quoted_block"]);
  });

  // ── the false positives that would make the rules unusable ────────────────

  it("does not mistake ordinary column names for write keywords", () => {
    // `\b` after the keyword fails on the following word character, so
    // `created_at` is not `create`. This is the assertion that keeps the write
    // check from being deleted the first week someone hits it.
    const sql = `
      SELECT created_at, updated_at, deleted_at, inserted_by, setting_name, docall
        FROM audit_rows ORDER BY created_at
    `;
    expect(checkSqlShape(sql, [], {})).toEqual([]);
  });

  it("does not read inside string literals, quoted identifiers or comments", () => {
    expect(codes("SELECT 'update' AS verb, 'a; b' AS semi")).toEqual([]);
    expect(codes('SELECT "insert" FROM t')).toEqual([]);
    expect(codes("SELECT 1 -- DELETE FROM t\n")).toEqual([]);
    expect(codes("SELECT 1 /* $3 was removed; DROP TABLE t */")).toEqual([]);
    // A doubled quote is an escaped quote, not the end of the literal — reading
    // it as a close would leave the rest of the literal exposed to every rule.
    expect(codes("SELECT 'it''s; not two statements' AS s")).toEqual([]);
  });

  // ── paramOrder has to agree with the placeholders ─────────────────────────

  it("rejects more placeholders than declared parameters", () => {
    // Fails on every execution — and the first execution is after approval.
    expect(codes("SELECT * FROM t WHERE a = $1 AND b = $2", ["a"], { a: {} })).toContain(
      "placeholder_mismatch",
    );
  });

  it("rejects a declared parameter that binds nothing", () => {
    // The dangerous direction: the manifest and `refInterfaces()` then advertise
    // a parameter the query does not have, and since an import is checked
    // against the interface (D-25), the false signature travels to another
    // tenant and passes the structural check.
    expect(codes("SELECT * FROM t WHERE a = $1", ["a", "b"], { a: {}, b: {} })).toContain(
      "placeholder_mismatch",
    );
  });

  it("rejects a gap in the placeholder sequence", () => {
    // `$1, $3` with two names silently binds the second name to $3's position
    // while $2 has nothing — a shift, not an error.
    expect(codes("SELECT * FROM t WHERE a = $1 AND c = $3", ["a", "c"], { a: {}, c: {} })).toContain(
      "placeholder_gap",
    );
  });

  it("rejects a repeated parameter name", () => {
    expect(codes("SELECT * FROM t WHERE a = $1 AND b = $2", ["p", "p"], { p: {} })).toContain(
      "duplicate_param",
    );
  });

  it("accepts one placeholder referenced twice", () => {
    // The legitimate way to reuse a value: one declared name, two mentions.
    expect(codes("SELECT * FROM t WHERE a = $1 OR b = $1", ["p"], { p: {} })).toEqual([]);
  });

  it("requires paramsSchema to describe exactly the declared parameters", () => {
    // An undescribed parameter is not an omission — the manifest defaults it to
    // "string", which is a type assertion nobody made.
    expect(codes("SELECT * FROM t WHERE a = $1", ["a"], {})).toContain("params_schema_mismatch");
    expect(codes("SELECT * FROM t WHERE a = $1", ["a"], { a: {}, stale: {} })).toContain(
      "params_schema_mismatch",
    );
  });

  it("reports every problem at once", () => {
    // One 400 per rule teaches an author to work around the rules, and the way
    // around "single statement" is a second query nobody reviews.
    const p = checkSqlShape("UPDATE t SET a = $1; SELECT $3", ["x", "x"], {});
    expect(new Set(p.map((x) => x.code)).size).toBeGreaterThan(3);
  });
});

// ── the claim the whole design rests on ─────────────────────────────────────

/**
 * A parameter value can never become SQL.
 *
 * This is asserted against a real Postgres rather than by reading the code,
 * because the property belongs to the driver's protocol, not to Foundry: the
 * value travels in the Bind message, and the statement is already parsed. A unit
 * test with a fake client would assert that we pass two arguments to `query`,
 * which is not the same claim.
 *
 * Runs as `foundry_ro` against the seeded `hr_demo`, i.e. the same credential a
 * `datasource` step uses.
 */
const { reachable, skipReason } = await (async () => {
  const c = new Client({ connectionString: hrRoDbUrl(), connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
    await c.query("SELECT 1 FROM employees LIMIT 1");
    await c.end();
    return { reachable: true, skipReason: "" };
  } catch (e) {
    await c.end().catch(() => {});
    return { reachable: false, skipReason: (e as Error).message };
  }
})();

if (!reachable) {
  console.warn(`[datasource-query.test] SKIPPING the bound-parameter tests: ${skipReason}`);
}

describe.skipIf(!reachable)("a bound parameter is a value, never SQL", () => {
  it("treats SQL in a parameter as a literal string", async () => {
    const c = new Client({ connectionString: hrRoDbUrl() });
    await c.connect();
    try {
      // The classic shape. If interpolation were happening anywhere, this either
      // errors or returns every row; bound, it returns the count of employees
      // whose status is literally that whole string — zero.
      const evil = "x' OR '1'='1";
      const r = await c.query(
        "SELECT count(*)::int AS n FROM employees WHERE status = $1",
        [evil],
      );
      expect(r.rows[0].n).toBe(0);

      // And the control that makes the above mean something: a real value does
      // match, so the query is genuinely filtering rather than always empty.
      const ctrl = await c.query(
        "SELECT count(*)::int AS n FROM employees WHERE status = $1",
        ["active"],
      );
      expect(ctrl.rows[0].n).toBeGreaterThan(0);
    } finally {
      await c.end().catch(() => {});
    }
  });

  it("refuses a second statement once the query is parameterised", async () => {
    // The measurement behind the `multiple_statements` rule, pinned so the
    // asymmetry cannot be forgotten: WITH a parameter pg refuses; with an EMPTY
    // values array it runs both statements. The rule exists because the second
    // case is the one a zero-parameter named query lands in.
    const c = new Client({ connectionString: hrRoDbUrl() });
    await c.connect();
    try {
      await expect(c.query("SELECT $1::int AS a; SELECT 2 AS b", [1])).rejects.toThrow(
        /multiple commands/i,
      );

      const both = await c.query("SELECT 1 AS a; SELECT 2 AS b", []);
      // pg returns an ARRAY of results here — which is also why `runNamedQuery`
      // reading `.rows` off it yields `undefined`: the statements run and the
      // step reports nothing at all.
      expect(Array.isArray(both)).toBe(true);
      expect((both as unknown as Array<{ rows: unknown[] }>).length).toBe(2);
    } finally {
      await c.end().catch(() => {});
    }
  });
});
