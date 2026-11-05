/**
 * Registry tests — postgres/postgresql resolve to the pglite driver;
 * everything else is an explicit unsupported error (hard refuse upstream).
 */
import { describe, expect, it } from "vitest";
import { driverFor, supportsMockType } from "./registry.js";
import { pgliteDriver } from "./pglite.driver.js";
import { UnsupportedMockEngineError } from "./types.js";

describe("mock engine registry", () => {
  it.each(["postgres", "postgresql", "Postgres", "POSTGRESQL"])("resolves %s to the pglite driver", (t) => {
    expect(driverFor(t)).toBe(pgliteDriver);
    expect(driverFor(t).dialect).toBe("postgres");
  });

  it.each(["mysql", "mariadb", "mongodb", "s3", "snowflake", "", "postgres "])(
    "refuses %s with an explicit unsupported error",
    (t) => {
      let caught: unknown;
      try {
        driverFor(t);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(UnsupportedMockEngineError);
      expect((caught as UnsupportedMockEngineError).code).toBe("mock_engine_unsupported");
      expect((caught as UnsupportedMockEngineError).datasourceType).toBe(t);
    },
  );

  it("supportsMockType agrees with driverFor", () => {
    expect(supportsMockType("postgres")).toBe(true);
    expect(supportsMockType("postgresql")).toBe(true);
    expect(supportsMockType("mysql")).toBe(false);
    expect(supportsMockType("mongodb")).toBe(false);
  });
});
