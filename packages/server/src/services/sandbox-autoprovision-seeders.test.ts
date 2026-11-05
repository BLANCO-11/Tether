/**
 * WHICH SEEDERS START A SANDBOX BUILD, AND WHY THE ANSWER IS NOT "ALL OF THEM".
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * `provisionIfAbsent` is hooked into `datasourceService.refreshSchema` — the
 * route the onboarding wizard calls — so a datasource added through the product
 * comes up sandboxed on its own. Every seeder in this repo calls
 * `schemaIntrospectorService.refresh` DIRECTLY, one layer below that hook, so
 * none of them fired it. Measured on this deployment: all four demo datasources
 * had `sandbox_build_status` NULL and a draft run of every flow read the real
 * database. The product's default and a seeded tenant's default disagreed, and
 * nothing said so.
 *
 * ── ⚠ Why only the GENERIC seeder is hooked ─────────────────────────────────
 *
 * `demo:verify`, `showcase:verify` and `scenarios:verify` score a DRAFT run
 * against an oracle computed from the REAL dataset. Turning fixtures on under
 * HR, Finance, Legal or IT Operations therefore makes them fail for a CORRECT
 * reason — the run would be reading different rows than the oracle was computed
 * from. The three generic domains have no oracle harness and assert nothing
 * about a draft run's contents, which is the whole reason the hook is safe
 * there and nowhere else.
 *
 * So this asymmetry is a decision, not an unfinished job, and a test is the
 * only place that survives being read. Without it the obvious tidy-up — "add
 * the call to the other four" — looks like completing the work and takes the
 * regression net down.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** The seeders that must NOT auto-provision, and the harness that says why. */
const ORACLE_BACKED: Array<[string, string]> = [
  ["../demo/provision.ts", "demo:verify"],
  ["../demo/finance/provision-finance.ts", "finance:verify / scenarios:verify"],
  ["../demo/legal/provision-legal.ts", "legal:verify"],
  ["../demo/itops/provision-itops.ts", "itops:verify"],
];

describe("the generic seeder starts a sandbox build", () => {
  const src = read("../demo/generic/provision.ts");

  /** The control: the file was found and is the real one. */
  it("is reading the generic provisioner", () => {
    expect(src.length).toBeGreaterThan(3000);
    expect(src).toContain("schemaIntrospectorService.refresh(");
  });

  it("calls provisionIfAbsent for the datasource it just introspected", () => {
    expect(src).toContain("provisionIfAbsent(workspaceId, datasourceId)");
  });

  /**
   * ⚠ AFTER the introspection, not before. A fixture is generated from the
   * introspected shape, so a call above it would refuse every new datasource
   * with `no_schema` — a build that fails for a reason that is really "too
   * early", which is the exact trap `refreshSchema`'s own comment records.
   */
  it("calls it after introspecting, never before", () => {
    const introspect = src.indexOf("schemaIntrospectorService.refresh(");
    const auto = src.indexOf("provisionIfAbsent(workspaceId, datasourceId)");
    expect(introspect).toBeGreaterThan(-1);
    expect(auto).toBeGreaterThan(introspect);
  });

  /** The decision reaches the report, so a refusal is not swallowed. */
  it("reports the outcome rather than discarding it", () => {
    expect(src).toContain("sandbox: AutoProvisionOutcome;");
    expect(src).toMatch(/\n {4}sandbox,/);
    expect(read("../demo/generic/seed.ts")).toContain("r.sandbox.started");
  });
});

describe("the oracle-backed seeders deliberately do NOT", () => {
  for (const [rel, harness] of ORACLE_BACKED) {
    it(`${rel.split("/").pop()} does not auto-provision — ${harness} scores a draft run against the real dataset`, () => {
      const src = read(rel);
      // The control, per file: it was found and it really is a seeder.
      expect(src).toContain("schemaIntrospectorService.refresh(");
      expect(src).not.toContain("provisionIfAbsent");
    });
  }
});
