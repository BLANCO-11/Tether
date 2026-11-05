import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { flowFlagService } from "../services/flow-flag.service.js";
import { flowRepo } from "../repositories/flow.repo.js";

/**
 * B-12 · `flow_step_flags` routes — workspace-scoped, revision-aware.
 *
 * Flags are keyed to a `flowRevisionId` (FK → `flow_revisions`) honouring
 * D-37 insert-only revisions. Routes verify the flow belongs to the workspace
 * via `flowRepo.get(workspaceId, flowId)` — the same ownership check every
 * flow route uses — and that the revision belongs to the flow.
 *
 * `GET /:flag?revision=` supports both:
 *   - `?revision=<uuid>` (flow_revisions.id) — canonical, since flags are FK'd
 *     to the row id and revision numbers can be ambiguous across flows.
 *   - `?revision=<number>` — convenience; resolved via `flowRepo.getRevision`.
 *   When absent, the draft revision is used (or 400 if the flow has no draft).
 *
 * `PATCH /:flagId` transitions `status` (`open` → `resolved`|`deferred`);
 * `consequence` is required validation (AC-05-8) — DB NOT NULL plus service
 * check that the persisted consequence is non-empty.
 */
export const flowFlagsRouter = Router({ mergeParams: true });

const patchSchema = z.object({
  status: z.enum(["resolved", "deferred"]),
  consequence: z.string().min(1).max(4000).optional(),
});

flowFlagsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { workspaceId, flowId } = req.params as { workspaceId: string; flowId: string };
    const revisionParam = (req.query.revision as string | undefined)?.trim();

    let flags;
    if (revisionParam) {
      // Try uuid first; if not uuid-shaped, treat as revision number.
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(revisionParam);
      if (isUuid) {
        flags = await flowFlagService.list(workspaceId, flowId, revisionParam);
      } else {
        const n = Number(revisionParam);
        if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "invalid_revision", message: "revision must be a uuid or positive integer" });
        flags = await flowFlagService.listByRevisionNumber(workspaceId, flowId, n);
      }
    } else {
      // Default to draft revision.
      const flow = await flowRepo.get(workspaceId, flowId);
      if (!flow) return res.status(404).json({ error: "not_found" });
      if (flow.draftRevision == null) return res.status(400).json({ error: "no_draft", message: "flow has no draft revision" });
      const rev = await flowRepo.getRevision(flowId, flow.draftRevision);
      if (!rev) return res.status(404).json({ error: "revision_not_found" });
      flags = await flowFlagService.list(workspaceId, flowId, rev.id);
    }

    if (flags === undefined) return res.status(404).json({ error: "not_found" });

    // Also return canTest / canPublish — document and compute here so the
    // three surfaces (flag card, Steps outline, readiness sheet) share one row
    // and one gate (AC-05-10, AC-05-13).
    const canTest = flowFlagService.canTest(flags);
    const canPublish = flowFlagService.canPublish(flags);
    res.json({ flags, canTest, canPublish });
  }),
);

flowFlagsRouter.patch(
  "/:flagId",
  asyncHandler(async (req, res) => {
    const { workspaceId, flowId, flagId } = req.params as {
      workspaceId: string;
      flowId: string;
      flagId: string;
    };
    const input = patchSchema.parse(req.body);
    try {
      const updated = await flowFlagService.updateStatus(workspaceId, flowId, flagId, input);
      if (!updated) return res.status(404).json({ error: "not_found" });
      res.json({ flag: updated });
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status === 400) return res.status(400).json({ error: "validation", message: e.message });
      if (e.status === 409) return res.status(409).json({ error: "conflict", message: e.message });
      throw err;
    }
  }),
);
