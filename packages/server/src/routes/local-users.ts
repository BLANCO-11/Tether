// src/routes/local-users.ts — creating and managing accounts for people with no
// AD identity.
//
// ── ⚠ TWO ROUTERS, AND THE SPLIT IS THE SECURITY BOUNDARY ───────────────────
//
// `localUsersRouter` is the ADMIN surface: `requireIdentity` + `requireSuperAdmin`,
// the same gate workspace create/rename/delete and every membership write carry
// since 2026-08-20.
//
// `localAuthRouter` is the SIGN-IN surface, and it is a different thing
// entirely: it answers *before anybody has a session*, because it is what mints
// one. So it cannot require an identity — there is none yet — and the API key is
// all it has. That makes it the only route in the product that takes a password,
// which is why it carries its own throttle and why it is mounted on its own
// path rather than as `POST /api/local-users/verify`: a reader scanning
// `app.ts` must be able to see that one of these is behind `requireSuperAdmin`
// and one is not.
//
// ⚠ **`packages/client` CANNOT do this itself, and that is why the route
// exists.** Auth.js runs in the web container, which holds no database
// credential (the same reason `platform_users` is written from `resolveIdentity`
// rather than from a NextAuth callback). Its `authorize()` therefore calls this
// with `PARENT_API_KEY`, server-side, exactly as the proxy route does.
import { superAdminHere, isOwnAdmin, isRestricted } from "../services/workspace-restriction.service.js";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity } from "../middleware/identity.middleware.js";
import { authFailureThrottleInstance } from "../middleware/auth.middleware.js";
import { localUserService } from "../services/local-user.service.js";
import { grantSchema, workspaceMemberService } from "../services/workspace-member.service.js";
import { actorOf } from "../middleware/identity.middleware.js";
import { config } from "../config/index.js";

export const localUsersRouter = Router();
export const localAuthRouter = Router();

/**
 * ⚠ **`requireSuperAdmin` REMOVED — the per-route platform permission decides now.**
 *
 * This router was `requireIdentity + requireSuperAdmin` for every handler, which made
 * "manage local accounts" and "put somebody in a workspace" the same authority: the
 * allowlist. They are now two permissions, spliced per route from
 * `auth/route-permissions.ts`:
 *
 *   - the six account-lifecycle handlers → `platform.localusers.write`
 *   - `GET /:id/access`                  → `platform.users.read`
 *   - `PUT|DELETE /:id/access/:workspaceId` → **`platform.members.grant`**
 *
 * ⚠ **Keeping `requireSuperAdmin` here would have made every one of them AND**, which is
 * narrower than before and would refuse a platform administrator at the two routes D-9
 * exists to make reachable. An allowlist holder still passes everywhere, because
 * `config.isSuperAdmin` short-circuits the resolver to the entire platform catalogue.
 *
 * ⚠ **The two `/access/` routes are the counter-example to FR-024** — deployment-level
 * routes that carry a `:workspaceId`. They are NOT workspace-scoped: the permission is
 * `platform.members.grant`, held on the deployment, and the guard takes its parameter
 * name explicitly precisely so scope is never inferred from a parameter being present.
 */
localUsersRouter.use(requireIdentity);

localUsersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({ users: await localUserService.list() });
  }),
);

/**
 * ⚠ `.strict()`, and there is deliberately no `role`, no `superAdmin` and no
 * `subject` field. An unknown key is a 400 rather than a silent drop: a caller
 * who sends `{"superAdmin": true}` must learn that the field does not exist,
 * not watch it be ignored and assume it worked. `subject` is issued by the
 * service from the row's uuid — accepting one would let a caller point a new
 * account at an existing person's `workspace_members` rows.
 */
const createSchema = z
  .object({
    username: z.string().min(1).max(128),
    password: z.string().min(1).max(1024),
    email: z.string().max(320).optional(),
    name: z.string().max(255).optional(),
  })
  .strict();

localUsersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);
    const user = await localUserService.create({
      ...input,
      /**
       * ⚠ **`req.user.subject`, NOT `actorOf(req)`** — `actorOf` returns
       * `email || subject`, and this column is documented and read as a
       * subject. Storing an email under that name is the `flowId` hazard again:
       * one field, two meanings, and the wrong one wins wherever somebody
       * compares it to a `workspace_members.subject`.
       *
       * ⚠ The SUBJECT from the verified token — never a body field.
       * `authorOf`'s rule: a body-supplied author is refused everywhere in this
       * product, and this is attribution of who created an account.
       *
       * ⚠ **`.strict()` above is what ENFORCES that, not this line.** Perturbing
       * this to read `req.body.createdBy` reddens nothing, because the schema
       * refuses the field before the handler runs — so a reader checking the
       * rule must look at the schema. `local-users.test.ts` puts `createdBy` in
       * its unknown-field list for exactly this reason.
       */
      createdBy: req.user?.subject ?? null,
    });
    res.status(201).json({ user });
  }),
);

