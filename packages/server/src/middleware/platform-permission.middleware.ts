import type { Request, Response, NextFunction } from "express";
import { asyncHandler, withResponseBody } from "./error.middleware.js";
import { effectivePermissionsService } from "../services/effective-permissions.service.js";
import { config } from "../config/index.js";
import type { PlatformPermission } from "../auth/permissions.js";
import { accessAuditService } from "../services/access-audit.service.js";

/** Marker so `mountedRoutes` can see which platform guard a route carries. */
export const PLATFORM_GUARD = Symbol.for("foundry.rbac.platformGuard");

export interface PlatformGuardMarker {
  permission: PlatformPermission;
}

export function platformGuardMarker(handler: unknown): PlatformGuardMarker | undefined {
  if (typeof handler !== "function") return undefined;
  return (handler as unknown as Record<symbol, PlatformGuardMarker | undefined>)[PLATFORM_GUARD];
}

/**
 * Require a DEPLOYMENT-LEVEL permission — no workspace in the question.
 *
 * ## ⚠ This replaces `requireDeploymentAdmin`, which was satisfied by being an admin in ANY workspace
 *
 * That is the whole reason this tier exists. Under the old guard, one tenant's
 * administrator could change a deployment-wide setting — the generation model, for
 * instance — because holding `admin` somewhere was read as holding authority everywhere.
 * `deployment-admin.middleware.ts` is DELETED in the same change that adds this, and the
 * deletion is the point: leaving it importable leaves two answers to "who may change a
 * deployment setting", and the weaker one takes no argument to satisfy.
 *
 * ## ⚠ TWO REFUSALS, TWO ACTIONS (FR-022)
 *
 * Not politeness — they send the reader somewhere different:
 *
 *  - **401** no person is named. The API key authorises the request; it does not name
 *    anybody, and a platform permission is a question about a person.
 *  - **403, allowlist EMPTY** → *"set `SUPER_ADMIN_EMAILS`"*. Nobody can grant this,
 *    because with no platform-role assignment anywhere and no allowlist there is no
 *    authority on the deployment at all. The fix is an environment variable.
 *  - **403, allowlist SET** → *"ask a platform administrator"*. The fix is a person.
 *
 * This is the same fork `requireSuperAdmin` already makes, and the same reason
 * `config.superAdminConfigured` exists.
 *
 * ⚠ **Bootstrap**: with no assignment anywhere, only an allowlist holder passes — because
 * `config.isSuperAdmin` short-circuits the resolver to every platform permission. That is
 * what stops a fresh deployment being un-administrable, and it is the same short-circuit
 * that keeps a memberless workspace assignable.
 *
 * ## ⚠ THIS IS NOT separation of duties, AND IT NEVER WILL BE
 *
 * Anything holding `RUNTIME_JWT_SECRET` can mint an identity, and a minted identity with
 * a `platform_role_assignments` row is a platform administrator. I-13's rule, and it
 * applies to every authorisation check in this product. The sentence to use is *"a person
 * who has not been granted this permission cannot do this"* — never the unqualified
 * claim.
 *
 * ⚠ And the one this tier is most likely to be misdescribed with, from D-9: **a platform
 * administrator cannot see a tenant's data, but CAN give themselves the ability to, and
 * doing so leaves an audit entry naming them.** Never *"a platform admin cannot access
 * tenant data"*, which is false.
 *
 * ⚠ **WHAT CHANGED FROM `requireDeploymentAdmin`: IT IS NO LONGER DELIBERATELY COARSE.**
 * That guard's own docblock called itself coarse and meant it — "admin in ANY workspace"
 * was an approximation standing in for a tier that did not exist. This one asks for a
 * named permission held on the deployment, so one tenant's administrator holds nothing
 * here at all.
 */
export function requirePlatformPermission(permission: PlatformPermission) {
  const guard = asyncHandler(async function platformGuard(
    req: Request,
    _res: Response,
    next: NextFunction,
  ) {
    if (!req.user?.subject) {
      return next(
        refusal(req, 401, {
          error: "unauthenticated",
          reason: "no_identity",
          message:
            "this is a deployment-level action, so it needs a signed-in user. The API key " +
            "authorises the request; it does not name a person.",
          permission,
        }),
      );
    }

    if (await effectivePermissionsService.hasPlatform(req.user, permission)) return next();

    /**
     * ⚠ Same as the workspace guard: the recorder existed and nothing called it (I-120).
     * `workspaceId: null` routes it to the platform audit store — a deployment-level
     * refusal has no workspace to belong to.
     */
    void accessAuditService.recordDenial({
      workspaceId: null,
      actor: req.user.subject,
      actorEmail: req.user.email ?? null,
      permission,
      route: `${req.method} ${req.route?.path ?? "(unknown)"}`,
    });

    return next(
      refusal(req, 403, {
        error: "forbidden",
        reason: config.superAdminConfigured ? "missing_permission" : "deployment_unconfigured",
        message: config.superAdminConfigured
          ? `this action needs the "${permission}" permission on this deployment, which you ` +
            `do not have. A platform administrator can grant it.`
          : `this action needs the "${permission}" permission on this deployment, and this ` +
            `deployment has no super admin configured, so nobody can grant it yet. Set ` +
            `SUPER_ADMIN_EMAILS on the API server (identity subject or email, ` +
            `comma-separated) and that person can assign platform roles.`,
        permission,
      }),
    );
  });

  Object.defineProperty(guard, "name", { value: "platformGuard", configurable: true });
  Object.defineProperty(guard, PLATFORM_GUARD, { value: { permission }, enumerable: false });
  return guard;
}

function refusal(req: Request, status: number, body: Record<string, unknown>) {
  const err = Object.assign(new Error(String(body.message)), { statusCode: status });
  return withResponseBody(err, { ...body, requestId: (req as Request & { id?: string }).id });
}
