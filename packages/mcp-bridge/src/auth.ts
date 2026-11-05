import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";

// FR-001/FR-002 (guardrail-port V2/V4/V5/V8, research.md Decision 1). Every
// call to this package's schema tools was, until this feature, reachable by
// anyone who could reach the port — confirmed by reading the whole package:
// no auth logic existed anywhere. Hand-rolled here rather than importing
// @foundry/shared's authFailureThrottle or packages/server's requireApiKey —
// this package has never depended on either, and one ~15-line check is not
// a reason to start.
//
// Fails CLOSED: an unconfigured MCP_BRIDGE_API_KEY refuses every request
// (500), never falling back to "anonymous is fine" — the same rule
// resolveIdentity's identity_unavailable branch already follows on the
// server side.
/**
 * Constant-time compare, matching `packages/server`'s `requireApiKey`.
 *
 * `!==` short-circuits at the first differing byte, so its duration leaks the
 * shared prefix — an oracle against a long-lived shared key. Length is compared
 * on the BUFFERS, not the strings: they disagree for anything outside ASCII, and
 * `timingSafeEqual` throws on unequal lengths, so a string-length check turns a
 * wrong credential into a 500 that a caller can trigger at will.
 *
 * ⚠ Unlike the server's, this has no failure throttle. This package has never
 * depended on `@foundry/shared` and the service is not started by default (see
 * the compose profile) — worth adding if it is ever put on a live path.
 */
function secretEquals(provided: string, configured: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(configured, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const configured = process.env.MCP_BRIDGE_API_KEY;
  if (!configured) {
    res.status(500).json({ error: "misconfigured", message: "MCP_BRIDGE_API_KEY is not set" });
    return;
  }

  const provided = req.header("x-api-key");
  if (!provided || !secretEquals(provided, configured)) {
    res.status(401).json({ error: "unauthorized", message: "Missing or invalid API key" });
    return;
  }

  next();
}
