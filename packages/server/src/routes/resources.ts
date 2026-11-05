import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { resourceService } from "../services/resource.service.js";
import type { ResourceCategory } from "../db/schema.js";

export const resourcesRouter = Router({ mergeParams: true });

const VALID_CATEGORIES: ReadonlyArray<string> = ["all", "datasource", "connector", "tool"];

resourcesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const rawType = typeof req.query.type === "string" ? req.query.type.toLowerCase() : "all";
    const rawQ = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const category: ResourceCategory | "all" =
      (VALID_CATEGORIES as readonly string[]).includes(rawType) && rawType !== "all"
        ? (rawType as ResourceCategory)
        : "all";

    // For "all" we return everything; otherwise filtered via service.
    const list = await resourceService.list(req.params.workspaceId, category);

    const filtered = rawQ
      ? list.filter(
          (r) =>
            r.name.toLowerCase().includes(rawQ) ||
            r.resourceType.toLowerCase().includes(rawQ) ||
            r.type.toLowerCase().includes(rawQ),
        )
      : list;

    res.json({ resources: filtered });
  }),
);

resourcesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const all = await resourceService.list(req.params.workspaceId);
    const found = all.find((r) => r.id === req.params.id);
    if (!found) return res.status(404).json({ error: "resource not found" });
    res.json({ resource: found });
  }),
);
