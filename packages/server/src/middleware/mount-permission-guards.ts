// src/middleware/mount-permission-guards.ts — put the permission guard in front of
// every route that declares one, once, at boot.
//
// ── ⚠ WHY A BOOT-TIME SPLICE AND NOT A MOUNTED MIDDLEWARE ───────────────────
//
// The obvious shape — `router.use(permissionGuard)` on each workspace router — CANNOT
// WORK. A router-level middleware runs *before* Express has matched the sub-route, so
// `req.route` is empty and the guard cannot know which handler is about to run. To find
// out, it would have to re-match `req.method` + `req.path` against the map itself, which
// means re-implementing `path-to-regexp` AND Express's route-ordering rules. Those rules
// are load-bearing here: `GET /flows/builder/...` and `GET /flows/:flowId` are
// distinguished by REGISTRATION ORDER alone, and a hand-rolled matcher that got that
// backwards would hand the jobs list the `:flowId` permission and never say so.
//
// ⚠ **AND `app.use("/api", guard)` IS FORBIDDEN OUTRIGHT.** That form attaches to every
// `/api/*` request reaching the line, which silently puts the Kestra step callbacks
// behind the parent key — after which every flow dies at `begin` with no
// `flow_executions` row and no error naming the cause (I-65). It has happened here.
//
// So: walk the mounted stack once, resolve each route against the SAME map the
// completeness check uses, and splice the guard in front of that route's own handlers.
// This is the shape `wrapAsyncRoutes` already uses on this codebase, for the same
// reason — the alternative is the same edit in 44 route files, and the 45th file,
// written next month, silently ships open.
//
// ⚠ **IT MUST NEVER BE A SILENT NO-OP.** A walk that spliced nothing would leave 106
// routes exactly as open while reading as closed, so it RETURNS A COUNT, the count is
// logged at boot, and `route-permissions.test.ts` asserts a floor on it against the real
// app. "It ran" is satisfied by splicing zero (I-38).
import type { Express, NextFunction, Request, Response } from "express";
import { requirePermission, guardMarker } from "./require-permission.middleware.js";
import {
  requirePlatformPermission,
  platformGuardMarker,
} from "./platform-permission.middleware.js";
import { ROUTE_PERMISSIONS, routeKey } from "../auth/route-permissions.js";
import { contentGuard } from "./content-guard.middleware.js";
import { appStack, mountPathOf } from "../auth/express-mount.js";

/** Marks a handler this module has already put a guard in front of. */
const GUARDED = Symbol("foundry.rbac.spliced");

type Handler = ((req: Request, res: Response, next: NextFunction) => unknown) & {
  [GUARDED]?: true;
};

interface RouteLayer {
  method?: string;
  name?: string;
  handle?: Handler;
}

interface Layer {
  slash?: boolean;
  route?: { path?: string; stack?: RouteLayer[] };
  handle?: { stack?: Layer[] } & Function;
}


/**
 * Put `guard` in front of `first`, preserving arity and the RBAC marker.
 *
 * ⚠ **Composed rather than unshifted as a new layer.** Constructing an Express `Layer`
 * means importing `express/lib/router/layer`, which is deeper into internals than this
 * needs to go; composing two handlers needs no internal constructor at all.
 *
 * ⚠ **The marker is copied onto the composition.** `mountedRoutes` reads the marker off
 * `handle` to check that the guard mounted on a route declares the same permission the
 * map does. Leave it on the inner function and the walker sees an unmarked handler —
 * which is how the mount assertion would end up asserting nothing (the failure mode that
 * already bit this feature once, via `asyncHandler` erasing guard names).
 */
