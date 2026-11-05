/**
 * Gate 3 — the `approval` step kind, verified against the running stack.
 *
 *   pnpm --filter @foundry/server kestra:hitl
 *   pnpm --filter @foundry/server kestra:hitl --period=2026-05
 *
 * ── What has to be here rather than in a unit test ───────────────────────────
 *
 * The compiler emitting a `Pause` is a string comparison, and `flow-compiler.test.ts`
 * makes it. Everything that makes gate 3 a GATE is a fact about the engine:
 *
 *   1. **The flow stops, and nothing is sent.** Asserted against
 *      ops-api's `mail_outbox` — the COUNT, not the flow's own report of what it did.
 *      A gate that pauses after sending is not a gate, and a flow that says it
 *      sent nothing is exactly the class of self-report this repo has been
 *      burned by (`generation-audit` marked `clean` a script that emailed 0 of 11).
 *   2. **The wait outlives this process.** The exit criterion. The API server is
 *      RESTARTED while the run is paused, and the run must still be resumable
 *      afterwards. Nothing in-process can demonstrate that, because anything
 *      in-process is what is being killed.
 *   3. **Approve delivers the decision.** Kestra accepts a JSON resume body with
 *      a 2xx and SILENTLY DROPS the inputs (D-21), so asserting the 2xx proves
 *      nothing. The resumed VALUE has to arrive.
 *   4. **Reject sends nothing, ever.** The dangerous case: resuming with
 *      `decision: "rejected"` would un-pause and every downstream step would run.
 *      Asserted as an outbox count after the run has settled.
 *   5. **A rejected run releases its M3 budget slot.** A killed execution never
 *      reaches `complete`, so nothing else would move its row off `running` —
 *      and five rejections would then brick the workspace through a FAIRNESS
 *      control (I-10).
 *
 * Each assertion is paired with the control that makes it discriminating: the
 * approve path is run to completion so "nothing was sent" is known to mean the
 * gate held rather than the flow being broken.
 */
import { spawnSync } from "node:child_process";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { kestra, type KestraExecution } from "../services/kestra-client.service.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { flowService } from "../services/flow.service.js";
import { stepApprovalService } from "../services/step-approval.service.js";
import { flowPortabilityService } from "../services/flow-portability.service.js";
import type { FlowModel } from "../services/flow-compiler.service.js";
import { opsClient } from "../services/ops-client.service.js";
import { systemAuthor } from "../services/revision-author.js";

const PERIOD = process.argv.find((a) => a.startsWith("--period="))?.split("=")[1] ?? "2026-06";
const SKIP_RESTART = process.argv.includes("--skip-restart");

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
    `  ${pass ? c.ok("PASS") : c.bad("FAIL")}  ${label.padEnd(60)} ` +
      (pass ? c.dim(String(want)) : c.bad(`\n        got  ${got}\n        want ${want}`)),
  );
}
function checkThat(label: string, pass: boolean, detail = "") {
  if (!pass) failures++;
  console.log(`  ${pass ? c.ok("PASS") : c.bad("FAIL")}  ${label.padEnd(60)} ${c.dim(detail)}`);
}

const settled = (e: KestraExecution) => ["SUCCESS", "FAILED", "KILLED", "WARNING"].includes(e.state.current);
const paused = (e: KestraExecution) => e.state.current === "PAUSED";

async function waitFor(
  executionId: string,
  until: (e: KestraExecution) => boolean,
  timeoutMs = 180_000,
): Promise<KestraExecution> {
  const deadline = Date.now() + timeoutMs;
  let ex = await kestra.getExecution(executionId);
  while (Date.now() < deadline && !until(ex)) {
    await new Promise((r) => setTimeout(r, 1500));
    ex = await kestra.getExecution(executionId);
  }
  return ex;
}

/**
 * Wait for the API server to be serving again.
 *
 * Needed because `docker compose restart` returns as soon as the container is
 * STARTED, not when the process inside it is listening — and the first run of
 * this harness proved the difference matters: the approval was delivered 12s
 * after the restart, Kestra resumed, and `notify` died with
 * `Connect to http://server:4000 failed: Connection refused`.
 *
 * That was the harness racing, not a product defect — but it is worth what it
 * showed. The PAUSE survived the API server being completely absent, and the
 * decision was still deliverable, because neither of those touches Foundry. The
 * only thing that needed the server back was the tool call afterwards, which is
 * exactly right: a `tool` step goes through Foundry by design (R2).
 */
