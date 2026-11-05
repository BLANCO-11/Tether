import { Router } from "express";
import { superAdminHere } from "../services/workspace-restriction.service.js";
import { asyncHandler } from "../middleware/error.middleware.js";
import { flowRepo } from "../repositories/flow.repo.js";
import {
  flowApprovalService,
  approveSchema,
  revokeSchema,
} from "../services/flow-approval.service.js";
import { actorOf, requireIdentity, requireWorkspaceRole } from "../middleware/identity.middleware.js";
import { requireProvenanceAuthority } from "../middleware/revision-provenance.middleware.js";
import { config } from "../config/index.js";

/**
 * Gate 2 — approve a revision to run unattended, and revoke it.
 * Mounted at `/api/workspaces/:workspaceId/flows/:flowId/approvals`.
 * archive/kestra-migration/05-lifecycle-and-flows.md §6.5 · 07 §7.2
 *
 * Its own router, not three more handlers on `routes/flows.ts`, because this is
 * the ONLY client-reachable path that writes to the live Kestra namespace.
 * Keeping it separate means "what can arm a schedule" is answerable by reading
 * one 80-line file.
 *
 * ⚠ **The approver is VERIFIED as of Stage 9.1, and the claim has an exact
 * size.** `approverUserId` is no longer read from the body; it comes from a
 * signed identity token the sign-in flow minted, checked against a secret that
 * is NOT `PARENT_API_KEY`. So holding the API key no longer lets you name an
 * approver — which is the specific thing I-13 recorded.
 *
 * It is still not §6.5's "a distinct authenticated human with the approver
 * role": the role is checked HERE (GAPS §1.1, `requireWorkspaceRole`) and not in
 * the service, and anything holding `RUNTIME_JWT_SECRET` can mint
 * a token (`e2e:ui` does, deliberately). The self-approval refusal is now real
 * on the APPROVER side and only as good as the recorded author on the other —
 * `created_by` is verified when the flow was authored through the browser and
 * self-asserted when it came from a harness or the drafter. See I-13 and I-32.
 */
export const approvalsRouter = Router({ mergeParams: true });

/** History + the current state, which is what an ApprovalPanel renders. */
approvalsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const flow = await flowRepo.get(req.params.workspaceId, req.params.flowId);
    if (!flow) return res.status(404).json({ error: "not_found" });
    res.json({
      state: await flowApprovalService.state(req.params.workspaceId, flow),
      approvals: await flowRepo.listApprovals(flow.id),
    });
  }),
);

/**
 * What the approver is signing off: draft vs armed, split into structure
 * changes (human re-approval) and fragment changes (automated re-test).
 */
approvalsRouter.get(
  "/diff",
  asyncHandler(async (req, res) => {
    const flow = await flowRepo.get(req.params.workspaceId, req.params.flowId);
    if (!flow) return res.status(404).json({ error: "not_found" });
    const to = req.query.to ? Number(req.query.to) : flow.draftRevision;
    const from = req.query.from !== undefined ? Number(req.query.from) : flow.armedRevision;
    if (!Number.isInteger(to)) return res.status(400).json({ error: "bad_revision" });
    res.json(
      await flowApprovalService.diff(
        req.params.workspaceId,
        req.params.flowId,
        from == null || Number.isNaN(from) ? null : from,
        to,
      ),
    );
  }),
);

/**
 * Approve → compile → deploy live → deploy the Schedule trigger → record.
 *
 * ⚠ **The approver comes from the verified identity and from nowhere else**
 * (Stage 9.1). `approveSchema` is `.strict()`, so a body still carrying
 * `approverUserId` is a 400 that names the field rather than a value quietly
 * overridden — a field that is accepted and ignored reads, to the next person,
 * as a field that works.
 */
approvalsRouter.post(
  "/",
  requireIdentity,
  // GAPS §1.1. `requireIdentity` says a person is making this request; this says
  // they are allowed to approve HERE. Until this line, every signed-in person
  // could approve in every workspace.
  requireWorkspaceRole("approver"),
  // GAPS §1.2b, D-69. §1.2 recorded whether authorship was ATTESTED and refused
  // nothing on it. This is the refusal, and it escalates rather than blocks: a
  // revision nobody is recorded as having written needs an ADMIN, because there
  // is nobody for the self-approval refusal to compare an approver against.
  // ⚠ At the route for the same reason the role check is (D-67) — it needs
  // `req.user`, and every harness arms flows through `systemAuthor()`.
  requireProvenanceAuthority(),
  asyncHandler(async (req, res) => {
    const input = approveSchema.parse(req.body);
    const result = await flowApprovalService.approve(
      req.params.workspaceId,
      req.params.flowId,
      {
        ...input,
        approverUserId: actorOf(req),
        // ⚠ From the verified identity, never from the body — `approveSchema` is
        // `.strict()` so an approver cannot name themselves, and an exemption a
        // caller could assert would be that hole under a new name.
        bySuperAdmin: await superAdminHere(req.user, req.params.workspaceId!),
      },
    );
    res.status(201).json(result);
  }),
);

/**
 * Revoke → the Schedule trigger is REMOVED from Kestra, not flagged (assertion 25).
 *
 * Identity is required here for the same reason as approving, and it is the
 * half people forget: revoking is the act that STOPS an automation somebody
 * relies on, so "who turned this off" is at least as worth recording as who
 * turned it on.
 */
approvalsRouter.post(
  "/revoke",
  requireIdentity,
  // Revoking is the act that STOPS an automation somebody relies on, so it needs
  // at least what approving needs. A role model that gated the on switch and not
  // the off switch would be an odd kind of control.
  requireWorkspaceRole("approver"),
  asyncHandler(async (req, res) => {
    const input = revokeSchema.parse(req.body);
    res.json(
      await flowApprovalService.revoke(req.params.workspaceId, req.params.flowId, {
        ...input,
        revokedBy: actorOf(req),
      }),
    );
  }),
);

/**
 * Re-arm a turned-off flow — one click, no review.
 *
 * Resumes the APPROVED revision even when a newer draft exists (that draft is
 * untouched and still needs its own review). The contract the list's switch
 * reads: 200 means firing again, 409 means a person needs to look (the
 * approval went stale, or something the approved revision depends on changed
 * shape or vanished) and the client routes those to `/publish`. Anything else
 * is a failure.
 *
 * Same role as revoke: starting an automation somebody relies on needs at
 * least what stopping one needs. No provenance check — re-arm approves no new
 * content, so there is no authorship question to escalate (see `rearm`).
 */
approvalsRouter.post(
  "/rearm",
  requireIdentity,
  // Re-arming is the act that STARTS an automation somebody relies on firing
  // again, so it needs at least what revoking needs. A role model that gated
  // the off switch and not the on switch would be an odd kind of control.
  requireWorkspaceRole("approver"),
  asyncHandler(async (req, res) => {
    res.json(
      await flowApprovalService.rearm(req.params.workspaceId, req.params.flowId, {
        rearmedBy: actorOf(req),
      }),
    );
  }),
);

/**
 * Re-check staleness now, rather than waiting for the sweep.
 *
 * A read that can suspend, so it is a POST. Exists because "a tool changed
 * shape" is something an engineer usually knows the moment it happens, and
 * waiting a tick to see the schedule suspend makes the control look unreliable.
 */
approvalsRouter.post(
  "/recheck",
  asyncHandler(async (req, res) => {
    const flow = await flowRepo.get(req.params.workspaceId, req.params.flowId);
    if (!flow) return res.status(404).json({ error: "not_found" });
    res.json(await flowApprovalService.checkStaleness(req.params.workspaceId, flow));
  }),
);
