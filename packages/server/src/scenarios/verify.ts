/**
 * `pnpm scenarios:verify` — did the three Finance flows do the RIGHT thing?
 * Programme 3, Stage 3 exit criterion.
 *
 * ── The question this asks, and the one it refuses to ask ───────────────────
 *
 * `scenarios:seed` already answers "did it run". This answers "was it right",
 * and the two are not the same question — the measured original failure of this
 * whole system was a script that *"hardcoded `period="2023-10"`, emailed 0 of 11,
 * and still exited 0 with `tests_passed=true` and audit `clean`"*. A green run
 * said yes to every check that existed. Only an oracle said no.
 *
 * So every assertion below compares what the flow DID — the rows ops-api
 * captured, which are the real effects — against `financeOracle()`, which is
 * computed from the dataset definition and has never seen a query result.
 *
 * ⚠ `financeOracle()` is a SEPARATE FUNCTION from `expectedScreening()` and must
 * never become a parameterisation of it. A shared oracle lets a shared bug
 * produce a wrong answer that agrees with itself.
 *
 * ── Run it at more than one period ──────────────────────────────────────────
 *
 * `2026-04` flags ZERO overdue invoices and zero claims over policy. That is the
 * only period that exercises the empty case, and three real bugs in this repo's
 * history (I-09, I-10, I-20) were invisible at one period and obvious at another.
 *
 * ── Two things it deliberately cannot check ─────────────────────────────────
 *
 *   1. `finance-expense-policy` PAUSES at gate 3. Its send is verified by
 *      asserting the outbox has NOT moved — the gate stopping a send is the
 *      claim, so the evidence is an absence.
 *   2. The paragraph `llm_complete` writes. It is non-deterministic by
 *      construction and its output is terminal (D-34), so it is asserted to
 *      EXIST and to be absent from every figure, never to say anything
 *      particular. An oracle scoring generated prose would be scoring itself.
 */

import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { abortUnlessScorable } from "../demo/oracle-corpus.js";
import { flowService } from "../services/flow.service.js";
import { flowVisibilityService } from "../services/flow-visibility.service.js";
import { kestra, type KestraExecution } from "../services/kestra-client.service.js";
import { opsClient } from "../services/ops-client.service.js";
import { financeOracle, FINANCE_DEFAULT_PERIOD } from "../demo/finance/finance-dataset.js";
import { FINANCE_WORKSPACE_NAME } from "../demo/finance/provision-finance.js";
import {
  FINANCE_BUDGET_VARIANCE,
  FINANCE_EXPENSE_POLICY,
  FINANCE_INVOICE_CHASE,
} from "./finance-flows.js";

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

let passes = 0;
let fails = 0;
function check(label: string, ok: boolean, detail: string) {
  if (ok) {
    passes++;
    console.log(`  ${c.ok("PASS")}  ${label.padEnd(44)} ${c.dim(detail)}`);
  } else {
    fails++;
    console.log(`  ${c.bad("FAIL")}  ${label.padEnd(44)} ${detail}`);
  }
}

const SETTLED = ["SUCCESS", "FAILED", "KILLED", "WARNING"];

