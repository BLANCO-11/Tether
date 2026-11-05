/**
 * Phase 6 — replay and sharing, verified against the running stack.
 * archive/kestra-migration/progress/phase-6.md
 *
 *   pnpm --filter @foundry/server kestra:phase6
 *   pnpm --filter @foundry/server kestra:phase6 --live
 *
 * ── The exit criterion, and the control that makes it mean something ─────────
 *
 * 08 §10: *"export a flow from the HR workspace, import into `hr_demo_alt`,
 * regenerate its code steps, and assert it produces the **alt** oracle's answer
 * — proving structure travelled and fragments refitted (the 0–100 vs 0–1 rate
 * difference is the test that matters)."*
 *
 * Proving only the positive case would be worthless: a harness that cannot detect
 * a wrong answer produces the same green as one that can. So the import is run
 * TWICE into the alt tenant, against two named queries that differ in exactly one
 * respect — whether the rate is converted to the percentage the travelling
 * contract declares (`alt-screening.queries.ts`).
 *
 *   NEGATIVE  the alt's native 0–1 fraction. Imports with ZERO findings, runs
 *             green, and reports a shortfall of ~0.22 where the truth is ~22.
 *   POSITIVE  ×100. Imports identically, runs green, and matches the oracle.
 *
 * That pair is the phase's real result, and it is a limit as much as a success:
 * **an import is a structural check, not a correctness one.** Only the importing
 * tenant's oracle is the latter.
 *
 * ── --live, and what is honest without it ───────────────────────────────────
 *
 * Fragment generation runs through a SCRIPTED `InferenceClient` by default. That
 * is stated rather than hidden: with a script, "the fragment refitted" is not
 * being proven — the script wrote it. What IS proven deterministically is
 * everything around it: the code did not travel, the contract did, the refs were
 * revalidated, generation happened before deploy, and the same recipe scores
 * differently against two tenants' queries.
 *
 * `--live` routes generation through a real model instead, which additionally exercises
 * a real model producing that fragment from the travelled contract. It is slower
 * and it can legitimately fail on a bad generation; the deterministic default is
 * what belongs in a regression net.
 */
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { HR_GENERATED_QUERIES } from "../demo/hr-generated.js";
import type { NamedQuerySpec } from "../services/datasource-query.service.js";
import { config } from "../config/index.js";
import { kestra, KestraError, type KestraExecution } from "../services/kestra-client.service.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { datasourceQueryRepo } from "../repositories/datasource-query.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { flowService } from "../services/flow.service.js";
import { flowTemplateService } from "../services/flow-template.service.js";
import { flowReplayService } from "../services/flow-replay.service.js";
import { fragmentPromotionService } from "../services/fragment-promotion.service.js";
import {
  exportFlow,
  planImport,
  importFlow,
  type FlowBundle,
} from "../services/flow-portability.service.js";
import { generateFragments } from "../services/flow-generation.service.js";
import { inference, type InferenceClient } from "../services/inference.service.js";
import { tenantMapper } from "../services/tenant-mapper.service.js";
import { ALT_SCREENING_QUERIES } from "./alt-screening.queries.js";
import { PORTABLE_SCREENING_MODEL, PORTABLE_RANK_CONTRACT } from "./hr-screening-portable.model.js";
import { expectedScreening } from "../demo/hr-dataset.js";
import { altExpectedScreening } from "../demo/alt/alt-dataset.js";
import { ALT_WORKSPACE_NAME } from "../demo/alt/provision-alt.js";
import { ALT_PERIOD } from "../demo/alt/alt-dataset.js";
import { countToolCalls, opsClient, opsServiceKey } from "../services/ops-client.service.js";
import { systemAuthor } from "../services/revision-author.js";

const LIVE = process.argv.includes("--live");
const PERIOD =
  process.argv.find((a) => a.startsWith("--period="))?.slice("--period=".length) ?? "2026-06";
const AUTHOR = systemAuthor("author@acme-hr.example");

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
  const pass = String(got) === String(want);
  if (!pass) failures++;
  console.log(
    `  ${pass ? c.ok("PASS") : c.bad("FAIL")}  ${label.padEnd(60)} ` +
      (pass ? c.dim(String(want)) : c.bad(`\n        got  ${got}\n        want ${want}`)),
  );
}

/** Assert something is REFUSED, and that the refusal says something useful. */
async function refuses(label: string, fn: () => Promise<unknown>, statusCode: number, match: RegExp) {
  try {
    await fn();
    failures++;
    console.log(`  ${c.bad("FAIL")}  ${label.padEnd(60)} ${c.bad("it was ALLOWED")}`);
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    const msg = (e as Error).message;
    const pass = code === statusCode && match.test(msg);
    if (!pass) failures++;
    console.log(
      `  ${pass ? c.ok("PASS") : c.bad("FAIL")}  ${label.padEnd(60)} ` +
        (pass ? c.dim(String(code)) : c.bad(`got ${code} "${msg}"`)),
    );
  }
}

const SETTLED = ["SUCCESS", "FAILED", "KILLED", "WARNING"];
/**
 * Wait for an execution to settle.
 *
 * ⚠ On TIMEOUT this returns the last state it saw, and it now SAYS SO. It used
 * to return silently, which is the degrade-quietly shape this repo keeps finding
 * (I-12's lesson: a catch around a remote call must log what it degraded from,
 * or the failure presents as "the field is just null sometimes"). The symptom
 * here was worse than null — every assertion downstream runs against a
 * still-running execution, so a slow engine reads as a wrong answer. It cost one
 * intermittent FAIL on the replay-boundary check during a full-net run, green on
 * re-run, with nothing in the output pointing at timing.
 */
