/**
 * Phase 3 — the approval gate, verified against the running stack.
 * archive/kestra-migration/progress/phase-3.md
 *
 *   pnpm --filter @foundry/server kestra:phase3
 *   pnpm --filter @foundry/server kestra:phase3 --period=2026-05
 *
 * Phase 3's exit criterion is two sentences:
 *
 *   "A new schedule cannot fire until a human approves it, AND editing an armed
 *    flow does not change what the schedule runs."
 *
 * Neither is provable from unit tests: the first is a property of what exists in
 * Kestra, and the second is a property of what is DEPLOYED there while Foundry's
 * draft moves. So this script drives the real services against the real engine
 * and reads the answers back out of Kestra.
 *
 * It also carries the compiler's own falsification (P0). `flow-compiler.service.ts`
 * arrived a phase early (DECISIONS.md D-16), so the first thing checked is that a
 * flow compiled from a MODEL still produces the oracle's answer — the same bar
 * Phase 1 set for the hand-written YAML. A compiler that emits deployable YAML
 * that computes the wrong thing would pass every other assertion here.
 *
 * Named after the design's verification list: 10, 11, 12, 13, 25.
 */
import { config } from "../config/index.js";
import { kestra, KestraError, type KestraExecution } from "../services/kestra-client.service.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { datasourceQueryRepo } from "../repositories/datasource-query.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { flowService } from "../services/flow.service.js";
import { flowApprovalService } from "../services/flow-approval.service.js";
import { flowCompiler } from "../services/flow-compiler.service.js";
import { tenantMapper } from "../services/tenant-mapper.service.js";
import { HR_GENERATED_QUERIES } from "../demo/hr-generated.js";
const HR_SCREENING_QUERIES = HR_GENERATED_QUERIES.filter((q) => ["policy_thresholds", "attendance_below_threshold", "attendance_excluded"].includes(q.name));
import { HR_SCREENING_MODEL } from "./hr-screening.model.js";
import { expectedScreening } from "../demo/hr-dataset.js";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import crypto from "node:crypto";
import { opsClient } from "../services/ops-client.service.js";
import { systemAuthor } from "../services/revision-author.js";

const PERIOD =
  process.argv.find((a) => a.startsWith("--period="))?.slice("--period=".length) ?? "2026-06";
/**
 * ⚠ A HARNESS author, and since archive/GAPS.md §1.2 the row says so: every revision
 * this file writes is stamped `created_by_kind: "system"` by `systemAuthor()`,
 * because nothing here holds a session. The self-approval refusal below still
 * fires against the NAME — see `flowApprovalService.approve` for why the
 * comparison was deliberately left alone rather than skipped for system
 * authors, which would have made P1's assertion pass by not running.
 */
const AUTHOR = systemAuthor("author@acme-hr.example");
const APPROVER = "approver@acme-hr.example";
const DATASOURCE_NAME = "hr_demo";

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
    `  ${pass ? c.ok("PASS") : c.bad("FAIL")}  ${label.padEnd(58)} ` +
      (pass ? c.dim(String(want)) : c.bad(`\n        got  ${got}\n        want ${want}`)),
  );
}

/** Assert a call is refused, and that the refusal says something useful. */
async function refuses(label: string, fn: () => Promise<unknown>, statusCode: number, match: RegExp) {
  try {
    await fn();
    failures++;
    console.log(`  ${c.bad("FAIL")}  ${label.padEnd(58)} ${c.bad("it was ALLOWED")}`);
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    const msg = (e as Error).message;
    const pass = code === statusCode && match.test(msg);
    if (!pass) failures++;
    console.log(
      `  ${pass ? c.ok("PASS") : c.bad("FAIL")}  ${label.padEnd(58)} ` +
        (pass ? c.dim(`${code}`) : c.bad(`got ${code} "${msg}"`)),
    );
  }
}

async function liveFlow(workspaceId: string, kestraFlowId: string) {
  const { live } = await flowService.namespaces(workspaceId);
  try {
    return await kestra.getFlow(live, kestraFlowId);
  } catch (e) {
    if (e instanceof KestraError && e.status === 404) return null;
    throw e;
  }
}

async function scheduleTriggerOf(workspaceId: string, kestraFlowId: string) {
  const flow = await liveFlow(workspaceId, kestraFlowId);
  return (flow?.triggers ?? []).find((t) => t.type?.endsWith("trigger.Schedule")) ?? null;
}

