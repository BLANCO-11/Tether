/**
 * Who can see what, across the deployment (rbac-observability, 2026-10-15): one row per person, one column per
 * workspace, each cell what that person may see and do there and WHY.
 *
 * ⚠ **This is the cross-workspace member listing D-27 refused, built on purpose and gated narrowly.** D-27's worry is
 * a directory of a customer base assembled from rows nobody meant to publish together. The answer here is the gate:
 * `platform.users.read` — the people who run the deployment and already read `GET /api/platform/users` — and the
 * payload carries its own caveat. It names roles and reach; it never lists a workspace's content.
 *
 * ⚠ Every cell is `effectivePermissionsService.forWorkspace` — the SAME union every route's guard decides from — so
 * the grid cannot disagree with what the product actually allows. A second derivation here (from the role column
 * alone) would miss custom roles, individual grants, platform conferral and the super-admin allowlist.
 */
import type { WorkspacePermission } from "../auth/permissions.js";
import { config } from "../config/index.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { effectivePermissionsService, PlatformRoleCache, type Provenance } from "./effective-permissions.service.js";
import { platformUserService } from "./platform-user.service.js";
import { workspaceMemberService } from "./workspace-member.service.js";
import { closedTo } from "./workspace-restriction.service.js";

/** How far a person's sight reaches in one workspace — the private / published regions, in order. */
export type Reach = "none" | "published" | "own" | "review" | "everything";

export interface AccessCell {
  reach: Reach;
  /** The membership role, or null (super admin, platform conferral, or nothing). */
  role: string | null;
  /** Why, in words: "Creator", "custom role Auditors", "individual grant", "platform admin", "super admin". */
  via: string[];
  /** Whose cost they see here: their own, everyone's, or none. */
  cost: "none" | "own" | "everyone";
  /** May they change who is in the workspace. */
  managesPeople: boolean;
  permissionCount: number;
}

export interface AccessMatrix {
  /** `restricted`: a restricted workspace the viewer is outside of — its name only, and no cell in any row. */
  workspaces: Array<{ id: string; name: string; restricted?: boolean }>;
  people: Array<{ subject: string; email: string; name: string | null; superAdmin: boolean; cells: Record<string, AccessCell> }>;
  caveat: string;
}

const ROLE_WORDS: Record<string, string> = { viewer: "Observer", author: "Creator", approver: "Reviewer", admin: "Admin" };

/** The region a permission set reaches. Pure — the order is the order of the regions, widest last. */
export function reachOf(perms: readonly string[]): Reach {
  const has = (p: string) => perms.includes(p);
  if (has("content.read.others")) return "everything";
  if (has("flows.approve")) return "review";
  if (has("flows.write")) return "own";
  if (has("flows.read") || has("runs.read")) return "published";
  return "none";
}

/** Every distinct reason behind a permission set, in words. */
export function viaOf(provenance: Record<string, Provenance[]>, superAdmin: boolean): string[] {
  if (superAdmin) return ["super admin"];
  const out = new Set<string>();
  for (const sources of Object.values(provenance)) {
    for (const s of sources) {
      if (s.via === "preset") out.add(ROLE_WORDS[s.role] ?? s.role);
      else if (s.via === "role") out.add(`custom role ${s.roleName}`);
      else if (s.via === "grant") out.add("individual grant");
      else if (s.via === "platform") out.add(`platform role ${s.role}`);
      else if (s.via === "superadmin") out.add("super admin");
    }
  }
  return [...out].sort();
}

export const accessMatrixService = {
  async build(viewer?: { subject?: string | null; email?: string | null } | null): Promise<AccessMatrix> {
    const [all, users, closed] = await Promise.all([workspaceRepo.list(), platformUserService.list(), closedTo(viewer)]);
    // ⚠ Restricted workspaces (phase 3): one the viewer is outside of is a name and nothing else — no members, no cells.
    const workspaces = all.filter((w) => !closed.has(w.id));
    const members = await Promise.all(workspaces.map((w) => workspaceMemberService.list(w.id)));

    // Everyone who signed in, plus every member who has not yet (a member row is keyed on subject alone).
    const people = new Map<string, { subject: string; email: string; name: string | null }>();
    for (const u of users) people.set(u.subject, { subject: u.subject, email: u.email, name: u.name });
    for (const list of members) for (const m of list) if (!people.has(m.subject)) people.set(m.subject, { subject: m.subject, email: m.email, name: null });

    const cache = new PlatformRoleCache();
    const rows = await Promise.all(
      [...people.values()].map(async (p) => {
        const identity = { subject: p.subject, email: p.email };
        const cells: Record<string, AccessCell> = {};
        for (const w of workspaces) {
          const eff = await effectivePermissionsService.forWorkspace(identity, w.id, cache);
          const perms = eff.permissions as readonly WorkspacePermission[];
          const reach = reachOf(perms);
          cells[w.id] = {
            reach,
            role: eff.isSuperAdmin ? null : eff.memberRole,
            via: viaOf(eff.provenance, eff.isSuperAdmin),
            // Cost follows the regions: everyone's with `content.read.others`, else your own wherever you have a reach.
            cost: reach === "everything" ? "everyone" : reach === "none" ? "none" : "own",
            managesPeople: perms.includes("members.grant" as WorkspacePermission),
            permissionCount: perms.length,
          };
        }
        return { ...p, superAdmin: config.isSuperAdmin(identity), cells };
      }),
    );
    rows.sort((a, b) => Number(b.superAdmin) - Number(a.superAdmin) || a.email.localeCompare(b.email));
    return {
      workspaces: [
        ...workspaces.map((w) => ({ id: w.id, name: w.name })),
        ...[...closed].map(([id, name]) => ({ id, name, restricted: true })),
      ].sort((a, b) => a.name.localeCompare(b.name)),
      people: rows,
      caveat:
        "Worked out from the same permissions every request is checked against. It lists people this deployment has " +
        "seen sign in and every workspace member; someone on the super-admin list who has never signed in is not shown.",
    };
  },
};
