/**
 * Phase 1 — prove the loop, or kill the thesis.
 * archive/kestra-migration/progress/phase-1.md
 *
 *   pnpm kestra:prove                 # all three scenarios, scored
 *   pnpm kestra:prove --only=rollup   # one scenario by key
 *   pnpm kestra:prove --no-run        # seed + deploy only
 *   pnpm kestra:prove --no-reset      # keep existing stub side effects
 *
 * This script is the falsification gate. From the plan's README:
 *
 *   "Rebuild the three measured scenarios as flows and score them against
 *    GET /api/test-oracle/screening. If per-step generation does not clearly beat 1-of-3,
 *    the thesis is wrong."
 *
 * It exits non-zero when any flow disagrees with its oracle. A green run means
 * the decomposition produced the right answer; it does NOT mean the rest of the
 * plan is proven, and the numbers it prints are the only evidence that matters.
 *
 * ── What "three scenarios" means here ────────────────────────────────────────
 *
 * The three originally-measured prompts were recorded in `PRODUCTION_DRY_RUN.md`,
 * which was never tracked in git and is gone (see progress/ISSUES.md I-08). These
 * three are therefore RECONSTRUCTED, not the literal originals — chosen so each
 * has a different SHAPE and each targets a different measured failure mode:
 *
 *   A screening   fan-out    N rows → N emails       fabricated dates, missing COALESCE
 *   B escalation  fan-IN     N rows → M tickets      invented joins; N→N when the answer is N→M
 *   C roll-up     aggregate  all rows → one message  divide-by-zero, dropping the empty group
 *
 * Each is scored against an oracle written independently of the flow.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config/index.js";
import { kestra, namespaceFor, KestraError, type KestraExecution } from "../services/kestra-client.service.js";
import { datasourceQueryRepo } from "../repositories/datasource-query.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowExecutionRepo, flowStepRunRepo } from "../repositories/flow-execution.repo.js";
import { expectedScreening } from "../demo/hr-dataset.js";
import { expectedEscalation, expectedRollup } from "../demo/scenario-oracles.js";
import type { NamedQuerySpec } from "../services/datasource-query.service.js";
import { HR_GENERATED_QUERIES } from "../demo/hr-generated.js";
import { opsClient } from "../services/ops-client.service.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATASOURCE_NAME = "hr_demo";
/**
 * The reporting period. Overridable with `--period=YYYY-MM`, which is the point:
 * the worst measured failure was a script that hardcoded `period="2023-10"`. Here
 * the period is a declared flow input and the oracle is recomputed for it, so
 * running the same three flows at a different period is a direct test that
 * nothing downstream is pinned to a literal.
 */
const PERIOD =
  process.argv.find((a) => a.startsWith("--period="))?.slice("--period=".length) ?? "2026-06";
