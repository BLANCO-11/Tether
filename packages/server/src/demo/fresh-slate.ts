/**
 * `pnpm slate:plan` / `pnpm slate:clear` — remove every flow and every run, and
 * leave the tenants themselves standing.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Everything that had ever been authored in this deployment was a fixture: six
 * `showcase-*` flows and 990 executions, all of them written by a harness. That
 * is fine for proving engine properties and useless as a demonstration — a
 * person opening `/flows` saw a list of things named after the assertions that
 * created them.
 *
 * So this clears the *authored* surface and keeps the *provisioned* one. The
 * split is the whole design of the script:
 *
 *   DELETED   flows · revisions · steps · phases · step flags · card positions ·
 *             approvals · step approvals · executions · step runs · execution
 *             tokens · run requests · email sends · expectation results ·
 *             capability handles · triggers · trigger fires · chat threads and
 *             turns · generation jobs · templates · test scenarios · pins ·
 *             release gates, plus the matching Kestra flows and executions,
 *             plus ops-api's capture tables (outbox, tickets, call log, pages).
 *
 *   KEPT      workspaces · members · roles · users · tools · datasources ·
 *             uploaded files · fixtures · DB operations · named queries ·
 *             introspected schemas · manifests · secrets · budgets · the audit
 *             trails · the approval-request queue, and every demo database row.
 *
 * (2026-10-03) The DELETED list grew by fourteen tables added after this script
 * was written — chat threads were left orphaned by a clear, and 952 run requests
 * survived one. A table that holds a flow's or a run's state belongs here the day
 * it is added.
 *
 * A cleared deployment is therefore still fully provisioned: the catalogue a
 * flow can be authored against is intact, and nothing needs reseeding to start
 * authoring. Re-running the harnesses re-creates their own fixtures.
 *
 * ── WHAT IT REFUSES TO TOUCH, AND WHY ────────────────────────────────────────
 *
 * `foundry.system` is Foundry's operational namespace — retention, and the two
 * V1 network probes. It has no tenant segment, cannot resolve to a workspace,
 * and is not a tenant's automation (D-09). Deleting `retention` would silently
 * stop the only thing bounding Kestra's growth, and the failure would present
 * months later as a full disk. The namespace filter is an explicit exclusion
 * rather than an "it happens not to match", because the next namespace someone
 * adds must fail loudly rather than be swept.
 *
 * ── DRY RUN IS THE DEFAULT ───────────────────────────────────────────────────
 *
 * `slate:plan` counts and prints; `slate:clear` needs `--yes` on top. This
 * deletes a deployment's entire run history and there is no undo short of
 * `pnpm restore`. Two words is the right price.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { kestra, type NamespaceRef } from "../services/kestra-client.service.js";
import { opsClient } from "../services/ops-client.service.js";
import { config } from "../config/index.js";

/** Namespaces this script must never delete from, checked by exact prefix. */
const PROTECTED_NAMESPACE = `${config.kestra.namespacePrefix}.system`;

export interface SlateReport {
  applied: boolean;
  /** Foundry rows, per table, in deletion order. */
  /** `rows: null` — the table does not exist on this database (a schema behind or beside this one), so it was skipped. */
  foundry: Array<{ table: string; rows: number | null }>;
  /** Kestra flows found outside the protected namespace. */
  kestraFlows: Array<{ namespace: string; id: string; deleted: boolean; error?: string }>;
  kestraExecutions: { found: number; deleted: number; failed: number };
  /** ops-api capture tables, or the reason they could not be reached. */
  ops: { truncated: string[]; error?: string };
  /** Left standing on purpose — printed so the guarantee is visible, not implied. */
  preserved: Record<string, number | null>;
  /** Non-fatal problems worth reading. */
  warnings: string[];
}

/**
 * Delete order is FK order, and it is written out rather than relying on
 * `ON DELETE CASCADE`: not every one of these FKs has it (`flow_executions
 * .trigger_fire_id` does not), and a cascade that silently reaches further than
 * intended is exactly the kind of thing this script must not do.
 *
 * `flow_executions.replay_of_id` is self-referential, so that table needs one
 * unconditional delete rather than a leaf-first walk — safe because the whole
 * table goes.
 */
const DELETE_ORDER = [
  "flow_step_approvals",
  "flow_step_runs",
  "flow_expectation_results",
  "plugin_capability_handles",
  "email_sends",
  "execution_tokens",
  "flow_run_requests",
  "flow_executions",
  "trigger_fires",
  "triggers",
  "flow_approvals",
  "flow_step_flags",
  "flow_phases",
  "flow_step_positions",
  "flow_test_scenarios",
  "pins",
  "release_gates",
  "flow_chat_turns",
  "flow_chat_threads",
  "flow_steps",
  "flow_revisions",
  "flow_generation_jobs",
  "flow_templates",
  "flows",
] as const;

/**
 * Does this database have the table? A deployment can be on a different schema from the one this list was
 * written against (2026-10-03: a prod VM had no `plugin_capability_handles`), and a missing table holds no
 * rows to clear — so it is skipped and reported, never a reason to stop the whole clear.
 */
