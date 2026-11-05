/**
 * Slice 5d probe (D-311): every workspace's tables as readers — how many compile, how many fields each offers, how large the
 * spec's field enum becomes. METADATA ONLY (schema rows), never a row value. No model call. `harness-in-net.sh` it.
 */
import { workspaceRepo } from "../repositories/workspace.repo.js";
import * as builder from "../services/builder/builder.service.js";
import { fieldPairs, goalSpecSchema, shapeSchema } from "../services/builder/goal-spec.js";
import { isTableRef } from "../services/builder/table-readers.js";

async function main() {
  for (const w of await workspaceRepo.list()) {
    const { items } = await builder.builderCatalogue(w.id);
    const tables = items.items.filter((i) => isTableRef(i.ref));
    const saved = items.items.filter((i) => i.kind === "reader" && !isTableRef(i.ref));
    const widest = Math.max(0, ...tables.map((t) => t.fields?.length ?? 0));
    const enums = (x: unknown): number => (Array.isArray(x) ? x.reduce((a: number, y) => a + enums(y), 0) : x && typeof x === "object" ? Object.entries(x as Record<string, unknown>).reduce((a, [k, v]) => a + (k === "enum" && Array.isArray(v) ? v.length : enums(v)), 0) : 0);
    const widest2 = [...items.items].filter((i) => i.kind === "reader").sort((a, b) => (b.fields?.length ?? 0) - (a.fields?.length ?? 0)).slice(0, 2).map((i) => i.ref);
    console.log(`${w.name.padEnd(36)} spec-schema enums ${enums(goalSpecSchema(items))} · worst shape-schema enums ${enums(shapeSchema(items, widest2))} (limit 1000)`);
    console.log(`${w.name.padEnd(36)} saved readers ${String(saved.length).padStart(2)} · tables ${String(tables.length).padStart(2)} · widest ${widest} fields · field enum ${fieldPairs(items).length}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
