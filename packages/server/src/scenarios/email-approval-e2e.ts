/**
 * An email-oriented automation with a three-way condition and an APPROVAL on one path, created THROUGH CHAT and proven on Kestra
 * (2026-09-30). The goal is a person's first chat message (`flowChatService.turn`, the route's own function); the saved flow is
 * draft-run at the instants that take each path, and the approval is decided through `stepApprovalService.decide` — the function
 * the inbox's Approve / Reject call:
 *
 *   - the path with the gate PAUSES before its gated email, nothing gated has run; APPROVE → the run completes and the email ran;
 *   - the same instant again, REJECT → the run is killed and the gated email NEVER runs;
 *   - the other two paths run with no pause, and only their own steps run (both directions: a flow running every path fails).
 *
 * The runs are LIVE — the flow approved (gate 2), a manual trigger enabled after one draft run (gate 1), fired with each date —
 * because a draft reads MOCK data (10 generated rows a table; at most one invoice is ever overdue in it), where the first two
 * paths can never run. Live reads finance_demo, measured: 2026-06-30 → 15 overdue, 2026-05-31 → 6, 2026-04-30 → 0. Everything the
 * flow calls is simulated even live: `test_email_send` is captured in Foundry's Email box and delivered to nobody; tickets go to
 * ops-api. The flow is revoked and deleted at the end.
 *
 *   ./scripts/harness-in-net.sh packages/server/src/scenarios/email-approval-e2e.ts
 *
 * ⚠ Model calls (the chat's own). Every flow and thread it creates is DELETED at the end. `main()` runs at import.
 */
import { decideTest, type EFlow } from "@foundry/flow-edit";
import { flowChatService } from "../services/flow-chat.service.js";
import { flowChatRepo } from "../repositories/flow-chat.repo.js";
import { flowService } from "../services/flow.service.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { stepApprovalService } from "../services/step-approval.service.js";
import { canvasOpen, type CanvasView } from "../services/builder/canvas.service.js";
import { resolveGenerationProvider } from "../services/generation-provider.service.js";
import { kestra, type KestraExecution } from "../services/kestra-client.service.js";
import { flowApprovalService } from "../services/flow-approval.service.js";
import { triggerService } from "../services/trigger.service.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { runDraft, stepReport } from "./kestra-draft-run.js";

const AUTHOR = { createdBy: "email-approval-e2e", createdByKind: "system" as const };
export const GOAL =
  'Check the invoices overdue as of the date I give. If more than 10 are overdue, send a test email of them to ap-team@microland.com ' +
  'from finance-bot@microland.com with the subject "Overdue invoices over 10" — ask me to approve it first — and open a ticket titled ' +
  '"Overdue invoices over 10"; otherwise, if at least 1 is overdue, send a test email of them to finance-ops@microland.com from ' +
  'finance-bot@microland.com with the subject "Overdue invoices"; otherwise send a test email to finance-ops@microland.com from ' +
  'finance-bot@microland.com with the subject "All clear" saying "All invoices are current".';
const AT = { many: "2026-06-30", some: "2026-05-31", none: "2026-04-30" };

let failed = 0;
const ok = (c: boolean, what: string) => { console.log(`  ${c ? "ok  " : "FAIL"} ${what}`); if (!c) failed++; };
const SETTLED = ["SUCCESS", "FAILED", "KILLED", "WARNING"];
async function settle(id: string): Promise<KestraExecution> {
  for (const end = Date.now() + 240_000; Date.now() < end; ) {
    const ex = await kestra.getExecution(id);
    if (SETTLED.includes(ex.state.current)) return ex;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`execution ${id} did not settle`);
}
const ran = (ex: KestraExecution, id: string) => (ex.taskRunList ?? []).some((t) => t.taskId === id && t.state.current === "SUCCESS");

