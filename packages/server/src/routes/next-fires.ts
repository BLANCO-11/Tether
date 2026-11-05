import { Router } from "express";
import { z } from "zod";
import { validate } from "@foundry/shared";
import { asyncHandler } from "../middleware/error.middleware.js";
import { nextFireService } from "../services/next-fire.service.js";

const querySchema = z.object({
  limit: z.string().optional(),
  window: z.string().optional(),
});

export const nextFiresRouter = Router({ mergeParams: true });

/**
 * B-01 next-fire armed only 30d + overflow.
 * GET /workspaces/:ws/next-fires?limit=4&window=30d honouring armed only D-18
 * Prefer Kestra engine if available but stub compute expansion in Foundry with note "derived in Foundry" beside number.
 */
nextFiresRouter.get(
  "/",
  validate({ query: querySchema }),
  asyncHandler(async (req, res) => {
    const ws = req.params.workspaceId;
    const rawLimit = req.query.limit as string | undefined;
    const rawWindow = req.query.window as string | undefined;
    let limit = 4;
    let windowDays = 30;
    if (rawLimit !== undefined) {
      const n = Number(rawLimit);
      if (!Number.isNaN(n)) limit = n;
    }
    if (rawWindow !== undefined) {
      // accept "30d" or "30"
      const cleaned = rawWindow.replace(/d$/i, "");
      const n = Number(cleaned);
      if (!Number.isNaN(n)) windowDays = n;
    }
    const result = await nextFireService.list(ws, limit, windowDays);
    res.json(result);
  }),
);
