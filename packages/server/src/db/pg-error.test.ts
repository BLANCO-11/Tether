import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { pgErrorCode } from "./pg-error.js";

/**
 * ⚠ The tests in `error.middleware.test.ts` and `health.service.test.ts` hand the code a plain `{ code }` object — the
 * shape a raw driver error has. From drizzle-orm 0.44 nothing Drizzle throws has that shape: the SQLSTATE is on
 * `err.cause`. Those tests stayed green while `err.code === "22P02"` stopped matching in production. So the shape is
 * taken HERE from a real query through Drizzle, not written by hand.
 */
describe("pgErrorCode reads the SQLSTATE through Drizzle's wrapper", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client);
  });
  afterAll(async () => {
    await client.close();
  });

  const thrown = async (q: ReturnType<typeof sql>) => {
    try {
      await db.execute(q);
    } catch (e) {
      return e;
    }
    throw new Error("the query was expected to fail");
  };

  it("a malformed uuid through Drizzle is 22P02", async () => {
    const e = await thrown(sql`select ${"not-a-uuid"}::uuid`);
    expect(pgErrorCode(e)).toBe("22P02");
  });

  it("a missing table through Drizzle is 42P01", async () => {
    const e = await thrown(sql`select count(*) from drizzle.__drizzle_migrations`);
    expect(pgErrorCode(e)).toBe("42P01");
  });

  /** Why the helper exists: the wrapper does not carry the code itself, so a bare `err.code` read misses it. */
  it("CONTROL — Drizzle's error does not carry the SQLSTATE on itself", async () => {
    const e = (await thrown(sql`select ${"not-a-uuid"}::uuid`)) as { code?: unknown; cause?: { code?: unknown } };
    expect(e.code).toBeUndefined();
    expect(e.cause?.code).toBe("22P02");
  });
});

describe("pgErrorCode on hand-built shapes", () => {
  it("a raw driver error", () => {
    expect(pgErrorCode(Object.assign(new Error("x"), { code: "22P02" }))).toBe("22P02");
  });

  it("a wrapper of a wrapper", () => {
    const raw = Object.assign(new Error("x"), { code: "42P01" });
    expect(pgErrorCode(new Error("outer", { cause: new Error("mid", { cause: raw }) }))).toBe("42P01");
  });

  /** A Node or application code on the wrapper is not a SQLSTATE and must not hide the one underneath. */
  it("skips a code that is not a SQLSTATE", () => {
    const raw = Object.assign(new Error("x"), { code: "22P02" });
    expect(pgErrorCode(Object.assign(new Error("outer", { cause: raw }), { code: "ECONNRESET" }))).toBe("22P02");
    expect(pgErrorCode(Object.assign(new Error("y"), { code: "ops_api_unavailable" }))).toBeUndefined();
  });

  it("nothing to read", () => {
    expect(pgErrorCode(undefined)).toBeUndefined();
    expect(pgErrorCode("22P02")).toBeUndefined();
    expect(pgErrorCode(new Error("no code"))).toBeUndefined();
  });
});
