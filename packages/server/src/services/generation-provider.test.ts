/**
 * One model connection (2026-11-04), and the D-115 deployment gate on the pricing routes.
 * The owner reversed D-35: the builder's model is the runtime connection, so what these tests pin is that nothing
 * reads `generation_llm` any more, the model routes are gone, and a failed read still throws.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const runtimeSvc = readFileSync("src/services/runtime-model.service.ts", "utf8");
const svc = readFileSync("src/services/generation-provider.service.ts", "utf8");
const routes = readFileSync("src/routes/generation-provider.ts", "utf8");
const inference = readFileSync("src/services/inference.service.ts", "utf8");
/**
 * ⚠ **THE SUBJECT MOVED (RBAC T070).** `deployment-admin.middleware.ts` is DELETED. Its
 * job — "who may change a deployment-wide setting" — is now
 * `requirePlatformPermission("platform.generation.write")`. Deleting it was the point:
 * leaving it importable leaves two answers to that question, and the weaker one
 * ("be an admin in ANY workspace") takes no argument to satisfy.
 *
 * Every PROPERTY this file asserted survives; one is inverted, and deliberately — the old
 * guard described itself as *deliberately coarse*, and the whole reason for the platform
 * tier is that it no longer has to be.
 */
const guard = readFileSync("src/middleware/platform-permission.middleware.ts", "utf8");

describe("one model connection (2026-11-04)", () => {
  it("the generation adapter resolves the one connection and never reads generation_llm", () => {
    expect(svc).toContain("resolveModelConnection");
    expect(svc).not.toContain("generationLlm");
  });

  it("the generation router has no model routes", () => {
    expect(routes).not.toMatch(/"\/llm\//);
  });

  it("resolves the connection PER CALL, not once at import", () => {
    expect(inference).not.toMatch(/export const inference: InferenceClient = resolveInference\(\)/);
    expect(inference).toContain("class ResolvingInference");
    expect(inference).toContain("currentConnection()");
  });

  it("caches for seconds, never for the process lifetime", () => {
    const ttl = /const TTL_MS = ([\d_]+)/.exec(runtimeSvc);
    expect(ttl).not.toBeNull();
    expect(Number(ttl![1]!.replace(/_/g, ""))).toBeLessThanOrEqual(60_000);
  });

  it("a failed read is not silently the environment", () => {
    const from = runtimeSvc.indexOf("export async function resolveModelConnection");
    const next = runtimeSvc.indexOf("\nexport ", from + 1);
    const body = runtimeSvc.slice(from, next === -1 ? undefined : next);
    expect(from).toBeGreaterThan(-1);
    expect(body).not.toMatch(/catch/);
  });
});

describe("D-115 — the deployment-level gate says what it is", () => {
  it("⚠ is a SEPARATE guard from requireWorkspaceRole", () => {
    // `requireWorkspaceRole` treats a missing `:workspaceId` as a 500 wiring
    // bug — correctly, for every route it guards. Teaching it a second mode
    // where the absence is legitimate would delete that check for every caller.
    // ⚠ What is forbidden is CALLING it, not mentioning it — the guard's own
    // docblock explains at length why it is not `requireWorkspaceRole`, and the
    // first version of this assertion flagged that explanation. I-62: state the
    // forbidden thing, not a pattern that resembles it. A guard that cries wolf
    // gets widened, and the widening is what permits the defect.
    expect(guard).not.toMatch(/requireWorkspaceRole\s*\(/);
    // ⚠ The generation model is its own platform permission, NOT the tool model's.
    // D-115 keeps those two settings separate and it has confused a user twice; one
    // permission over both would merge them at the authorisation layer.
    expect(routes).toContain('requirePlatformPermission("platform.generation.write")');
    expect(routes).not.toContain("requireDeploymentAdmin");
    expect(routes).not.toContain("platform.toolmodel");
  });

  it("⚠ distinguishes 'nobody holds admin anywhere' from 'you are not an admin'", () => {
    // One message for both sends a person who cannot fix it looking for someone
    // who does not exist. Verified at the wire on 2026-08-07: an identity with
    // no admin row got the second, naming the coarse bound.
    //
    // ⚠ The PROPERTY is unchanged and the FIX it names changed. This asserted
    // `members/claim` until that endpoint was deleted (assignment by a super
    // admin replaced the self-claim bootstrap), so the unconfigured branch now
    // points at assignment and, when no super admin exists at all, at the
    // variable that has to be set. A refusal naming a route that no longer
    // exists is worse than one naming none.
    expect(guard).not.toContain("members/claim");
    expect(guard).toMatch(/super admin/i);
    expect(guard).toContain("SUPER_ADMIN_EMAILS");
    // ⚠ INVERTED ON PURPOSE. The old guard called itself "deliberately coarse" because
    // "admin in ANY workspace" was an approximation standing in for a tier that did not
    // exist. The tier exists now, so the guard asks for a named deployment permission and
    // one tenant's administrator holds nothing here at all.
    expect(guard).toMatch(/no longer deliberately coarse/i);
  });

  it("⚠ never claims separation of duties", () => {
    // Anything holding RUNTIME_JWT_SECRET can mint an identity, and a minted
    // identity with an admin row is an admin. I-13's rule, and it applies to
    // every role check in this product.
    // ⚠ Asserted as the PRESENCE of the disclaimer, not the absence of the
    // phrase. The phrase has to appear — that is how the file says it is not
    // that — so an absence check is unsatisfiable by a correct file, which is a
    // control that can only fail (the mirror image of I-38).
    expect(guard).toContain("NOT separation of duties");
    expect(guard).toContain("RUNTIME_JWT_SECRET");
  });
});
