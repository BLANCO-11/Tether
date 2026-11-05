/**
 * V8 — the shapes rules and the combinator exchange. Rules never decide an
 * outcome (FR-004); they return one of these per match. The combinator is the
 * only place that turns evidence into a `PolicyDecision` (FR-006).
 *
 * No confidence floats anywhere in these types, on purpose — a finding is a
 * named fact (which product, which phrase, which features), never a score
 * (spec Clarifications).
 */

/** A discriminated union so the combinator can pattern-match on `kind` without any rule knowing about another rule's shape. */
export type Evidence =
  | { readonly kind: "productReference"; readonly product: string; readonly matchedAlias: string }
  | { readonly kind: "reproductionIntent"; readonly phrase: string }
  | {
      readonly kind: "differentiationQualifier";
      readonly phrase: string;
      readonly qualifierKind: "alternative" | "interop" | "similar" | "vertical";
    }
  | {
      readonly kind: "capabilitySignature";
      readonly product: string;
      readonly matched: readonly string[];
      readonly missing: readonly string[];
    };

/**
 * Static, per-rule metadata. Declared so a future combinator change could
 * dispatch on capability instead of hardcoding a rule's identity — the
 * combinator does not currently read this field; `decide()` still branches
 * directly on evidence kind (FR-007's stated intent is aspirational, not yet
 * implemented).
 */
export interface RuleCapability {
  readonly name: string;
  /** Only true for the evidence pattern FR-013 permits to reject unilaterally. */
  readonly canRejectAlone: boolean;
}

/** Whether a human can respond to a TRANSFORM proposal (FR-010) — a property of the calling context, not of a UI. */
export type EvaluationMode = "confirmation-available" | "confirmation-unavailable";

/** What every rule reads. Deliberately just text — no manifest, no tool list, no workspace id (plan.md Decisions D1). */
export interface ResolvedRequest {
  readonly task: string;
}

/** A rewrite proposed under TRANSFORM (FR-009). */
export interface PolicyProposal {
  readonly proposalId: string;
  readonly task: string;
}

/** The combinator's output (FR-006, FR-019). Every branch carries the same shared fields plus its own. */
interface DecisionBase {
  readonly evidence: readonly Evidence[];
  readonly reason: string;
  readonly configVersion: string;
  readonly originalRequest: string;
}

export type PolicyDecision =
  | (DecisionBase & { readonly decision: "allow" })
  | (DecisionBase & { readonly decision: "transform"; readonly proposal: PolicyProposal })
  | (DecisionBase & { readonly decision: "reject" });
