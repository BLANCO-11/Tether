/**
 * V8 — the sole place evidence becomes a decision (FR-006). Reasons over the
 * full named evidence set; never a single opaque aggregate score. Reconciles
 * cross-cutting signals (FR-008) so no individual rule has to be
 * outcome-aware.
 */
import type { Evidence, EvaluationMode, PolicyDecision, ResolvedRequest } from "./evidence.js";
import type { PolicyConfig } from "./config.js";
import { buildProposal } from "./transform.js";
import { policyRules } from "./rules.js";

function findAll<K extends Evidence["kind"]>(
  evidence: readonly Evidence[],
  kind: K,
): (Evidence & { kind: K })[] {
  return evidence.filter((e): e is Evidence & { kind: K } => e.kind === kind);
}

function rejectReason(product: string, phrase: string): string {
  return (
    `Your request names "${product}" together with reproduction language ("${phrase}"). ` +
    "Foundry does not generate direct reproductions of an existing commercial product."
  );
}

function capabilityReason(product: string, matched: readonly string[]): string {
  return (
    `Your request describes several capabilities (${matched.join(", ")}) that closely match ` +
    `an existing commercial product ("${product}"), without naming it.`
  );
}

/**
 * Evaluate the full evidence set produced by every rule, under the given
 * mode, and produce exactly one decision (FR-003).
 */
export function decide(
  request: ResolvedRequest,
  evidence: readonly Evidence[],
  mode: EvaluationMode,
  config: PolicyConfig,
): PolicyDecision {
  const base = { evidence, configVersion: config.version, originalRequest: request.task };

  const productRefs = findAll(evidence, "productReference");
  const reproIntents = findAll(evidence, "reproductionIntent");
  const differentiations = findAll(evidence, "differentiationQualifier");
  const capabilityMatches = findAll(evidence, "capabilitySignature");

  // FR-008: differentiation/alternative-framing evidence suppresses what would
  // otherwise be a REJECT-eligible pattern, regardless of other evidence.
  const hasDifferentiation = differentiations.length > 0;

  // FR-013: only productReference + reproductionIntent together may reject unilaterally.
  if (productRefs.length > 0 && reproIntents.length > 0 && !hasDifferentiation) {
    const product = productRefs[0]!;
    const intent = reproIntents[0]!;
    return {
      ...base,
      decision: "reject",
      reason: rejectReason(product.product, intent.phrase),
    };
  }

  // FR-013/FR-012: capability-signature evidence alone can only reach TRANSFORM
  // (confirmation-available) or the REJECT that mode collapses to
  // (confirmation-unavailable) — never a unilateral REJECT of its own kind,
  // and never suppressed to ALLOW just because no product was named.
  if (capabilityMatches.length > 0 && !hasDifferentiation) {
    const match = capabilityMatches[0]!;
    const reason = capabilityReason(match.product, match.matched);

    if (mode === "confirmation-available") {
      const proposal = buildProposal(match, config);
      if (proposal) {
        return { ...base, decision: "transform", reason, proposal };
      }
      // FR-009: no honest substitute mapping exists for a matched feature —
      // do not guess. Fall back to REJECT-with-explanation even though a
      // human could confirm, because there is nothing safe to propose.
      return {
        ...base,
        decision: "reject",
        reason: `${reason} No safe original substitute could be generated for one or more of the matched capabilities.`,
      };
    }

    // FR-012: confirmation-unavailable — the identical evidence and the
    // identical reason text, just no proposal and a different decision.
    return { ...base, decision: "reject", reason };
  }

  return {
    ...base,
    decision: "allow",
    reason: hasDifferentiation
      ? "A named product was referenced alongside alternative, interoperability, or differentiation language, which is a legitimate engineering or competitive goal, not reproduction."
      : "No policy concerns identified.",
  };
}

/**
 * The single entry point — runs every rule, then `decide`.
 *
 * ⚠ This docblock claimed a second caller that does not exist: it named
 * `request-policy-client.ts` (client) beside `request-policy.service.ts`
 * (server), and there is no policy code in `packages/client` at all — the
 * client posts a goal and reads the outcome, which is the correct shape (a
 * policy decision the browser could compute is a policy decision the browser
 * could skip). The "equivalence test asserts both wrappers" sentence went with
 * it, because there is one wrapper and nothing to hold equivalent.
 *
 * The property that DOES need protecting is that the decision is reached in one
 * place: `request-policy.service.ts` is the only server caller, and if a client
 * evaluator is ever added it must call this function rather than reimplement the
 * rules. `request-policy.test.ts` pins the single-caller shape.
 */
export function evaluatePolicy(
  request: ResolvedRequest,
  mode: EvaluationMode,
  config: PolicyConfig,
): PolicyDecision {
  const evidence = policyRules.flatMap((rule) => rule.evaluate(request, config));
  return decide(request, evidence, mode, config);
}
