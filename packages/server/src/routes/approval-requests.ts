import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity, requireWorkspaceRole } from "../middleware/identity.middleware.js";
import { approvalQueueService } from "../services/approval-queue.service.js";

export const approvalRequestsRouter = Router({ mergeParams: true });

/**
 * B-14 · S-37 Approvals inbox — unified queue.
 * Mounted at `/api/workspaces/:workspaceId/approval-requests` behind `requireApiKey`.
 *
 * GET /?tab=pending_me|requested|delegated|history → {requests, figures}
 * Figures: {pendingYourApproval, inFlight} workspace-scoped pending counts.
 * Workspace scoping: every read filters WHERE workspace_id = ?.
 * Auth: requireIdentity + workspace member check (author at minimum).
 * superAdmin still needs member check via requireWorkspaceRole — same as other workspace routes.
 */
approvalRequestsRouter.get(
  "/",
  requireIdentity,
  requireWorkspaceRole("author"),
  asyncHandler(async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const viewerSubject = req.user?.subject;
    if (!viewerSubject) {
      return res.status(401).json({ error: "identity required" });
    }
    const tab = typeof req.query.tab === "string" ? req.query.tab : undefined;
    const result = await approvalQueueService.list({ workspaceId, viewerSubject, tab });
    res.json(result);
  }),
);

approvalRequestsRouter.get(
  "/figures",
  requireIdentity,
  requireWorkspaceRole("author"),
  asyncHandler(async (req, res) => {
    res.json(await approvalQueueService.figures(req.params.workspaceId));
  }),
);
