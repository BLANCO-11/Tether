/**
 * MEASURES whether a natural conditional request produces a GUARDED step.
 *
 * ⚠ The failure: asked *"if any of them are on the enterprise plan, post to the
 * #escalations channel"* on a flow ending at a transform, the builder added the
 * post UNGUARDED — because with sixteen ops there was no way to start a
 * condition on a step that did not exist yet. This scores the fix.
 *
 * The bar is deliberately the OUTCOME, not the op name: a flow where the new
 * step depends on a branch passes however it was built. Scoring `add_guarded_step`
 * by name would mark a correct two-op answer wrong.
 */
import { flowChatService } from "../services/flow-chat.service.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowService } from "../services/flow.service.js";
import type { FlowModel } from "../services/flow-compiler.service.js";

const WS = "Customer Support";
const ROUNDS = Number(process.argv.find((a) => a.startsWith("--rounds="))?.split("=")[1] ?? 3);
const AUTHOR = { createdBy: "conditional-measure", createdByKind: "system" as const };

/**
 * ⚠ The base flow is AUTHORED, not conversed into existence, and that is what
 * makes this a measurement of one thing. Asked cold, the builder's correct
 * first move is a `transform` that filters to the enterprise rows —
 * `EXPRESSION_RULES` tells it a tool step must not be handed a raw query row —
 * so a cold probe measures the projection step, not the guard. Here the
 * projection already exists and the only move left is the guarded call.
 */
const baseModel = (tag: string): FlowModel => ({
  id: tag,
  name: tag,
  inputs: [{ id: "as_of", type: "DATETIME", required: true }],
  steps: [
    {
      id: "breaching",
      kind: "datasource",
      ref: "support_demo.tickets_breaching_resolve",
      paramsExpr: '[{"as_of":"{{ inputs.as_of }}"}]',
    },
    {
      id: "enterprise_rows",
      kind: "transform",
      expr: "{{ json(outputs.breaching.body).results[0].data | jq('[.[] | select(.plan == \"enterprise\")]') | first }}",
      dependsOn: ["breaching"],
    },
  ],
} as unknown as FlowModel);

const PROBE = "if any of them are on the enterprise plan, post a message to the #escalations chat channel";

async function main() {
  const ws = (await workspaceRepo.list()).find((w) => w.name === WS);
  if (!ws) throw new Error(`no "${WS}" workspace`);
  console.log(`\nconditional:measure — does "if X, do Y" produce a GUARDED step?`);
  console.log(`workspace ${WS} · ${ROUNDS} round(s)\n`);

  let guarded = 0;
  let unguarded = 0;
  let other = 0;
  for (let i = 1; i <= ROUNDS; i++) {
    const tag = `cond-${Date.now()}-${i}`;
    let flowId: string | null = null;
    try {
      const created = await flowService.create(ws.id, { name: tag, model: baseModel(tag), author: AUTHOR });
      flowId = created.flow.id;
      const thread = await flowChatService.createThread(ws.id, { name: tag, flowId } as never, AUTHOR);
      const b = await flowChatService.turn(ws.id, thread.id, { message: PROBE }, AUTHOR);
      flowId = b.flowId ?? flowId;
      const op = (b.turn as { opJson?: { op?: string } }).opJson;

      const flow = await flowRepo.get(ws.id, flowId!);
      const rev = await flowRepo.getRevision(flow!.id, flow!.draftRevision);
      const steps = ((rev?.modelJson as { steps?: any[] })?.steps ?? []);
      const branches = new Set(steps.filter((s) => s.kind === "branch").map((s) => s.id));
      const added = steps.filter((s) => s.kind === "tool" || s.kind === "notify");
      const isGuarded = added.some((s) => (s.dependsOn ?? []).some((d: string) => branches.has(d)));

      if (b.turn.status !== "applied") { console.log(`  ${i}. ${b.turn.status}  op=${op?.op ?? "\u2014"}`); other++; }
      else if (isGuarded) { console.log(`  ${i}. GUARDED    op=${op?.op}  branches=${branches.size}`); guarded++; }
      else if (added.length) { console.log(`  ${i}. UNGUARDED  op=${op?.op}  branches=${branches.size}  \u2190 would run every execution`); unguarded++; }
      else { console.log(`  ${i}. no call added  op=${op?.op}  branches=${branches.size}`); other++; }
    } finally {
      if (flowId) await flowService.remove(ws.id, flowId).catch(() => {});
    }
  }
  console.log(`\n  guarded ${guarded} · unguarded ${unguarded} · other ${other}  (n=${ROUNDS})`);
  console.log(`  ⚠ scored on the OUTCOME — a step depending on a branch — not on which op was used.\n`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
