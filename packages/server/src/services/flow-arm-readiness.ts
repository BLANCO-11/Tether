// src/services/flow-arm-readiness.ts — gate 1, as ONE definition with TWO callers.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ WHY THIS IS ITS OWN MODULE
// ─────────────────────────────────────────────────────────────────────────────
//
// `flowEnableReadiness` lived in `trigger.service.ts`, whose only caller was the
// trigger-enable path. Publishing now also arms the capacity a flow was built
// in, so `flow-approval.service.ts` needs the identical answer — and it cannot
// import it, because `trigger.service.ts` imports `flowApprovalService`. That is
// a cycle, and the two ways out of it are both bad:
//
//   * Re-deriving "has this flow ever succeeded" inside the approval service
//     would be a SECOND definition of gate 1 (D-197). Two copies of a gate drift
//     in the direction where the untested one stops refusing, and nothing
//     reports it.
//   * Doing the arming in `routes/approvals.ts`, where both services are already
//     reachable, would mean every harness, seed and CLI that arms a flow through
//     the service — `kestra:phase3`, `showcase:seed`, `scenarios:seed`,
//     `catalogue:flows`, `e2e:ui` — silently does not arm it. Route placement is
//     for checks that need `req.user` (D-67); this one needs no identity.
//
// So the gate moved down to a leaf both can import. Its reasoning is unchanged
// and is reproduced below verbatim, because it is the argument for the gate
// existing at all.
//
// ⚠ **NOTHING ABOUT THE GATE WAS RELAXED BY THE MOVE.** Gate 1 for APPROVAL was
// downgraded to a warning on 2026-09-07 at the user's request ("switch to any
// version even if never run"); this is the TRIGGER gate, it is still a hard
// refusal, and the two are deliberately not the same. Approving records that a
// person read a version. Arming lets it fire with nobody watching.
import { flowRepo } from "../repositories/flow.repo.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { flowExpectationService } from "./flow-expectation.service.js";

/**
 * WS-H0.2 — the enable gate.
 *
 * A trigger may be enabled only once its bound flow has completed at least one
 * run. The script-bound half of this gate was deleted with `scripts` in Phase 4
 * (task 4.11); the reasoning it was written for is why the flow half exists, so
 * it is kept here rather than lost with the code:
 *
 *   The old gate certified that the AGENT's own self-test had passed. Measured
 *   2026-07-26, a script with `status="completed"`, `tests_passed=true` and
 *   audit verdict `clean` hardcoded `period="2023-10"` and emailed 0 of 11
 *   people. That gate would have let a schedule fire it for ever.
 *
 * Hence "has it ever actually run", not "did generation say it was fine". The
 * sequence is draft → test-run → then arm.
 *
 * DELIBERATE LIMIT, stated out loud: this proves the automation ran once, not
 * that it produced the right result. Only the oracle does that (WS-F). **An
 * enabled trigger is not a correctness guarantee.**
 */
export interface EnableReadiness {
  ready: boolean;
  reason: string | null;
}

/**
 * Gate 1 only — "has this flow ever completed a run" (task 3.6).
 *
 * Note what it does NOT check: whether the flow is approved. That is gate 2 and
 * it is reported alongside, not folded in — a webhook trigger on an unapproved
 * flow must say "waiting for approval", not "not ready", or the Triggers page
 * presents a dead switch with no explanation. This is the same mistake as the
 * removed localStorage go-live gate.
 *
 * ⚠ That separation is also what makes it safe to call from inside `approve`:
 * the answer does not depend on the approval, so asking before or after the
 * approval row is written gives the same result.
 */
export async function flowEnableReadiness(
  workspaceId: string,
  flowId: string,
): Promise<EnableReadiness> {
  const flow = await flowRepo.get(workspaceId, flowId);
  if (!flow) return { ready: false, reason: "The flow this trigger is bound to no longer exists." };
  if (flow.draftRevision < 1) {
    return { ready: false, reason: "The flow has no revision yet, so there is nothing to run." };
  }
  if (!(await flowExecutionRepo.hasSucceeded(flow.id))) {
    return {
      ready: false,
      reason:
        "The flow has never completed a run. Start a test run against the draft namespace and " +
        "check the result, then this trigger can be enabled.",
    };
  }

  // ── Gate 1's second half — archive/GAPS.md §2.3, D-68 ──────────────────────────────
  //
  // Until now the gate stopped here, and "completed" was all it meant. The
  // measured failure this migration exists to fix passed it: a script that
  // emailed 0 of 11 people exited 0.
  //
  // ⚠ A flow that declares nothing is unchanged. Refusing every flow that has
  // not opted in would be a day-one refusal everybody routes around, and what
  // gets routed around is the control (D-52's argument for sandboxes, again).
  const draft = await flowRepo.getRevision(flow.id, flow.draftRevision);
  const outcome = await flowExpectationService.gateOutcome(flow.id, draft?.modelJson);
  if (!outcome.satisfied) {
    return {
      ready: false,
      reason:
        `This flow declares ${outcome.declared} expectation(s) about its own output and ` +
        `${outcome.unmet.length} of them (${outcome.unmet.map((e) => `"${e.id}"`).join(", ")}) ` +
        `has not passed on a successful run yet. Start a test run — or, if the expectation is ` +
        `the thing that is wrong, correct it.`,
    };
  }
  return { ready: true, reason: null };
}
