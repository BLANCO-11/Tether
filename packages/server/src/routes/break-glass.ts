import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity, requireWorkspaceRole } from "../middleware/identity.middleware.js";
import { workspaceMemberCapabilitiesService } from "../services/workspace-member-capabilities.service.js";
import { breakGlassService } from "../services/break-glass.service.js";

export const breakGlassRouter = Router({ mergeParams: true });

const activateSchema = z.object({
  incidentId: z.string().min(1),
  scope: z.enum(["hris-unmasked", "payroll-restricted"]),
  duration: z.number().int().refine((v) => [1, 2, 4].includes(v), { message: "duration must be 1|2|4" }).optional(),
  durationHours: z.number().int().refine((v) => [1, 2, 4].includes(v), { message: "duration must be 1|2|4" }).optional(),
  justification: z.string().min(20, "justification must be at least 20 characters"),
  acknowledged: z.boolean().refine((v) => v === true, { message: "acknowledgement required" }),
}).refine((d) => d.duration !== undefined || d.durationHours !== undefined, {
  message: "duration required",
  path: ["duration"],
});

/**
 * B-16 · S-58 Activate break-glass, S-59 active session.
 *
 * POST /workspaces/:workspaceId/break-glass — workspace scoping, require admin + real-data capability
 * GET  /workspaces/:workspaceId/break-glass/active
 * POST /workspaces/:workspaceId/break-glass/:id/revoke — admin
 *
 * Workspace-scoped: every operation checks workspaceId param.
 * Ties to auditService.record for every activation (in service).
 */

breakGlassRouter.post(
  "/",
  requireIdentity,
  requireWorkspaceRole("admin"),
  asyncHandler(async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const user = req.user;
    if (!user?.subject) return res.status(401).json({ error: "identity required" });

    // Require real-data capability in addition to admin role
    const hasRealData = await workspaceMemberCapabilitiesService.hasCapability({
      workspaceId,
      subject: user.subject,
      email: user.email,
      capability: "realdata.use",
    });
    if (!hasRealData) {
      return res.status(403).json({ error: "forbidden", message: "real-data capability required for break-glass" });
    }

    const parsed = activateSchema.parse(req.body);
    const durationValue = parsed.duration ?? parsed.durationHours;
    if (durationValue === undefined) return res.status(400).json({ error: "validation", message: "duration required" });

    try {
      const session = await breakGlassService.activate({
        workspaceId,
        incidentId: parsed.incidentId,
        scope: parsed.scope,
        duration: durationValue,
        justification: parsed.justification,
        acknowledged: parsed.acknowledged,
        activatedBy: user.subject,
      });
      res.status(201).json({ session });
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      if (e.statusCode === 400) return res.status(400).json({ error: "validation", message: e.message });
      if (e.statusCode === 404) return res.status(404).json({ error: "not_found", message: e.message });
      if (e.statusCode === 409) return res.status(409).json({ error: "conflict", message: e.message });
      throw err;
    }
  }),
);

breakGlassRouter.get(
  "/active",
  requireIdentity,
  requireWorkspaceRole("admin"),
  asyncHandler(async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const sessions = await breakGlassService.active(workspaceId);
    res.json({ sessions });
  }),
);

breakGlassRouter.post(
  "/:id/revoke",
  requireIdentity,
  requireWorkspaceRole("admin"),
  asyncHandler(async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const id = req.params.id;
    try {
      const revoked = await breakGlassService.revoke({ workspaceId, sessionId: id });
      if (!revoked) return res.status(404).json({ error: "not_found" });
      res.json({ session: revoked });
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      if (e.statusCode === 409) return res.status(409).json({ error: "conflict", message: e.message });
      if (e.statusCode === 400) return res.status(400).json({ error: "validation", message: e.message });
      throw err;
    }
  }),
);
