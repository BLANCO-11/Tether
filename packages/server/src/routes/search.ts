import { Router } from "express";
import { z } from "zod";
import { validate } from "@foundry/shared";
import { asyncHandler } from "../middleware/error.middleware.js";
import { searchService } from "../services/search.service.js";
import { requireIdentity } from "../middleware/identity.middleware.js";
import { effectivePermissionsService } from "../services/effective-permissions.service.js";
import { contentVisibility } from "../services/content-visibility.service.js";

const querySchema = z.object({
  q: z.string().optional(),
});

export const searchRouter = Router({ mergeParams: true });

/**
 * B-30 search index 6 kinds workspace-scoped replacing STATIC_SEARCH_INDEX.
 * keep GET /api/templates separate.
 * GET /workspaces/:ws/search?q= unions flows+steps+runs+resources+approvals+persons
 */
/**
 * ⚠ **THE ONE ROUTE THE PERMISSION MAP CANNOT SECURE ON ITS OWN.**
 *
 * `search.read` is a FLOOR — it decides who reaches this handler, not what comes back.
 * Search unions six kinds drawn from six different tables, and each of those tables has
 * its own permission. Without the per-kind filter in the service, an `author` (who holds
 * `search.read` and neither `approvals.read` nor `members.read`) could read the titles
 * and metadata of every approval and every person in the workspace through a search box.
 * That is a read-around of the permissions that exist to stop exactly that.
 *
 * `requireIdentity` is explicit here even though the spliced `search.read` guard already
 * refuses an anonymous caller: this route resolves the caller's permissions itself, so
 * the identity it depends on should be a stated requirement rather than an inherited
 * side effect.
 */
searchRouter.get(
  "/",
  requireIdentity,
  validate({ query: querySchema }),
  asyncHandler(async (req, res) => {
    const ws = req.params.workspaceId;
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const eff = await effectivePermissionsService.forWorkspace(req.user, ws);
    const results = await searchService.index(ws, q, {
      permissions: new Set<string>(eff.permissions),
      content: await contentVisibility.viewer(req.user, ws),
    });
    res.json({ results });
  }),
);