async function waitForServer(timeoutMs = 90_000): Promise<boolean> {
  const base = process.env.FOUNDRY_BASE_URL ?? "http://127.0.0.1:4000";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * How much mail ops-api actually accepted.
 *
 * Read from the service, not from the flow. The whole assertion is that a paused
 * run has sent NOTHING, and a run reporting on itself is the self-report this
 * repo has been burned by. `records` throws if ops-api is unreachable, so an
 * outbox that cannot be read never reads as an empty one.
 */
async function mailCount(): Promise<number> {
  return (await opsClient.records("mail", 1000)).length;
}

/**
 * The flow under test: screen, then STOP for a person, then send.
 *
 * `notify` is last and depends on the gate, so "the emails have not been sent"
 * is a claim about the outbox that only holds if the Pause really is blocking.
 */
function gatedFlow(id: string): FlowModel {
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
        id: "confirm_send",
        kind: "approval",
        // ⚠ Note `| @json`. Without it this is I-11 and the run FAILS — measured,
        // on the first attempt at this file: `| first` unwraps a jq STRING into
        // raw text, so `"Send a warning to 11 employee(s)?"` lands in the JSON
        // body unquoted and Kestra rejects the task with
        // `JsonParseException: Unrecognized token 'Send'`, which names neither
        // the step nor the field. `@json` re-encodes the string WITH its quotes,
        // and escapes anything inside it, so the value is valid JSON whatever a
        // department happens to be called.
        summaryExpr:
          "{{ json(outputs.screen.body).results[0].data " +
          "| jq('(\"Send an attendance warning to \" + (length|tostring) + \" employee(s)?\") | @json') " +
          "| first }}",
        // The EVIDENCE, not a count. An approver asked to approve "10 emails"
        // without knowing to whom is being asked to rubber-stamp.
        contextExpr:
          "{{ json(outputs.screen.body).results[0].data " +
          "| jq('{recipients: [.[] | {name: .full_name, email: .work_email, rate: .attendance_rate}]}') " +
          "| first }}",
        dependsOn: ["screen"],
        awaitSeconds: 900,
      },
      {
        id: "notify",
        kind: "tool",
        ref: "mail_send",
        paramsExpr:
          "{{ json(outputs.screen.body).results[0].data " +
          '| jq(\'[.[] | select(.work_email != null) | {sender: "hr-bot@acme-hr.example", ' +
          'recipients: [.work_email], subject: "Attendance below policy", ' +
          'body: ("Hi " + .full_name + ".")}]\') | first }}',
        dependsOn: ["confirm_send"],
        timeoutSeconds: 120,
      },
    ],
  };
}

async function deploy(workspaceId: string, model: FlowModel) {
  const stale = await flowRepo.getByKestraFlowId(workspaceId, model.id);
  if (stale) await flowService.remove(workspaceId, stale.id);
  const created = await flowService.create(workspaceId, {
    name: `HITL ${model.id}`,
    model,
    author: systemAuthor("hitl-verify@acme-hr.example"),
  });
  return created.flow;
}

