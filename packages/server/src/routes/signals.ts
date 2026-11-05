import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { operationalSignals } from "../services/operational-signals.service.js";
import { closedTo } from "../services/workspace-restriction.service.js";

export const signalsRouter = Router();

/**
 * "Is the system still doing its job?" — GAPS §6.1.
 *
 * ⚠ **AUTHENTICATED, unlike `/api/health`, and that is not an oversight.**
 * `/api/health` is open because a probe and a status pill need it and it names
 * nothing: components, statuses, latencies, and a `sanitizeDetail` that strips
 * URLs, hostnames and ids. This route names **workspaces and flows** — which
 * tenants exist, what their automations are called, which of them stopped
 * firing. That is a description of the customer base and it goes behind the
 * API key.
 *
 * ⚠ **Never merge this into `/api/health`.** The merge is tempting (one
 * endpoint, one dashboard) and it either drags tenant names onto an open route
 * or puts the liveness probe behind a credential. Both are worse than two
 * routes.
 *
 * ⚠ Mounted at `/api/signals` **exactly** — see the mount in `app.ts` and I-65.
 * The `app.use("/api", requireApiKey, signalsRouter)` form reads as scoping the
 * guard to this router and does not: it guards every `/api/*` path below it, and
 * it put Kestra's own callbacks behind the parent API key.
 *
 * It always returns **200**, including when a signal is in `alarm`. The status
 * code answers *"did this endpoint work"*; the body answers *"is the system
 * healthy"*, and conflating them means a monitoring probe that cannot
 * distinguish "the system is degraded" from "the monitoring is down".
 */
signalsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await operationalSignals(await closedTo(req.user)));
  }),
);
