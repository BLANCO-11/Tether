/**
 * `pnpm tenants:plan` / `pnpm tenants:clear` — remove every TENANT, not just
 * every flow.
 *
 * ── WHY THIS IS A SECOND SCRIPT AND NOT A FLAG ON `slate:clear` ──────────────
 *
 * `fresh-slate.ts` states its own guarantee in its header: *"a cleared
 * deployment is therefore still fully provisioned"*. It keeps workspaces,
 * tools, datasources, named queries, introspected schemas, manifests, secrets
 * and budgets, and it keeps every row in the demo databases. That is a
 * deliberate and useful guarantee — after `slate:clear` you can start authoring
 * immediately.
 *
 * This script destroys exactly the surface that one preserves. Putting it
 * behind `--everything` on the same command would mean the safe operation and
 * the unrecoverable one share a name, a help string and a muscle memory. They
 * do not share a name here.
 *
 * ⚠ **THERE IS NO UNDO AND `pnpm restore` IS THE ONLY ROUTE BACK.** This drops
 * databases. A demo dataset is reseedable from the CLI; a workspace's
 * `workspace_secrets`, its introspected schema and its authored DB operations
 * are not, and neither is anything a person built by hand.
 *
 * ── WHAT IT REFUSES TO TOUCH ─────────────────────────────────────────────────
 *
 *   `foundry_parent` · `kestra` · `foundry_ops`   the control plane, the engine
 *                                                 and the tool layer
 *   `generation_llm`                              the resolved generation model
 *                                                 (D-115). Wiping it silently
 *                                                 reverts drafting to the env's
 *                                                 model, which is the exact
 *                                                 confusion D-115 exists to end.
 *   `platform_users`                              the record that a subject
 *                                                 presented a verified token.
 *                                                 Not tenant data.
 *   `foundry.system.*`                            inherited from `freshSlate`,
 *                                                 which owns that exclusion.
 *
 * ── THE DELETE ORDER IS FK ORDER AND IS WRITTEN OUT ──────────────────────────
 *
 * Same reasoning `fresh-slate.ts` gives: not every FK here has `ON DELETE
 * CASCADE`, and a cascade that reaches further than intended is the one thing a
 * script like this must not do. The order below was derived from
 * `pg_constraint` on this deployment, not from reading the schema file.
 *
 * ⚠ `flow_chat_threads` / `flow_chat_turns` are in this list and are NOT in
 * `fresh-slate.ts`'s — so a plain `slate:clear` leaves chat threads pointing at
 * flows that no longer exist. That is a real gap in that script, noted here
 * rather than fixed there, because fixing it changes what `slate:clear`
 * preserves and that is its documented contract.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { freshSlate, type SlateReport } from "./fresh-slate.js";

/**
 * Tenant-scoped tables, children before parents.
 *
 * Every name is a literal in this array and never comes from input — the same
 * constraint `fresh-slate.ts`'s `preservedCounts` works under.
 */
const TENANT_TABLES = [
  // chat, which `slate:clear` misses
  "flow_chat_turns",
  "flow_chat_threads",
  // revision children
  "flow_phases",
  "flow_step_flags",
  // flow children that survive slate:clear because it does not know them
  "flow_expectation_results",
  "flow_run_requests",
  "flow_step_positions",
  "flow_test_scenarios",
  "pins",
  "release_gates",
  // the approval queue (workspace-scoped, distinct from flow_approvals)
  "approval_decisions",
  "approval_requests",
  // workspace-scoped records
  "audit_events",
  "break_glass_sessions",
  "catalogue_items",
  "email_sends",
  "incidents",
  "attendance_compliance",
  "attendance_daily",
  // the datasource subtree — fixtures, readers and introspection before the row
  "datasource_fixtures",
  "datasource_operations",
  "datasource_queries",
  "schemas",
  "datasources",
  // the rest of the provisioned surface
  "tools",
  "workspace_secrets",
  "workspace_manifests",
  "tenant_budgets",
  "workspace_member_capabilities",
  "workspace_members",
  // last
  "workspaces",
] as const;

/** Databases this script must never drop, whatever the pattern says. */
const PROTECTED_DBS = ["foundry_parent", "kestra", "foundry_ops", "postgres", "template0", "template1"];

/**
 * A database is a drop candidate if it looks like a demo dataset or a sandbox
 * projection. An explicit pattern list rather than "everything not protected":
 * this cluster is shared, and `bto` is somebody else's database sitting right
 * beside ours. The next database somebody adds must be named here to be
 * dropped, which is the failure direction that leaves data alive.
 */
const DROPPABLE = [/^hr_demo(_alt)?$/, /_demo$/, /^foundry_sbx_/];

