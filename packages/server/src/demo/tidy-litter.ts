/**
 * `pnpm tidy:plan` / `pnpm tidy:clear` — remove the litter a HARNESS left behind,
 * and nothing a person authored.
 *
 * ── WHY THIS IS NOT `slate:clear` ────────────────────────────────────────────
 *
 * `slate:clear` is all-or-nothing, and for this job it is wrong in both
 * directions at once:
 *
 *   · It **preserves every workspace** — so the 18 throwaway tenants a browser
 *     walk and the `probe-*` scripts created are exactly what it does not touch.
 *   · It **deletes every flow**, including the three Finance scenarios this
 *     deployment deliberately holds (two of them armed) and their gate-1
 *     evidence.
 *
 * So the axis is wrong. `slate:clear` splits on *authored vs provisioned*; this
 * splits on *whose litter it is*. The predicates below are structural for
 * exactly that reason — a run with no flow, a tenant with no flow — rather than
 * a list of ids that would rot the first time a harness ran again.
 *
 * ── WHAT IT DELETES ─────────────────────────────────────────────────────────
 *
 *   RUNS      executions whose `flow_id IS NULL` — a run whose flow no longer
 *             exists. `flow_executions.flow_id` is `ON DELETE SET NULL`, so this
 *             is precisely the residue of a harness deleting its own flows:
 *             `e2e-ui-journey`, `e2e-ui-hitl`, `e2e-ui-expect`, `e2e-ui-retry`
 *             and the old `attendance_*` drafting experiments. Nothing can
 *             replay them (the flow is gone), nothing gates on them (gate 1
 *             reads a flow's own runs), and no UI can reach them.
 *
 *   TENANTS   workspaces whose slug matches a harness pattern AND which hold
 *             zero flows — soft-deleted through the product's own
 *             `workspaceService.remove`, because that is the path the product
 *             has and a second one would be a second definition of what
 *             "deleted" means.
 *
 * ── WHAT IT REFUSES, AND WHY THAT IS THE POINT ──────────────────────────────
 *
 * A **non-terminal** execution is reported and left alone. `kestra.deleteExecution`
 * says it: *"Callers should let the refusal surface rather than killing the run
 * to make the delete succeed"* — purging a `PAUSED` run destroys a live human
 * approval. This deployment has one such run right now (the deliberately-gated
 * `finance-expense-policy` draft, holding an undecided `notify_gate`), so the
 * refusal is not hypothetical and must not be papered over with a kill.
 *
 * A workspace holding **any** flow is refused however its slug reads, and the
 * four product slugs are refused by name on top of that. Two independent
 * guards, because the pattern is the fragile one: a real tenant somebody names
 * `probe-europe` must not be deletable by a naming coincidence.
 *
 * ── DRY RUN IS THE DEFAULT ──────────────────────────────────────────────────
 *
 * `tidy:plan` counts and prints; `tidy:clear` needs `--yes` on top. Same price
 * as `slate:clear`, for the same reason: there is no undo for the Kestra half.
 * The Foundry half of the tenant deletion IS reversible (it sets `deleted_at`),
 * and the report says so rather than implying a shred.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import {
  executionTokens,
  flowExecutions,
  flowExpectationResults,
  flowStepApprovals,
  flowStepRuns,
  flows,
  workspaces,
} from "../db/schema.js";
import { kestra } from "../services/kestra-client.service.js";
import { workspaceService } from "../services/workspace.service.js";

/**
 * Slugs that are never litter, whatever else is true of them. `foundry` is here
 * even though it is already soft-deleted: it was soft-deleted *deliberately* in
 * Programme 3, and a script that "tidies" a decision someone recorded is
 * indistinguishable from one that reverses it.
 */
const PROTECTED_SLUGS = new Set(["hr", "finance", "legal", "hr-alt-swap-rehearsal", "foundry"]);

/**
 * Harness-generated tenant slugs. Every one of these is created by a script with
 * a timestamp in the name, which is what makes them recognisable — and why the
 * `holds zero flows` guard carries the real weight rather than this list.
 *
 * ⚠ **`att-<timestamp>-` and `ds-target-control-` were added 2026-09-04**, having sat on
 * the deployment as visible clutter since 2026-09-01. Both are named in
 * CLAUDE.md as litter — `datasource-target.test.ts` is recorded there as leaving
 * `ds-target-control-*` behind when it dies mid-run, which it has done more than
 * once. A list that does not name the litter people actually complain about is a
 * list that gets bypassed by hand, and a hand-deleted workspace does not go
 * through `workspaceService.remove`.
 *
 * ⚠ **The `att-` entry requires the TIMESTAMP**, not the bare prefix. The two on
 * this deployment are named `att-ws-…` and slugged `att-1788269171284-a`, so
 * matching the display name would have missed them and matching a bare `att-`
 * would put a future workspace called "Attendance" one zero-flow moment away
 * from deletion. The digits are what make it recognisably machine-generated.
 */
