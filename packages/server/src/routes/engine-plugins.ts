import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { enginePluginService } from "../services/engine-plugin.service.js";
import { requireIdentity } from "../middleware/identity.middleware.js";

/**
 * `GET /api/engine/plugins` — what the execution engine can do.
 * ui-upgrade Phase 9 · D-111
 *
 * ── ⚠ NOT under `/workspaces/:ws`, and that is the decision ─────────────────
 *
 * `plan.md` 9.1 proposes `GET /api/workspaces/:ws/engine-plugins`. It is not
 * built there, because the path would state something false: plugins are a
 * property of the **engine's build**, not of a tenant. Kestra has no
 * tenant-scoped plugin endpoint at all — `/api/v1/main/plugins` is a 404 — and
 * every workspace on this deployment sees exactly the same list. A
 * workspace-scoped URL invites a per-workspace registry, which is a feature
 * nobody has decided to build and which the engine could not serve.
 *
 * Same shape as `/api/signals` (D-71): its own path, its own router, API-key
 * authenticated at its exact mount.
 *
 * ── What it is NOT ──────────────────────────────────────────────────────────
 *
 * Not a proxy. The browser gets a **shaped view**, never Kestra's response, and
 * never a Kestra URL — clients do not address the engine (R5). Installing a
 * plugin is deliberately out of scope (D-85): provisioning the engine is a
 * deployment operation, and a button here would be one that rebuilds an image.
 */
export const enginePluginsRouter = Router();

enginePluginsRouter.get(
  "/plugins",
  requireIdentity,
  asyncHandler(async (_req, res) => {
    // ⚠ 200 even when the engine is unreachable. `reachable: false` plus the
    // transport diagnosis is the answer; a 503 here would take the page down
    // and remove the only surface that could say why — the same argument
    // `/api/health` makes for staying `ok` while Kestra is down (D-62).
    res.json(await enginePluginService.list());
  }),
);

/**
 * `GET /api/engine/plugins/:name/credentials` — what one plugin needs in order
 * to authenticate, read from the engine's own property schema.
 *
 * ⚠ **Declared AFTER `/plugins`, and `:name` is a plugin name like
 * `plugin-slack`** — never a class, and never anything a client composes into a
 * Kestra URL. The engine call happens here; the browser gets field names and
 * prose.
 *
 * ⚠ **This route reads. It stores nothing and it does not make the plugin
 * usable.** `usableToday` is on every response for that reason — see the
 * service's docblock, which carries the Phase 8 question this is groundwork for.
 */
enginePluginsRouter.get(
  "/plugins/:name/credentials",
  requireIdentity,
  asyncHandler(async (req, res) => {
    // 200 with `reachable: false` for the same reason `/plugins` does — a 503
    // takes down the only surface that could explain itself (D-62).
    res.json(await enginePluginService.credentials(req.params.name));
  }),
);
