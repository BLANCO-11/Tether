import { describe, it, expect } from "vitest";
import express from "express";
import { recordMountPaths } from "./express-mount.js";
import { mountedRoutes } from "./route-stack.js";

/**
 * Express 5 keeps no mount path on a router layer, so the walkers read the path `recordMountPaths` stamped at
 * `app.use`. A walker resolving `""` for a mount would key the permission splice on the wrong path and guard nothing —
 * so the failure modes are asserted here, not only the happy path.
 */
describe("mount paths under Express 5", () => {
  it("resolves a route under a parameterised mount to its full path", () => {
    const app = express();
    recordMountPaths(app);
    const r = express.Router({ mergeParams: true });
    r.get("/:flowId", (_req, res) => res.end());
    r.post("/", (_req, res) => res.end());
    app.use("/api/workspaces/:workspaceId/flows", r);
    app.use((_req, _res, next) => next());

    const keys = mountedRoutes(app).map((x) => `${x.method} ${x.path}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        "GET /api/workspaces/:workspaceId/flows/:flowId",
        "POST /api/workspaces/:workspaceId/flows",
      ]),
    );
  });

  it("a router mounted at the root keeps the paths it declares", () => {
    const app = express();
    recordMountPaths(app);
    const inner = express.Router();
    inner.get("/health", (_req, res) => res.end());
    const outer = express.Router();
    outer.use(inner);
    app.use("/api", outer);
    expect(mountedRoutes(app).map((x) => `${x.method} ${x.path}`)).toContain("GET /api/health");
  });

  /** The control: without the stamp the walker must refuse, never fall back to "". */
  it("CONTROL — an unrecorded mount throws instead of resolving to the wrong path", () => {
    const app = express();
    const r = express.Router();
    r.get("/x", (_req, res) => res.end());
    app.use("/api/somewhere", r);
    expect(() => mountedRoutes(app)).toThrow(/recordMountPaths/);
  });
});

/**
 * `@types/express-serve-static-core` is pinned to 5.0.7 (root `package.json` overrides), whose `req.params` values are
 * `string`. 5.1 widened them to `string | string[]` because an Express 5 wildcard (`/*rest`) captures an ARRAY. That
 * pin is only true while no route uses a wildcard or an optional group — this is what keeps it true.
 */
describe("the real app", async () => {
  const { createApp } = await import("../app.js");
  const routes = mountedRoutes(createApp());

  it("walks the whole app — CONTROL", () => {
    expect(routes.length).toBeGreaterThan(150);
    expect(routes.some((r) => r.path.startsWith("/api/workspaces/:workspaceId/"))).toBe(true);
  });

  it("no route uses an Express 5 wildcard or optional group", () => {
    const offenders = routes.filter((r) => /[*{}]/.test(r.path)).map((r) => `${r.method} ${r.path}`);
    expect(offenders).toEqual([]);
  });
});
