/**
 * The gate on `POST /api/mail/send`.
 * email-send-tool · plan.md Decision 5
 *
 * ⚠ **Deliberately not `requireApiKey`.** This endpoint is called by the step
 * executor like any other tool, so whatever credential it presents lives in
 * `workspace_secrets` and rides along on every email step in every flow. Making
 * that `PARENT_API_KEY` would put the credential that authorises the entire parent
 * API into a per-workspace secret store, present on every email step, for ever.
 *
 * So the endpoint takes a key of its own, derived from `PARENT_API_KEY` but not
 * equal to it (`services/mail-service-key.ts`). Holding it buys this one route.
 *
 * ⚠ It reuses `auth.middleware.ts`'s throttle instance rather than adding a
 * second one, so failures against either check count toward the same per-IP
 * budget. Two independent 20/min budgets would be 40/min for an attacker who
 * alternates between them.
 */
import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { authFailureRule, authFailureThrottleInstance } from "./auth.middleware.js";
import { mailServiceKey, MAIL_KEY_HEADER } from "../services/mail-service-key.js";

/**
 * Compare without leaking how much of the key was right.
 *
 * Same construction and the same caveat as `auth.middleware.ts`'s `secretEquals`:
 * length is compared first and therefore leaks, because `timingSafeEqual` throws
 * on unequal lengths. Learning that the key is 40 hex chars buys an attacker
 * nothing — it is documented; learning its prefix would buy them the key.
 */
function keyEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function requireMailKey(req: Request, res: Response, next: NextFunction) {
  const provided = req.header(MAIL_KEY_HEADER);

  if (!provided || !keyEquals(provided, mailServiceKey())) {
    authFailureThrottleInstance.recordFailure(req.ip ?? "unknown");
    // Never the presented value — only enough context to investigate.
    console.warn(`[mail] auth failure from ${req.ip}`, {
      path: req.path,
      at: new Date().toISOString(),
    });
    if (authFailureThrottleInstance.isThrottled(req.ip ?? "unknown")) {
      const retryAfter = Math.ceil(authFailureRule.windowMs / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "rate_limited", retryAfterSeconds: retryAfter });
    }
    return res.status(401).json({
      error: "unauthorized",
      message: `Missing or invalid ${MAIL_KEY_HEADER}`,
    });
  }

  next();
}
