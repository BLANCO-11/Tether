/**
 * Runtime retry — the one loop the system was missing — verified against the
 * running engine.
 *
 *   pnpm --filter @foundry/server kestra:retry
 *   pnpm --filter @foundry/server kestra:retry --period=2026-05
 *
 * ── What has to be here rather than in a unit test ───────────────────────────
 *
 * `flow-compiler.test.ts` asserts the YAML: `maxAttempts` plural,
 * `behavior: RETRY_FAILED_TASK`, the refusals on `agent`/`approval`/`transform`.
 * None of that is evidence that a run recovers. Four things are facts about the
 * engine and are checked here:
 *
 *   1. **A transient failure does not kill the run.** The step fails once with a
 *      503 and the execution reaches its LAST step. Before this existed, the same
 *      flow ended `FAILED` at step 1 — which is asserted as the negative control
 *      below, using a flow identical except that it declares no `retry`.
 *   2. **The attempt count is real and visible.** Read from Kestra's taskrun and
 *      cross-checked against the ENDPOINT's own count of how many requests
 *      actually arrived. Those are two independent witnesses: Kestra saying
 *      "attempt 2" while the service saw one request would mean the retry never
 *      left the engine.
 *   3. **Retry does not fork the execution.** `CREATE_NEW_EXECUTION` is the other
 *      value Kestra accepts for `behavior`, and it would mint a second execution
 *      token, take a second M3 budget slot and write a second `flow_executions`
 *      row for one logical run. Asserted as a row count, because that is the
 *      symptom someone would eventually see.
 *   4. **Exhausting the attempts still fails.** A retry that swallowed a
 *      permanent failure would be worse than no retry at all: every one of this
 *      product's measured disasters is a thing that reported success while doing
 *      nothing. `failures=4` against `maxAttempts: 2` must end FAILED.
 *
 * Every assertion is paired with the control that makes it discriminating —
 * see the `no-retry` flow in block 1 and the exhaustion flow in block 4.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { kestra, type KestraExecution } from "../services/kestra-client.service.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { flowVisibilityService } from "../services/flow-visibility.service.js";
import { flowService } from "../services/flow.service.js";
import { flowPortabilityService } from "../services/flow-portability.service.js";
import { flowCompiler, type FlowModel } from "../services/flow-compiler.service.js";
import { tenantMapper } from "../services/tenant-mapper.service.js";
import { FLAKY_TOOL } from "../showcase/flows.js";
import { toolService } from "../services/tool.service.js";
import { config } from "../config/index.js";
import { OPS_AUTH_STYLE, OPS_SECRET_ENV, opsClient } from "../services/ops-client.service.js";
import { systemAuthor } from "../services/revision-author.js";

const PERIOD = process.argv.find((a) => a.startsWith("--period="))?.split("=")[1] ?? "2026-06";

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
  const pass = String(got) === String(want);
  if (!pass) failures++;
  console.log(
    `  ${pass ? c.ok("PASS") : c.bad("FAIL")}  ${label.padEnd(58)} ` +
      (pass ? c.dim(String(want)) : c.bad(`\n        got  ${got}\n        want ${want}`)),
  );
}
function checkThat(label: string, pass: boolean, detail = "") {
  if (!pass) failures++;
  console.log(`  ${pass ? c.ok("PASS") : c.bad("FAIL")}  ${label.padEnd(58)} ${c.dim(detail)}`);
}

const SETTLED = ["SUCCESS", "FAILED", "KILLED", "WARNING"];
const settled = (e: KestraExecution) => SETTLED.includes(e.state.current);

async function waitFor(executionId: string, timeoutMs = 180_000): Promise<KestraExecution> {
  const deadline = Date.now() + timeoutMs;
  let ex = await kestra.getExecution(executionId);
  while (Date.now() < deadline && !settled(ex)) {
    await new Promise((r) => setTimeout(r, 1500));
    ex = await kestra.getExecution(executionId);
  }
  return ex;
}

const taskrun = (e: KestraExecution, id: string) => (e.taskRunList ?? []).find((t) => t.taskId === id);

/**
 * How many times the engine ran a task.
 *
 * ⚠ `attempts.length`, not `attempt`. Kestra publishes no scalar — measured on
 * the first run of this harness, which reported `attempt: undefined` beside an
 * `attempts` array of length 2. `flow-visibility.service.ts` had been reading
 * the scalar since Phase 2, so the UI's "attempt N" badge could never fire.
 * Returns undefined when the task never ran, so a missing step is distinguishable
 * from one that ran once.
 */
