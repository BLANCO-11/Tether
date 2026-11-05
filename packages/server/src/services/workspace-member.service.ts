import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { workspaceMembers } from "../db/schema.js";
import { z } from "zod";
import { config } from "../config/index.js";
import { superAdminHere } from "./workspace-restriction.service.js";
import { containsAll, presetPermissions } from "../auth/role-presets.js";

/**
 * Roles in a workspace — archive/GAPS.md §1.1.
 *
 * ── What was there before ───────────────────────────────────────────────────
 *
 * Gate 2 (approve a revision) and gate 3 (approve a paused step) refused
 * *self*-approval and nothing else. There were no roles, so anyone who could
 * sign in could approve anything, and "a second pair of eyes" meant only "a
 * different string". Stage 9 made the approver's NAME verified; it never made
 * the approver AUTHORISED.
 *
 * ── ⚠ The claim to make, and the two this does not support ──────────────────
 *
 * True: **a person who has not been granted `approver` in this workspace cannot
 * approve in it**, which was false for every signed-in person until now.
 *
 * Not true, and neither should ever be written down as if it were:
 *
 *   * *"separation of duties"* unqualified (I-13). Anything holding
 *     `RUNTIME_JWT_SECRET` mints any identity — `e2e:ui` does — and a minted
 *     identity with an `approver` row approves. This raises the bar from "can
 *     sign in" to "can sign in AND was granted the role"; it does not defend
 *     against the signing secret.
 *   * *"authenticated user"*. Same reason, and CLAUDE.md already forbids the
 *     phrase.
 *
 * ── Why the check is at the ROUTE and not inside the approval services ──────
 *
 * The instinct in this codebase is the opposite — `flow-approval.service.ts` is
 * *"the only module that writes to the live namespace"* precisely so the
 * property is greppable. This is different in kind: it is an authorisation
 * decision about a **request**, and it needs `req.user`, which a service called
 * from `scenarios:seed` does not have and should not invent.
 *
 * Putting it in the service would mean one of two things, both bad. Either
 * every harness, seed and CLI path acquires a fake privileged identity — at
 * which point the role model is satisfied by a constant and protects nobody —
 * or they all break, which is how a control gets reverted. So it is
 * `requireWorkspaceRole` beside `requireIdentity`, on the same routes, and
 * **`workspace-member.test.ts` greps the route tree** to assert that every route
 * reaching an approval decision carries it. A route that forgets it would work
 * perfectly and report nothing, which is the shape this repo has been bitten by
 * twice (a secret with a second silent reader, `authorOf` as the one minter).
 *
 * ── Zero members is a REFUSAL, not a bypass ─────────────────────────────────
 *
 * Migration 0027 backfills nothing. A workspace with no members refuses every
 * approval over HTTP until a **super admin assigns** somebody to it.
 *
 * ⚠ The tempting shape — *"if there are no members, allow it"* — is a control
 * that turns itself off exactly where it has never been configured, i.e.
 * everywhere it matters. And the next shape along — *"the first person to
 * approve becomes admin"* — is a gate that grants the role to whoever arrives.
 *
 * ⚠ **`claim()` IS DELETED and this is where it was.** It was the bootstrap:
 * `POST …/members/claim`, identity-only, first caller becomes admin, refused
 * once the workspace had any member. Its cost was stated at the time and is
 * what removed it — *on a deployment where anyone can sign in, the first person
 * to claim an unclaimed workspace owns it*. The replacement is
 * `config.SUPER_ADMIN_EMAILS`: a grant that cannot be obtained from inside the
 * product, so nobody can escalate to it through the screen they were just
 * given.
 *
 * ⚠ **What that trades, in the open.** `check`'s super-admin branch runs before
 * the member list is read, so a super admin can always grant a memberless
 * workspace its first member — which is why removing `claim` adds no dead end.
 * But with an EMPTY allowlist it adds a permanent one: no super admin, no
 * claim, no members, nothing assignable over HTTP. That is why the refusal
 * above forks on `superAdminConfigured` and names the variable, and why
 * `SUPER_ADMIN_EMAILS` is documented as load-bearing rather than optional.
 *
 * ⚠ **`BOOTSTRAP_GRANT` stays.** Rows written by the deleted endpoint still
 * exist and still read `granted_by = 'bootstrap'`; the badge that explains
 * "nobody let this person in" has to keep working, or the history of how those
 * memberships arrived is lost.
 */

export const ROLES = ["viewer", "author", "approver", "admin"] as const;
export type WorkspaceRole = (typeof ROLES)[number];

/**
 * Role → what it may additionally do. Ordered, so a check is a comparison
 * rather than a set of `||`s that drift apart between call sites.
 */
