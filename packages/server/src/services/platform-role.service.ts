import { platformRoleRepo, type PlatformRoleRow } from "../repositories/platform-role.repo.js";
import { platformAuditRepo } from "../repositories/platform-audit.repo.js";
import { accessAuditService } from "./access-audit.service.js";
import { effectivePermissionsService } from "./effective-permissions.service.js";
import { config } from "../config/index.js";
import { isPlatformPermission, type PlatformPermission } from "../auth/permissions.js";
import { withResponseBody } from "../middleware/error.middleware.js";

function httpError(message: string, statusCode: number, extra?: Record<string, unknown>) {
  const err = Object.assign(new Error(message), { statusCode, ...extra });
  return withResponseBody(err, {
    error: statusCode === 403 ? "forbidden" : "request_error",
    message,
    ...(extra ?? {}),
  });
}

export interface Actor {
  subject?: string | null;
  email?: string | null;
}

/** The role whose removal INV-14 protects. */
const PLATFORM_ADMIN = "platform-admin";

/**
 * The platform tier — roles above a workspace.
 *
 * ## ⚠ INV-13 — NOTHING HERE CAN CONFER SUPER ADMIN
 *
 * There is no `platform.superadmin` permission in the catalogue and no code path from a
 * row in `platform_roles` to `config.isSuperAdmin`, which reads the environment and
 * nothing else. **The allowlist stays the un-grantable root**: the one authority in the
 * product that cannot be handed out from inside the product. Every other authority here
 * is a row somebody with the right permission can write, and that is precisely why the
 * root must not be.
 *
 * ## ⚠ INV-20 — the last-admin exemption does NOT extend to this tier
 *
 * `workspace-member.service.ts` lets a **super admin** remove a workspace's last admin,
 * and that exemption was MEASURED rather than reasoned: keeping the refusal absolute
 * made a mis-assignment irreversible, with nobody above the super admin to undo it.
 *
 * A platform administrator is NOT in that position. There is always an allowlist holder
 * above them, so for them the refusal is recoverable — and it therefore stays (INV-14).
 * A platform admin who hits it escalates; a super admin passes.
 */
