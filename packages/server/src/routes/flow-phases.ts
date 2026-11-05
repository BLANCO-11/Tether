import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";

/**
 * B-11 · flow_phases — background frames for builder canvas (S-07).
 * Placeholder until B-11's implementation lands. Keeps the app importable.
 */
export const flowPhasesRouter = Router({ mergeParams: true });

flowPhasesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({ phases: [] });
  }),
);
