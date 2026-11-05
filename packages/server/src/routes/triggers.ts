import crypto from "node:crypto";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { fixedWindowLimiter } from "@foundry/shared";
import { config } from "../config/index.js";
import { asyncHandler } from "../middleware/error.middleware.js";
import {
  triggerService,
  createTriggerSchema,
  updateTriggerSchema,
} from "../services/trigger.service.js";
import { credentialProviderService } from "../services/credential-provider.service.js";

/**
 * Triggers bound to a FLOW — the only kind there is.
 * Mounted at `/api/workspaces/:workspaceId/flows/:flowId/triggers`.
 *
 * The script-bound router that used to sit above this one was deleted with
 * `scripts` in Phase 4 (task 4.11). Keeping them as two routers rather than one
 * with a `:scriptId ?? :flowId` in every handler is what made this a deletion
 * instead of an unpicking.
 *
 * `type: "schedule"` is refused here with an explanation: Kestra owns schedules
 * from §5.4 on, so a cron goes on the flow model and is armed by approving a
 * revision.
 */
export const flowTriggersRouter = Router({ mergeParams: true });

flowTriggersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({ triggers: await triggerService.listByFlow(req.params.workspaceId, req.params.flowId) });
  }),
);

flowTriggersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createTriggerSchema.parse(req.body);
    const t = await triggerService.createForFlow(req.params.workspaceId, req.params.flowId, input);
    res.status(201).json({ trigger: t });
  }),
);

flowTriggersRouter.patch(
  "/:tid",
  asyncHandler(async (req, res) => {
    const input = updateTriggerSchema.parse(req.body);
    const t = await triggerService.update(req.params.tid, input);
    if (!t) return res.status(404).json({ error: "not_found" });
    res.json({ trigger: t });
  }),
);

flowTriggersRouter.delete(
  "/:tid",
  asyncHandler(async (req, res) => {
    const ok = await triggerService.remove(req.params.tid);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.status(204).send();
  }),
);

/**
 * Fire now — starts the APPROVED revision in the live namespace, or 403s.
 *
 * ⚠ The response is BUILT, never spread (I-22). `fireFlow` resolves
 * `{ fire, executionId, kestraExecutionId, error }` and this route used to
 * `json(result)`, handing a client the engine's execution id — engine addressing,
 * against R5. In-process callers keep it; the wire gets Foundry-side facts only.
 *
 * `fireId` is what replaces it, and it is a better answer than the one it
 * removes: it is the `trigger_fires` row, written BEFORE the engine is called, so
 * it exists even for a fire that started nothing — which is the case anyone
 * debugging a silent automation is actually in. `GET …/:tid/fires` resolves it.
 *
 * `started` is a boolean because that is all the client ever read the leaked id
 * for (`lib/api.ts` said so in a comment). A Foundry execution id cannot be
 * returned here: the `flow_executions` row is created by the flow's own `begin`
 * task, which has not run yet at 202 time.
 *
 * The body carries `{ inputs?, payload? }`. `payload` is the audit trail, as
 * before — never engine inputs. `inputs` are the values THIS fire sends,
 * type-checked by `validateFireInputs` against the ARMED revision before the
 * fire row is written: a missing required input, a mistyped value or an
 * undeclared id is a 422 naming each input (the same contract as the api
 * receiver), replacing the 409 `fireFlow` used to throw after the row existed.
 * `fireFlow`'s own 409 stays for the paths that do not validate (poll,
 * internal callers).
 */
flowTriggersRouter.post(
  "/:tid/fire",
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { inputs?: Record<string, unknown>; payload?: unknown };
    const trigger = await triggerService.getForFire(req.params.tid);
    const validated = await triggerService.validateFireInputs(trigger, body.inputs);
    if (validated.issues.length) {
      // `message` is what a toast shows — without it the client renders raw
      // JSON for a refusal, which reads as a crash rather than an answer.
      return res.status(422).json({
        error: "invalid_inputs",
        message: validated.issues.map((i) => i.message).join("; "),
        issues: validated.issues,
      });
    }
    const result = await triggerService.fire(req.params.tid, "manual", body.payload, validated.inputs);
    res.status(202).json({
      fireId: result.fire.id,
      started: result.kestraExecutionId != null,
      error: result.error,
    });
  }),
);

