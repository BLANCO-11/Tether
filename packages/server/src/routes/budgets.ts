import { Router } from "express";
import { z } from "zod";
import { validate } from "@foundry/shared";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity, requireWorkspaceRole } from "../middleware/identity.middleware.js";
import { budgetSchema, tenantBudgetService } from "../services/tenant-budget.service.js";

export const budgetsRouter = Router({ mergeParams: true });
const paramsSchema = z.object({ workspaceId: z.string().uuid() });

budgetsRouter.get(
  "/",
  requireIdentity,
  requireWorkspaceRole("admin"),
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params as { workspaceId: string };
    res.json(await tenantBudgetService.resolve(workspaceId));
  }),
);

budgetsRouter.put(
  "/",
  requireIdentity,
  requireWorkspaceRole("admin"),
  validate({ params: paramsSchema, body: budgetSchema }),
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params as { workspaceId: string };
    res.json(await tenantBudgetService.set(workspaceId, req.body));
  }),
);

budgetsRouter.delete(
  "/",
  requireIdentity,
  requireWorkspaceRole("admin"),
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params as { workspaceId: string };
    res.json(await tenantBudgetService.clear(workspaceId));
  }),
);
