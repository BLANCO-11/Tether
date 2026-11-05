/**
 * V8 — the request → expected-decision table shared by every test suite that
 * needs one (rules, combinator, and the client/server equivalence test), per
 * V7's `rules.cases.ts` precedent. Adding a case here is how a new edge case
 * gets covered everywhere at once.
 */
import type { EvaluationMode, PolicyDecision } from "./evidence.js";

export interface PolicyFixture {
  readonly description: string;
  readonly request: string;
  readonly mode: EvaluationMode;
  readonly expected: PolicyDecision["decision"];
}

export const policyFixtures: readonly PolicyFixture[] = [
  // --- US1: explicit clones, reproduction intent named alongside a product ---
  { description: "bare clone request", request: "Build Facebook", mode: "confirmation-available", expected: "reject" },
  {
    description: "explicit exact-copy phrasing",
    request: "Clone Instagram exactly",
    mode: "confirmation-available",
    expected: "reject",
  },
  {
    description: "rebuild phrasing",
    request: "Rebuild Facebook from scratch",
    mode: "confirmation-available",
    expected: "reject",
  },

  // --- US2: category-level requests, no product named ---
  {
    description: "category only, no product",
    request: "Build a social media platform",
    mode: "confirmation-available",
    expected: "allow",
  },
  {
    description: "category only, CRM",
    request: "Build a CRM",
    mode: "confirmation-available",
    expected: "allow",
  },
  {
    description: "category only, video sharing",
    request: "Build a video sharing platform",
    mode: "confirmation-available",
    expected: "allow",
  },

  // --- US2: named product, alternative/interop framing, no reproduction intent ---
  {
    description: "alternative framing suppresses an otherwise-named product",
    request: "Build an open-source Slack alternative",
    mode: "confirmation-available",
    expected: "allow",
  },
  {
    description: "similar-to framing",
    request: "Build a CRM like Salesforce",
    mode: "confirmation-available",
    expected: "allow",
  },
  {
    description: "interoperability framing",
    request: "Build a PostgreSQL-compatible database",
    mode: "confirmation-available",
    expected: "allow",
  },
  {
    description: "interoperability framing, different product",
    request: "Build a browser compatible with Chrome extensions",
    mode: "confirmation-available",
    expected: "allow",
  },
  {
    description: "similar-to framing, payments",
    request: "Build a payment gateway like Stripe",
    mode: "confirmation-available",
    expected: "allow",
  },
  {
    description: "similar-to framing, ERP",
    request: "Build an ERP like SAP",
    mode: "confirmation-available",
    expected: "allow",
  },

  // --- Vertical differentiation: named business model, novel or uncataloged domain ---
  {
    description: "named business model, uncataloged/novel vertical",
    request: "Build an Uber for doctors",
    mode: "confirmation-available",
    expected: "allow",
  },
  {
    description:
      "named business model, a vertical Uber Eats already occupies — but bare naming, no feature description, still allows (FR-016: matching requires the domain product's own signature, not a vertical-phrase heuristic)",
    request: "Build an Uber for restaurants",
    mode: "confirmation-available",
    expected: "allow",
  },
  {
    description:
      "the SAME restaurant-delivery vertical, but now described by Uber Eats's actual distinguishing features with no product name",
    request:
      "Build a food delivery app with restaurant delivery dispatch and courier live tracking for food orders, ready to launch nationwide",
    mode: "confirmation-available",
    expected: "transform",
  },

  // --- US3: unnamed but feature-matching request ---
  {
    description: "unnamed Facebook-signature match, confirmation available",
    request: "Build a blue social network with a friend graph, a news feed, a marketplace, and pages",
    mode: "confirmation-available",
    expected: "transform",
  },

  // --- US4: the identical evidence, confirmation unavailable ---
  {
    description: "unnamed Facebook-signature match, confirmation unavailable",
    request: "Build a blue social network with a friend graph, a news feed, a marketplace, and pages",
    mode: "confirmation-unavailable",
    expected: "reject",
  },
];