function compose(guard: Handler, first: Handler): Handler {
  const guarded = function guardedHandler(req: Request, res: Response, next: NextFunction) {
    return guard(req, res, (err?: unknown) => {
      if (err) return next(err);
      return first(req, res, next);
    });
  } as Handler;
  guarded[GUARDED] = true;
  const marker = guardMarker(guard);
  if (marker) {
    Object.defineProperty(guarded, Symbol.for("foundry.rbac.guard"), {
      value: marker,
      enumerable: false,
    });
  }
  const platformMarker = platformGuardMarker(guard);
  if (platformMarker) {
    Object.defineProperty(guarded, Symbol.for("foundry.rbac.platformGuard"), {
      value: platformMarker,
      enumerable: false,
    });
  }
  return guarded;
}

function withContentGuard(guard: Handler, inner: Handler): Handler {
  return function contentGuardedHandler(req: Request, res: Response, next: NextFunction) {
    return guard(req, res, (err?: unknown) => {
      if (err) return next(err);
      return inner(req, res, next);
    });
  } as Handler;
}

function walk(stack: Layer[] | undefined, prefix: string, seen: Set<unknown>): number {
  let n = 0;
  for (const layer of stack ?? []) {
    if (layer.route) {
      const rp = layer.route.path === "/" ? "" : (layer.route.path ?? "");
      const path = prefix + rp || "/";
      const routeStack = layer.route.stack ?? [];
      const first = routeStack[0];
      if (!first || typeof first.handle !== "function") continue;

      // A route registered under several methods has one stack per method layer;
      // `layer.route.stack[i].method` tells them apart. Guard by the method the first
      // layer declares, falling back to every method present.
      const methods = [...new Set(routeStack.map((h) => h.method).filter(Boolean))] as string[];
      for (const method of methods) {
        const req = ROUTE_PERMISSIONS.get(routeKey(method, path));
        // ⚠ An identity-only route is a DECISION recorded in the map, not an omission —
        // needing a permission to discover you have none is a bootstrap nobody can
        // escape. An exempt route is not in this map at all.
        if (req?.kind !== "workspace" && req?.kind !== "platform") continue;

        // Splice in front of the first handler CARRYING THIS METHOD, so a route
        // registered for two methods with different permissions guards each correctly.
        const target = routeStack.find((h) => h.method === method) ?? first;
        if (!target.handle || target.handle[GUARDED]) continue;
        // Already carries a hand-mounted guard of either tier — leave it alone rather
        // than stacking a second, which would silently make the route an AND.
        if (guardMarker(target.handle) || platformGuardMarker(target.handle)) continue;
        if (seen.has(target)) continue;
        seen.add(target);

        const guard = (
          req.kind === "workspace"
            ? requirePermission(req.permission, { param: req.param })
            : requirePlatformPermission(req.permission)
        ) as unknown as Handler;
        // The content guard runs AFTER the permission guard (rbac-observability): may they see THIS automation,
        // chat, run or session. Wrapped first so the permission guard stays outermost and keeps its marker.
        const content = req.kind === "workspace" ? contentGuard(req.permission, req.param) : null;
        if (content) target.handle = withContentGuard(content as unknown as Handler, target.handle);
        target.handle = compose(guard, target.handle);
        // Marked so `mountedRoutes` can report it — `content-guard.test.ts` asserts every route naming content has one.
        if (content) {
          Object.defineProperty(target.handle, Symbol.for("foundry.rbac.contentGuard"), { value: ["request"], enumerable: false });
        }
        n += 1;
      }
      continue;
    }
    if (layer.handle && (layer.handle as { stack?: Layer[] }).stack) {
      n += walk((layer.handle as { stack?: Layer[] }).stack, prefix + mountPathOf(layer), seen);
    }
  }
  return n;
}

/**
 * Put the declared permission guard in front of every route that declares one —
 * workspace-scoped and platform-tier alike.
 *
 * @returns how many routes were guarded. **Assert a floor on this.** Zero means the walk
 * found nothing and 106 routes are still open while the boot log reads as if they are
 * not.
 */
export function mountPermissionGuards(app: Express): number {
  return walk(appStack<Layer>(app), "", new Set());
}
