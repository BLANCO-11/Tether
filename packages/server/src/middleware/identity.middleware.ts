import type { Request, Response, NextFunction } from "express";
import { jwtVerify, errors as joseErrors } from "jose";
import { config } from "../config/index.js";
import { asyncHandler } from "./error.middleware.js";
import { authFailureRule, authFailureThrottleInstance } from "./auth.middleware.js";
import { platformUserService } from "../services/platform-user.service.js";
import { personMergeService } from "../services/person-merge.service.js";
import {
  systemAuthor,
  SYSTEM_AUTHOR_NAME,
  type RevisionAuthor,
} from "../services/revision-author.js";

/**
 * Who is making this request — Stage 9.1.
 * DECISIONS.md D-39 · ISSUES.md I-32
 *
 * ── The problem this ends ────────────────────────────────────────────────────
 *
 * `lib/auth.tsx` is Auth.js with a real signed-in user, and the Next proxy built
 * exactly one header — `x-api-key` — and threw the rest away. **The browser knew
 * who you were and the API never did.** So gate 2 took `approverUserId` from the
 * request body and gate 3 took `decidedBy` from the request body; both recorded
 * a name, neither could verify one (I-13). A demo where "a human approved this"
 * is self-asserted is fine. A product where it is, is not.
 *
 * ── Verified, and precisely how far ──────────────────────────────────────────
 *
 * The client already minted an HS256 token at sign-in — `src/auth.ts`, the
 * `backendToken` — and nothing consumed it. The proxy now forwards it as
 * `x-foundry-identity` and this verifies the signature against a **second
 * secret** that is not `PARENT_API_KEY`.
 *
 * That is a real narrowing and should be described exactly: **holding the API
 * key no longer lets you name a person.** It is not proof that a browser sent
 * the request — anything holding `RUNTIME_JWT_SECRET` can mint a token, and
 * `e2e:ui` deliberately does. Two secrets instead of one, and the person-naming
 * one is held by the sign-in flow. Say that, not "authenticated user".
 *
 * ── Two rules, and the second is the one that would rot quietly ──────────────
 *
 *  1. **Identity is resolved everywhere and required per ROUTE.** The same
 *     `PARENT_API_KEY` authenticates Kestra's step callbacks and every `kestra:*`
 *     harness; a blanket requirement breaks the engine. The routes that need it
 *     are the ones that record a person.
 *  2. **A token that is PRESENT and invalid is a 401 — never ignored.** The
 *     tempting version treats a bad token as no token and carries on under the
 *     API key. Then an expired session records an approval attributed to nobody,
 *     which is worse than the state before this middleware existed: the field
 *     now looks verified.
 */

/** A person, as this server is willing to name them. */
export interface FoundryIdentity {
  /** The token's `sub` — Entra OID, or `local-admin`. Stable across renames. */
  subject: string;
  /** What gets recorded. Empty only if the token carried none. */
  email: string;
  name?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: FoundryIdentity;
    }
  }
}

export const IDENTITY_HEADER = "x-foundry-identity";

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = statusCode;
  return e;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let keyCache: Uint8Array | null = null;
function signingKey(): Uint8Array {
  if (!keyCache) keyCache = new TextEncoder().encode(config.identity.secret);
  return keyCache;
}

/**
 * FR-007 (research.md Decision 5) — shares `auth.middleware.ts`'s instance
 * so a caller's failures against either check count toward one throttle,
 * keyed on the same IP. Never called from the `identity_unavailable` (500)
 * branch — that is a deployment misconfiguration, not a caller's failure.
 */
function recordAndCheckIdentityThrottle(req: Request, res: Response): boolean {
  authFailureThrottleInstance.recordFailure(req.ip ?? "unknown");
  console.warn(`[identity] failure from ${req.ip}`, { path: req.path, at: new Date().toISOString() });
  if (authFailureThrottleInstance.isThrottled(req.ip ?? "unknown")) {
    res.setHeader("Retry-After", String(Math.ceil(authFailureRule.windowMs / 1000)));
    res
      .status(429)
      .json({ error: "rate_limited", retryAfterSeconds: Math.ceil(authFailureRule.windowMs / 1000) });
    return true;
  }
  return false;
}

/**
 * Attach `req.user` when a valid identity token is presented.
 *
 * Mounted once, before the routers. Most routes ignore it; the ones that record
 * a person read it and nothing else.
 */
