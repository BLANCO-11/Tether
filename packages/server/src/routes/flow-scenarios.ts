import { Router } from "express";
import { z } from "zod";
import { validate } from "@foundry/shared";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity, requireWorkspaceRole } from "../middleware/identity.middleware.js";
import { scenarioService } from "../services/flow-scenario.service.js";
import { flowRepo } from "../repositories/flow.repo.js";

/**
 * B-18 · flow_test_scenarios — GET /workspaces/:workspaceId/flows/:flowId/scenarios
 *
 * Mock-only scenarios for S-20 Test scenario picker. Five equal radio Saved/Edge/AI/Manual/Real
 * where Real is NOT a stored kind — real is namespace D-52 (draft vs live, never a fixture).
 * Panel shows population "142 employees · normal month" and edge-case reason "why worth running";
 * AI shows textarea; Real opens 5-part modal over draft namespace. This route returns mock
 * scenarios only, ordered created_at, honest-empty when none (B-24/B-26: population not faked).
 *
 * Workspace scoping: verify flow belongs to workspace via flowRepo.get (read pre-workspace scoping)
 * before listing. Auth: requireIdentity + requireWorkspaceRole("author") — same as catalogue etc.
 * Returns {scenarios} where each row carries population + reason.
 */

export const flowScenariosRouter = Router({ mergeParams: true });

const paramsSchema = z.object({
  workspaceId: z.string().uuid(),
  flowId: z.string().uuid(),
});

flowScenariosRouter.get(
  "/",
  validate({ params: paramsSchema }),
  requireIdentity,
  requireWorkspaceRole("author"),
  asyncHandler(async (req, res) => {
    const { workspaceId, flowId } = req.params as { workspaceId: string; flowId: string };
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) return res.status(404).json({ error: "not_found", message: "flow not found in workspace" });
    const { scenarios } = await scenarioService.list(workspaceId, flowId);
    res.json({ scenarios });
  }),
);
