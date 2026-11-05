import { config } from "../config/index.js";
import {
  WORKSPACE_PERMISSIONS,
  type Permission,
  type PlatformPermission,
  type WorkspacePermission,
} from "../auth/permissions.js";
import { presetPermissions } from "../auth/role-presets.js";
import { conferredByPlatform, PLATFORM_CONFERS } from "../auth/platform-conferral.js";
import { isRestricted, superAdminHere } from "./workspace-restriction.service.js";
import { workspaceRoleRepo } from "../repositories/workspace-role.repo.js";
import { platformRoleRepo } from "../repositories/platform-role.repo.js";
import { workspaceMemberService } from "./workspace-member.service.js";
import { workspaceMemberCapabilitiesService } from "./workspace-member-capabilities.service.js";

/**
 * The resolver — the ONE computation that answers "what may this person do in this
 * workspace".
 *
 * ```
 * effective(person, workspace) =
 *       preset(workspace_members.role)                  if a membership row exists
 *     ∪ ⋃ permissions(r) for r in workspace_role_assignments
 *     ∪ workspace_member_capabilities rows
 *     ∪ ⋃ PLATFORM_CONFERS[p] for the person's platform permissions
 *
 *     = ALL catalogue permissions                       if config.isSuperAdmin(identity)
 *     = ∅                                               otherwise
 * ```
 *
 * ## ⚠ It is a UNION, and there is no subtraction anywhere
 *
 * P-1 / FR-011 / D-3. Grant-only, so the order the sources are read in cannot change the
 * answer and two grants can never conflict. There is no `deny`, no `effect` column and
 * no precedence rule — **the absence is the enforcement.** A deny semantics would need a
 * precedence order, and a precedence order is a second thing to get right on the path of
 * every authorisation check. If somebody ever adds one, every property below has to be
 * re-derived.
 *
 * ## ⚠ Provenance comes back WITH the answer, not from a second computation
 *
 * P-4. `explain()` and `permissionsFor()` are one pass. A screen that says *why*
 * somebody may act must not be able to disagree with the check that let them — which is
 * exactly what two computations drift into. FR-038 is answered from the same union that
 * decides.
 *
 * ## ⚠ The super-admin branch runs BEFORE any read
 *
 * P-3, and it is load-bearing rather than an optimisation. `POST …/members/claim` is
 * deleted, so a workspace with zero members can only ever gain its first one through
 * somebody who passes without a membership row. This deployment has **eight** such
 * workspaces. Move this branch below the member read and every workspace here becomes
 * permanently un-grantable.
 */

/** Where a permission came from. `via: "platform"` is FR-020 / INV-19 / P-6. */
export type Provenance =
  | { via: "superadmin" }
  | { via: "preset"; role: string }
  | { via: "role"; roleId: string; roleName: string }
  | { via: "grant" }
  | { via: "platform"; role: string; permission: PlatformPermission };

export interface EffectivePermissions {
  /** Sorted, deduplicated. */
  permissions: WorkspacePermission[];
  /**
   * Every source for every permission. A permission can have SEVERAL — being both an
   * admin and a platform admin is not a conflict, it is two reasons, and a screen
   * showing "why" should be able to say so.
   */
  provenance: Record<string, Provenance[]>;
  /** The preset role from `workspace_members`, or null for a non-member. */
  memberRole: string | null;
  isSuperAdmin: boolean;
}

export interface Identity {
  subject?: string | null;
  email?: string | null;
}

/**
 * A per-request cache for the platform-role read.
 *
 * ⚠ **P-5.** The platform read is keyed on SUBJECT ALONE, so it is literally the same
 * answer for every workspace in one request. `GET /api/workspaces` asks the same
 * question once per workspace — eight times here — and without this it would be eight
 * identical round trips to decide one list.
 *
 * Deliberately request-scoped and explicit rather than a module-level TTL cache: a stale
 * authorisation answer that survives a revocation is the failure mode that matters, and
 * a cache nobody passed cannot be reasoned about at the call site.
 */
export class PlatformRoleCache {
  private readonly bySubject = new Map<
    string,
    Promise<Array<{ roleKey: string; permissions: PlatformPermission[] }>>
  >();

  rolesFor(subject: string) {
    let hit = this.bySubject.get(subject);
    if (!hit) {
      hit = platformRoleRepo.rolesFor(subject);
      this.bySubject.set(subject, hit);
    }
    return hit;
  }
}

