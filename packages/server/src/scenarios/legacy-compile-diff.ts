/**
 * Phase 3 exit criterion 3 — do stored revisions still compile byte-identically?
 *
 * Every `flow_revisions` row carries `compiled_yaml_hash`, the hash of the YAML
 * `writeRevision` compiled when the row was written. This recompiles each stored
 * `model_json` with the same options (draft namespace, no schedule, the same
 * labels) and compares. A match is byte-identity by construction; a mismatch is
 * listed, and `--out=<dir>` writes every YAML so a run at another commit can be
 * diffed against it. Reads only; writes nothing to any database or engine.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { flowCompiler } from "../services/flow-compiler.service.js";
import { flowService } from "../services/flow.service.js";

const out = process.argv.find((a) => a.startsWith("--out="))?.slice(6);
// CONTROL: perturb one label byte, so every row MUST differ. Without it a
// comparison that never reports a difference scores 27 of 27 (I-38).
const control = process.argv.includes("--control");
if (out) mkdirSync(out, { recursive: true });

const res = await db.execute(sql`
  select r.flow_id, r.revision, r.model_json, r.compiled_yaml_hash, r.created_at, f.workspace_id, f.name
  from flow_revisions r join flows f on f.id = r.flow_id order by r.created_at`);
const rows = (res as unknown as { rows: Array<Record<string, unknown>> }).rows;

let same = 0;
const differ: string[] = [];
const failed: string[] = [];
for (const r of rows) {
  const tag = `${r.name} r${r.revision} (${String(r.flow_id).slice(0, 8)}, ${new Date(r.created_at as string).toISOString().slice(0, 10)})`;
  try {
    const { draft } = await flowService.namespaces(r.workspace_id as string);
    const c = flowCompiler.compile(r.model_json as never, {
      namespace: draft,
      withSchedule: false,
      labels: { foundry_flow: String(r.flow_id), foundry_revision: String(r.revision) + (control ? "x" : ""), foundry_env: "draft" },
    });
    if (out) writeFileSync(join(out, `${r.flow_id}-r${r.revision}.yaml`), c.yaml);
    if (c.hash === r.compiled_yaml_hash) same++;
    else differ.push(tag);
  } catch (e) {
    failed.push(`${tag}: ${(e as Error).message.slice(0, 200)}`);
  }
}
if (control) {
  console.log(`CONTROL: ${differ.length} of ${rows.length} differ under a one-byte perturbation — ${differ.length === rows.length ? "the comparison can fail" : "⚠ INCONCLUSIVE"}`);
  await pool.end();
  process.exit(differ.length === rows.length ? 0 : 3);
}
console.log(`legacy compile: ${rows.length} revisions · ${same} byte-identical · ${differ.length} differ · ${failed.length} no longer compile`);
for (const d of differ) console.log(`  DIFFER  ${d}`);
for (const f of failed) console.log(`  FAILED  ${f}`);
await pool.end();
process.exit(failed.length ? 2 : differ.length ? 1 : 0);