/**
 * The fire audit trail. A fire that started nothing still writes a row — which
 * is exactly what someone debugging a silent automation needs to see.
 */
flowTriggersRouter.get(
  "/:tid/fires",
  asyncHandler(async (req, res) => {
    res.json({ fires: await triggerService.fires(req.params.tid) });
  }),
);

/**
 * The only bound on the two PUBLIC receivers below.
 *
 * They are the app's only routes that answer an anonymous caller and then do
 * work — `getByWebhookToken` is a database lookup, and on a hit the webhook
 * receiver fires a flow. Until this existed there was no limit of any kind on
 * that path: a loop drove unlimited lookups.
 *
 * ⚠ Keyed on IP, and IP is spoofable-by-proxy and shareable behind NAT. So this
 * is a DoS bound and NOT an authentication control — the token in the URL is the
 * credential, and for the `…/api` receiver the Bearer check is. Stated because a
 * limiter is easy to mistake for the thing that keeps callers out.
 *
 * ⚠ One limiter shared by both receivers, deliberately. Two would let a caller
 * spend the full allowance twice against the same lookup, which is the thing
 * being bounded.
 */
const receiverLimiter = fixedWindowLimiter({
  windowMs: 60_000,
  max: config.publicReceiverRatePerMinute,
});

/** Test-only: module state does not reset between test CASES. */
export function resetReceiverLimiterForTests() {
  Object.assign(
    receiverLimiter,
    fixedWindowLimiter({ windowMs: 60_000, max: config.publicReceiverRatePerMinute }),
  );
}

function limitPublicReceiver(req: Request, res: Response, next: NextFunction) {
  if (receiverLimiter.hit(req.ip ?? "unknown")) {
    // Never the token — it is the credential, and it is already in the path this
    // line would otherwise copy into the log.
    console.warn(`[receiver] rate limited ${req.ip}`, { at: new Date().toISOString() });
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ error: "rate_limited", retryAfterSeconds: 60 });
  }
  next();
}

/**
 * ⚠ **THE WEBHOOK RECEIVER IS RETIRED AND ANSWERS 404 UNCONDITIONALLY
 * (2026-09-08).** It was the only route in the product that took an
 * unauthenticated call and started a run. `api` is what replaced it — see
 * `FLOW_TRIGGER_TYPES` in `trigger.service.ts` for what the two actually
 * differed by, which was NOT authentication (both credentials are the token in
 * the URL) but whether the body's inputs reached the flow.
 *
 * ⚠ **IT STAYS MOUNTED, and 404 is the same answer it already gave** for an
 * unknown token, a disabled trigger or the wrong suffix — so a caller sees no
 * new failure mode and the URL keeps addressing nothing rather than erroring
 * differently. Unmounting it would answer 404 from Express's fallthrough
 * anyway; keeping the route is what lets it LOG, which is the half that makes
 * a retirement visible instead of silent.
 *
 * ⚠ **It refuses BEFORE the lookup, deliberately.** Looking the token up first
 * and refusing only an existing webhook would leave the retirement depending on
 * there being no rows — measured zero on this deployment, and not a property of
 * the code. Refusing unconditionally means a legacy row on any deployment
 * cannot fire, which is the fail-closed direction, and the log line names the
 * token prefix so an operator can find what called it.
 *
 * ⚠ The rate limit stays FIRST. A retired route that anyone may still call is
 * exactly a route worth bounding, and the limiter is a DoS bound rather than an
 * authentication control.
 */
