# Phase 1 Data Model: Request Policy Engine (V8)

No database schema changes (Decisions D5). Everything below is TypeScript
types in `@foundry/shared`, consumed by both `packages/server` and
`packages/client`.

## Evidence

One fact produced by exactly one rule. A discriminated union so the
combinator can pattern-match on `kind` without any rule needing to know about
another rule's shape.

```ts
type Evidence =
  | { kind: "productReference"; product: string; matchedAlias: string }
  | { kind: "reproductionIntent"; phrase: string }
  | { kind: "differentiationQualifier"; phrase: string; qualifierKind: "alternative" | "interop" | "similar" | "vertical" }
  | { kind: "capabilitySignature"; product: string; matched: string[]; missing: string[] };
```

- **Validation rules**: `product` values MUST correspond to an entry in
  `PolicyConfig.products`; `matched`/`missing` are drawn only from that
  product's `distinguishingFeatures`. Enforced by a fixture/unit test, not a
  runtime assertion (this is internal-consistency between rule output and
  config, not external input).
- **Relationships**: many `Evidence` items feed one `PolicyDecision`. No
  evidence item references another.

## Rule capability metadata

Static, per-rule data read by the combinator (FR-007) — not computed, not
inferred from the rule's evidence at call time.

```ts
type RuleCapability = {
  name: string;
  canRejectAlone: boolean; // only productReference+reproductionIntent co-occurrence, per FR-013
};
```

## PolicyConfig

The versioned, data-only configuration consumed identically by both packages
(FR-017).

```ts
type ProductEntry = {
  name: string;
  aliases: string[];
  distinguishingFeatures: string[]; // deliberately short — FR-014
};

type FeatureSubstitute = {
  feature: string; // matches a distinguishingFeatures entry
  substitute: string; // used in a TRANSFORM proposal, FR-009
};

type IntentLexicon = {
  reproduction: string[]; // "clone", "exact", "identical", "rebuild", "replicate", ...
  differentiation: {
    alternative: string[]; // "alternative to", "open-source ... alternative"
    interop: string[]; // "compatible with", "interoperable with"
    similar: string[]; // "like", "similar to"
    vertical: string[]; // "but for", "for [domain]" — pattern, not literal list
  };
};

type PolicyConfig = {
  version: string; // stamped onto every PolicyDecision, FR-020
  products: ProductEntry[];
  featureSubstitutes: FeatureSubstitute[];
  intentLexicon: IntentLexicon;
};
```

**State/lifecycle**: `PolicyConfig` is immutable data checked into
`@foundry/shared`. A change to it is a data-only PR (FR-017); `version` MUST
be bumped whenever `products`, `featureSubstitutes`, or `intentLexicon`
changes, verified by a test that fails if content changes without a version
bump.

## PolicyDecision

The combinator's output (FR-006, FR-019).

```ts
type PolicyDecision =
  | {
      decision: "allow";
      evidence: Evidence[];
      reason: string;
      configVersion: string;
      originalRequest: string;
    }
  | {
      decision: "transform";
      evidence: Evidence[];
      reason: string;
      configVersion: string;
      originalRequest: string;
      proposal: { proposalId: string; task: string };
    }
  | {
      decision: "reject";
      evidence: Evidence[];
      reason: string;
      configVersion: string;
      originalRequest: string;
    };
```

- **`proposalId`**: an opaque identifier the client echoes back via
  `acceptedTransform.proposalId` on resubmission (Decisions D3), so the server
  can confirm the accepted text matches what was actually proposed rather than
  trusting an arbitrary client-supplied string as "the accepted rewrite."
- **Non-goal**: no `confidence` field, no numeric score anywhere in this type
  (spec Clarifications — evidence and reason only).

## EvaluationMode

```ts
type EvaluationMode = "confirmation-available" | "confirmation-unavailable";
```

Passed into the combinator alongside the evidence array; not stored, not part
of `PolicyDecision` (the decision itself doesn't need to remember which mode
produced it beyond what `decision` already encodes — a `"reject"` produced
under confirmation-unavailable mode for what would have been TRANSFORM is
indistinguishable in shape from an FR-013 REJECT, which is intentional: the
caller does not need to know *why* it was a REJECT to handle it correctly, and
`reason` still states the actual evidence either way).

## ResolvedRequest

The input every rule reads (plain data, no service dependency):

```ts
type ResolvedRequest = {
  task: string; // the operator's current wording, at whichever evaluation pass this is
};
```

Kept minimal deliberately — rules operate on text only, per spec scope. No
manifest, no tool list, no workspace id reaches a rule.
