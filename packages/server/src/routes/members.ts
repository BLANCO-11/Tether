import { Router } from "express";
import { superAdminHere } from "../services/workspace-restriction.service.js";
import { asyncHandler } from "../middleware/error.middleware.js";
import { actorOf, requireIdentity, requireWorkspaceRole } from "../middleware/identity.middleware.js";
import { config } from "../config/index.js";
import { grantSchema, workspaceMemberService } from "../services/workspace-member.service.js";

export const membersRouter = Router({ mergeParams: true });

/**
 * Workspace membership — archive/GAPS.md §1.1.
 *
 * Mounted at `/api/workspaces/:workspaceId/members`.
 *
 * ⚠ **Reads and writes are gated differently, on purpose.** Listing needs
 * `author` IN the workspace; assigning and removing need a **super admin** for
 * the whole deployment. Anyone who is in a workspace has to be able to see who
 * can approve there — otherwise the refusal they hit is a dead end — but nobody
 * inside a workspace decides who else gets in.
 *
 * ⚠ **There is deliberately no route that lists members ACROSS workspaces.**
 * Same rule as templates and fragment candidates (D-27): a membership list is a
 * list of the people who work on one tenant's automations, and a cross-workspace
 * view is a directory of the customer base assembled from rows nobody meant to
 * publish together.
 */

/**
 * Who is in this workspace.
 *
 * Readable by any member, including an `author` — a person who cannot approve
 * still has to be able to see **who can**, or the refusal they get is a dead end
 * with no next step in it.
 *
 * ⚠ Deliberately NOT `requireSuperAdmin`, unlike the writes below. Gating the
 * read too would leave every member of every workspace unable to find out who
 * to ask, which is the dead end this route exists to prevent.
 *
 * ⚠ **`requireWorkspaceRole("author")` REMOVED — it is `members.read` now, and keeping
 * both would have been AND.** The permission expresses this docblock's intent exactly:
 * `members.read` is in the `author` preset, so every member still reads it.
 *
 * What the role guard additionally required was a MEMBERSHIP ROW, and that is what broke:
 * a platform administrator is conferred `members.read` in every workspace (D-9) and is a
 * member of none, so the role guard refused them at the one read D-9 exists to make
 * reachable. Found by `rbac:platform-verify` reporting 10 of 11 rather than by reading.
 */
membersRouter.get(
  "/",
  requireIdentity,
  asyncHandler(async (req, res) => {
    res.json({ members: await workspaceMemberService.list(req.params.workspaceId!) });
  }),
);

/**
 * Assign somebody to this workspace, or change their role. **Super admin only.**
 *
 * ── What changed, and why the guard moved ───────────────────────────────────
 *
 * It was `requireWorkspaceRole("admin")` — a workspace admin granting inside
 * their own workspace. That check was real, but its BOOTSTRAP was
 * `POST …/members/claim`: the first signed-in caller became the admin of any
 * workspace nobody had claimed. So the effective answer to *"who decides who
 * works here"* was *"whoever asked first"*, and a workspace admin could then
 * grant further admins from there. Claim is deleted.
 *
 * ── ⚠ IT IS NOW `members.grant`, WHICH MEANS SUPER ADMIN **OR** A WORKSPACE ADMIN ──
 *
 * This was `requireSuperAdmin` alone, and the RBAC feature resolved a contradiction
 * between two artefacts that disagreed about whether the new rule was AND or OR. It is
 * **OR**, and that is a deliberate WIDENING (spec behaviour change 3): a workspace
 * administrator can now add and remove members of their own workspace without an
 * allowlist holder.
 *
 * ⚠ **`requireSuperAdmin` is REMOVED rather than kept alongside, and the removal is the
 * whole point.** Keeping both would mean AND — an allowlist holder AND the permission —
 * which is strictly narrower than today and would make a workspace admin unable to
 * manage their own workspace. `members.grant` on its own already yields the OR, because
 * `config.isSuperAdmin` short-circuits the resolver to the ENTIRE catalogue before any
 * row is read: an allowlist holder holds `members.grant` in every workspace, member or
 * not. That short-circuit is also what keeps a memberless workspace assignable at all
 * now that `claim` is gone, which is the property this deployment depends on — all eight
 * of its workspaces have zero members.
 *
 * ⚠ It is also what makes spec D-9 work: a platform administrator is conferred
 * `members.read` + `members.grant` in every workspace, and would be refused here by a
 * super-admin check they cannot satisfy.
 *
 * ⚠ **The guard is SPLICED, not written here.** `auth/route-permissions.ts` declares
 * `POST /api/workspaces/:workspaceId/members → members.grant` and
 * `mountPermissionGuards` puts it in front of this handler at boot. Do not add a second
 * guard to this file: `route-permissions.test.ts` asserts the mounted guard matches the
 * map, and two guards on one route is two answers to one question.
 *
 * ⚠ **`grant()` is unchanged and there is no `assign()`.** It already holds the
 * subject-keying, the insert-vs-update branch and the last-admin refusal; a
 * second writer would be a second place for those to disagree. What moved is the
 * guard, and the default role the UI offers.
 *
 * ⚠ **A super admin CAN remove or demote a workspace's last admin, and the
 * wire test is why.** Keeping the refusal absolute made a mis-assignment
 * irreversible: the removal 409'd and, with `claim` gone, there was no other way
 * back. The refusal's premise — "members and nobody able to grant again" — is
 * false for a super admin, who passes `check` without a row. It still holds for
 * every other caller (the seeds and harnesses call the service directly), and
 * the flag is derived from the verified identity, never from the body.
 */
membersRouter.post(
  "/",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const input = grantSchema.parse(req.body);
    // ⚠ Derived from the verified identity, never from the body. The flag lifts
    // the last-admin refusal — see the service — and a body-settable version
    // would be an exemption any caller could assert.
    const member = await workspaceMemberService.grant(req.params.workspaceId!, input, actorOf(req), {
      bySuperAdmin: await superAdminHere(req.user, req.params.workspaceId!),
    });
    res.status(201).json({ member });
  }),
);

/**
 * Remove a member, by SUBJECT — never by email.
 *
 * The subject is what the membership is keyed on; removing by email would let
 * two people who have swapped an address remove each other's row.
 */
membersRouter.delete(
  "/:subject",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const removed = await workspaceMemberService.revoke(
      req.params.workspaceId!,
      req.params.subject!,
      { bySuperAdmin: await superAdminHere(req.user, req.params.workspaceId!), by: req.user?.email ?? req.user?.subject },
    );
    if (!removed) return res.status(404).json({ error: "not_found", message: "no such member" });
    res.json({ removed: true });
  }),
);
