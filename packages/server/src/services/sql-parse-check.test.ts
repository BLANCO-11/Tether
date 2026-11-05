/** A compiled read must PARSE on the engine that runs it — checked before it is accepted (FL02, 2026-10-02). */
import { describe, expect, it } from "vitest";
import { syntaxProblem } from "./sql-parse-check.js";

const GOOD = `SELECT "t0"."id" AS "id" FROM "public"."devices" AS "t0" INNER JOIN "public"."readings" AS "t2" ON "t0"."id" = "t2"."device_id" WHERE "t0"."status" = $1 AND "t2"."read_at" = $2 AND "t2"."battery_pct" < "t0"."min_battery_pct"`;

describe("a compiled read parses on its own engine", () => {
  it("Postgres (PGlite): a placeholder that binds nothing, or broken syntax, is reported in the engine's words", async () => {
    expect(await syntaxProblem(GOOD.replace("$2", "$undefined"), "postgres")).toMatch(/syntax error/);
    expect(await syntaxProblem(GOOD.replace("WHERE", "WHERE AND"), "postgres")).toMatch(/syntax error/);
  }, 30000);
  it("CONTROL: a well-formed read parses — tables the empty database lacks say nothing about the statement", async () => {
    expect(await syntaxProblem(GOOD, "postgres")).toBeNull();
    expect(await syntaxProblem(`SELECT count(*) AS "n" FROM "public"."nowhere" AS "t0"`, "postgres")).toBeNull();
  }, 30000);
  it("SQLite: through the same translation execution uses", async () => {
    expect(await syntaxProblem(GOOD.replace(/"public"\./g, ""), "sqlite")).toBeNull();
    expect(await syntaxProblem(GOOD.replace(/"public"\./g, "").replace("WHERE", "WHERE AND"), "sqlite")).toMatch(/syntax error/);
  });
});