const LITTER_SLUG = /^(1-9-|probe-|e2e-|att-\d{10,}-|ds-target-control-)/;

/** Kestra will refuse to delete these, and it is right to. */
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

interface TidyReport {
  applied: boolean;
  runs: {
    /** Terminal, flowless — the ones that go. */
    deletable: Array<{ id: string; kestraId: string; flowName: string; status: string }>;
    /** Non-terminal, flowless — reported and refused. */
    refused: Array<{ id: string; kestraId: string; flowName: string; status: string; why: string }>;
    /** Rows that travel with them, counted explicitly rather than left to a cascade. */
    dependents: Record<string, number>;
    kestra: { deleted: number; failed: number; errors: string[] };
  };
  tenants: {
    deletable: Array<{ id: string; name: string; slug: string; tools: number; datasources: number }>;
    refused: Array<{ slug: string; why: string }>;
  };
  /** Left standing, printed so the guarantee is visible rather than implied. */
  kept: { flows: Array<{ ws: string; name: string; armed: boolean; runs: number }>; runs: number };
  warnings: string[];
}

/** Executions with no flow, split on whether Kestra will let them go. */
async function flowlessRuns() {
  const rows = await db
    .select({
      id: flowExecutions.id,
      kestraId: flowExecutions.kestraExecutionId,
      flowName: flowExecutions.kestraFlowId,
      status: flowExecutions.status,
    })
    .from(flowExecutions)
    .where(isNull(flowExecutions.flowId));

  const deletable = rows.filter((r) => TERMINAL.has(r.status));
  const refused = rows
    .filter((r) => !TERMINAL.has(r.status))
    .map((r) => ({
      ...r,
      why:
        "not terminal — a paused run holds a live human approval, and " +
        "kestra.deleteExecution refuses it on purpose",
    }));
  return { deletable, refused };
}

/**
 * The rows that travel with an execution, counted per table.
 *
 * ⚠ `flow_expectation_results` is in this list because it is `ON DELETE
 * CASCADE` and therefore invisible: `slate:plan` does not count it, so
 * `slate:clear`'s report understates what it destroys. A number nobody prints is
 * a number nobody checks.
 */
async function dependentCounts(execIds: string[]): Promise<Record<string, number>> {
  if (execIds.length === 0) return {};
  const of = async (t: typeof flowStepRuns | typeof flowStepApprovals | typeof executionTokens | typeof flowExpectationResults) => {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(t)
      .where(inArray(t.flowExecutionId, execIds));
    return n;
  };
  return {
    flow_step_approvals: await of(flowStepApprovals),
    flow_step_runs: await of(flowStepRuns),
    execution_tokens: await of(executionTokens),
    "flow_expectation_results (via cascade)": await of(flowExpectationResults),
  };
}

/** Harness tenants holding nothing, and the ones that only look like them. */
async function litterTenants() {
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      deletedAt: workspaces.deletedAt,
    })
    .from(workspaces);

  const deletable: TidyReport["tenants"]["deletable"] = [];
  const refused: TidyReport["tenants"]["refused"] = [];

  for (const w of rows) {
    if (!LITTER_SLUG.test(w.slug ?? "")) continue;
    if (PROTECTED_SLUGS.has(w.slug ?? "")) {
      refused.push({ slug: w.slug ?? "", why: "protected by name" });
      continue;
    }
    const [{ n: flowCount }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(flows)
      .where(eq(flows.workspaceId, w.id));
    if (flowCount > 0) {
      refused.push({ slug: w.slug ?? "", why: `holds ${flowCount} flow(s)` });
      continue;
    }
    if (w.deletedAt) continue; // already gone through the product's own path
    const [{ n: tools }] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from tools where workspace_id = ${w.id}`,
    ).then((r) => r.rows as Array<{ n: number }>);
    const [{ n: dss }] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from datasources where workspace_id = ${w.id}`,
    ).then((r) => r.rows as Array<{ n: number }>);
    deletable.push({ id: w.id, name: w.name, slug: w.slug ?? "", tools, datasources: dss });
  }
  return { deletable, refused };
}

/** What survives — printed, because a preservation guarantee should be checkable. */
async function keptFlows() {
  const r = await db.execute<{ ws: string; name: string; armed: boolean; runs: number }>(sql`
    select w.slug as ws, f.name, (f.armed_revision is not null) as armed,
           (select count(*)::int from flow_executions e where e.flow_id = f.id) as runs
      from flows f join workspaces w on w.id = f.workspace_id
     order by w.slug, f.name
  `);
  const flowsKept = r.rows as Array<{ ws: string; name: string; armed: boolean; runs: number }>;
  const [{ n }] = (
    await db.execute<{ n: number }>(
      sql`select count(*)::int as n from flow_executions where flow_id is not null`,
    )
  ).rows as Array<{ n: number }>;
  return { flows: flowsKept, runs: n };
}