async function waitFor(executionId: string, timeoutMs = 240_000): Promise<KestraExecution> {
  const deadline = Date.now() + timeoutMs;
  let ex = await kestra.getExecution(executionId);
  while (Date.now() < deadline) {
    if (SETTLED.includes(ex.state.current)) return ex;
    await new Promise((r) => setTimeout(r, 1200));
    ex = await kestra.getExecution(executionId);
  }
  console.log(
    c.bad(
      `  ⚠ TIMEOUT  execution ${executionId} was still ${ex.state.current} after ${timeoutMs}ms.\n` +
        "             Every assertion below it is now racing a live run — read them as unknown,\n" +
        "             not as answers. A busy engine is the usual cause; run the harnesses one at a time.",
    ),
  );
  return ex;
}

function taskOutputs(ex: KestraExecution, taskId: string): Record<string, unknown> {
  return (ex.taskRunList ?? []).find((t) => t.taskId === taskId)?.outputs ?? {};
}
function fragmentResult(ex: KestraExecution, taskId: string): Record<string, unknown> | undefined {
  return (taskOutputs(ex, taskId).vars as Record<string, unknown> | undefined)?.result as
    | Record<string, unknown>
    | undefined;
}
function taskState(ex: KestraExecution, taskId: string): string {
  return (ex.taskRunList ?? []).find((t) => t.taskId === taskId)?.state.current ?? "ABSENT";
}
/**
 * How many pointer rows a step wrote under a given Foundry execution row.
 *
 * ── This is the discriminator, and finding it took two wrong attempts (I-19) ──
 *
 * The question a replay raises is *"did this step run again, or was its result
 * reused?"*, and **neither of the obvious signals answers it.**
 *
 *   task STATE      a copied taskrun carries its state, so `begin` and `screen`
 *                   both read SUCCESS in a replay that executed neither.
 *   taskrun ID      the engine mints fresh ids for the copied taskruns too, so
 *                   "the id changed" is true for every task and means nothing.
 *
 * What does answer it is the side effect on FOUNDRY. A `tool` or `datasource`
 * step can only run by calling back into `/api/steps/*`, and every such call
 * writes a `flow_step_runs` row keyed on its taskrun. One row → it did not run
 * again. Two → it did.
 */
/** The pointer rows themselves, so a failure can name the taskruns it saw. */
async function pointerRows(
  flowExecutionId: string,
  stepId: string,
): Promise<Array<{ kestra_taskrun_id: string | null }>> {
  const r = await db.execute<{ kestra_taskrun_id: string | null }>(sql`
    SELECT kestra_taskrun_id FROM flow_step_runs
    WHERE flow_execution_id = ${flowExecutionId} AND step_id = ${stepId}`);
  return r.rows as Array<{ kestra_taskrun_id: string | null }>;
}

async function pointerRowCount(flowExecutionId: string, stepId: string): Promise<number> {
  const r = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM flow_step_runs
    WHERE flow_execution_id = ${flowExecutionId} AND step_id = ${stepId}`);
  return Number((r.rows[0] as { n: string }).n);
}
/**
 * Execution credentials minted for a row. `begin` is the only thing that mints
 * one, so **zero means `begin` did not execute** — which is the single fact every
 * guard in `flow-replay.service.ts` follows from.
 */
async function tokenCount(flowExecutionId: string): Promise<number> {
  const r = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM execution_tokens WHERE flow_execution_id = ${flowExecutionId}`);
  return Number((r.rows[0] as { n: string }).n);
}
/**
 * The largest shortfall below the applicable minimum, or **0 for an empty set**.
 *
 * `Math.max(...[])` is `-Infinity`, not 0, and the HR dataset legitimately flags
 * nobody outside its reporting month — so the naive spread produced an expectation
 * of `-Infinity` and a harness failure that looked like a flow bug (I-19).
 */
function worstShortfall(flagged: Array<{ threshold: number; rate: number }>): number {
  return flagged.length ? Math.max(...flagged.map((f) => f.threshold - f.rate)) : 0;
}
function stepRows<T>(ex: KestraExecution, taskId: string): T[] {
  const raw = taskOutputs(ex, taskId).body;
  if (typeof raw !== "string") return [];
  try {
    return ((JSON.parse(raw) as { results?: Array<{ data?: T[] }> }).results?.[0]?.data ?? []) as T[];
  } catch {
    return [];
  }
}

// ── The scripted generator ───────────────────────────────────────────────────

/**
 * A fragment satisfying `PORTABLE_RANK_CONTRACT`, written ONCE and reused for
 * both imports.
 *
 * It is **unit-agnostic on purpose**, and that is what makes the negative control
 * work. It does not know or assume a scale; it subtracts the two fields it was
 * given. So the same fragment returns 22.5 against percentages and 0.225 against
 * fractions, and the difference is entirely attributable to the importing
 * tenant's query rather than to anything the fragment did.
 *
 * A fragment that "helpfully" normalised would hide the very thing being
 * measured.
 */
const SCRIPTED_FRAGMENT = [
  "def run(payload):",
  "    rows = payload['rows']",
  "    worst = 0.0",
  "    for r in rows:",
  "        gap = float(r['min_attendance_rate']) - float(r['attendance_rate'])",
  "        if gap > worst:",
  "            worst = gap",
  "    return {'flagged_count': len(rows), 'worst_shortfall': round(worst, 4)}",
].join("\n");

