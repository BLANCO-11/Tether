/**
 * Observability (pi-runtime P-OBS): what the workspace — or the deployment — used, what it cost, how its runs went.
 *
 * Who sees what (rbac-observability, 2026-10-15): everybody sees cost — for what they may see. A member gets their own
 * usage and cost and the runs they may see (`scope: "mine"`); an Admin (`content.read.others`) gets everyone's, by
 * person (`scope: "workspace"`), and may ask for their own with `?scope=mine`. The platform view is the deployment's,
 * by workspace.
 */
import { Router } from "express";
import { isNull, notInArray, or } from "drizzle-orm";
import { flowExecutions, usageEvents } from "../db/schema.js";
import { closedTo } from "../services/workspace-restriction.service.js";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { usageService } from "../services/usage.service.js";
import { contentVisibility } from "../services/content-visibility.service.js";

const query = z.object({
  days: z.coerce.number().int().min(1).max(366).optional().default(30),
  scope: z.enum(["mine", "workspace"]).optional(),
});

/** `/api/workspaces/:workspaceId/observability` — one workspace. Guarded at boot: `runs.read`. */
export const workspaceObservabilityRouter = Router({ mergeParams: true });

workspaceObservabilityRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { days, scope } = query.parse(req.query);
    const ws = req.params.workspaceId;
    const viewer = await contentVisibility.viewer(req.user, ws);
    // "Mine" is the caller's own usage whatever they hold; without `content.read.others` it is all there is.
    const own = !viewer.all || scope === "mine";
    const mine = { ...viewer, all: false, reviewer: false };
    res.json(
      await usageService.summary(ws, {
        days,
        usageWhere: contentVisibility.usageWhere(own ? mine : viewer),
        runsWhere: contentVisibility.runsWhere(own ? mine : viewer),
        scope: own ? "mine" : "workspace",
      }),
    );
  }),
);

/** `/api/observability` — the whole deployment, cost included. Guarded at boot: `platform.signals.read`. */
export const platformObservabilityRouter = Router();

platformObservabilityRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { days } = query.parse(req.query);
    // ⚠ Restricted workspaces (phase 3): one the viewer is outside of is left out of every figure and named only.
    const closed = await closedTo(req.user);
    const ids = [...closed.keys()];
    const summary = await usageService.summary(null, {
      days,
      scope: "deployment",
      ...(ids.length
        ? {
            usageWhere: or(isNull(usageEvents.workspaceId), notInArray(usageEvents.workspaceId, ids)),
            runsWhere: notInArray(flowExecutions.workspaceId, ids),
          }
        : {}),
    });
    res.json({
      ...summary,
      restricted: [...closed].map(([id, name]) => ({ id, name })),
      ...(ids.length ? { restrictedNote: "Figures leave out the restricted workspaces listed; only their own admins see them." } : {}),
    });
  }),
);
