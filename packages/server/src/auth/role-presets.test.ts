import { describe, it, expect } from "vitest";
import {
  ROLE_PRESETS,
  PRESET_ROLES,
  DECLARED_WIDENINGS,
  containsAll,
  presetPermissions,
  isPresetRole,
  ADMIN_IS_THE_WHOLE_WORKSPACE_CATALOGUE,
} from "./role-presets.js";
import { WORKSPACE_PERMISSIONS, isWorkspacePermission } from "./permissions.js";

describe("the built-in presets", () => {
  it("carry only workspace permissions — a preset can never hold `platform.*`", () => {
    for (const role of PRESET_ROLES) {
      for (const p of ROLE_PRESETS[role]) {
        expect(isWorkspacePermission(p), `${role} carries ${p}`).toBe(true);
      }
    }
  });

  it("are frozen, so a caller cannot widen one for the life of the process", () => {
    expect(Object.isFrozen(ROLE_PRESETS)).toBe(true);
    for (const role of PRESET_ROLES) expect(Object.isFrozen(ROLE_PRESETS[role])).toBe(true);
  });

  it("hold no duplicates and are sorted, so two reads of one preset are one string", () => {
    for (const role of PRESET_ROLES) {
      const list = ROLE_PRESETS[role];
      expect(new Set(list).size, `${role} has duplicates`).toBe(list.length);
      expect([...list], `${role} is not sorted`).toEqual([...list].sort());
    }
  });

  /**
   * ⚠ Was 19 / 23 / 38. `datasources.write` moved from `ADMIN_ADDS` to `AUTHOR`
   * on 2026-09-17 — onboarding a datasource is an author's job and the SCOPE is
   * `access_policy` on the row, enforced by the read-only transaction. Admin's
   * total is unchanged because it is built by union.
   *
   * ⚠ These numbers are here so a widening cannot be silent. Do not update one
   * to make a run green without deciding that the permission genuinely moved.
   */
  // 2026-10-15 (rbac-observability): `viewer` (Observer) added at 5, and admin gained `content.read.others`.
  it("are the sizes the design says: 5 / 22 / 25 / 42 (plugins.read in author, plugins.enable and reports.read in admin; approvals.decide moved to author, sharing-boundaries)", () => {
    expect(ROLE_PRESETS.viewer.length).toBe(5);
    expect(ROLE_PRESETS.author.length).toBe(22);
    expect(ROLE_PRESETS.approver.length).toBe(25);
    expect(ROLE_PRESETS.admin.length).toBe(42);
  });

  it("lets an author onboard a datasource, the scope being access_policy's job", () => {
    expect(ROLE_PRESETS.author).toContain("datasources.write");
    // The containment the presets are built to guarantee still holds.
    expect(ROLE_PRESETS.admin).toContain("datasources.write");
    expect(ROLE_PRESETS.approver).toContain("datasources.write");
  });

  it("resolve a non-preset name to nothing rather than to a default", () => {
    expect(isPresetRole("admin")).toBe(true);
    expect(isPresetRole("Admin")).toBe(false);
    expect(isPresetRole("owner")).toBe(false);
    expect(presetPermissions("owner")).toEqual([]);
    // ⚠ A custom role's name reaching this function must produce EMPTY, never `author`.
    // A default here would silently give every unknown role a working set of permissions.
    expect(presetPermissions("")).toEqual([]);
  });
});

/**
 * INV-4 — `admin ⊇ approver ⊇ author`, as SET CONTAINMENT.
 *
 * ⚠ This is the property `RANK`'s integer comparison used to express. The property
 * survives the deletion of `RANK`; the mechanism does not. Containment is strictly more
 * general — a custom role is not on any line, and there is no integer that could place
 * it there.
 */
describe("INV-4: the presets are ordered by containment, not by rank", () => {
  it("admin ⊇ approver ⊇ author", () => {
    expect(containsAll(ROLE_PRESETS.approver, ROLE_PRESETS.author)).toBe(true);
    expect(containsAll(ROLE_PRESETS.admin, ROLE_PRESETS.approver)).toBe(true);
    expect(containsAll(ROLE_PRESETS.admin, ROLE_PRESETS.author)).toBe(true);
  });

  it("and the containment is STRICT in both steps", () => {
    // Without this, three identical presets would satisfy the assertion above.
    expect(containsAll(ROLE_PRESETS.author, ROLE_PRESETS.approver)).toBe(false);
    expect(containsAll(ROLE_PRESETS.approver, ROLE_PRESETS.admin)).toBe(false);
  });

  it("CONTROL: containsAll can answer false", () => {
    // A predicate that always returns true satisfies every assertion above.
    expect(containsAll(["flows.read"], ["flows.write"])).toBe(false);
    expect(containsAll([], ["flows.read"])).toBe(false);
    expect(containsAll(["flows.read"], [])).toBe(true);
  });

  it("admin is the WHOLE workspace catalogue", () => {
    expect(ADMIN_IS_THE_WHOLE_WORKSPACE_CATALOGUE).toBe(true);
    expect([...ROLE_PRESETS.admin].sort()).toEqual([...WORKSPACE_PERMISSIONS].sort());
  });
});

