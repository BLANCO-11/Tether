/**
 * Flow expectations, and gate 1's second half — verified against the running
 * engine and scored against the HR oracle.
 *
 *   pnpm --filter @foundry/server kestra:expect
 *   pnpm --filter @foundry/server kestra:expect --period=2026-05
 *
 * archive/GAPS.md §2.3 · DECISIONS.md D-68
 *
 * ── What has to be here rather than in a unit test ───────────────────────────
 *
 * `flow-expectation.test.ts` has 32 assertions over the evaluator and every one
 * of them is fed a hand-built `StepView`. That proves the comparisons; it proves
 * nothing about the three real output shapes, which is where this feature is
 * most likely to be silently wrong — a `code` step's output is
 * `vars.result` and not `.value` (I-44), a `datasource` step's rows are nested
 * two levels inside a JSON *string*, and a `tool` step's "rows" are its calls.
 * Get any of those wrong and every expectation returns `unevaluable`, which
 * reads on screen like a feature nobody has used yet.
 *
 * Five things are checked here and can only be checked here:
 *
 *   1. **A true claim passes on a real run**, at the count the ORACLE gives —
 *      not at a count read back from the same query the flow ran, which would
 *      be the flow agreeing with itself.
 *   2. **A false claim fails.** The negative control, and it is the whole
 *      harness: a vocabulary that always passes is worse than none (I-38), and
 *      it would look exactly like this one until the day it mattered.
 *   3. **Gate 1 refuses to arm on it, and then allows.** Both arms, because a
 *      gate that only ever refuses is indistinguishable from a broken gate.
 *   4. **`unevaluable` does not satisfy the gate.** The third state exists so a
 *      claim nobody could check does not read as a claim that held.
 *   5. **The verdicts are persisted at the run**, once, and a later read does
 *      not recompute them against the flow's current claims.
 *
 * ⚠ **A passing expectation is not a correct run**, and this harness must never
 * be quoted as saying otherwise. An expectation is written by the flow's own
 * author and can be wrong in the same direction as the flow. What it catches is
 * a flow drifting from its author's stated intent — which IS the measured
 * disaster this migration exists to fix ("emailed 0 of 11, exited 0") — and not
 * the units trap, which only an oracle sees.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { kestra, type KestraExecution } from "../services/kestra-client.service.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { abortUnlessScorable } from "../demo/oracle-corpus.js";
import { flowService } from "../services/flow.service.js";
import { flowPortabilityService } from "../services/flow-portability.service.js";
import { flowExpectationService, expectationKey } from "../services/flow-expectation.service.js";
import { flowValidator, FlowValidationError } from "../services/flow-validator.service.js";
import { triggerService } from "../services/trigger.service.js";
import { type FlowModel } from "../services/flow-compiler.service.js";
import { expectedScreening } from "../demo/hr-dataset.js";
import { systemAuthor } from "../services/revision-author.js";

const PERIOD = process.argv.find((a) => a.startsWith("--period="))?.split("=")[1] ?? "2026-06";

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
function checkThat(label: string, pass: boolean, detail = "") {
  if (!pass) failures++;
  console.log(`  ${pass ? c.ok("PASS") : c.bad("FAIL")}  ${label.padEnd(60)} ${c.dim(detail)}`);
}
function block(n: string) {
  console.log(`\n${c.dim("─".repeat(78))}\n${n}\n`);
}

const SETTLED = ["SUCCESS", "FAILED", "KILLED", "WARNING"];
async function waitFor(executionId: string, timeoutMs = 180_000): Promise<KestraExecution> {
  const deadline = Date.now() + timeoutMs;
  let ex = await kestra.getExecution(executionId);
  while (Date.now() < deadline && !SETTLED.includes(ex.state.current)) {
    await new Promise((r) => setTimeout(r, 1500));
    ex = await kestra.getExecution(executionId);
  }
  return ex;
}

/** Foundry's row for a Kestra execution — the id every expectation result hangs off. */
async function foundryExecutionId(kestraExecutionId: string): Promise<string | null> {
  const r = await db.execute<{ id: string }>(sql`
    SELECT id FROM flow_executions WHERE kestra_execution_id = ${kestraExecutionId} LIMIT 1`);
  return r.rows?.[0]?.id ?? null;
}

