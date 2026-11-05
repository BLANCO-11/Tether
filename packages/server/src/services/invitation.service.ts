import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { platformRoleRepo } from "../repositories/platform-role.repo.js";
import { effectivePermissionsService, PlatformRoleCache, type Identity } from "./effective-permissions.service.js";
import { platformRoleService } from "./platform-role.service.js";
import { workspaceMemberService } from "./workspace-member.service.js";
import { accessAuditService } from "./access-audit.service.js";
import { superAdminHere } from "./workspace-restriction.service.js";
import { ROLES as WORKSPACE_ROLES } from "./workspace-member.service.js";

/**
 * Invite a person by email, with their workspaces and roles chosen in advance (admin simplify, phase 2 —
 * plans/admin-simplify-2026-10-30). At their first sign-in every entry becomes real before the first page loads.
 *
 * ⚠ **Everything is decided by the INVITER, when they invite.** Each workspace needs `members.grant` there, and a
 * platform role needs the inviter to hold every permission it carries — the same rules as granting directly. At sign-in
 * the person merely receives what was decided; nothing they present can widen it.
 *
 * ⚠ **Matching by email is sound only because sign-in accepts ONE Entra tenant** (`ALLOWED_TENANT_ID` in the client's
 * auth.ts), so an address can only come from this organisation's directory or a local account an admin created. Opening
 * sign-in to other tenants would make an email claim something an outsider can set: redeeming would then need the
 * person's id, not their email.
 *
 * If the email already belongs to exactly ONE person who has signed in, the access is applied at once and no invitation
 * is kept, so "add a person" means the same thing whether or not they have signed in yet.
 */

/** How long an invitation waits. Long enough to set people up ahead of a rollout. */
export const INVITATION_DAYS = 30;

export const inviteSchema = z
  .object({
    email: z.string().trim().email().max(255),
    workspaces: z
      .array(z.object({ workspaceId: z.string().uuid(), role: z.enum(WORKSPACE_ROLES) }).strict())
      .max(100)
      .default([]),
    platformRole: z.string().min(1).max(64).nullable().optional(),
  })
  .strict()
  .refine((v) => v.workspaces.length > 0 || !!v.platformRole, {
    message: "choose at least one workspace or a platform role",
  });

export type InviteInput = z.infer<typeof inviteSchema>;

