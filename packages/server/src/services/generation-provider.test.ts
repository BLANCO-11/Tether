/**
 * The two AI providers are two things, and this file exists to keep them two.
 * `breaking-2026-08-07/plan-provider-and-scope.md` Part A · F2 · D-115
 *
 * ⚠ **The assertion worth writing is the one that looks tautological.** F2 was
 * not a broken function — every unit here worked. It was *two things that must
 * not be connected looking, on screen and in the docs, like one thing*, so the
 * defect lived in the gap between them where no test was pointed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

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

describe("F2 — the generation provider is not the runtime provider", () => {
  it("⚠ shares no module with the runtime model's (D-35) — not ops-api's old client, not runtime-model.service", () => {
    // *"Runtime and generation inference must not be merged — different
    // credentials, different processes, no shared abstraction."* That was forced
    // by I-24, where the agent-runtime transport silently destroyed the
    // `insufficient_contract` refusal channel. Two panels on one page is a
    // layout choice; this is the property.
    for (const src of [svc, routes]) {
      expect(src).not.toMatch(/ops-client\.service|opsClient|runtime-model\.service/);
    }
  });

  it("⚠ resolves a MODEL and never a credential", () => {
    // The rejected alternative was "the parent fetches the gateway and key from
    // ops-api's row", which inverts Stage 5's boundary: ops-api holds no
    // control-plane credential and the parent holds no ops database credential.
    // So the row has neither column, and nothing here may invent one.
    expect(svc).not.toMatch(/baseUrl:\s*row|apiKey:\s*row|row\?\.(baseUrl|apiKey)/);
    expect(svc).toContain("config.inference.baseUrl");
    expect(svc).toContain("config.inference.apiKey");
  });

  it("⚠ never returns a key, and refuses one by NAME rather than dropping it", () => {
    // There is deliberately no endpoint in this product that returns a secret
    // value and no `?reveal=`; a settings page is precisely where that rule gets
    // broken "so the operator can check what they pasted".
    expect(routes).toContain("keyFingerprint");
    expect(routes).not.toMatch(/apiKey:\s*config\.inference\.apiKey/);
    // ⚠ Accepted-and-ignored reads exactly like a field that works, which is
    // the same class of defect as F2 itself.
    expect(routes).toContain("refuseCredentialFields");
    expect(routes).toContain(".strict()");
  });

  it("⚠ resolves the model PER CALL, not once at import", () => {
    // `export const inference = resolveInference()` bound the model at module
    // load, so changing it needed a container restart — which is the state this
    // whole feature exists to leave. A settings page over a boot-time binding is
    // a page that reports a change it did not make.
    expect(inference).not.toMatch(/export const inference: InferenceClient = resolveInference\(\)/);
    expect(inference).toContain("class ResolvingInference");
    expect(inference).toContain("currentModel()");
  });

  it("⚠ caches for seconds, never for the process lifetime", () => {
    // A process-lifetime cache would reinstate the restart requirement while
    // looking like it had been removed.
    const ttl = /const TTL_MS = ([\d_]+)/.exec(svc);
    expect(ttl).not.toBeNull();
    expect(Number(ttl![1]!.replace(/_/g, ""))).toBeLessThanOrEqual(60_000);
  });

  it("⚠ a failed read is not silently the environment", () => {
    // That would generate on a different model from the one the screen shows,
    // for as long as the database is unhappy, and say nothing — the shape of
    // I-07, where `begin` answers 503 rather than trusting the request body.
    // A missing ROW is a different thing and is the normal case.
    expect(svc).not.toMatch(/catch[\s\S]{0,120}config\.inference\.model/);
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
