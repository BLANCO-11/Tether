// Prints one `METHOD path\tguards` row per reachable route of `createApp()`.
//
// ⚠ Rewritten 2026-10-27: the first version walked Express 4's `app._router` and its `layer.regexp`, which Express 5
// removed — it crashed on `_router.stack`. It now uses `src/auth/route-stack.ts`, the SAME walker
// `route-permissions.test.ts` checks the map against, so the generator and the check cannot disagree about the stack.
import { createApp } from "./src/app.js";
import { mountedRoutes } from "./src/auth/route-stack.js";

const routes = mountedRoutes(createApp());
for (const r of [...routes].sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`))) {
  console.log(`${r.method} ${r.path}\t${r.guards.join(",") || "-"}`);
}
console.error(`TOTAL ${routes.length}`);