async function main() {
  console.log(`\n${"═".repeat(74)}\nGate 3 — the approval step  ${c.dim(`period ${PERIOD}`)}\n${"═".repeat(74)}`);

  const ws = (await workspaceRepo.list()).find((w) => w.name === "HR");
  if (!ws) throw new Error('workspace "HR" not found — run `pnpm demo:seed`');

  // ── 1. it pauses, and it sends NOTHING ────────────────────────────────────
  console.log(`\n${"─".repeat(74)}\n1  the flow stops at the gate and the outbox stays empty\n`);

  await opsClient.reset();
  const flow = await deploy(ws.id, gatedFlow("hitl-gated-screening"));
  const started = await flowService.testRun(ws.id, flow.id, { period: PERIOD });
  const pausedEx = await waitFor(started.kestraExecutionId, (e) => paused(e) || settled(e));

  check("the execution is PAUSED", pausedEx.state.current, "PAUSED");
  check(
    "…at the gate's await task",
    (pausedEx.taskRunList ?? []).find((t) => t.taskId === "confirm_send_await")?.state.current,
    "PAUSED",
  );
  check("…and `notify` has not run at all", (pausedEx.taskRunList ?? []).some((t) => t.taskId === "notify"), false);
  // The claim that matters, and it is a COUNT rather than the flow's own report.
  check("NOTHING was sent while the gate is open", await mailCount(), 0);

  const efx = await flowExecutionRepo.getByKestraId(pausedEx.id);
  if (!efx) throw new Error("no flow_executions row for the paused run");

  const pending = await stepApprovalService.listPending(ws.id);
  const mine = pending.find((p) => p.flowExecutionId === efx.id);
  checkThat("the request is in the inbox", !!mine, mine?.summary ?? "—");
  checkThat(
    "…with the EVIDENCE, not just a count",
    Array.isArray((mine?.context as { recipients?: unknown[] })?.recipients),
    `${((mine?.context as { recipients?: unknown[] })?.recipients ?? []).length} recipient(s)`,
  );

  // ── 2. the exit criterion: the wait outlives the API server ───────────────
  console.log(`\n${"─".repeat(74)}\n2  EXIT CRITERION — restart the API server mid-pause\n`);

  if (SKIP_RESTART) {
    console.log(c.warn("  SKIPPED (--skip-restart) — the exit criterion was NOT checked"));
  } else {
    // Restarting the container is the whole point: anything this script could do
    // in-process would be testing a mock of the failure. `restart` is right here
    // rather than `up -d` — no environment changed, and `restart` is the harsher
    // test because it does not rebuild.
    const t0 = Date.now();
    const r = spawnSync(
      "docker",
      ["compose", "-f", "../../infra/docker-compose.yml", "restart", "server"],
      { encoding: "utf8", timeout: 180_000 },
    );
    checkThat(
      "the API server was restarted",
      r.status === 0,
      r.status === 0 ? `${Math.round((Date.now() - t0) / 1000)}s` : (r.stderr ?? "").slice(0, 200),
    );
    // Assert the pause survived BEFORE waiting for the server: at this moment
    // the API server may still be down, and the run being PAUSED with nothing
    // listening on :4000 is the strongest form of the claim.
    const afterRestart = await kestra.getExecution(pausedEx.id);
    check("…and the run is STILL paused", afterRestart.state.current, "PAUSED");
    check("…still at the same task", (afterRestart.taskRunList ?? []).find((t) => t.taskId === "confirm_send_await")?.state.current, "PAUSED");
    check("…and still nothing sent", await mailCount(), 0);

    // Now let it come back, because the tool step after the gate does need
    // Foundry. Without this the run resumes into a refused connection — measured
    // on the first attempt, and it looked like a gate-3 failure.
    checkThat("…and the API server comes back", await waitForServer(), "serving");
  }

  // ── 3. approve → the decision ARRIVES, and the send happens ───────────────
  console.log(`\n${"─".repeat(74)}\n3  approve — the decision is delivered, not merely accepted\n`);

  const decided = await stepApprovalService.decide(ws.id, mine!.id, {
    decision: "approved",
    decidedBy: "hr-director@acme-hr.example",
    note: "checked the list",
  });
  check("the decision is recorded", decided.decision, "approved");
  checkThat("…and was delivered to the engine", !!decided.appliedAt, String(decided.appliedAt));

  const done = await waitFor(pausedEx.id, settled);
  check("the execution completes", done.state.current, "SUCCESS");
  // ⚠ Kestra accepts a JSON resume body with a 2xx and silently drops the
  // inputs (D-21). Asserting the 2xx would pass against that bug; asserting the
  // VALUE is what catches it.
  check(
    "the approver's decision reached the flow",
    ((done.taskRunList ?? []).find((t) => t.taskId === "confirm_send_await")?.outputs?.onResume as
      | Record<string, unknown>
      | undefined)?.decision,
    "approved",
  );
  const sent = await mailCount();
  // The control that makes "0 while paused" mean something: the flow does send
  // when allowed to, so the zero above was the gate and not a broken flow.
  checkThat("…and the send happened only AFTER approval", sent > 0, `${sent} email(s)`);

  const second = await stepApprovalService
    .decide(ws.id, mine!.id, { decision: "rejected", decidedBy: "someone-else@acme-hr.example" })
    .then(() => "accepted a second decision")
    .catch((e) => (e as { statusCode?: number }).statusCode);
  check("a decision cannot be revised", second, 409);

  // ── 4. reject — the dangerous path ────────────────────────────────────────
  console.log(`\n${"─".repeat(74)}\n4  reject — the run is KILLED, so the send can never happen\n`);

  await opsClient.reset();
  const flow2 = await deploy(ws.id, gatedFlow("hitl-gated-rejected"));
  const started2 = await flowService.testRun(ws.id, flow2.id, { period: PERIOD });
  const paused2 = await waitFor(started2.kestraExecutionId, (e) => paused(e) || settled(e));
  check("the second run is PAUSED", paused2.state.current, "PAUSED");

  const efx2 = await flowExecutionRepo.getByKestraId(paused2.id);
  const pending2 = (await stepApprovalService.listPending(ws.id)).find(
    (p) => p.flowExecutionId === efx2!.id,
  );
  const rejected = await stepApprovalService.decide(ws.id, pending2!.id, {
    decision: "rejected",
    decidedBy: "hr-director@acme-hr.example",
    note: "wrong period",
  });
  check("the rejection is recorded", rejected.decision, "rejected");

  const dead = await waitFor(paused2.id, settled, 60_000);
  // Resuming with decision="rejected" would have un-paused the execution and run
  // `notify`. It is KILLED instead, so there is no execution left to send with.
  check("the execution is KILLED, not resumed", dead.state.current, "KILLED");
  check("…`notify` never ran", (dead.taskRunList ?? []).some((t) => t.taskId === "notify"), false);
  check("NOTHING was sent on the rejected run", await mailCount(), 0);

  // I-10: a killed run never reaches `complete`, so nothing else closes the row —
  // and a `running` row holds an M3 budget slot. Five rejections would brick the
  // workspace through a fairness control.
  const row2 = await flowExecutionRepo.get(efx2!.id);
  check("the rejected run released its budget slot", row2?.status, "cancelled");
  checkThat("…and is stamped as ended", !!row2?.endedAt, String(row2?.endedAt));

  // ── 5. the gate TRAVELS ───────────────────────────────────────────────────
  console.log(`\n${"─".repeat(74)}\n5  a new step kind has to survive export → import (D-24)\n`);

  const bundle = await flowPortabilityService.exportFlow(ws.id, flow.id);
  const step = (bundle.model.steps as Array<Record<string, unknown>>).find((s) => s.id === "confirm_send");
  checkThat("the approval step is in the bundle", !!step, JSON.stringify(step).slice(0, 90));
  check("…with its question", (step as { summaryExpr?: string })?.summaryExpr !== undefined, true);
  check("…and its evidence expression", (step as { contextExpr?: string })?.contextExpr !== undefined, true);
  // `bundleStep` is an allowlist per kind, so a field only travels once somebody
  // writes it down. The DECISIONS deliberately do not: they are this tenant's
  // audit trail, and an import carrying them would arrive claiming somebody
  // elsewhere had already approved a run that never happened here.
  const serialised = JSON.stringify(bundle);
  check("no decision travelled with it", serialised.includes("hr-director@acme-hr.example"), false);
  check("…and no execution id did either", serialised.includes(efx.id), false);

  // ── cleanup ───────────────────────────────────────────────────────────────
  await flowService.remove(ws.id, flow.id).catch(() => {});
  await flowService.remove(ws.id, flow2.id).catch(() => {});

  console.log(`\n${"═".repeat(74)}`);
  console.log(
    failures === 0
      ? c.ok("gate 3: all assertions passed") +
          c.dim(
            "  — and it is still NOT separation of duties. Stage 9.1 made `decidedBy` VERIFIED on " +
              "the route (a signed identity, refused if sent in the body), and GAPS §1.1 added " +
              "ROLES: `requireWorkspaceRole('approver')` guards the decide route, so a signed-in " +
              "person who has not been granted the role in this workspace is refused. It is still " +
              "not separation of duties — anything holding RUNTIME_JWT_SECRET mints an identity, " +
              "and unlike gate 2 there is nobody to compare a decider against, because an " +
              "execution has no author. ⚠ This harness calls the SERVICE directly, so it bypasses " +
              "the role guard entirely: what it proves is the pause/resume/kill behaviour, not the " +
              "identity and not the authorisation.",
          )
      : c.bad(`${failures} assertion(s) FAILED`),
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(c.bad(`\nhitl-verify failed: ${(e as Error).message}`));
  console.error(e);
  process.exit(1);
});
