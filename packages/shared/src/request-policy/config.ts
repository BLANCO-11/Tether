/**
 * V8 — the versioned policy dataset (FR-017). Plain data: product names,
 * aliases, distinguishing-feature signatures, feature-substitute mappings,
 * and the intent lexicons the rules match against. No functions here.
 *
 * **The dataset is deliberately incomplete and will stay that way (FR-014,
 * FR-015).** It only needs entries for products whose feature set is
 * genuinely distinguishing — not an exhaustive catalog. Absence of a match
 * defaults to `allow` in the combinator, never to `reject`.
 *
 * `version` MUST be bumped whenever `products`, `featureSubstitutes`, or
 * `intentLexicon` changes — `config.test.ts` asserts this so a content change
 * without a version bump fails a test rather than silently making a past
 * decision unexplainable (FR-020).
 *
 * ── ⚠ WHAT "DELIBERATELY INCOMPLETE" COSTS, MEASURED ────────────────────────
 *
 * Ten products are listed. Reported from real use on 2026-08-18 — *"this is
 * hardcoded for the scope of slack only, what if anyone uses any other name?"* —
 * and the answer measured against this dataset: identical reproduction language
 * about anything not listed is ALLOWED. `build an exact clone of Slack` rejects;
 * `…of Notion`, `…of WhatsApp`, `…of Trello`, `…of Zoom`, `…of Jira`,
 * `…of Shopify`, `…of Airtable`, `…of ServiceNow` and
 * `make a pixel-perfect copy of Linear` all allow. **Nine of ten.**
 *
 * That is working as designed and the design was not changed: the only pattern
 * permitted to reject unilaterally is an explicit product name plus explicit
 * reproduction intent, because a generic "clone of <ProperNoun>" rule refuses
 * real work — "a clone of our old Access database", "an exact copy of the Q3
 * spreadsheet". Widening it is a product decision, not a tidy-up, and it needs a
 * false-positive pass before it ships.
 *
 * ⚠ **What DID change is that the bound is now on screen.** The refusal panel
 * used to read as a general anti-cloning guarantee; `packages/client/src/lib/
 * policy-copy.ts`'s `POLICY_SCOPE_NOTE` states that this looks for specific named
 * products and that an unflagged request has not been assessed for originality at
 * all, with tests pinning that the copy never claims otherwise and never prints
 * this list (a list on screen is a spec for evading the check).
 *
 * ⚠ **Adding an entry here does not need the UI to change, and must not.** The
 * copy is deliberately count-free and name-free so this dataset can grow without
 * a screen going stale.
 */

export interface ProductEntry {
  readonly name: string;
  readonly aliases: readonly string[];
  /** Deliberately short — features rare enough to fingerprint this one product, not shared conveniences (FR-014). */
  readonly distinguishingFeatures: readonly string[];
}

export interface FeatureSubstitute {
  /** Must match a `distinguishingFeatures` entry of at least one product — enforced by config.test.ts. */
  readonly feature: string;
  /** Used in a TRANSFORM proposal (FR-009) — a generic capability, never a competitor's name. */
  readonly substitute: string;
}

export interface IntentLexicon {
  readonly reproduction: readonly string[];
  /**
   * Build-verbs that make "<verb> [me] [a/an/the] <product>" itself
   * reproduction intent (rules.ts's `bareProductRequest`), even when no
   * `reproduction` phrase appears anywhere else in the request. Kept as its
   * own list rather than folded into `reproduction` — the two lexicons feed
   * different matchers (anywhere-in-text phrase containment vs. a
   * sentence-initial verb pattern) — but versioned alongside it so adding a
   * verb here is still covered by this file's FR-020 version-bump discipline.
   */
  readonly bareBuildVerbs: readonly string[];
  readonly differentiation: {
    readonly alternative: readonly string[];
    readonly interop: readonly string[];
    readonly similar: readonly string[];
    /**
     * A regex **source string** (never a compiled `RegExp` — same reason as
     * `@foundry/shared`'s existing rule tables: a shared `RegExp` would carry
     * `lastIndex` state across consumers). Matches "X for Y" generically
     * ("Uber for doctors") rather than enumerating every domain word, since
     * the domain side is open-ended by definition.
     */
    readonly verticalPattern: string;
  };
}

