/**
 * `pnpm scenarios:seed` — three Finance automations, authored, run once and armed.
 * Programme 3, Stage 3.
 *
 * ── What this does that `showcase:seed` does not ────────────────────────────
 *
 * `showcase:seed` provisions one flow per CAPABILITY over the HR dataset, so a
 * reviewer can click each feature. This provisions three flows that do a JOB, in
 * the Finance workspace, and `scenarios:verify` scores each against
 * `financeOracle()` rather than against a green run. They are separate scripts
 * because they answer different questions and one failing should not obscure the
 * other.
 *
 * ── It goes through the product's own sequence ──────────────────────────────
 *
 * Author → test-run once → arm. Gate 1 REFUSES to approve a flow that has never
 * completed a run, so this script cannot hand itself an armed flow; it has to run
 * the draft first, exactly as a person would. The side benefit is the one that
 * matters more: every Pebble expression is actually EVALUATED. A `paramsExpr`
 * that renders prose into a JSON body (I-11) typechecks perfectly and fails only
 * here.
 *
 * ── Idempotent, and honest about which part is not ──────────────────────────
 *
 * A flow that already exists gets a new REVISION, never a replacement — revisions
 * are insert-only and an approval binds to one. So re-running against an armed
 * flow leaves the old approval where it was and reports the flow as
 * `draft_pending`. That is Phase 3 working, not a bug.
 */

import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowService } from "../services/flow.service.js";
import { flowApprovalService } from "../services/flow-approval.service.js";
import { manifestBuilderService } from "../services/manifest-builder.service.js";
import { kestra, type KestraExecution } from "../services/kestra-client.service.js";
import { FINANCE_SCENARIOS } from "./finance-flows.js";
import { FINANCE_WORKSPACE_NAME } from "../demo/finance/provision-finance.js";
import { FINANCE_DEFAULT_PERIOD } from "../demo/finance/finance-dataset.js";
import { financeToolCatalogue } from "../demo/finance/finance-tools.js";
import { createToolSchema, toolService } from "../services/tool.service.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { systemAuthor } from "../services/revision-author.js";

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

/**
 * Two distinct identities, because `approve` refuses a revision whose recorded
 * author matches the approver.
 *
 * ⚠ Both are self-asserted. One shared `PARENT_API_KEY`, no role model (I-13) —
 * so this is a guard against the honest mistake and nothing more. Never describe
 * it as separation of duties. The control that actually holds is that the
 * approval binds to a revision.
 */
/**
 * ⚠ A SEED author. Since archive/GAPS.md §1.2 every revision this file writes carries
 * `created_by_kind: "system"` — nothing here holds a session, and the name is a
 * label rather than a claim that anybody was checked. The approver below is a
 * different string on purpose, so gate 2's self-approval refusal does not fire
 * on a seeded arm.
 */
const AUTHOR = systemAuthor("scenario-seed@acme-finance.example");
const APPROVER = "finance-director@acme-finance.example";

const SETTLED = ["SUCCESS", "FAILED", "KILLED", "WARNING"];

