import { describe, it, expect } from "vitest";
import { PLATFORM_CONFERS, conferredByPlatform, CONFERRABLE } from "./platform-conferral.js";
import { isWorkspacePermission, isPlatformPermission } from "./permissions.js";

/**
 * The built-in platform roles, as migration 0063 seeds them. Written out here rather than
 * read from the database, deliberately: this asserts a PROPERTY OF THE DESIGN, and a test
 * that reads the rows would agree with whatever the rows happen to say.
 */
const BUILTIN_PLATFORM_ROLES = {
  "platform-admin": [
    "platform.workspaces.write",
    "platform.members.grant",
    "platform.users.read",
    "platform.roles.write",
    "platform.generation.write",
    "platform.localusers.write",
    "platform.audit.read",
    "platform.ops.read",
    "platform.toolmodel.read",
    "platform.toolmodel.write",
    "platform.signals.read",
  ],
  // 0100 (2026-10-15) merged `support` into `auditor`: one read-only platform profile.
  auditor: [
    "platform.users.read",
    "platform.audit.read",
    "platform.ops.read",
    "platform.signals.read",
  ],
} as const;

describe("INV-18: the conferral is EXACTLY two permissions", () => {
  /**
   * ⚠ **SET EQUALITY. NOT A SUBSET. NOT AN ABSENCE CHECK.**
   *
   * `expect(CONFERRABLE).not.toContain("secrets.read")` passes while somebody adds
   * `flows.read`. `expect(CONFERRABLE.every(isWorkspacePermission))` passes while
   * somebody adds all thirty-eight. The entire cost of D-9 — a platform administrator
   * can see and change every workspace's member list, and nothing else — is bounded by
   * this one assertion. If it is ever relaxed, the standards amendment's sentence about
   * what a platform administrator can reach stops being true and nothing says so.
   */
  it("the image of the map equals {members.read, members.grant}", () => {
    expect([...CONFERRABLE].sort()).toEqual(["members.grant", "members.read"]);
  });

  it("and the map has exactly one key: the permission, not a role name", () => {
    expect(Object.keys(PLATFORM_CONFERS)).toEqual(["platform.members.grant"]);
    // Keyed on the permission — so a CUSTOM platform role holding it confers the same.
    for (const key of Object.keys(PLATFORM_CONFERS)) {
      expect(isPlatformPermission(key), `${key} is not a platform permission`).toBe(true);
    }
  });

  it("confers only workspace permissions — a conferral can never yield `platform.*`", () => {
    for (const conferred of Object.values(PLATFORM_CONFERS)) {
      for (const w of conferred) {
        expect(isWorkspacePermission(w), `${w} is not a workspace permission`).toBe(true);
      }
    }
  });

  it("is frozen, map and values", () => {
    expect(Object.isFrozen(PLATFORM_CONFERS)).toBe(true);
    for (const v of Object.values(PLATFORM_CONFERS)) expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(CONFERRABLE)).toBe(true);
  });
});

describe("conferredByPlatform", () => {
  it("gives a platform.members.grant holder exactly members.read and members.grant", () => {
    expect(conferredByPlatform(["platform.members.grant"])).toEqual([
      "members.grant",
      "members.read",
    ]);
  });

  it("CONTROL: it can return something — 'confers nothing' is not the only answer", () => {
    // Without this, a function that returned [] unconditionally would satisfy every
    // INV-12 assertion below and score 100%.
    expect(conferredByPlatform(["platform.members.grant"]).length).toBeGreaterThan(0);
  });

  it("ignores a platform permission that confers nothing, and unknown strings", () => {
    expect(conferredByPlatform(["platform.audit.read"])).toEqual([]);
    expect(conferredByPlatform(["nope.nope"])).toEqual([]);
    expect(conferredByPlatform([])).toEqual([]);
  });

  it("deduplicates and sorts, so two reads are one string", () => {
    const twice = conferredByPlatform([
      "platform.members.grant",
      "platform.members.grant",
      "platform.audit.read",
    ]);
    expect(twice).toEqual(["members.grant", "members.read"]);
  });
});

/**
 * INV-12 — the auditor sees the audit record and no tenant data.
 *
 * ⚠ **THE SUBJECT OF THIS TEST MOVED WITH D-9.** It used to read "the auditor's
 * permission list does not intersect the workspace catalogue". That is now the WRONG
 * assertion: platform roles *can* confer workspace permissions, so the question is no
 * longer what the auditor's list contains but what it CONFERS. Computed through the same
 * map the resolver uses — the old form would pass while `platform.audit.read` quietly
 * acquired a conferral, which is precisely the change that would break FR-021 and SC-010.
 */
describe("INV-12: the auditor confers nothing, computed through the map", () => {
  it("auditor", () => {
    expect(conferredByPlatform(BUILTIN_PLATFORM_ROLES.auditor)).toEqual([]);
  });

  it("platform-admin confers the two, and ONLY the two", () => {
    expect(conferredByPlatform(BUILTIN_PLATFORM_ROLES["platform-admin"])).toEqual([
      "members.grant",
      "members.read",
    ]);
  });

  it("no built-in platform role confers a data read", () => {
    for (const [key, perms] of Object.entries(BUILTIN_PLATFORM_ROLES)) {
      const conferred = conferredByPlatform(perms);
      for (const forbidden of [
        "flows.read",
        "runs.read",
        "secrets.read",
        "datasources.read",
        "audit.read",
      ]) {
        expect(conferred, `${key} confers ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("INV-13: no platform permission confers anything named for super admin", () => {
    // There is no `platform.superadmin` and no path from a row to `config.isSuperAdmin`.
    for (const key of Object.keys(PLATFORM_CONFERS)) {
      expect(key).not.toMatch(/superadmin|super_admin/i);
    }
    for (const w of CONFERRABLE) expect(w).not.toMatch(/superadmin|super_admin/i);
  });
});