export interface PolicyConfig {
  readonly version: string;
  readonly products: readonly ProductEntry[];
  readonly featureSubstitutes: readonly FeatureSubstitute[];
  readonly intentLexicon: IntentLexicon;
}

export const policyConfig: PolicyConfig = {
  version: "1",
  products: [
    {
      name: "Facebook",
      aliases: ["facebook", "fb"],
      distinguishingFeatures: ["friend graph", "news feed", "marketplace", "pages", "poke"],
    },
    {
      name: "Instagram",
      aliases: ["instagram", "insta", "the gram"],
      distinguishingFeatures: ["stories", "reels", "explore"],
    },
    {
      name: "Slack",
      aliases: ["slack"],
      distinguishingFeatures: ["channels", "threads", "workspace"],
    },
    {
      name: "Salesforce",
      aliases: ["salesforce"],
      distinguishingFeatures: ["opportunity pipeline", "einstein forecasting"],
    },
    {
      name: "Stripe",
      aliases: ["stripe"],
      distinguishingFeatures: ["payment intents api", "connect marketplace payouts"],
    },
    {
      name: "SAP",
      aliases: ["sap"],
      distinguishingFeatures: ["module-based erp configuration", "abap customization"],
    },
    {
      name: "Uber",
      aliases: ["uber"],
      distinguishingFeatures: ["real-time driver dispatch", "surge pricing", "rider-driver rating"],
    },
    {
      name: "Uber Eats",
      aliases: ["uber eats", "ubereats"],
      distinguishingFeatures: ["restaurant delivery dispatch", "courier live tracking for food orders"],
    },
    {
      name: "GitHub",
      aliases: ["github"],
      distinguishingFeatures: ["pull requests", "forks", "actions ci"],
    },
    {
      name: "Figma",
      aliases: ["figma"],
      distinguishingFeatures: ["multiplayer canvas", "auto layout components"],
    },
  ],
  featureSubstitutes: [
    { feature: "friend graph", substitute: "user connections" },
    { feature: "news feed", substitute: "activity feed" },
    { feature: "marketplace", substitute: "listings" },
    { feature: "pages", substitute: "organization profiles" },
    { feature: "poke", substitute: "a lightweight greeting notification" },
    { feature: "stories", substitute: "temporary posts" },
    { feature: "reels", substitute: "short videos" },
    { feature: "explore", substitute: "a discovery feed" },
    { feature: "channels", substitute: "topic-based rooms" },
    { feature: "threads", substitute: "message replies" },
    { feature: "workspace", substitute: "team space" },
    { feature: "pull requests", substitute: "change proposals" },
    { feature: "forks", substitute: "project copies" },
    { feature: "actions ci", substitute: "automated build pipelines" },
    { feature: "multiplayer canvas", substitute: "a shared real-time canvas" },
    { feature: "auto layout components", substitute: "reusable layout components" },
    { feature: "restaurant delivery dispatch", substitute: "local delivery coordination" },
    { feature: "courier live tracking for food orders", substitute: "live delivery tracking" },
    // Deliberately no substitute for a few features (FR-009's fallback path,
    // exercised by transform.test.ts / combinator.test.ts): a distinguishing
    // feature this specific to a business model has no honest generic rename.
    // "opportunity pipeline", "einstein forecasting", "payment intents api",
    // "connect marketplace payouts", "module-based erp configuration",
    // "abap customization", "real-time driver dispatch", "surge pricing",
    // "rider-driver rating" intentionally omitted.
  ],
  intentLexicon: {
    reproduction: ["clone", "exact copy", "exactly", "identical", "replicate", "rebuild"],
    bareBuildVerbs: ["build", "create", "make", "clone", "copy", "replicate", "rebuild"],
    differentiation: {
      alternative: ["alternative to", "alternative for", "alternative"],
      interop: ["compatible with", "interoperable with"],
      similar: ["like", "similar to", "similar for"],
      // "Uber for doctors", "Notion for construction companies" — the word
      // right after "for" is the differentiator, whatever it is.
      verticalPattern: "\\bfor\\s+[a-z][a-z\\s]*$",
    },
  },
};
