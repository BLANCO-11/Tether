/**
 * V8 — thin server wrapper over `@foundry/shared`'s Request Policy Engine.
 * All decision logic lives in the shared combinator (FR-006); this module
 * only adds what the server specifically needs: tracking issued TRANSFORM
 * proposals so a resubmission can be verified against what was actually
 * proposed (plan.md Decisions D3), rather than trusting an arbitrary
 * client-supplied task string as "the accepted rewrite".
 */
import { evaluatePolicy, policyConfig, type EvaluationMode, type PolicyDecision } from "@foundry/shared";

// In-memory only, deliberately: a proposal is only ever meant to be confirmed
// or abandoned within the same generation attempt. No persistence is added
// for this (plan.md Decisions D5) — losing an in-flight proposal on a server
// restart just means the client re-evaluates from scratch, which is safe.
//
// Proposals expire after PROPOSAL_TTL_MS — an abandoned tab or a proposal the
// user never acts on shouldn't stay acceptable indefinitely, and without a
// bound the map would otherwise grow for as long as the process runs. This is
// operational hygiene, not a security fix: the accepted text is always
// re-evaluated regardless of the proposal's age (see `evaluate` below), so an
// expired-but-still-present entry couldn't be leveraged for anything even if the
// TTL check were absent.
//
// ⚠ That sentence used to cite `script-generation.service.ts`'s `start()`. That
// service was DELETED in the Kestra migration's Phase 4 (see CLAUDE.md, "The
// monolithic path is DELETED") and the citation came across with the port from a
// branch where it still existed. The call sites on this branch are
// `flow-generation-job.service.ts`'s `runGeneration()` and
// `flow-chat.service.ts`'s `turn()`.
const PROPOSAL_TTL_MS = 30 * 60 * 1000;
const issuedProposals = new Map<string, { task: string; issuedAt: number }>();

export interface EvaluateOptions {
  confirmationAvailable: boolean;
  /**
   * FR-021: reserved, unused. No caller in this feature may set this to
   * anything other than undefined/false — it exists so a future policy
   * bypass is additive to a known interface, not retrofitted as an
   * ad hoc escape hatch.
   */
  bypass?: { reason: string };
}

function toMode(confirmationAvailable: boolean): EvaluationMode {
  return confirmationAvailable ? "confirmation-available" : "confirmation-unavailable";
}

export const requestPolicyService = {
  /** Evaluate a fresh (or re-resolved) request. */
  evaluate(task: string, opts: EvaluateOptions): PolicyDecision {
    if (opts.bypass) {
      // FR-021: reserved parameter, deliberately inert in this feature.
      // Logged, never honored, so a future implementation has a real signal
      // to build on rather than silent scope creep.
      console.warn(
        "[request-policy] bypass parameter set but not implemented in this feature; ignoring and evaluating normally",
      );
    }
    const decision = evaluatePolicy({ task }, toMode(opts.confirmationAvailable), policyConfig);
    if (decision.decision === "transform") {
      issuedProposals.set(decision.proposal.proposalId, {
        task: decision.proposal.task,
        issuedAt: Date.now(),
      });
    }
    return decision;
  },

  /**
   * A resubmission after a shown TRANSFORM proposal. Returns the verified
   * task text to proceed with, or `null` if the proposalId doesn't match
   * anything this process actually issued, or the match has expired — in
   * either case the caller must treat the request as fresh and re-evaluate
   * it, not trust the supplied text blindly.
   */
  verifyAcceptedTransform(accepted: { proposalId: string; task: string }): string | null {
    const proposed = issuedProposals.get(accepted.proposalId);
    if (proposed === undefined) return null;
    // Single-use regardless of outcome: an expired or already-consumed
    // proposalId must not be usable again.
    issuedProposals.delete(accepted.proposalId);
    if (Date.now() - proposed.issuedAt > PROPOSAL_TTL_MS) return null;
    // The user may have edited the proposal before confirming (Story 3,
    // Scenario 2 — "their decision determines what proceeds") — accept their
    // edited text, not only the exact original proposal.
    return accepted.task;
  },
};
