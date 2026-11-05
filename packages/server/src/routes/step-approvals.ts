import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { stepApprovalService, decideSchema } from "../services/step-approval.service.js";
import { actorOf, requireIdentity, requireWorkspaceRole } from "../middleware/identity.middleware.js";
import { requireNotRunRequester } from "../middleware/run-requester.middleware.js";
import { contentVisibility } from "../services/content-visibility.service.js";

/**
 * Gate 3's client surface — the approvals inbox and the decision.
 * 05 §6.5 · Stage 3
 *
 * Mounted under `/api/workspaces/:workspaceId/step-approvals`, behind the parent
 * API key like every other client route. Two things about the addressing:
 *
 *  * **An approval is named by ITS OWN id**, never by a Kestra taskrun (R5). The
 *    task to resume is stored server-side on the row and resolved there. This is
 *    the same rule replay follows — §6.3's diagram ends `{taskRunId}` and the API
 *    takes `{ fromStepId }`.
 *  * **The workspace comes from the path and is enforced by a join**, not by a
 *    filter the caller supplies. `decide` looks the row up through
 *    `flow_executions.workspace_id`, so naming another tenant's approval id is a
 *    404 rather than a decision.
 *
 * ⚠ There is no "undecide". A decision is closed by timestamp and a second one
 * is a 409 — the same discipline as `flow_approvals`. To stop a run that is still
 * going, cancel the execution; that is a different act with a different record.
 */
export const stepApprovalsRouter = Router({ mergeParams: true });

/** The inbox: everything in this workspace still waiting on a person. */
stepApprovalsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    // The pauses this person decides: their own workflows' (and an Admin's: ownerless ones) — sharing-boundaries P1-D1.
    const pauses = contentVisibility.pausesWhere(await contentVisibility.viewer(req.user, req.params.workspaceId));
    res.json({ approvals: await stepApprovalService.listPending(req.params.workspaceId, pauses) });
  }),
);

/**
 * Every approval on one execution, decided or not.
 *
 * Under `/step-approvals` rather than under `/flow-executions/:id` because it is
 * the same resource read a different way, and because `flow-executions` is the
 * REDACTED engine-assembly surface (D-07) — putting a second reader with its own
 * redaction rules behind that path is how the two eventually disagree.
 */
stepApprovalsRouter.get(
  "/execution/:executionId",
  asyncHandler(async (req, res) => {
    const out = await stepApprovalService.listForExecution(
      req.params.workspaceId,
      req.params.executionId,
    );
    if (out === undefined) return res.status(404).json({ error: "not_found" });
    res.json({ approvals: out });
  }),
);

/**
 * Decide.
 *
 * ⚠ **`decidedBy` is VERIFIED as of Stage 9.1** and no longer read from the
 * body — the schema is `.strict()`, so sending it is a 400. It comes from a
 * signed identity token checked against a secret that is not `PARENT_API_KEY`,
 * so holding the API key no longer lets a caller name a decider.
 *
 * ⚠ **There IS a self-decision refusal now** (GAPS §1.1b, D-70), and the
 * paragraph that used to sit here explained why there could not be: *"gate 2 has
 * a recorded revision AUTHOR to compare against, and an execution has no author
 * — it was started by a schedule, a trigger or a test run."* That was true and
 * is the gap that got closed: `flow_executions` now records WHO ASKED for the
 * run, so the comparison has a subject.
 *
 * It compares identity SUBJECTS, and it stands down where there is genuinely
 * nobody — a schedule, a trigger fire, a harness, or a run that predates the
 * column. Still not separation of duties (I-13). Say: *the person who started a
 * run cannot also approve its pause.*
 */
stepApprovalsRouter.post(
  "/:approvalId/decide",
  requireIdentity,
  // GAPS §1.1 — may this person decide in this workspace at all. A Creator may since sharing-boundaries (2026-10-30):
  // the OWNER decides a pause; `requireNotRunRequester` holds it to them.
  requireWorkspaceRole("author"),
  // GAPS §1.1b, D-70 — the second layer the role check used to be alone without.
  requireNotRunRequester(),
  asyncHandler(async (req, res) => {
    const input = decideSchema.parse(req.body);
    res.json({
      approval: await stepApprovalService.decide(req.params.workspaceId, req.params.approvalId, {
        ...input,
        decidedBy: actorOf(req),
      }),
    });
  }),
);
