import type { Request, Response, NextFunction } from "express";
import { executionTokenService, type TokenClaims } from "../services/execution-token.service.js";
import { asyncHandler } from "./error.middleware.js";

/**
 * Validates the execution-scoped token on `/api/steps/*` and resolves tenancy
 * from it (R3).
 *
 * ── Why this is NOT `requireApiKey` with an extra branch ─────────────────────
 *
 * `requireApiKey` accepts `Authorization: Bearer <parentApiKey>` as an alias for
 * `x-api-key`. If the step routes reused it, the *global* parent API key would
 * authenticate a step call — and then there would be no workspace to resolve,
 * because the parent key names no tenant. R3's guarantee is that tenancy comes
 * FROM THE TOKEN; a credential that carries no tenancy cannot be accepted here
 * at all, however privileged it is.
 *
 * So this middleware deliberately does **not** fall back to the parent key, and
 * `/api/steps/*` is mounted under this and nothing else.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireStepToken. Present iff the request authenticated as a step callback. */
      stepAuth?: TokenClaims;
    }
  }
}

export const requireStepToken = asyncHandler(async function requireStepToken(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "unauthorized",
      message: "step callbacks require an execution-scoped bearer token",
    });
  }

  const claims = await executionTokenService.verify(header.slice(7).trim());
  if (!claims) {
    // One message for unknown / expired / burned. Distinguishing them would tell
    // a caller which tokens exist.
    return res.status(401).json({ error: "unauthorized", message: "invalid execution token" });
  }

  req.stepAuth = claims;
  next();
});
