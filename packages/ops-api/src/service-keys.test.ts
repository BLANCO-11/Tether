import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { OPS_AUTH_STYLE, OPS_SECRET_ENV, opsServiceKey, type OpsService } from "./service-keys.js";

/**
 * Derived from the table, not listed again.
 *
 * A hardcoded list here was fine while the set was closed, and stopped being
 * fine the moment a sixth service was added: everything below would have kept
 * passing over the original five while the new one was covered by nothing. The
 * count is asserted separately, so adding a service still has to be deliberate —
 * it just cannot be silently uncovered.
 */
const SERVICES = Object.keys(OPS_SECRET_ENV) as OpsService[];

/**
 * These pin the two things that have to hold across a process boundary.
 *
 * The derivation is duplicated in `packages/server` (deliberately — see
 * `service-keys.ts`), so this file re-derives it from first principles rather
 * than calling the function under test with different arguments. A test that
 * only checks `opsServiceKey(k, s) === opsServiceKey(k, s)` would pass after any
 * change to the recipe, which is precisely the change that breaks the other
 * side.
 */
describe("ops service keys", () => {
  it("derives the documented recipe, not merely a stable one", () => {
    for (const service of SERVICES) {
      const expected = createHmac("sha256", "root-key")
        .update(`ops-api:${service}:v1`)
        .digest("hex")
        .slice(0, 40);
      const got = opsServiceKey("root-key", service);
      // `probe` is `user:pass` because HTTP Basic needs a pair.
      expect(got).toBe(service === "probe" ? `probe:${expected}` : expected);
    }
  });

  it("gives every service a DIFFERENT credential", () => {
    // The control on the test above. One root key and a per-service label is
    // only worth anything if the label actually reaches the digest — a
    // derivation that ignored `service` would satisfy "stable" and "derived"
    // and hand every service the same value, so a leaked mail key would open
    // ticketing.
    const keys = SERVICES.map((s) => opsServiceKey("root-key", s));
    expect(new Set(keys).size).toBe(SERVICES.length);
  });

  it("changes every credential when the root changes", () => {
    for (const service of SERVICES) {
      expect(opsServiceKey("root-a", service)).not.toBe(opsServiceKey("root-b", service));
    }
  });

  it("covers exactly the services this build knows about", () => {
    // The control on deriving SERVICES from the table: if the two tables ever
    // disagree about which services exist, the loops above would quietly skip
    // one side. Adding a service means updating this number and reading why.
    expect(SERVICES.sort()).toEqual([
      "chat",
      "hr",
      "llm",
      "mail",
      // ⚠ Added 2026-09-03 for the IT operations domain, deliberately and not as
      // a rename of an existing one. A page is not an email: it is the most
      // expensive thing an automation here can do, so it has its own credential
      // and a workspace can hold mail without holding it.
      "paging",
      "probe",
      "ticketing",
    ]);
    expect(Object.keys(OPS_AUTH_STYLE).sort()).toEqual(SERVICES.sort());
  });

  it("keeps the LLM tool credential separate from the provider key", () => {
    // Two credentials in two directions: `LLM_TOOL_TOKEN` is what a FLOW
    // presents to ops-api, and the provider key is what ops-api presents to the
    // gateway. Naming them the same thing is how one ends up in the other's
    // header — so the inbound style is deliberately NOT bearer, which is where
    // the outbound key goes.
    expect(OPS_SECRET_ENV.llm).toBe("LLM_TOOL_TOKEN");
    expect(OPS_SECRET_ENV.llm).not.toBe("LLM_API_KEY");
    expect(OPS_AUTH_STYLE.llm.style).not.toBe("bearer");
  });

  it("uses all four auth styles across the services", () => {
    // Not variety for its own sake. Each service accepts exactly one style, so
    // covering all four means an automation that gets `bearer` right has still
    // proved nothing about `query` — and a wrong guess is visible in the call
    // log rather than absorbed by an endpoint that takes anything.
    const styles = new Set(SERVICES.map((s) => OPS_AUTH_STYLE[s].style));
    expect([...styles].sort()).toEqual(["basic", "bearer", "header", "query"]);
  });

  it("gives every service a distinct secret env name", () => {
    // The env-var name is the single identifier joining `workspace_secrets`, the
    // manifest's `<auth env=…>` and the endpoint. Two services sharing one name
    // would make the manifest ambiguous about which credential a tool needs.
    const names = SERVICES.map((s) => OPS_SECRET_ENV[s]);
    expect(new Set(names).size).toBe(SERVICES.length);
  });

  it("keeps the ticketing env name it had before Stage 5", () => {
    // An existing workspace secret and an existing tool registration both name
    // this string. Renaming it would silently 401 every ticket call on an
    // already-seeded deployment until someone re-ran `demo:seed`.
    expect(OPS_SECRET_ENV.ticketing).toBe("TICKETING_API_KEY");
  });

  it("expects a header style to name its header, and bearer/basic not to", () => {
    for (const service of SERVICES) {
      const { style, paramName } = OPS_AUTH_STYLE[service];
      if (style === "header" || style === "query") {
        expect(paramName, `${service} (${style}) must name its parameter`).toBeTruthy();
      } else {
        expect(paramName, `${service} (${style}) has nothing to name`).toBeNull();
      }
    }
  });
});
