/**
 * `pnpm --filter @foundry/server generic:flows` — one demo flow per generic
 * domain, authored, run once and armed.
 *
 * Author → test-run → arm, the same sequence `itops:scenarios` uses and for the
 * same reason: gate 1 REFUSES to approve a flow that has never completed a run,
 * so this cannot hand itself an armed flow. The side benefit matters more —
 * every Pebble expression is actually EVALUATED, and an expression that renders
 * prose into a JSON body typechecks perfectly and fails only here.
 *
 * ⚠ **IT SEEDS, IT DOES NOT SCORE.** A green run proves the YAML is valid and
 * the expressions render. It does NOT prove the right arm fired — which is the
 * only interesting question about a branching flow and the one thing that can be
 * wrong while everything is green. `--as-of` is how you check the other arm: run
 * it at an instant where the query is empty and watch which tasks appear.
 */
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowService } from "../services/flow.service.js";
import { flowApprovalService } from "../services/flow-approval.service.js";
import { manifestBuilderService } from "../services/manifest-builder.service.js";
import { kestra } from "../services/kestra-client.service.js";
import { runDraft, stepReport } from "./kestra-draft-run.js";
import { GENERIC_FLOWS } from "./generic-flows.js";
import { GENERIC_GENERATED_QUERIES } from "../demo/generic-generated.js";
import { GENERIC_DOMAINS } from "../demo/generic/index.js";
import { genericToolCatalogue } from "../demo/generic/tools.js";
import { createToolSchema, toolService } from "../services/tool.service.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { checkSqlShape } from "../services/datasource-query.service.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { datasourceQueryRepo } from "../repositories/datasource-query.repo.js";
import { systemAuthor } from "../services/revision-author.js";
import { CATALOGUE_OPERATIONS } from "../demo/catalogue/operations.js";
import { dbOperationRepo } from "../repositories/db-operation.repo.js";
import { dbOperationBodySchema, dbOperationService } from "../services/db-operation.service.js";

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

/** ⚠ Author and approver differ so gate 2's self-approval refusal does not fire. */
const AUTHOR = systemAuthor("scenario-seed@acme-demo.example");
const APPROVER = "demo-lead@acme-demo.example";

const READER_FOR_FLOW: Record<string, { ds: string; query: string }> = {
  "support-sla-check": { ds: "support_demo", query: "tickets_breaching_resolve" },
  "hiring-offer-chase": { ds: "hiring_demo", query: "offers_expiring" },
  "orders-late-check": { ds: "orders_demo", query: "orders_past_promise" },
};

async function ensureGenericReader(workspaceId: string, flowId: string): Promise<void> {
  const want = READER_FOR_FLOW[flowId];
  if (!want) return;
  const q = GENERIC_GENERATED_QUERIES.find((g) => g.name === want.query);
  if (!q) throw new Error(`no generated query ${want.query} for flow ${flowId}`);
  const problems = checkSqlShape(q.sqlText, q.paramOrder, q.paramsSchema);
  if (problems.length > 0) {
    throw new Error(`${q.name}: ${problems.map((p) => `${p.code} ${p.message}`).join("; ")}`);
  }
  const ds = (await datasourceRepo.listByWorkspace(workspaceId)).find((d) => d.name === want.ds);
  if (!ds) throw new Error(`datasource "${want.ds}" not found — run generic:seed`);
  await datasourceQueryRepo.upsertByName({
    datasourceId: ds.id,
    name: q.name,
    description: q.description,
    sqlText: q.sqlText,
    paramOrder: q.paramOrder,
    paramsSchema: q.paramsSchema,
  });
}

/**
 * The domain tools the flows call, upserted from the domain catalogue — the
 * same upsert `uat-lifecycle-setup.ts` performs. A fresh provision only
 * carries the lean tools, so without this the flows name tools the workspace
 * does not hold.
 */
async function ensureGenericTools(workspaceId: string, workspaceName: string): Promise<void> {
  const spec = GENERIC_DOMAINS.find((d) => d.workspaceName === workspaceName);
  if (!spec) return;
  const byName = new Map((await toolRepo.listByWorkspace(workspaceId)).map((t) => [t.name, t]));
  for (const t of genericToolCatalogue(spec)) {
    if (byName.has(t.name)) continue;
    await toolService.create(workspaceId, createToolSchema.parse(t));
  }
}
async function ensureGenericOperation(workspaceId: string): Promise<void> {
  const seed = CATALOGUE_OPERATIONS["orders_demo"].find((s) => s.name === "orders_past_promised_date");
  if (!seed) throw new Error("orders_past_promised_date missing from CATALOGUE_OPERATIONS");
  const ds = (await datasourceRepo.listByWorkspace(workspaceId)).find((d) => d.name === "orders_demo");
  if (!ds) throw new Error(`datasource "orders_demo" not found — run generic:seed`);
  const have = new Set((await dbOperationRepo.listByDatasource(ds.id)).map((o) => o.name));
  if (have.has(seed.name)) return;
  await dbOperationService.create(
    workspaceId,
    ds.id,
    dbOperationBodySchema.parse({
      name: seed.name,
      description: seed.description,
      spec: seed.spec,
      paramDescriptions: seed.params,
      ...(seed.defaults ? { paramDefaults: seed.defaults } : {}),
      ...(seed.formats ? { paramFormats: seed.formats } : {}),
    }),
  );
}