/** The last date of a `YYYY-MM` period — what `invoices_overdue` is asked "as of". */
function asOfFor(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

async function runDraft(
  workspaceId: string,
  flowId: string,
  inputs: Record<string, string>,
  timeoutMs = 240_000,
): Promise<KestraExecution> {
  const started = await flowService.testRun(workspaceId, flowId, inputs);
  const deadline = Date.now() + timeoutMs;
  let last: KestraExecution | undefined;
  while (Date.now() < deadline) {
    last = await kestra.getExecution(started.kestraExecutionId);
    // ⚠ PAUSED is returned, not waited through, and it is NOT a synonym for
    // settled. `finance-expense-policy` parks at gate 3 by design and would
    // otherwise sit here until the timeout — reported as "stuck", which is the
    // exact opposite of what happened. The CALLER decides what a pause means;
    // this function only refuses to pretend it is a success.
    if (SETTLED.includes(last.state.current) || last.state.current === "PAUSED") return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    `execution ${started.kestraExecutionId} did not settle within ${timeoutMs / 1000}s ` +
      `(last state ${last?.state.current ?? "unknown"})`,
  );
}

function stepReport(ex: KestraExecution): string {
  return (ex.taskRunList ?? []).map((t) => `${t.taskId}=${t.state.current}`).join(" · ");
}

/**
 * The tools the scenarios call, restored from the finance catalogue — the
 * call site `provision-finance.ts` anticipates ("restoring a tool is a call
 * site rather than a rewrite"). Provision installs the lean set only.
 */
async function ensureFinanceTools(workspaceId: string): Promise<void> {
  const byName = new Map((await toolRepo.listByWorkspace(workspaceId)).map((t) => [t.name, t]));
  for (const t of financeToolCatalogue()) {
    if (t.name !== "mail_send" && t.name !== "ticket_create") continue;
    if (byName.has(t.name)) continue;
    await toolService.create(workspaceId, createToolSchema.parse(t));
  }
}
async function main() {

  const period = process.argv.find((a) => a.startsWith("--period="))?.split("=")[1] ?? FINANCE_DEFAULT_PERIOD;
  const asOf = asOfFor(period);
  console.log(`\n${"═".repeat(76)}\nscenarios:seed  ${c.dim(`period ${period} · as of ${asOf}`)}\n${"═".repeat(76)}`);

  const spaces = await workspaceRepo.list();
  const ws = spaces.find((w) => w.name === FINANCE_WORKSPACE_NAME);
  if (!ws) {
    console.error(
      c.bad(`\nno "${FINANCE_WORKSPACE_NAME}" workspace — run \`pnpm finance:seed\` first.\n`),
    );
    process.exit(1);
  }
  console.log(`\nworkspace ${c.ok(ws.name)} ${c.dim(ws.id)}`);

  await ensureFinanceTools(ws.id);

  // The manifest is what a flow's refs are fingerprinted against, so it is
  // rebuilt BEFORE any flow is written — otherwise the revision captures
  // `"<missing>"` for a query that exists and the flow is stale the moment it is
  // approved.
  const manifest = await manifestBuilderService.buildAndPersist(ws.id);
  console.log(
    `manifest v${manifest.version} ${c.dim(manifest.hash.slice(0, 12))}` +
      c.dim(manifest.changed ? " (new version)" : " (unchanged)"),
  );

  console.log(`\n${"─".repeat(76)}\n`);
  const summary: Array<{ name: string; id: string; state: string; note: string }> = [];
  let failures = 0;

  for (const spec of FINANCE_SCENARIOS) {
    const existing = await flowRepo.getByKestraFlowId(ws.id, spec.model.id);
    let flowId: string;
    let revision: number;

    if (existing) {
      const out = await flowService.writeRevision(ws.id, existing, spec.model, AUTHOR);
      flowId = existing.id;
      revision = out.revision.revision;
      console.log(`  ${c.ok("✓")} ${spec.model.id} ${c.dim(`→ revision ${revision} (existing flow)`)}`);
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

    // Only the inputs this model declares. Kestra rejects an execution carrying
    // an input the flow has never heard of, so a blanket `{ period, as_of }`
    // would fail two of three flows for a reason unrelated to what they do.
    const supply: Record<string, string> = { period, as_of: asOf };
    const declared = Object.fromEntries(
      (spec.model.inputs ?? []).filter((i) => i.id in supply).map((i) => [i.id, supply[i.id]!]),
    );

    let state = "draft";
    let note = "";

    try {
      const ex = await runDraft(ws.id, flowId, declared);
      const gated = spec.model.steps.some((st) => st.kind === "approval");

      if (ex.state.current === "PAUSED") {
        // The flow stopped for a person, which for a gated flow is the run
        // working. It does NOT satisfy gate 1 — that needs a completed run — so
        // the flow stays a draft, and saying so is more useful than a green tick.
        //
        // Killed rather than left hanging: a PAUSED execution holds an M3 budget
        // slot, and retention purges terminal states only, so an abandoned pause
        // outlives every cleanup in this repo.
        const why = gated
          ? "paused at its approval gate — as designed; a gated flow cannot satisfy gate 1 unattended"
          : "PAUSED with no approval step — something is waiting that should not be";
        console.log(`      run ${gated ? c.warn("PAUSED") : c.bad("PAUSED")} ${c.dim(stepReport(ex))}`);
        try {
          await kestra.killExecution(ex.id);
        } catch {
          /* best effort — reported below either way */
        }
        if (!gated) failures++;
        summary.push({ name: spec.name, id: spec.model.id, state: gated ? "ran, not armed" : "stuck", note: why });
        console.log(`      ${gated ? c.warn("not armed") : c.bad("unexpected")} ${c.dim(why)}`);
        continue;
      }

      // ⚠ WARNING is a PASS, and saying so is the point rather than a
      // convenience. A `retry:` step that failed once and recovered settles the
      // execution WARNING; treating that as a failure would make the retry
      // feature unusable in a seeded flow.
      const ran = ex.state.current === "SUCCESS" || ex.state.current === "WARNING";
      console.log(`      run ${ran ? c.ok(ex.state.current) : c.bad(ex.state.current)} ${c.dim(stepReport(ex))}`);
      if (!ran) {
        failures++;
        state = "run failed";
        note = "gate 1 unsatisfied — cannot be approved";
        summary.push({ name: spec.name, id: spec.model.id, state, note });
        continue;
      }
      state = "ran";
    } catch (e) {
      failures++;
      console.log(`      run ${c.bad("did not settle")} ${c.dim((e as Error).message)}`);
      summary.push({ name: spec.name, id: spec.model.id, state: "stuck", note: (e as Error).message });
      continue;
    }

    if (spec.unapprovedBecause) {
      // Deliberately left at gate 1, with the reason travelling beside it. A
      // blanket "some flows are unapproved" note would make this read like an
      // incomplete seed rather than a decision.
      note = spec.unapprovedBecause;
      summary.push({ name: spec.name, id: spec.model.id, state: "ran, not armed", note });
      console.log(`      ${c.warn("not armed")} ${c.dim(note)}`);
      continue;
    }

    try {
      await flowApprovalService.approve(ws.id, flowId, {
        revision,
        approverUserId: APPROVER,
        approverKind: "client_admin",
        note: "seeded scenario",
      });
      state = "armed";
      note = spec.model.schedule ? `schedule ${spec.model.schedule.cron} deployed` : "approved";
      console.log(`      ${c.ok("armed")} ${c.dim(note)}`);
    } catch (e) {
      // Not counted as a failure: re-seeding an already-armed flow legitimately
      // refuses here, and so does an approval blocked by a stale ref. Both are
      // the gate working.
      state = "ran, not armed";
      note = (e as Error).message;
      console.log(`      ${c.warn("not armed")} ${c.dim(note)}`);
    }
    summary.push({ name: spec.name, id: spec.model.id, state, note });
  }

  console.log(`\n${"═".repeat(76)}`);
  for (const s of summary) {
    const tone = s.state === "armed" ? c.ok : s.state.startsWith("ran") ? c.warn : c.bad;
    console.log(`  ${tone(s.state.padEnd(14))} ${s.id.padEnd(26)} ${c.dim(s.note)}`);
  }
  console.log(
    `\n  ${failures === 0 ? c.ok("every scenario ran") : c.bad(`${failures} scenario(s) did not run`)}` +
      c.dim("  ·  next: pnpm --filter @foundry/server scenarios:verify\n"),
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(c.bad(`\nscenarios:seed failed: ${(e as Error).message}\n`));
  process.exit(1);
});
