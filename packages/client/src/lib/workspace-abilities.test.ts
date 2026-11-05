import { describe, expect, it } from "vitest";
import { workspaceAbilities } from "./workspace-abilities";

const answer = (permissions: string[], platformPermissions: string[] = [], memberRole: string | null = null) => ({
  permissions,
  platformPermissions,
  memberRole,
});

describe("workspaceAbilities", () => {
  it("a workspace's own admin manages members and limits, but renaming needs the platform permission", () => {
    const a = workspaceAbilities(answer(["members.read", "members.grant", "budget.read", "budget.write"], [], "admin"), false);
    expect(a).toEqual({ readMembers: true, addPeople: true, changeSettings: false, readLimits: true, changeLimits: true });
  });
  it("a platform admin changes the settings of an open workspace", () => {
    expect(workspaceAbilities(answer([], ["platform.workspaces.write"]), false).changeSettings).toBe(true);
  });
  it("a RESTRICTED workspace's settings are its own admins' — the platform permission alone is not enough", () => {
    expect(workspaceAbilities(answer([], ["platform.workspaces.write"]), true).changeSettings).toBe(false);
    expect(workspaceAbilities(answer([], ["platform.workspaces.write"], "admin"), true).changeSettings).toBe(true);
  });
  it("a Creator reads members and changes nothing here", () => {
    const a = workspaceAbilities(answer(["members.read"], [], "author"), false);
    expect(a).toEqual({ readMembers: true, addPeople: false, changeSettings: false, readLimits: false, changeLimits: false });
  });
});