export interface TenantReport {
  applied: boolean;
  slate: SlateReport;
  /** Tenant rows, per table, in deletion order. */
  tenant: Array<{ table: string; rows: number }>;
  /** Workspaces that were there, named so the report says what was destroyed. */
  workspaces: Array<{ name: string; kind: string | null; deleted: boolean }>;
  databases: Array<{ name: string; dropped: boolean; error?: string }>;
  roles: Array<{ name: string; dropped: boolean; error?: string }>;
  /** Deliberately still standing. */
  preserved: Record<string, number>;
  warnings: string[];
}

async function countTenant(): Promise<Array<{ table: string; rows: number }>> {
  const out: Array<{ table: string; rows: number }> = [];
  for (const t of TENANT_TABLES) {
    const r = await db.execute(sql.raw(`select count(*)::int as n from ${t}`));
    out.push({ table: t, rows: Number((r.rows[0] as { n: number }).n) });
  }
  return out;
}

async function listWorkspaces(): Promise<Array<{ name: string; kind: string | null }>> {
  const r = await db.execute(
    sql.raw("select name, kind from workspaces order by deleted_at nulls first, name"),
  );
  return r.rows as Array<{ name: string; kind: string | null }>;
}

async function droppableDatabases(): Promise<string[]> {
  const r = await db.execute(sql.raw("select datname from pg_database order by datname"));
  return (r.rows as Array<{ datname: string }>)
    .map((x) => x.datname)
    .filter((n) => !PROTECTED_DBS.includes(n) && DROPPABLE.some((re) => re.test(n)));
}

/**
 * Roles this script must never drop.
 *
 * ⚠ **`ops_ro` IS THE ONE TO GET RIGHT, and the first version of this script
 * listed it for deletion.** It matches the `%_ro` shape every tenant reader
 * has, and it is not a tenant reader: it is ops-api's own read-only credential
 * on `foundry_ops`, which is a PROTECTED database. CLAUDE.md states why it
 * exists as a second role rather than a reuse of `foundry_ro` — *"so revoking
 * the script credential in an incident does not take the tool layer down"*.
 * Dropping it takes the tool layer down, which is the opposite.
 *
 * `foundry` is the owner this process is connected as; dropping it mid-script
 * is not a recoverable state.
 */
const PROTECTED_ROLES = ["foundry", "ops_ro"];

/**
 * Read-only roles the seeders create, discovered rather than hardcoded.
 *
 * ⚠ Discovery is the right default here and the exclusion list is what makes
 * it safe: a role belonging to a protected database is invisible to the
 * `%_ro` pattern, so the pattern cannot be the whole rule. A role added later
 * for a protected service must be named above.
 */
async function droppableRoles(): Promise<string[]> {
  const r = await db.execute(sql.raw("select rolname from pg_roles where rolname like '%\\_ro' order by rolname"));
  return (r.rows as Array<{ rolname: string }>)
    .map((x) => x.rolname)
    .filter((n) => !PROTECTED_ROLES.includes(n));
}

export async function freshTenants(opts: { apply: boolean }): Promise<TenantReport> {
  const warnings: string[] = [];

  // ── 1. Flows, runs, Kestra and the capture tables ──────────────────────────
  //
  // Delegated rather than reimplemented. `freshSlate` owns the Kestra half, the
  // `foundry.system` exclusion and the PAUSED-execution refusal; a second copy
  // of that logic is a second place for the protected-namespace check to drift.
  const slate = await freshSlate({ apply: opts.apply });

  const tenantBefore = await countTenant();
  const workspaces = await listWorkspaces();
  const dbs = await droppableDatabases();
  const roles = await droppableRoles();

  const report: TenantReport = {
    applied: opts.apply,
    slate,
    tenant: tenantBefore,
    workspaces: workspaces.map((w) => ({ ...w, deleted: false })),
    databases: dbs.map((name) => ({ name, dropped: false })),
    roles: roles.map((name) => ({ name, dropped: false })),
    preserved: {},
    warnings,
  };

  if (!opts.apply) {
    report.preserved = await preserved();
    return report;
  }

  // ── 2. Tenant rows, in FK order ────────────────────────────────────────────
  const after: Array<{ table: string; rows: number }> = [];
  for (const t of TENANT_TABLES) {
    const r = await db.execute(sql.raw(`delete from ${t}`));
    after.push({ table: t, rows: r.rowCount ?? 0 });
  }
  report.tenant = after;
  for (const w of report.workspaces) w.deleted = true;

  // ── 3. The databases ───────────────────────────────────────────────────────
  //
  // `DROP DATABASE` refuses while anything is connected, and the server and the
  // harnesses hold pooled connections to the demo databases.
  // So terminate first — and report the refusal rather than swallowing it, or a
  // "cleared" deployment keeps serving a datasource whose rows are still there.
  for (const d of report.databases) {
    try {
      await pool.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [d.name],
      );
      // Identifier, so it cannot be a bound parameter. `d.name` came from
      // `pg_database` filtered by the literal patterns above, never from input.
      await pool.query(`drop database if exists "${d.name}"`);
      d.dropped = true;
    } catch (e) {
      d.error = (e as Error).message;
      warnings.push(`could not drop ${d.name}: ${d.error}`);
    }
  }

  // ── 4. The read-only roles ─────────────────────────────────────────────────
  //
  // After the databases, necessarily: a role holding privileges on a live
  // database cannot be dropped, and the error names the database rather than
  // the privilege, which reads like the role being in use.
  for (const r of report.roles) {
    try {
      await pool.query(`drop role if exists "${r.name}"`);
      r.dropped = true;
    } catch (e) {
      r.error = (e as Error).message;
      warnings.push(`could not drop role ${r.name}: ${r.error}`);
    }
  }

  report.preserved = await preserved();

  // ── 5. Say whether it worked, from the database rather than from the plan ──
  const remaining = (await countTenant()).filter((c) => c.rows > 0);
  if (remaining.length) {
    warnings.push(
      `still populated after the clear: ${remaining.map((r) => `${r.table}=${r.rows}`).join(", ")}`,
    );
  }
  return report;
}