async function waitFor(executionId: string, timeoutMs = 180_000): Promise<KestraExecution> {
  const deadline = Date.now() + timeoutMs;
  let ex = await kestra.getExecution(executionId);
  while (Date.now() < deadline) {
    if (["SUCCESS", "FAILED", "KILLED", "WARNING"].includes(ex.state.current)) return ex;
    await new Promise((r) => setTimeout(r, 1200));
    ex = await kestra.getExecution(executionId);
  }
  return ex;
}

function stepRows<T>(execution: KestraExecution, taskId: string): T[] {
  const raw = (execution.taskRunList ?? []).find((t) => t.taskId === taskId)?.outputs?.body;
  if (typeof raw !== "string") return [];
  try {
    return ((JSON.parse(raw) as { results?: Array<{ data?: T[] }> }).results?.[0]?.data ?? []) as T[];
  } catch {
    return [];
  }
}

async function main() {
  console.log(`\nPhase 3 — the approval gate\n${"═".repeat(72)}`);

  const all = await workspaceRepo.list();
  const ws = all.find((w) => w.name === "HR");
  if (!ws) throw new Error('workspace "HR" not found — run `pnpm demo:seed` first');
  const ns = tenantMapper.namespacesFor(ws);

  const health = await kestra.health();
  if (!health.reachable) throw new Error(`Kestra unreachable at ${health.baseUrl}: ${health.detail}`);
  if (!health.authenticated) throw new Error(`Kestra rejected KESTRA_AUTH: ${health.detail}`);
  if (!config.kestra.callbackSecret) {
    throw new Error("KESTRA_CALLBACK_SECRET is unset — POST /api/executions/begin refuses everything");
  }
  console.log(`workspace HR   ${c.dim(`${ns.tenantSlug}.${ns.slug}`)}`);
  console.log(`live           ${c.dim(ns.live.value)}`);
  console.log(`draft          ${c.dim(ns.draft.value)}`);
  console.log(`kestra         ${c.dim(`${health.edition} ${health.version} @ ${health.baseUrl}`)}\n`);

  // ── setup ────────────────────────────────────────────────────────────────
  const datasources = await datasourceRepo.listByWorkspace(ws.id);
  const ds = datasources.find((d) => d.name === DATASOURCE_NAME);
  if (!ds) throw new Error(`datasource "${DATASOURCE_NAME}" not found in workspace HR`);
  for (const q of HR_SCREENING_QUERIES) {
    await datasourceQueryRepo.upsertByName({
      datasourceId: ds.id,
      name: q.name,
      description: q.description,
      sqlText: q.sqlText,
      paramOrder: q.paramOrder,
      paramsSchema: q.paramsSchema,
    });
  }

  // Clean slate. A leftover flow from a previous run would make "no live flow
  // before approval" pass or fail for the wrong reason.
  const stale = await flowRepo.getByKestraFlowId(ws.id, HR_SCREENING_MODEL.id);
  if (stale) await flowService.remove(ws.id, stale.id);

  const mailTool = await toolRepo.getByName(ws.id, "mail_send");
  if (!mailTool) throw new Error('tool "mail_send" not found in workspace HR');
  const mailToolParams = mailTool.paramsSchema;

  // ── 0. the compiler reproduces Phase 1's answer ──────────────────────────
  console.log(`${"─".repeat(72)}\nP0  the COMPILED flow still beats the oracle  ${c.dim(`(period ${PERIOD})`)}\n`);

  const created = await flowService.create(ws.id, {
    name: "HR attendance screening (compiled)",
    model: HR_SCREENING_MODEL,
    author: AUTHOR,
  });
  const flowId = created.flow.id;
  check("revision 1 written", created.revision.revision, 1);

  await opsClient.reset();
  const testRun = await flowService.testRun(ws.id, flowId, { period: PERIOD });
  const draftExec = await waitFor(testRun.kestraExecutionId);
  check("draft execution state", draftExec.state.current, "SUCCESS");

  const oracle = expectedScreening(PERIOD);
  const flagged = stepRows<{ employee_id: number }>(draftExec, "screen");
  check(
    "flagged employees match the oracle",
    flagged.map((f) => Number(f.employee_id)).sort((a, b) => a - b).join(","),
    oracle.flagged.map((f) => f.id).sort((a, b) => a - b).join(","),
  );
  const mailed = await opsClient.records("mail", 1000);
  check(
    "emails actually sent, counted in ops-api's mail_outbox",
    String(mailed.length),
    String(oracle.flagged.filter((f) => f.email).length),
  );

  const fx = await flowExecutionRepo.getByKestraId(draftExec.id);
  check("flow_executions row is bound to the flow", fx?.flowId, flowId);
  check("…and records the revision that ran", fx?.flowRevision, 1);

  // ── 10. a new schedule cannot fire until a human approves it ─────────────
  console.log(`\n${"─".repeat(72)}\n10  a new schedule cannot fire until a human approves it\n`);

  const draftDeployed = await kestra.getFlow(ns.draft, HR_SCREENING_MODEL.id);
  check("the draft namespace carries NO trigger", (draftDeployed.triggers ?? []).length, 0);
  check("nothing is deployed live yet", await liveFlow(ws.id, HR_SCREENING_MODEL.id), null);

  await refuses(
    "an author cannot approve their own revision",
    () => flowApprovalService.approve(ws.id, flowId, { revision: 1, approverUserId: AUTHOR.createdBy, approverKind: "client_admin" }),
    409,
    /cannot approve it/,
  );

  const approved = await flowApprovalService.approve(ws.id, flowId, {
    revision: 1,
    approverUserId: APPROVER,
    approverKind: "client_admin",
    note: "phase3-verify",
  });
  check("flow is armed at revision 1", approved.flow.armedRevision, 1);
  check("flow status", approved.flow.status, "armed");

  const trigger = await scheduleTriggerOf(ws.id, HR_SCREENING_MODEL.id);
  check("a Schedule trigger now exists in Kestra", trigger?.type, "io.kestra.plugin.core.trigger.Schedule");
  check("…with the model's cron", trigger?.cron, HR_SCREENING_MODEL.schedule!.cron);
  check("…and is not merely disabled", trigger?.disabled ?? false, false);

  // The deployed YAML is byte-for-byte what Foundry compiled for revision 1.
  const liveSource1 = await kestra.getFlowSource(ns.live, HR_SCREENING_MODEL.id);
  const liveHash1 = "sha256:" + crypto.createHash("sha256").update(liveSource1).digest("hex");
  const rev1 = await flowRepo.getRevision(flowId, 1);
  const recompiled1 = flowCompiler.compile(rev1!.modelJson as typeof HR_SCREENING_MODEL, {
    namespace: ns.live,
    withSchedule: true,
    labels: { foundry_flow: flowId, foundry_revision: "1", foundry_env: "live" },
  });
  check("live YAML is exactly revision 1, recompiled", liveHash1, recompiled1.hash);

  // ── 11. editing an armed flow does not change what the schedule runs ─────
  console.log(`\n${"─".repeat(72)}\n11  editing an armed flow does not change what the schedule runs\n`);

  const edited = {
    ...HR_SCREENING_MODEL,
    steps: HR_SCREENING_MODEL.steps.filter((s) => s.id !== "excluded"),
  };
  const rev2 = await flowService.saveRevision(ws.id, flowId, { model: edited, author: AUTHOR });
  check("the edit produced a NEW revision", rev2.revision.revision, 2);
  check("the armed revision did not move", rev2.flow.armedRevision, 1);
  check("status says a draft is waiting", rev2.flow.status, "draft_pending");

  const liveSource2 = await kestra.getFlowSource(ns.live, HR_SCREENING_MODEL.id);
  check("live YAML is byte-identical after the edit", liveSource2 === liveSource1, true);
  check("the live trigger survived the edit", (await scheduleTriggerOf(ws.id, HR_SCREENING_MODEL.id))?.cron, HR_SCREENING_MODEL.schedule!.cron);

  const draftSource2 = await kestra.getFlowSource(ns.draft, HR_SCREENING_MODEL.id);
  check("…while the DRAFT namespace did change", draftSource2.includes('"excluded"'), false);

  const diff = await flowApprovalService.diff(ws.id, flowId, 1, 2);
  check("the diff names the removed step", diff.removed.join(","), "excluded");
  check("…and calls it a structure change", diff.requires, "human_reapproval");

  // ── 12. a referenced tool changes shape → approval stale → suspend ───────
  console.log(`\n${"─".repeat(72)}\n12  a referenced tool changes shape → approval stale → schedule suspends\n`);

  await toolRepo.update(ws.id, mailTool.id, {
    paramsSchema: {
      ...((mailToolParams as Record<string, unknown>) ?? {}),
      // The §6.5 case, exactly: a tool the approver signed off on gains a
      // required parameter, so the approved flow is now wrong — and nothing
      // about the flow changed, which is why only the manifest can detect it.
      cost_centre: { type: "string", required: true },
    },
  });

  const swept = await flowApprovalService.sweepStaleness();
  // Asserts that the sweep suspended THIS flow, not that it suspended exactly one.
  //
  // It used to read `swept.suspended === 1`, and that was wrong in a way worth
  // recording: the sweep is global, so the assertion silently depended on this
  // being the only armed flow in the instance that referenced `mail_send`. The
  // moment Stage 2 seeded a second one, a completely correct sweep — it suspended
  // both flows, because both were approved against the old tool shape — was
  // reported as a phase 3 regression. A global count is not a claim about the
  // behaviour under test.
  check("the sweep suspended THIS flow", swept.suspendedFlowIds.includes(flowId), true);

  const afterSweep = await flowRepo.get(ws.id, flowId);
  check("flow status", afterSweep?.status, "suspended");
  check("the approval is marked stale", (await flowRepo.currentApproval(flowId, 1)) ?? null, null);
  check("the Schedule trigger is gone from Kestra", await scheduleTriggerOf(ws.id, HR_SCREENING_MODEL.id), null);
  check("…but the live flow itself is still there", (await liveFlow(ws.id, HR_SCREENING_MODEL.id)) !== null, true);

  // Belt and braces: even a MANUAL live start is refused at step 1.
  const refused = await kestra.startExecution(ns.live, HR_SCREENING_MODEL.id, { period: PERIOD }, {});
  const refusedEx = await waitFor(refused.id, 60_000);
  check("a manual live execution fails at begin", refusedEx.state.current, "FAILED");
  check("…and no flow_executions row was created", await flowExecutionRepo.getByKestraId(refused.id), undefined);

  // Put the tool back, so the workspace is left as it was found.
  await toolRepo.update(ws.id, mailTool.id, { paramsSchema: mailToolParams });

  // ── 13 + 25. revoke → no further firings; the trigger is REMOVED ─────────
  console.log(`\n${"─".repeat(72)}\n13/25  revoke → no further firings, and the trigger is REMOVED not flagged\n`);

  const reapproved = await flowApprovalService.approve(ws.id, flowId, {
    revision: 2,
    approverUserId: APPROVER,
    approverKind: "client_admin",
  });
  check("re-approval arms revision 2", reapproved.flow.armedRevision, 2);
  check("the trigger is back", (await scheduleTriggerOf(ws.id, HR_SCREENING_MODEL.id))?.cron, HR_SCREENING_MODEL.schedule!.cron);

  const revoked = await flowApprovalService.revoke(ws.id, flowId, { reason: "phase3-verify" });
  check("one approval was closed", revoked.revoked, 1);
  check("flow status", revoked.flow.status, "suspended");

  const liveAfterRevoke = await liveFlow(ws.id, HR_SCREENING_MODEL.id);
  check("triggers array is EMPTY, not disabled", (liveAfterRevoke?.triggers ?? []).length, 0);
  check(
    "the word 'Schedule' is absent from the deployed YAML",
    (await kestra.getFlowSource(ns.live, HR_SCREENING_MODEL.id)).includes("trigger.Schedule"),
    false,
  );
  const afterRevoke = (await flowRepo.get(ws.id, flowId))!;
  await refuses(
    "begin refuses a live run of a revoked flow",
    () => flowApprovalService.assertMayRunLive(ws.id, afterRevoke),
    403,
    /not currently approved/,
  );

  // ── teardown ─────────────────────────────────────────────────────────────
  await flowService.remove(ws.id, flowId);
  check("cleanup: the flow is gone from Kestra", await liveFlow(ws.id, HR_SCREENING_MODEL.id), null);

  console.log(`\n${"═".repeat(72)}`);
  console.log(
    failures === 0
      ? c.ok("\n  all Phase 3 assertions passed (10, 11, 12, 13, 25 + the compiler's own oracle)\n")
      : c.bad(`\n  ${failures} assertion(s) FAILED\n`),
  );
  if (failures) process.exit(1);
}

main().catch((e) => {
  if (e instanceof KestraError) {
    console.error(c.bad(`\nKestra error ${e.status}:`), e.message);
    console.error(JSON.stringify(e.body, null, 2)?.slice(0, 2000));
  } else {
    console.error(c.bad("\nfailed:"), (e as Error).message);
    console.error((e as Error).stack);
  }
  process.exit(1);
});
