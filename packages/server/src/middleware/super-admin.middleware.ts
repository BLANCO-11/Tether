import type { NextFunction, Request, Response } from "express";
import { config } from "../config/index.js";

/**
 * A gate for actions that belong to whoever runs the DEPLOYMENT.
 * `specs/20260820-193547-superadmin-workspace-assignment/` · D-4
 *
 * ── What it guards, and why these routes and not others ─────────────────────
 *
 * Workspace lifecycle (create / rename / delete) and workspace **membership**
 * writes. Both were reachable by anyone who could sign in: workspace CRUD had
 * no gate at all, and membership was `requireWorkspaceRole("admin")` — which is
 * a real check, but its bootstrap was `POST …/members/claim`, where the first
 * signed-in caller made themselves the admin of any unclaimed workspace. So the
 * effective answer to *"who may decide who works on what"* was *"whoever asked
 * first"*. This is that answer replaced.
 *
 * ── Why an env allowlist rather than a role table ───────────────────────────
 *
 * ⚠ **The point is that it cannot be granted from inside the product.** Every
 * other authority here is a row somebody with that authority can write, so a
 * table would mean the person being handed workspace assignment could also hand
 * out the power to assign. `SUPER_ADMIN_EMAILS` is read from the API server's
 * environment, so escalating to it means having the deployment, not having the
 * screen. `requireDeploymentAdmin`'s option (c) — a real deployment-role table
 * (⚠ that middleware is now DELETED; the table exists and the guard is
 * `requirePlatformPermission`)
 * — is still the answer if this ever needs to be delegated per tenant.
 *
 * ── Why NOT a fourth value on `requireWorkspaceRole` ────────────────────────
 *
 * The same reason `deployment-admin.middleware.ts` gives for itself, and it is
 * worth repeating because the instinct to merge them is strong.
 * `requireWorkspaceRole` answers *"may this person act IN this workspace"* and
 * treats a missing `:workspaceId` as a **500 wiring bug** — correctly, because
 * for every route it guards, a missing workspace means it was mounted wrong.
 * This question has no workspace in it (`POST /api/workspaces` creates one), so
 * teaching that guard a mode where the absence is legitimate would delete its
 * wiring check for every caller. Two questions, two guards.
 *
 * ── ⚠ What this is NOT ──────────────────────────────────────────────────────
 *
 * Not separation of duties, and not proof of identity (I-13). Anything holding
 * `RUNTIME_JWT_SECRET` mints any identity, and a minted identity whose email is
 * in the allowlist is a super admin. The claim that holds is: *a person whose
 * subject or email the API server was not configured with cannot create a
 * workspace or decide its membership.* Nothing stronger.
 *
 * It is also an ACCESS grant only. A super admin is subject to every
 * accountability gate downstream — the self-approval refusal, the run-requester
 * refusal, provenance escalation — exactly like anybody else.
 */
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    // `requireIdentity` is mounted alongside and normally answers first. Kept so
    // this guard cannot silently allow a request it could not evaluate if it is
    // ever mounted alone — the worst possible failure for an authorisation
    // check, and one that looks exactly like a passing route.
    return next(
      httpError(
        "this action is restricted to a super admin, so it needs a signed-in user. The API key " +
          "authorises the request; it does not name a person.",
        401,
      ),
    );
  }

  if (config.isSuperAdmin(req.user)) return next();

  /**
   * ⚠ **Two refusals, because they need two different actions**, and this is
   * the same distinction `requirePlatformPermission` draws and `check` now forks
   * on. Somebody is configured ⇒ ask them. Nobody is ⇒ the deployment is
   * unconfigured and the fix is an environment variable, which the message has
   * to name or the screen reads as broken rather than as unfinished.
   *
   * ⚠ Neither message lists WHO the super admins are. The allowlist is
   * deployment configuration, and a 403 is the last place to publish a list of
   * the accounts worth attacking.
   */
  return next(
    httpError(
      config.superAdminConfigured
        ? "creating workspaces and deciding who works in them is restricted to a super admin on " +
            "this deployment, and you are not one. Ask whoever administers it."
        : "this deployment has no super admin configured, so nobody is authorised to create " +
            "workspaces or assign members. Set SUPER_ADMIN_EMAILS on the API server — a " +
            "comma-separated list of identity subjects or emails — and restart it. It is refused " +
            "rather than allowed on purpose: a check that passes when unconfigured passes " +
            "everywhere it was never set up.",
      403,
    ),
  );
}

function httpError(message: string, status: number): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = status;
  return e;
}
