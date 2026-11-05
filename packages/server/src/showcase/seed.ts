/**
 * `pnpm showcase:seed` — the named queries and flows that make each capability
 * clickable.
 *
 * ── Why this is not `demo:seed` ──────────────────────────────────────────────
 *
 * `demo:seed` provisions the **dataset**: the `hr_demo` database, its 62
 * employees and their traps, the 14 tools and the read-only role. That is the
 * regression net's subject and its files are not to be edited. This script
 * provisions **automations over** that dataset, and is re-runnable.
 *
 * ── Idempotent, and honest about which parts are not ─────────────────────────
 *
 * Named queries upsert by name. Flows do NOT: a flow that already exists gets a
 * new REVISION rather than being replaced, because revisions are insert-only and
 * an approval binds to one. Re-running therefore leaves any existing approval
 * bound to the revision it was given, which is the whole point of Phase 3 — so a
 * re-seed of an armed flow reports that the flow is now `draft_pending` and needs
 * approving again rather than quietly re-arming it.
 *
 * ── The collision this script asserts against ───────────────────────────────
 *
 * `POST /api/executions/begin` resolves a Foundry `flows` row by its Kestra slug.
 * A showcase flow reusing a harness slug therefore hijacks that harness's run and
 * refuses it with *"flow has no approved revision"* — `kestra:prove` scenario A
 * fails and nothing points at the cause. Every id is checked here, not just in
 * review.
 */

import { config } from "../config/index.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { datasourceQueryRepo } from "../repositories/datasource-query.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { triggerRepo } from "../repositories/trigger.repo.js";
import { flowService } from "../services/flow.service.js";
import { flowApprovalService } from "../services/flow-approval.service.js";
import { manifestBuilderService } from "../services/manifest-builder.service.js";
import { checkSqlShape } from "../services/datasource-query.service.js";
import { kestra, type KestraExecution } from "../services/kestra-client.service.js";
import type { NamedQuerySpec } from "../services/datasource-query.service.js";
import { HR_GENERATED_QUERIES } from "../demo/hr-generated.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { toolService } from "../services/tool.service.js";
import { SHOWCASE_FLOWS, HARNESS_FLOW_IDS, SHOWCASE_PREFIX, FLAKY_TOOL } from "./flows.js";
import { OPS_AUTH_STYLE, OPS_SECRET_ENV } from "../services/ops-client.service.js";
import { systemAuthor } from "../services/revision-author.js";

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

/**
 * The seed's own author identity.
 *
 * It matters because `approve` REFUSES to approve a revision whose recorded
 * author is the same string — so seeding an approved flow needs two distinct
 * names. ⚠ That refusal is not separation of duties: there is one shared
 * `PARENT_API_KEY` and no user model, so both of these are self-asserted (I-13).
 * It is a guard against the honest mistake, and the control that actually holds
 * is that the approval binds to a revision.
 */
/**
 * ⚠ A SEED author. Since archive/GAPS.md §1.2 every revision this file writes carries
 * `created_by_kind: "system"` — nothing here holds a session, and the name is a
 * label rather than a claim that anybody was checked. The approver below is a
 * different string on purpose, so gate 2's self-approval refusal does not fire
 * on a seeded arm.
 */
const SEED_AUTHOR = systemAuthor("showcase-seed@acme-hr.example");
const SEED_APPROVER = "hr-director@acme-hr.example";

const SETTLED = ["SUCCESS", "FAILED", "KILLED", "WARNING"];
const settled = (e: KestraExecution) => SETTLED.includes(e.state.current);

/**
 * Run a flow's draft revision and wait for it to settle.
 *
 * This exists because **gate 1 refuses to approve a flow that has never
 * completed a run** — so a seed script cannot simply hand itself an armed flow.
 * That refusal is the product's sequence (author → run once → arm) and working
 * around it here would have seeded a showcase whose armed state was reachable by
 * no user.
 *
 * The side benefit is the one that matters more: every expression in the flow is
 * actually EVALUATED. A `paramsExpr` that renders prose into a JSON body (I-11)
 * or reads `outputs.<agent>.vars` instead of `outputs.<agent>_await.onResume`
 * typechecks perfectly and fails only here.
 */
async function runDraft(
  workspaceId: string,
  flowId: string,
  inputs: Record<string, string>,
  timeoutMs = 180_000,
): Promise<KestraExecution> {
  const started = await flowService.testRun(workspaceId, flowId, inputs);
  const deadline = Date.now() + timeoutMs;
  let last: KestraExecution | undefined;
  while (Date.now() < deadline) {
    last = await kestra.getExecution(started.kestraExecutionId);
    if (settled(last)) return last;
    // A `code` step pulls an image and starts a sibling container, so the first
    // run of the day is legitimately slow. Polling is right here rather than the
    // progress socket: this is a script, and D-15's ticket exists for browsers.
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    `execution ${started.kestraExecutionId} did not settle within ${timeoutMs / 1000}s ` +
      `(last state ${last?.state.current ?? "unknown"})`,
  );
}

