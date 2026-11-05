/**
 * Remove the leftover "Untitled" drafts.
 *
 * ⚠ CLAUDE.md records these as "somebody's working state, not junk this feature
 * may decide about" — so they survived several passes deliberately. Removed
 * here on an explicit instruction, and the flows deleted BY ID rather than by a
 * name pattern applied blindly: a `name ILIKE 'untitled%'` sweep would take any
 * future flow somebody had not yet named.
 */
import { log, head } from "./uat-lifecycle.js";
import { kestra } from "../services/kestra-client.service.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowService } from "../services/flow.service.js";

async function main() {
  head("CLEAR THE LEFTOVER DRAFTS");
  for (const ws of await workspaceRepo.list()) {
    for (const f of await flowRepo.listByWorkspace(ws.id)) {
      if (!/^untitled/i.test(f.name)) continue;
      // ⚠ Never an armed flow, whatever it is called. An armed flow is one a
      // person approved and a schedule may be pointing at.
      if (f.armedRevision !== null) { log(`SKIP  ${ws.name}/${f.name} — armed at ${f.armedRevision}`); continue; }
      for (const suffix of ["", ".draft"]) {
        const ns = `foundry.${ws.tenantSlug}.${ws.slug}${suffix}`;
        try {
          await kestra.deleteFlow({ value: ns } as never, f.kestraFlowId);
          log(`  kestra ${ns}/${f.kestraFlowId} deleted`);
        } catch { /* never deployed there */ }
      }
      await flowService.remove(ws.id, f.id);
      log(`DELETED ${ws.name}/${f.name}  (${f.status}, draft rev ${f.draftRevision})`);
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
