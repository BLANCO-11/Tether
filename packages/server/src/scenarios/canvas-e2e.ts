/**
 * The manual builder end to end (compiled-builder phase 7): a flow built ONLY from canvas actions, on this deployment, through
 * the real funnel and the engine. For each workspace given (default: every one): create an empty flow, drop a call and leave it
 * incomplete (saved as the working copy), then build a complete flow — a reader, a shape, the result — and save it as a
 * revision (`writeRevision`: lowering, the gate, compile, the Kestra draft deploy); reopen it from the draft and check the engine
 * reads back what was saved. The flow it creates is DELETED at the end (Kestra first, then Foundry) — it touches nothing else.
 *
 *   ./scripts/harness-in-net.sh /repo/packages/server/src/scenarios/canvas-e2e.ts [--workspace=<id>]
 *
 * No model calls. ⚠ `main()` runs at import — never import this from a test.
 */
import { canvasCreate, canvasOpen, canvasAct, canvasSave, type CanvasView, type ActionView } from "../services/builder/canvas.service.js";
import { flowService } from "../services/flow.service.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { systemAuthor } from "../services/revision-author.js";
import { rng, sampleLiteral, type Ty } from "@foundry/flow-edit";
import { builderCatalogue } from "../services/builder/builder.service.js";

const only = process.argv.find((a) => a.startsWith("--workspace="))?.slice(12);
const workspaces = (await workspaceRepo.list()).filter((w) => !only || w.id === only);
let failed = 0;
const ok = (c: boolean, what: string) => { console.log(`  ${c ? "ok  " : "FAIL"} ${what}`); if (!c) failed++; };

async function act(ws: string, flowId: string, v: CanvasView, pick: (a: ActionView) => boolean, value?: string): Promise<CanvasView> {
  const a = v.actions.find(pick);
  if (!a) throw new Error("no such action listed");
  const r = await canvasAct(ws, flowId, { state: v.state, sig: v.sig, actionId: a.id, ...(value !== undefined ? { value } : {}) });
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r;
}

for (const w of workspaces) {
  console.log(`\n${w.name}`);
  const { flowId } = await canvasCreate(w.id, `canvas e2e (harness) ${Date.now().toString(36)}`);
  try {
    let v = (await canvasOpen(w.id, flowId)) as CanvasView;
    ok(!("legacy" in v) && v.state.steps.length === 0, "a new flow opens empty on the engine canvas");
    const reader = v.actions.find((a) => a.op?.op === "add_reader" && a.op.ref && !(a.op as { under?: string }).under);
    if (!reader) { console.log("  (no reader in this workspace — skipped)"); continue; }
    // Incomplete: a reader whose required inputs are unset, or the result undecided — saved as the working copy.
    v = await act(w.id, flowId, v, (a) => a.id === reader.id);
    const inc = await canvasSave(w.id, flowId, { state: v.state, sig: v.sig }, systemAuthor("canvas-e2e"));
    ok(inc.status === "incomplete", `with holes it saves as the working copy (${inc.status}, ${"holes" in inc ? inc.holes : 0} undecided)`);
    ok((await flowRepo.get(w.id, flowId))?.draftRevision === 0, "…and writes no revision");
    // Complete: fill the reader's required inputs — a listed source when there is one, else a value typed into the slot (retried
    // until one fits, as a person would), then a count and the result.
    v = (await canvasOpen(w.id, flowId)) as CanvasView;
    ok(v.state.steps.length === 1, "reopening shows the working copy");
    const readId = v.state.steps[0]!.id;
    const { cat } = await builderCatalogue(w.id);
    const r = rng(7);
    for (let guard = 0; guard < 10; guard++) {
      const port = v.state.holes.find((h) => h.site.at === "port") as { site: { stepId: string; port: string } } | undefined;
      if (!port) break;
      const here = v.actions.filter((a) => a.where.at === "port" && a.where.stepId === port.site.stepId && a.where.port === port.site.port);
      const src = here.find((a) => a.op?.op === "bind"), slot = here.find((a) => a.slot);
      if (src) { v = await act(w.id, flowId, v, (a) => a.id === src.id); continue; }
      if (!slot) break;
      let done = false;
      for (let t = 0; t < 12 && !done; t++) {
        const res = await canvasAct(w.id, flowId, { state: v.state, sig: v.sig, actionId: slot.id, value: sampleLiteral(slot.slot!.ty as Ty, cat, r) });
        if (!("refused" in res)) { v = res; done = true; }
      }
      if (!done) break;
    }
    ok(!v.state.holes.some((h) => h.site.at === "port"), "every required input filled from the listed sources or a typed value");
    const shape = v.actions.find((a) => a.op?.op === "add_transform" && (a.op as { from: string }).from === readId && !(a.op as { under?: string }).under && /count rows/.test(a.label));
    if (shape && !v.state.holes.some((h) => h.site.at === "port")) {
      v = await act(w.id, flowId, v, (a) => a.id === shape.id);
      const shapeId = v.state.steps.at(-1)!.id;
      v = await act(w.id, flowId, v, (a) => a.op?.op === "set_output" && (a.op as { stepId: string }).stepId === shapeId);
      ok(v.complete, "a reader, a count and the result: complete");
      const done = await canvasSave(w.id, flowId, { state: v.state, sig: v.sig }, systemAuthor("canvas-e2e"));
      ok(done.status === "complete" && done.revision > 0, `complete saves as a revision through writeRevision (revision ${"revision" in done ? done.revision : "—"})`);
      const re = (await canvasOpen(w.id, flowId)) as CanvasView;
      ok(!("legacy" in re) && re.state.steps.length === 2 && re.state.output?.stepId === shapeId && re.complete, "reopened from the draft, the engine reads back what was saved");
      ok(!(await flowService.getIncomplete(w.id, flowId)), "the working copy is dropped once a revision is written");
    } else console.log("  (no fillable reader + count here — complete path skipped)");
  } catch (e) { ok(false, `threw: ${(e as Error).message.slice(0, 300)}`); }
  finally { await flowService.remove(w.id, flowId); console.log("  (its flow deleted)"); }
}
console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
