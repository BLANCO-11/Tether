import { Router } from "express";
import { z } from "zod";
import { validate } from "@foundry/shared";
import { asyncHandler } from "../middleware/error.middleware.js";
import { catalogueService } from "../services/catalogue.service.js";
import { flowCatalogueService } from "../services/flow-catalogue.service.js";
import { requireIdentity, requireWorkspaceRole } from "../middleware/identity.middleware.js";

const paramsSchema = z.object({ workspaceId: z.string().uuid() });
const querySchema = z.object({ q: z.string().optional() });
const accessRequestBodySchema = z.object({
  itemId: z.string().uuid(),
  reason: z.string().min(10, "reason must be at least 10 characters"),
});

/**
 * Catalogue — two reads on one mount (see `app.ts:344`).
 *
 * `GET /` — Programme 3 Stage 5 flow-authoring catalogue: `{entries,triggers,outputs,expressions,caps,drift}`
 * via `flowCatalogueService.forWorkspace`. Same ref set `checkFlowRefs` validates,
 * so palette never offers a ref the validator rejects. Recovered from `origin/v1-alpha`
 * (which had only this read); kept at `/` so `GET /workspaces/:ws/catalogue`
 * stays the palette's one read and `foundry-client.getFlowCatalogue` needs no
 * path change.
 *
 * `GET /items?q=` — B-10 · S-04 attachment picker `{items: CatalogueItem[]}`
 * (`masked|mock|restricted` per-access). Moved from `/` to `/items` to stop
 * shadowing the FA shape (`{items}` vs `{entries,…}` crash at `FlowBuilder.tsx:210`).
 *
 * `POST /access-requests` (+ alias at `/access-requests`) — B-10 access request.
 */
export const catalogueRouter = Router({ mergeParams: true });

catalogueRouter.get(
  "/",
  validate({ params: paramsSchema }),
  asyncHandler(async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const result = await flowCatalogueService.forWorkspace(workspaceId);
    res.json(result);
  }),
);

catalogueRouter.get(
  "/items",
  validate({ params: paramsSchema, query: querySchema }),
  requireIdentity,
  requireWorkspaceRole("author"),
  asyncHandler(async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const viewerSubject = req.user?.subject ?? null;
    const viewerEmail = req.user?.email ?? null;
    const result = await catalogueService.list({ workspaceId, q, viewerSubject, viewerEmail });
    res.json(result);
  }),
);

// POST /workspaces/:workspaceId/catalogue/access-requests — B-10 access request (ACC-)
// Also mounted as POST /workspaces/:workspaceId/access-requests via app.ts alias for spec literal.
catalogueRouter.post(
  "/access-requests",
  validate({ params: paramsSchema, body: accessRequestBodySchema }),
  requireIdentity,
  requireWorkspaceRole("author"),
  asyncHandler(async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const viewerSubject = req.user?.subject;
    if (!viewerSubject) return res.status(401).json({ error: "identity required" });
    const { itemId, reason } = req.body as { itemId: string; reason: string };
    const row = await catalogueService.requestAccess({ workspaceId, itemId, reason, requesterSubject: viewerSubject });
    res.status(201).json({ request: row });
  }),
);

/**
 * Standalone access-requests router at POST /workspaces/:workspaceId/access-requests (spec literal).
 * Thin wrapper over catalogueService.requestAccess to satisfy `POST /workspaces/:ws/access-requests` path.
 */
export const catalogueAccessRequestsRouter = Router({ mergeParams: true });

catalogueAccessRequestsRouter.post(
  "/",
  validate({ params: paramsSchema, body: accessRequestBodySchema }),
  requireIdentity,
  requireWorkspaceRole("author"),
  asyncHandler(async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const viewerSubject = req.user?.subject;
    if (!viewerSubject) return res.status(401).json({ error: "identity required" });
    const { itemId, reason } = req.body as { itemId: string; reason: string };
    const row = await catalogueService.requestAccess({ workspaceId, itemId, reason, requesterSubject: viewerSubject });
    res.status(201).json({ request: row });
  }),
);