const attemptsOf = (e: KestraExecution, id: string) => taskrun(e, id)?.attempts?.length;

/**
 * How many requests the ENDPOINT actually received for this key.
 *
 * The independent witness. Kestra's `attempt` counter says what the engine
 * believes it did; this says what crossed the wire. A retry that incremented one
 * without the other would be a retry that never happened.
 */
async function callsFor(key: string): Promise<number> {
  const rows = await opsClient.callLog(1000);
  // Every call, including the 401s and the 503s — the question is how many
  // requests crossed the wire, not how many succeeded. Filtering to 2xx here
  // would report 1 for a probe that failed once and then recovered, which is
  // precisely the case being measured.
  return rows.filter((r) => r.toolName === "flaky_probe" && r.query?.key === key).length;
}

/** Foundry rows for one logical run. Must be exactly 1, whatever the engine retried. */
async function executionRowsFor(kestraExecutionId: string): Promise<number> {
  const r = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM flow_executions WHERE kestra_execution_id = ${kestraExecutionId}`);
  return Number(r.rows?.[0]?.n ?? 0);
}

/**
 * The flow under test. One probe step, one report step.
 *
 * `key` is the EXECUTION id so each run gets its own counter at the endpoint —
 * a fixed key would fail once ever and every subsequent run would sail through,
 * which is a test that passes for the wrong reason from the second run onwards.
 */
function probeFlow(id: string, opts: { failures: number; retry?: { maxAttempts: number } }): FlowModel {
  return {
    id,
    steps: [
      {
        id: "probe",
        kind: "tool",
        ref: "flaky_probe",
        paramsExpr: `[{ "key": "{{ execution.id }}", "failures": ${opts.failures} }]`,
        ...(opts.retry ? { retry: { maxAttempts: opts.retry.maxAttempts, intervalSeconds: 1 } } : {}),
        timeoutSeconds: 30,
      },
      {
        id: "report",
        kind: "transform",
        // A transform, not a tool: this block is about the engine's retry, and a
        // second HTTP call would add a second way for it to fail.
        expr: "{{ json(outputs.probe.body).results[0].data | jq('.attempt') | first }}",
        dependsOn: ["probe"],
      },
    ],
  };
}

async function deploy(workspaceId: string, model: FlowModel) {
  const stale = await flowRepo.getByKestraFlowId(workspaceId, model.id);
  if (stale) await flowService.remove(workspaceId, stale.id);
  const created = await flowService.create(workspaceId, {
    name: `retry ${model.id}`,
    model,
    author: systemAuthor("retry-verify@acme-hr.example"),
  });
  return created.flow;
}

async function main() {
  console.log(
    `\n${"═".repeat(74)}\nRuntime retry  ${c.dim(`period ${PERIOD}`)}\n${"═".repeat(74)}`,
  );

  const ws = (await workspaceRepo.list()).find((w) => w.name === "HR");
  if (!ws) throw new Error('workspace "HR" not found — run `pnpm demo:seed`');

  // The fixture tool. Registered here as well as by `showcase:seed` so this
  // harness stands alone — a verification script that only works after another
  // script has run is one people stop running.
  //
  // ⚠ UPSERT, not create-if-absent. The earlier version skipped when a row with
  // this name already existed, and Stage 5 walked straight into what that costs:
  // the Stage 4 registration pointed at `:4000/stub-api/flaky` and carried no
  // auth, so after the tool layer moved, every probe call went to a deleted
  // route on the wrong service. `callsFor` returned 0, the retry appeared not to
  // reach the endpoint, and nothing named the stale row. `provision.ts` already
  // documents this trap for the ticket tools; it is the same one.
  const existingProbe = (await toolRepo.listByWorkspace(ws.id)).find(
    (t) => t.name === FLAKY_TOOL.name,
  );
  if (existingProbe) {
    await toolService.update(ws.id, existingProbe.id, {
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
      authParamName: null,
    });
    console.log(c.dim(`  re-registered ${FLAKY_TOOL.name}`));
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
    console.log(c.dim(`  registered ${FLAKY_TOOL.name}`));
  }

  // ── 1. the recovery, and the control that makes it mean something ─────────
  console.log(
    `\n${"─".repeat(74)}\n1  a transient failure is re-attempted, and the run survives\n`,
  );

  const withRetry = await deploy(ws.id, probeFlow("retry-recovers", { failures: 1, retry: { maxAttempts: 3 } }));
  const startedA = await flowService.testRun(ws.id, withRetry.id, {});
  const exA = await waitFor(startedA.kestraExecutionId);

  checkThat(
    "the run reached a terminal state that is not FAILED",
    exA.state.current === "SUCCESS" || exA.state.current === "WARNING",
    exA.state.current,
  );
  check("…and the downstream step ran", taskrun(exA, "report")?.state.current, "SUCCESS");
  // Ground truth: what actually crossed the wire. Independent of anything the
  // engine reports about itself, so a retry the engine believes in but never
  // made would fail here.
  check("the endpoint received exactly 2 requests", await callsFor(exA.id), 2);
  // warningOnRetry — the recovered run is recorded as WARNING, not SUCCESS, so
  // "it worked on the second go" is a fact rather than something you only find
  // by reading attempt counts.
  check("the recovered run settles WARNING, not a clean SUCCESS", exA.state.current, "WARNING");
  check("ONE Foundry execution row for one logical run", await executionRowsFor(exA.id), 1);

  // ── and it is VISIBLE, through the surface the UI actually reads ──────────
  //
  // Asserted against `flowVisibilityService`, not against the raw Kestra
  // taskrun. `StepGraph` renders an "attempt N" badge and `StepStrip` puts it in
  // the tooltip, and both read this view — so this is the assertion that
  // corresponds to the exit criterion ("visible in the step strip") rather than
  // to a field existing somewhere in an engine response.
  const rowA = await flowExecutionRepo.getByKestraId(exA.id);
  const viewA = rowA ? await flowVisibilityService.get(ws.id, rowA.id) : null;
  const probeView = viewA?.steps.find((s) => s.stepId === "probe");
  checkThat("the run view resolves", !!probeView, `${viewA?.steps.length ?? 0} step(s)`);
  check("…and reports the probe as attempt 2", probeView?.attempt, 2);
  // Cross-check against the engine's own array. Two witnesses again: the view is
  // what the UI renders, this is what Kestra recorded, and the per-attempt states
  // say WHICH way it went — `FAILED → SUCCESS` is a recovery, `FAILED → FAILED`
  // is an exhausted retry, and a count alone cannot tell them apart.
  check("…matching Kestra's attempts array", attemptsOf(exA, "probe"), 2);
  console.log(
    c.dim(
      `        attempt states: ` +
        (taskrun(exA, "probe")?.attempts ?? []).map((a) => a.state?.current).join(" → "),
    ),
  );

  // The negative control. Identical flow, no `retry:` — if this also survived,
  // every assertion above would be passing for a reason unrelated to retry
  // (a lucky endpoint, a swallowed error, a mis-set `failures`).
  console.log(c.dim("\n  control — the same flow with no retry declared:"));
  const noRetry = await deploy(ws.id, probeFlow("retry-control-none", { failures: 1 }));
  const startedB = await flowService.testRun(ws.id, noRetry.id, {});
  const exB = await waitFor(startedB.kestraExecutionId);

  check("CONTROL: without retry the same failure kills the run", exB.state.current, "FAILED");
  check("CONTROL: …the probe ran exactly once", attemptsOf(exB, "probe"), 1);
  checkThat(
    "CONTROL: …and the downstream step never ran",
    taskrun(exB, "report") === undefined || taskrun(exB, "report")?.state.current !== "SUCCESS",
    taskrun(exB, "report")?.state.current ?? "not reached",
  );

  // ── 2. the emitted YAML, as the engine actually holds it ──────────────────
  console.log(`\n${"─".repeat(74)}\n2  what is deployed, read back from Kestra\n`);

  // Through `tenantMapper`, not `namespaceFor` directly — it is the single
  // source for a workspace's namespace names, and it refuses a workspace with no
  // slug pair instead of quietly producing one that resolves to nothing.
  const draftNs = tenantMapper.namespacesFor(ws).draft;
  let deployed = "";
  try {
    deployed = await kestra.getFlowSource(draftNs, "retry-recovers");
  } catch (e) {
    // Degrading gracefully, but LOUDLY — a silent catch here is how "the field
    // is just null sometimes" bugs are born (I-12's lesson).
    console.log(c.warn(`  could not read the deployed source: ${(e as Error).message}`));
  }
  if (deployed) {
    checkThat("the deployed YAML carries a retry block", deployed.includes("retry:"), "");
    checkThat("…with maxAttempts (plural)", deployed.includes("maxAttempts:"), "");
    checkThat(
      "…and behavior: RETRY_FAILED_TASK, never CREATE_NEW_EXECUTION",
      deployed.includes("RETRY_FAILED_TASK") && !deployed.includes("CREATE_NEW_EXECUTION"),
      "",
    );
  }

  // ── 3. the compiler refuses what a retry would break ──────────────────────
  console.log(`\n${"─".repeat(74)}\n3  the refusals, against the same compiler that deploys\n`);

  const refuses = (step: object, label: string, pattern: RegExp) => {
    let message = "(did not throw)";
    try {
      flowCompiler.compile({ id: "refuse-probe", steps: [step as never] }, { namespace: draftNs });
    } catch (e) {
      message = (e as Error).message;
    }
    checkThat(label, pattern.test(message), message.slice(0, 90));
  };

  refuses(
    { id: "gate", kind: "approval", summaryExpr: '"ok?"', retry: { maxAttempts: 2 } },
    "an approval step cannot retry — the decision outlives the task",
    /already answered/,
  );
  refuses(
    { id: "t", kind: "transform", expr: "x", retry: { maxAttempts: 2 } },
    "a transform cannot retry — it has no network to fail on",
    /cannot fail/,
  );

  // ── 4. exhaustion still fails ─────────────────────────────────────────────
  console.log(`\n${"─".repeat(74)}\n4  a retry that runs out of attempts FAILS the run\n`);

  const exhausts = await deploy(ws.id, probeFlow("retry-exhausts", { failures: 4, retry: { maxAttempts: 2 } }));
  const startedC = await flowService.testRun(ws.id, exhausts.id, {});
  const exC = await waitFor(startedC.kestraExecutionId);

  // The most important assertion in the file. A retry that turned a permanent
  // failure into a green run would be strictly worse than no retry: every
  // measured disaster in this product is something that reported success while
  // having done nothing.
  check("a permanently broken step still fails the run", exC.state.current, "FAILED");
  check("…having made exactly maxAttempts attempts", attemptsOf(exC, "probe"), 2);
  check("…and the endpoint saw exactly 2 requests", await callsFor(exC.id), 2);
  check("…still ONE Foundry execution row", await executionRowsFor(exC.id), 1);

  // ── 5. retry travels in a bundle ──────────────────────────────────────────
  console.log(`\n${"─".repeat(74)}\n5  retry survives export → import (D-24's allowlist)\n`);

  const bundle = await flowPortabilityService.exportFlow(ws.id, withRetry.id);
  const bundledProbe = bundle.model.steps.find((s) => s.id === "probe") as { retry?: { maxAttempts: number } };
  // `bundleStep` is an allowlist per kind, so a field does not travel until
  // someone writes it down. Dropping retry would make an imported flow quietly
  // LESS resilient than the one it was copied from — a difference nobody notices
  // until the first transient failure in production.
  checkThat("the bundle carries the step's retry", !!bundledProbe?.retry, JSON.stringify(bundledProbe?.retry));
  check("…with the attempts intact", bundledProbe?.retry?.maxAttempts, 3);

  const plan = await flowPortabilityService.planImport(ws.id, bundle);
  const importedProbe = plan.model.steps.find((s) => s.id === "probe") as { retry?: { maxAttempts: number } };
  checkThat(
    "…and it is still there after the import rebuild",
    !!importedProbe?.retry,
    JSON.stringify(importedProbe?.retry),
  );

  // ── clean up ──────────────────────────────────────────────────────────────
  for (const f of [withRetry, noRetry, exhausts]) {
    try {
      await flowService.remove(ws.id, f.id);
    } catch {
      /* leave it; the next run replaces it anyway */
    }
  }

  console.log(`\n${"═".repeat(74)}`);
  if (failures > 0) {
    console.log(c.bad(`${failures} assertion(s) FAILED`));
    process.exit(1);
  }
  console.log(c.ok("runtime retry verified against the engine"));
  process.exit(0);
}

main().catch((e) => {
  console.error(c.bad(`\nkestra:retry failed: ${(e as Error).message}`));
  console.error(e);
  process.exit(1);
});
