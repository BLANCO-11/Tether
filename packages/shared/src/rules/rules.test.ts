import { describe, expect, it } from "vitest";
import { ENV_NAME_RE, AUTH_STYLES } from "./index.js";

/**
 * SC-006 — these values are now sourced from ONE place; client and server
 * import the same export, so there is nothing left to compare for
 * equivalence except that the exported values themselves are correct
 * (research.md Decision 4). Fixtures match the ones the two duplicated
 * copies were each independently tested against before this migration.
 */
describe("ENV_NAME_RE", () => {
  it("accepts a valid env-var-shaped name", () => {
    for (const name of ["FOO", "foo_bar", "_PRIVATE", "MAIL_API_KEY", "a1"]) {
      expect(ENV_NAME_RE.test(name), name).toBe(true);
    }
  });

  it("rejects a name that is not env-var-shaped", () => {
    for (const name of ["", "1FOO", "foo-bar", "foo bar", "foo.bar"]) {
      expect(ENV_NAME_RE.test(name), name).toBe(false);
    }
  });
});

describe("AUTH_STYLES", () => {
  it("is exactly the four credential styles plus none, in the server's order", () => {
    expect(AUTH_STYLES).toEqual(["bearer", "header", "query", "basic", "none"]);
  });
});
