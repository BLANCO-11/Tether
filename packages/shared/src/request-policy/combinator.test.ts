import { describe, expect, it } from "vitest";
import { policyConfig } from "./config.js";
import { evaluatePolicy } from "./combinator.js";
import { policyFixtures } from "./fixtures.js";

describe("combinator — fixture table", () => {
  for (const fixture of policyFixtures) {
    it(`${fixture.description}: "${fixture.request}" (${fixture.mode}) -> ${fixture.expected}`, () => {
      const result = evaluatePolicy({ task: fixture.request }, fixture.mode, policyConfig);
      expect(result.decision).toBe(fixture.expected);
    });
  }
});

describe("combinator — FR-013: only productReference + reproductionIntent may reject unilaterally", () => {
  it("capabilitySignature evidence alone never rejects, even under confirmation-unavailable — it becomes reject via the mode collapse, not via its own reject authority", () => {
    const result = evaluatePolicy(
      { task: "a blue social network with a friend graph, a news feed, a marketplace, and pages" },
      "confirmation-unavailable",
      policyConfig,
    );
    expect(result.decision).toBe("reject");
    // The distinguishing check: this reject must carry capabilitySignature evidence,
    // not productReference+reproductionIntent evidence (which is the ONLY combination
    // FR-013 grants unilateral reject authority to).
    expect(result.evidence.some((e) => e.kind === "capabilitySignature")).toBe(true);
    expect(result.evidence.some((e) => e.kind === "productReference")).toBe(false);
  });
});

describe("combinator — FR-008: differentiation evidence suppresses an otherwise-rejecting pattern", () => {
  it("product + reproduction intent + differentiation together still allow", () => {
    // Contrived: a request that would reject on productReference+reproductionIntent
    // alone, but also carries differentiation language.
    const result = evaluatePolicy(
      { task: "Build a clone that serves as an alternative to Slack" },
      "confirmation-available",
      policyConfig,
    );
    expect(result.decision).toBe("allow");
  });

  it(
    "KNOWN LIMITATION: a trailing \"for X\" clause allows a literal clone request through the " +
      "same path that legitimately allows a novel vertical business model — recorded here as a " +
      "deliberate trade-off, not a silent gap",
    () => {
      // "Build an Uber for doctors" (a genuinely novel business idea, spec's own worked
      // example) and "Build Facebook for my team" (arguably still a literal clone, just
      // naming who it's for) produce IDENTICAL evidence shapes: productReference +
      // reproductionIntent + differentiationQualifier(vertical). Surface text alone
      // cannot distinguish "for X" meaning "a different vertical" from "for X" meaning
      // "the audience of this literal clone" — resolving it either way by widening or
      // narrowing the vertical pattern would fix one case by breaking the other. This
      // test locks in the side the spec explicitly committed to (never block legitimate
      // category-level requests takes priority — false negatives over false positives)
      // rather than leaving the trade-off to be rediscovered as a surprise later.
      const uberForDoctors = evaluatePolicy(
        { task: "Build an Uber for doctors" },
        "confirmation-available",
        policyConfig,
      );
      const facebookForMyTeam = evaluatePolicy(
        { task: "Build Facebook for my team" },
        "confirmation-available",
        policyConfig,
      );
      expect(uberForDoctors.decision).toBe("allow");
      expect(facebookForMyTeam.decision).toBe("allow");
    },
  );

  it(
    "KNOWN LIMITATION: reproduction intent against a product NOT in the dataset is allowed — " +
      "the coverage bound, recorded here as a deliberate trade-off rather than left to be " +
      "reported from use",
    () => {
      // Reported from real use on 2026-08-18: *"this is hardcoded for the scope of
      // slack only, what if anyone uses any other name?"* — and it is. `products`
      // holds ten entries, so an identical sentence about anything else reaches
      // `allow` with no evidence at all. Measured: `clone of Slack` rejects; Notion,
      // WhatsApp, Trello, Zoom, Jira, Shopify, Airtable, ServiceNow and Linear all
      // allow. Nine of ten.
      //
      // This is the SAME trade-off the test above locks in, arriving from the other
      // side, and `config.ts` already commits to it in as many words: the dataset is
      // "deliberately incomplete and will stay that way", and absence of a match
      // defaults to allow, never to reject. The alternative — firing on reproduction
      // language plus any proper noun — refuses real work: "a clone of our old Access
      // database", "an exact copy of the Q3 spreadsheet". False negatives over false
      // positives, which is the priority the spec set.
      //
      // ⚠ **This test exists so that widening it is a DECISION rather than a diff.**
      // Add a generic proper-noun rule and these expectations go red, which is the
      // point: the person doing it has to come here, read why the bound was chosen,
      // and change this test on purpose. A prose comment cannot do that — the reason
      // the sibling test above is a test and not a paragraph.
      //
      // ⚠ It asserts the BOUND, not the list. Adding a product to `config.ts` must
      // not break it, so nothing here names a listed product.
      const unlisted = [
        "build an exact clone of Notion",
        "build an exact clone of WhatsApp",
        "build an exact clone of Trello",
        "make a pixel-perfect copy of Linear",
        "build an exact replica of ServiceNow",
      ];
      for (const task of unlisted) {
        const d = evaluatePolicy({ task }, "confirmation-available", policyConfig);
        expect(d.decision, `${task} — unlisted, so nothing matches it`).toBe("allow");
      }

      // ⚠ The CONTROL, and without it this whole test passes over a broken evaluator:
      // "everything is allowed" would satisfy every expectation above. A listed
      // product with the same wording must still reject.
      const listed = evaluatePolicy(
        { task: "build an exact clone of Slack" },
        "confirmation-available",
        policyConfig,
      );
      expect(listed.decision, "the control — a LISTED product still rejects").toBe("reject");
    },
  );
});

describe("combinator — FR-012: mode-collapse produces an identical reason to the transform case", () => {
  it("the reject reason under confirmation-unavailable matches the transform reason's evidence-based text", () => {
    const task = "a blue social network with a friend graph, a news feed, a marketplace, and pages";
    const available = evaluatePolicy({ task }, "confirmation-available", policyConfig);
    const unavailable = evaluatePolicy({ task }, "confirmation-unavailable", policyConfig);
    expect(available.decision).toBe("transform");
    expect(unavailable.decision).toBe("reject");
    expect(unavailable.reason).toBe(available.reason);
  });
});

describe("combinator — FR-019: every decision carries full evidence and metadata", () => {
  it("allow, transform, and reject decisions all carry originalRequest and configVersion", () => {
    const cases: [string, "confirmation-available" | "confirmation-unavailable"][] = [
      ["Build a CRM", "confirmation-available"],
      ["a blue social network with a friend graph, a news feed, a marketplace, and pages", "confirmation-available"],
      ["Build Facebook", "confirmation-available"],
    ];
    for (const [task, mode] of cases) {
      const result = evaluatePolicy({ task }, mode, policyConfig);
      expect(result.originalRequest).toBe(task);
      expect(result.configVersion).toBe(policyConfig.version);
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("combinator — FR-009 fallback: no substitute mapping means reject, not a guess", () => {
  it("a capability match with an unmappable feature falls back to reject even under confirmation-available", () => {
    // Stripe's distinguishing features intentionally have no featureSubstitutes entries.
    const result = evaluatePolicy(
      { task: "a payments platform with payment intents api and connect marketplace payouts" },
      "confirmation-available",
      policyConfig,
    );
    expect(result.decision).toBe("reject");
    expect(result.reason).toMatch(/no safe original substitute/i);
  });
});