class ScriptedInference implements InferenceClient {
  readonly prompts: string[] = [];
  async complete(prompt: string, opts: { label: string }): Promise<string> {
    this.prompts.push(prompt);
    if (!opts.label.startsWith("fragment:")) {
      throw new Error(`the phase-6 harness never drafts a flow; unexpected call "${opts.label}"`);
    }
    return JSON.stringify({ status: "ok", code: SCRIPTED_FRAGMENT });
  }
}

async function generator(): Promise<{ client: InferenceClient; scripted: ScriptedInference | null }> {
  if (LIVE) return { client: inference, scripted: null };
  const scripted = new ScriptedInference();
  return { client: scripted, scripted };
}

async function upsertQueries(workspaceId: string, dsName: string, specs: NamedQuerySpec[]) {
  const ds = (await datasourceRepo.listByWorkspace(workspaceId)).find((d) => d.name === dsName);
  if (!ds) throw new Error(`datasource "${dsName}" not found in workspace ${workspaceId}`);
  for (const q of specs) {
    await datasourceQueryRepo.upsertByName({
      datasourceId: ds.id,
      name: q.name,
      description: q.description,
      sqlText: q.sqlText,
      paramOrder: q.paramOrder,
      paramsSchema: q.paramsSchema,
    });
  }
  return ds;
}

async function dropFlow(workspaceId: string, kestraFlowId: string) {
  const stale = await flowRepo.getByKestraFlowId(workspaceId, kestraFlowId);
  if (stale) await flowService.remove(workspaceId, stale.id);
}

/** Clear ops-api's four capture tables. Throws if the service is unreachable. */
async function truncateStubs() {
  await opsClient.reset();
}

/**
 * Import the bundle into the alt tenant, run it, and report what the `rank`
 * fragment computed. One function for both arms, so the negative and positive
 * runs differ ONLY in the ref they are pointed at.
 */
async function importRunAndScore(
  altWsId: string,
  bundle: FlowBundle,
  opts: { modelId: string; localRef: string; client: InferenceClient },
): Promise<{ findings: number; shortfall: number | null; flagged: number | null; state: string }> {
  await dropFlow(altWsId, opts.modelId);

  const plan = await planImport(altWsId, { ...bundle, model: { ...bundle.model, id: opts.modelId } }, {
    "hr_demo.attendance_below_threshold": opts.localRef,
  });
  const blocking = plan.findings.filter((f) => f.blocking).length;

  const result = await importFlow(
    altWsId,
    bundle,
    {
      modelId: opts.modelId,
      refMap: { "hr_demo.attendance_below_threshold": opts.localRef },
      name: `imported (${opts.localRef})`,
      author: AUTHOR,
    },
    opts.client,
  );
  if (result.status !== "ok" || !result.flow) {
    return { findings: blocking, shortfall: null, flagged: null, state: result.status };
  }

  await truncateStubs();
  const run = await flowService.testRun(altWsId, result.flow.id, { period: ALT_PERIOD });
  const ex = await waitFor(run.kestraExecutionId);
  const fragment = fragmentResult(ex, "rank");
  return {
    findings: blocking,
    shortfall: fragment?.worst_shortfall == null ? null : Number(fragment.worst_shortfall),
    flagged: fragment?.flagged_count == null ? null : Number(fragment.flagged_count),
    state: ex.state.current,
  };
}

