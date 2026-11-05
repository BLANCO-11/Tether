import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity, requireWorkspaceRole } from "../middleware/identity.middleware.js";
import { releaseGateService } from "../services/release-gate.service.js";
import { flowRepo } from "../repositories/flow.repo.js";

const patchGateSchema = z.object({ enabled: z.boolean() });

/**
 * B-19 · `release_gates` routes — workspace-scoped, flow-override aware.
 *
 * Mounted at:
 *  - `GET /api/workspaces/:workspaceId/release-gates`  → workspace defaults (flow_id IS NULL)
 *  - `GET /api/workspaces/:workspaceId/flows/:flowId/release-gates` → per-flow (fallback to workspace defaults)
 *
 * Returns `{gates}` in ordinal order, where disabled gates are still returned
 * with `enabled:false` so UI can render "not enforced" rather than hiding.
 * `satisfiedBy` is quoted verbatim when blocked (AC-07-5).
 *
 * Workspace scoping: every read filters WHERE workspace_id = ? and, when flowId
 * is present, verifies the flow belongs to the workspace via `flowRepo.get`.
 */
export const releaseGatesRouter = Router({ mergeParams: true });

releaseGatesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { workspaceId, flowId } = req.params as { workspaceId: string; flowId?: string };

    // Workspace-scoped: if flowId present, verify ownership (prevents cross-workspace probe).
    if (flowId) {
      const flow = await flowRepo.get(workspaceId, flowId);
      if (!flow) return res.status(404).json({ error: "not_found", message: "flow not found in workspace" });
      const gates = await releaseGateService.list({ workspaceId, flowId });
      // Lazily ensure defaults if nothing exists anywhere (honest seed)
      if (gates.length === 0) {
        const seeded = await releaseGateService.ensureDefaults(workspaceId);
        // For flow-scoped request with no per-flow overrides, return workspace defaults (seeded)
        res.json({ gates: seeded });
        return;
      }
      res.json({ gates });
      return;
    }

    // Workspace defaults
    let gates = await releaseGateService.list({ workspaceId });
    if (gates.length === 0) {
      gates = await releaseGateService.ensureDefaults(workspaceId);
    }
    res.json({ gates });
  }),
);

releaseGatesRouter.patch(
  "/:gateId",
  requireIdentity,
  requireWorkspaceRole("admin"),
  asyncHandler(async (req, res) => {
    const { workspaceId, flowId, gateId } = req.params as {
      workspaceId: string;
      flowId?: string;
      gateId: string;
    };
    const body = patchGateSchema.parse(req.body);
    if (flowId) {
      const flow = await flowRepo.get(workspaceId, flowId);
      if (!flow) return res.status(404).json({ error: "not_found", message: "flow not found in workspace" });
    }
    const gate = await releaseGateService.setEnabled({ workspaceId, gateId, enabled: body.enabled });
    if (!gate) return res.status(404).json({ error: "not_found", message: "gate not found in workspace" });
    res.json({ gate });
  }),
);
