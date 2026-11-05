import { afterEach, describe, expect, it } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { requireSuperAdmin } from "./super-admin.middleware.js";
import { config } from "../config/index.js";

/**
 * `requireSuperAdmin` — the gate on workspace lifecycle and membership writes.
 *
 * Four outcomes, and the two 403s are the point: *"you are not one"* and *"there
 * are none"* need different actions (ask a person, versus set an environment
 * variable), and one message for both sends somebody who cannot fix it looking
 * for somebody who does not exist.
 */

const SUPER = "boss@acme-hr.example";

function run(user?: { subject: string; email: string }) {
  const errs: unknown[] = [];
  let passed = false;
  const next: NextFunction = ((e?: unknown) => {
    if (e) errs.push(e);
    else passed = true;
  }) as NextFunction;
  requireSuperAdmin({ user } as unknown as Request, {} as Response, next);
  const err = errs[0] as (Error & { statusCode?: number }) | undefined;
  return { passed, status: err?.statusCode, message: err?.message ?? "" };
}

/**
 * ⚠ **The allowlist is real deployment config and this repo's `.env` SETS it**,
 * so a test about the unconfigured branch has to empty it rather than assume it
 * starts empty — the first version of this file did assume, and passed or failed
 * depending on whose machine it ran on. `superAdminEmails` is the same `Set`
 * object `config` exposes, so emptying and restoring it is the whole seam.
 */
const REAL = [...config.superAdminEmails];
function withNoSuperAdmins() {
  config.superAdminEmails.clear();
}
afterEach(() => {
  config.superAdminEmails.clear();
  for (const e of REAL) config.superAdminEmails.add(e);
});

describe("requireSuperAdmin", () => {
  it("allows a listed identity — the positive control", () => {
    config.superAdminEmails.add(SUPER);
    const r = run({ subject: "oid-boss", email: SUPER });
    expect(r.passed).toBe(true);
  });

  it("401s an anonymous caller — a different problem from being refused", () => {
    // The API key authorises the request; it does not name a person. A 403 here
    // would send somebody to ask for a role they cannot be granted without
    // signing in first.
    config.superAdminEmails.add(SUPER);
    const r = run(undefined);
    expect(r.status).toBe(401);
  });

  it("403s a signed-in non-super-admin and tells them to ask", () => {
    config.superAdminEmails.add(SUPER);
    const r = run({ subject: "oid-alice", email: "alice@acme-hr.example" });
    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
    expect(r.message).toMatch(/not one|administers/i);
    // ⚠ It must NOT name the allowlisted accounts: a 403 is the last place to
    // publish the list of accounts worth attacking.
    expect(r.message).not.toContain(SUPER);
  });

  it("⚠ 403s with a DIFFERENT message when no super admin is configured", () => {
    // Nobody is listed, so nobody can create a workspace or assign a member.
    // The message has to name the variable or the product reads as broken
    // rather than as unconfigured — this is the whole cost of deleting `claim`.
    withNoSuperAdmins();
    const r = run({ subject: "oid-alice", email: "alice@acme-hr.example" });
    expect(r.status).toBe(403);
    expect(r.message).toContain("SUPER_ADMIN_EMAILS");
  });

  it("the two 403s are not the same string", () => {
    withNoSuperAdmins();
    const unconfigured = run({ subject: "oid-alice", email: "alice@acme-hr.example" }).message;
    config.superAdminEmails.add(SUPER);
    const configured = run({ subject: "oid-alice", email: "alice@acme-hr.example" }).message;
    expect(configured).not.toBe(unconfigured);
    expect(configured).not.toContain("SUPER_ADMIN_EMAILS");
  });
});

describe("config.isSuperAdmin", () => {
  it("an empty allowlist grants nothing to anybody", () => {
    withNoSuperAdmins();
    expect(config.superAdminConfigured).toBe(false);
    expect(config.isSuperAdmin({ subject: "oid-boss", email: SUPER })).toBe(false);
  });

  it("matches subject or email, and ignores an identity with neither", () => {
    withNoSuperAdmins();
    config.superAdminEmails.add(SUPER);
    expect(config.isSuperAdmin({ subject: SUPER, email: null })).toBe(true);
    expect(config.isSuperAdmin({ subject: "oid-x", email: SUPER })).toBe(true);
    expect(config.isSuperAdmin({ subject: "oid-x", email: "" })).toBe(false);
    expect(config.isSuperAdmin(undefined)).toBe(false);
  });
});

/**
 * The super admin's reach through the ACCOUNTABILITY gates, not just the role
 * check — asked for explicitly ("all access for all workspaces, including
 * approvals and rejections").
 *
 * ⚠ These assert an EXEMPTION, which is the opposite of what most tests in this
 * repo do, so they are worth reading carefully. Two things had refused a super
 * admin and both were correct to: gate 2's self-approval refusal and gate 3's
 * self-decision refusal. Both now stand down for them, and both leave a trace.
 * The claim to make afterwards is *"a NON-super-admin cannot approve their own
 * revision"* — never the unqualified sentence.
 */
describe("the accountability gates, and where a super admin now passes", () => {
  it("the override is recorded on the approval row, not silent", async () => {
    // ⚠ The column is the point. Without it, "a second pair of eyes approved
    // this" and "its author approved it under an override" become the same row,
    // and every existing row in the table quietly loses the stronger meaning.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../services/flow-approval.service.ts", import.meta.url).pathname, "utf8"),
    );
    expect(src).toContain("selfApprovedOverride");
    // And it must come from the identity, never a body — `approveSchema` is
    // `.strict()` for exactly that reason.
    const route = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../routes/approvals.ts", import.meta.url).pathname, "utf8"),
    );
    // Restricted workspaces: the allowlist counts only where `superAdminHere` says it does (not in a restricted
    // workspace without an open emergency access), still from the verified identity.
    expect(route).toContain("bySuperAdmin: await superAdminHere(req.user, req.params.workspaceId!)");
    expect(route).not.toMatch(/bySuperAdmin:\s*(req\.body|input)/);
  });

  it("⚠ the refusal still fires for everyone else — the exemption is not a deletion", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../services/flow-approval.service.ts", import.meta.url).pathname, "utf8"),
    );
    // The guard is `selfApproval && !override`, so a non-super-admin author is
    // refused exactly as before. If this ever becomes an unconditional pass, the
    // grep goes red rather than the behaviour going quiet.
    expect(src).toMatch(/if\s*\(selfApproval\s*&&\s*!override\)/);
    expect(src).toMatch(/Approval is a second pair of eyes/);
  });
});
