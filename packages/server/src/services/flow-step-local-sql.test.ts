/**
 * A read that lives in the WORKFLOW rather than in the data source.
 *
 * Three things have to hold together and each is asserted with its control:
 * the ref check must STOP asking a question the shape has no answer to, the
 * replacement check must refuse what the executor would have refused later, and
 * the op rewrite must touch only the step it was told to.
 */
import { describe, expect, it } from "vitest";
import { checkFlowRefs, checkStepLocalSql } from "./flow-validator.service.js";
import { draftedStepSchema } from "./flow-drafted-shape.js";

const local = (over: Record<string, unknown> = {}) => ({
  id: "read_unshipped",
  kind: "query" as const,
  ref: "orders_demo.unshipped",
  paramsExpr: "[{}]",
  sql: "SELECT id FROM orders",
  datasourceRef: "orders_demo",
  ...over,
});
const model = (steps: unknown[]) => ({ id: "f", steps } as never);

describe("checkFlowRefs — a step-local read names no shared reader", () => {
  it("does not demand a registered ref for a step carrying its own SQL", () => {
    expect(checkFlowRefs(model([local()]), [])).toEqual([]);
  });

  it("CONTROL: the same unregistered ref without step SQL is still refused", () => {
    const { sql: _s, datasourceRef: _d, ...bare } = local();
    const findings = checkFlowRefs(model([bare]), []);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("unknown_ref");
  });

  it("⚠ needs BOTH keys — SQL with no datasource is not the exempt shape", () => {
    const { datasourceRef: _d, ...half } = local();
    expect(checkFlowRefs(model([half]), []).map((f) => f.rule)).toEqual(["unknown_ref"]);
  });
});

describe("checkStepLocalSql — refused at save, not at execution", () => {
  it("passes a complete, parameterless step-local read", () => {
    expect(checkStepLocalSql(model([local()]))).toEqual([]);
  });

  it("⚠ refuses a placeholder with nothing to bind — the failure that earned this", () => {
    const f = checkStepLocalSql(model([local({ sql: "SELECT id FROM orders WHERE p = $1" })]));
    expect(f.map((x) => x.rule)).toEqual(["step_sql_shape"]);
    expect(f[0]!.message).toMatch(/placeholder/i);
  });

  it("CONTROL: the same SQL with a declared order passes", () => {
    const f = checkStepLocalSql(
      model([
        local({
          sql: "SELECT id FROM orders WHERE p = $1",
          sqlParamOrder: ["period"],
          sqlParamsSchema: { period: { type: "string", required: true, description: "" } },
        }),
      ]),
    );
    expect(f).toEqual([]);
  });

  it("refuses SQL with no datasource named", () => {
    const { datasourceRef: _d, ...half } = local();
    expect(checkStepLocalSql(model([half])).map((f) => f.rule)).toEqual(["step_sql_without_datasource"]);
  });

  it("refuses a binding declared with no SQL — it would be silently ignored", () => {
    const { sql: _s, ...noSql } = local();
    expect(
      checkStepLocalSql(model([{ ...noSql, sqlParamOrder: ["period"] }])).map((f) => f.rule),
    ).toEqual(["step_sql_binding_without_sql"]);
  });

  it("⚠ still refuses a statement that writes, wherever it came from", () => {
    const f = checkStepLocalSql(model([local({ sql: "UPDATE orders SET shipped = true" })]));
    // ⚠ Not an exact count: `checkSqlShape` reports every rule a write breaks,
    // and pinning the number here would go red when it learns another one.
    expect(f.length).toBeGreaterThan(0);
    expect(new Set(f.map((x) => x.rule))).toEqual(new Set(["step_sql_shape"]));
  });
});

/**
 * ── THE PARSE DOOR, and it was the fourth allowlist these fields needed ──────
 *
 * `parseDraft` is how a model reaches `authorFlow`, and a chat turn goes through
 * it on EVERY op: the current flow is serialised, parsed by `draftedStepSchema`,
 * and whatever the schema has not heard of is dropped — zod strips unknown keys,
 * silently, by default.
 *
 * Measured against the live deployment on 2026-09-16, with the fields absent:
 * goal mode produced a step-local read correctly (its fill happens AFTER the
 * parse, which is why it hid this), and the very next chat message answered
 * `needs_component` — *"finance_demo IS a datasource … but it has no readable
 * component named employees_with_cost_centre"* — because the ref check was
 * handed a bare `ref` with nothing behind it. And had that turn succeeded it
 * would have written the step back WITHOUT its statement.
 *
 * ⚠ These tests are about a SCHEMA KEEPING A FIELD, which normally needs no
 * test. It needs one here because the failure is an absence: nothing throws,
 * nothing is reported, and the loss appears one layer away as a component that
 * does not exist.
 */
describe("the drafted step schema carries a step-local read", () => {
  const step = {
    id: "fetch_employees",
    kind: "datasource" as const,
    ref: "finance_demo.employees_with_cost_centre",
    paramsExpr: "[{}]",
    sql: "SELECT e.full_name, c.name FROM employees e JOIN cost_centres c ON c.id = e.cost_centre_id",
    datasourceRef: "finance_demo",
    sqlParamOrder: ["centre"],
    sqlParamsSchema: { centre: { type: "string", required: true } },
  };

  it("keeps all four fields through a parse", () => {
    const parsed = draftedStepSchema.parse(step) as Record<string, unknown>;
    expect(parsed.sql).toContain("JOIN cost_centres");
    expect(parsed.datasourceRef).toBe("finance_demo");
    expect(parsed.sqlParamOrder).toEqual(["centre"]);
    expect(parsed.sqlParamsSchema).toEqual({ centre: { type: "string", required: true } });
  });

  /**
   * ⚠ CONTROL. The schema must still strip what it genuinely does not know —
   * otherwise this stops being an allowlist and a typo'd field name reads as a
   * field that works.
   */
  it("⚠ CONTROL: still drops a field it does not declare", () => {
    const parsed = draftedStepSchema.parse({ ...step, sqlDialect: "postgres" }) as Record<string, unknown>;
    expect("sqlDialect" in parsed).toBe(false);
  });

  /**
   * ⚠ CONTROL. The round trip is what the chat turn actually performs — the
   * flow is JSON-serialised before it is parsed — so the assertion is made over
   * that, not over the object literal above.
   */
  it("⚠ CONTROL: survives the serialise-then-parse a chat turn really does", () => {
    const parsed = draftedStepSchema.parse(JSON.parse(JSON.stringify(step))) as Record<string, unknown>;
    expect(parsed.sql).toBe(step.sql);
    expect(parsed.datasourceRef).toBe(step.datasourceRef);
  });
});
