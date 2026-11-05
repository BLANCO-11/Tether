/**
 * `goalset-slots` — phase 0 task 6 (compiled-builder programme): how many binding
 * decisions in real built flows are FORCED (exactly one type-compatible source),
 * need a CHOICE of 2–10, or have MORE than 10. This sizes the laya chooser (phase 6).
 *
 *   scripts/harness-in-net.sh packages/server/src/scenarios/goalset-slots.ts --rows=baseline-rows.json --out=slots.json
 *
 * For each call step's port in each built flow, the candidates are every flow input
 * and every field of every OTHER step's row type, judged by the checker's own
 * `assignable`. An `Opaque` match is counted apart: the checker passes it without
 * checking (`types.ts:136`), so it is a candidate the types cannot rule in or out.
 *
 * ⚠ A LOWER bound on the choice space the new builder faces: combinator outputs
 * are not candidates here because today's flows have none. It reads the catalogue
 * as it is NOW, not as it was when the row was built. It makes no model calls.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { assignable, outputOf, portsOf, rowOf, tyOfFlowInput, type CheckModel, type Ty } from "@foundry/flow-edit";
import { buildCatalogueSnapshot } from "../services/flow-typecheck.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const ROWS = arg("rows"), OUT = arg("out");

type Bucket = "none" | "forced" | "2-10" | ">10";
const bucket = (n: number): Bucket => (n === 0 ? "none" : n === 1 ? "forced" : n <= 10 ? "2-10" : ">10");

async function main() {
  if (!ROWS || !OUT) throw new Error("need --rows=… and --out=…");
  const data = JSON.parse(readFileSync(ROWS, "utf8"));
  const ws = new Map((await workspaceRepo.list()).filter((w: any) => !w.deletedAt).map((w: any) => [w.name, w.id as string]));
  const decisions: Array<{ row: string; step: string; port: string; typed: number; opaque: number; bucket: Bucket; opaqueOnly: boolean }> = [];

  for (const r of data.rows as Array<{ id: string; round: number; workspace: string; model?: CheckModel }>) {
    if (!r.model?.steps) continue;
    const wsId = ws.get(r.workspace);
    if (!wsId) continue;
    const model = r.model;
    const cat = await buildCatalogueSnapshot(wsId, model as never);
    const inputs: Array<{ name: string; ty: Ty }> = (model.inputs ?? []).map((i) => ({ name: `input.${i.id}`, ty: tyOfFlowInput(i) }));
    for (const step of model.steps) {
      const ports = portsOf(step, cat) ?? [];
      if (!ports.length) continue;
      const fields: Array<{ name: string; ty: Ty }> = [];
      for (const other of model.steps) {
        if (other.id === step.id) continue;
        const out = outputOf(other, cat, model);
        if (!out) continue;
        const row = rowOf(out);
        if (row.t === "Record") for (const [k, v] of Object.entries(row.fields)) fields.push({ name: `${other.id}.${k}`, ty: v });
        else fields.push({ name: other.id, ty: row });
      }
      for (const p of ports) {
        let typed = 0, opaque = 0;
        for (const c of [...inputs, ...fields]) {
          const a = assignable(c.ty, p.ty);
          if (!a.ok) continue;
          if ("unchecked" in a && a.unchecked?.length) opaque++;
          else typed++;
        }
        decisions.push({ row: `${r.id}#${r.round}`, step: step.id, port: p.name, typed, opaque, bucket: bucket(typed), opaqueOnly: typed === 0 && opaque > 0 });
      }
    }
  }
  const tally = (b: Bucket) => decisions.filter((d) => d.bucket === b).length;
  const summary = {
    decisions: decisions.length,
    forced: tally("forced"), choice2to10: tally("2-10"), over10: tally(">10"), none: tally("none"),
    opaqueOnly: decisions.filter((d) => d.opaqueOnly).length,
    withAnyOpaque: decisions.filter((d) => d.opaque > 0).length,
  };
  console.log(JSON.stringify(summary));
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), summary, decisions }, null, 1));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(2); });