async function main() {
  console.log(`\nPhase 6 — replay and sharing\n${"═".repeat(72)}`);

  const all = await workspaceRepo.list();
  const hr = all.find((w) => w.name === "HR");
  if (!hr) throw new Error('workspace "HR" not found — run `pnpm demo:seed` first');
  const alt = all.find((w) => w.name === ALT_WORKSPACE_NAME);
  if (!alt) throw new Error(`workspace "${ALT_WORKSPACE_NAME}" not found — run \`pnpm demo:seed-alt\` first`);

  const health = await kestra.health();
  if (!health.reachable) throw new Error(`Kestra unreachable at ${health.baseUrl}: ${health.detail}`);
  if (!health.authenticated) throw new Error(`Kestra rejected KESTRA_AUTH: ${health.detail}`);
  if (!config.kestra.callbackSecret) {
    throw new Error("KESTRA_CALLBACK_SECRET is unset — POST /api/executions/begin refuses everything");
  }

  const hrNs = tenantMapper.namespacesFor(hr);
  const altNs = tenantMapper.namespacesFor(alt);
  console.log(`origin      HR              ${c.dim(hrNs.draft.value)}`);
  console.log(`destination ${ALT_WORKSPACE_NAME}  ${c.dim(altNs.draft.value)}`);
  console.log(`generation  ${LIVE ? c.bad("LIVE") : c.dim("scripted — see the header")}`);
  console.log(`periods     ${c.dim(`origin ${PERIOD} · alt ${ALT_PERIOD}`)}`);
  console.log(`kestra      ${c.dim(`${health.edition} ${health.version} @ ${health.baseUrl}`)}\n`);

  await upsertQueries(hr.id, "hr_demo", [...HR_GENERATED_QUERIES.filter((q) => q.name !== "flagged_unreachable" && q.name !== "department_attendance_rollup")]);
  await upsertQueries(alt.id, "hr_demo_alt", ALT_SCREENING_QUERIES);
  if (!(await toolRepo.getByName(hr.id, "mail_send"))) throw new Error('tool "mail_send" missing in HR');
  if (!(await toolRepo.getByName(alt.id, "mail_send"))) {
    throw new Error(`tool "mail_send" missing in ${ALT_WORKSPACE_NAME}`);
  }

  const { client, scripted } = await generator();

  // ── The origin flow. Created through GENERATION, not hand-written ──────────
  console.log(`${"─".repeat(72)}\nP0  the origin flow is GENERATED, so there is a first fitting to refit\n`);

  await dropFlow(hr.id, PORTABLE_SCREENING_MODEL.id);
  const generated = await generateFragments(
    {
      model: PORTABLE_SCREENING_MODEL,
      contracts: { rank: { stepId: "rank", ...PORTABLE_RANK_CONTRACT } },
    },
    client,
  );
  check("one code step → one inference call", generated.inferenceCalls, 1);
  check("no refusal against a sufficient contract", generated.refusals.length, 0);

  const origin = await flowService.create(
    hr.id,
    { name: "HR screening (portable)", model: generated.model, author: AUTHOR },
    generated.contracts,
  );
  await truncateStubs();
  const originRun = await flowService.testRun(hr.id, origin.flow.id, { period: PERIOD });
  const originEx = await waitFor(originRun.kestraExecutionId);
  check("origin run state", originEx.state.current, "SUCCESS");

  const hrOracle = expectedScreening(PERIOD);
  const originRows = stepRows<{ employee_id: number }>(originEx, "screen");
  check(
    "origin flagged employees match the HR oracle",
    originRows.map((r) => Number(r.employee_id)).sort((a, b) => a - b).join(","),
    hrOracle.flagged.map((f) => f.id).sort((a, b) => a - b).join(","),
  );
  const originFragment = fragmentResult(originEx, "rank");
  check("origin flagged_count", originFragment?.flagged_count, hrOracle.flagged.length);
  check(
    "origin worst_shortfall matches the HR oracle (percentage points)",
    Number(originFragment?.worst_shortfall).toFixed(2),
    worstShortfall(hrOracle.flagged).toFixed(2),
  );
  /**
   * **The HR dataset flags nobody at 2026-04 or 2026-05** — its traps are tuned to
   * the reporting month, 2026-06. So running at a second period exercises the
   * EMPTY case, and that is worth an assertion rather than a patched expectation:
   * `max()` over an empty sequence raises in Python, and a fragment that does not
   * seed its accumulator fails on exactly the period where there is nothing to
   * report. A run that flagged nobody must say 0, not crash.
   *
   * The first version of this harness computed `Math.max(...[])` and asserted
   * against `-Infinity`, which is the same mistake in TypeScript.
   */
  if (hrOracle.flagged.length === 0) {
    check("…and a period with NOTHING to report says 0 rather than failing", originFragment?.worst_shortfall, 0);
    check("…the run still succeeded", originEx.state.current, "SUCCESS");
  }

  // ── 6.2 export ────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(72)}\n6.2  export — the CONTRACT travels, the code does not\n`);

  const bundle = await exportFlow(hr.id, origin.flow.id, { workspaceName: hr.name });
  const serialised = JSON.stringify(bundle);
  check("bundle contains no generated fragment", serialised.includes("def run("), false);
  check("bundle contains no Kestra task type (R8)", serialised.includes("io.kestra"), false);
  check("bundle carries the code step's contract", bundle.model.steps.some((s) => s.kind === "code"), true);
  check(
    "…and its declared units, the only place a recipe can state them",
    serialised.includes("PERCENTAGES in 0-100"),
    true,
  );
  // ⚠ This assertion used to be `bundle.secretNames.join(",") === ""`, and it
  // passed for the wrong reason: the reference flow's tools were keyless before
  // Stage 5, so "names only, never values" was proved by an empty list. A bundle
  // that leaked every secret VALUE would have passed it just as happily on a
  // flow with no secrets.
  //
  // Now `mail_send` carries `MAIL_API_KEY`, so the list is non-empty and the
  // property is checkable: the NAME travels (an importing tenant has to know
  // what to provide) and the VALUE does not. The value is derived, so the
  // harness can compute exactly what must be absent and look for it.
  check("secret NAMES travel", bundle.secretNames.includes("MAIL_API_KEY"), true);
  check(
    "…and secret VALUES do not, anywhere in the bundle",
    serialised.includes(opsServiceKey("mail")),
    false,
  );
  check("refs recorded with their call signature", bundle.refs.length, 2);
  check(
    "the origin query's SQL is NOT recorded — it is what must differ per tenant",
    serialised.includes("attendance_monthly"),
    false,
  );

  // ── 6.3 import: refused before it is allowed ───────────────────────────────
  console.log(`\n${"─".repeat(72)}\n6.3  import — revalidated against the IMPORTING tenant\n`);

  const noMap = await planImport(alt.id, bundle);
  check("without a refMap the import is REFUSED", noMap.findings.some((f) => f.blocking), true);
  check(
    "…naming the ref",
    noMap.findings.find((f) => f.code === "unknown_ref")?.ref,
    "hr_demo.attendance_below_threshold",
  );
  check(
    "…and listing what this workspace does have",
    noMap.findings.find((f) => f.code === "unknown_ref")?.message.includes("presence_below_policy"),
    true,
  );
  check("nothing is guessed from the similar name", noMap.remapped.length, 0);

  await refuses(
    "a hand-written code step cannot be exported at all",
    async () => {
      const handId = "phase6-handwritten";
      await dropFlow(hr.id, handId);
      const f = await flowService.create(hr.id, {
        name: "phase6 hand-written",
        author: AUTHOR,
        model: {
          id: handId,
          steps: [
            {
              id: "compute",
              kind: "code",
              code: "def run(payload):\n    return {'x': 1}",
              inputExpr: "{}",
              outputKeys: ["x"],
            },
          ],
        },
      });
      try {
        return await exportFlow(hr.id, f.flow.id);
      } finally {
        await flowService.remove(hr.id, f.flow.id);
      }
    },
    409,
    /no stored contract/,
  );

  // ── THE EXIT CRITERION, with its control ──────────────────────────────────
  console.log(
    `\n${"─".repeat(72)}\nEXIT  the same recipe, two tenant queries  ` +
      c.dim("(the 0-100 vs 0-1 difference is the test)") +
      `\n`,
  );

  const altOracle = altExpectedScreening(ALT_PERIOD);
  // The oracle's rates are FRACTIONS. Percentage points is what the contract asks
  // for, so the expectation is scaled here — in the harness, deliberately, rather
  // than by asking the oracle to speak the flow's units.
  const altWorstPct = worstShortfall(altOracle.flagged) * 100;

  const negative = await importRunAndScore(alt.id, bundle, {
    modelId: "hr-screening-portable-raw",
    localRef: "hr_demo_alt.presence_below_policy_raw",
    client,
  });
  console.log(`  ${c.dim("NEGATIVE CONTROL — the alt's native 0-1 fractions")}`);
  check("imports with ZERO blocking findings", negative.findings, 0);
  check("…and runs green", negative.state, "SUCCESS");
  check("…flagged_count is still right — a count does not scale away", negative.flagged, altOracle.flagged.length);
  check(
    "…but worst_shortfall is WRONG, and plausible",
    negative.shortfall != null && Math.abs(negative.shortfall - altWorstPct) > 1,
    true,
  );
  console.log(
    `        ${c.dim(`reported ${negative.shortfall} · truth ${altWorstPct.toFixed(2)} — no error, no empty result`)}`,
  );

  const positive = await importRunAndScore(alt.id, bundle, {
    modelId: "hr-screening-portable-alt",
    localRef: "hr_demo_alt.presence_below_policy",
    client,
  });
  console.log(`\n  ${c.dim("POSITIVE — the same query, rates converted to the contract's units")}`);
  check("imports with ZERO blocking findings", positive.findings, 0);
  check("…and runs green", positive.state, "SUCCESS");
  check("…flagged_count matches the ALT oracle", positive.flagged, altOracle.flagged.length);
  check(
    "…and worst_shortfall matches the ALT oracle",
    Number(positive.shortfall).toFixed(2),
    altWorstPct.toFixed(2),
  );

  // The two arms were structurally indistinguishable. That is the finding.
  check(
    "both arms imported identically — the check could not tell them apart",
    negative.findings === positive.findings && negative.state === positive.state,
    true,
  );
  check(
    "…and the ALT answer differs from the ORIGIN answer, so nothing was cached",
    Number(positive.shortfall).toFixed(2) !== Number(originFragment?.worst_shortfall).toFixed(2),
    true,
  );

  const altFlow = await flowRepo.getByKestraFlowId(alt.id, "hr-screening-portable-alt");
  check("an imported flow arrives UNARMED", altFlow?.armedRevision, null);
  check("…as revision 1", altFlow?.draftRevision, 1);
  check("…with no approval", (await flowRepo.listApprovals(altFlow!.id)).length, 0);
  const altSteps = await flowRepo.listSteps(altFlow!.id, 1);
  const rankStep = altSteps.find((s) => s.stepId === "rank");
  check("the imported code step carries its contract, so it can be regenerated", !!rankStep?.contractJson, true);
  check(
    "the imported fragment is NOT the placeholder — generation ran before deploy",
    (rankStep?.configJson as { code?: string })?.code !== "needs_regeneration",
    true,
  );

  if (scripted) {
    // Assertion 18 still holds on the import path: the fragment's prompt is its
    // contract and nothing else. Checked here because import is a NEW caller of
    // `generateFragments` and a new caller is where an extra "helpful" block gets
    // added.
    const leaks = ["hr_demo", "presence_below_policy", "mail_send", "paramsExpr", "attendance_monthly"];
    const leaked = leaks.filter((n) => scripted.prompts.some((p) => p.includes(n)));
    check("no fragment prompt named a tenant ref, schema or sibling", leaked.join(",") || "none", "none");
  }

  // ── 6.4 templates ─────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(72)}\n6.4  the template library — a snapshot, instantiated as an import\n`);

  for (const t of await flowTemplateService.list(hr.id)) {
    if (t.name === "phase6 screening") await flowTemplateService.remove(hr.id, t.id);
  }
  const template = await flowTemplateService.saveFromFlow(hr.id, origin.flow.id, {
    name: "phase6 screening",
    createdBy: AUTHOR.createdBy,
  });
  check("template stores a bundle, not a flow reference", !!(template.bundleJson as FlowBundle).model, true);
  check("…snapshotting a specific revision", template.sourceRevision, 1);
  check(
    "the snapshot contains no generated code either",
    JSON.stringify(template.bundleJson).includes("def run("),
    false,
  );
  await refuses(
    "a second template of the same name is refused, never silently replaced",
    () => flowTemplateService.saveFromFlow(hr.id, origin.flow.id, { name: "phase6 screening" }),
    409,
    /already exists/,
  );

  // Editing the source flow must not change the template.
  const digest = (v: unknown) =>
    crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
  const before = digest(template.bundleJson);
  await flowService.saveRevision(
    hr.id,
    origin.flow.id,
    {
      model: { ...generated.model, inputs: [{ id: "period", type: "STRING", defaults: PERIOD }] },
      author: AUTHOR,
    },
    generated.contracts,
  );
  const after = await flowTemplateService.get(hr.id, template.id);
  check("editing the source flow leaves the template untouched", digest(after.bundleJson), before);

  // ── An edit that is not about a `code` step must not disarm one (Stage 7.3) ─
  //
  // The edit above passes `contracts` explicitly, which is what `regenerateStep`
  // does and NOT what `POST /:flowId/revisions` does — the route passed none, so
  // the first edit through it dropped every stored contract and left the
  // fragments permanently un-regenerable. `regenerateStep` then refuses the step
  // by name, correctly and unhelpfully, and nothing else in the product would
  // have said anything was wrong.
  //
  // Stage 7 made `saveRevision` inherit them, so this call deliberately mirrors
  // the ROUTE: same edit, no contracts argument.
  const codeStepId = generated.model.steps.find((s) => s.kind === "code")?.id;
  const edited = await flowService.saveRevision(hr.id, origin.flow.id, {
    model: { ...generated.model, inputs: [{ id: "period", type: "STRING", defaults: PERIOD }] },
    author: AUTHOR,
  });
  const carried = await flowService.contractsFor(origin.flow.id, edited.revision.revision);
  check(
    "an edit that passes no contracts INHERITS them, so a code step stays regenerable",
    !!(codeStepId && carried[codeStepId]?.purpose),
    true,
  );

  // ── 6.5 the graduation loop ───────────────────────────────────────────────
  console.log(`\n${"─".repeat(72)}\n6.5  fragment promotion — the same contract in two flows\n`);

  const candidates = await fragmentPromotionService.promotionCandidates(alt.id);
  const rankCandidate = candidates.find((k) => k.occurrences.some((o) => o.stepId === "rank"));
  check("the recurring code step is surfaced", !!rankCandidate, true);
  check("…counted across both imported flows", rankCandidate?.flowCount, 2);
  if (LIVE) {
    /**
     * `distinctBodies` is REPORTED here, not asserted, and the reason is a
     * measurement that changed twice in one afternoon.
     *
     * `distinctBodies: 1` is promotion's strong signal — the same contract in
     * several flows with one implementation between them. Under the scripted
     * generator it is true by construction (every call returns the same canned
     * fragment), so asserting it there proves nothing about a real workspace.
     *
     * Under live generation the answer depends on the TRANSPORT, which is not
     * something a promotion heuristic should be sensitive to but is:
     *
     *   through a live model  distinctBodies = 2. A real generation is nondeterministic and
     *                        its `finalMessage` varies, so two generations of a
     *                        byte-identical prompt came back textually different.
     *   through the gateway  distinctBodies = 1. One completion at temperature 0
     *                        against an identical prompt reproduces the fragment.
     *
     * ⚠ Neither is a guarantee. Temperature 0 is a bias toward the same answer,
     * not a promise of one — batching, quantisation and provider routing all move
     * it, and D-23's no-shared-session rule means fragment B is generated with no
     * knowledge of fragment A by design. So the durable signal is the WEAKER one:
     * the same contract interface recurring across distinct flows with
     * `shapeOnly: false`. Asserting `distinctBodies === 1` here would make the
     * harness red on a day the gateway routed differently, which is the kind of
     * flake that gets a real check deleted.
     */
    check("…recurring under LIVE generation too", (rankCandidate?.flowCount ?? 0) >= 2, true);
    console.log(
      c.dim(
        `  NOTE  distinctBodies = ${rankCandidate?.distinctBodies} under live generation.\n` +
          `        1 means the transport reproduced the fragment (a temperature-0 completion\n` +
          `        does; an agent run does not). It is a bias, not a guarantee — the durable\n` +
          `        signal is the recurring contract interface, not byte equality.`,
      ),
    );
  } else {
    check(
      "…and reported as ONE implementation, which is the strong signal",
      rankCandidate?.distinctBodies,
      1,
    );
  }
  check("…not labelled shape-only, because the purposes agree", rankCandidate?.shapeOnly, false);

  // ── 6.1 replay ────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(72)}\n6.1  replay — and the four things a partial replay skips\n`);

  const originExecRow = await flowExecutionRepo.getByKestraId(originEx.id);
  if (!originExecRow) throw new Error("no flow_executions row for the origin run");

  await refuses(
    "another workspace cannot replay this execution",
    () => flowReplayService.replay(alt.id, originExecRow.id),
    404,
    /not found/,
  );
  await refuses(
    "…and an unknown id gives the SAME answer, so it cannot be probed",
    () => flowReplayService.replay(alt.id, "00000000-0000-0000-0000-000000000000"),
    404,
    /not found/,
  );

  const okPlan = await flowReplayService.replayPlan(hr.id, originExecRow.id);
  check("the plan is offered for a settled run", okPlan.replayable, true);
  check("…listing the model's steps", okPlan.steps.map((s) => s.stepId).sort().join(","), "notify,rank,screen");
  check(
    "…and never a compiler-emitted task (begin/complete are not steps)",
    okPlan.steps.some((s) => ["begin", "complete"].includes(s.stepId)),
    false,
  );
  /**
   * A run that SUCCEEDED cannot be partially replayed, permanently — `complete`
   * burns its execution credential on the way out, and a partial replay reuses
   * that credential rather than re-running `begin`.
   *
   * This was found by running the harness, not by reading the code: the first
   * version tried to resume a successful run and the refusal fired. It is correct
   * behaviour, so it is asserted rather than worked around — and the message has
   * to distinguish "this run completed" from "the credential expired", because the
   * second reads as a defect when it is the design.
   */
  check(
    "a SUCCEEDED run cannot be resumed mid-way, and says why",
    okPlan.steps.every((s) => !s.replayable && /completed, and completing closes/.test(s.reason ?? "")),
    true,
  );

  // ── The §6.3 case: a run that FAILED partway ──────────────────────────────
  //
  // §6.3's whole scenario is a step exhausting its retries and the operator
  // resuming from there. A failed execution never reaches `complete`, so its
  // credential is still live — which is exactly why partial replay is useful for
  // a failure and refused for a success.
  const brokenId = "phase6-replay-broken";
  await dropFlow(hr.id, brokenId);
  const broken = await flowService.create(hr.id, {
    name: "phase6 replay (deliberately broken)",
    model: {
      id: brokenId,
      inputs: [{ id: "period", type: "STRING", required: true }],
      steps: [
        {
          id: "screen",
          kind: "datasource",
          ref: "hr_demo.attendance_below_threshold",
          paramsExpr: '[{ "period": "{{ inputs.period }}" }]',
        },
        {
          id: "rank",
          kind: "code",
          code: SCRIPTED_FRAGMENT,
          inputExpr: '{"rows": {{ json(outputs.screen.body).results[0].data }}}',
          outputKeys: ["flagged_count", "worst_shortfall"],
          dependsOn: ["screen"],
        },
        {
          // Fails at the stub with a 422: the same deliberate break Phase 2's exit
          // criterion used. It is the LAST step, so `screen` and `rank` both
          // succeed and there is genuinely something to rehydrate.
          id: "notify",
          kind: "tool",
          ref: "mail_send",
          paramsExpr:
            '[{ "sender": "hr-bot@acme-hr.example", "recipients": ["not-an-email"], ' +
            '"subject": "phase6", "body": "phase6" }]',
          dependsOn: ["rank"],
          timeoutSeconds: 60,
        },
      ],
    },
    author: AUTHOR,
  });
  await truncateStubs();
  const brokenRun = await flowService.testRun(hr.id, broken.flow.id, { period: PERIOD });
  const brokenEx = await waitFor(brokenRun.kestraExecutionId);
  check("the broken run FAILED, as intended", brokenEx.state.current, "FAILED");
  check("…at notify", taskState(brokenEx, "notify"), "FAILED");
  check("…having got through screen and rank", taskState(brokenEx, "rank"), "SUCCESS");

  const brokenRow = await flowExecutionRepo.getByKestraId(brokenEx.id);
  if (!brokenRow) throw new Error("no flow_executions row for the broken run");
  check(
    "a FAILED run still holds its credential, so it CAN be resumed",
    (await flowReplayService.replayPlan(hr.id, brokenRow.id)).steps.find((s) => s.stepId === "rank")
      ?.replayable,
    true,
  );

  const partial = await flowReplayService.replay(hr.id, brokenRow.id, { fromStepId: "rank" });
  check("a partial replay records its lineage", partial.lineageRecorded, true);
  check("…as a replay of the original", partial.execution?.replayOfId, brokenRow.id);
  check("…naming the step, not a Kestra taskrun id", partial.execution?.replayFromStep, "rank");

  const replayEx = await waitFor(partial.execution!.kestraExecutionId);

  // ── Rehydrated vs re-executed, measured by the side effect on Foundry ─────
  //
  // See `pointerRowCount` for why neither task state nor taskrun id can answer
  // this. A `datasource` step runs only by calling back into Foundry, so its
  // pointer-row count is the observation.
  check(
    "`screen` was REHYDRATED — it never called Foundry a second time",
    await pointerRowCount(brokenRow.id, "screen"),
    1,
  );
  // Reported with the evidence, not just the count. When this fails it is
  // either a real replay-boundary regression or a race with a slow engine, and
  // the two look identical from a bare "got 1, want 2" — which is exactly what
  // happened once, and cost a re-run to distinguish.
  const notifyRuns = await pointerRows(brokenRow.id, "notify");
  if (notifyRuns.length !== 2) {
    console.log(
      c.dim(
        `        replay execution ${replayEx.id} is ${replayEx.state.current}; ` +
          `notify taskruns seen: ${notifyRuns.map((r) => r.kestra_taskrun_id ?? "null").join(", ") || "none"}`,
      ),
    );
  }
  check(
    "…while `notify`, downstream of the replay point, genuinely re-ran",
    notifyRuns.length,
    2,
  );
  check(
    "…so the replay boundary is where it was asked to be",
    (await pointerRowCount(brokenRow.id, "screen")) === 1 &&
      (await pointerRowCount(brokenRow.id, "notify")) === 2,
    true,
  );
  check(
    "…and `rank` recomputed the same answer from the rehydrated rows",
    Number(fragmentResult(replayEx, "rank")?.worst_shortfall).toFixed(2),
    Number(originFragment?.worst_shortfall).toFixed(2),
  );
  // `succeededOnly: false`, and that is not a loosening. The broken run mails
  // `not-an-email` on purpose, so every one of these calls is a 422 — the
  // question this assertion asks is whether the request CROSSED THE WIRE a
  // second time or the replay served a cached response. Counting only 2xx would
  // report 0 and fail a correct replay.
  const mailCalls = await countToolCalls("mail_send", { succeededOnly: false });
  check(
    "…reaching the real tool endpoint again, not a cached response",
    mailCalls >= 2,
    true,
  );

  /**
   * **The measurement every guard in `flow-replay.service.ts` rests on.**
   *
   * `begin` is task 1: it mints the execution credential, applies the approval
   * gate and creates the Foundry row. A partial replay does not execute it — its
   * taskrun is copied like any other upstream step. So the replay row has ZERO
   * credentials of its own, the replayed steps run on the ORIGINAL one, and
   * Foundry gets no second opportunity to check anything.
   *
   * Which is why Foundry re-applies the gate, charges the budget and writes the
   * row itself, and refuses outright where it cannot compensate.
   */
  check(
    "`begin` did NOT execute — the replay row has no credential of its own",
    await tokenCount(partial.execution!.id),
    0,
  );
  check(
    "…while the original still has the one the replayed steps used",
    (await tokenCount(brokenRow.id)) >= 1,
    true,
  );

  /**
   * I-18, asserted rather than left as prose. The rehydrated credential names the
   * ORIGINAL execution, so a replayed step's pointer row lands under the original
   * row — visible in the `notify` count above being 2 rather than the replay row
   * having one of its own. Harmless for display, because the step view is
   * assembled from the engine by the replay's own execution id; the one path where
   * it is not harmless — agent resume — is refused below. Locked in so a change is
   * noticed.
   */
  check(
    "a replayed step writes NO pointer row under the replay's own id (I-18)",
    await pointerRowCount(partial.execution!.id, "notify"),
    0,
  );

  await flowService.remove(hr.id, broken.flow.id);

  // An execution the engine has purged is GONE, not missing — and the message
  // names the retention window rather than saying "not found" about a row the
  // client can see in its own history.
  const ghost = await flowExecutionRepo.create({
    workspaceId: hr.id,
    flowId: origin.flow.id,
    flowRevision: 1,
    kestraNamespace: hrNs.draft.value,
    kestraFlowId: PORTABLE_SCREENING_MODEL.id,
    kestraExecutionId: `phase6-purged-${crypto.randomUUID()}`,
    status: "failed",
  });
  await refuses(
    "a purged execution is 410 GONE, naming the retention window",
    () => flowReplayService.replay(hr.id, ghost.id),
    410,
    new RegExp(`retained for ${config.kestra.retentionDays} days`),
  );

  // ── A partial replay reaching an agent step would hang (I-18) ─────────────
  //
  // A real flow and a real failed execution, not a fabricated row: the guard reads
  // the revision's MODEL to find the agent step, so a fixture that only had a
  // `flow_executions` row would exercise the "no model" branch instead and pass
  // for the wrong reason. `boom` fails first, so the agent step never starts —
  // which is precisely the state from which someone would want to resume.
  const agentModelId = "phase6-agent-replay";
  await dropFlow(hr.id, agentModelId);
  const agentFlow = await flowService.create(hr.id, {
    name: "phase6 agent replay",
    model: {
      id: agentModelId,
      steps: [
        {
          id: "boom",
          kind: "tool",
          ref: "mail_send",
          paramsExpr:
            '[{ "sender": "hr-bot@acme-hr.example", "recipients": ["not-an-email"], ' +
            '"subject": "phase6", "body": "phase6" }]',
          timeoutSeconds: 60,
        },
        {
          id: "summarise",
          kind: "approval",
          summaryExpr: '"the send failed — proceed?"',
          dependsOn: ["boom"],
        },
      ],
    },
    author: AUTHOR,
  });
  const agentRun = await flowService.testRun(hr.id, agentFlow.flow.id, {});
  const agentEx = await waitFor(agentRun.kestraExecutionId);
  check("the agent-flow run failed before reaching the agent step", taskState(agentEx, "boom"), "FAILED");
  check("…so the agent step never started", taskState(agentEx, "summarise"), "ABSENT");

  const agentRow = await flowExecutionRepo.getByKestraId(agentEx.id);
  await refuses(
    "a partial replay reaching an agent step is REFUSED, not left to hang",
    () => flowReplayService.replay(hr.id, agentRow!.id, { fromStepId: "boom" }),
    409,
    /cannot be resumed/,
  );
  check(
    "…and the plan says so per step rather than just greying it out",
    (await flowReplayService.replayPlan(hr.id, agentRow!.id)).steps
      .find((s) => s.stepId === "boom")
      ?.reason?.includes("summarise"),
    true,
  );
  await flowService.remove(hr.id, agentFlow.flow.id);

  // ── teardown ──────────────────────────────────────────────────────────────
  await dropFlow(alt.id, "hr-screening-portable-raw");
  await dropFlow(alt.id, "hr-screening-portable-alt");
  await flowTemplateService.remove(hr.id, template.id);
  await dropFlow(hr.id, PORTABLE_SCREENING_MODEL.id);

  console.log(`\n${"═".repeat(72)}`);
  if (failures) {
    console.log(c.bad(`${failures} assertion(s) FAILED`));
    process.exit(1);
  }
  console.log(c.ok("phase 6 — all assertions passed"));
  if (!LIVE) {
    console.log(
      c.dim(
        "\nNote: fragment generation was SCRIPTED. This run proves that the code did not travel,\n" +
          "the contract did, refs were revalidated, generation happened before deploy, and the same\n" +
          "recipe scores differently against two tenants' queries. It does NOT prove a real model\n" +
          "produces that fragment from the travelled contract — re-run with --live for that.",
      ),
    );
  }
}

main()
  .catch((e) => {
    console.error(c.bad(`\nphase6-verify crashed: ${(e as Error).message}`));
    if (e instanceof KestraError) console.error(JSON.stringify(e.body, null, 2));
    process.exit(1);
  })
  .finally(async () => {
    const { pool } = await import("../db/index.js");
    await pool.end().catch(() => {});
  });
