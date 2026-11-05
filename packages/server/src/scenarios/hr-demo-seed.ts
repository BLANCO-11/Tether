/**
 * `pnpm --filter @foundry/server hr:demo-flows` — two IT operations
 * automations, authored, run once and armed.
 *
 * ── Same sequence as `scenarios:seed`, and for the same reason ──────────────
 *
 * Author → test-run once → arm. Gate 1 REFUSES to approve a flow that has never
 * completed a run, so this script cannot hand itself an armed flow; it has to run
 * the draft first, exactly as a person would. The side benefit is the one that
 * matters more: every Pebble expression is actually EVALUATED. A `paramsExpr`
 * that renders prose into a JSON body (I-11) typechecks perfectly and fails only
 * here — and this domain's flows carry the longest jq programs in the repository.
 *
 * ── ⚠ IT SEEDS, IT DOES NOT SCORE ──────────────────────────────────────────
 *
 * A green run proves the YAML is valid and the expressions render. It does NOT
 * prove the right ARM fired, which is the only interesting question about a
 * branching flow — and the one thing that can be wrong while everything is
 * green. `nothing yet — run it and look` is what answers it, against `itopsOracle()`.
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
import { kestra } from "../services/kestra-client.service.js";
import { runDraft, stepReport } from "./kestra-draft-run.js";
import { HR_DEMO_SCENARIOS } from "./hr-demo-flows.js";
const HR_WS = "HR";

import { systemAuthor } from "../services/revision-author.js";

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

/**
 * ⚠ A SEED author, and the approver is a different string on purpose so gate 2's
 * self-approval refusal does not fire on a seeded arm.
 *
 * Both are self-asserted. One shared `PARENT_API_KEY`, no role model (I-13) — so
 * this is a guard against the honest mistake and nothing more. **Never describe
 * it as separation of duties.** The control that actually holds is that the
 * approval binds to a revision.
 */
const AUTHOR = systemAuthor("scenario-seed@acme-hr.example");
const APPROVER = "hr-lead@acme-hr.example";

async function main() {
  const period = process.argv.find((a) => a.startsWith("--period="))?.split("=")[1] ?? "2026-06";
  console.log(`\n${"═".repeat(76)}\nhr:demo-flows  ${c.dim(`period ${period}`)}\n${"═".repeat(76)}`);

  const ws = (await workspaceRepo.list()).find((w) => w.name === HR_WS);
  if (!ws) {
    console.error(
      c.bad(`\nno "${HR_WS}" workspace — run \`pnpm --filter @foundry/server demo:seed\` first.\n`),
    );
    process.exit(1);
  }
  console.log(`\nworkspace ${c.ok(ws.name)} ${c.dim(ws.id)}`);

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
  const summary: Array<{ id: string; state: string; note: string }> = [];
  let failures = 0;

  for (const spec of HR_DEMO_SCENARIOS) {
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

    let state = "draft";
    let note = "";
    try {
      const ex = await runDraft(ws.id, flowId, { period });
      if (ex.state.current === "PAUSED") {
        console.log(`      run ${c.bad("PAUSED")} ${c.dim(stepReport(ex))}`);
        try {
          await kestra.killExecution(ex.id);
        } catch {
          /* best effort */
        }
        failures++;
        summary.push({
          id: spec.model.id,
          state: "stuck",
          note: "PAUSED with no approval step — something is waiting that should not be",
        });
        continue;
      }
      // ⚠ WARNING is a PASS. A `retry:` step that failed once and recovered
      // settles the execution WARNING; treating that as a failure would make the
      // retry on `page` unusable in a seeded flow.
      const ran = ex.state.current === "SUCCESS" || ex.state.current === "WARNING";
      console.log(`      run ${ran ? c.ok(ex.state.current) : c.bad(ex.state.current)} ${c.dim(stepReport(ex))}`);
      if (!ran) {
        failures++;
        summary.push({ id: spec.model.id, state: "run failed", note: "gate 1 unsatisfied — cannot be approved" });
        continue;
      }
      state = "ran";
    } catch (e) {
      failures++;
      console.log(`      run ${c.bad("did not settle")} ${c.dim((e as Error).message)}`);
      summary.push({ id: spec.model.id, state: "stuck", note: (e as Error).message });
      continue;
    }

    const un = (spec as { unapprovedBecause?: string }).unapprovedBecause;
    if (un) {
      summary.push({ id: spec.model.id, state: "ran, not armed", note: un });
      console.log(`      ${c.warn("not armed")} ${c.dim(un)}`);
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
      // refuses here, and so does an approval blocked by a stale ref.
      state = "ran, not armed";
      note = (e as Error).message;
      console.log(`      ${c.warn("not armed")} ${c.dim(note)}`);
    }
    summary.push({ id: spec.model.id, state, note });
  }

  console.log(`\n${"═".repeat(76)}`);
  for (const s of summary) {
    const tone = s.state === "armed" ? c.ok : s.state.startsWith("ran") ? c.warn : c.bad;
    console.log(`  ${tone(s.state.padEnd(14))} ${s.id.padEnd(26)} ${c.dim(s.note)}`);
  }
  console.log(
    `\n  ${failures === 0 ? c.ok("every scenario ran") : c.bad(`${failures} scenario(s) did not run`)}` +
      c.dim("  ·  ⚠ a green run does NOT mean the right arm fired — next: hr:demo-flows-verify\n"),
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(c.bad(`\nhr:demo-flows failed: ${(e as Error).message}\n`));
  process.exit(1);
});
