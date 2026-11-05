import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import {
  toolService,
  createToolSchema,
  updateToolSchema,
} from "../services/tool.service.js";
import { toolProbeService, probeInputSchema } from "../services/tool-probe.service.js";
import { StepError } from "../services/step-error.js";

// mergeParams so :workspaceId from the parent mount is visible here.
export const toolsRouter = Router({ mergeParams: true });

toolsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({ tools: await toolService.list(req.params.workspaceId) });
  }),
);

toolsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createToolSchema.parse(req.body);
    const tool = await toolService.create(req.params.workspaceId, input);
    res.status(201).json({ tool });
  }),
);

/**
 * "Test this tool" — one bounded, reported call to a registered or drafted tool.
 * `specs/20260818-123807-tool-probe` · contract `POST …/tools/probe`
 *
 * ⚠ **Mounted above `/:toolId` as cheap insurance, NOT because it is load-bearing
 * today.** Express matches on method AND path, and this router declares no
 * `POST /:toolId` — so `/probe` cannot currently be read as "the tool whose id is
 * the string `probe`" whatever the order. Measured, by moving this block below the
 * `/:toolId` handlers: all 11 route tests still passed.
 *
 * ⚠ It becomes load-bearing the moment somebody adds a `POST /:toolId…` route (a
 * "run this tool" action is the obvious one). `tools-probe.test.ts` asserts that
 * no such route exists, so that day is announced by a test rather than discovered
 * as a 404 on a button that used to work.
 *
 * ⚠ **A 200 from this route does NOT mean the tool works.** It means Foundry
 * managed to ask. The answer is in `probe.verdict`, and a 401 from the endpoint is
 * a 200 here with `verdict: "auth_rejected"` — merging "the API said no" into
 * "Foundry could not ask" recreates exactly the ambiguity `applyAuth`'s 424 exists
 * to remove (plan Decision 5).
 *
 * Non-200s all come out of the service as `StepError`, whose `status` the shared
 * error middleware surfaces verbatim — the same numbers execution already speaks,
 * so the two surfaces cannot disagree about what one means.
 */
toolsRouter.post(
  "/probe",
  asyncHandler(async (req, res) => {
    const input = probeInputSchema.parse(req.body);
    try {
      const probe = await toolProbeService.probe(req.params.workspaceId, input);
      return res.json({ probe });
    } catch (e) {
      /**
       * ⚠ **Translated HERE rather than in `error.middleware.ts`, deliberately.**
       * `StepError` carries `status`; the middleware switches on `statusCode`, so
       * a StepError reaching it becomes a 500. Teaching the middleware about
       * `status` would silently re-map every OTHER thrower of this class —
       * `agent-run.service.ts` and the step routes — from whatever they answer
       * today to their `status`, which is a behaviour change for paths this
       * feature has no business touching. `routes/steps.ts` already translates it
       * locally (`if (e instanceof StepError) …`) and this is that same idiom, on
       * purpose: one class, two explicit translations, no action at a distance.
       */
      if (!(e instanceof StepError)) throw e;
      const detail = (e.detail ?? {}) as Record<string, unknown> & { error?: string };
      const { error: code, ...rest } = detail;
      /**
       * ⚠ **The contract's error code is a function of the STATUS, so it is
       * derived here rather than required from every thrower.** Measured at the
       * wire: a 424 arrived as `{"error":"probe_failed"}`, because the 424 that
       * matters most — `applyAuth`'s *"declares auth style X but its secret has no
       * value"* — is raised deep in the shared dial and carries no `detail` at
       * all. Requiring each thrower to name a probe-specific code would mean
       * editing `tool-invoke.ts` to know about this route, which is backwards: the
       * dial is shared with execution, which speaks a different vocabulary.
       *
       * `detail.error` still wins where a thrower sets one (the platform-managed
       * refusal and the rate limiter both do), so this is a fallback, not an
       * override.
       */
      const codeForStatus: Record<number, string> = {
        400: "invalid_draft",
        404: "not_found",
        409: "secret_collision",
        424: "credential_not_configured",
        429: "probe_rate_limited",
      };
      /**
       * ⚠ `Retry-After` as well as the body field. A caller that honours the
       * header gets it for free, and a client that reads the JSON is not made to
       * parse a header it has no reason to look at.
       */
      if (e.status === 429 && typeof rest.retryAfterSec === "number") {
        res.setHeader("Retry-After", String(rest.retryAfterSec));
      }
      return res.status(e.status).json({
        error: code ?? codeForStatus[e.status] ?? "probe_failed",
        message: e.message,
        requestId: req.id,
        ...rest,
      });
    }
  }),
);

toolsRouter.get(
  "/:toolId",
  asyncHandler(async (req, res) => {
    const tool = await toolService.get(req.params.workspaceId, req.params.toolId);
    if (!tool) return res.status(404).json({ error: "not_found" });
    res.json({ tool });
  }),
);

toolsRouter.patch(
  "/:toolId",
  asyncHandler(async (req, res) => {
    const input = updateToolSchema.parse(req.body);
    const tool = await toolService.update(req.params.workspaceId, req.params.toolId, input);
    if (!tool) return res.status(404).json({ error: "not_found" });
    res.json({ tool });
  }),
);

toolsRouter.delete(
  "/:toolId",
  asyncHandler(async (req, res) => {
    const ok = await toolService.remove(req.params.workspaceId, req.params.toolId);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.status(204).send();
  }),
);