/**
 * The flow under test — one step of each readable kind, so all three real output
 * shapes are exercised by one run.
 *
 * The `code` fragment is hand-written rather than generated, deliberately: this
 * harness is about reading a fragment's output, and routing it through a real
 * generation would make an inference failure look like an expectation failure.
 */
function shapesFlow(id: string): FlowModel {
  return {
    id,
    inputs: [{ id: "period", type: "STRING", defaults: PERIOD }],
    steps: [
      {
        id: "screen",
        kind: "datasource",
        ref: "hr_demo.attendance_below_threshold",
        paramsExpr: '[{ "period": "{{ inputs.period }}" }]',
      },
      {
        id: "project",
        kind: "transform",
        // I-42's rule, and a good one anyway: a projecting transform, dates
        // flattened, so nothing downstream consumes a raw query row.
        // ⚠ `full_name` / `work_email`, and the FIRST version of this harness
        // wrote `.name` / `.email`. The projection silently produced eleven rows
        // of nulls, the flow ran green, and the only thing that noticed was the
        // expectation under test reporting `0 of 11 rows satisfy name present`.
        // Left recorded here because it is the feature catching exactly what it
        // is for: a step that ran, succeeded, and produced the wrong thing.
        expr:
          "{{ json(outputs.screen.body).results[0].data " +
          "| jq('[.[] | {name: .full_name, email: .work_email}]') | first }}",
        dependsOn: ["screen"],
      },
      {
        id: "summarise",
        kind: "code",
        code:
          "def run(payload):\n" +
          "    people = payload.get('people') or []\n" +
          "    return {'flagged': len(people), 'named': [p.get('name') for p in people]}\n",
        inputExpr: '{ "people": {{ outputs.project.value }} }',
        outputKeys: ["flagged", "named"],
        dependsOn: ["project"],
      },
    ],
  };
}

async function deploy(workspaceId: string, model: FlowModel, name: string) {
  const stale = await flowRepo.getByKestraFlowId(workspaceId, model.id);
  if (stale) await flowService.remove(workspaceId, stale.id);
  const created = await flowService.create(workspaceId, {
    name,
    model,
    author: systemAuthor("expect-verify@acme-hr.example"),
  });
  return created.flow;
}

async function runAndEvaluate(workspaceId: string, flowId: string) {
  const started = await flowService.testRun(workspaceId, flowId, { period: PERIOD });
  const ex = await waitFor(started.kestraExecutionId);
  // ⚠ Before any oracle comparison below: this harness scores against the HR
  // oracle, which describes the real dataset, and a draft run reads hr_demo's
  // sandbox whenever one exists.
  await abortUnlessScorable(started.kestraExecutionId, "hr_demo");
  const foundryId = await foundryExecutionId(started.kestraExecutionId);
  if (!foundryId) throw new Error(`no Foundry row for execution ${started.kestraExecutionId}`);
  const outcome = await flowExpectationService.evaluate(foundryId);
  return { ex, foundryId, verdicts: outcome.verdicts };
}

const statusOf = (verdicts: Array<{ expectationId: string; status: string }>, id: string) =>
  verdicts.find((v) => v.expectationId === id)?.status ?? "<missing>";