export const resolveIdentity = asyncHandler(async function resolveIdentity(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const raw = req.header(IDENTITY_HEADER);
  if (!raw) return next();

  if (!config.identity.secret) {
    // Presented a token to a server that cannot check one. Refusing is the only
    // honest answer: accepting it unverified is the failure mode this file
    // exists to remove, and dropping it silently would record the request as
    // anonymous while the caller believes it is attributed.
    return res.status(500).json({
      error: "identity_unavailable",
      message:
        "an identity token was presented but this server has no RUNTIME_JWT_SECRET configured, " +
        "so it cannot verify one",
    });
  }

  try {
    const { payload } = await jwtVerify(raw, signingKey(), {
      // Pinned. Never read the algorithm from the token — that is how `alg: none`
      // and HS/RS confusion get in.
      algorithms: ["HS256"],
    });
    req.user = {
      subject: String(payload.sub ?? ""),
      email: typeof payload.email === "string" ? payload.email : "",
      ...(typeof payload.name === "string" && payload.name ? { name: payload.name } : {}),
    };
    if (!req.user.email && !req.user.subject) {
      if (recordAndCheckIdentityThrottle(req, res)) return;
      return res.status(401).json({
        error: "identity_invalid",
        message: "the identity token carries neither a subject nor an email",
      });
    }
    /**
     * Record that we saw this person — `services/platform-user.service.ts`.
     *
     * ⚠ **After the verify and after the emptiness refusal, never before.** This
     * is the list a super admin assigns workspace access from, so a row in it
     * must mean a token that actually verified; writing before the check would
     * let anyone populate it by presenting garbage.
     *
     * ⚠ **Not awaited, and it cannot throw** (the service swallows and logs).
     * This runs on every authenticated request, including every authorisation
     * check, and bookkeeping must not be able to add latency to one or turn one
     * into a 500.
     */
    void platformUserService.seen(req.user);
    /**
     * ⚠ **AWAITED, unlike the line above, and that is the point.** Access given to this person under their email
     * address becomes theirs before this request is authorised, so it applies on the very first page after sign-in
     * (admin simplify, phase 1). It runs once per person per process and cannot throw.
     */
    await personMergeService.onFirstSight(req.user);
    return next();
  } catch (e) {
    if (recordAndCheckIdentityThrottle(req, res)) return;
    const expired = e instanceof joseErrors.JWTExpired;
    return res.status(401).json({
      error: expired ? "identity_expired" : "identity_invalid",
      message: expired
        ? "your session has expired — sign in again"
        : `the identity token could not be verified: ${(e as Error).message}`,
    });
  }
});

/**
 * This route records a person, so it needs one.
 *
 * Per route, never global — see rule 1 above. Applied to approvals, revocations
 * and step decisions: everything that writes a name into a record somebody will
 * later be asked to trust.
 */
export function requireIdentity(req: Request, _res: Response, next: NextFunction) {
  if (!config.identity.secret) {
    // A configuration failure, not an authentication one, and the status says so.
    // A 401 here would send someone to look at their session.
    return next(
      httpError(
        "this route records who acted, and this server has no RUNTIME_JWT_SECRET configured to " +
          "verify an identity with. Set it to the same value the sign-in flow signs with.",
        503,
      ),
    );
  }
  if (!req.user) {
    return next(
      httpError(
        `this action records who performed it, so it requires a signed-in user. Present a ` +
          `verified identity in the "${IDENTITY_HEADER}" header — the API key authorises the ` +
          `request but cannot say who is making it.`,
        401,
      ),
    );
  }
  next();
}

/** What gets written into an audit field. Email by preference; subject when there is none. */
export function actorOf(req: Request): string {
  return req.user?.email || req.user?.subject || "";
}

/**
 * Who to record as the AUTHOR of a revision — **and whether anybody checked.**
 * archive/GAPS.md §1.2 · ISSUES.md I-32 · `services/revision-author.ts`
 *
 * Weaker than `requireIdentity` on purpose, and the asymmetry is the decision:
 * approving is always a person, but a revision is written by people, by
 * harnesses, by the drafter and by an import. Requiring an identity here would
 * mean nothing could author a flow without a session, which breaks `kestra:*`,
 * the seeds and every non-interactive path.
 *
 * So: **a verified identity wins, and a body value alongside it is refused.**
 * Accepting both and preferring one is how `createdBy` comes to look like a
 * field a client controls — the same reasoning that made `approveSchema`
 * `.strict()`.
 *
 * ── What changed, and why the old caveat is now a column ─────────────────────
 *
 * This used to return a bare `string | undefined`, so the consequence had to be
 * written down rather than recorded: the name was verified through the browser
 * and self-asserted everywhere else, and **the row did not say which**. Gate 2's
 * self-approval refusal reads that name, so the control was verified on one side
 * and only as good as its input on the other — a caller holding the API key
 * could author as `someone-else@…` and approve as themselves (I-32).
 *
 * It now returns the name and the attestation as one `RevisionAuthor`, because a
 * qualifier that can be dropped at a call site is one that will be (D-42's
 * `resolveKey()`, same shape, same reason).
 *
 * ⚠ **This is the ONLY function in the codebase that may mint `createdByKind:
 * "user"`**, and `revision-author.test.ts` asserts that by reading the source
 * tree. A second minter would work perfectly and report nothing.
 *
 * ⚠ A body value on an unauthenticated path is still recorded — a harness
 * calling itself `phase3-verify@…` is useful — but it is now *labelled*
 * `system`, so it carries no claim that anyone verified it. That is the whole
 * fix: the name stops being the load-bearing part.
 *
 * ⚠ Still NOT separation of duties (I-13). No roles; anyone who can sign in can
 * approve, and anything holding `RUNTIME_JWT_SECRET` can mint an identity.
 */
