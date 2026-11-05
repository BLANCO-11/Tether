/**
 * `typecheck:report` — phased-typed-build phase 1 task 6. REPORT MODE: runs the
 * composite checker over EVERY revision on the deployment and counts what it
 * finds. Reads only; writes nothing to the database.
 *
 *   pnpm --filter @foundry/server typecheck:report [--out=f.json] [--show=FT0201]
 *
 * ⚠ An ERROR on an ARMED revision is the line to triage: it is either a true
 * positive (the flow is broken and running) or a checker bug. Both go in
 * `phase-1-type-system/issues.md`, one each, never as a count alone.
 */
import { writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { renderDiagnostic, type Diagnostic } from "@foundry/flow-edit";
import { db } from "../db/index.js";
import { flowRevisions, flows, workspaces } from "../db/schema.js";
import { buildCatalogueSnapshot, typecheckWith } from "../services/flow-typecheck.js";
import { manifestBuilderService } from "../services/manifest-builder.service.js";
import type { FlowModel } from "../services/flow-compiler.service.js";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const OUT = arg("out");
const SHOW = arg("show");

async function main() {
  const rows = await db
    .select({ rev: flowRevisions.revision, model: flowRevisions.modelJson, flowId: flows.id, flowName: flows.name, ws: flows.workspaceId, armed: flows.armedRevision, draft: flows.draftRevision, wsName: workspaces.name })
    .from(flowRevisions)
    .innerJoin(flows, eq(flowRevisions.flowId, flows.id))
    .innerJoin(workspaces, eq(flows.workspaceId, workspaces.id));

  const ifaceCache = new Map<string, Awaited<ReturnType<typeof manifestBuilderService.refInterfaces>>>();
  const byCode: Record<string, { error: number; warning: number; hole: number; revisions: number }> = {};
  const results: Array<{ flow: string; ws: string; rev: number; armed: boolean; latest: boolean; diagnostics: Diagnostic[] }> = [];

  for (const r of rows) {
    const model = r.model as FlowModel;
    if (!ifaceCache.has(r.ws)) ifaceCache.set(r.ws, await manifestBuilderService.refInterfaces(r.ws));
    const cat = await buildCatalogueSnapshot(r.ws, model);
    let ds: Diagnostic[];
    try {
      ds = typecheckWith(model, cat, ifaceCache.get(r.ws)!);
    } catch (e) {
      console.log(`CHECKER CRASH on ${r.flowName} r${r.rev}: ${(e as Error).stack}`);
      continue;
    }
    const seen = new Set<string>();
    for (const d of ds) {
      byCode[d.code] ??= { error: 0, warning: 0, hole: 0, revisions: 0 };
      byCode[d.code]![d.severity]++;
      if (!seen.has(d.code)) { byCode[d.code]!.revisions++; seen.add(d.code); }
    }
    results.push({ flow: r.flowName, ws: r.wsName, rev: r.rev, armed: r.armed === r.rev, latest: r.draft === r.rev, diagnostics: ds });
  }

  const errs = (x: (typeof results)[number]) => x.diagnostics.filter((d) => d.severity === "error").length;
  console.log(`typecheck:report · ${results.length} revisions · ${new Set(results.map((r) => r.flow + r.ws)).size} flows`);
  console.log(`revisions with ≥1 error: ${results.filter((r) => errs(r) > 0).length} · armed revisions: ${results.filter((r) => r.armed).length}, with errors: ${results.filter((r) => r.armed && errs(r) > 0).length}`);
  console.log("\ncode     errors  warnings  revisions");
  for (const [code, c] of Object.entries(byCode).sort()) console.log(`${code}   ${String(c.error).padStart(6)}  ${String(c.warning).padStart(8)}  ${String(c.revisions).padStart(9)}`);

  for (const r of results.filter((r) => r.armed || r.latest)) {
    const shown = r.diagnostics.filter((d) => (SHOW ? d.code === SHOW : d.severity === "error"));
    if (!shown.length) continue;
    console.log(`\n── ${r.ws} · ${r.flow} · r${r.rev}${r.armed ? " · ARMED" : ""}${r.latest ? " · latest" : ""}`);
    for (const d of shown) console.log(renderDiagnostic(d).replace(/^/gm, "   "));
  }
  if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), byCode, results }, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(2); });
