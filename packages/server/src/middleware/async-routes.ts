// src/middleware/async-routes.ts — a rejected route promise must become a
// RESPONSE, not the end of the process.
//
// ── ⚠ WHY THIS EXISTS: ONE BAD QUERY STRING TOOK THE DEPLOYMENT DOWN ────────
//
// ⚠ **Express 5 (2026-10-22) forwards a rejected handler to the error middleware ITSELF**, so the outage below can no
// longer happen even unwrapped (`async-routes.test.ts` asserts it). The wrap stays as a second layer — it costs one
// closure per handler and keeps the 22P02 path independent of which router version is installed.
//
// Express **4** does not catch a rejected promise returned by a route handler.
// A handler written `async (req, res) => { … }` with no try/catch therefore
// turns any thrown error into an `unhandledRejection`, and Node 22's default
// for that is to terminate the process.
//
// Measured on the live deployment, 2026-09-08: `GET /api/me?workspaceId=ws_it`
// reached `workspace-member.service.find`, Postgres refused the non-uuid with
// `22P02`, and **the API server died** — restart count 15, `curl` receiving no
// response at all. Every other signed-in person's next request then failed with
// undici's `fetch failed` while the container restarted, which is what
// *"Could not read this workspace's runs — fetch failed"* was. Not a permission
// problem, not a local-accounts problem: an outage, triggerable by any caller,
// on any of the ~90 handlers that share this shape across 27 route files.
//
// ⚠ **The control for this ALREADY EXISTED and could not fire.** F5 added a
// `22P02 → 400` branch to `error.middleware.ts` precisely so a malformed
// identifier reads as the caller's mistake — but an error middleware is only
// reached through `next(err)`, and a rejected promise never calls it. So the
// right answer was written down, tested, and unreachable from the majority of
// the product's routes. I-38 with a very large blast radius.
//
// ── Why the stack is walked instead of 27 files being edited ────────────────
//
// A per-handler try/catch is the same fix ~90 times, and the 91st handler —
// written next week — reintroduces the outage with nothing reporting it. This
// is the shape this repo reaches for everywhere else: put the check in the one
// place every call passes through. `wrapAsyncRoutes` is applied once, in
// `createApp`, after every router is mounted.
//
// ⚠ **It must never be a silent no-op.** A walk that matched nothing would
// leave the product exactly as broken while reading as fixed, so it RETURNS the
// number of handlers it wrapped and `async-routes.test.ts` asserts a floor on
// it against the real app — a count, because "it ran" is satisfied by wrapping
// zero.
//
// ⚠ Express's layer stack is internal shape. That is the cost, and it is
// accepted over the alternative of an outage per un-caught route; the test
// above is what turns a change in that shape into a failure here rather than a
// crash in production.
import type { Express, NextFunction, Request, Response } from "express";
import { appStack } from "../auth/express-mount.js";

/** Marks a handler this module has already wrapped, so a second walk is a no-op. */
const WRAPPED = Symbol("foundry.asyncWrapped");

type Handler = ((req: Request, res: Response, next: NextFunction) => unknown) & {
  [WRAPPED]?: true;
  stack?: unknown;
};

/**
 * Wrap one handler so a rejection — or a synchronous throw — reaches `next`.
 *
 * ⚠ **A 4-argument function is left alone.** Express identifies an ERROR
 * handler by its arity, so wrapping one in a 3-argument function would silently
 * unregister `errorHandler` itself — the exact middleware this change exists to
 * reach.
 */
function wrapHandler(h: Handler): Handler {
  if (typeof h !== "function" || h.length >= 4 || h[WRAPPED]) return h;
  const wrapped = ((req: Request, res: Response, next: NextFunction) => {
    let out: unknown;
    try {
      out = h(req, res, next);
    } catch (e) {
      // A synchronous throw from a non-async handler. Express already handles
      // this one; catching it here keeps both paths identical rather than
      // leaving two answers to the same question.
      next(e);
      return;
    }
    if (out && typeof (out as Promise<unknown>).then === "function") {
      (out as Promise<unknown>).catch(next);
    }
    return out;
  }) as Handler;
  wrapped[WRAPPED] = true;
  /**
   * ⚠ **CARRY THE RBAC MARKER ACROSS.** `mount-permission-guards.ts` tags each guard it
   * splices with a symbol naming the permission it enforces, and
   * `route-permissions.test.ts`'s mount assertion reads that marker to check the guard
   * on each route matches the map. This wrapper replaces `layer.handle`, so without
   * this copy the marker is erased and the mount assertion silently asserts nothing —
   * which is exactly the failure `asyncHandler` erasing guard NAMES already caused once
   * in this feature. A wrapper must not destroy what it wraps was carrying.
   */
  for (const key of [RBAC_GUARD, RBAC_PLATFORM_GUARD, RBAC_CONTENT_GUARD]) {
    const marker = (h as unknown as Record<symbol, unknown>)[key];
    if (marker !== undefined) {
      Object.defineProperty(wrapped, key, { value: marker, enumerable: false });
    }
  }
  return wrapped;
}

/** Kept in step with `require-permission.middleware.ts`. `Symbol.for` is global. */
const RBAC_GUARD = Symbol.for("foundry.rbac.guard");
const RBAC_PLATFORM_GUARD = Symbol.for("foundry.rbac.platformGuard");
/** rbac-observability: the content guard's marker — which content a route checks. Carried like the two above. */
const RBAC_CONTENT_GUARD = Symbol.for("foundry.rbac.contentGuard");

type Layer = { route?: { stack?: Layer[] }; handle?: Handler };

function walk(stack: Layer[] | undefined, seen: Set<unknown>): number {
  let n = 0;
  for (const layer of stack ?? []) {
    // A `.route` layer holds the handlers registered for one path+verb.
    if (layer.route?.stack) {
      n += walk(layer.route.stack, seen);
      continue;
    }
    const h = layer.handle;
    // A mounted Router is itself a function carrying its own `.stack`. Recurse
    // into it and do NOT wrap it: it dispatches, it does not answer.
    if (typeof h === "function" && h.stack) {
      if (!seen.has(h)) {
        seen.add(h);
        n += walk(h.stack as Layer[], seen);
      }
      continue;
    }
    if (typeof h === "function") {
      const w = wrapHandler(h);
      if (w !== h) {
        layer.handle = w;
        n += 1;
      }
    }
  }
  return n;
}

/**
 * Make every mounted route handler forward its rejections.
 *
 * @returns how many handlers were wrapped. **Assert a floor on this** — see the
 * header. Zero means the walk found nothing and the process is still one bad
 * query string away from going down.
 */
export function wrapAsyncRoutes(app: Express): number {
  return walk(appStack<Layer>(app), new Set());
}
