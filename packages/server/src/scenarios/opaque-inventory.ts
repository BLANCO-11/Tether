/**
 * `opaque-inventory` — every ref, in every workspace, whose output is still `Opaque` (compiled-builder phase 2 exit gate).
 *
 *   scripts/harness-in-net.sh packages/server/src/scenarios/opaque-inventory.ts
 *
 * An `Opaque` output is one the types cannot check a read of. The gate is that none can reach a typed port: the combinators
 * refuse an Opaque input outright (a pipeline over it does not type), and phase 3's legal-move engine offers only
 * type-compatible sources. This lists what is left, so the residue is a named set rather than an assumption. No model calls.
 */
import { buildCatalogueSnapshot } from "../services/flow-typecheck.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";

const hasOpaque = (ty: unknown): boolean => JSON.stringify(ty).includes('"Opaque"');
const total: Record<string, number> = {};
const opaque = new Map<string, Set<string>>();
for (const w of (await workspaceRepo.list()).filter((x: { deletedAt: unknown; name: string }) => !x.deletedAt && !x.name.includes("rbac") && !x.name.includes("zrbac"))) {
  const cat = await buildCatalogueSnapshot(w.id);
  for (const [ref, sig] of Object.entries(cat.refs)) {
    total[sig.kind] = (total[sig.kind] ?? 0) + 1;
    if (hasOpaque(sig.payload)) {
      const k = `${sig.kind} ${ref}`;
      if (!opaque.has(k)) opaque.set(k, new Set());
      opaque.get(k)!.add(w.name);
    }
  }
}
console.log(`refs by kind: ${JSON.stringify(total)}`);
console.log(`refs whose output is still Opaque: ${opaque.size} distinct`);
for (const [k, ws] of [...opaque].sort()) console.log(`  ${k.padEnd(40)} ${ws.size} workspace(s)`);
process.exit(0);