/** Per-step outcome, so a failure names the step rather than the flow. */
function stepReport(ex: KestraExecution): string {
  return (ex.taskRunList ?? [])
    .map((t) => `${t.taskId}=${t.state.current}`)
    .join(" · ");
}

async function main() {
  const period = process.argv.find((a) => a.startsWith("--period="))?.split("=")[1] ?? "2026-06";
  console.log(`\n${"═".repeat(72)}\nshowcase:seed  ${c.dim(`period hint ${period}`)}\n${"═".repeat(72)}`);

  // ── the workspace ─────────────────────────────────────────────────────────
  //
  // The HR workspace, deliberately, rather than a new one. It already holds the
  // datasource, the 14 tools, the manifest and the oracle — a second workspace
  // pointing at the same database would add a second manifest to keep in step
  // and demonstrate nothing that `HR (alt)` does not already demonstrate.
  const ws = (await workspaceRepo.list()).find((w) => w.name === "HR");
  if (!ws) {
    console.error(c.bad('workspace "HR" not found — run `pnpm demo:seed` first'));
    process.exit(1);
  }
  const ds = (await datasourceRepo.listByWorkspace(ws.id)).find((d) => d.name === "hr_demo");
  if (!ds) {
    console.error(c.bad('datasource "hr_demo" not found — run `pnpm demo:seed` first'));
    process.exit(1);
  }
  console.log(`workspace ${ws.name} ${c.dim(ws.id)}\ndatasource ${ds.name} ${c.dim(ds.id)}`);

  // ── the reserved-slug check, before anything is written ───────────────────
  const collisions = SHOWCASE_FLOWS.filter((f) =>
    (HARNESS_FLOW_IDS as readonly string[]).includes(f.model.id),
  );
  if (collisions.length > 0) {
    console.error(
      c.bad(
        `these showcase flows reuse a harness slug: ${collisions.map((f) => f.model.id).join(", ")}. ` +
          "begin() would resolve the Foundry row and refuse the harness's own run.",
      ),
    );
    process.exit(1);
  }
  const unprefixed = SHOWCASE_FLOWS.filter((f) => !f.model.id.startsWith(SHOWCASE_PREFIX));
  if (unprefixed.length > 0) {
    console.error(
      c.bad(`showcase flow ids must start with "${SHOWCASE_PREFIX}": ${unprefixed.map((f) => f.model.id).join(", ")}`),
    );
    process.exit(1);
  }
  console.log(c.ok(`✓ ${SHOWCASE_FLOWS.length} flow id(s) outside the reserved harness set`));

  // ── the retry fixture's tool ──────────────────────────────────────────────
  //
  // Registered here rather than in `demo/tool-catalogue.ts` on purpose: that
  // catalogue is what `demo:verify` and `demo:rehearse` are written against, and
  // a 15th tool whose whole job is to fail would be a standing asterisk on every
  // count they report. See `FLAKY_TOOL`.
  console.log(`\n${"─".repeat(72)}\ntools\n`);
  // ⚠ UPSERT, not create-if-absent. "Already registered" is not the same as
  // "registered correctly": the Stage 4 row pointed at `:4000/stub-api/flaky`
  // with no auth, so after the tool layer moved to :4004 this branch happily
  // reported the tool present while every call went to a deleted route on the
  // wrong service. `provision.ts` documents the same trap for the ticket tools.
  const existingTools = await toolRepo.listByWorkspace(ws.id);
  const existingProbe = existingTools.find((t) => t.name === FLAKY_TOOL.name);
  if (existingProbe) {
    await toolService.update(ws.id, existingProbe.id, {
      method: FLAKY_TOOL.method,
      url: `${config.opsApiBase}${FLAKY_TOOL.urlPath}`,
      description: FLAKY_TOOL.description,
      paramsSchema: FLAKY_TOOL.paramsSchema,
      secretEnvName: OPS_SECRET_ENV.probe,
      authStyle: OPS_AUTH_STYLE.probe.style,
      authParamName: null,
    });
    console.log(`  ${c.ok("✓")} ${FLAKY_TOOL.name} ${c.dim("→ re-registered against ops-api")}`);
  } else {
    await toolService.create(ws.id, {
      name: FLAKY_TOOL.name,
      method: FLAKY_TOOL.method,
      url: `${config.opsApiBase}${FLAKY_TOOL.urlPath}`,
      description: FLAKY_TOOL.description,
      paramsSchema: FLAKY_TOOL.paramsSchema,
      // The probe service authenticates like every other ops-api service, and
      // with the one style nothing else uses — `basic`. Registering it without
      // auth would 401 at the first attempt, and the retry would then "recover"
      // from a credential error rather than a transient one, which is a
      // different property and not the one being demonstrated.
      secretEnvName: OPS_SECRET_ENV.probe,
      authStyle: OPS_AUTH_STYLE.probe.style,
      isActive: true,
    });
    console.log(`  ${c.ok("✓")} ${FLAKY_TOOL.name} ${c.dim("→ registered (retry fixture)")}`);
  }

  // ── named queries ─────────────────────────────────────────────────────────
  //
  // Both sets: the harness fixture (which the reference flow calls) and the
  // showcase additions. Seeding the fixture here too means the showcase does not
  // depend on a `kestra:phaseN` run having happened first.
  console.log(`\n${"─".repeat(72)}\nnamed queries\n`);
  const specs: NamedQuerySpec[] = [...HR_GENERATED_QUERIES];

  // Checked with the SAME function the HTTP route uses. Seed data that could not
  // be authored through the product would be demonstrating something the product
  // cannot do — and the rules are strict enough that this has caught real
  // mistakes in queries written by hand right here.
  let rejected = 0;
  for (const q of specs) {
    const problems = checkSqlShape(q.sqlText, q.paramOrder, q.paramsSchema);
    if (problems.length > 0) {
      rejected++;
      console.error(c.bad(`  ✗ ${q.name}`));
      for (const p of problems) console.error(`      ${p.code}: ${p.message}`);
    }
  }
  if (rejected > 0) {
    console.error(
      c.bad(`\n${rejected} seeded quer(ies) would be refused by POST …/queries — fix them, not the rule.`),
    );
    process.exit(1);
  }
  for (const q of specs) {
    await datasourceQueryRepo.upsertByName({
      datasourceId: ds.id,
      name: q.name,
      description: q.description,
      sqlText: q.sqlText,
      paramOrder: q.paramOrder,
      paramsSchema: q.paramsSchema,
    });
    console.log(`  ${c.ok("✓")} ${ds.name}.${q.name} ${c.dim(`(${q.paramOrder.length} param)`)}`);
  }

  // The manifest is what a flow's refs are fingerprinted against, so it has to
  // be rebuilt BEFORE any flow is written — otherwise the revision captures
  // `"<missing>"` for a query that exists, and the flow is stale the moment it
  // is approved.
  const manifest = await manifestBuilderService.buildAndPersist(ws.id);
  console.log(
    `\nmanifest v${manifest.version} ${c.dim(manifest.hash.slice(0, 12))}` +
      (manifest.changed ? c.dim(" (new version — the new queries changed it)") : c.dim(" (unchanged)")),
  );

  // ── flows ─────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(72)}\nflows\n`);
  const summary: Array<{ name: string; id: string; state: string; note: string }> = [];

  for (const spec of SHOWCASE_FLOWS) {
    const existing = await flowRepo.getByKestraFlowId(ws.id, spec.model.id);
    let flowId: string;
    let revision: number;

    if (existing) {
      // A new revision, never an overwrite. Revisions are insert-only, and an
      // approval binds to one — so this deliberately does NOT re-arm the flow.
      const out = await flowService.writeRevision(ws.id, existing, spec.model, SEED_AUTHOR);
      flowId = existing.id;
      revision = out.revision.revision;
      console.log(`  ${c.ok("✓")} ${spec.model.id} ${c.dim(`→ revision ${revision} (existing flow)`)}`);
    } else {
      const out = await flowService.create(ws.id, {
        name: spec.name,
        description: spec.description,
        model: spec.model,
        author: SEED_AUTHOR,
      });
      flowId = out.flow.id;
      revision = out.revision.revision;
      console.log(`  ${c.ok("✓")} ${spec.model.id} ${c.dim(`→ created, revision ${revision}`)}`);
    }

    let state = "draft";
    let note = "";

    // ── gate 1: run it once, against the DRAFT namespace ────────────────────
    //
    // The draft namespace is exempt from gate 2, which is not an oversight — a
    // draft run is how gate 1 gets satisfied in the first place, so requiring
    // approval to perform it would be a cycle.
    // Only the inputs the model actually declares. `showcase-retry-recovery`
    // takes none, and Kestra rejects an execution carrying an input the flow has
    // never heard of — so a blanket `{ period }` would fail one flow for a reason
    // that has nothing to do with what it demonstrates.
    const declared = Object.fromEntries(
      (spec.model.inputs ?? []).filter((i) => i.id === "period").map((i) => [i.id, period]),
    );

    if (spec.testRun) {
      try {
        const ex = await runDraft(ws.id, flowId, declared);
        // WARNING is a PASS here, and saying so is the point rather than a
        // convenience. A flow with a `retry:` step that recovered settles WARNING
        // by design (`warningOnRetry`), so treating anything but SUCCESS as a
        // failure would report the retry showcase as broken every single time it
        // worked — and the fix somebody would reach for is turning off the one
        // signal that distinguishes "worked" from "worked on the third go".
        const ok = ex.state.current === "SUCCESS" || ex.state.current === "WARNING";
        const label = ok ? c.ok(ex.state.current) : c.warn(ex.state.current);
        console.log(
          `      draft run ${label} ${c.dim(stepReport(ex))}` +
            (ex.state.current === "WARNING" ? c.dim(" — a step was re-attempted and recovered") : ""),
        );
        if (!ok) {
          // Reported, not swallowed. A seeded flow that fails its own draft run
          // is a broken showcase, and the per-step line above names which step —
          // which is the whole reason the run happens here rather than being
          // left to whoever clicks first.
          note = `draft run ${ex.state.current}`;
        }
      } catch (e) {
        note = `draft run did not settle: ${(e as Error).message}`;
        console.log(`      ${c.bad("draft run failed")} ${c.dim(note)}`);
      }
    }

    if (spec.arm) {
      try {
        await flowApprovalService.approve(ws.id, flowId, {
          revision,
          approverUserId: SEED_APPROVER,
          approverKind: "client_admin",
          note: "seeded by showcase:seed so the armed state is visible without a manual approval",
        });
        const after = await flowRepo.get(ws.id, flowId);
        state = after?.status ?? "?";
        note = spec.model.schedule ? `cron ${spec.model.schedule.cron} deployed live` : "live";
        console.log(`      ${c.ok("armed")} — ${note}`);
      } catch (e) {
        // Not fatal. Approval deploys to Kestra, so it needs the engine up; the
        // flow is still seeded and approvable by hand from the UI, which is the
        // more interesting path to demonstrate anyway.
        state = "draft";
        note = `approval failed: ${(e as Error).message}`;
        console.log(`      ${c.warn("not armed")} — ${note}`);
      }
    } else {
      // Per flow, not a shared sentence. Three flows are unapproved for three
      // different reasons, and printing "this is the flow that shows gate 2
      // refusing" against all of them is a small lie of exactly the kind this
      // work exists to remove — it tells a reader the retry demo is a gate demo.
      note = spec.unapprovedBecause;
      console.log(`      ${c.dim(note)}`);
    }

    summary.push({ name: spec.name, id: spec.model.id, state, note });

    // ── gate 1, made clickable ──────────────────────────────────────────────
    //
    // A `manual` trigger, created DISABLED. `createTriggerSchema.enabled`
    // defaults to false and that default is load-bearing: it used to be true, so
    // a client omitting the field armed the trigger — a standing grant to run
    // unattended, granted by silence. Seeding it disabled means the readiness
    // gate is something you can watch refuse.
    //
    // Not a `schedule` trigger: Foundry refuses those for a flow, because a cron
    // lives on the MODEL and is armed by approving a revision (D-18). A second
    // timer no approval covers is exactly what that refusal prevents.
    const triggers = await triggerRepo.listByFlow(flowId);
    if (triggers.length === 0) {
      await triggerRepo.create({
        workspaceId: ws.id,
        flowId,
        name: `Run ${spec.name.toLowerCase()} now`,
        type: "manual",
        config: { inputs: declared },
        enabled: false,
      });
      console.log(`      ${c.dim("+ manual trigger (disabled — gate 1)")}`);
    }
  }

  // ── what to click ─────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(72)}\n${c.ok("showcase seeded")}\n`);
  for (const s of summary) {
    console.log(`  ${s.state.padEnd(14)} ${s.id.padEnd(34)} ${c.dim(s.note)}`);
  }
  console.log(
    `\n${c.dim("web")} http://localhost:${config.port === 4000 ? 4002 : config.port + 2}/flows` +
      `\n${c.dim("try")} edit a named query on /data-sources and read \`willSuspendFlows\` in the response —` +
      `\n    a query's SQL is inside its ref fingerprint (D-17), so editing it unarms the flows` +
      `\n    approved against the old shape. That is the gate working, not a bug.\n`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(c.bad(`\nshowcase:seed failed: ${(e as Error).message}`));
  console.error(e);
  process.exit(1);
});
