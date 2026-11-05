import type { NextFunction, Request, Response } from "express";
import { superAdminHere } from "../services/workspace-restriction.service.js";
import { stepApprovalService } from "../services/step-approval.service.js";
import { contentVisibility } from "../services/content-visibility.service.js";
import { config } from "../config/index.js";
import { asyncHandler } from "./error.middleware.js";

/**
 * Gate 3's self-decision refusal — archive/GAPS.md §1.1b · D-70.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 *
 * Gate 2 refuses self-approval by comparing the approver against
 * `flow_revisions.created_by`. Gate 3 could not: an execution recorded nobody,
 * so `routes/step-approvals.ts` said, correctly, *"a comparison with nothing to
 * compare to would be ceremony"*. §1.1b is that absence. `flow_executions` now
 * records **who asked for the run** (D-70), so the comparison has a subject and
 * this is it.
 *
 * ── What it does and does not buy ────────────────────────────────────────────
 *
 * ⚠ **Say: the person who started a run cannot also approve its pause.** It is
 * still NOT separation of duties (I-13) — anything holding `RUNTIME_JWT_SECRET`
 * mints any identity, so both sides of the comparison rest on that secret. The
 * bar moved from *"the role is the whole control"* to *"the role, plus you are
 * not the person who asked for this"*.
 *
 * ⚠ **It compares SUBJECTS, never names.** An email can be reassigned, and gate
 * 2's string comparison is the weaker half of this pair precisely because it has
 * only a name to work with (I-32). Where there is no subject on either side
 * there is no comparison to make and the request proceeds — which is the honest
 * outcome and is stated in the run view rather than hidden:
 *
 *   * a **scheduled** run has no requester, so nobody can be it;
 *   * a **trigger** fire has no person behind it;
 *   * a **harness** run is `system`;
 *   * a run from before migration 0029 is `unknown`, and inventing a requester
 *     for it would be worse than admitting the record does not exist.
 *
 * A refusal that fired on `unknown` would block every historical run's pause on
 * a fact nobody recorded — and the fix people would reach for is deleting the
 * check (I-38 by the usual road).
 *
 * ⚠ **At the ROUTE, like `requireWorkspaceRole` (D-67) and the provenance gate
 * (D-69), and for the same reason**: it needs `req.user`, and `kestra:hitl`
 * calls `stepApprovalService.decide` directly with no identity at all. In the
 * service this would be satisfied by a constant or would break the harness.
 */
export function requireNotRunRequester() {
  return asyncHandler(async function selfDecisionGate(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const workspaceId = req.params.workspaceId;
    const approvalId = req.params.approvalId;
    if (!workspaceId || !approvalId) {
      // A wiring mistake is a 500 naming itself, never a pass — mounting this
      // where the params are absent would turn the refusal off silently.
      return res.status(500).json({
        error: "misconfigured",
        message:
          "requireNotRunRequester is mounted where :workspaceId/:approvalId are not both in scope",
      });
    }

    const run = await stepApprovalService.requesterOfRun(workspaceId, approvalId);
    // Not found is `decide`'s business — it distinguishes a missing approval
    // from another tenant's with one 404, and duplicating that judgement here
    // would give the two paths two chances to disagree.
    if (!run) return next();

    // ⚠ Sharing boundaries (2026-10-30, P1-D1/D2): only the workflow's OWNER decides its pauses (or an Admin when it
    // has no owner). Reviewers judge whether a workflow is valid, not its execution.
    const viewer = await contentVisibility.viewer(req.user, workspaceId);
    // The run's own decider: whoever's account it used (sharing-boundaries P3-I2), else the workflow's owner.
    const decides = run.actsAs ?? run.owner ?? null;
    if (!contentVisibility.mayDecidePause(viewer, decides, run.named ?? null)) {
      return res.status(403).json({
        error: "not_the_decider",
        message: run.actsAs
          ? `This run used another person's own account, so they decide its pauses${run.named ? ", or the person its step names" : ""}.`
          : run.owner
            ? `Only the owner of "${run.flowName ?? "this workflow"}"${run.named ? ", or the person its step names," : ""} decides its pauses.`
            : `"${run.flowName ?? "This workflow"}" has no owner, so an Admin decides its pauses.`,
      });
    }

    const decider = req.user?.subject;
    if (!decider || !run.subject) return next();
    if (decider !== run.subject) return next();
    // ⚠ The owner decides their own workflow's pause even on a run they started: in My space nobody else can see it,
    // and the user chose the owner as the decider for shared ones too (P1-D2). The refusal below still holds for
    // anybody else who decides a run they started.
    if (decider === decides || decider === run.named) return next();

    /**
     * ⚠ **A SUPER ADMIN DECIDES ANYWAY, and this is gate 3's half of the same
     * trade gate 2 now makes.** Asked for directly: a super admin has full
     * access in every workspace, approvals and rejections included. On a
     * single-operator deployment the person who starts the run is the only
     * person who could ever decide its pause, so an absolute refusal parks every
     * gated flow for ever.
     *
     * ⚠ The claim to make afterwards is *"a non-super-admin cannot decide a
     * pause on a run they started"*. Not the unqualified sentence.
     *
     * Logged, because unlike gate 2 there is no column to record it in: a step
     * approval's row has no field for an override, and inventing one here would
     * be a schema change on the strength of a log line. The log is the trace.
     */
    if (await superAdminHere(req.user, workspaceId)) {
      console.warn(
        `[gate3] SELF-DECISION OVERRIDE — "${run.actor}" is a super admin and decided the pause ` +
          `on approval ${approvalId}, on a run they started themselves.`,
      );
      return next();
    }

    return res.status(403).json({
      error: "self_decision",
      message:
        `you started this run (as "${run.actor}"), so you cannot also approve the step it ` +
        `paused on. This workflow has no owner, so another Admin of this workspace has to decide it.`,
      requestedBy: run.actor,
      requestedByKind: run.kind,
    });
  });
}
