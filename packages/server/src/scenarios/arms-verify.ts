/**
 * `pnpm --filter @foundry/server arms:verify` — did the right ARM fire, in
 * EVERY branching flow in every workspace?
 *
 * ⚠ **Kestra-touching: on macOS run it through `./scripts/harness-in-net.sh`.**
 * Kestra publishes no ports and cannot (I-03/I-05), so a host process cannot
 * reach it.
 *
 * ── Why this exists when `itops:scenarios-verify` already does it ───────────
 *
 * That harness is the only thing in the product that can catch a wrong branch,
 * and it is hand-written for **two flows**, against a hand-written domain
 * oracle, at three named instants. Every other branching flow — including every
 * one somebody builds in chat — has no such check at all. A domain oracle
 * cannot generalise: there is no `financeOracle()` for a flow authored this
 * morning.
 *
 * `flow-arm-oracle.ts` is the general form: a branch's condition is a decidable
 * predicate over rows the run itself recorded, so **the model plus the execution
 * is the oracle**, with no per-domain knowledge. This harness applies it to
 * history that already exists.
 *
 * ── ⚠ IT READS EXISTING EXECUTIONS AND FIRES NOTHING ────────────────────────
 *
 * Deliberate. Firing runs would put rows in tenant capture tables, consume M3
 * budget slots and — for an armed flow — send real mail. `itops-verify` may run
 * drafts because it owns its fixtures; this one runs across every workspace on
 * the deployment and owns none of them. The cost is stated below: coverage is
 * whatever history happens to hold.
 *
 * ── ⚠ IT IS A MEASUREMENT, NOT A GATE ───────────────────────────────────────
 *
 * Exit 1 on a genuine wrong-arm finding; exit **2** on an unreadable deployment.
 * Two codes, because "the arms are wrong" and "I could not find out" need
 * different responses — D-66's ranking, and `pnpm signals` already uses exactly
 * this split.
 * `unevaluable` is REPORTED and does not fail the run — most branches will be
 * unevaluable, because the redacted step view does not carry every upstream
 * step's rows. ⚠ But it is never silently dropped either: a harness that hid
 * them would print a clean sheet over runs it checked nothing about, and its
 * coverage could fall to zero without a line changing. The summary prints the
 * decided/undecided split for exactly that reason.
 */

import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowVisibilityService } from "../services/flow-visibility.service.js";
// ⚠ The raw row, because `executionBase()` deliberately does not project
// `flow_revision` — it is engine-adjacent addressing a client has no use for.
// A harness importing a repo directly is this repo's own idiom for exactly
// this: right for engine properties, wrong for `e2e:ui`, which may only use the
// HTTP surface the client uses.
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { armOf, type FlowModel } from "../services/flow-compiler.service.js";
import {
  expectedArms,
  compareArms,
  rowsFrom,
  branchesOf,
} from "../services/flow-arm-oracle.js";

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

async function main() {
  const limit = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 50);
  const workspaces = (await workspaceRepo.list()).filter((w) => !w.deletedAt);
  if (workspaces.length === 0) {
    console.error(c.bad("no workspaces on this deployment — nothing to verify"));
    process.exit(2);
  }

  let branchingFlows = 0;
  let executionsRead = 0;
  let decided = 0;
  let undecided = 0;
  const wrong: string[] = [];
  const undecidedLines: string[] = [];

  for (const w of workspaces) {
    let executions;
    try {
      executions = await flowExecutionRepo.listByWorkspace(w.id, limit);
    } catch (e) {
      // ⚠ Exit 2, not 1, and not a silent skip. "the deployment is unreadable"
      // and "the arms are wrong" need different responses (D-66's ranking), and
      // a verifier that quietly drops its only meaningful half is the false
      // green this repo keeps finding.
      console.error(c.bad(`could not read executions for ${w.name}: ${(e as Error).message}`));
      process.exit(2);
    }

    for (const e of executions) {
      if (!e.flowId || e.flowRevision == null) continue;
      const rev = await flowRepo.getRevision(e.flowId, e.flowRevision);
      if (!rev) continue;
      const model = rev.modelJson as FlowModel;
      const branches = branchesOf(model);
      if (branches.length === 0) continue;
      branchingFlows++;

      const view = await flowVisibilityService.get(w.id, e.id);
      if (!view) continue;
      executionsRead++;

      const ran = new Set(view.steps.map((s) => s.stepId));
      const rows = rowsFrom(view.steps as ReadonlyArray<{ stepId: string; output: unknown }>);
      const members = new Map(
        branches.map((b) => [b.id, armOf(model, b.id).map((s) => s.id)] as const),
      );

      const verdicts = expectedArms(branches, rows);
      const findings = compareArms(verdicts, members, ran);
      for (const f of findings) {
        const where = `${w.name} · ${e.kestraFlowId} · run ${e.id.slice(0, 8)}`;
        if (f.code === "unevaluable") {
          undecided++;
          undecidedLines.push(`${c.dim(where)} ${f.message}`);
        } else {
          wrong.push(`${c.bad("✗")} ${where}: ${f.message}`);
        }
      }
      decided += verdicts.filter((v) => v.verdict !== "unevaluable").length;
    }
  }

  console.log("");
  console.log(`workspaces          ${workspaces.length}`);
  console.log(`branching runs      ${branchingFlows}`);
  console.log(`executions read     ${executionsRead}`);
  console.log(`arms decided        ${decided}`);
  console.log(`arms undecided      ${undecided}`);
  console.log("");

  if (undecidedLines.length) {
    console.log(c.warn(`${undecidedLines.length} arm(s) could not be decided — reported, not passed:`));
    for (const l of undecidedLines.slice(0, 20)) console.log(`  ${l}`);
    if (undecidedLines.length > 20) console.log(c.dim(`  … and ${undecidedLines.length - 20} more`));
    console.log("");
  }

  if (wrong.length) {
    console.log(c.bad(`${wrong.length} WRONG ARM finding(s) — every one of these runs is GREEN:`));
    for (const l of wrong) console.log(`  ${l}`);
    process.exit(1);
  }

  if (branchingFlows === 0) {
    // ⚠ NOT a pass. Nothing was checked, and printing a tick over an empty set
    // is the exact shape of I-38 — a control that cannot fail. It exits 0
    // because there is no defect to report, and says plainly that it found
    // nothing to look at.
    console.log(c.warn("no branching executions in history — NOTHING WAS CHECKED."));
    console.log(c.dim("  Run a branching flow (see `catalogue:flows`), then re-run this."));
    return;
  }

  console.log(
    c.ok(`✓ every decided arm matched the oracle`) +
      c.dim(` (${decided} decided, ${undecided} undecided — the undecided are NOT a pass)`),
  );
}

main().catch((e) => {
  console.error(c.bad(String(e)));
  process.exit(2);
});
