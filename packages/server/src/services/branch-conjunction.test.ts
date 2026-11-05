import { describe, it, expect } from "vitest";
import { displayCondition } from "./flow-compiler.service.js";
import { validateGeneratedExpr, PEBBLE_OPERATORS } from "./flow-expression.service.js";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PHASE 4a.1 · TWO CONDITIONS ON ONE ARM
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `amount > 1000 AND region = EU` was unexpressible: `conditions` accepted an
 * array and the compiler refused anything past the first by name.
 *
 * ⚠ The spelling was MEASURED against v1.3.29 (2026-09-22) with a positive and
 * a negative control, and the first probe's control FAILED — it read
 * `outputs.rows.body` against a `core.debug.Return` whose output is `.value`,
 * so every case came back false and `and` looked broken. A probe with no
 * control would have recorded that as a property of the engine.
 */
const rows = { id: "rows", kind: "datasource", ref: "d.q", paramsExpr: "{}" };
const branch = (conditions: unknown[]) =>
  ({ id: "guard", kind: "branch", dependsOn: ["rows"], conditions }) as never;
const GT = { left: { stepId: "rows", field: "amount" }, op: "field_gt", right: { fixed: "1000" } };
const EQ = { left: { stepId: "rows", field: "region" }, op: "field_eq", right: { fixed: "EU" } };
const render = (conditions: unknown[]) =>
  displayCondition(branch(conditions), [rows, branch(conditions)] as never);

