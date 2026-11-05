import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity, requireWorkspaceRole } from "../middleware/identity.middleware.js";
import { INCIDENT_STATUSES, incidentService } from "../services/incident.service.js";

export const incidentsRouter = Router({ mergeParams: true });

const createIncidentSchema = z.object({
  id: z.string().min(1).max(255),
  title: z.string().min(1).max(500),
  severity: z.enum(["sev1", "sev2", "sev3"]),
  status: z.enum(["reported","triaged","investigating","contained","recovering","monitoring","resolved","post-incident-review","closed"]).optional(),
  ownerSubject: z.string().optional(),
  timeline: z.unknown().optional(),
});

const transitionIncidentSchema = z.object({ status: z.enum(INCIDENT_STATUSES) });

/**
 * B-16 · S-60 Incident list/detail.
 * GET /workspaces/:workspaceId/incidents
 * GET /workspaces/:workspaceId/incidents/:id
 * POST /workspaces/:workspaceId/incidents (for seeding/tests — admin only, not in spec but needed to create rows)
 *
 * Workspace-scoped: every read filters WHERE workspace_id = ?
 */
incidentsRouter.get(
  "/",
  requireIdentity,
  requireWorkspaceRole("author"),
  asyncHandler(async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const rows = await incidentService.list(workspaceId);
    res.json({ incidents: rows });
  }),
);

incidentsRouter.get(
  "/:id",
  requireIdentity,
  requireWorkspaceRole("author"),
  asyncHandler(async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const id = req.params.id;
    const row = await incidentService.get(workspaceId, id);
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json({ incident: row });
  }),
);

incidentsRouter.post(
  "/",
  requireIdentity,
  requireWorkspaceRole("admin"),
  asyncHandler(async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const parsed = createIncidentSchema.parse(req.body);
    const row = await incidentService.create({
      workspaceId,
      id: parsed.id,
      title: parsed.title,
      severity: parsed.severity,
      status: parsed.status,
      ownerSubject: parsed.ownerSubject ?? null,
      timeline: parsed.timeline ?? null,
    });
    res.status(201).json({ incident: row });
  }),
);

incidentsRouter.patch(
  "/:id",
  requireIdentity,
  requireWorkspaceRole("admin"),
  asyncHandler(async (req, res) => {
    const { workspaceId, id } = req.params;
    const parsed = transitionIncidentSchema.parse(req.body);
    const user = req.user;
    if (!user?.subject) return res.status(401).json({ error: "identity required" });
    try {
      res.json({
        incident: await incidentService.transition({
          workspaceId: workspaceId!,
          incidentId: id!,
          status: parsed.status,
          actorSubject: user.subject,
        }),
      });
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      if (e.statusCode === 400) return res.status(400).json({ error: "validation", message: e.message });
      if (e.statusCode === 404) return res.status(404).json({ error: "not_found", message: e.message });
      throw err;
    }
  }),
);
