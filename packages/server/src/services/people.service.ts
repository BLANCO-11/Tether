/**
 * People — one row per person, for the Admin "People" page (admin simplify, phase 3 — plans/admin-simplify-2026-10-30).
 *
 * Built on `accessMatrixService.build`, so every workspace a row shows is the guard's own answer for that person
 * (memberships, custom roles, grants, platform conferral, the super-admin list, restricted workspaces) — never a second
 * derivation from the role column. Gated like the matrix: `platform.users.read`.
 *
 * It also says what the VIEWER may do (`can`), so the screen offers only actions that will succeed; every one of
 * those actions is still refused by its own route if the answer has changed.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { config } from "../config/index.js";
import { platformRoleRepo } from "../repositories/platform-role.repo.js";
import { accessMatrixService, type Reach } from "./access-matrix.service.js";
import { effectivePermissionsService, PlatformRoleCache, type Identity } from "./effective-permissions.service.js";
import { invitationService, type Invitation } from "./invitation.service.js";
import { localUserService, LOCAL_SUBJECT_PREFIX } from "./local-user.service.js";

export interface PersonWorkspace {
  id: string;
  name: string;
  /** The membership role, or null when they reach it some other way (super admin, platform role, custom role). */
  role: string | null;
  reach: Reach;
  /** In words, why they reach it ("Creator", "super admin", "platform role auditor"…). */
  via: string[];
}

export interface Person {
  subject: string;
  email: string;
  name: string | null;
  /** How they sign in. "local" is a local account; "microsoft" anybody else who has signed in. */
  signIn: "microsoft" | "local";
  /** Null when they have never signed in. */
  lastSeenAt: string | null;
  superAdmin: boolean;
  platformRoles: string[];
  /** Only workspaces they reach; restricted workspaces the viewer is outside of never appear. */
  workspaces: PersonWorkspace[];
  /** Local accounts only. */
  localAccount: { id: string; username: string; active: boolean } | null;
}

export interface PeopleView {
  people: Person[];
  invitations: Invitation[];
  /** Every workspace the viewer can see, for filters and pickers. */
  workspaces: { id: string; name: string; canAddPeople: boolean }[];
  /** Restricted workspaces the viewer is outside of: named so the list does not look complete when it is not. */
  closedWorkspaces: string[];
  platformRoles: { key: string; name: string }[];
  can: { givePlatformRoles: boolean; createLocalAccounts: boolean };
}

export const peopleService = {
  async build(viewer: Identity): Promise<PeopleView> {
    const [matrix, seen, locals, assignments, roles, invitations] = await Promise.all([
      accessMatrixService.build(viewer),
      db.execute(sql`SELECT subject, last_seen_at FROM platform_users`),
      localUserService.list(),
      platformRoleRepo.assignments(),
      platformRoleRepo.list(),
      invitationService.list(viewer),
    ]);
    const lastSeen = new Map(
      (seen.rows as { subject: string; last_seen_at: Date | string }[]).map((r) => [r.subject, new Date(r.last_seen_at).toISOString()]),
    );
    const localBySubject = new Map(locals.map((l) => [l.subject, l]));
    const rolesOf = new Map<string, string[]>();
    for (const a of assignments) rolesOf.set(a.subject, [...(rolesOf.get(a.subject) ?? []), a.roleKey]);

    const open = matrix.workspaces.filter((w) => !w.restricted);
    const people: Person[] = matrix.people.map((p) => {
      const local = localBySubject.get(p.subject);
      return {
        subject: p.subject,
        email: local?.email ?? p.email,
        name: local?.name ?? p.name,
        signIn: p.subject.startsWith(LOCAL_SUBJECT_PREFIX) ? "local" : "microsoft",
        lastSeenAt: lastSeen.get(p.subject) ?? null,
        superAdmin: p.superAdmin,
        platformRoles: (rolesOf.get(p.subject) ?? []).sort(),
        workspaces: open
          .map((w) => ({ w, c: p.cells[w.id] }))
          .filter(({ c }) => c && (c.role !== null || c.reach !== "none"))
          .map(({ w, c }) => ({ id: w.id, name: w.name, role: c!.role, reach: c!.reach, via: c!.via })),
        localAccount: local ? { id: local.id, username: local.username, active: local.isActive } : null,
      };
    });
    // A local account that has never signed in and is in no workspace is still a person somebody made.
    const listed = new Set(people.map((p) => p.subject));
    for (const l of locals) {
      if (listed.has(l.subject)) continue;
      people.push({
        subject: l.subject,
        email: l.email ?? "",
        name: l.name ?? l.username,
        signIn: "local",
        lastSeenAt: l.lastSignInAt,
        superAdmin: config.isSuperAdmin({ subject: l.subject, email: l.email }),
        platformRoles: (rolesOf.get(l.subject) ?? []).sort(),
        workspaces: [],
        localAccount: { id: l.id, username: l.username, active: l.isActive },
      });
    }
    people.sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));

    const cache = new PlatformRoleCache();
    const workspaces = await Promise.all(
      open.map(async (w) => {
        const eff = await effectivePermissionsService.forWorkspace(viewer, w.id, cache);
        return { id: w.id, name: w.name, canAddPeople: (eff.permissions as readonly string[]).includes("members.grant") };
      }),
    );
    const mine = await effectivePermissionsService.platformPermissions(viewer, cache);
    return {
      people,
      invitations,
      workspaces,
      closedWorkspaces: matrix.workspaces.filter((w) => w.restricted).map((w) => w.name),
      platformRoles: roles.map((r) => ({ key: r.key, name: r.name })),
      can: {
        givePlatformRoles: mine.permissions.includes("platform.members.grant"),
        createLocalAccounts: mine.permissions.includes("platform.localusers.write"),
      },
    };
  },
};