/**
 * ⚠ **`RANK` IS GONE. Ordering is SET CONTAINMENT now** (INV-4).
 *
 * It was `{ author: 1, approver: 2, admin: 3 }` and `RANK[mine] < RANK[needed]` decided
 * every role check in the product. The property it expressed — an admin satisfies an
 * approver check — survives unchanged; the mechanism does not, and the replacement is
 * strictly more general. An integer can only order a line, and a **custom role** is not
 * on any line: "Finance Reviewer" holding `flows.approve` and nothing else is neither
 * above nor below `author`, and there is no number that could place it.
 *
 * `containsAll(presetPermissions(mine), presetPermissions(needed))` answers the same
 * question for the three presets and the right question for everything else.
 *
 * ⚠ `workspace-member.test.ts` asserts the PROPERTY and its comment no longer names
 * `RANK`. A test that went on describing a mechanism that is gone is worse than no
 * comment, because it reads as a live description of how the check works.
 */

/** The literal recorded in `granted_by` for the first member of a workspace. */
export const BOOTSTRAP_GRANT = "bootstrap";

export const grantSchema = z
  .object({
    subject: z.string().min(1).max(255),
    email: z.string().email().max(255),
    role: z.enum(ROLES),
  })
  .strict();

export interface Member {
  id: string;
  workspaceId: string;
  subject: string;
  email: string;
  role: WorkspaceRole;
  grantedBy: string;
  createdAt: Date | null;
}

function toPublic(r: typeof workspaceMembers.$inferSelect): Member {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    subject: r.subject,
    email: r.email,
    role: r.role as WorkspaceRole,
    grantedBy: r.grantedBy,
    createdAt: r.createdAt,
  };
}

function httpError(message: string, statusCode: number) {
  const e = new Error(message) as Error & { statusCode?: number };
  e.statusCode = statusCode;
  return e;
}

