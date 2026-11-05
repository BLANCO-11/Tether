/**
 * `engine-catalogues` — every workspace's catalogue, as the checker sees it, dumped for the legal-move property test
 * (compiled-builder phase 3, task 4: "over every catalogue on the deployment").
 *
 *   scripts/harness-in-net.sh packages/server/src/scenarios/engine-catalogues.ts [--write]
 *
 * Writes `src/services/__fixtures__/engine-catalogues.json`: per workspace, the `CatalogueSnapshot` (minus its function) and
 * the `RefInterface`s the save funnel reads. Demo workspaces only (all synthetic data); the rbac test workspaces carry no
 * catalogue. Schema METADATA only — no row is read. Without `--write` it compares with the committed file and exits 1 on drift.
 * No model calls.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildCatalogueSnapshot } from "../services/flow-typecheck.js";
import { manifestBuilderService } from "../services/manifest-builder.service.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";

const FILE = new URL("../services/__fixtures__/engine-catalogues.json", import.meta.url);
const out: Array<{ workspace: string; cat: unknown; ifaces: unknown }> = [];
for (const w of (await workspaceRepo.list()).filter((x: { deletedAt: unknown; name: string }) => !x.deletedAt && !/rbac/i.test(x.name)) as Array<{ id: string; name: string }>) {
  const ifaces = await manifestBuilderService.refInterfaces(w.id);
  const { renderInputs: _fn, ...cat } = await buildCatalogueSnapshot(w.id, undefined, ifaces);
  out.push({ workspace: w.name, cat, ifaces });
}
out.sort((a, b) => a.workspace.localeCompare(b.workspace));
const text = JSON.stringify(out, null, 1) + "\n";
if (process.argv.includes("--write")) { writeFileSync(FILE, text); console.log(`wrote ${out.length} catalogues, ${text.length} bytes`); process.exit(0); }
let committed = "";
try { committed = readFileSync(FILE, "utf8"); } catch { /* absent */ }
console.log(committed === text ? `same: ${out.length} catalogues` : `DRIFT: the deployment's catalogues differ from the committed fixture — re-run with --write`);
process.exit(committed === text ? 0 : 1);
