import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { platformRoles, platformRoleAssignments } from "../db/schema.js";
import type { PlatformPermission } from "../auth/permissions.js";

export interface PlatformRoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: PlatformPermission[];
  builtin: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Rows only. INV-13 (no path from a row to `config.isSuperAdmin`), INV-14 (the last
 * platform admin) and INV-15 (built-ins are immutable) live in
 * `platform-role.service.ts`.
 */
export const platformRoleRepo = {
  async list(): Promise<PlatformRoleRow[]> {
    const rows = await db.select().from(platformRoles);
    return rows.map(toRow).sort((a, b) => a.key.localeCompare(b.key));
  },

  async getByKey(key: string): Promise<PlatformRoleRow | null> {
    const [row] = await db.select().from(platformRoles).where(eq(platformRoles.key, key));
    return row ? toRow(row) : null;
  },

  async create(input: {
    key: string;
    name: string;
    description?: string | null;
    permissions: readonly PlatformPermission[];
  }): Promise<PlatformRoleRow> {
    const [row] = await db
      .insert(platformRoles)
      .values({
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        permissions: [...input.permissions],
        builtin: false,
      })
      .returning();
    return toRow(row!);
  },

  async update(
    key: string,
    patch: { name?: string; description?: string | null; permissions?: readonly PlatformPermission[] },
  ): Promise<void> {
    await db
      .update(platformRoles)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.permissions !== undefined ? { permissions: [...patch.permissions] } : {}),
        updatedAt: new Date(),
      })
      .where(eq(platformRoles.key, key));
  },

  async remove(key: string): Promise<void> {
    await db.delete(platformRoles).where(eq(platformRoles.key, key));
  },

  async assign(input: {
    subject: string;
    email: string;
    roleKey: string;
    grantedBy: string;
  }): Promise<void> {
    await db.insert(platformRoleAssignments).values(input).onConflictDoNothing();
  },

  async unassign(subject: string, roleKey: string): Promise<void> {
    await db
      .delete(platformRoleAssignments)
      .where(
        and(
          eq(platformRoleAssignments.subject, subject),
          eq(platformRoleAssignments.roleKey, roleKey),
        ),
      );
  },

  /**
   * The platform roles one person holds, with each role's permissions.
   *
   * ⚠ **Keyed on SUBJECT ALONE, so it is the same read for every workspace in a
   * request** — P-5. The resolver caches it per request rather than issuing it once per
   * workspace, which matters for `GET /api/workspaces`, where the filter asks the same
   * question eight times.
   */
  async rolesFor(
    subject: string,
  ): Promise<Array<{ roleKey: string; permissions: PlatformPermission[] }>> {
    const rows = await db
      .select({
        roleKey: platformRoles.key,
        permissions: platformRoles.permissions,
      })
      .from(platformRoleAssignments)
      .innerJoin(platformRoles, eq(platformRoles.key, platformRoleAssignments.roleKey))
      .where(eq(platformRoleAssignments.subject, subject));
    return rows.map((r) => ({
      roleKey: r.roleKey,
      permissions: (r.permissions ?? []) as PlatformPermission[],
    }));
  },

  /** Everybody holding a given platform role — INV-14 needs the count. */
  async holdersOf(roleKey: string): Promise<Array<{ subject: string; email: string }>> {
    return db
      .select({
        subject: platformRoleAssignments.subject,
        email: platformRoleAssignments.email,
      })
      .from(platformRoleAssignments)
      .where(eq(platformRoleAssignments.roleKey, roleKey));
  },

  async assignments(): Promise<
    Array<{ subject: string; email: string; roleKey: string; grantedBy: string; createdAt: Date }>
  > {
    return db
      .select({
        subject: platformRoleAssignments.subject,
        email: platformRoleAssignments.email,
        roleKey: platformRoleAssignments.roleKey,
        grantedBy: platformRoleAssignments.grantedBy,
        createdAt: platformRoleAssignments.createdAt,
      })
      .from(platformRoleAssignments);
  },
};

function toRow(row: typeof platformRoles.$inferSelect): PlatformRoleRow {
  return { ...row, permissions: (row.permissions ?? []) as PlatformPermission[] };
}