function asOfFor(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

type MailRow = { to_addresses?: unknown; subject?: string | null; body?: string | null };

/** Mail captured by ops-api, newest first. These are the real effects, not a log line. */
async function outbox(): Promise<MailRow[]> {
  return opsClient.records<MailRow>("mail", 400);
}

function recipientsOf(m: MailRow): string[] {
  const t = m.to_addresses;
  if (Array.isArray(t)) return t.map(String);
  if (typeof t === "string") {
    try {
      const parsed = JSON.parse(t);
      return Array.isArray(parsed) ? parsed.map(String) : [t];
    } catch {
      return [t];
    }
  }
  return [];
}

async function runToSettleOrPause(
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
    // PAUSED is a terminal state FOR THIS HARNESS and nowhere else: one flow is
    // supposed to stop there, and waiting for it to settle would time out on the
    // behaviour being verified.
    if (SETTLED.includes(last.state.current) || last.state.current === "PAUSED") {
      // ⚠ Here, not at the call sites: every run this harness scores goes
      // through this function, so the corpus is checked once and cannot be
      // forgotten by a scenario added later. And AFTER settling — `read_from`
      // is stamped at step-callback time, so an earlier read sees no rows and
      // would pass over nothing (I-38).
      await abortUnlessScorable(started.kestraExecutionId, "finance_demo");
      return last;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    `execution ${started.kestraExecutionId} did not settle within ${timeoutMs / 1000}s ` +
      `(last state ${last?.state.current ?? "unknown"})`,
  );
}

async function main() {
  const period = process.argv.find((a) => a.startsWith("--period="))?.split("=")[1] ?? FINANCE_DEFAULT_PERIOD;
  const asOf = asOfFor(period);
  const oracle = financeOracle(period);

  console.log(`\n${"═".repeat(78)}`);
  console.log(`scenarios:verify  ${c.dim(`period ${period} · as of ${asOf}`)}`);
  console.log(
    c.dim(
      `oracle: ${oracle.overdue.length} overdue · ${oracle.claimsOverPolicy.length} over policy · ` +
        `${oracle.spendByCostCentre.filter((s) => s.overBudget).length} over budget`,
    ),
  );
  console.log("═".repeat(78));

  const ws = (await workspaceRepo.list()).find((w) => w.name === FINANCE_WORKSPACE_NAME);
  if (!ws) {
    console.error(c.bad(`\nno "${FINANCE_WORKSPACE_NAME}" workspace — run \`pnpm finance:seed\`.\n`));
    process.exit(1);
  }

  const flowOf = async (kestraId: string) => {
    const f = await flowRepo.getByKestraFlowId(ws.id, kestraId);
    if (!f) throw new Error(`flow "${kestraId}" is not registered — run \`pnpm scenarios:seed\` first`);
    return f;
  };

  // ══ 1. Chase overdue invoices ═══════════════════════════════════════════
  console.log(`\n${c.dim("─".repeat(78))}\n1. ${FINANCE_INVOICE_CHASE.id}\n`);
  {
    const flow = await flowOf(FINANCE_INVOICE_CHASE.id);
    const before = (await outbox()).length;
    const ex = await runToSettleOrPause(ws.id, flow.id, { as_of: asOf });

    // WARNING passes: the chase step carries a `retry:`, and an execution that
    // recovered on attempt 2 settles WARNING. Treating that as failure would
    // make the retry feature unusable.
    check(
      "the run completed",
      ex.state.current === "SUCCESS" || ex.state.current === "WARNING",
      ex.state.current,
    );

    const after = await outbox();
    const sent = after.slice(0, after.length - before);

    // ⚠ THE assertion. One chase per overdue invoice the oracle names — not
    // "some mail was sent", which is what a green run already told us.
    check(
      "one chase per overdue invoice",
      sent.length === oracle.overdue.filter((o) => o.contactEmail && !o.contactEmail.includes("-bounce.")).length,
      `sent ${sent.length}, oracle mailable ${
        oracle.overdue.filter((o) => o.contactEmail && !o.contactEmail.includes("-bounce.")).length
      } of ${oracle.overdue.length} overdue`,
    );

    // Every invoice the oracle names is actually in a subject line. A count that
    // matches while the WRONG invoices were chased is the failure a count alone
    // cannot see.
    const subjects = sent.map((m) => m.subject ?? "").join(" | ");
    const missing = oracle.overdue
      .filter((o) => o.contactEmail && !o.contactEmail.includes("-bounce."))
      .filter((o) => !subjects.includes(o.invoiceNumber))
      .map((o) => o.invoiceNumber);
    check("every overdue invoice was named", missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : "all present");

    // The unreachable ones must NOT have been mailed — they are the ones the
    // ticket is for, and mailing an address known to bounce is the failure this
    // flow's routing exists to prevent.
    const unreachableAddrs = new Set(
      oracle.overdue.filter((o) => !o.contactEmail || o.contactEmail.includes("-bounce.")).map((o) => o.contactEmail),
    );
    const wronglyMailed = sent.filter((m) => recipientsOf(m).some((r) => unreachableAddrs.has(r)));
    check(
      "nothing was mailed to an unreachable vendor",
      wronglyMailed.length === 0,
      `${unreachableAddrs.size} unreachable address(es), ${wronglyMailed.length} mailed`,
    );

    // The empty case. At 2026-04 the oracle names nobody, and zero mail is the
    // correct answer — a flow that sends a "0 invoices overdue" notice would
    // make a quiet month indistinguishable from a broken run.
    if (oracle.overdue.length === 0) {
      check("the empty period sends nothing", sent.length === 0, `${sent.length} message(s)`);
    }

    // The seam badge's subject, asserted from the server's own read model rather
    // than from the flow file: this flow touches no model, and the canvas must
    // therefore mark none of its nodes.
    const view = await flowVisibilityService.list(ws.id, 1);
    const detail = view[0] ? await flowVisibilityService.get(ws.id, view[0].id) : null;
    check(
      "no step here reaches a model",
      !(detail?.steps ?? []).some((s) => s.ref === "llm_complete"),
      `${(detail?.steps ?? []).length} step(s) inspected`,
    );
  }

  // ══ 2. Expense claims over policy — the gate stops the send ═════════════
  console.log(`\n${c.dim("─".repeat(78))}\n2. ${FINANCE_EXPENSE_POLICY.id}\n`);
  {
    const flow = await flowOf(FINANCE_EXPENSE_POLICY.id);
    const before = await outbox();
    const ex = await runToSettleOrPause(ws.id, flow.id, { period });

    check("the run stopped for a person", ex.state.current === "PAUSED", ex.state.current);

    // ⚠ The claim is an ABSENCE, and it is matched on this flow's OWN subject
    // line rather than on the size of the outbox. The first version of the
    // equivalent check in `e2e:ui` counted the whole outbox and went MISMATCH
    // because another flow's replay was in flight and also mailing.
    const after = await outbox();
    const ours = (rows: MailRow[]) => rows.filter((m) => (m.subject ?? "").includes("is over policy"));
    check(
      "nothing was sent while it waits",
      ours(after).length === ours(before).length,
      `${ours(after).length} policy notice(s) before and after — the gate is what stops it`,
    );

    // The gate is emitted BEFORE the send, which is the entire mechanism: Kestra
    // runs tasks in emission order, so a gate at the end would satisfy every
    // assertion about a pause and stop nothing. Asserted from the compiled
    // graph, not from the source file.
    const notifyIdx = FINANCE_EXPENSE_POLICY.steps.findIndex((s) => s.id === "notify");
    const gateIdx = FINANCE_EXPENSE_POLICY.steps.findIndex((s) => s.id === "notify_gate");
    check("the gate is emitted before the send", gateIdx >= 0 && gateIdx < notifyIdx, `gate at ${gateIdx}, send at ${notifyIdx}`);

    // Leave nothing paused behind. A PAUSED execution holds an M3 budget slot,
    // and retention purges terminal states only — so an abandoned pause survives
    // every cleanup this repo has.
    try {
      await kestra.killExecution(ex.id);
      console.log(c.dim(`      (paused run ${ex.id.slice(0, 8)} killed — a pause holds a budget slot)`));
    } catch (e) {
      console.log(c.warn(`      could not kill the paused run: ${(e as Error).message}`));
    }
  }

  // ══ 3. Budget versus actual — the units trap ════════════════════════════
  console.log(`\n${c.dim("─".repeat(78))}\n3. ${FINANCE_BUDGET_VARIANCE.id}\n`);
  {
    const flow = await flowOf(FINANCE_BUDGET_VARIANCE.id);
    const before = (await outbox()).length;
    const ex = await runToSettleOrPause(ws.id, flow.id, { period });
    check("the run completed", ex.state.current === "SUCCESS" || ex.state.current === "WARNING", ex.state.current);

    const after = await outbox();
    const digest = after.slice(0, after.length - before).find((m) => (m.subject ?? "").startsWith("Budget variance"));
    check("a digest was sent", !!digest, digest?.subject ?? "no digest in the outbox");

    // ⚠ THE UNITS TRAP, and the only assertion that catches it.
    //
    // `spend_by_cost_centre` returns budgets in BOTH units. A fragment reaching
    // for `budget_amount_major` instead of `budget_cents` reports every cost
    // centre as ~100x over, so the count goes to 6 of 6 — which reads like a
    // department in crisis rather than like a bug. The oracle knows it is one.
    const expectedOver = oracle.spendByCostCentre.filter((s) => s.overBudget);
    check(
      "the over-budget count matches the oracle",
      (digest?.subject ?? "").includes(`${expectedOver.length} cost centre`),
      `subject says "${digest?.subject ?? "—"}", oracle says ${expectedOver.length}`,
    );

    // And the right ones, by name — a count that matches while the wrong centres
    // are listed is the failure a count cannot see.
    const body = digest?.body ?? "";
    const namedWrong = expectedOver.filter((s) => !body.includes(s.costCentreCode)).map((s) => s.costCentreCode);
    check(
      "every over-budget centre is named",
      namedWrong.length === 0,
      namedWrong.length ? `missing ${namedWrong.join(", ")}` : `${expectedOver.length} named`,
    );

    // The dormant centre — zero budget and zero spend — is reported rather than
    // silently counted as compliant. "0 of 0" and "under budget" are different
    // facts and only one deserves attention.
    const dormant = oracle.spendByCostCentre.filter((s) => s.actualCents === 0 && s.budgetCents === 0);
    if (dormant.length > 0) {
      check(
        "the dormant cost centre is reported, not hidden",
        dormant.every((d) => body.includes(d.costCentreCode)),
        `${dormant.map((d) => d.costCentreCode).join(", ")}`,
      );
    }

    // The model seam did its job and stayed in its lane. `llm_complete` was
    // called (so the seam is real and the canvas badge has a subject), and the
    // figures in the digest all come from the fragment.
    const calls = await opsClient.callLog(200);
    check(
      "the model step actually ran",
      calls.some((r) => (r.path ?? "").includes("/llm")),
      `${calls.filter((r) => (r.path ?? "").includes("/llm")).length} llm call(s) in the log`,
    );
  }

  console.log(`\n${"═".repeat(78)}`);
  console.log(`  ${passes} passed · ${fails === 0 ? c.ok("0 failed") : c.bad(`${fails} failed`)}`);
  console.log(
    c.dim(
      `\n  ⚠ A green run here means each flow matched its oracle AT ${period} on the ` +
        `synthetic\n    Finance dataset. It is not a claim about production units. ` +
        `Run --period=2026-04\n    for the empty case.\n`,
    ),
  );
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(c.bad(`\nscenarios:verify failed: ${(e as Error).message}\n`));
  process.exit(1);
});