const passwordSchema = z.object({ password: z.string().min(1).max(1024) }).strict();

localUsersRouter.post(
  "/:id/password",
  asyncHandler(async (req, res) => {
    const { password } = passwordSchema.parse(req.body);
    await localUserService.setPassword(req.params.id!, password);
    // ⚠ No body. There is nothing safe to echo from a password change, and a
    // route that returns the account invites a client to render "password:" from
    // a field that happens to be absent today.
    res.status(204).end();
  }),
);

/**
 * ⚠ `.strict()`, and still no `role`, no `superAdmin` and no `subject`. An EDIT
 * is the other half of the create control: a rename that could set an
 * allowlisted email would make "local accounts are workspace-scoped" one
 * rename away from nothing, which is why `update` carries the same refusal.
 */
const updateSchema = z
  .object({
    username: z.string().min(1).max(128).optional(),
    // ⚠ `nullable`, so clearing an address is expressible. `optional` alone
    // cannot say "remove this" — only "leave it alone".
    email: z.string().max(320).nullable().optional(),
    name: z.string().max(255).nullable().optional(),
  })
  .strict();

localUsersRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const input = updateSchema.parse(req.body);
    res.json({ user: await localUserService.update(req.params.id!, input) });
  }),
);

/**
 * ⚠ **DELETE IS PERMANENT AND FREES THE USERNAME, which is why "turn off"
 * exists beside it and is the safer action.** The subject is derived from this
 * row's id, so deleting leaves any `workspace_members` rows keyed on it
 * pointing at nobody — and a NEW account can then take the same username with
 * a different id, so the old rows do NOT follow it. That is the honest outcome
 * and the panel says so before asking.
 */
localUsersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json({ user: await localUserService.remove(req.params.id!) });
  }),
);

const activeSchema = z.object({ isActive: z.boolean() }).strict();

localUsersRouter.post(
  "/:id/active",
  asyncHandler(async (req, res) => {
    const { isActive } = activeSchema.parse(req.body);
    res.json({ user: await localUserService.setActive(req.params.id!, isActive) });
  }),
);

/**
 * ── Workspace access, for ONE local account, from the page that created it ──
 *
 * ⚠ **THE GAP THIS CLOSES.** `POST /api/workspaces/:ws/members` takes a
 * client-supplied `subject` and `email`, and `MembersPanel` offers a picker
 * built from `platform_users` — *identities this API has SEEN*. A local account
 * that has never signed in is in no such list, so granting it access meant
 * copying `local:<uuid>` out of the accounts panel and pasting it into a
 * free-text field in a different panel. And if the account had no email, the
 * grant was **refused outright**: `grantSchema` validates with zod's
 * `.email()`, which rejects the `<username>@local` form. So the product could
 * create an account it could not give access to.
 *
 * ⚠ **THE CLIENT NAMES AN ACCOUNT AND A WORKSPACE, NEVER A SUBJECT.** The
 * subject and the email are derived server-side from the `local_users` row.
 * That is deliberately STRONGER than the members route it delegates to: there
 * is no field here in which a caller could name somebody else's subject and
 * attach a new account to an existing person's memberships — the same reason
 * `createSchema` above refuses a `subject`.
 *
 * ⚠ **NO SECOND WRITER.** `workspaceMemberService.grant` / `.revoke` hold the
 * subject-keying, the insert-vs-update branch and the last-admin refusal.
 * Reimplementing any of that here would be a second place for it to disagree —
 * `members.ts` says the same thing about why there is no `assign()`.
 */

/**
 * Which workspaces this one local account can act in.
 *
 * ⚠ **This is NOT the cross-workspace member listing `members.ts` refuses to
 * build, and the difference is worth stating rather than assuming.** That rule
 * (D-27's reasoning) forbids a view of *the people who work on each tenant's
 * automations*, assembled from rows nobody meant to publish together. This
 * answers the inverted, single-subject question — *what can THIS account do* —
 * for one account that exists only on this deployment, asked by the super admin
 * who created it, who can already list every workspace and read each one's
 * members. It returns no other person's row: the filter is the account's own
 * derived subject, and there is no parameter that could widen it.
 *
 * ⚠ It is scoped to LOCAL accounts by construction — the subject comes from a
 * `local_users` row — so it cannot be pointed at an Entra identity.
 */
localUsersRouter.get(
  "/:id/access",
  asyncHandler(async (req, res) => {
    const user = await localUserService.byId(req.params.id!);
    res.json({ access: await localUserService.accessFor(user.subject) });
  }),
);

