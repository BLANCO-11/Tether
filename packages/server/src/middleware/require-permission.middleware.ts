import type { Request, Response, NextFunction } from "express";
import { asyncHandler, withResponseBody } from "./error.middleware.js";
import {
  effectivePermissionsService,
  PlatformRoleCache,
} from "../services/effective-permissions.service.js";
import type { WorkspacePermission } from "../auth/permissions.js";
import { accessAuditService } from "../services/access-audit.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RefusalReason =
  | "missing_permission"
  | "not_a_member"
  | "workspace_unconfigured"
  | "deployment_unconfigured"
  | "role_exceeds_granter"
  | "unattested_revision";

export interface RefusalBody {
  error: "forbidden" | "unauthenticated" | "misconfigured";
  reason: RefusalReason | "no_identity" | "wiring";
  message: string;
  permission?: string;
  requestId?: string;
}

/**
 * Reuse one `PlatformRoleCache` for the life of a request.
 *
 * ⚠ **Per request, never per process.** The platform read is keyed on subject alone, so
 * one request that touches several workspaces asks the same question several times — but
 * a process-level cache would keep answering with a revoked role until it expired, and a
 * stale *authorisation* answer that survives a revocation is the failure mode that
 * actually matters here.
 */
function cacheFor(req: Request): PlatformRoleCache {
  const holder = req as Request & { _rbacCache?: PlatformRoleCache };
  return (holder._rbacCache ??= new PlatformRoleCache());
}

/**
 * Refuse a request that does not carry `permission` in the workspace it names.
 *
 * ## ⚠ THREE OUTCOMES, AND THE THIRD IS NOT A REFUSAL
 *
 *  - **401** when no person is named. The API key authorises the *request*; it does not
 *    name a person, and a workspace permission is a question about a person.
 *  - **403** when a person is named and is not permitted.
 *  - **500** when the guard is mounted where its workspace parameter is not in scope.
 *
 * FR-022 requires the first two to be distinguishable: one shared 403 sends somebody to
 * check their session when the answer is that they need a grant, and those are two
 * different people's problems with two different fixes.
 *
 * FR-024 is the third. ⚠ **A guard that cannot decide MUST NOT PASS.** Mounted on a route
 * with no workspace in scope it has no question to answer, and the tempting behaviour —
 * "no workspace, so nothing to check, call `next()`" — turns the guard off exactly where
 * somebody wired it wrongly, which is exactly where you want to hear about it. It is a
 * wiring bug, it is a 500, and it says so. `requireWorkspaceRole` and
 * `requireProvenanceAuthority` already behave this way; this is the same rule.
 *
 * ## ⚠ NOTHING IN THE REQUEST CAN WIDEN THE ANSWER
 *
 * FR-023. The permission is baked in by the caller of this factory at boot. The
 * workspace comes from a **route parameter**, never from a body, a query string or a
 * header. There is no `?permission=`, no override field and no escape hatch — which is
 * the same rule `approveSchema.strict()` enforces for self-approval and the same reason
 * `verifyVia` is a function argument rather than a field on a schema.
 *
 * ## ⚠ The workspace parameter is NAMED, never inferred
 *
 * Most routes carry `:workspaceId`, but `GET /api/workspaces/:id` carries `:id`, and
 * `PUT /api/local-users/:id/access/:workspaceId` is a **deployment-level** route that
 * carries a `:workspaceId` and must NOT be treated as workspace-scoped. So the parameter
 * name is an explicit argument and scope is never inferred from the presence of a
 * parameter.
 */
