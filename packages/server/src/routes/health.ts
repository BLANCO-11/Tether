import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { getHealthReport } from "../services/health.service.js";

export const healthRouter = Router();

/**
 * ⚠ Both routes here are UNAUTHENTICATED (`app.ts` mounts this router above the
 * API-key block). Nothing added to either may carry a URL, a container
 * hostname, a credential, an execution id or a Kestra namespace — see
 * `sanitizeDetail` in `health.service.ts`, and R5.
 */

/**
 * "Can this process serve requests?" — GAPS §6.2.
 *
 * 200 unless the process itself is broken. Kestra and ops-api are
 * reported as named components with their own status, latency and reason, and a
 * failure in any of them leaves this 200 on purpose: with the engine down this
 * API is still the only surface that can tell a person WHY, and taking it out
 * of the load balancer removes exactly that. `health.service.ts`'s header has
 * the full argument.
 *
 * `db` is still on the body. It is the field the old two-key response carried
 * and `foundryApi.parentHealth` reads it; keeping it costs one line and dropping
 * it would break a client for no gain.
 */
healthRouter.get(
  "/health",
  asyncHandler(async (req, res) => {
    const report = await getHealthReport({ fresh: req.query.fresh === "1" });
    res.status(report.serves ? 200 : 503).json({
      ...report,
      db: report.components.find((c) => c.name === "database")?.status === "up",
    });
  }),
);

/**
 * "Is every dependency wired?" — the deploy smoke test and the post-restart
 * readiness probe.
 *
 * Same body, stricter code: 503 unless every component is `up`. It is a second
 * URL rather than a query parameter on the first because the choice between
 * these two meanings belongs to whoever configures the probe, and a
 * `?strict=1` that changes a status code is the kind of thing that gets dropped
 * when a probe config is copied.
 *
 * ⚠ Do not point a load balancer at this one. It goes 503 when any component is
 * short of `up`, which is often a perfectly serviceable API.
 */
healthRouter.get(
  "/health/strict",
  asyncHandler(async (req, res) => {
    const report = await getHealthReport({ fresh: req.query.fresh === "1" });
    res.status(report.status === "ok" ? 200 : 503).json(report);
  }),
);