const FOUNDRY = (process.env.FOUNDRY_BASE_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

// ─────────────────────────────────────────────────────────────────────────────
// Scenario definitions
// ─────────────────────────────────────────────────────────────────────────────

type Check = [label: string, got: unknown, want: unknown];

interface Scenario {
  key: string;
  flowId: string;
  file: string;
  title: string;
  /** What this scenario proves that the others do not. Printed, so a green run says why it matters. */
  shape: string;
  inputs: Record<string, string>;
  /** Scored against the oracle, from the execution's own task outputs. */
  score: (execution: KestraExecution) => Check[];
  /** Scored from the stub side-effect tables — INDEPENDENT of what the flow reported. */
  sideEffects: () => Promise<Check[]>;
}

/** Pull a task's parsed response body out of the execution context. */
function stepBody<T>(execution: KestraExecution, taskId: string): T | null {
  const task = (execution.taskRunList ?? []).find((t) => t.taskId === taskId);
  const raw = task?.outputs?.body;
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Rows from a `datasource` step's first (and only) named-query result. */
function stepRows<T>(execution: KestraExecution, taskId: string): T[] {
  const parsed = stepBody<{ results?: Array<{ data?: unknown }> }>(execution, taskId);
  return ((parsed?.results?.[0]?.data as T[]) ?? []) as T[];
}

const SCENARIOS: Scenario[] = [
  // ── A ──────────────────────────────────────────────────────────────────────
  {
    key: "screening",
    flowId: "hr-attendance-screening",
    file: "hr-screening.flow.yml",
    title: "A — attendance screening → email",
    shape: "fan-out: N flagged rows → N emails",
    inputs: { period: PERIOD },
    score: (execution) => {
      const oracle = expectedScreening(PERIOD);
      const flagged = stepRows<{ employee_id: number; work_email: string | null }>(execution, "screen");
      const gotIds = flagged.map((f) => Number(f.employee_id)).sort((a, b) => a - b);
      const wantIds = oracle.flagged.map((f) => f.id).sort((a, b) => a - b);
      return [
        ["below threshold", gotIds.length, wantIds.length],
        ["exact employee ids", gotIds.join(","), wantIds.join(",")],
        ["unmailable (NULL email)", flagged.filter((f) => f.work_email === null).length, oracle.unmailable.length],
        // The trap that a script hardcoding 80 always missed. Called out
        // separately because "11 == 11" could still be 11 wrong people.
        //
        // Derived from the oracle, not hardcoded to "present": #14 is at 80.95%
        // in June and comfortably above the bar in May, so a fixed expectation
        // here fails at any other period — which is the same class of mistake
        // (a literal where a computed value belongs) the flows exist to avoid.
        [
          "#14 tracks the oracle (ENG bar 85)",
          flagged.some((f) => Number(f.employee_id) === 14) ? "present" : "absent",
          oracle.flagged.some((f) => f.id === 14) ? "present" : "absent",
        ],
      ];
    },
    sideEffects: async () => {
      const oracle = expectedScreening(PERIOD);
      const mailable = oracle.flagged.length - oracle.unmailable.length;
      const rows = await opsClient.records<{ status: string }>("mail", 1000);
      const bounced = rows.filter((r) => r.status === "bounced").length;
      return [
        ["mail_outbox rows", rows.length, mailable],
        ["bounced", bounced, oracle.bouncing.length],
        ["delivered", rows.length - bounced, mailable - oracle.bouncing.length],
      ];
    },
  },

  // ── B ──────────────────────────────────────────────────────────────────────
  {
    key: "escalation",
    flowId: "hr-manager-escalation",
    file: "hr-escalation.flow.yml",
    title: "B — escalate to the nearest active manager → tickets",
    shape: "fan-IN: N flagged rows → M tickets, M < N",
    inputs: { period: PERIOD },
    score: (execution) => {
      const oracle = expectedEscalation(PERIOD);
      const grouped = stepBody<never>(execution, "group_by_manager");
      // `debug.Return` puts its rendered value on `value`, not `body`.
      const task = (execution.taskRunList ?? []).find((t) => t.taskId === "group_by_manager");
      const raw = (task?.outputs?.value ?? grouped) as string | undefined;
      let parsed: { tickets?: Array<{ manager_id: number; report_ids: number[] }>; unescalatable?: unknown[] } = {};
      try {
        parsed = typeof raw === "string" ? JSON.parse(raw) : ((raw ?? {}) as never);
      } catch {
        /* reported as a mismatch below */
      }
      const tickets = parsed.tickets ?? [];
      const gotManagers = tickets.map((t) => Number(t.manager_id)).sort((a, b) => a - b);
      const wantManagers = oracle.tickets.map((t) => t.managerId).sort((a, b) => a - b);
      const gotPairs = tickets
        .map((t) => `${t.manager_id}:${[...t.report_ids].sort((a, b) => a - b).join("+")}`)
        .sort()
        .join(" ");
      const wantPairs = oracle.tickets
        .map((t) => `${t.managerId}:${t.reportIds.join("+")}`)
        .sort()
        .join(" ");
      return [
        // The fan-in itself. 11 flagged people, fewer than 11 tickets.
        ["tickets (fan-in from 11 flagged)", tickets.length, oracle.tickets.length],
        ["exact manager ids", gotManagers.join(","), wantManagers.join(",")],
        ["manager → reports mapping", gotPairs, wantPairs],
        ["unescalatable reported", (parsed.unescalatable ?? []).length, oracle.unescalatable.length],
      ];
    },
    sideEffects: async () => {
      const oracle = expectedEscalation(PERIOD);
      const rows = await opsClient.records<{ assignee: string | null; priority: string | null }>("tickets", 1000);
      const assigned = rows.filter((r) => r.assignee !== null).length;
      return [
        ["tickets created", rows.length, oracle.tickets.length],
        [
          "assigned to a manager",
          assigned,
          oracle.tickets.length - oracle.unassignable.length,
        ],
        ["all high priority", rows.every((r) => r.priority === "high"), true],
      ];
    },
  },

  // ── C ──────────────────────────────────────────────────────────────────────
  {
    key: "rollup",
    flowId: "hr-department-rollup",
    file: "hr-rollup.flow.yml",
    title: "C — per-department roll-up → chat",
    shape: "aggregate: all rows → one message, empty group included",
    inputs: { period: PERIOD, channel: "#hr-ops" },
    score: (execution) => {
      const oracle = expectedRollup(PERIOD);
      const rows = stepRows<{
        department_code: string;
        headcount: number;
        avg_attendance_rate: number | null;
        below_threshold: number;
        threshold: number;
      }>(execution, "rollup");
      const fmt = (d: { department_code: string; headcount: number; avg_attendance_rate: number | null; below_threshold: number }) =>
        `${d.department_code}/${d.headcount}/${d.avg_attendance_rate ?? "null"}/${d.below_threshold}`;
      const got = [...rows].sort((a, b) => a.department_code.localeCompare(b.department_code)).map(fmt).join(" ");
      const want = oracle.departments
        .map((d) => `${d.departmentCode}/${d.headcount}/${d.avgAttendanceRate ?? "null"}/${d.belowThreshold}`)
        .join(" ");
      const empty = rows.filter((d) => d.headcount === 0);
      return [
        ["every department present", rows.length, oracle.departments.length],
        ["headcount / avg / below, per department", got, want],
        // The empty department is the trap, so it is asserted twice: present at
        // all, and null rather than 0.
        ["empty department present", empty.map((d) => d.department_code).join(","), oracle.emptyDepartments.join(",")],
        ["empty department avg is null, not 0", empty.every((d) => d.avg_attendance_rate === null), true],
        ["org below threshold", rows.reduce((n, d) => n + Number(d.below_threshold), 0), oracle.orgBelowThreshold],
      ];
    },
    sideEffects: async () => {
      const oracle = expectedRollup(PERIOD);
      const rows = await opsClient.records<{ text: string | null; channel: string }>("chat", 1000);
      const text = rows.map((r) => r.text ?? "").join("\n");
      return [
        ["chat messages posted", rows.length, 1],
        ["posted to the resolved channel", rows[0]?.channel ?? "none", "#hr-ops"],
        // The message itself must name the empty department. A roll-up that
        // computed it correctly and then formatted it away is still wrong.
        ["message names the empty department", oracle.emptyDepartments.every((code) => text.includes(code)), true],
        ["message names all 7 departments", oracle.departments.filter((d) => text.includes(d.departmentCode)).length, 7],
        // Phrased positively so an EMPTY message cannot pass it. `!/names/.test("")`
        // is true, which would have read as "correctly withheld employee names"
        // for a message that was never posted.
        ["message is a roll-up, not a per-employee list", text.length > 0 && !/Villalobos|Solberg|Cardoso/.test(text), true],
      ];
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────

async function resolveWorkspace() {
  const all = await workspaceRepo.list();
  const ws = all.find((w) => w.name === "HR");
  if (!ws) throw new Error('workspace "HR" not found — run `pnpm demo:seed` first');
  if (!ws.slug || !ws.tenantSlug) {
    throw new Error(`workspace "HR" has no namespace slugs — migration 0010 backfills them`);
  }
  return ws;
}

async function seedQueries(workspaceId: string, queries: NamedQuerySpec[]) {
  const datasources = await datasourceRepo.listByWorkspace(workspaceId);
  const ds = datasources.find((d) => d.name === DATASOURCE_NAME);
  if (!ds) throw new Error(`datasource "${DATASOURCE_NAME}" not found in workspace HR`);

  for (const q of queries) {
    await datasourceQueryRepo.upsertByName({
      datasourceId: ds.id,
      name: q.name,
      description: q.description,
      sqlText: q.sqlText,
      paramOrder: q.paramOrder,
      paramsSchema: q.paramsSchema,
    });
    console.log(`  ${c.ok("✓")} named query ${DATASOURCE_NAME}.${q.name}`);
  }
}

async function deployFlow(ns: ReturnType<typeof namespaceFor>, scenario: Scenario) {
  let yaml = fs.readFileSync(path.join(here, scenario.file), "utf8");
  // The YAML carries the namespace literally so it is readable on disk and in
  // kestra-ui. Rewrite it from the workspace's slugs so a differently-slugged
  // install cannot deploy into the wrong namespace.
  yaml = yaml.replace(/^namespace:.*$/m, `namespace: ${ns.value}`);

  const findings = (await kestra.validateFlow(yaml)) ?? [];
  const problems = findings.filter((f) => f.constraints);
  if (problems.length) {
    console.error(c.bad(`  ✗ Kestra rejected ${scenario.flowId}:`));
    for (const p of problems) console.error(`    ${p.constraints}`);
    process.exit(1);
  }
  const deployed = await kestra.deployFlow(ns, scenario.flowId, yaml);
  console.log(`  ${c.ok("✓")} ${scenario.flowId} revision ${deployed.revision}`);
}

async function runAndWait(ns: ReturnType<typeof namespaceFor>, scenario: Scenario, workspaceId: string) {
  const started = await kestra.startExecution(
    ns,
    scenario.flowId,
    scenario.inputs,
    // Labels carry the workspace so kestra-ui stays filterable during internal
    // debugging without cross-referencing ids. NOT a credential — Kestra
    // persists labels (R2).
    { workspace: workspaceId, phase: "1", scenario: scenario.key },
  );
  const deadline = Date.now() + 180_000;
  let execution = started;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    execution = await kestra.getExecution(started.id);
    if (["SUCCESS", "FAILED", "KILLED", "WARNING"].includes(execution.state.current)) break;
  }
  return execution;
}

function reportTaskRuns(execution: KestraExecution) {
  for (const tr of execution.taskRunList ?? []) {
    const state = tr.state.current;
    const hist = tr.state.histories ?? [];
    const ms = hist.length >= 2 ? Date.parse(hist[hist.length - 1].date) - Date.parse(hist[0].date) : null;
    console.log(
      `    ${state === "SUCCESS" ? c.ok("✓") : c.bad("✗")} ${tr.taskId.padEnd(18)} ${state.padEnd(9)} ${ms !== null ? `${ms}ms` : ""}`,
    );
  }
}

function report(checks: Check[]): number {
  let bad = 0;
  for (const [label, got, want] of checks) {
    const pass = String(got) === String(want);
    if (!pass) bad++;
    console.log(
      `    ${pass ? c.ok("PASS") : c.bad("FAIL")}  ${String(label).padEnd(40)} ` +
        (pass ? c.dim(String(want)) : c.bad(`\n            got  ${got}\n            want ${want}`)),
    );
  }
  return bad;
}

/**
 * Clear the capture tables between scenarios.
 *
 * Scored side effects are only meaningful against a known-empty starting point —
 * "10 mails in the outbox" proves nothing if the previous run left 10 there.
 * This touches ops-api's four tables ONLY; it does not reseed `hr_demo` and
 * never touches workspaces, tools or triggers.
 *
 * It is a call to ops-api rather than a TRUNCATE because those tables are in
 * that service's database now and this process holds no credential for it. If
 * ops-api is unreachable the call THROWS, which is the behaviour that matters:
 * a reset that quietly did nothing would leave the previous scenario's rows in
 * place and score the next one against them.
 */
async function resetSideEffects() {
  await opsClient.reset();
}

async function main() {
  const noRun = process.argv.includes("--no-run");
  const noReset = process.argv.includes("--no-reset");
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);
  const scenarios = only ? SCENARIOS.filter((s) => s.key === only) : SCENARIOS;
  if (!scenarios.length) throw new Error(`no scenario matches --only=${only}`);

  console.log(`\nPhase 1 — prove the loop\n${"═".repeat(60)}`);

  const ws = await resolveWorkspace();
  console.log(`workspace HR  ${c.dim(`${ws.tenantSlug}.${ws.slug}  ${ws.id}`)}`);

  const health = await kestra.health();
  if (!health.reachable) throw new Error(`Kestra unreachable at ${health.baseUrl}: ${health.detail}`);
  if (!health.authenticated) throw new Error(`Kestra rejected KESTRA_AUTH: ${health.detail}`);
  console.log(`kestra        ${c.dim(`${health.edition} ${health.version} @ ${health.baseUrl}`)}`);
  console.log(`foundry       ${c.dim(FOUNDRY)}`);

  if (!config.kestra.callbackSecret) {
    throw new Error("KESTRA_CALLBACK_SECRET is unset — POST /api/executions/begin refuses everything");
  }

  console.log(`\nseed generated queries (flagged_unreachable is showcase-only; flagged_with_escalation_target has no consumers and is dropped)`);
  await seedQueries(ws.id, [...HR_GENERATED_QUERIES.filter((q) => q.name !== "flagged_unreachable")]);

  console.log(`\ndeploy flows`);
  const ns = namespaceFor(ws.tenantSlug!, ws.slug!);
  for (const s of scenarios) await deployFlow(ns, s);
  if (noRun) return;

  let totalFailures = 0;
  const summary: Array<[string, boolean]> = [];

  for (const scenario of scenarios) {
    console.log(`\n${"─".repeat(60)}\n${scenario.title}\n  ${c.dim(scenario.shape)}\n`);
    if (!noReset) await resetSideEffects();

    const execution = await runAndWait(ns, scenario, ws.id);
    console.log(`  ${c.dim(`execution ${execution.id}`)}`);
    reportTaskRuns(execution);

    console.log(`\n  oracle (period ${PERIOD}):`);
    let bad = report(scenario.score(execution));

    // Scored from the stub tables, NOT from the flow's own report. This is the
    // direct counterpart of the measured failure where a script reported
    // tests_passed=true having emailed 0 of 11.
    console.log(`\n  side effects, measured independently of the flow's report:`);
    bad += report(await scenario.sideEffects());

    const fx = await flowExecutionRepo.getByKestraId(execution.id);
    if (!fx) {
      console.log(`    ${c.bad("FAIL")}  no flow_executions row — begin never ran`);
      bad++;
    } else {
      const stepRuns = await flowStepRunRepo.listByExecution(fx.id);
      console.log(
        `\n  foundry records: ${c.dim(`flow_executions status=${fx.status}, ${stepRuns.length} step pointer(s): ${stepRuns.map((s) => s.stepId).join(", ")}`)}`,
      );
    }

    const stateOk = execution.state.current === "SUCCESS";
    if (!stateOk) {
      console.log(`    ${c.bad("FAIL")}  execution state ${execution.state.current}`);
      bad++;
    }
    summary.push([scenario.title, bad === 0]);
    totalFailures += bad;
  }

  console.log(`\n${"═".repeat(60)}`);
  for (const [title, ok] of summary) console.log(`  ${ok ? c.ok("PASS") : c.bad("FAIL")}  ${title}`);
  const passed = summary.filter(([, ok]) => ok).length;
  console.log(
    `\n  ${passed === summary.length ? c.ok(`${passed} of ${summary.length} scenarios`) : c.bad(`${passed} of ${summary.length} scenarios`)}` +
      c.dim("   (the measured baseline for generated scripts was 1 of 3)") +
      "\n",
  );
  if (totalFailures > 0) process.exit(1);
}

main().catch((e) => {
  if (e instanceof KestraError) {
    console.error(c.bad(`\nKestra error ${e.status}:`), e.message);
    console.error(JSON.stringify(e.body, null, 2)?.slice(0, 2000));
  } else {
    console.error(c.bad("\nfailed:"), (e as Error).message);
  }
  process.exit(1);
});