export const platformRoleService = {
  async list(): Promise<PlatformRoleRow[]> {
    return platformRoleRepo.list();
  },

  async assignments() {
    return platformRoleRepo.assignments();
  },

  /**
   * ⚠ Every permission must be in the catalogue AND on the platform tier.
   *
   * A workspace permission here would be a role that claims to grant something inside
   * every workspace without going through `PLATFORM_CONFERS` — which is the single,
   * audited, two-entry map that bounds D-9's entire cost. A second route to conferral
   * would make that bound meaningless.
   */
  assertPlatformPermissions(permissions: readonly string[]): PlatformPermission[] {
    for (const p of permissions) {
      if (!isPlatformPermission(p)) {
        throw httpError(
          `"${p}" is not a platform permission. A platform role may only carry ` +
            `\`platform.*\` permissions; what those confer inside a workspace is decided ` +
            `by PLATFORM_CONFERS, not by naming a workspace permission here.`,
          400,
          { reason: "not_a_platform_permission", permission: p },
        );
      }
    }
    return permissions as PlatformPermission[];
  },

  async create(
    input: { key: string; name: string; description?: string | null; permissions: readonly string[] },
    actor: Actor,
  ): Promise<PlatformRoleRow> {
    const key = input.key.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(key)) {
      throw httpError("a role key is lower-case letters, digits and hyphens.", 400);
    }
    if (await platformRoleRepo.getByKey(key)) {
      throw httpError(`a platform role with the key "${key}" already exists.`, 409, {
        reason: "key_taken",
      });
    }
    const permissions = this.assertPlatformPermissions(input.permissions);
    await this.assertGrantable(actor, permissions);

    const role = await platformRoleRepo.create({
      key,
      name: input.name,
      description: input.description ?? null,
      permissions,
    });
    await accessAuditService.recordPlatformGrant({
      actor: actor.subject ?? "unknown",
      actorEmail: actor.email ?? null,
      subject: key,
      roleKey: key,
      action: "role.create",
      after: { name: input.name, permissions },
    });
    return role;
  },

  /**
   * ⚠ FR-009 on this tier too: a caller cannot put a platform permission into a role
   * that they do not themselves hold. An allowlist holder holds all of them.
   */
  async assertGrantable(actor: Actor, permissions: readonly PlatformPermission[]): Promise<void> {
    const mine = await effectivePermissionsService.platformPermissions(actor);
    const held = new Set<string>(mine.permissions);
    for (const p of permissions) {
      if (!held.has(p)) {
        throw httpError(
          `you cannot put "${p}" in a platform role because you do not hold it.`,
          403,
          { reason: "role_exceeds_granter", permission: p },
        );
      }
    }
  },

  async update(
    key: string,
    patch: { name?: string; description?: string | null; permissions?: readonly string[] },
    actor: Actor,
  ): Promise<PlatformRoleRow> {
    const before = await this.requireRole(key);
    // INV-15 — a built-in role somebody can edit is a built-in role that can be edited
    // into something nobody reviewed, on every deployment that ships it.
    if (before.builtin) {
      throw httpError(
        `"${key}" is a built-in platform role and cannot be edited. Create a custom role instead.`,
        409,
        { reason: "builtin" },
      );
    }
    let permissions: PlatformPermission[] | undefined;
    if (patch.permissions) {
      permissions = this.assertPlatformPermissions(patch.permissions);
      await this.assertGrantable(actor, permissions);
    }
    await platformRoleRepo.update(key, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(permissions !== undefined ? { permissions } : {}),
    });
    const after = await this.requireRole(key);
    await accessAuditService.recordPlatformGrant({
      actor: actor.subject ?? "unknown",
      actorEmail: actor.email ?? null,
      subject: key,
      roleKey: key,
      action: "role.update",
      before: { name: before.name, permissions: before.permissions },
      after: { name: after.name, permissions: after.permissions },
    });
    return after;
  },

  async remove(key: string, actor: Actor): Promise<void> {
    const role = await this.requireRole(key);
    if (role.builtin) {
      throw httpError(`"${key}" is a built-in platform role and cannot be deleted.`, 409, {
        reason: "builtin",
      });
    }
    const holders = await platformRoleRepo.holdersOf(key);
    if (holders.length > 0) {
      throw httpError(
        `${holders.length} ${holders.length === 1 ? "person holds" : "people hold"} ` +
          `"${key}". Remove them from it first.`,
        409,
        { reason: "has_assignees", assignees: holders.length },
      );
    }
    await platformRoleRepo.remove(key);
    await accessAuditService.recordPlatformGrant({
      actor: actor.subject ?? "unknown",
      actorEmail: actor.email ?? null,
      subject: key,
      roleKey: key,
      action: "role.retire",
      before: { name: role.name, permissions: role.permissions },
    });
  },

  async assign(
    input: { subject: string; email: string; roleKey: string },
    actor: Actor,
  ): Promise<void> {
    const role = await this.requireRole(input.roleKey);
    // FR-009 — you cannot hand out what you do not hold.
    await this.assertGrantable(actor, role.permissions);

    await platformRoleRepo.assign({
      subject: input.subject,
      email: input.email,
      roleKey: input.roleKey,
      grantedBy: actor.subject ?? "unknown",
    });
    await accessAuditService.recordPlatformGrant({
      actor: actor.subject ?? "unknown",
      actorEmail: actor.email ?? null,
      subject: input.subject,
      roleKey: input.roleKey,
      action: "grant",
      after: { roleKey: input.roleKey, permissions: role.permissions },
    });
  },

  /**
   * ⚠ **INV-14 — the LAST platform administrator can only be removed by an allowlist
   * holder.**
   *
   * Without this, the tier can lock itself out: the last platform admin removes
   * themselves, and on a deployment with an empty `SUPER_ADMIN_EMAILS` there is nobody
   * left who can assign anybody. That is the same failure `claim`'s deletion created for
   * workspaces, and the same reason `SUPER_ADMIN_EMAILS` became load-bearing.
   *
   * ⚠ **A platform admin does NOT get the super admin's exemption here** (INV-20), and
   * the asymmetry is deliberate. The workspace exemption exists because a super admin has
   * nobody above them to undo a mistake. A platform admin always does.
   */
  async unassign(subject: string, roleKey: string, actor: Actor): Promise<void> {
    if (roleKey === PLATFORM_ADMIN) {
      const holders = await platformRoleRepo.holdersOf(PLATFORM_ADMIN);
      const isLast = holders.length <= 1 && holders.some((h) => h.subject === subject);
      if (isLast && !config.isSuperAdmin(actor)) {
        throw httpError(
          config.superAdminConfigured
            ? `this is the last platform administrator. Removing them would leave nobody ` +
                `able to administer the deployment, so only somebody on SUPER_ADMIN_EMAILS ` +
                `may do it. Ask them, or assign a second platform administrator first.`
            : `this is the last platform administrator, and this deployment has no super ` +
                `admin configured to recover with. Set SUPER_ADMIN_EMAILS on the API server, ` +
                `or assign a second platform administrator first.`,
          409,
          { reason: "last_platform_admin" },
        );
      }
    }
    await platformRoleRepo.unassign(subject, roleKey);
    await accessAuditService.recordPlatformGrant({
      actor: actor.subject ?? "unknown",
      actorEmail: actor.email ?? null,
      subject,
      roleKey,
      action: "revoke",
      before: { roleKey },
    });
  },

  async requireRole(key: string): Promise<PlatformRoleRow> {
    const role = await platformRoleRepo.getByKey(key);
    if (!role) throw httpError(`no platform role with the key "${key}".`, 404);
    return role;
  },

  /**
   * The audit reader — INV-17.
   *
   * ⚠ **Two stores, ONE time order.** Workspace access events live in `audit_events` and
   * deployment-level ones in `platform_audit_events`; which table a decision landed in is
   * a storage detail, and a reader of an audit trail should never have to know it in
   * order to see what happened in sequence.
   */
  async auditTrail(opts: { limit?: number; actor?: string; hideWorkspaces?: ReadonlySet<string> } = {}) {
    const limit = Math.min(opts.limit ?? 200, 1000);
    const platform = await platformAuditRepo.list({ limit, actor: opts.actor });

    const { db } = await import("../db/index.js");
    const { auditEvents } = await import("../db/schema.js");
    const { and, desc, eq } = await import("drizzle-orm");
    const { notInArray } = await import("drizzle-orm");
    // ⚠ Restricted workspaces (phase 3): a restricted workspace's own entries are its admins' to read, not the
    // platform's — auditors included (user, 2026-10-29).
    const hidden = [...(opts.hideWorkspaces ?? [])];
    const where = [
      eq(auditEvents.operation, "access"),
      ...(hidden.length ? [notInArray(auditEvents.workspaceId, hidden)] : []),
      ...(opts.actor ? [eq(auditEvents.actor, opts.actor)] : []),
    ];
    const workspace = await db
      .select()
      .from(auditEvents)
      .where(and(...where))
      .orderBy(desc(auditEvents.time))
      .limit(limit);

    return [
      ...platform.map((p) => ({
        time: p.time,
        tier: "platform" as const,
        workspaceId: null as string | null,
        actor: p.actor,
        action: p.action,
        subject: p.subject,
        entity: p.entity,
        entityId: p.entityId,
        before: p.before,
        after: p.after,
        repeatCount: p.repeatCount,
      })),
      ...workspace.map((w) => ({
        time: w.time,
        tier: "workspace" as const,
        workspaceId: w.workspaceId,
        actor: w.actor,
        action: w.description,
        subject: (w.raw as { subject?: string } | null)?.subject ?? w.whereEntityId,
        entity: w.entity,
        entityId: w.entityId,
        before: (w.raw as { before?: unknown } | null)?.before ?? null,
        after: (w.raw as { after?: unknown } | null)?.after ?? null,
        repeatCount: 1,
      })),
    ]
      .sort((a, b) => b.time.getTime() - a.time.getTime())
      .slice(0, limit);
  },
};