export function authorOf(req: Request, bodyValue: string | undefined): RevisionAuthor {
  if (!req.user) return systemAuthor(bodyValue ?? SYSTEM_AUTHOR_NAME);
  if (bodyValue) {
    throw httpError(
      `"createdBy" is not accepted from a signed-in caller — authorship is taken from the ` +
        `verified identity. Remove the field.`,
      400,
    );
  }
  const actor = actorOf(req);
  // `resolveIdentity` already 401s a token carrying neither subject nor email,
  // so this cannot be empty in practice. Falling back to `system` rather than
  // to an empty attested name keeps the invariant true by construction: a `user`
  // kind always names somebody.
  return actor ? { createdBy: actor, createdByKind: "user" } : systemAuthor();
}

/**
 * Require a ROLE in the workspace this route addresses — archive/GAPS.md §1.1.
 *
 * `requireIdentity` above says *"a person is making this request"*.
 * This says *"and they are allowed to do this here"*, which is the half that
 * did not exist: gate 2 and gate 3 refused self-approval and nothing else, so
 * anyone who could sign in could approve anything.
 *
 * ⚠ It reads `req.params.workspaceId`, so it may only be mounted on a router
 * that has one. Rather than trusting that, it **refuses with a 500 naming the
 * mistake** when the parameter is absent — a middleware that silently allows a
 * request it could not evaluate is the worst possible failure for an
 * authorisation check, and it would look exactly like a passing route.
 *
 * ⚠ Always paired with `requireIdentity`, and the pairing is asserted by
 * `workspace-member.test.ts` reading the route tree. Alone it would still 401
 * an anonymous caller (via `check`), but the two say different things and a
 * route carrying only this one is a route somebody edited without reading it.
 *
 * ── ⚠ IT IS NOW A VIEW OVER THE PERMISSION MODEL, AND IT IS KEPT ─────────────
 *
 * `check` no longer compares an integer `RANK`. It asks whether the preset the
 * person holds **contains** the preset the route asked for (INV-4) — the same
 * answer for these three names, and the right question in general, because a
 * custom role is not on any ladder.
 *
 * ⚠ **This guard is DELIBERATELY NOT DELETED**, even though every route now also
 * carries a `requirePermission` spliced from `auth/route-permissions.ts`. Thirty-six
 * handlers were written against a ROLE and say so at the call site; rewriting them all
 * to a permission in the same change that introduces permissions would mean the sweep
 * and the rewrite could not be reviewed apart.
 *
 * ⚠ **BUT CARRYING BOTH IS AN `AND`, AND THAT IS NOT ALWAYS HARMLESS — I GOT THIS WRONG
 * ONCE AND `rbac:platform-verify` CAUGHT IT.** This paragraph used to say the pairing was
 * safe because "the permission a role guard's routes ask for sits inside that role's
 * preset, so nobody who passes the role guard is stopped by the permission guard". That
 * is true and it is only ONE direction. The other direction is the one that bites:
 * somebody may hold the PERMISSION without holding a MEMBERSHIP ROW, and the role guard
 * demands the row.
 *
 * That is exactly a platform administrator, who is conferred `members.read` +
 * `members.grant` in every workspace (D-9) and is a member of none.
 * `GET /workspaces/:ws/members` carried `requireWorkspaceRole("author")` beside
 * `members.read` and refused them at the one read the conferral exists to make reachable.
 *
 * **So: before pairing this guard with a permission, ask whether anybody can hold that
 * permission without a membership row.** If they can, the role guard must go.
 *
 * ⚠ **Prefer `requirePermission` for anything new.** A role is a bundle somebody chose;
 * a permission is the thing the handler actually needs. `requireWorkspaceRole("admin")`
 * on a route that only reads the budget grants fourteen other things by implication.
 */
export function requireWorkspaceRole(needed: "viewer" | "author" | "approver" | "admin") {
  return asyncHandler(async function roleGuard(req: Request, _res: Response, next: NextFunction) {
    const workspaceId = req.params.workspaceId;
    if (!workspaceId) {
      return next(
        httpError(
          "requireWorkspaceRole was mounted on a route with no :workspaceId parameter, so it " +
            "cannot decide anything. This is a wiring bug, not a permission failure.",
          500,
        ),
      );
    }
    if (!UUID_RE.test(workspaceId)) {
      return next(httpError(`"${workspaceId}" is not a workspace id.`, 400));
    }
    const { workspaceMemberService } = await import("../services/workspace-member.service.js");
    // ⚠ The whole identity, not `req.user?.subject`. The member lookup is keyed
    // on subject, but the super-admin allowlist matches subject OR email — and
    // passing only the subject is exactly the bug that made a correctly
    // configured `SUPER_ADMIN_EMAILS` grant nothing to an Entra sign-in, whose
    // subject is an OID. See `config.isSuperAdmin`.
    const verdict = await workspaceMemberService.check(workspaceId, req.user, needed);
    if (verdict.allowed) return next();
    return next(httpError(verdict.reason, verdict.status));
  });
}