const exists = async (t: string) =>
  ((await db.execute(sql`select to_regclass(${`public.${t}`}) is not null as ok`)).rows[0] as { ok: boolean }).ok;

// Identifiers are the literals in this file, never input. `null` — the table is absent.
const count = async (t: string): Promise<number | null> =>
  (await exists(t))
    ? Number(((await db.execute(sql.raw(`select count(*)::int as n from ${t}`))).rows[0] as { n: number }).n)
    : null;

async function countAll(): Promise<Array<{ table: string; rows: number | null }>> {
  const out: Array<{ table: string; rows: number | null }> = [];
  for (const table of DELETE_ORDER) out.push({ table, rows: await count(table) });
  return out;
}

async function preservedCounts(): Promise<Record<string, number | null>> {
  const tables = [
    "workspaces",
    "workspace_members",
    "platform_users",
    "tools",
    "datasources",
    "datasource_files",
    "datasource_operations",
    "datasource_queries",
    "schemas",
    "workspace_manifests",
    "workspace_secrets",
    "tenant_budgets",
  ];
  const out: Record<string, number | null> = {};
  for (const t of tables) out[t] = await count(t);
  return out;
}

/** Every Kestra flow that is not Foundry's own operational infrastructure. */
async function tenantKestraFlows(): Promise<Array<{ namespace: string; id: string }>> {
  const found: Array<{ namespace: string; id: string }> = [];
  // Kestra's flow search pages; 200 is far above anything this deployment holds,
  // but read `total` and say so rather than silently truncating (I-12's lesson
  // is that a page-size assumption fails late and quietly).
  const res = await kestra.searchFlows({ size: 200 });
  for (const f of res.results) {
    if (f.namespace === PROTECTED_NAMESPACE || f.namespace.startsWith(`${PROTECTED_NAMESPACE}.`)) {
      continue;
    }
    found.push({ namespace: f.namespace, id: f.id });
  }
  if (res.total > res.results.length) {
    throw new Error(
      `Kestra reports ${res.total} flows but returned ${res.results.length} — raise the page ` +
        "size rather than clearing a partial set",
    );
  }
  return found;
}

