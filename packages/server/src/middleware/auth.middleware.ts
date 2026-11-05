import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { authFailureThrottle } from "@foundry/shared";
import { config } from "../config/index.js";

// FR-007 (research.md Decision 5) — 20 failures per IP per minute is a
// generous ceiling for a legitimate caller with a stale/misconfigured key
// (a person retyping it a few times), while still bounding a brute-force
// attempt to ~20/min instead of unlimited.
export const authFailureRule = { windowMs: 60_000, max: 20 };

// One instance, shared with identity.middleware.ts's failure branch — a
// caller's failures against either check count toward the same throttle,
// keyed on the same IP.
export const authFailureThrottleInstance = authFailureThrottle(authFailureRule);

/** Test-only: state resets between test files but not between test CASES. */
export function resetAuthFailureThrottleForTests() {
  Object.assign(authFailureThrottleInstance, authFailureThrottle(authFailureRule));
}

function recordAndCheckThrottle(req: Request, res: Response): boolean {
  authFailureThrottleInstance.recordFailure(req.ip ?? "unknown");
  // Never the presented credential value — only enough context to investigate.
  console.warn(`[auth] failure from ${req.ip}`, { path: req.path, at: new Date().toISOString() });
  if (authFailureThrottleInstance.isThrottled(req.ip ?? "unknown")) {
    res.setHeader("Retry-After", String(Math.ceil(authFailureRule.windowMs / 1000)));
    res.status(429).json({ error: "rate_limited", retryAfterSeconds: Math.ceil(authFailureRule.windowMs / 1000) });
    return true;
  }
  return false;
}

/**
 * Compare a presented credential against the configured one without leaking how
 * much of it was right.
 *
 * `===` on strings short-circuits at the first differing byte, so the time it
 * takes is a function of the shared prefix. That is a real oracle against a
 * long-lived shared secret like `PARENT_API_KEY`: guess a byte, keep the guess
 * that took longer, repeat. The throttle above bounds attempts to ~20/min per
 * IP, which makes the attack slow rather than impossible, and it does nothing
 * about an attacker with addresses to spare.
 *
 * ⚠ Length is compared first and therefore still leaks — `timingSafeEqual`
 * throws on unequal lengths, so there is no way around it here. Learning the
 * length of a random key buys an attacker essentially nothing; learning its
 * prefix buys them the key.
 */
function secretEquals(provided: string, configured: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(configured, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Simple API-key gate for the parent app's own API (Sprint 1 baseline; JWT/OIDC later).
// Health endpoints are intentionally left open (see app.ts mounting order).
export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const provided =
    req.header("x-api-key") ??
    (req.header("authorization")?.startsWith("Bearer ")
      ? req.header("authorization")!.slice(7)
      : undefined);

  if (!provided || !secretEquals(provided, config.parentApiKey)) {
    if (recordAndCheckThrottle(req, res)) return;
    return res.status(401).json({ error: "unauthorized", message: "Missing or invalid API key" });
  }
  next();
}
