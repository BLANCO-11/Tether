import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  workspaceRoles,
  workspaceRolePermissions,
  workspaceRoleAssignments,
} from "../db/schema.js";
import type { WorkspacePermission } from "../auth/permissions.js";

export interface WorkspaceRoleRow {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  retiredAt: Date | null;
}

export interface WorkspaceRoleWithPermissions extends WorkspaceRoleRow {
  permissions: WorkspacePermission[];
}

/**
 * Rows only. Every rule — INV-6 (no preset name collision), INV-7 (retire, never
 * delete), INV-9 (assignee must already be a member), FR-009 (cannot grant what you do
 * not hold) — lives in `workspace-role.service.ts`. A repository that enforced a policy
 * would be a second place the policy lives.
 */
export const workspaceRoleRepo = {
  /**
   * ⚠ **Live roles only by default.** A retired role must not appear in a picker, and it
   * must still resolve by id, because audit entries name it. `includeRetired` is what
   * separates the two, and it is a parameter rather than two functions so a caller has
   * to decide.
   */
  async list(workspaceId: string, includeRetired = false): Promise<WorkspaceRoleWithPermissions[]> {
    const roles = await db
      .select()
      .from(workspaceRoles)
      .where(
        includeRetired
          ? eq(workspaceRoles.workspaceId, workspaceId)
          : and(eq(workspaceRoles.workspaceId, workspaceId), isNull(workspaceRoles.retiredAt)),
      );
    if (roles.length === 0) return [];

    const perms = await db
      .select()
      .from(workspaceRolePermissions)
      .where(
        inArray(
          workspaceRolePermissions.roleId,
          roles.map((r) => r.id),
        ),
      );
    const byRole = new Map<string, WorkspacePermission[]>();
    for (const p of perms) {
      const list = byRole.get(p.roleId) ?? [];
      list.push(p.permission as WorkspacePermission);
      byRole.set(p.roleId, list);
    }
    return roles.map((r) => ({ ...r, permissions: (byRole.get(r.id) ?? []).sort() }));
  },

  async get(roleId: string): Promise<WorkspaceRoleWithPermissions | null> {
    const [role] = await db.select().from(workspaceRoles).where(eq(workspaceRoles.id, roleId));
    if (!role) return null;
    const perms = await db
      .select()
      .from(workspaceRolePermissions)
      .where(eq(workspaceRolePermissions.roleId, roleId));
    return {
      ...role,
      permissions: perms.map((p) => p.permission as WorkspacePermission).sort(),
    };
  },

  /** Case-insensitive, LIVE roles only — the shape of the partial unique index. */
  async findLiveByName(workspaceId: string, name: string): Promise<WorkspaceRoleRow | null> {
    const [row] = await db
      .select()
      .from(workspaceRoles)
      .where(
        and(
          eq(workspaceRoles.workspaceId, workspaceId),
          isNull(workspaceRoles.retiredAt),
          sql`lower(${workspaceRoles.name}) = lower(${name})`,
        ),
      );
    return row ?? null;
  },

  async create(input: {
    workspaceId: string;
    name: string;
    description?: string | null;
    createdBy: string;
  }): Promise<WorkspaceRoleRow> {
    const [row] = await db
      .insert(workspaceRoles)
      .values({
        workspaceId: input.workspaceId,
        name: input.name,
        description: input.description ?? null,
        createdBy: input.createdBy,
      })
      .returning();
    return row!;
  },

  async rename(
    roleId: string,
    patch: { name?: string; description?: string | null },
  ): Promise<void> {
    await db
      .update(workspaceRoles)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(workspaceRoles.id, roleId));
  },

  /**
   * ⚠ **INV-7 — a timestamp, never a DELETE.** A deleted role leaves audit entries
   * referencing a name nobody can look up, and FR-033 forbids editing the audit to
   * repair that. There is deliberately no `delete` on this repository at all: the
   * absence is the enforcement, the same way there is no `effect` column.
   */
  async retire(roleId: string): Promise<void> {
    await db
      .update(workspaceRoles)
      .set({ retiredAt: new Date(), updatedAt: new Date() })
      .where(eq(workspaceRoles.id, roleId));
  },

  async setPermissions(
    roleId: string,
    permissions: readonly WorkspacePermission[],
    grantedBy: string,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .delete(workspaceRolePermissions)
        .where(eq(workspaceRolePermissions.roleId, roleId));
      if (permissions.length === 0) return;
      await tx.insert(workspaceRolePermissions).values(
        permissions.map((permission) => ({ roleId, permission, grantedBy })),
      );
    });
  },

  async assign(input: {
    workspaceId: string;
    subject: string;
    roleId: string;
    grantedBy: string;
  }): Promise<void> {
    await db.insert(workspaceRoleAssignments).values(input).onConflictDoNothing();
  },

  async unassign(workspaceId: string, subject: string, roleId: string): Promise<void> {
    await db
      .delete(workspaceRoleAssignments)
      .where(
        and(
          eq(workspaceRoleAssignments.workspaceId, workspaceId),
          eq(workspaceRoleAssignments.subject, subject),
          eq(workspaceRoleAssignments.roleId, roleId),
        ),
      );
  },

  /**
   * The permissions one person holds through custom roles in one workspace, with the
   * role that conferred each.
   *
   * ⚠ **ONE query, joined** — P-5. The resolver runs on the path of every authorisation
   * check, so "list the roles then fetch each one's permissions" would be N+1 on the
   * hottest path in the product.
   *
   * ⚠ **Retired roles are excluded here.** Retiring a role must actually take the
   * permission away; the row surviving is for the audit trail's benefit, not the
   * resolver's.
   */
  async permissionsFor(
    workspaceId: string,
    subject: string,
  ): Promise<Array<{ permission: WorkspacePermission; roleId: string; roleName: string }>> {
    const rows = await db
      .select({
        permission: workspaceRolePermissions.permission,
        roleId: workspaceRoles.id,
        roleName: workspaceRoles.name,
      })
      .from(workspaceRoleAssignments)
      .innerJoin(workspaceRoles, eq(workspaceRoles.id, workspaceRoleAssignments.roleId))
      .innerJoin(
        workspaceRolePermissions,
        eq(workspaceRolePermissions.roleId, workspaceRoles.id),
      )
      .where(
        and(
          eq(workspaceRoleAssignments.workspaceId, workspaceId),
          eq(workspaceRoleAssignments.subject, subject),
          isNull(workspaceRoles.retiredAt),
        ),
      );
    return rows.map((r) => ({
      permission: r.permission as WorkspacePermission,
      roleId: r.roleId,
      roleName: r.roleName,
    }));
  },

  /** Who holds which custom role in this workspace — the admin surface's read. */
  async assignmentsIn(
    workspaceId: string,
  ): Promise<Array<{ subject: string; roleId: string; roleName: string; grantedBy: string; createdAt: Date }>> {
    const rows = await db
      .select({
        subject: workspaceRoleAssignments.subject,
        roleId: workspaceRoles.id,
        roleName: workspaceRoles.name,
        grantedBy: workspaceRoleAssignments.grantedBy,
        createdAt: workspaceRoleAssignments.createdAt,
      })
      .from(workspaceRoleAssignments)
      .innerJoin(workspaceRoles, eq(workspaceRoles.id, workspaceRoleAssignments.roleId))
      .where(eq(workspaceRoleAssignments.workspaceId, workspaceId));
    return rows;
  },
};