export async function freshSlate(opts: { apply: boolean }): Promise<SlateReport> {
  const warnings: string[] = [];

  // ── 1. What is there ───────────────────────────────────────────────────────
  const before = await countAll();
  const kestraFlowList = await tenantKestraFlows();

  // Executions are counted per namespace: `executions/search` is namespace-scoped
  // and there is no "everything except" filter.
  //
  // ⚠ Collected into a SET, not an array. Kestra's sort is `state.startDate:desc`
  // and harness runs share a start second in bulk, so ties order differently
  // between page requests and the same execution comes back on two pages. The
  // first version pushed into an array and reported "1555 found, 945 deleted,
  // 610 failed" against a namespace that was in fact completely empty — 610
  // second attempts, each a 404. A dedupe is the fix; the reason it is worth a
  // comment is that the failure looked exactly like a refusal to delete.
  const namespaces = [...new Set(kestraFlowList.map((f) => f.namespace))];
  const seen = new Set<string>();
  for (const ns of namespaces) {
    const ref = { value: ns } as NamespaceRef;
    let page = 1;
    for (;;) {
      const res = await kestra.listExecutions(ref, { size: 200, page });
      for (const e of res.results) seen.add(e.id);
      if (res.results.length < 200) break;
      page++;
      if (page > 50) {
        warnings.push(`stopped paging ${ns} at 10,000 executions — re-run to clear the rest`);
        break;
      }
    }
  }
  const execIds = [...seen];

  const report: SlateReport = {
    applied: opts.apply,
    foundry: before,
    kestraFlows: kestraFlowList.map((f) => ({ ...f, deleted: false })),
    kestraExecutions: { found: execIds.length, deleted: 0, failed: 0 },
    ops: { truncated: [] },
    preserved: {},
    warnings,
  };

  if (!opts.apply) {
    report.preserved = await preservedCounts();
    return report;
  }

  // ── 2. Kestra first ────────────────────────────────────────────────────────
  //
  // Before Foundry, deliberately. `flow_executions` is Foundry's POINTER into
  // Kestra (R6) — the engine holds the data. Clearing the pointers first would
  // leave engine executions with nothing in Foundry naming them, which is the
  // one state no read path here can report.
  for (const e of report.kestraFlows) {
    try {
      await kestra.deleteFlow({ value: e.namespace } as NamespaceRef, e.id);
      e.deleted = true;
    } catch (err) {
      e.error = (err as Error).message;
    }
  }
  const refusals: string[] = [];
  for (const id of execIds) {
    try {
      await kestra.deleteExecution(id);
      report.kestraExecutions.deleted++;
    } catch (err) {
      // A 404 means it went away between the listing and here — already gone is
      // the outcome asked for, so it is not a failure. Anything else is: a
      // PAUSED execution refuses deletion until it is killed, and saying so is
      // the point, because a live human approval is exactly what must not be
      // silently destroyed.
      const status = (err as { status?: number }).status;
      if (status === 404) continue;
      report.kestraExecutions.failed++;
      if (refusals.length < 3) refusals.push(`${id}: ${(err as Error).message}`);
    }
  }
  if (report.kestraExecutions.failed > 0) {
    warnings.push(
      `${report.kestraExecutions.failed} Kestra execution(s) refused deletion — a PAUSED run ` +
        `must be killed first (pnpm kestra:ui). First: ${refusals.join("; ")}`,
    );
  }

  // ── 3. Foundry ─────────────────────────────────────────────────────────────
  const after: Array<{ table: string; rows: number | null }> = [];
  const present = new Set(before.filter((c) => c.rows !== null).map((c) => c.table));
  // One transaction: a clear that stops half way leaves runs pointing at flows that are gone.
  await db.transaction(async (tx) => {
    for (const table of DELETE_ORDER) {
      if (!present.has(table)) { after.push({ table, rows: null }); continue; }
      const r = await tx.execute(sql.raw(`delete from ${table}`));
      after.push({ table, rows: r.rowCount ?? 0 });
    }
  });
  report.foundry = after;

  // ── 4. ops-api's capture tables ────────────────────────────────────────────
  //
  // Over HTTP, because the parent holds no credential for that database and must
  // not acquire one (D-33). Not swallowed: a slate that leaves 47 emails in the
  // outbox makes the next run's count agree with an oracle for the wrong reason,
  // which is the exact failure `demo:reset` documents.
  try {
    report.ops.truncated = (await opsClient.reset()).truncated;
  } catch (e) {
    report.ops.error = (e as Error).message;
    warnings.push(
      `ops-api capture tables were NOT cleared (${(e as Error).message}) — the outbox still ` +
        "holds previous runs; fix ops-api and re-run before trusting any count",
    );
  }

  report.preserved = await preservedCounts();

  // ── 5. Say whether it worked, from the database rather than from the plan ──
  const remaining = (await countAll()).filter((c) => (c.rows ?? 0) > 0);
  if (remaining.length) {
    warnings.push(
      `still populated after the clear: ${remaining.map((r) => `${r.table}=${r.rows}`).join(", ")}`,
    );
  }
  return report;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const wantsApply = argv.includes("--apply") || argv.includes("clear");
  const confirmed = argv.includes("--yes");

  if (wantsApply && !confirmed) {
    console.error(
      "refusing: `slate:clear` deletes every flow and every run in this deployment, in " +
        "Foundry AND in Kestra. There is no undo short of `pnpm restore`.\n" +
        "Run `pnpm slate:plan` to see what would go, then re-run with --yes.",
    );
    process.exit(2);
  }

  const r = await freshSlate({ apply: wantsApply });
  const verb = r.applied ? "deleted" : "would delete";

  console.log(r.applied ? "FRESH SLATE — applied\n" : "FRESH SLATE — dry run\n");
  console.log("Foundry");
  for (const { table, rows } of r.foundry) {
    console.log(rows === null ? `       —  absent here, skipped  ${table}` : `  ${rows.toString().padStart(6)}  ${verb}  ${table}`);
  }
  console.log("\nKestra");
  for (const f of r.kestraFlows) {
    console.log(
      `  ${f.deleted ? "deleted" : r.applied ? `FAILED (${f.error})` : "would delete"}  ` +
        `${f.namespace}/${f.id}`,
    );
  }
  console.log(
    `  ${r.kestraExecutions.found} execution(s) found; ` +
      `${r.applied ? `${r.kestraExecutions.deleted} deleted, ${r.kestraExecutions.failed} failed` : "none deleted (dry run)"}`,
  );
  console.log(`  protected, never touched: ${PROTECTED_NAMESPACE}.*`);
  console.log(
    `\nops-api  ${r.ops.error ? `NOT CLEARED — ${r.ops.error}` : r.applied ? r.ops.truncated.join(", ") : "would truncate the four capture tables"}`,
  );
  console.log("\nPreserved");
  for (const [t, n] of Object.entries(r.preserved)) {
    console.log(n === null ? `       —  ${t} (absent here)` : `  ${n.toString().padStart(6)}  ${t}`);
  }
  if (r.warnings.length) {
    console.log("\nWarnings");
    for (const w of r.warnings) console.log(`  ⚠ ${w}`);
  }
  if (!r.applied) console.log("\nNothing was changed. `./scripts/fresh-slate.sh --yes` to apply.");
}

/**
 * ⚠ Guarded, so `freshSlate` can be IMPORTED.
 *
 * This called `main()` unconditionally, which means any module importing
 * `freshSlate` ran a dry-run slate — opening the pool, paging every Kestra
 * execution and then calling `pool.end()` underneath its importer. That is the
 * defect `propose-measure.test.ts` hit from the other direction (a scenario
 * script's `main()` running at import), and here the blast radius is larger,
 * because the importer might be the one asking for `{ apply: true }`.
 *
 * `fresh-tenants.ts` is the first importer and is why this is guarded now.
 */
if (process.argv[1] && process.argv[1].endsWith("fresh-slate.ts")) {
  main()
    .then(() => pool.end())
    .catch(async (e) => {
      console.error(e);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}