export interface Invitation {
  id: string;
  email: string;
  workspaces: { workspaceId: string; workspaceName: string; role: string }[];
  /** Null when there is none, or when the reader may not see platform roles. */
  platformRole: string | null;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

export type InviteResult =
  | { applied: true; subject: string; email: string }
  | { applied: false; invitation: Invitation };

function httpError(message: string, statusCode: number, error?: string) {
  return Object.assign(new Error(message), { statusCode, ...(error ? { error } : {}) });
}

async function mayGrant(actor: Identity, workspaceId: string, cache: PlatformRoleCache): Promise<boolean> {
  const eff = await effectivePermissionsService.forWorkspace(actor, workspaceId, cache);
  return (eff.permissions as readonly string[]).includes("members.grant");
}

async function mayRead(actor: Identity, workspaceId: string, cache: PlatformRoleCache): Promise<boolean> {
  const eff = await effectivePermissionsService.forWorkspace(actor, workspaceId, cache);
  return (eff.permissions as readonly string[]).includes("members.read");
}

/** Refuse unless the actor may grant in every named workspace, and may hand out the platform role. */
async function checkAuthority(actor: Identity, input: { workspaces: { workspaceId: string }[]; platformRole?: string | null }) {
  const cache = new PlatformRoleCache();
  for (const w of input.workspaces) {
    const ws = await workspaceRepo.get(w.workspaceId);
    if (!ws) throw httpError("one of the chosen workspaces does not exist", 404, "not_found");
    if (!(await mayGrant(actor, w.workspaceId, cache))) {
      throw httpError(`you cannot add people to "${ws.name}"`, 403, "forbidden");
    }
  }
  if (input.platformRole) {
    const role = await platformRoleService.requireRole(input.platformRole);
    const mine = await effectivePermissionsService.platformPermissions(actor, cache);
    if (!mine.permissions.includes("platform.members.grant")) {
      throw httpError("you cannot give platform roles", 403, "forbidden");
    }
    await platformRoleService.assertGrantable(actor, role.permissions);
  }
}

async function signedInWith(email: string): Promise<{ subject: string; email: string }[]> {
  const r = await db.execute(sql`SELECT subject, email FROM platform_users WHERE lower(email) = ${email}`);
  return r.rows as { subject: string; email: string }[];
}

async function view(ids: string[], actor: Identity | null): Promise<Invitation[]> {
  if (!ids.length) return [];
  const rows = (
    await db.execute(sql`
      SELECT i.id, i.email, i.platform_role_key, coalesce(i.invited_by_email, i.invited_by) AS invited_by,
             i.created_at, i.expires_at, i.expires_at < now() AS expired,
             coalesce(json_agg(json_build_object('workspaceId', w.workspace_id, 'workspaceName', ws.name, 'role', w.role)
                      ORDER BY ws.name) FILTER (WHERE w.workspace_id IS NOT NULL), '[]') AS workspaces
        FROM person_invitations i
        LEFT JOIN person_invitation_workspaces w ON w.invitation_id = i.id
        LEFT JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL
       WHERE i.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
       GROUP BY i.id
       ORDER BY i.created_at DESC`)
  ).rows as {
    id: string;
    email: string;
    platform_role_key: string | null;
    invited_by: string;
    created_at: Date | string;
    expires_at: Date | string;
    expired: boolean;
    workspaces: { workspaceId: string; workspaceName: string | null; role: string }[];
  }[];

  const cache = new PlatformRoleCache();
  const seesPlatform = actor
    ? (await effectivePermissionsService.platformPermissions(actor, cache)).permissions.includes("platform.users.read")
    : true;
  const readable = new Map<string, boolean>();
  const out: Invitation[] = [];
  for (const r of rows) {
    const workspaces: Invitation["workspaces"] = [];
    for (const w of r.workspaces) {
      if (!w.workspaceName) continue; // its workspace was deleted
      if (actor) {
        if (!readable.has(w.workspaceId)) readable.set(w.workspaceId, await mayRead(actor, w.workspaceId, cache));
        if (!readable.get(w.workspaceId)) continue;
      }
      workspaces.push({ workspaceId: w.workspaceId, workspaceName: w.workspaceName, role: w.role });
    }
    const platformRole = seesPlatform ? r.platform_role_key : null;
    if (!workspaces.length && !platformRole) continue; // nothing in it this reader may see
    out.push({
      id: r.id,
      email: r.email,
      workspaces,
      platformRole,
      invitedBy: r.invited_by,
      createdAt: new Date(r.created_at).toISOString(),
      expiresAt: new Date(r.expires_at).toISOString(),
      expired: r.expired,
    });
  }
  return out;
}

export const invitationService = {
  /**
   * Add a person by email. Applied at once when the email belongs to exactly one person who has signed in; otherwise
   * kept as an invitation (added to the open one if there is one, renewing its expiry).
   */
  async invite(actor: Identity & { subject: string }, raw: unknown): Promise<InviteResult> {
    const input = inviteSchema.parse(raw);
    const email = input.email.toLowerCase();
    await checkAuthority(actor, input);

    const people = await signedInWith(email);
    if (people.length > 1) {
      throw httpError(
        `more than one person has signed in with ${email}. Choose the right one from People instead.`,
        409,
        "ambiguous_email",
      );
    }
    if (people.length === 1) {
      const person = people[0]!;
      for (const w of input.workspaces) {
        await workspaceMemberService.grant(
          w.workspaceId,
          { subject: person.subject, email, role: w.role },
          actor.email ?? actor.subject,
          { bySuperAdmin: await superAdminHere(actor, w.workspaceId) },
        );
      }
      if (input.platformRole) {
        await platformRoleService.assign({ subject: person.subject, email, roleKey: input.platformRole }, actor);
      }
      return { applied: true, subject: person.subject, email };
    }

    const id = await db.transaction(async (tx) => {
      const r = await tx.execute(sql`
        INSERT INTO person_invitations (email, platform_role_key, invited_by, invited_by_email, expires_at)
        VALUES (${email}, ${input.platformRole ?? null}, ${actor.subject}, ${actor.email ?? null},
                now() + make_interval(days => ${INVITATION_DAYS}))
        ON CONFLICT (email) WHERE accepted_at IS NULL AND revoked_at IS NULL DO UPDATE SET
          expires_at = excluded.expires_at,
          platform_role_key = coalesce(excluded.platform_role_key, person_invitations.platform_role_key)
        RETURNING id`);
      const invitationId = (r.rows[0] as { id: string }).id;
      for (const w of input.workspaces) {
        await tx.execute(sql`
          INSERT INTO person_invitation_workspaces (invitation_id, workspace_id, role, added_by)
          VALUES (${invitationId}, ${w.workspaceId}, ${w.role}, ${actor.email ?? actor.subject})
          ON CONFLICT (invitation_id, workspace_id) DO UPDATE SET role = excluded.role, added_by = excluded.added_by,
            added_at = now()`);
      }
      return invitationId;
    });
    const [invitation] = await view([id], actor);
    return { applied: false, invitation: invitation! };
  },

  /** Open invitations (expired ones included, so they can be renewed), each showing only what the reader may see. */
  async list(actor: Identity): Promise<Invitation[]> {
    const r = await db.execute(
      sql`SELECT id FROM person_invitations WHERE accepted_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 500`,
    );
    return view((r.rows as { id: string }[]).map((x) => x.id), actor);
  },

  /** Take one workspace off an invitation. An invitation left with nothing is withdrawn. */
  async removeWorkspace(actor: Identity & { subject: string }, invitationId: string, workspaceId: string): Promise<void> {
    if (!(await mayGrant(actor, workspaceId, new PlatformRoleCache()))) {
      throw httpError("you cannot change who is invited to that workspace", 403, "forbidden");
    }
    const r = await db.execute(sql`
      DELETE FROM person_invitation_workspaces w USING person_invitations i
       WHERE w.invitation_id = i.id AND i.id = ${invitationId} AND w.workspace_id = ${workspaceId}
         AND i.accepted_at IS NULL AND i.revoked_at IS NULL`);
    if (!r.rowCount) throw httpError("no such open invitation for that workspace", 404, "not_found");
    await db.execute(sql`
      UPDATE person_invitations SET revoked_at = now(), revoked_by = ${actor.subject}
       WHERE id = ${invitationId} AND platform_role_key IS NULL
         AND NOT EXISTS (SELECT 1 FROM person_invitation_workspaces WHERE invitation_id = ${invitationId})`);
  },

  /** Withdraw a whole invitation: only somebody who could have made every part of it. */
  async revoke(actor: Identity & { subject: string }, invitationId: string): Promise<void> {
    const r = await db.execute(sql`
      SELECT i.platform_role_key, coalesce(array_agg(w.workspace_id) FILTER (WHERE w.workspace_id IS NOT NULL), '{}') AS ws
        FROM person_invitations i LEFT JOIN person_invitation_workspaces w ON w.invitation_id = i.id
       WHERE i.id = ${invitationId} AND i.accepted_at IS NULL AND i.revoked_at IS NULL
       GROUP BY i.id`);
    const row = r.rows[0] as { platform_role_key: string | null; ws: string[] } | undefined;
    if (!row) throw httpError("no such open invitation", 404, "not_found");
    await checkAuthority(actor, {
      workspaces: row.ws.map((workspaceId) => ({ workspaceId })),
      platformRole: row.platform_role_key,
    });
    await db.execute(
      sql`UPDATE person_invitations SET revoked_at = now(), revoked_by = ${actor.subject} WHERE id = ${invitationId}`,
    );
  },

  /**
   * At a person's first sign-in: every open, unexpired invitation for their email becomes real. A workspace role is
   * never LOWERED by an invitation — where they are already a member with a stronger role, that role stays.
   * Returns what was applied. Called (awaited) from `personMergeService.onFirstSight`.
   */
  async redeem(identity: { subject: string; email?: string | null }): Promise<{ workspaces: number; platformRole: string | null }> {
    const email = identity.email?.trim().toLowerCase();
    if (!email) return { workspaces: 0, platformRole: null };
    return db.transaction(async (tx) => {
      const found = (
        await tx.execute(sql`
          SELECT id, platform_role_key, invited_by, invited_by_email FROM person_invitations
           WHERE email = ${email} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
           FOR UPDATE`)
      ).rows as { id: string; platform_role_key: string | null; invited_by: string; invited_by_email: string | null }[];
      let workspaces = 0;
      let platformRole: string | null = null;
      for (const inv of found) {
        const entries = (
          await tx.execute(sql`
            SELECT w.workspace_id, w.role, w.added_by FROM person_invitation_workspaces w
              JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL
             WHERE w.invitation_id = ${inv.id}`)
        ).rows as { workspace_id: string; role: string; added_by: string }[];
        for (const e of entries) {
          await tx.execute(sql`
            INSERT INTO workspace_members (workspace_id, subject, email, role, granted_by)
            VALUES (${e.workspace_id}, ${identity.subject}, ${email}, ${e.role}, ${`invitation: ${e.added_by}`})
            ON CONFLICT (workspace_id, subject) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by,
              updated_at = now()
            WHERE CASE excluded.role WHEN 'admin' THEN 4 WHEN 'approver' THEN 3 WHEN 'author' THEN 2 ELSE 1 END
                > CASE workspace_members.role WHEN 'admin' THEN 4 WHEN 'approver' THEN 3 WHEN 'author' THEN 2 ELSE 1 END`);
          workspaces++;
        }
        if (inv.platform_role_key && (await platformRoleRepo.getByKey(inv.platform_role_key))) {
          await tx.execute(sql`
            INSERT INTO platform_role_assignments (subject, email, role_key, granted_by)
            VALUES (${identity.subject}, ${email}, ${inv.platform_role_key}, ${inv.invited_by})
            ON CONFLICT DO NOTHING`);
          platformRole = inv.platform_role_key;
        }
        await tx.execute(sql`
          UPDATE person_invitations SET accepted_at = now(), accepted_subject = ${identity.subject} WHERE id = ${inv.id}`);
      }
      if (platformRole) {
        const inv = found.find((f) => f.platform_role_key === platformRole)!;
        await accessAuditService.recordPlatformGrant({
          actor: inv.invited_by,
          actorEmail: inv.invited_by_email,
          subject: identity.subject,
          roleKey: platformRole,
          action: "grant",
          after: { roleKey: platformRole, via: "invitation" },
        });
      }
      return { workspaces, platformRole };
    });
  },
};