/**
 * INV-5 — the presets reproduce the roles this deployment already had.
 *
 * ⚠ **THE ORIGINAL FORM OF THIS INVARIANT IS NOT DERIVABLE, and it is worth knowing why
 * before somebody "restores" it.**
 *
 * (a) It said "pin against today's ROLE_CAPS". There are TWO `ROLE_CAPS` and they
 *     disagree on exactly one cell. We pin against the SERVER's, with `flows.arm` on
 *     `approver` spelled out below as a declared exception rather than folded into an
 *     expected set — a widening that rides inside an expected set is invisible.
 *
 * (b) It said "the routes that role can reach today". That is degenerate: 106 of the 142
 *     workspace-scoped routes carry no authorisation check at all, so today EVERY role
 *     and every non-member reaches all of them, and the derived set is the whole
 *     catalogue for everybody. Dropped.
 *
 * (c) It said "diff against baseline-access.json". That file's member list is EMPTY —
 *     zero members and zero capability grants across eight workspaces — so there is
 *     nothing to diff. ⚠ **Do not describe this test as making SC-003 provable.** With
 *     zero members SC-003 is vacuous on this deployment, and a test cannot repair that.
 */
describe("INV-5: the presets carry today's capabilities forward", () => {
  /**
   * The server's `ROLE_CAPS` as it stands in
   * `services/workspace-member-capabilities.service.ts`, mapped onto catalogue names by
   * the same correspondence migration 0065 applies. Written out here rather than
   * imported, deliberately: importing it would make this test agree with whatever that
   * file says, which is the opposite of pinning it.
   */
  const TODAYS_SERVER_ROLE_CAPS: Record<"author" | "approver" | "admin", string[]> = {
    // author: ["edit-workflows"]
    author: ["flows.write"],
    // approver: ["edit-workflows", "approve"]   ⚠ no `publish` — that is the widening
    approver: ["flows.write", "flows.approve"],
    // admin: ["edit-workflows", "publish", "approve", "resources", "admin", "real-data"]
    // `admin` itself is dropped by 0065 — a role wearing a capability's clothes (INV-10).
    admin: ["flows.write", "flows.arm", "flows.approve", "resources.read", "realdata.use"],
  };

  /** Migration 0065's rename, so this test and that migration cannot disagree. */
  const CAPABILITY_RENAME: Record<string, string | null> = {
    "edit-workflows": "flows.write",
    publish: "flows.arm",
    approve: "flows.approve",
    resources: "resources.read",
    admin: null,
    "platform-admin": null,
    "real-data": "realdata.use",
  };

  it("0065's rename lands every surviving value in the catalogue", () => {
    for (const [was, becomes] of Object.entries(CAPABILITY_RENAME)) {
      if (becomes === null) continue;
      expect(isWorkspacePermission(becomes), `${was} -> ${becomes} is not a permission`).toBe(
        true,
      );
    }
    // INV-10: exactly two are dropped, and both were roles rather than permissions.
    const dropped = Object.entries(CAPABILITY_RENAME)
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    expect(dropped.sort()).toEqual(["admin", "platform-admin"]);
  });

  it("every capability a role has today survives into its preset", () => {
    for (const role of ["author", "approver", "admin"] as const) {
      const have = new Set<string>(ROLE_PRESETS[role]);
      for (const cap of TODAYS_SERVER_ROLE_CAPS[role]) {
        expect(have.has(cap), `${role} LOST ${cap}`).toBe(true);
      }
    }
  });

  it("the ONE declared widening is `approver` gaining `flows.arm`, and nothing else", () => {
    // Spelled out, not folded in. If a second widening is ever taken, it is a decision
    // and it belongs in spec.md before it belongs in the presets.
    expect(DECLARED_WIDENINGS.length).toBe(1);
    expect(DECLARED_WIDENINGS[0]).toMatchObject({
      role: "approver",
      permission: "flows.arm",
    });
    expect(DECLARED_WIDENINGS[0]!.why).toMatch(/D-4/);

    // It really is a widening: today's server ROLE_CAPS does NOT give approver `publish`.
    expect(TODAYS_SERVER_ROLE_CAPS.approver).not.toContain("flows.arm");
    // And the preset really does grant it.
    expect(ROLE_PRESETS.approver).toContain("flows.arm");
  });

  it("D-8: four sensitive reads sit with admin, and members.read does not", () => {
    for (const p of ["secrets.read", "audit.read", "breakglass.read", "budget.read"] as const) {
      expect(ROLE_PRESETS.author, `author should not hold ${p}`).not.toContain(p);
      expect(ROLE_PRESETS.approver, `approver should not hold ${p}`).not.toContain(p);
      expect(ROLE_PRESETS.admin, `admin should hold ${p}`).toContain(p);
    }
    // ⚠ `members.read` deliberately STAYS with author — it is the one read in that group
    // with a real answer today, and a member who cannot approve still has to be able to
    // find out who can.
    expect(ROLE_PRESETS.author).toContain("members.read");
  });

  it("D-7: runs.replay belongs to approver, not to author and not to nobody", () => {
    expect(ROLE_PRESETS.author).not.toContain("runs.replay");
    expect(ROLE_PRESETS.approver).toContain("runs.replay");
  });
});