describe("two conditions become ONE template joined with `and`", () => {
  it("⚠ one template, never two — `{{ A }} and {{ B }}` renders the TEXT \"true and false\"", () => {
    const out = render([GT, EQ])!;
    // Exactly one span. Two spans concatenate to a string that is not "true",
    // so the arm never runs and never errors either.
    expect(out.match(/\{\{/g)).toHaveLength(1);
    expect(out.startsWith("{{ (")).toBe(true);
    expect(out).toContain(") and (");
  });

  it("each part keeps its own parentheses, so precedence cannot bite", () => {
    const out = render([GT, EQ])!;
    expect(out).toContain("(.amount | tonumber?) > 1000");
    expect(out).toContain('.region == "EU"');
  });

  it("three conditions join with two `and`s", () => {
    const out = render([GT, EQ, GT])!;
    expect(out.match(/\) and \(/g)).toHaveLength(2);
    expect(out.match(/\{\{/g)).toHaveLength(1);
  });

  it("one condition is unchanged — the single-condition bytes do not move", () => {
    expect(render([GT])).toBe(
      "{{ json(outputs.rows.body).results[0].data | jq('any(.[]; (.amount | tonumber?) > 1000)') | first }}",
    );
  });
});

describe("D-22's allowlist accepts the conjunction and still refuses a call", () => {
  it("the rendered conjunction passes", () => {
    expect(validateGeneratedExpr(render([GT, EQ])!, "guard.condition")).toEqual([]);
  });

  /**
   * ⚠ **THE BYPASS THAT MUST STAY CLOSED.** `CALL_RE` is `identifier\s*\(`, and
   * the `\s*` is load-bearing: without it `secret ('FOUNDRY_CALLBACK')` with one
   * space walks past D-22 and posts Kestra's callback secret to a tenant
   * endpoint. The operator exemption must not reopen it.
   */
  it("`secret ('X')` with a space is still refused", () => {
    expect(validateGeneratedExpr("{{ secret ('X') }}", "w")[0]?.message).toMatch(/not callable/);
  });

  /**
   * ⚠ The exemption is the OPERATOR, not the word. `and('x')` is a call to a
   * function Pebble does not have — it would pass every static check and die at
   * render naming nothing, which is I-44's shape.
   */
  it("`and('x')` — no space — is refused as a call", () => {
    expect(validateGeneratedExpr("{{ and('x') }}", "w")[0]?.message).toMatch(/`and\(…\)` is not callable/);
  });

  it("`and` is also not reported as an unreadable ROOT", () => {
    // The roots message would be advice for a mistake nobody made — the I-43
    // lesson, where a wrong finding cost a redraft and reproduced the error.
    for (const f of validateGeneratedExpr(render([GT, EQ])!, "guard.condition")) {
      expect(f.message).not.toMatch(/not readable/);
    }
  });

  /**
   * ⚠ ONLY what was measured. `or` and `not` are plausible and unmeasured, and
   * `PEBBLE_ABSENT` records `not` coming back
   * `ParserException: Unexpected token "not" of type OPERATOR`. An OR needs no
   * entry: an `elif` chain already expresses one.
   */
  it("the operator list is exactly what was run against the engine", () => {
    expect([...PEBBLE_OPERATORS]).toEqual(["and"]);
  });
});

/**
 * ⚠ `conjoinConditions`' REFUSAL branches — added 2026-09-22, after the phase
 * 4a.1 records recorded them as unpinned.
 *
 * These are the controls standing between an unrecognised span and D-234's
 * silent-false concatenation: the whole reason the conjunction is one template
 * is that two templates render the literal text `true and false`, which is
 * truthy garbage the engine never complains about. A refusal that guards that
 * and is itself unasserted is I-38 one level in.
 */
describe("a condition that cannot be combined is REFUSED, never concatenated", () => {
  /** A literal carrying a template — the I-11 hazard, arriving through a value. */
  const nested = {
    left: { stepId: "rows", field: "region" },
    op: "field_eq",
    right: { fixed: "{{ secret('FOUNDRY_CALLBACK') }}" },
  };

  it("refuses a nested `{{`, naming the step", () => {
    expect(() => render([GT, nested])).toThrow(/branch step "guard".*nested "\{\{"/s);
  });

  it("refuses it even when the literal closes the span first", () => {
    // `}} x {{` escapes the template and reopens it. The outer match is greedy,
    // so this lands in the same branch — and it must, because the alternative
    // is an expression whose shape the compiler did not choose.
    const closer = {
      left: { stepId: "rows", field: "region" },
      op: "field_eq",
      right: { fixed: "}} x {{" },
    };
    expect(() => render([GT, closer])).toThrow(/nested "\{\{"/);
  });

  it("the control: the same pair without the literal template compiles", () => {
    // Without this, a `conjoinConditions` that threw on every two-condition
    // branch would pass both assertions above.
    expect(() => render([GT, EQ])).not.toThrow();
  });

  /**
   * ⚠ **A SINGLE condition takes a different road to the same refusal, and
   * finding that out is why this test exists.** The one-condition path never
   * calls `conjoinConditions` — it renders and returns — so it does NOT throw
   * here. It is refused one layer down, by D-22's scanner, which detects a
   * nested `{{` for I-11's sake on every generated expression.
   *
   * Written the other way round first, asserting a throw, and it went red. The
   * property held; the mechanism was somewhere else. Both are pinned rather
   * than one, because "two conditions are guarded and one is not" is exactly
   * the half-guard this would otherwise have been.
   */
  it("a nested `{{` in a SINGLE condition is refused too — by the scanner", () => {
    const out = render([nested]);
    expect(typeof out).toBe("string");
    expect(validateGeneratedExpr(out!, "guard.condition")[0]?.message).toMatch(
      /nested inside another one/,
    );
  });

  it("the control: a single ordinary condition passes the scanner clean", () => {
    expect(validateGeneratedExpr(render([GT])!, "guard.condition")).toEqual([]);
  });
});

/**
 * ⚠ STATED, NOT TESTED: `conjoinConditions`' other throw — *"a condition that
 * is not a single template"* — is **defensively unreachable** from here.
 * `displayCondition` builds every condition itself and always wraps it in one
 * `{{ … }}` span, so no input to this module can produce an unwrapped one.
 *
 * It is deliberately left in place rather than deleted: it is the assertion
 * that the contract between the renderer and the joiner still holds, and the
 * day somebody adds a second renderer it becomes reachable. Recording it as
 * unreachable is the honest alternative to a test that fabricates the state —
 * which is what this repo's own `platform-user.test.ts` lesson is about.
 */
