import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { workspaceMemberCapabilitiesService, isValidCapability } from "./workspace-member-capabilities.service.js";
import { WORKSPACE_PERMISSIONS } from "../auth/permissions.js";
import { ROLE_PRESETS } from "../auth/role-presets.js";

/**
 * T050 / R-5 — `realdata.use` has TWO enforcing consumers, not one.
 *
 * ⚠ The plan's R-5 named `routes/break-glass.ts` alone. There are **three** readers of
 * the capability store — break-glass, `routes/me.ts` (which serves `capabilities[]` to
 * the browser and therefore decides what the sidebar renders) and
 * `services/catalogue.service.ts` — and **two of them enforce** `realdata.use`. A test
 * on break-glass alone leaves the catalogue's gate unproven, which is the reader that
 * decides whether a person sees real identifiers or a hatched panel.
 *
 * ⚠ **This reads the source off disk**, the `TETHER_API_KEY`-in-three-files idiom. The
 * gate is a `hasCapability` call inside a larger function; a behavioural test would need
 * a whole workspace with real datasources to exercise it, and the thing that actually
 * rots is the capability STRING — renamed by migration 0065 from `real-data` to
 * `realdata.use`. A consumer left on the old spelling would ask for a capability nobody
 * can hold, and fail CLOSED: every person permanently restricted, with no error anywhere.
 */

const SOURCES = {
  "routes/break-glass.ts": "src/routes/break-glass.ts",
  "services/catalogue.service.ts": "src/services/catalogue.service.ts",
} as const;

function read(rel: string): string {
  return readFileSync(new URL(`../../${rel}`, import.meta.url).pathname, "utf8");
}

describe("realdata.use is enforced by both of its consumers", () => {
  it("CONTROL: the scan can find anything at all", () => {
    // Without this, a renamed or moved file reads as an empty string and every
    // assertion below passes over nothing.
    for (const [name, rel] of Object.entries(SOURCES)) {
      const src = read(rel);
      expect(src.length, `${name} read as empty`).toBeGreaterThan(500);
      expect(src, `${name} does not look like the file we mean`).toMatch(
        /workspaceMemberCapabilitiesService/,
      );
    }
  });

  it("both ask for `realdata.use`, and neither still asks for `real-data`", () => {
    for (const [name, rel] of Object.entries(SOURCES)) {
      const src = read(rel);
      expect(src, `${name} does not gate on realdata.use`).toMatch(/capability: "realdata\.use"/);
      // ⚠ The old spelling fails CLOSED and silently: nobody can hold `real-data` any
      // more, so a consumer left on it restricts everybody for ever with no error.
      expect(src, `${name} still asks for the pre-0065 "real-data"`).not.toMatch(
        /capability: "real-data"/,
      );
    }
  });

  it("break-glass refuses activation without it, and says which capability", () => {
    const src = read(SOURCES["routes/break-glass.ts"]);
    expect(src).toMatch(/if \(!hasRealData\)/);
    expect(src).toMatch(/403/);
  });

  it("the catalogue's gate decides RESTRICTED vs masked, and defaults to restricted", () => {
    const src = read(SOURCES["services/catalogue.service.ts"]);
    // ⚠ `: false` is the load-bearing half — an anonymous or unresolvable viewer is
    // restricted, not waved through. A gate whose unknown case is "allow" is not a gate.
    // ⚠ `: false` is the load-bearing half — an anonymous or unresolvable viewer is
    // restricted, not waved through. A gate whose unknown case is "allow" is not a gate.
    const gate = src.slice(src.indexOf("const hasRealData"), src.indexOf("const hasRealData") + 400);
    expect(gate, "the catalogue gate is not where this test thinks").toMatch(/realdata\.use/);
    expect(gate, "an unresolvable viewer is not defaulted to restricted").toMatch(/:\s*false/);
  });
});

describe("the capability vocabulary is the catalogue now", () => {
  it("`realdata.use` is a real permission and the old strings are not", () => {
    expect(isValidCapability("realdata.use")).toBe(true);
    for (const dead of ["real-data", "edit-workflows", "publish", "approve", "resources"]) {
      expect(isValidCapability(dead), `${dead} is still accepted`).toBe(false);
    }
  });

  it("INV-10: `admin` and `platform-admin` are NOT capabilities", () => {
    // ⚠ They were roles wearing a capability's clothes. A capability is a thing you may
    // do; those two were statements about who somebody is.
    expect(isValidCapability("admin")).toBe(false);
    expect(isValidCapability("platform-admin")).toBe(false);
  });

  it("CAPABILITIES is the workspace catalogue, not a second list", () => {
    expect([...workspaceMemberCapabilitiesService.CAPABILITIES].sort()).toEqual(
      [...WORKSPACE_PERMISSIONS].sort(),
    );
  });

  it("`realdata.use` sits in `admin` and nowhere else", () => {
    expect(ROLE_PRESETS.admin).toContain("realdata.use");
    expect(ROLE_PRESETS.approver).not.toContain("realdata.use");
    expect(ROLE_PRESETS.author).not.toContain("realdata.use");
  });
});