export const webhookRouter = Router();
webhookRouter.post(
  "/:token/webhook",
  limitPublicReceiver,
  asyncHandler(async (req, res) => {
    // The token PREFIX only. Logging the whole value would write a live
    // credential into the log — the token in the URL is the credential.
    console.warn(
      `[triggers] refused a call to the RETIRED webhook receiver ` +
        `(token ${String(req.params.token).slice(0, 6)}…). Use the api trigger instead: ` +
        `POST /api/triggers/<token>/api with an Authorization: Bearer header.`,
    );
    return res.status(404).json({ error: "not_found" });
  }),
);

/**
 * Constant-time string comparison for the api receiver's Bearer check.
 *
 * The token is hex (36 chars) but the comparison must not reveal how many
 * characters matched — length itself is tolerated, since the stored token's
 * length is already public via the receiver path.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Phase 6 — authenticated programmatic receiver: `POST /api/triggers/:token/api`.
 *
 * Beside the webhook receiver, on a PUBLIC router (no API key — the caller is
 * a third party), differing in the two ways the design says:
 *
 *  - AUTH — the request must carry `Authorization: Bearer <value>`, where
 *    value is the workspace credential of kind `api` whose ref is the
 *    trigger's NAME. It is resolved through the Phase 5 credential-provider
 *    seam (`resolveCredential`), which maps api → trigger name → stored token,
 *    and compared in constant time. Wrong or missing → 401, and the response
 *    never says which part failed — no credential, wrong kind, wrong value all
 *    answer identically.
 *  - INPUTS — the body's typed `inputs` are validated against the flow's
 *    DECLARED inputs BEFORE anything is written. The webhook body is
 *    attacker-controlled and never reaches the engine; this caller is
 *    credential-authenticated, so its inputs may — but only after
 *    `triggerService.validateFireInputs` has type-checked them.
 *
 * After that the ordering is the webhook's, preserved exactly: `trigger_fires`
 * is written first (its id is stamped onto the Kestra execution as a label,
 * and `begin` reads it back to link the run), then the APPROVED live revision
 * is started, then the answer. The response carries `fireId` — the
 * `trigger_fires` row, which is the pointer to the `flow_executions` row once
 * the flow's own `begin` task has created it: `GET …/triggers/:tid/fires`
 * resolves `fireId` → `flowExecutionId`. A `flow_executions` id cannot be
 * returned here — the row does not exist at 202 time — and engine internals
 * never leave (R5).
 */
export const apiTriggerRouter = Router();
apiTriggerRouter.post(
  "/:token/api",
  limitPublicReceiver,
  asyncHandler(async (req, res) => {
    const trigger = await triggerService.getByWebhookToken(req.params.token);
    // Same silence as the webhook receiver: an unknown token, a disabled
    // trigger or a token that is not an api trigger's is "not found" — the URL
    // addresses nothing here.
    if (!trigger || !trigger.enabled || trigger.type !== "api") {
      return res.status(404).json({ error: "not_found" });
    }

    // ── Authenticate: Bearer must be this trigger's api credential ──────────
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    let authed = false;
    if (match) {
      const resolved = await credentialProviderService
        .resolveCredential(trigger.workspaceId, trigger.name)
        .catch(() => null);
      if (resolved && resolved.metadata.kind === "api" && constantTimeEqual(resolved.value, match[1])) {
        authed = true;
      }
    }
    if (!authed) return res.status(401).json({ error: "unauthorized" });

    // ── Typed inputs, validated BEFORE any row is written ────────────────────
    const body = (req.body ?? {}) as { inputs?: Record<string, unknown> };
    const validated = await triggerService.validateFireInputs(trigger, body.inputs);
    if (validated.issues.length) {
      return res.status(422).json({ error: "invalid_inputs", issues: validated.issues });
    }

    const result = await triggerService.fire(trigger.id, "api", req.body, validated.inputs);
    res.status(202).json({ fired: true, fireId: result.fire.id, error: result.error });
  }),
);
