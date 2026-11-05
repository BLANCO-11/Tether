import { describe, expect, it } from "vitest";
import { MATRIX_ROWS, cellFor, presetsFrom } from "./role-matrix";

// The rows are checked against the server's presets in packages/server/src/auth/role-matrix.test.ts — the web image
// has no server source, so that check cannot live here.
describe("the roles table, in the client", () => {
  it("a row is yes, no, or partly by how many of its permissions are held", () => {
    const row = { label: "x", needs: ["a", "b"] };
    expect(cellFor(row, ["a", "b", "c"])).toBe("yes");
    expect(cellFor(row, ["c"])).toBe("no");
    expect(cellFor(row, ["a"])).toBe("partly");
    expect(MATRIX_ROWS.length).toBeGreaterThan(0);
  });

  it("takes only the built-in roles from the server's list", () => {
    const got = presetsFrom([
      { name: "viewer", builtin: true, permissions: ["flows.read"] },
      { name: "Auditors", builtin: false, permissions: ["audit.read"] },
    ]);
    expect(got).toEqual({ viewer: ["flows.read"] });
  });
});