export const workspaceMemberService = {
  ROLES,
  BOOTSTRAP_GRANT,

  async list(workspaceId: string): Promise<Member[]> {
    const rows = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .orderBy(asc(workspaceMembers.createdAt));
    return rows.map(toPublic);
  },

  /** The caller's own row, or undefined. Subject, never email — see the schema. */
  async find(workspaceId: string, subject: string): Promise<Member | undefined> {
    const [row] = await db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.subject, subject)))
      .limit(1);
    return row ? toPublic(row) : undefined;
  },

  async count(workspaceId: string): Promise<number> {
    return (await this.list(workspaceId)).length;
  },

  /**
   * Does this subject hold at least `needed` in this workspace?
   *
   * Returns a REASON rather than a boolean, because the three refusals need
   * different messages and a caller reducing them to `false` would produce one
   * unhelpful 403 for "the workspace has no members yet" and "you are an author,
   * not an approver" alike.
   */
  async check(
    workspaceId: string,
    /**
     * The caller. A bare string is read as the subject — every existing caller
     * and test passes one, and an identity that is only a subject is still a
     * complete answer for the member lookup, which is keyed on subject. The
     * object form exists because the SUPER-ADMIN allowlist matches subject *or*
     * email (config.isSuperAdmin), and passing only the subject there is the
     * bug that made a correctly-configured email grant nothing.
     */
    identity: string | { subject?: string | null; email?: string | null } | undefined,
    needed: WorkspaceRole,
  ): Promise<{ allowed: true; role: WorkspaceRole } | { allowed: false; status: number; reason: string }> {
    const who = typeof identity === "string" ? { subject: identity, email: null } : (identity ?? null);
    const subject = who?.subject ?? undefined;
    if (!subject) {
      return {
        allowed: false,
        status: 401,
        reason:
          "this action is authorised per workspace, so it needs a signed-in user. The API key " +
          "authorises the request; it does not name a person.",
      };
    }
    // Super admin (env allowlist): acts in EVERY workspace at the highest role,
    // member or not. An ACCESS grant only — the accountability gates downstream
    // (self-approval refusal, provenance) still apply, so a super admin
    // approving a flow they authored is refused exactly like anybody else. Off
    // by default (empty allowlist).
    //
    // ⚠ Matched through `config.isSuperAdmin`, on subject OR email, and it used
    // to be `superAdminEmails.has(subject)` — see that function's docblock for
    // why subject-only was a silent failure for every Entra sign-in.
    //
    // ⚠ This branch runs BEFORE the member list is read, which is what makes a
    // memberless workspace assignable at all now that `claim` is gone: a super
    // admin passes the `admin` check in a workspace with zero members, so they
    // can grant its first one.
    // ⚠ Not in a restricted workspace without an active emergency access (workspace-restriction.service.ts).
    if (await superAdminHere(who, workspaceId)) {
      return { allowed: true, role: "admin" };
    }
    const members = await this.list(workspaceId);
    if (members.length === 0) {
      return {
        allowed: false,
        status: 403,
        reason: config.superAdminConfigured
          ? "this workspace has no members yet, so nobody is authorised to act in it. A super " +
            "admin can assign you to it from Manage Workspaces. It is refused rather than " +
            "allowed on purpose: a role check that passes when unconfigured passes everywhere " +
            "it was never set up."
          : "this workspace has no members yet, and this deployment has no super admin " +
            "configured, so nobody can assign one. Set SUPER_ADMIN_EMAILS on the API server " +
            "(identity subject or email, comma-separated) and that person can assign members. " +
            "It is refused rather than allowed on purpose: a role check that passes when " +
            "unconfigured passes everywhere it was never set up.",
      };
    }
    const mine = members.find((m) => m.subject === subject);
    if (!mine) {
      return {
        allowed: false,
        status: 403,
        reason: `you are not a member of this workspace. A super admin can assign you to it with the "${needed}" role.`,
      };
    }
    if (!containsAll(presetPermissions(mine.role), presetPermissions(needed))) {
      return {
        allowed: false,
        status: 403,
        reason: `this action needs the "${needed}" role in this workspace and you hold "${mine.role}".`,
      };
    }
    return { allowed: true, role: mine.role };
  },

  /**
   * Grant or change a role. Admin-only; the route enforces that.
   *
   * ⚠ **An admin cannot demote or remove themselves while they are the last
   * one.** Not politeness: a workspace with members but no admin can never grant
   * again, and the only repair is a database edit.
   *
   * ⚠ **A SUPER ADMIN IS EXEMPT, and that was MEASURED rather than reasoned.**
   * The first version of this feature kept the refusal absolute, and the wire
   * test found the consequence immediately: a super admin assigned the wrong
   * person as a workspace's only member and **could not take it back** — the
   * removal 409'd, and with `claim` deleted there was no other way in or out. An
   * irreversible mis-assignment is a worse failure than the state the refusal
   * protects against.
   *
   * The refusal's premise is *"members and nobody able to grant again"*, and for
   * a super admin that premise is false by construction: `check`'s super-admin
   * branch runs before the member list is read, so they can always re-assign.
   *
   * ⚠ Kept for every other caller, and it still has teeth: the seeds, the
   * harnesses and `scenarios:seed` all call this service directly with no
   * identity, and on a deployment with an EMPTY allowlist there is no super
   * admin to recover with. The flag is set by the route from
   * `config.isSuperAdmin(req.user)` — never accepted from a request body, which
   * would make the exemption something a caller could assert.
   */
  async grant(
    workspaceId: string,
    input: z.infer<typeof grantSchema>,
    grantedBy: string,
    /**
     * Set by the route when the caller is a super admin — see
     * `LAST_ADMIN_NOTE` below.
     */
    opts: { bySuperAdmin?: boolean } = {},
  ): Promise<Member> {
    const members = await this.list(workspaceId);
    const target = members.find((m) => m.subject === input.subject);
    if (!opts.bySuperAdmin && target && target.role === "admin" && input.role !== "admin") {
      const admins = members.filter((m) => m.role === "admin");
      if (admins.length === 1) {
        throw httpError(
          "this is the workspace's last admin, and demoting them would leave it with members and " +
            "nobody able to grant a role — an unrecoverable state. Promote another admin first.",
          409,
        );
      }
    }
    if (target) {
      const [row] = await db
        .update(workspaceMembers)
        .set({ email: input.email, role: input.role, grantedBy, updatedAt: new Date() })
        .where(eq(workspaceMembers.id, target.id))
        .returning();
      return toPublic(row!);
    }
    const [row] = await db
      .insert(workspaceMembers)
      .values({ workspaceId, ...input, grantedBy })
      .returning();
    return toPublic(row!);
  },

  /** Remove a member. Same last-admin refusal as `grant`, same reason and same exemption. */
  async revoke(
    workspaceId: string,
    subject: string,
    opts: { bySuperAdmin?: boolean; by?: string } = {},
  ): Promise<boolean> {
    const members = await this.list(workspaceId);
    const target = members.find((m) => m.subject === subject);
    if (!target) return false;
    if (
      !opts.bySuperAdmin &&
      target.role === "admin" &&
      members.filter((m) => m.role === "admin").length === 1
    ) {
      throw httpError(
        "this is the workspace's last admin, and removing them would leave it with members and " +
          "nobody able to grant a role — an unrecoverable state.",
        409,
      );
    }
    await db.delete(workspaceMembers).where(eq(workspaceMembers.id, target.id));
    // ⚠ Their own connections to services in this workspace go with them (plugins 8.7). Loaded here, not imported at
    // the top: the plugin service reaches far more than membership should depend on.
    const { pluginService } = await import("./plugin.service.js");
    await pluginService.removePersonalConnections(workspaceId, subject, opts.by ?? "workspace membership").catch((e) =>
      console.warn(`[members] could not remove the personal connections of ${subject} in ${workspaceId}: ${(e as Error).message}`),
    );
    // ⚠ Their workflows become the Admins' (sharing-boundaries): nobody else could decide their runs' pauses or change
    // them. Loaded here for the same reason as the plugin service above.
    // ⚠ Out of every project first, so what they owned in a project passes to its owner, not to nobody (phase 5).
    const { projectService } = await import("./project.service.js");
    await projectService.memberLeftWorkspace(workspaceId, subject, opts.by ?? "workspace membership").catch((e) =>
      console.warn(`[members] could not take ${subject} out of the projects in ${workspaceId}: ${(e as Error).message}`),
    );
    const { releaseOwnedBy } = await import("./flow-ownership.service.js");
    await releaseOwnedBy(workspaceId, subject, opts.by ?? "workspace membership").catch((e) =>
      console.warn(`[members] could not release the workflows of ${subject} in ${workspaceId}: ${(e as Error).message}`),
    );
    return true;
  },
};