export const effectivePermissionsService = {
  /**
   * What this person may do in this workspace, with provenance.
   *
   * ⚠ Pass an `Identity`, not a bare subject. `config.isSuperAdmin` matches subject **or
   * email**, and passing only the subject is the exact bug that made a correctly
   * configured `SUPER_ADMIN_EMAILS` grant nothing at all for every Entra sign-in.
   */
  async forWorkspace(
    identity: Identity | undefined,
    workspaceId: string,
    cache?: PlatformRoleCache,
  ): Promise<EffectivePermissions> {
    const subject = identity?.subject ?? null;
    const empty: EffectivePermissions = {
      permissions: [],
      provenance: {},
      memberRole: null,
      isSuperAdmin: false,
    };

    // P-3 — before ANY other read. See the docblock. ⚠ Restricted workspaces: the allowlist counts only with an
    // active emergency access (`superAdminHere`); without one a super admin falls through and is whatever their
    // membership makes them here — usually nothing.
    if (await superAdminHere(identity, workspaceId)) {
      const all = [...WORKSPACE_PERMISSIONS].sort();
      const provenance: Record<string, Provenance[]> = {};
      for (const p of all) provenance[p] = [{ via: "superadmin" }];
      return { permissions: all, provenance, memberRole: "admin", isSuperAdmin: true };
    }

    // P-2 — an identity that names nobody holds nothing. Not "treat as anonymous and
    // fall through"; there is nothing to fall through to.
    if (!subject) return empty;

    const [member, roleGrants, capabilities, platformRoles] = await Promise.all([
      workspaceMemberService.find(workspaceId, subject),
      workspaceRoleRepo.permissionsFor(workspaceId, subject),
      workspaceMemberCapabilitiesService.list(workspaceId, subject),
      cache ? cache.rolesFor(subject) : platformRoleRepo.rolesFor(subject),
    ]);

    const provenance: Record<string, Provenance[]> = {};
    const add = (permission: string, source: Provenance) => {
      (provenance[permission] ??= []).push(source);
    };

    // 1. The membership preset.
    if (member) {
      for (const p of presetPermissions(member.role)) add(p, { via: "preset", role: member.role });
    }

    // 2. Custom roles. A person may hold several; the effective set is the union, which
    //    is what makes several roles unable to conflict.
    for (const g of roleGrants) {
      add(g.permission, { via: "role", roleId: g.roleId, roleName: g.roleName });
    }

    // 3. Individual grants.
    for (const c of capabilities) add(c, { via: "grant" });

    // 4. ⚠ D-9 — what a PLATFORM permission confers here. Keyed on the permission, never
    //    on the role name, so a custom platform role holding `platform.members.grant`
    //    confers exactly what the built-in `platform-admin` does.
    //
    //    ⚠ P-6 / INV-19: these carry `via: "platform"` and never `via: "preset"`. A
    //    screen must be able to say "because they administer the platform" rather than
    //    implying somebody put them in this workspace — and a membership row is exactly
    //    what has NOT happened here.
    //    ⚠ Not in a RESTRICTED workspace: there, only the people its own admins added get in. Read lazily — only
    //    when a platform role would confer something — so a plain member's check costs no extra query.
    const confersAny = platformRoles.some((r) => r.permissions.some((p) => (PLATFORM_CONFERS as Record<string, unknown>)[p]));
    const conferralApplies = confersAny && !(await isRestricted(workspaceId));
    for (const role of conferralApplies ? platformRoles : []) {
      for (const held of role.permissions) {
        const confers = (
          PLATFORM_CONFERS as Record<string, readonly WorkspacePermission[] | undefined>
        )[held];
        if (!confers) continue;
        for (const w of confers) {
          add(w, { via: "platform", role: role.roleKey, permission: held });
        }
      }
    }

    const permissions = [...new Set(Object.keys(provenance))].sort() as WorkspacePermission[];
    return {
      permissions,
      provenance,
      memberRole: member?.role ?? null,
      isSuperAdmin: false,
    };
  },

  /** The hot path. Same union as `forWorkspace`; the provenance is simply not read. */
  async has(
    identity: Identity | undefined,
    workspaceId: string,
    permission: WorkspacePermission,
    cache?: PlatformRoleCache,
  ): Promise<boolean> {
    const eff = await this.forWorkspace(identity, workspaceId, cache);
    return eff.permissions.includes(permission);
  },

  /**
   * The person's PLATFORM permissions — no workspace in the question.
   *
   * ⚠ The allowlist short-circuits here too, and for the same reason: a deployment whose
   * platform-role table is empty must still be administrable by its allowlist holder,
   * or the tier this feature adds is a way to lock everybody out.
   */
  async platformPermissions(
    identity: Identity | undefined,
    cache?: PlatformRoleCache,
  ): Promise<{ permissions: PlatformPermission[]; roles: string[]; isSuperAdmin: boolean }> {
    if (config.isSuperAdmin(identity ?? null)) {
      const { PLATFORM_PERMISSIONS } = await import("../auth/permissions.js");
      return {
        permissions: [...PLATFORM_PERMISSIONS].sort(),
        roles: [],
        isSuperAdmin: true,
      };
    }
    const subject = identity?.subject ?? null;
    if (!subject) return { permissions: [], roles: [], isSuperAdmin: false };

    const roles = cache ? await cache.rolesFor(subject) : await platformRoleRepo.rolesFor(subject);
    const permissions = new Set<PlatformPermission>();
    for (const r of roles) for (const p of r.permissions) permissions.add(p);
    return {
      permissions: [...permissions].sort(),
      roles: roles.map((r) => r.roleKey).sort(),
      isSuperAdmin: false,
    };
  },

  async hasPlatform(
    identity: Identity | undefined,
    permission: PlatformPermission,
    cache?: PlatformRoleCache,
  ): Promise<boolean> {
    const { permissions } = await this.platformPermissions(identity, cache);
    return permissions.includes(permission);
  },

  /**
   * What this person's platform standing confers into EVERY workspace.
   *
   * Used by `GET /api/workspaces`'s filter (FR-015): a `platform-admin` sees every
   * workspace because the conferral gives them `members.read` everywhere, and an
   * `auditor` sees **none**, which is correct rather than a bug — they read across
   * tenants through the audit record, and the workspace list is tenant metadata they
   * hold no permission for.
   */
  async conferredEverywhere(
    identity: Identity | undefined,
    cache?: PlatformRoleCache,
  ): Promise<readonly WorkspacePermission[]> {
    const { permissions, isSuperAdmin } = await this.platformPermissions(identity, cache);
    if (isSuperAdmin) return [...WORKSPACE_PERMISSIONS].sort();
    return conferredByPlatform(permissions);
  },
};

export type { Permission };