/** The three things whose survival is a property, printed rather than implied. */
async function preserved(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ["generation_llm", "platform_users", "reviewed_templates"]) {
    const r = await db.execute(sql.raw(`select count(*)::int as n from ${t}`));
    out[t] = Number((r.rows[0] as { n: number }).n);
  }
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const wantsApply = argv.includes("--apply") || argv.includes("clear");
  const confirmed = argv.includes("--yes");

  if (wantsApply && !confirmed) {
    console.error(
      "refusing: `tenants:clear` deletes every WORKSPACE, datasource, tool, secret and\n" +
        "introspected schema in this deployment, and DROPS the demo databases. It is a\n" +
        "superset of `slate:clear`. There is no undo short of `pnpm restore`.\n" +
        "Run `pnpm tenants:plan` to see what would go, then re-run with --yes.",
    );
    process.exit(2);
  }

  const r = await freshTenants({ apply: wantsApply });
  const verb = r.applied ? "deleted" : "would delete";

  console.log(r.applied ? "FRESH TENANTS — applied\n" : "FRESH TENANTS — dry run\n");

  console.log("Flows and runs (via slate)");
  const slateTotal = r.slate.foundry.reduce((a, b) => a + (b.rows ?? 0), 0);
  console.log(`  ${slateTotal.toString().padStart(6)}  ${verb}  rows across ${r.slate.foundry.length} tables`);
  console.log(
    `  ${r.slate.kestraFlows.length.toString().padStart(6)}  ${verb}  Kestra flows` +
      `, ${r.slate.kestraExecutions.found} executions`,
  );

  console.log("\nTenant provisioning");
  for (const { table, rows } of r.tenant) {
    if (rows > 0 || r.applied) console.log(`  ${rows.toString().padStart(6)}  ${verb}  ${table}`);
  }

  console.log(`\nWorkspaces (${r.workspaces.length})`);
  for (const w of r.workspaces) {
    console.log(`  ${w.deleted ? "deleted" : "would delete"}  ${w.name}${w.kind ? `  [${w.kind}]` : ""}`);
  }

  console.log("\nDatabases");
  for (const d of r.databases) {
    console.log(`  ${d.dropped ? "DROPPED" : d.error ? `FAILED (${d.error})` : "would DROP"}  ${d.name}`);
  }
  console.log(`  protected, never dropped: ${PROTECTED_DBS.join(", ")}`);

  console.log("\nRoles");
  for (const x of r.roles) {
    console.log(`  ${x.dropped ? "dropped" : x.error ? `FAILED (${x.error})` : "would drop"}  ${x.name}`);
  }
  console.log(`  protected, never dropped: ${PROTECTED_ROLES.join(", ")}`);

  console.log("\nPreserved on purpose");
  for (const [k, v] of Object.entries(r.preserved)) console.log(`  ${v.toString().padStart(6)}  ${k}`);

  if (r.warnings.length) {
    console.log("\nWARNINGS");
    for (const w of r.warnings) console.log(`  ! ${w}`);
  }
  if (!r.applied) console.log("\nNothing was changed. Re-run `tenants:clear --yes` to apply.");

  await pool.end();
}

if (process.argv[1] && process.argv[1].endsWith("fresh-tenants.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
