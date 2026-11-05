/**
 * Removes the UAT lifecycle probe's tenant — flows, triggers, executions, the
 * workspace, the Kestra namespace, and the synthetic identities it minted.
 *
 * ⚠ It does NOT touch `support_demo`. The probe registered its own read-only
 * credential against a database three other workspaces read; dropping the data
 * because a borrower left would be the borrower deleting the library.
 */
import { http, log, head, SUPER } from "./uat-lifecycle.js";
import { kestra } from "../services/kestra-client.service.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowService } from "../services/flow.service.js";

const NAME = "UAT lifecycle";

async function main() {
  head(`TEARDOWN · ${NAME}`);
  const ws = (await workspaceRepo.list()).find((w) => w.name === NAME);
  if (!ws) { log("already gone"); return; }
  log(`workspace ${ws.id}  namespace foundry.${ws.tenantSlug}.${ws.slug}`);

  for (const f of await flowRepo.listByWorkspace(ws.id)) {
    for (const nsSuffix of ["", ".draft"]) {
      const ns = `foundry.${ws.tenantSlug}.${ws.slug}${nsSuffix}`;
      try {
        await kestra.deleteFlow({ value: ns } as never, f.kestraFlowId);
        log(`  kestra ${ns}/${f.kestraFlowId} deleted`);
      } catch (e) {
        log(`  kestra ${ns}/${f.kestraFlowId}: ${(e as Error).message.slice(0, 80)}`);
      }
    }
    await flowService.remove(ws.id, f.id);
    log(`  flow "${f.name}" removed`);
  }

  const d = await http("DELETE", `/workspaces/${ws.id}`, undefined, SUPER);
  log(`\nDELETE workspace → HTTP ${d.status} ${d.status >= 400 ? JSON.stringify(d.body).slice(0, 200) : ""}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
