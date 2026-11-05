import { describe, expect, it } from "vitest";
import { policyConfig } from "./config.js";

describe("policyConfig — internal consistency", () => {
  it("every featureSubstitutes entry maps a feature some product actually declares", () => {
    const allFeatures = new Set(
      policyConfig.products.flatMap((p) => p.distinguishingFeatures),
    );
    for (const sub of policyConfig.featureSubstitutes) {
      expect(allFeatures.has(sub.feature), `orphan substitute mapping for "${sub.feature}"`).toBe(
        true,
      );
    }
  });

  it("has a non-empty version string", () => {
    expect(policyConfig.version.length).toBeGreaterThan(0);
  });

  it("no product name collides with another product's alias", () => {
    const names = new Set(policyConfig.products.map((p) => p.name.toLowerCase()));
    for (const p of policyConfig.products) {
      for (const alias of p.aliases) {
        if (alias.toLowerCase() === p.name.toLowerCase()) continue;
        expect(names.has(alias.toLowerCase()), `alias "${alias}" collides with a product name`).toBe(
          false,
        );
      }
    }
  });

  it("every product has at least one distinguishing feature", () => {
    for (const p of policyConfig.products) {
      expect(p.distinguishingFeatures.length, `${p.name} has no distinguishing features`).toBeGreaterThan(0);
    }
  });

  it("the vertical differentiation pattern compiles and matches 'X for Y' style phrasing", () => {
    const re = new RegExp(policyConfig.intentLexicon.differentiation.verticalPattern, "i");
    expect(re.test("build an uber for doctors")).toBe(true);
    expect(re.test("build an airbnb for pets")).toBe(true);
    expect(re.test("build a social media platform")).toBe(false);
  });
});

/**
 * Regression guard for FR-020: content changes to the dataset must bump
 * `version`. This test hardcodes a snapshot of the current content's shape
 * (counts only, not full content, to stay cheap to maintain) against the
 * current version — if someone edits products/featureSubstitutes/lexicon
 * without bumping version, this fails.
 */
describe("policyConfig — version discipline (FR-020)", () => {
  it("version '1' corresponds to the current dataset shape", () => {
    if (policyConfig.version !== "1") {
      // A later version is expected to have its own snapshot recorded here;
      // this branch exists so the test fails loudly rather than silently
      // passing once the version has moved on without an updated snapshot.
      throw new Error(
        `policyConfig.version is "${policyConfig.version}" but this test only has a snapshot for ` +
          `version "1". Add a matching snapshot branch before bumping the version further, or this ` +
          "test is not actually verifying anything.",
      );
    }
    expect(policyConfig.products.length).toBe(10);
    expect(policyConfig.featureSubstitutes.length).toBe(18);
    expect(policyConfig.intentLexicon.reproduction.length).toBe(6);
    expect(policyConfig.intentLexicon.bareBuildVerbs.length).toBe(7);
  });
});
