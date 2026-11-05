import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import {
  flowPositionService,
  putPositionsSchema,
} from "../services/flow-position.service.js";

/**
 * A flow's step positions — the DAG arrangement mirror (plan decision ②, D-150).
 * Mounted at `/api/workspaces/:workspaceId/flows/:flowId/positions` behind
 * `requireApiKey`, BESIDE `/flows` inside the flow, and that is deliberate:
 * positions are a property of a flow, so a `/:flowId`-nested mount (like the
 * triggers router) is the honest address.
 *
 * ⚠ **Neither handler touches the revision.** Reads return rows; writes replace
 * the set. A drag must never create a revision — approval binds to a revision,
 * and a cosmetic drag creating one would invalidate an approval (D-150). The
 * client reconciles (drops deleted-step rows, re-keys renamed ones) before PUT;
 * the server stores exactly what it is given.
 */
export const flowPositionsRouter = Router({ mergeParams: true });

flowPositionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const positions = await flowPositionService.list(
      req.params.workspaceId,
      req.params.flowId,
    );
    if (!positions) return res.status(404).json({ error: "not_found" });
    res.json({ positions });
  }),
);

flowPositionsRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    const input = putPositionsSchema.parse(req.body);
    const ok = await flowPositionService.replace(
      req.params.workspaceId,
      req.params.flowId,
      input,
    );
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.json({ saved: input.positions.length });
  }),
);
