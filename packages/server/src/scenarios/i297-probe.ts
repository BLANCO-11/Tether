/**
 * I-297 / D-323 probe — an engine-built flow that reads a DB OPERATION, saved through the real funnel and draft-run on Kestra. No model.
 * Before the fix the step was stored as `datasource` and the runtime resolved it as a named query (404). Deletes what it creates.
 *
 *   scripts/harness-in-net.sh packages/server/src/scenarios/i297-probe.ts --workspace="Customer Support" --ref=support_demo.tickets_by_status --port=status --value=open
 */
import { apply, emptyFlow, type EFlow, type EngineOp } from "@foundry/flow-edit";
import { buildCatalogueSnapshot } from "../services/flow-typecheck.js";
import { flowService } from "../services/flow.service.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { systemAuthor } from "../services/revision-author.js";
import { kestra } from "../services/kestra-client.service.js";
import type { FlowModel } from "../services/flow-compiler.service.js";
import { runDraft } from "./kestra-draft-run.js";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

async function main() {
  const wsName = arg("workspace")!, ref = arg("ref")!, port = arg("port"), value = arg("value");
  const ws = (await workspaceRepo.list()).find((w: any) => w.name === wsName && !w.deletedAt);
  if (!ws) throw new Error(`no workspace ${wsName}`);
  const cat = await buildCatalogueSnapshot(ws.id);
  let f: EFlow = emptyFlow("i297_probe");
  // `--bind=port=value` (a person's value) or `--bind=port=@catalogue` (the port's DECLARED default, D-323 — the engine refuses it
  // unless the catalogue states it). Repeatable.
  const binds = process.argv.filter((a) => a.startsWith("--bind=")).map((a) => a.slice(7).split(/=(.*)/s).slice(0, 2) as [string, string]);
  if (port && value) binds.unshift([port, value]);
  const bindOps = binds.map(([p, v]): EngineOp => {
    const fromCat = v === "@catalogue";
    const value = fromCat ? cat.refs[ref]?.params.find((x) => x.name === p)?.default ?? "" : v;
    return { op: "bind", stepId: "read_1", port: p, source: { from: "literal", value, provenance: fromCat ? "catalogue" : "person" } } as EngineOp;
  });
  const ops: EngineOp[] = [{ op: "add_reader", id: "read_1", ref }, ...bindOps, { op: "set_output", stepId: "read_1" }];
  for (const op of ops) { const r = apply(f, op, cat); if (!r.ok) throw new Error(`${op.op}: ${r.error}`); f = r.flow; }
  const { flow, revision } = await flowService.create(ws.id, { name: `i297-probe ${Date.now().toString(36)}`, model: f as unknown as FlowModel, author: systemAuthor() }, {}, null, false, { origin: "builder" });
  try {
    const stored = (revision.modelJson as { steps: Array<{ id: string; kind: string }> }).steps.find((s) => s.id === "read_1");
    console.log(`stored kind: ${stored?.kind} (ref kind in catalogue: ${cat.refs[ref]?.kind})`);
    const ex = await runDraft(ws.id, flow.id, {}, 120_000);
    console.log(`draft run: ${ex.state.current}`);
    if (ex.state.current !== "SUCCESS") {
      const logs: Array<{ taskId?: string; message?: string }> = await kestra.getExecutionLogs(ex.id, "ERROR").catch(() => []);
      console.log(`error: ${logs[0] ? `${logs[0].taskId}: ${logs[0].message}` : "(none)"}`.slice(0, 600));
    }
  } finally {
    await flowService.remove(ws.id, flow.id).catch((e) => console.error("cleanup failed", e));
    console.log(`left: ${(await flowRepo.listByWorkspace(ws.id)).filter((x: any) => String(x.name).startsWith("i297-probe")).length}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(2); });
