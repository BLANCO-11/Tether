import type { Express } from "express";

/**
 * Where each mounted router sits — the one thing the route walkers need that Express 5 no longer keeps.
 *
 * ⚠ **Express 4 kept it on the layer and Express 5 does not.** Under Express 4 a mounted router's path could be rebuilt
 * from `layer.regexp.source` + `layer.keys`, and `route-stack.ts` and `mount-permission-guards.ts` each did exactly that.
 * Express 5's router (`router@2`) compiles the path into a closure in `layer.matchers` and keeps `layer.keys` empty, so
 * the path is simply not on the layer. A walker that kept reading `layer.regexp` would get `""` for every mount, look up
 * `GET /flows` instead of `GET /api/workspaces/:workspaceId/flows`, find no permission, and splice NO guard — every
 * workspace route open, with nothing raising an error.
 *
 * So `createApp()` calls {@link recordMountPaths} before its first `app.use`, and each layer an `app.use(path, …)` adds
 * is stamped with that path. Every path mount in this server is in `app.ts` (route files mount no router at a path), so
 * stamping the one app instance covers all of them; a router layer found WITHOUT a stamp throws rather than guessing.
 */
const MOUNT_PATH = Symbol.for("foundry.express.mountPath");

interface StampedLayer {
  [MOUNT_PATH]?: string;
  /** Express 5 sets it on a layer mounted at "/" with `end: false` — i.e. `app.use(fn)` / `router.use(fn)`. */
  slash?: boolean;
}

/** The app's top-level router stack (Express 5 keeps it on `app.router`; Express 4's `app._router` is gone). */
export function appStack<L>(app: Express): L[] | undefined {
  return (app as unknown as { router?: { stack?: L[] } }).router?.stack;
}

/**
 * Stamp every layer `app.use(path, …)` adds with `path`. Call once, right after `express()` and before any `app.use`.
 * Only this app instance is touched — no prototype is patched.
 */
export function recordMountPaths(app: Express): void {
  const use = app.use.bind(app) as (...args: unknown[]) => Express;
  (app as unknown as { use: (...args: unknown[]) => Express }).use = (...args: unknown[]) => {
    const path = typeof args[0] === "string" ? args[0] : "/";
    if (Array.isArray(args[0]) || args[0] instanceof RegExp) {
      throw new Error("recordMountPaths: mount a router at ONE string path — the route walkers cannot read an array or a RegExp");
    }
    const stack = appStack<StampedLayer>(app);
    const before = stack?.length ?? 0;
    const out = use(...args);
    const after = appStack<StampedLayer>(app) ?? [];
    for (let i = before; i < after.length; i++) after[i][MOUNT_PATH] = path;
    return out;
  };
}

/**
 * The path a router layer is mounted at, `""` for the root.
 *
 * ⚠ Throws on an unstamped, non-root router layer: returning `""` there would resolve every route under it to the wrong
 * path, and the permission splice keys on that path.
 */
export function mountPathOf(layer: StampedLayer): string {
  const stamped = layer[MOUNT_PATH];
  if (stamped !== undefined) return stamped === "/" ? "" : stamped.replace(/\/$/, "");
  // Express 5, mounted at "/" (`app.use(fn)` / `router.use(fn)`): `slash` is exactly that case.
  if (layer.slash) return "";
  throw new Error(
    "a router is mounted at a path this walker was not told — call recordMountPaths(app) before the first app.use",
  );
}