async function plan(): Promise<TidyReport> {
  const runs = await flowlessRuns();
  const tenants = await litterTenants();
  return {
    applied: false,
    runs: {
      ...runs,
      dependents: await dependentCounts(runs.deletable.map((r) => r.id)),
      kestra: { deleted: 0, failed: 0, errors: [] },
    },
    tenants,
    kept: await keptFlows(),
    warnings: [],
  };
}

async function apply(report: TidyReport): Promise<TidyReport> {
  const execIds = report.runs.deletable.map((r) => r.id);

  // Kestra first. If the engine refuses, the Foundry pointer row is the only
  // remaining record that the execution existed — deleting it first would turn a
  // refusal into an orphan nobody can find again.
  for (const r of report.runs.deletable) {
    try {
      await kestra.deleteExecution(r.kestraId);
      report.runs.kestra.deleted++;
    } catch (e) {
      report.runs.kestra.failed++;
      if (report.runs.kestra.errors.length < 5) {
        report.runs.kestra.errors.push(`${r.kestraId}: ${(e as Error).message}`);
      }
    }
  }

  // Then Foundry, in FK order. Scoped by id — never a bare `delete from`.
  if (execIds.length > 0) {
    await db.delete(flowStepApprovals).where(inArray(flowStepApprovals.flowExecutionId, execIds));
    await db.delete(flowStepRuns).where(inArray(flowStepRuns.flowExecutionId, execIds));
    await db.delete(executionTokens).where(inArray(executionTokens.flowExecutionId, execIds));
    await db.delete(flowExecutions).where(inArray(flowExecutions.id, execIds));
  }

  // Tenants, through the product's own path.
  for (const t of report.tenants.deletable) {
    const ok = await workspaceService.remove(t.id);
    if (!ok) report.warnings.push(`workspace ${t.slug} was already deleted`);
  }

  report.applied = true;
  return report;
}

function print(r: TidyReport) {
  const head = r.applied ? "TIDY — applied" : "TIDY — dry run";
  console.log(`\n${head}\n`);

  console.log("Runs with no flow (harness residue)");
  const byFlow = new Map<string, number>();
  for (const x of r.runs.deletable) byFlow.set(x.flowName, (byFlow.get(x.flowName) ?? 0) + 1);
  for (const [name, n] of [...byFlow.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${r.applied ? "deleted" : "would delete"}  ${name}`);
  }
  if (byFlow.size === 0) console.log("     0  none");
  for (const [t, n] of Object.entries(r.runs.dependents)) {
    console.log(`  ${String(n).padStart(4)}  ${r.applied ? "deleted" : "would delete"}  ${t}`);
  }
  console.log(
    `  Kestra: ${
      r.applied
        ? `${r.runs.kestra.deleted} deleted, ${r.runs.kestra.failed} failed`
        : `${r.runs.deletable.length} to delete (dry run)`
    }`,
  );
  for (const e of r.runs.kestra.errors) console.log(`    ! ${e}`);

  if (r.runs.refused.length > 0) {
    console.log("\n  REFUSED — reported, never killed to make a delete succeed");
    for (const x of r.runs.refused) {
      console.log(`    ${x.flowName} (${x.status}) ${x.kestraId}`);
      console.log(`      ${x.why}`);
    }
  }

  console.log("\nThrowaway tenants");
  for (const t of r.tenants.deletable) {
    const holds = [t.tools ? `${t.tools} tools` : "", t.datasources ? `${t.datasources} datasources` : ""]
      .filter(Boolean)
      .join(", ");
    console.log(
      `  ${r.applied ? "soft-deleted" : "would soft-delete"}  ${t.slug}${holds ? `  (${holds})` : ""}`,
    );
  }
  if (r.tenants.deletable.length === 0) console.log("  none");
  if (r.tenants.refused.length > 0) {
    console.log("  refused:");
    for (const x of r.tenants.refused) console.log(`    ${x.slug} — ${x.why}`);
  }
  console.log(
    "  ⚠ soft delete sets `deleted_at`; the rows remain and are recoverable. " +
      "This is the product's own deletion, not a shred.",
  );

  console.log("\nKept");
  for (const f of r.kept.flows) {
    console.log(
      `  ${f.ws.padEnd(22)} ${f.name.padEnd(28)} ${f.armed ? "ARMED" : "draft"}  ${f.runs} run(s)`,
    );
  }
  console.log(`  ${r.kept.runs} execution(s) belonging to a live flow — untouched`);

  for (const w of r.warnings) console.log(`\n! ${w}`);
  if (!r.applied) console.log("\nNothing was changed. `pnpm tidy:clear --yes` to apply.\n");
  else console.log("");
}

async function main() {
  const argv = process.argv.slice(2);
  const wants = argv.includes("clear");
  const confirmed = argv.includes("--yes");

  let report = await plan();
  if (wants && !confirmed) {
    print(report);
    console.error("Refusing to apply without --yes.");
    process.exitCode = 1;
    return;
  }
  if (wants) report = await apply(report);
  print(report);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
