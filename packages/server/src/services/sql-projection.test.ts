import { describe, it, expect } from "vitest";
import { selectProjection } from "./sql-projection.js";

/**
 * ⚠ Every refusal below is a `undefined`, and `undefined` means the caller says
 * NOTHING — it is not a finding. That is the whole safety argument for this
 * module: `unknown_output_column` blocks a save, so a projection that is merely
 * incomplete would refuse work that is correct (I-62).
 */
describe("selectProjection — the keys a statement's rows arrive under", () => {
  it("reads a quoted alias byte-exact", () => {
    expect(selectProjection(`SELECT count(*) AS "onboarded_count" FROM "public"."partners_user"`))
      .toEqual(["onboarded_count"]);
  });

  it("reads a lower-case bare alias", () => {
    expect(selectProjection("SELECT count(*) AS total FROM t")).toEqual(["total"]);
  });

  it("reads bare and qualified column references", () => {
    expect(selectProjection("SELECT id, u.email, t.created_at FROM users u")).toEqual([
      "id",
      "email",
      "created_at",
    ]);
  });

  it("reads a quoted column reference, and a quoted qualifier does not confuse it", () => {
    expect(selectProjection(`SELECT "firstName", u."lastName" FROM "User" u`)).toEqual([
      "firstName",
      "lastName",
    ]);
  });

  it("survives comments, newlines and a trailing semicolon", () => {
    expect(
      selectProjection(`
        SELECT -- the count, from FROM, with a comma ,
          count(*) AS "n"  /* block , comment */
        FROM t;`),
    ).toEqual(["n"]);
  });

  it("is not fooled by a comma or FROM inside a string literal", () => {
    expect(selectProjection(`SELECT 'a, b from c' AS label, id FROM t`)).toEqual(["label", "id"]);
  });

  it("is not fooled by a comma inside a function call", () => {
    expect(selectProjection("SELECT coalesce(a, b) AS v, max(x) AS w FROM t")).toEqual(["v", "w"]);
  });

  it("handles a statement with no FROM at all", () => {
    expect(selectProjection("SELECT 1 AS one")).toEqual(["one"]);
  });

  it("takes the alias, not the column, when both are present", () => {
    expect(selectProjection("SELECT u.email AS contact FROM users u")).toEqual(["contact"]);
  });

  it("allows DISTINCT", () => {
    expect(selectProjection("SELECT DISTINCT dept FROM employees")).toEqual(["dept"]);
  });
});

describe("selectProjection — every doubt refuses the WHOLE statement", () => {
  const refused: Array<[string, string]> = [
    ["a star", "SELECT * FROM t"],
    ["a qualified star", "SELECT t.* FROM t"],
    ["a star beside a real column", "SELECT id, * FROM t"],
    ["an unaliased expression", "SELECT count(*) FROM t"],
    ["one unaliased expression among good ones", "SELECT count(*) AS n, sum(x) FROM t"],
    ["an implicit alias", "SELECT count(*) n FROM t"],
    ["a set operation", "SELECT a FROM t UNION SELECT b FROM u"],
    ["an EXCEPT", "SELECT a FROM t EXCEPT SELECT a FROM u"],
    ["a CTE", "WITH x AS (SELECT 1 AS a) SELECT a FROM x"],
    ["two statements", "SELECT a FROM t; SELECT b FROM u"],
    ["an unterminated quote", `SELECT "a FROM t`],
    ["an unterminated block comment", "SELECT a /* FROM t"],
    ["a dollar-quoted body", "SELECT $$x$$ AS a"],
    ["nothing at all", "   "],
    ["not a SELECT", "UPDATE t SET a = 1"],
    ["DISTINCT ON", "SELECT DISTINCT ON (a) a AS x FROM t"],
    ["two columns landing on one key", "SELECT a AS v, b AS v FROM t"],
  ];
  for (const [what, sql] of refused) {
    it(`refuses ${what}`, () => {
      expect(selectProjection(sql)).toBeUndefined();
    });
  }

  /**
   * ⚠ The dialect sidestep, and the reason it is a refusal rather than a fold.
   * Postgres lower-cases an unquoted alias and MySQL does not, so either answer
   * invents a false positive on one of them — and this module is handed no
   * dialect. A QUOTED alias is byte-exact in both, so it is allowed.
   */
  it("refuses an unquoted alias that is not already lower case", () => {
    expect(selectProjection("SELECT count(*) AS Onboarded_Count FROM t")).toBeUndefined();
    expect(selectProjection("SELECT Email FROM t")).toBeUndefined();
    expect(selectProjection(`SELECT count(*) AS "Onboarded_Count" FROM t`)).toEqual([
      "Onboarded_Count",
    ]);
  });

  it("never returns an empty array — `undefined` and `[]` are not interchangeable", () => {
    for (const [, sql] of refused) {
      expect(selectProjection(sql)).not.toEqual([]);
    }
  });
});

/**
 * CONTROL. Without this, a function returning `undefined` for everything passes
 * every refusal above and the suite is worthless.
 */
describe("CONTROL: selectProjection can answer", () => {
  it("returns a real projection for ordinary SQL", () => {
    const got = selectProjection("SELECT id, name AS label FROM t");
    expect(got).toEqual(["id", "label"]);
    expect(got).not.toBeUndefined();
  });
});
