import { workspaceRoleRepo, type WorkspaceRoleWithPermissions } from "../repositories/workspace-role.repo.js";
import { workspaceMemberService } from "./workspace-member.service.js";
import { effectivePermissionsService } from "./effective-permissions.service.js";
import { accessAuditService } from "./access-audit.service.js";
import { isWorkspacePermission, isPlatformPermission, type WorkspacePermission } from "../auth/permissions.js";
import { PRESET_ROLES, isPresetRole } from "../auth/role-presets.js";
import { withResponseBody } from "../middleware/error.middleware.js";

/**
 * A refusal that survives the error middleware intact.
 *
 * ⚠ **`withResponseBody` is what carries `reason`, `permission` and `assignees` to the
 * caller.** The 4xx branch of `error.middleware.ts` returns `{error, message, requestId}`
 * and drops everything else — so without this, "retiring this role affects 3 people"
 * arrives as prose with no number a client can render, and `role_exceeds_granter`
 * arrives indistinguishable from any other 403. That is contracts/api.md §E's whole
 * point: a client should not have to parse prose to tell refusals apart.
 */
function httpError(message: string, statusCode: number, extra?: Record<string, unknown>) {
  const err = Object.assign(new Error(message), { statusCode, ...extra });
  return withResponseBody(err, {
    error: statusCode === 403 ? "forbidden" : statusCode >= 500 ? "misconfigured" : "request_error",
    message,
    ...(extra ?? {}),
  });
}

export interface Granter {
  subject?: string | null;
  email?: string | null;
}

/**
 * Custom workspace roles — a named set of permissions an administrator composes.
 *
 * Every rule lives here rather than in the repository or the route, because all three of
 * them would otherwise each be a place a rule could be forgotten.
 *
 * ## ⚠ FR-009 — YOU CANNOT GRANT WHAT YOU DO NOT HOLD
 *
 * The most important rule in this file. Without it, role authoring is privilege
 * escalation with extra steps: an `author` who may create roles could compose
 * "Everything" and assign it to themselves. The check is against the granter's
 * **effective** permissions in this workspace — the same resolver the guard uses, so
 * there is no second opinion about what they hold.
 *
 * ⚠ **The refusal names the offending permission and NEVER lists what the caller holds**
 * (FR-021/FR-023). A 403 that replies "you only have these fourteen" is a capability
 * disclosure to somebody who has just demonstrated they are probing.
 */
