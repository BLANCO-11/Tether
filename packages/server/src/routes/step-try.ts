import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity, requireWorkspaceRole } from "../middleware/identity.middleware.js";
import { stepTryService, stepTrySchema } from "../services/step-try.service.js";
import { StepError } from "../services/step-error.js";

/**
 * `POST /api/workspaces/:workspaceId/steps/try` — run ONE component with values
 * a person supplied, and persist nothing. Builder programme T9 (`BD-006`).
 *
 * ⚠ **This is NOT `routes/steps.ts`** and the two must never be merged. That
 * router is what Kestra calls back into: it is mounted behind `requireStepToken`
 * and NOTHING else, its tenancy comes from an execution token, and it writes
 * `flow_step_runs` pointer rows. This one is called by a browser, is mounted
 * behind the parent key plus a verified identity plus a workspace role, and
 * writes nothing at all. They share the three executor functions and nothing
 * else — which is the whole point, because a second dial is how a probe comes
 * to present a credential differently from a run.
 *
 * ── Why `author` and not `approver` ──────────────────────────────────────────
 *
 * Trying a step is authoring. The same person can already start a draft run of
 * a whole flow with `POST …/flows/:id/test-run` at `author`, and that run makes
 * every one of these calls and more — so requiring a higher role here would
 * gate the smaller action more tightly than the larger one, which teaches people
 * to reach for the larger one.
 *
 * ⚠ **`requireIdentity` is not decoration.** A tool try really dials a tenant's
 * endpoint with a stored credential, so the parent API key alone must not be
 * enough: the key authorises a request and does not name a person (D-39).
 */
export const stepTryRouter = Router({ mergeParams: true });

stepTryRouter.post(
  "/try",
  requireIdentity,
  requireWorkspaceRole("author"),
  asyncHandler(async (req, res) => {
    const parsed = stepTrySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid try body", detail: parsed.error.flatten() });
    }
    if (parsed.data.useProductionData) {
      // Admin-gated branch ONLY: the plain mock preview stays at `author`.
      // Same cycle-avoidance dynamic import as the test-run route.
      const { workspaceMemberService } = await import("../services/workspace-member.service.js");
      const { actorOf } = await import("../middleware/identity.middleware.js");
      const verdict = await workspaceMemberService.check(req.params.workspaceId, req.user, "admin");
      if (!verdict.allowed) {
        return res.status(verdict.status).json({ error: "forbidden", message: verdict.reason });
      }
      try {
        res.json(await stepTryService.tryStep(req.params.workspaceId, parsed.data, { actor: actorOf(req) }));
      } catch (e) {
        if (e instanceof StepError) {
          return res.status(e.status).json({ error: e.message, detail: e.detail });
        }
        throw e;
      }
      return;
    }
    try {
      res.json(await stepTryService.tryStep(req.params.workspaceId, parsed.data));
    } catch (e) {
      if (e instanceof StepError) {
        return res.status(e.status).json({ error: e.message, detail: e.detail });
      }
      throw e;
    }
  }),
);
