import { describe, expect, it } from "vitest";
import { policyConfig } from "./config.js";
import {
  capabilitySignature,
  differentiationQualifier,
  productReference,
  reproductionIntent,
} from "./rules.js";

describe("productReference rule", () => {
  it("matches a cataloged product by name", () => {
    const ev = productReference.evaluate({ task: "Build Facebook" }, policyConfig);
    expect(ev).toEqual([{ kind: "productReference", product: "Facebook", matchedAlias: "Facebook" }]);
  });

  it("matches by alias", () => {
    const ev = productReference.evaluate({ task: "Build fb" }, policyConfig);
    expect(ev.some((e) => e.kind === "productReference" && e.product === "Facebook")).toBe(true);
  });

  it("produces no evidence for an uncataloged product", () => {
    const ev = productReference.evaluate({ task: "Build Notion" }, policyConfig);
    expect(ev).toEqual([]);
  });

  it("declares canRejectAlone: false", () => {
    expect(productReference.capability.canRejectAlone).toBe(false);
  });
});

describe("reproductionIntent rule", () => {
  it("matches each lexicon phrase", () => {
    for (const phrase of policyConfig.intentLexicon.reproduction) {
      const ev = reproductionIntent.evaluate({ task: `please ${phrase} this app` }, policyConfig);
      expect(ev.some((e) => e.kind === "reproductionIntent" && e.phrase === phrase)).toBe(true);
    }
  });

  it("produces no evidence for neutral phrasing", () => {
    const ev = reproductionIntent.evaluate({ task: "Build a nice app for my team" }, policyConfig);
    expect(ev).toEqual([]);
  });

  describe("bare-form pattern (\"Build Facebook\") — clause boundary handling", () => {
    // Regression, found manually against a running server (not by a fixture):
    // an earlier version of this pattern required the match to end at
    // end-of-string or `[.!?]`. That silently ALLOWED two real submissions
    // through: "Build Facebook, with everything" (a comma) and "Build
    // Facebook. Data sources it can use: none." (a trailing sentence the
    // client appends whenever anything is attached in the builder UI's
    // fullPrompt()). Fixed by adding `,` to the accepted clause-boundary set.
    it("still matches when trailing sentences follow the bare clause", () => {
      const ev = reproductionIntent.evaluate(
        { task: "Build Facebook. Data sources it can use: none." },
        policyConfig,
      );
      expect(ev.some((e) => e.kind === "reproductionIntent")).toBe(true);
    });

    it("still matches with multiple trailing sentences", () => {
      const ev = reproductionIntent.evaluate(
        {
          task: "Build Facebook. Tools it can use: Slack: notify. Schedule: every Monday.",
        },
        policyConfig,
      );
      expect(ev.some((e) => e.kind === "reproductionIntent")).toBe(true);
    });

    it("still matches with a comma continuation", () => {
      const ev = reproductionIntent.evaluate({ task: "Build Facebook, with everything" }, policyConfig);
      expect(ev.some((e) => e.kind === "reproductionIntent")).toBe(true);
    });

    it("does NOT match when another word sits between the verb and the alias", () => {
      const ev = reproductionIntent.evaluate(
        { task: "Build a tool that exports data to Slack" },
        policyConfig,
      );
      expect(ev).toEqual([]);
    });

    it("does NOT match a same-clause continuation with no punctuation (deliberate, see combinator test for why)", () => {
      // "Build Facebook for my team" has no bare-form evidence on its own —
      // this stays out of scope for THIS rule because of a genuine ambiguity
      // that surface text alone can't resolve (see the combinator-level test
      // below). Rules stay pure evidence producers (FR-004); reconciling that
      // ambiguity, if ever done, belongs in the combinator, not here.
      const ev = reproductionIntent.evaluate({ task: "Build Facebook for my team" }, policyConfig);
      expect(ev).toEqual([]);
    });
  });
});

describe("differentiationQualifier rule", () => {
  it("matches alternative phrasing", () => {
    const ev = differentiationQualifier.evaluate(
      { task: "an open-source Slack alternative" },
      policyConfig,
    );
    expect(ev.some((e) => e.kind === "differentiationQualifier" && e.qualifierKind === "alternative")).toBe(
      true,
    );
  });

  it("matches interop phrasing", () => {
    const ev = differentiationQualifier.evaluate(
      { task: "a database compatible with PostgreSQL" },
      policyConfig,
    );
    expect(ev.some((e) => e.kind === "differentiationQualifier" && e.qualifierKind === "interop")).toBe(
      true,
    );
  });

  it("matches similar-to phrasing", () => {
    const ev = differentiationQualifier.evaluate({ task: "a CRM like Salesforce" }, policyConfig);
    expect(ev.some((e) => e.kind === "differentiationQualifier" && e.qualifierKind === "similar")).toBe(
      true,
    );
  });

  it("matches the generic vertical pattern", () => {
    const ev = differentiationQualifier.evaluate({ task: "an uber for doctors" }, policyConfig);
    expect(ev.some((e) => e.kind === "differentiationQualifier" && e.qualifierKind === "vertical")).toBe(
      true,
    );
  });

  it("produces no evidence when nothing qualifies", () => {
    const ev = differentiationQualifier.evaluate({ task: "Build Facebook" }, policyConfig);
    expect(ev).toEqual([]);
  });
});

describe("capabilitySignature rule", () => {
  it("matches a full/near-full signature with no product name", () => {
    const ev = capabilitySignature.evaluate(
      { task: "a blue social network with a friend graph, a news feed, a marketplace, and pages" },
      policyConfig,
    );
    const facebook = ev.find((e) => e.kind === "capabilitySignature" && e.product === "Facebook");
    expect(facebook).toBeDefined();
    if (facebook && facebook.kind === "capabilitySignature") {
      expect(facebook.matched).toEqual(
        expect.arrayContaining(["friend graph", "news feed", "marketplace", "pages"]),
      );
      expect(facebook.missing).toEqual(["poke"]);
    }
  });

  it("produces no evidence below the match threshold", () => {
    const ev = capabilitySignature.evaluate({ task: "a marketplace for used books" }, policyConfig);
    expect(ev.find((e) => e.kind === "capabilitySignature" && e.product === "Facebook")).toBeUndefined();
  });

  it("produces no evidence for a request with no cataloged signature at all (FR-015 default-allow precondition)", () => {
    const ev = capabilitySignature.evaluate({ task: "Build a todo list app" }, policyConfig);
    expect(ev).toEqual([]);
  });

  it("declares canRejectAlone: false", () => {
    expect(capabilitySignature.capability.canRejectAlone).toBe(false);
  });
});