export const workspaceRoleService = {
  async list(workspaceId: string): Promise<
    Array<{
      id: string | null;
      name: string;
      description: string | null;
      permissions: readonly string[];
      builtin: boolean;
      retiredAt: Date | null;
      assignees: number;
    }>
  > {
    const { ROLE_PRESETS } = await import("../auth/role-presets.js");
    const custom = await workspaceRoleRepo.list(workspaceId);
    const assignments = await workspaceRoleRepo.assignmentsIn(workspaceId);
    const members = await workspaceMemberService.list(workspaceId);

    const countByRole = new Map<string, number>();
    for (const a of assignments) countByRole.set(a.roleId, (countByRole.get(a.roleId) ?? 0) + 1);

    return [
      // ⚠ The presets are listed BESIDE custom roles, with `builtin: true` and no id.
      // A screen that showed only custom roles would imply a workspace with none has no
      // roles at all, when in fact everybody in it holds one.
      ...PRESET_ROLES.map((name) => ({
        id: null,
        name,
        description: null,
        permissions: ROLE_PRESETS[name],
        builtin: true,
        retiredAt: null,
        assignees: members.filter((m) => m.role === name).length,
      })),
      ...custom.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        permissions: r.permissions,
        builtin: false,
        retiredAt: r.retiredAt,
        assignees: countByRole.get(r.id) ?? 0,
      })),
    ];
  },

  async get(workspaceId: string, roleId: string): Promise<WorkspaceRoleWithPermissions> {
    const role = await workspaceRoleRepo.get(roleId);
    // ⚠ Checked against the workspace in the PATH, not trusted from the row. A role id
    // from another workspace must read as absent, never as somebody else's role.
    if (!role || role.workspaceId !== workspaceId) {
      throw httpError("no such role in this workspace.", 404);
    }
    return role;
  },

  /**
   * ⚠ Validate the permission list: in the catalogue, workspace tier, and held by the
   * granter. Three separate refusals because they have three separate fixes.
   */
  async assertGrantable(
    workspaceId: string,
    granter: Granter,
    permissions: readonly string[],
  ): Promise<WorkspacePermission[]> {
    for (const p of permissions) {
      if (isPlatformPermission(p)) {
        // INV-8. Also refused by a CHECK constraint; refused here so the message can
        // explain rather than surfacing as a database error.
        throw httpError(
          `"${p}" is a platform permission and cannot belong to a workspace role. ` +
            `A workspace role granting a deployment-wide permission would be privilege ` +
            `escalation by role authoring.`,
          400,
          { reason: "platform_permission", permission: p },
        );
      }
      if (!isWorkspacePermission(p)) {
        throw httpError(`"${p}" is not a permission.`, 400, {
          reason: "unknown_permission",
          permission: p,
        });
      }
    }

    const mine = await effectivePermissionsService.forWorkspace(granter, workspaceId);
    const held = new Set<string>(mine.permissions);
    for (const p of permissions) {
      if (!held.has(p)) {
        // ⚠ FR-009. Names the offending permission and NOTHING about what the caller
        // holds — a 403 is the last place to publish a capability list.
        throw httpError(
          `you cannot put "${p}" in a role because you do not hold it in this workspace.`,
          403,
          { reason: "role_exceeds_granter", permission: p },
        );
      }
    }
    return permissions as WorkspacePermission[];
  },

  async create(
    workspaceId: string,
    input: { name: string; description?: string | null; permissions: readonly string[] },
    granter: Granter,
  ): Promise<WorkspaceRoleWithPermissions> {
    const name = input.name.trim();
    if (!name) throw httpError("a role needs a name.", 400);

    // INV-6 — a custom role may not be named after a preset, or a grant becomes
    // ambiguous between code and data and nobody can tell which one decided.
    if (isPresetRole(name.toLowerCase())) {
      throw httpError(
        `"${name}" is a built-in role. A custom role with that name would make every ` +
          `grant of it ambiguous between the built-in and the custom one.`,
        409,
        { reason: "preset_name" },
      );
    }
    const clash = await workspaceRoleRepo.findLiveByName(workspaceId, name);
    if (clash) {
      throw httpError(`a role called "${name}" already exists in this workspace.`, 409, {
        reason: "name_taken",
      });
    }

    const permissions = await this.assertGrantable(workspaceId, granter, input.permissions);

    const actor = granter.subject ?? "unknown";
    const role = await workspaceRoleRepo.create({
      workspaceId,
      name,
      description: input.description ?? null,
      createdBy: actor,
    });
    await workspaceRoleRepo.setPermissions(role.id, permissions, actor);
    await accessAuditService.recordRoleChange({
      workspaceId,
      actor,
      subject: role.id,
      what: name,
      action: "role.create",
      entityId: role.id,
      after: { name, permissions },
    });
    return { ...role, permissions };
  },

  async update(
    workspaceId: string,
    roleId: string,
    patch: { name?: string; description?: string | null; permissions?: readonly string[] },
    granter: Granter,
  ): Promise<WorkspaceRoleWithPermissions> {
    const before = await this.get(workspaceId, roleId);
    if (before.retiredAt) {
      throw httpError("this role is retired. Create a new one rather than reviving it.", 409, {
        reason: "retired",
      });
    }

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw httpError("a role needs a name.", 400);
      if (isPresetRole(name.toLowerCase())) {
        throw httpError(`"${name}" is a built-in role.`, 409, { reason: "preset_name" });
      }
      const clash = await workspaceRoleRepo.findLiveByName(workspaceId, name);
      if (clash && clash.id !== roleId) {
        throw httpError(`a role called "${name}" already exists in this workspace.`, 409, {
          reason: "name_taken",
        });
      }
    }

    const actor = granter.subject ?? "unknown";
    if (patch.name !== undefined || patch.description !== undefined) {
      await workspaceRoleRepo.rename(roleId, {
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
      });
    }
    if (patch.permissions !== undefined) {
      const permissions = await this.assertGrantable(workspaceId, granter, patch.permissions);
      await workspaceRoleRepo.setPermissions(roleId, permissions, actor);
    }

    const after = await this.get(workspaceId, roleId);
    await accessAuditService.recordRoleChange({
      workspaceId,
      actor,
      subject: roleId,
      what: after.name,
      action: "role.update",
      entityId: roleId,
      before: { name: before.name, permissions: before.permissions },
      after: { name: after.name, permissions: after.permissions },
    });
    return after;
  },

  /**
   * Retire a role.
   *
   * ⚠ **INV-7 — a timestamp, never a DELETE.** A deleted role leaves audit entries
   * naming something nobody can look up, and FR-033 forbids editing the audit to repair
   * that. The repository has no `delete` at all.
   *
   * ⚠ Retiring a role with assignees needs `confirm`, and the refusal CARRIES THE COUNT
   * so the confirmation can state it. "Are you sure?" with no number is a dialog people
   * learn to click through.
   */
  async retire(
    workspaceId: string,
    roleId: string,
    granter: Granter,
    opts: { confirm?: boolean } = {},
  ): Promise<{ retired: true; hadAssignees: number }> {
    const role = await this.get(workspaceId, roleId);
    const assignments = await workspaceRoleRepo.assignmentsIn(workspaceId);
    const holders = assignments.filter((a) => a.roleId === roleId);

    if (holders.length > 0 && !opts.confirm) {
      throw httpError(
        `${holders.length} ${holders.length === 1 ? "person holds" : "people hold"} ` +
          `"${role.name}". Retiring it takes those permissions away from them. ` +
          `Re-send with confirm=true.`,
        409,
        { reason: "has_assignees", assignees: holders.length },
      );
    }

    await workspaceRoleRepo.retire(roleId);
    await accessAuditService.recordRoleChange({
      workspaceId,
      actor: granter.subject ?? "unknown",
      subject: roleId,
      what: role.name,
      action: "role.retire",
      entityId: roleId,
      before: { name: role.name, permissions: role.permissions, assignees: holders.length },
    });
    return { retired: true, hadAssignees: holders.length };
  },

  async holders(
    workspaceId: string,
    roleId: string,
  ): Promise<Array<{ subject: string; grantedBy: string; createdAt: Date }>> {
    await this.get(workspaceId, roleId);
    return (await workspaceRoleRepo.assignmentsIn(workspaceId))
      .filter((a) => a.roleId === roleId)
      .map(({ subject, grantedBy, createdAt }) => ({ subject, grantedBy, createdAt }));
  },

  /**
   * Assign a role to somebody.
   *
   * ⚠ **INV-9 — they must ALREADY be a member.** `workspace_members` stays the single
   * answer to "is this person in this workspace"; a custom role adds to what a member
   * may do and never smuggles somebody in through a side door. There is no foreign key
   * that could express this, so it is checked here and the refusal names the missing
   * membership rather than saying "forbidden".
   */
  async assign(
    workspaceId: string,
    roleId: string,
    subject: string,
    granter: Granter,
  ): Promise<void> {
    const role = await this.get(workspaceId, roleId);
    if (role.retiredAt) {
      throw httpError("this role is retired and cannot be assigned.", 409, { reason: "retired" });
    }

    const member = await workspaceMemberService.find(workspaceId, subject);
    if (!member) {
      throw httpError(
        `that person is not a member of this workspace, so they cannot hold a role in ` +
          `it. Add them as a member first.`,
        409,
        { reason: "not_a_member" },
      );
    }

    // ⚠ FR-009 again, at the moment of assignment rather than only at authoring: a role
    // authored by an admin must not be assignable by somebody who does not hold its
    // permissions. Without this, "who may grant X" has two answers depending on whether
    // X arrived through a role or directly.
    await this.assertGrantable(workspaceId, granter, role.permissions);

    const actor = granter.subject ?? "unknown";
    await workspaceRoleRepo.assign({ workspaceId, subject, roleId, grantedBy: actor });
    await accessAuditService.recordGrant({
      workspaceId,
      actor,
      subject,
      what: `role "${role.name}"`,
      entityId: roleId,
      after: { roleId, permissions: role.permissions },
    });
  },

  async unassign(
    workspaceId: string,
    roleId: string,
    subject: string,
    granter: Granter,
  ): Promise<void> {
    const role = await this.get(workspaceId, roleId);
    await workspaceRoleRepo.unassign(workspaceId, subject, roleId);
    await accessAuditService.recordRevoke({
      workspaceId,
      actor: granter.subject ?? "unknown",
      subject,
      what: `role "${role.name}"`,
      entityId: roleId,
      before: { roleId, permissions: role.permissions },
    });
  },
};