async function main() {
  console.log(
    `\n${"═".repeat(78)}\nFlow expectations — GAPS §2.3  ${c.dim(`period ${PERIOD}`)}\n${"═".repeat(78)}`,
  );

  const ws = (await workspaceRepo.list()).find((w) => w.name === "HR");
  if (!ws) throw new Error('workspace "HR" not found — run `pnpm demo:seed`');

  // ⚠ The oracle, not a read-back of the flow's own query. Asserting the count
  // the flow produced against the count the flow produced is a tautology that
  // passes on every dataset including a broken one.
  const oracle = expectedScreening(PERIOD);
  const FLAGGED = oracle.flagged.length;
  console.log(
    c.dim(`  oracle: ${FLAGGED} employee(s) below threshold at ${PERIOD}` +
      (FLAGGED === 0 ? "  (the EMPTY case — the one most claims get wrong)" : "")),
  );

  // ── 1. A true claim passes, on all three output shapes ────────────────────
  block("1 · a true claim passes — one expectation per real output shape");

  const truthful = shapesFlow("expect_true");
  truthful.expectations = [
    {
      id: "screen_matches_oracle",
      stepId: "screen",
      description: `the query returns the ${FLAGGED} employee(s) the oracle flags`,
      assert: { type: "rowCount", op: "eq", value: FLAGGED },
    },
    {
      id: "everyone_is_named",
      stepId: "project",
      description: "no projected row lost its name",
      assert: { type: "rows", quantifier: "every", field: "name", op: "present" },
    },
    {
      id: "fragment_counted_them_all",
      stepId: "summarise",
      description: "the fragment's own count agrees with the query's",
      assert: { type: "field", field: "flagged", op: "eq", value: FLAGGED },
    },
  ];

  const trueFlow = await deploy(ws.id, truthful, "expectations — true claims");
  const t = await runAndEvaluate(ws.id, trueFlow.id);
  check("the run itself succeeded", t.ex.state.current, "SUCCESS");
  check("datasource rowCount vs the oracle", statusOf(t.verdicts, "screen_matches_oracle"), "passed");
  check("transform rows · every name present", statusOf(t.verdicts, "everyone_is_named"), "passed");
  check("code field · vars.result (I-44)", statusOf(t.verdicts, "fragment_counted_them_all"), "passed");
  // ⚠ Not one of them may be `unevaluable`. That is the failure mode where the
  // resolver cannot read a real shape and the whole feature quietly does nothing.
  checkThat(
    "none of the three was unevaluable",
    t.verdicts.every((v) => v.status !== "unevaluable"),
    t.verdicts.map((v) => `${v.expectationId}=${v.status}`).join(" "),
  );

  // ── 2. THE NEGATIVE CONTROL — a false claim fails, on each shape ──────────
  block("2 · the negative control — the same three claims, made false");

  const lying = shapesFlow("expect_false");
  lying.expectations = [
    {
      id: "screen_matches_oracle",
      stepId: "screen",
      // Deliberately off by one from whatever the oracle says, INCLUDING at the
      // empty period where the honest count is 0 — so this control fires at
      // every period rather than only at the busy one.
      assert: { type: "rowCount", op: "eq", value: FLAGGED + 7 },
    },
    {
      id: "everyone_is_named",
      stepId: "project",
      assert: { type: "rows", quantifier: "none", field: "name", op: "present" },
    },
    {
      id: "fragment_counted_them_all",
      stepId: "summarise",
      assert: { type: "field", field: "flagged", op: "eq", value: FLAGGED + 7 },
    },
  ];

  const falseFlow = await deploy(ws.id, lying, "expectations — false claims");
  const f = await runAndEvaluate(ws.id, falseFlow.id);
  check("the run still SUCCEEDED — a wrong claim is not a broken flow", f.ex.state.current, "SUCCESS");
  check("datasource rowCount · wrong number", statusOf(f.verdicts, "screen_matches_oracle"), "failed");
  check("code field · wrong number", statusOf(f.verdicts, "fragment_counted_them_all"), "failed");
  if (FLAGGED > 0) {
    check("transform rows · `none present` over named rows", statusOf(f.verdicts, "everyone_is_named"), "failed");
  } else {
    // ⚠ Stated, not skipped silently. At the empty period `none … present` over
    // zero rows is vacuously TRUE, so this particular control cannot fire — and
    // a harness that quietly dropped it would report full coverage it did not
    // have. The other two controls above are period-independent by construction.
    checkThat(
      "transform rows control is N/A at the empty period, and says so",
      statusOf(f.verdicts, "everyone_is_named") === "passed",
      "zero rows ⇒ `none` is vacuously satisfied; run at 2026-06 to exercise it",
    );
  }

  // ── 3. Gate 1 — both arms ─────────────────────────────────────────────────
  block("3 · gate 1 · a flow whose claim has not passed cannot be armed");

  const blocked = await triggerService.flowEnableReadiness(ws.id, falseFlow.id);
  checkThat("a flow with a failing claim is NOT ready", blocked.ready === false, blocked.reason ?? "");
  checkThat(
    "and the refusal NAMES the claim, so the fix is obvious",
    !!blocked.reason?.includes("screen_matches_oracle"),
    blocked.reason?.slice(0, 96) ?? "",
  );

  const allowed = await triggerService.flowEnableReadiness(ws.id, trueFlow.id);
  // ⚠ The arm that makes the one above discriminating. Without it, "gate 1
  // refuses" is satisfied by a gate that refuses everything.
  checkThat("a flow whose claims all passed IS ready", allowed.ready === true, allowed.reason ?? "ready");

  const noClaims = await deploy(ws.id, shapesFlow("expect_none"), "expectations — none declared");
  const n = await runAndEvaluate(ws.id, noClaims.id);
  check("a flow declaring nothing still runs", n.ex.state.current, "SUCCESS");
  check("…and produces no verdicts", n.verdicts.length, 0);
  checkThat(
    "…and gate 1 is UNCHANGED for it — no day-one refusal",
    (await triggerService.flowEnableReadiness(ws.id, noClaims.id)).ready === true,
  );

  // ── 4. `unevaluable` does not satisfy the gate ────────────────────────────
  block("4 · a claim nobody could check does not read as a claim that held");

  const unreadable = shapesFlow("expect_unreadable");
  unreadable.expectations = [
    {
      id: "counts_a_key_that_is_not_there",
      stepId: "summarise",
      // Passes validation — nothing at authoring time knows which keys a
      // fragment will emit — and cannot be evaluated at runtime.
      select: "flagged_people",
      assert: { type: "rowCount", op: "gte", value: 0 },
    },
  ];
  const uFlow = await deploy(ws.id, unreadable, "expectations — unevaluable");
  const u = await runAndEvaluate(ws.id, uFlow.id);
  check("the claim is unevaluable", statusOf(u.verdicts, "counts_a_key_that_is_not_there"), "unevaluable");
  checkThat(
    "…and it names the keys the step DID produce",
    !!u.verdicts[0]?.detail.includes("flagged"),
    u.verdicts[0]?.detail.slice(0, 96) ?? "",
  );
  checkThat(
    "⚠ gate 1 refuses on it — unevaluable is not a pass",
    (await triggerService.flowEnableReadiness(ws.id, uFlow.id)).ready === false,
  );

  // ── 5. Persistence, and what re-blocks the gate ───────────────────────────
  block("5 · the verdict is persisted at the run, and the gate is scoped to the CLAIM");

  const again = await flowExpectationService.evaluate(t.foundryId);
  check("a second evaluation returns the stored verdicts", again.evaluated, false);
  check("…and does not duplicate them", again.verdicts.length, t.verdicts.length);
  const rowCount = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM flow_expectation_results WHERE flow_execution_id = ${t.foundryId}`);
  check("one row per claim in the database", rowCount.rows?.[0]?.n, String(t.verdicts.length));

  // Reword the description only — same claim, so the same key, so still armed.
  const reworded = structuredClone(truthful);
  reworded.expectations![0]!.description = "the query returns exactly the people the oracle flags";
  await flowService.saveRevision(ws.id, trueFlow.id, {
    model: reworded,
    author: systemAuthor("expect-verify@acme-hr.example"),
  });
  checkThat(
    "⚠ rewording a claim does NOT re-block the gate",
    (await triggerService.flowEnableReadiness(ws.id, trueFlow.id)).ready === true,
    "the key is over what is claimed, not how it is worded",
  );

  // Change the number — a different claim, which no run has satisfied.
  const changed = structuredClone(truthful);
  changed.expectations![0]!.assert = { type: "rowCount", op: "eq", value: FLAGGED + 1 };
  await flowService.saveRevision(ws.id, trueFlow.id, {
    model: changed,
    author: systemAuthor("expect-verify@acme-hr.example"),
  });
  checkThat(
    "…but CHANGING it does — the new claim has never been tested",
    (await triggerService.flowEnableReadiness(ws.id, trueFlow.id)).ready === false,
  );
  // Distinct keys, so the two claims cannot be confused for one another.
  checkThat(
    "the two claims hash differently",
    expectationKey(truthful.expectations![0]!) !== expectationKey(changed.expectations![0]!),
  );

  // ── 6. Authoring-time refusals ────────────────────────────────────────────
  block("6 · a claim that names nothing is refused before it deploys");

  const typo = shapesFlow("expect_typo");
  typo.expectations = [
    { id: "oops", stepId: "sceen", assert: { type: "rowCount", op: "eq", value: 1 } },
  ];
  let refusal = "";
  try {
    await deploy(ws.id, typo, "expectations — typo");
  } catch (e) {
    refusal = e instanceof FlowValidationError ? e.findings.map((x) => x.rule).join(",") : String(e);
  }
  check("a typo'd step id is refused at writeRevision", refusal, "expectation_unknown_step");

  const onAgent = shapesFlow("expect_gate");
  onAgent.steps.push({
    id: "ask",
    kind: "approval",
    summaryExpr: '"proceed?"',
    dependsOn: ["project"],
  });
  onAgent.expectations = [
    { id: "nope", stepId: "ask", assert: { type: "rowCount", op: "eq", value: 1 } },
  ];
  checkThat(
    "a claim on an `approval` step is refused by kind",
    flowValidator.checkFlowExpectations(onAgent).some((x) => x.rule === "expectation_unreadable_kind"),
  );

  // ── 7. Expectations travel, and the import says what it cannot verify ─────
  block("7 · export / import — the claims travel and the import states their bound");

  // ⚠ A DIFFERENT flow, with no hand-written `code` step. `bundleStep` refuses
  // one that has no stored contract (D-24) — correctly, since the importing
  // workspace would have nothing to regenerate it from — and the first version
  // of this block died on that rather than testing what it meant to.
  const portable: FlowModel = {
    id: "expect_portable",
    inputs: [{ id: "period", type: "STRING", defaults: PERIOD }],
    steps: [
      {
        id: "screen",
        kind: "datasource",
        ref: "hr_demo.attendance_below_threshold",
        paramsExpr: '[{ "period": "{{ inputs.period }}" }]',
      },
    ],
    expectations: [
      {
        id: "screen_matches_oracle",
        stepId: "screen",
        description: "written against THIS tenant's data",
        assert: { type: "rowCount", op: "eq", value: FLAGGED },
      },
    ],
  };
  const portableFlow = await deploy(ws.id, portable, "expectations — portable");
  const bundle = await flowPortabilityService.exportFlow(ws.id, portableFlow.id);
  check("the bundle carries the claims", bundle.model.expectations?.length, 1);
  const plan = await flowPortabilityService.planImport(ws.id, bundle, {
    modelId: "expect_imported",
  });
  const warned = plan.warnings.find((w) => w.code === "expectation_imported");
  checkThat("the import warns that they were written elsewhere", !!warned, warned?.message.slice(0, 88) ?? "");
  checkThat(
    "…non-blocking — a bundle is a recipe, and the numbers are corrected here",
    warned?.blocking === false,
  );
  checkThat(
    "…and the rebuilt model still has them, so the gate will enforce them",
    plan.model.expectations?.length === bundle.model.expectations?.length,
  );

  // ── Clean up ──────────────────────────────────────────────────────────────
  for (const f of [trueFlow, falseFlow, noClaims, uFlow, portableFlow]) {
    await flowService.remove(ws.id, f.id).catch(() => {});
  }

  console.log(
    `\n${"═".repeat(78)}\n` +
      (failures === 0
        ? c.ok(`ALL ASSERTIONS PASSED  ·  period ${PERIOD}`)
        : c.bad(`${failures} ASSERTION(S) FAILED  ·  period ${PERIOD}`)) +
      `\n${"═".repeat(78)}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(c.bad(`\nharness error: ${(e as Error).stack ?? e}\n`));
  process.exit(1);
});
