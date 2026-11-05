import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  OPS_AUTH_STYLE,
  OPS_SECRET_ENV,
  opsHrRoPassword,
  opsServiceKey,
  type OpsService,
} from "./ops-client.service.js";

/**
 * Derived from the table, not listed again — a hardcoded list here kept passing
 * over the original five when a sixth service was added, leaving the new one
 * covered by nothing. The membership is asserted below, so adding a service is
 * still deliberate.
 */
const SERVICES = Object.keys(OPS_SECRET_ENV) as OpsService[];

/**
 * The parent's half of a derivation that spans two processes.
 *
 * `packages/ops-api/src/service-keys.test.ts` is the deliberate near-duplicate of
 * this file, and the duplication is the mechanism, not an oversight. Neither
 * package imports the other — the control plane taking a build dependency on the
 * service it registers is the wrong direction — so what keeps them in step is
 * that both are pinned to the same WRITTEN-DOWN recipe, re-derived here from
 * `createHmac` rather than by calling the function under test twice.
 *
 * That is what makes the drift loud. Change the recipe on one side and that
 * side's test fails immediately, naming the label. A test that only asserted
 * self-consistency (`f(x) === f(x)`) would pass through exactly the change that
 * breaks the other process, and the symptom would be a 401 in a demo.
 */
describe("ops-api credentials, parent side", () => {
  it("derives the documented recipe for each service key", () => {
    for (const service of SERVICES) {
      const expected = createHmac("sha256", "root-key")
        .update(`ops-api:${service}:v1`)
        .digest("hex")
        .slice(0, 40);
      expect(opsServiceKey(service, "root-key")).toBe(
        service === "probe" ? `probe:${expected}` : expected,
      );
    }
  });

  it("derives the documented recipe for the ops_ro database password", () => {
    // Different label AND different length from a service key — 32 chars, not
    // 40. If the two derivations ever collapsed into one, ops-api's database
    // password would equal a credential that is stored in `workspace_secrets`
    // and handed to every flow step. That is the failure worth a test of its
    // own: a tool step would hold the tool layer's database password.
    expect(opsHrRoPassword("root-key")).toBe(
      createHmac("sha256", "root-key").update("ops-api:hr-ro:v1").digest("hex").slice(0, 32),
    );
    expect(opsHrRoPassword("root-key")).not.toBe(opsServiceKey("hr", "root-key"));
  });

  it("gives every service a different credential, and every root a different set", () => {
    const keys = SERVICES.map((s) => opsServiceKey(s, "root-key"));
    expect(new Set(keys).size).toBe(SERVICES.length);
    for (const service of SERVICES) {
      expect(opsServiceKey(service, "root-a")).not.toBe(opsServiceKey(service, "root-b"));
    }
  });

  it("uses all four auth styles across the services", () => {
    const styles = new Set(SERVICES.map((s) => OPS_AUTH_STYLE[s].style));
    expect([...styles].sort()).toEqual(["basic", "bearer", "header", "query"]);
  });

  it("keeps the ticketing env name it had before Stage 5", () => {
    expect(OPS_SECRET_ENV.ticketing).toBe("TICKETING_API_KEY");
  });

  /**
   * This file and `packages/ops-api/src/service-keys.test.ts` must be talking
   * about the same set of services, or the cross-process derivation each of them
   * pins is being checked on one side only. Both assert this same list, so a
   * service added to one package and forgotten in the other fails here rather
   * than at the first 401.
   */
  it("knows exactly the seven services ops-api serves", () => {
    // ⚠ `paging` added 2026-09-03 for the IT operations domain. It is the seventh
    // and it is deliberate: a page is not an email, so it has its own credential
    // and a workspace can hold mail without holding it.
    expect(SERVICES.sort()).toEqual([
      "chat",
      "hr",
      "llm",
      "mail",
      "paging",
      "probe",
      "ticketing",
    ]);
    expect(Object.keys(OPS_AUTH_STYLE).sort()).toEqual(SERVICES.sort());
  });

  it("never names the provider key as a workspace secret", () => {
    // `LLM_TOOL_TOKEN` is derived like every other service credential and seeded
    // into `workspace_secrets`. The BILLABLE provider key is operator
    // configuration held inside ops-api and is not derivable from the root at
    // all — if it ever appeared in this table, the parent would be seeding a
    // real external credential where any flow step can have it injected.
    expect(Object.values(OPS_SECRET_ENV)).not.toContain("LLM_API_KEY");
    expect(OPS_SECRET_ENV.llm).toBe("LLM_TOOL_TOKEN");
  });
});
