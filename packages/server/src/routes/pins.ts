import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity } from "../middleware/identity.middleware.js";
import { pinService } from "../services/pin.service.js";
import { contentVisibility } from "../services/content-visibility.service.js";
import { flowRepo } from "../repositories/flow.repo.js";

export const pinsRouter = Router({ mergeParams: true });

pinsRouter.get(
  "/",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const ws = req.params.workspaceId;
    const subject = req.user!.subject;
    // A pin on an automation this person can no longer see (unpublished, reassigned) is not listed (rbac-observability).
    const viewer = await contentVisibility.viewer(req.user, ws);
    const list = [];
    for (const p of await pinService.list(ws, subject)) {
      const flow = await flowRepo.get(ws, p.flowId);
      if (flow && contentVisibility.flowVisible(viewer, flow)) list.push(p);
    }
    res.json({ pins: list });
  }),
);

pinsRouter.post(
  "/:flowId/toggle",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const ws = req.params.workspaceId;
    const subject = req.user!.subject;
    const flowId = req.params.flowId;
    const result = await pinService.toggle(ws, subject, flowId);
    res.json(result);
  }),
);