const accessSchema = z.object({ role: z.enum(workspaceMemberService.ROLES) }).strict();

/**
 * Grant this account a role in one workspace, or change the role it holds.
 *
 * A PUT rather than a POST: naming the (account, workspace) pair in the path
 * makes it idempotent, and `grant` already updates an existing row rather than
 * inserting a second one — so the verb matches what the service does.
 */
localUsersRouter.put(
  "/:id/access/:workspaceId",
  asyncHandler(async (req, res) => {
    if (await closedTo(req.user, req.params.workspaceId!)) return refuseRestricted(res);
    const { role } = accessSchema.parse(req.body);
    const user = await localUserService.byId(req.params.id!);
    /**
     * ⚠ Derived from the verified identity, exactly as `members.ts` does, and
     * NOT hardcoded `true` — this router is `requireSuperAdmin` today, so the
     * value is necessarily true, and writing the literal would leave the
     * last-admin exemption silently in place if that guard were ever relaxed.
     */
    /**
     * ⚠ **Parsed through `grantSchema` — the SAME schema the members route
     * applies to a client-supplied body.** The values are derived here, so it is
     * tempting to skip it; that would leave this the one write to
     * `workspace_members` whose subject and email nothing validates, and
     * `membershipEmail`'s sanitising would have no check behind it. A derived
     * value is held to the standard a typed one is.
     */
    const input = grantSchema.parse({
      subject: user.subject,
      email: localUserService.membershipEmail(user),
      role,
    });
    const member = await workspaceMemberService.grant(
      req.params.workspaceId!,
      input,
      actorOf(req),
      { bySuperAdmin: await superAdminHere(req.user, req.params.workspaceId!) },
    );
    res.json({ member });
  }),
);

/**
 * Take this account's access to one workspace away.
 *
 * ⚠ A 404 when there was no such membership, never a cheerful 200. "There was
 * nothing to remove" and "removed" are different answers, and a screen that
 * cannot tell them apart reports success for a revoke that found nothing —
 * which is the direction that matters here.
 */
localUsersRouter.delete(
  "/:id/access/:workspaceId",
  asyncHandler(async (req, res) => {
    if (await closedTo(req.user, req.params.workspaceId!)) return refuseRestricted(res);
    const user = await localUserService.byId(req.params.id!);
    const removed = await workspaceMemberService.revoke(req.params.workspaceId!, user.subject, {
      bySuperAdmin: await superAdminHere(req.user, req.params.workspaceId!),
    });
    if (!removed) {
      return res.status(404).json({ error: "not_found", message: "this account has no access to that workspace" });
    }
    res.json({ removed: true });
  }),
);

const verifySchema = z.object({ username: z.string().min(1).max(128), password: z.string().min(1).max(1024) }).strict();

/**
 * The sign-in check, called by `packages/client`'s credentials provider.
 *
 * ⚠ **A FAILURE IS A 401 WITH NO DETAIL, and every failure is the same 401.**
 * "No such account", "wrong password" and "deactivated" are one answer, because
 * three answers let anybody holding the key enumerate accounts. The service
 * does the scrypt work even on a miss so the response TIME does not leak it
 * either.
 *
 * ⚠ **It is throttled on the SHARED auth throttle**, so attempts here count
 * toward the same per-IP budget as a bad API key or a bad identity token — one
 * budget for "this caller keeps failing to authenticate", rather than a fresh
 * 20 attempts per mechanism.
 */
localAuthRouter.post(
  "/verify",
  asyncHandler(async (req, res) => {
    const ip = req.ip ?? "unknown";
    if (authFailureThrottleInstance.isThrottled(ip)) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "rate_limited", retryAfterSeconds: 60 });
      return;
    }
    const { username, password } = verifySchema.parse(req.body);
    const user = await localUserService.verify(username, password);
    if (!user) {
      authFailureThrottleInstance.recordFailure(ip);
      // ⚠ The username is logged and the password is NOT, ever — the same rule
      // the auth middleware follows for a presented credential.
      console.warn(`[local-auth] failed sign-in for "${username}" from ${ip}`);
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }
    res.json({ user });
  }),
);

/**
 * A RESTRICTED workspace is its own admins' to fill (restricted-workspaces): this platform route puts a local account
 * into any workspace, so it refuses one that is restricted unless the caller is one of its own admins.
 */
async function closedTo(user: Request["user"], ws: string): Promise<boolean> {
  return (await isRestricted(ws)) && !(await isOwnAdmin(user, ws));
}
function refuseRestricted(res: Response) {
  res.status(403).json({ error: "restricted", message: "That workspace is restricted: only its own admins add people to it." });
}