export function requirePermission(
  permission: WorkspacePermission,
  opts: { param?: string } = {},
) {
  const param = opts.param ?? "workspaceId";

  const guard = asyncHandler(async function permissionGuard(
    req: Request,
    _res: Response,
    next: NextFunction,
  ) {
    const workspaceId = req.params[param];

    // FR-024 — a wiring defect, never a pass.
    if (!workspaceId) {
      return next(
        refusal(req, 500, {
          error: "misconfigured",
          reason: "wiring",
          message:
            `requirePermission("${permission}") was mounted on a route with no :${param} ` +
            `parameter, so it cannot decide anything. This is a wiring bug, not a permission ` +
            `failure.`,
          permission,
        }),
      );
    }

    if (!UUID_RE.test(workspaceId)) {
      return next(httpStatus(`"${workspaceId}" is not a workspace id.`, 400));
    }

    // ⚠ The whole identity, not `req.user?.subject`. The member lookup is keyed on
    // subject, but the super-admin allowlist matches subject OR email — and passing only
    // the subject is exactly the bug that made a correctly configured
    // `SUPER_ADMIN_EMAILS` grant nothing to an Entra sign-in, whose subject is an OID.
    if (!req.user?.subject) {
      return next(
        refusal(req, 401, {
          error: "unauthenticated",
          reason: "no_identity",
          message:
            "this action is authorised per workspace, so it needs a signed-in user. The API " +
            "key authorises the request; it does not name a person.",
          permission,
        }),
      );
    }

    const eff = await effectivePermissionsService.forWorkspace(
      req.user,
      workspaceId,
      cacheFor(req),
    );
    if (eff.permissions.includes(permission)) return next();

    // ⚠ Two reasons, because they send the reader to two different places: somebody with
    // no standing at all in this workspace needs to be added to it, and somebody who is
    // a member needs this one permission. A single "forbidden" makes the first person
    // ask for the wrong thing.
    const reason: RefusalReason = eff.permissions.length === 0 ? "not_a_member" : "missing_permission";

    /**
     * ⚠ **RECORD THE REFUSAL — AND THIS CALL IS THE WHOLE POINT OF T094.**
     *
     * `accessAuditService` had a correct, tested denial recorder that **nothing called**.
     * That is I-120 exactly: a value computed and discarded, where the check passes its
     * own tests and no behaviour anywhere depends on the answer, so nothing notices when
     * it stops being true. The detector's own tests cannot close that gap — only a call
     * site can, and `access-audit-wired.test.ts` reads this file off disk to require it.
     *
     * ⚠ **Unawaited, and it cannot throw.** Bookkeeping on the path of an authorisation
     * check must not add latency to a refusal or turn one into a 500. Same posture as the
     * `platform_users` write, for the same reason.
     */
    void accessAuditService.recordDenial({
      workspaceId,
      actor: req.user.subject,
      actorEmail: req.user.email ?? null,
      permission,
      // ⚠ The DECLARED path, never `req.originalUrl` — that carries resolved ids and
      // query strings, which is request content and is not ours to keep (FR-034).
      route: `${req.method} ${req.route?.path ?? "(unknown)"}`,
    });

    // ⚠ FR-021 — the message NEVER names who does hold it. A 403 is the last place to
    // publish the list of accounts worth attacking; `requireSuperAdmin` already has this
    // rule and this is the same one.
    return next(
      refusal(req, 403, {
        error: "forbidden",
        reason,
        message:
          reason === "not_a_member"
            ? `you do not have access to this workspace. An administrator of it can add you.`
            : `this action needs the "${permission}" permission, which you do not have in this ` +
              `workspace. An administrator of it can grant it.`,
        permission,
      }),
    );
  });

  // ⚠ **TAG THE GUARD, because its NAME does not survive `asyncHandler`.**
  //
  // `asyncHandler` returns an anonymous arrow, so the inner `permissionGuard` name is
  // gone by the time the handler reaches Express's layer stack — which is exactly why a
  // stack walk cannot see `requireWorkspaceRole` either: every one of them shows up
  // nameless. A mount assertion written against the function NAME would therefore find
  // nothing and pass over an empty set, which is the I-38 shape this feature keeps
  // running into.
  //
  // The marker is read by `mountedRoutes`, so the mount assertion can check not merely
  // that A guard is present but that the guard mounted on each route declares the SAME
  // permission the map does. Presence alone would be satisfied by every route carrying
  // the same wrong guard.
  Object.defineProperty(guard, "name", { value: "permissionGuard", configurable: true });
  Object.defineProperty(guard, RBAC_GUARD, {
    value: { permission, param },
    enumerable: false,
  });
  return guard;
}

/** Marker key for a mounted `requirePermission`. Read by `mountedRoutes`. */
export const RBAC_GUARD = Symbol.for("foundry.rbac.guard");

export interface RbacGuardMarker {
  permission: WorkspacePermission;
  param: string;
}

/** The permission a mounted handler declares, or undefined if it is not our guard. */
export function guardMarker(handler: unknown): RbacGuardMarker | undefined {
  if (typeof handler !== "function") return undefined;
  return (handler as unknown as Record<symbol, RbacGuardMarker | undefined>)[RBAC_GUARD];
}

/** The refusal envelope from contracts/api.md §E, carried on the error for the handler. */
function refusal(req: Request, status: number, body: Omit<RefusalBody, "requestId">) {
  const err = new Error(body.message) as Error & { statusCode: number };
  err.statusCode = status;
  // ⚠ Symbol-keyed, NOT `err.expose` — `http-errors` already owns that name as a
  // boolean, and spreading `true` silently erased the error field of every 4xx that
  // passed through. See `RESPONSE_BODY`.
  return withResponseBody(err, { ...body, requestId: (req as Request & { id?: string }).id });
}

function httpStatus(message: string, status: number) {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = status;
  return err;
}