async function main() {
  const provider = await resolveGenerationProvider();
  console.log(`email + approval e2e · model ${provider.model} (${provider.source})\n“${GOAL}”`);
  const ws = (await workspaceRepo.list()).find((w) => w.name === "Finance" && !w.deletedAt)?.id;
  if (!ws) { ok(false, "Finance workspace missing"); process.exit(1); }
  let flowId: string | undefined, threadId: string | undefined;
  try {
    const thread = await flowChatService.createThread(ws, { name: `email approval e2e ${Date.now().toString(36)}` } as never, AUTHOR);
    threadId = thread.id;
    const out = await flowChatService.turn(ws, thread.id, { message: GOAL }, AUTHOR);
    flowId = out.flowId ?? undefined;
    console.log(`  turn: ${out.turn.status}\n    ${((out.turn.findingsJson as string[] | undefined) ?? []).join("\n    ")}`);
    ok(out.turn.status === "applied" && !!flowId, "the chat turn built and saved it");
    if (!flowId || out.turn.status !== "applied") return;

    // ── the shape, read off the saved flow ──
    const f: EFlow = ((await canvasOpen(ws, flowId)) as CanvasView).state;
    const kind = (id: string) => f.steps.find((s) => s.id === id)?.kind;
    const heads = f.steps.filter((s) => s.kind === "branch" && !s.elseOf);
    const chain = (b: string): string[] => { const n = f.steps.find((s) => s.kind === "branch" && s.elseOf === b); return [b, ...(n ? chain(n.id) : [])]; };
    const links = heads.length ? chain(heads[0]!.id) : [];
    // "at least 1 overdue" and "has rows" are one test, so the ELSE IF may be either; the IF must compare the count.
    const cond = (b: string) => (f.steps.find((s) => s.id === b) as Extract<EFlow["steps"][number], { kind: "branch" }>).conditions ?? [];
    ok(links.length === 3 && !!decideTest(f, cond(links[0]!)[0]?.left.stepId ?? "") && cond(links[1]!).length > 0 && !cond(links[2]!).length,
      `a three-way condition: IF on the count, ELSE IF, then an otherwise (${links.join(" → ") || "none"})`);
    const onPath = (b: string) => f.steps.filter((s) => s.dependsOn.includes(b) || f.steps.some((g) => g.kind === "approval" && g.dependsOn.includes(b) && s.dependsOn.includes(g.id)));
    const gate = f.steps.find((s) => s.kind === "approval");
    const gated = gate ? f.steps.filter((s) => s.dependsOn.includes(gate.id)) : [];
    ok(!!gate && !!links[0] && gate.dependsOn.includes(links[0]), `an approval on the first path (${gate?.id ?? "none"})`);
    ok(gated.length > 0 && gated.every((s) => s.kind === "tool" && s.ref === "test_email_send"), `…gating its test email (${gated.map((s) => `${s.id}:${s.kind === "tool" ? s.ref : s.kind}`).join(", ")})`);
    const mails = f.steps.filter((s) => s.kind === "tool" && s.ref === "test_email_send");
    ok(mails.length === 3 && links.every((b) => onPath(b).some((s) => s.kind === "tool" && s.ref === "test_email_send")), `a test email on every path (${mails.length})`);
    ok(!f.steps.some((s) => s.kind === "tool" && s.ref === "foundry_email_send"), "nothing sends real mail");
    const input = f.inputs.find((i) => !i.computed);
    const at = (day: string) => (input ? { [input.id]: day } : {});

    // ── 0. gate 1: one draft run (mock data — the otherwise path); gate 2: approve; a manual trigger to run it live ──
    console.log("\n0  draft run, approve, arm");
    const draft = await runDraft(ws, flowId, at(AT.none));
    console.log(`    ${stepReport(draft)}`);
    ok(draft.state.current === "SUCCESS", `the draft run completes (${draft.state.current})`);
    const row = await flowRepo.get(ws, flowId);
    const armed = await flowApprovalService.approve(ws, flowId, { revision: row!.draftRevision, approverUserId: "finance-lead@microland.com", approverKind: "client_admin", note: "email-approval-e2e" } as never);
    ok((armed.flow.armedRevision ?? 0) > 0, `the flow is approved and armed (revision ${armed.flow.armedRevision})`);
    const trig = await triggerService.createForFlow(ws, flowId, { name: "email approval e2e", type: "manual", enabled: false } as never);
    await triggerService.update(trig.id, { enabled: true } as never);
    const run = async (day: string): Promise<KestraExecution> => {
      const r = await triggerService.fire(trig.id, "manual", undefined, at(day));
      if (!r.kestraExecutionId) throw new Error(`the fire started nothing: ${r.error}`);
      for (const end = Date.now() + 240_000; Date.now() < end; ) {
        const ex = await kestra.getExecution(r.kestraExecutionId);
        if (SETTLED.includes(ex.state.current) || ex.state.current === "PAUSED") return ex;
        await new Promise((res) => setTimeout(res, 1500));
      }
      throw new Error("the live run did not settle");
    };
    const pathSteps = links.map((b) => onPath(b).filter((s) => kind(s.id) === "tool").map((s) => s.id));
    const only = (ex: KestraExecution, k: number, label: string) => {
      ok(pathSteps[k]!.every((id) => ran(ex, id)), `${label}: its steps ran (${pathSteps[k]!.join(", ")})`);
      const others = pathSteps.flatMap((p, j) => (j === k ? [] : p));
      ok(others.every((id) => !ran(ex, id)), `${label}: no other path's step ran`);
    };

    // ── 1. many → PAUSED at the gate; approve → it completes, the gated email ran ──
    console.log(`\n1  ${AT.many}: the escalation path pauses; APPROVE`);
    const p1 = await run(AT.many);
    console.log(`    ${stepReport(p1)}`);
    ok(p1.state.current === "PAUSED", `the run PAUSES (${p1.state.current})`);
    ok(gated.every((s) => !ran(p1, s.id)), "…and nothing gated has run");
    const e1 = await flowExecutionRepo.getByKestraId(p1.id);
    const pend1 = (await stepApprovalService.listPending(ws)).find((p) => p.flowExecutionId === e1?.id);
    ok(!!pend1, "…and the approval is in the inbox");
    if (pend1) {
      const d = await stepApprovalService.decide(ws, pend1.id, { decision: "approved", decidedBy: "finance-lead@microland.com", note: "checked the list" });
      ok(d.decision === "approved" && !!d.appliedAt, "the approval is recorded and delivered to the engine");
      const done = await settle(p1.id);
      console.log(`    ${stepReport(done)}`);
      ok(done.state.current === "SUCCESS", `the run completes (${done.state.current})`);
      only(done, 0, "approved");
    }

    // ── 2. many again → REJECT → killed, the gated email never runs ──
    console.log(`\n2  ${AT.many}: REJECT`);
    const p2 = await run(AT.many);
    ok(p2.state.current === "PAUSED", `the run PAUSES (${p2.state.current})`);
    const e2 = await flowExecutionRepo.getByKestraId(p2.id);
    const pend2 = (await stepApprovalService.listPending(ws)).find((p) => p.flowExecutionId === e2?.id);
    if (pend2) {
      await stepApprovalService.decide(ws, pend2.id, { decision: "rejected", decidedBy: "finance-lead@microland.com", note: "not this week" });
      const done = await settle(p2.id);
      console.log(`    ${stepReport(done)}`);
      ok(done.state.current === "KILLED", `the run is killed (${done.state.current})`);
      ok(gated.every((s) => !ran(done, s.id)), "…and the gated email NEVER ran");
    } else ok(false, "the second approval is in the inbox");

    // ── 3. the other paths: no pause, only their own steps ──
    for (const [k, day] of [[1, AT.some], [2, AT.none]] as const) {
      console.log(`\n3  ${day}: path ${k + 1}`);
      const ex = await run(day);
      console.log(`    ${stepReport(ex)}`);
      ok(ex.state.current === "SUCCESS", `the run completes with no pause (${ex.state.current})`);
      only(ex, k, `path ${k + 1}`);
    }
  } catch (e) { ok(false, `threw: ${(e as Error).message.slice(0, 400)}`); }
  finally {
    if (flowId) await flowApprovalService.revoke(ws, flowId, { reason: "email-approval-e2e done" } as never).catch(() => {});
    if (flowId) await flowService.remove(ws, flowId).catch(() => {});
    if (threadId) await flowChatRepo.deleteThread(ws, threadId).catch(() => {});
    console.log(`\n(flow and thread deleted)`);
  }
  console.log(failed ? `\n${failed} FAILED` : "\nall ok");
  process.exit(failed ? 1 : 0);
}
await main();
