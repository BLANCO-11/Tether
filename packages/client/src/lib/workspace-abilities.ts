/**
 * What the workspace page offers its reader (admin simplify, phase 4), from the server's answer for THAT workspace
 * (`GET /api/workspaces/:ws/me/permissions`). It reads permission keys the server returned; it holds no role table.
 *
 * ⚠ `changeSettings` mirrors two server rules and adds none: renaming, purpose and delete are `platform.workspaces.write`
 * (`PATCH|DELETE /api/workspaces/:id`), and a RESTRICTED workspace is its own admins' to change (`isOwnAdmin` in
 * `routes/workspaces.ts`). The routes still decide; this only stops offering what they would refuse.
 */
export interface WorkspaceAbilities {
  readMembers: boolean;
  addPeople: boolean;
  changeSettings: boolean;
  readLimits: boolean;
  changeLimits: boolean;
}

export function workspaceAbilities(
  answer: { permissions: string[]; platformPermissions: string[]; memberRole: string | null },
  restricted: boolean,
): WorkspaceAbilities {
  const has = (p: string) => answer.permissions.includes(p);
  return {
    readMembers: has("members.read"),
    addPeople: has("members.grant"),
    changeSettings: answer.platformPermissions.includes("platform.workspaces.write") && (!restricted || answer.memberRole === "admin"),
    readLimits: has("budget.read"),
    changeLimits: has("budget.write"),
  };
}