async function main() {
  const asOfArg = process.argv.find((a) => a.startsWith("--as-of="))?.split("=")[1];
  const as_of = asOfArg ?? "2026-06-15T10:00:00Z";
  console.log(`\n${"═".repeat(76)}\ngeneric:flows  ${c.dim(`as of ${as_of}`)}\n${"═".repeat(76)}\n`);

  const workspaces = await workspaceRepo.list();
  const summary: Array<{ id: string; state: string; note: string }> = [];
  let failures = 0;

  for (const spec of GENERIC_FLOWS) {
    const ws = workspaces.find((w) => w.name === spec.workspaceName);
    if (!ws) {
      failures++;
      console.log(`  ${c.bad("✗")} ${spec.model.id} ${c.dim(`no "${spec.workspaceName}" workspace — run generic:seed`)}`);
      summary.push({ id: spec.model.id, state: "no workspace", note: spec.workspaceName });
      continue;
    }

    await ensureGenericReader(ws.id, spec.model.id);
    await ensureGenericTools(ws.id, spec.workspaceName);
    if (spec.model.id === "orders-operation-check") {
      await ensureGenericOperation(ws.id);
    }

    // The manifest is what a flow's refs are fingerprinted against, so it is
    // rebuilt BEFORE the flow is written — otherwise the revision captures
    // "<missing>" for a query that exists and the flow is stale on approval.
    await manifestBuilderService.buildAndPersist(ws.id);

    const existing = await flowRepo.getByKestraFlowId(ws.id, spec.model.id);
    let flowId: string;
    let revision: number;
    if (existing) {
      const out = await flowService.writeRevision(ws.id, existing, spec.model, AUTHOR);
      flowId = existing.id;
      revision = out.revision.revision;
      console.log(`  ${c.ok("✓")} ${spec.model.id} ${c.dim(`→ revision ${revision}`)}`);
    } else {
      const out = await flowService.create(ws.id, {
        name: spec.name,
        description: spec.description,
        model: spec.model,
        author: AUTHOR,
      });
      flowId = out.flow.id;
      revision = out.revision.revision;
      console.log(`  ${c.ok("✓")} ${spec.model.id} ${c.dim(`→ created, revision ${revision}`)}`);
    }

    try {
      const ex = await runDraft(ws.id, flowId, { as_of });
      if (ex.state.current === "PAUSED") {
        // A pause holds an M3 budget slot and retention purges terminal states
        // only, so a stuck run is killed rather than left.
        await kestra.killExecution(ex.id).catch(() => {});
        failures++;
        console.log(`      run ${c.bad("PAUSED")} ${c.dim(stepReport(ex))}`);
        summary.push({ id: spec.model.id, state: "stuck", note: "paused with no approval step" });
        continue;
      }
      // ⚠ WARNING is a PASS — a retried step that recovered settles WARNING.
      const ran = ex.state.current === "SUCCESS" || ex.state.current === "WARNING";
      console.log(`      run ${ran ? c.ok(ex.state.current) : c.bad(ex.state.current)} ${c.dim(stepReport(ex))}`);
      if (!ran) {
        failures++;
        summary.push({ id: spec.model.id, state: "run failed", note: "gate 1 unsatisfied" });
        continue;
      }
    } catch (e) {
      failures++;
      console.log(`      run ${c.bad("did not settle")} ${c.dim((e as Error).message)}`);
      summary.push({ id: spec.model.id, state: "stuck", note: (e as Error).message });
      continue;
    }

    try {
      await flowApprovalService.approve(ws.id, flowId, {
        revision,
        approverUserId: APPROVER,
        approverKind: "client_admin",
        note: "seeded demo flow",
      });
      console.log(`      ${c.ok("armed")}`);
      summary.push({ id: spec.model.id, state: "armed", note: spec.workspaceName });
    } catch (e) {
      // Not a failure: re-seeding an already-armed flow legitimately refuses.
      console.log(`      ${c.warn("not armed")} ${c.dim((e as Error).message)}`);
      summary.push({ id: spec.model.id, state: "ran, not armed", note: (e as Error).message });
    }
  }

  console.log(`\n${"═".repeat(76)}`);
  for (const s of summary) {
    const tone = s.state === "armed" ? c.ok : s.state.startsWith("ran") ? c.warn : c.bad;
    console.log(`  ${tone(s.state.padEnd(14))} ${s.id.padEnd(22)} ${c.dim(s.note.slice(0, 70))}`);
  }
  console.log(
    `\n  ${failures === 0 ? c.ok("every flow ran") : c.bad(`${failures} flow(s) did not run`)}` +
      c.dim("  ·  ⚠ a green run does NOT prove the right arm fired — re-run with --as-of on an empty instant\n"),
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(c.bad(`\ngeneric:flows failed: ${(e as Error).message}\n`));
  process.exit(1);
});
