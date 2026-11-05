import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { bootstrapService } from "../services/bootstrap.service.js";

export const bootstrapRouter = Router({ mergeParams: true });

/**
 * B-04 bootstrap 34 templates ready.
 * GET /workspaces/:ws/bootstrap honest
 * returns {templatesCount 34, policiesReady, resourcesReady} for empty-workspace state
 */
bootstrapRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const ws = req.params.workspaceId;
    const ready = await bootstrapService.ready(ws);
    res.json(ready);
  }),
);
