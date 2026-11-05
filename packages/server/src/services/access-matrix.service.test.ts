import { describe, expect, it } from "vitest";
import { reachOf, viaOf } from "./access-matrix.service.js";
import { presetPermissions } from "../auth/role-presets.js";

describe("who can see what — the reach of a permission set", () => {
  it("follows the four presets, Observer to Admin", () => {
    expect(reachOf(presetPermissions("viewer"))).toBe("published");
    expect(reachOf(presetPermissions("author"))).toBe("own");
    expect(reachOf(presetPermissions("approver"))).toBe("review");
    expect(reachOf(presetPermissions("admin"))).toBe("everything");
  });

  it("is none for nothing, and for a platform admin's two conferred permissions (people, not content)", () => {
    expect(reachOf([])).toBe("none");
    expect(reachOf(["members.read", "members.grant"])).toBe("none");
  });

  it("names every reason, a super admin as one", () => {
    expect(viaOf({ "flows.read": [{ via: "preset", role: "author" }, { via: "grant" }], "x": [{ via: "role", roleId: "r", roleName: "Auditors" }] }, false))
      .toEqual(["Creator", "custom role Auditors", "individual grant"]);
    expect(viaOf({}, true)).toEqual(["super admin"]);
  });
});
