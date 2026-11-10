/**
 * `POST /api/web/fetch` — the endpoint behind the built-in `web_fetch` tool (2026-10-30).
 *
 * Called by `step-execution.service.ts` when a workflow step runs `foundry.call("web_fetch", …)`, exactly as
 * `tether_email_send` reaches `/api/mail/send`: the tool row carries a key derived from `PARENT_API_KEY`
 * (`X-Foundry-Web-Key`), and the run travels as `x-foundry-run`. The run decides the workspace — never the body — so
 * a call that names no known run is refused rather than guessed at.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { asyncHandler } from "../middleware/error.middleware.js";
import { authFailureRule, authFailureThrottleInstance } from "../middleware/auth.middleware.js";
import { db } from "../db/index.js";
import { flowExecutions } from "../db/schema.js";
import { WebFetchError, webFetch } from "../services/web-fetch.service.js";
import { WEB_KEY_HEADER, webServiceKey } from "../services/web-service-key.js";

export function requireWebKey(req: Request, res: Response, next: NextFunction) {
  const provided = Buffer.from(req.header(WEB_KEY_HEADER) ?? "", "utf8");
  const expected = Buffer.from(webServiceKey(), "utf8");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    authFailureThrottleInstance.recordFailure(req.ip ?? "unknown");
    console.warn(`[web] auth failure from ${req.ip}`, { path: req.path, at: new Date().toISOString() });
    if (authFailureThrottleInstance.isThrottled(req.ip ?? "unknown")) {
      const retryAfter = Math.ceil(authFailureRule.windowMs / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "rate_limited", retryAfterSeconds: retryAfter });
    }
    return res.status(401).json({ error: "unauthorized", message: `Missing or invalid ${WEB_KEY_HEADER}` });
  }
  next();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fetchSchema = z
  .object({
    url: z.string().min(1).max(4000),
    /** HEAD: only the status and the type, no body. */
    method: z.enum(["GET", "HEAD"]).optional(),
    /** An HTML page as it came, not converted to Markdown — for a step that parses the page itself. */
    raw: z.boolean().optional(),
    /** Which step asked. Recorded, never trusted for anything. */
    stepId: z.string().max(200).optional(),
  })
  .strict();

export const webRouter = Router();

webRouter.post(
  "/fetch",
  asyncHandler(async (req, res) => {
    const parsed = fetchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
    const runId = req.header("x-foundry-run") ?? "";
    const [run] = UUID.test(runId)
      ? await db.select({ id: flowExecutions.id, workspaceId: flowExecutions.workspaceId }).from(flowExecutions).where(eq(flowExecutions.id, runId)).limit(1)
      : [];
    if (!run) {
      return res.status(422).json({ error: "no_run", message: "web_fetch is called from a workflow step; this call is not attached to a known run." });
    }
    try {
      const out = await webFetch(run.workspaceId, parsed.data.url, { executionId: run.id, stepId: parsed.data.stepId ?? null }, { method: parsed.data.method, raw: parsed.data.raw });
      res.json(out);
    } catch (e) {
      if (e instanceof WebFetchError) return res.status(e.statusCode).json({ error: e.code, message: e.message });
      throw e;
    }
  }),
);
