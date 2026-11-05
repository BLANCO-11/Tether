/**
 * V8 — assembling a TRANSFORM proposal (FR-009). Templated, data-driven: the
 * substance (which feature became which substitute) comes from
 * `config.featureSubstitutes`, never freeform generation, so the output stays
 * fixture-testable. Returns `null` when a flagged feature has no mapping —
 * the combinator must fall back to REJECT-with-explanation in that case, not
 * fabricate a substitution.
 */
import type { Evidence } from "./evidence.js";
import type { PolicyConfig } from "./config.js";

const BOILERPLATE =
  "Your request references an existing commercial product. It has been converted into an " +
  "original application specification that preserves the overall goal while avoiding " +
  "product-specific branding, workflows, and proprietary functionality.";

/**
 * Random, not derived from evidence content. Article X / FR-018's
 * reproducibility requirement is about the *decision* (decision/reason/
 * evidence/proposal.task) being identical for identical input — it was never
 * a requirement on the identifier. An earlier version derived proposalId from
 * evidence content instead, which made it a publicly-computable value (same
 * config, same product -> same id, guessable by anyone). That was safe only
 * because the caller separately re-evaluates the submitted text on
 * resubmission (`request-policy.service.ts`) rather than trusting the id —
 * but there was no actual benefit to the id being predictable, and a random
 * id removes the enumerability for free.
 */
function proposalIdFor(): string {
  return `policy-proposal-${crypto.randomUUID()}`;
}

export interface BuildProposalResult {
  readonly proposalId: string;
  readonly task: string;
}

/**
 * Given capability-signature evidence, build a rewritten task substituting
 * every matched feature with its generic counterpart. Returns `null` if any
 * matched feature has no `featureSubstitutes` entry (FR-009's fallback path).
 */
export function buildProposal(
  evidence: Evidence & { kind: "capabilitySignature" },
  config: PolicyConfig,
): BuildProposalResult | null {
  const substitutes = new Map(config.featureSubstitutes.map((s) => [s.feature, s.substitute]));
  const mapped: string[] = [];
  for (const feature of evidence.matched) {
    const sub = substitutes.get(feature);
    if (!sub) return null; // no honest generic rename available — do not guess
    mapped.push(sub);
  }

  const task =
    `Build an original application with the following capabilities: ${mapped.join(", ")}. ` +
    BOILERPLATE;

  return { proposalId: proposalIdFor(), task };
}

// ⚠ `export { BOILERPLATE as TRANSFORM_BOILERPLATE }` was here and is removed: it
// had no importer in any package. It came across with the port from a branch whose
// client rendered the proposal text itself and needed the constant to strip it
// again; on this branch a proposal is built here and travels whole, so the alias
// was a public name for an internal string. Re-export it the day something needs
// it, not before — an unused export reads as an extension point somebody chose.
