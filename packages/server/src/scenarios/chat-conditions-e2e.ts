/**
 * Creating workflows with conditions THROUGH CHAT, end to end (compiled-builder phase C, the exit gate's chat half). Each goal is a
 * person's first message on a new chat thread — `flowChatService.turn`, the function the chat route calls — so it is routed,
 * understood, built by the solver, and saved through `writeRevision` exactly as from the panel. The saved flow is then run as a
 * DRAFT on Kestra, and the path that ran is checked against an ORACLE: each condition's typed test (read back from the saved flow
 * by the engine, `decideTest` / `splitSide`) re-evaluated by the engine's own evaluator over the rows the run itself read. A path
 * must run exactly when its test holds — both directions, so a flow that runs every path cannot pass.
 *
 *   ./scripts/harness-in-net.sh packages/server/src/scenarios/chat-conditions-e2e.ts
 *
 * ⚠ Model calls (the chat's own: route + understand + shape + wiring). Every flow and thread it creates is DELETED at the end.
 * ⚠ `main()` runs at import — never import this from a test.
 */
import { decideTest, evaluate, splitSide, withContext, type Comb, type EFlow } from "@foundry/flow-edit";
import { flowChatService } from "../services/flow-chat.service.js";
import { flowChatRepo } from "../repositories/flow-chat.repo.js";
import { flowService } from "../services/flow.service.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { canvasOpen, type CanvasView } from "../services/builder/canvas.service.js";
import { resolveGenerationProvider } from "../services/generation-provider.service.js";
import { runDraft, stepReport } from "./kestra-draft-run.js";
import { kestra } from "../services/kestra-client.service.js";

const AUTHOR = { createdBy: "chat-conditions-e2e", createdByKind: "system" as const };
const GOALS: Array<{ workspace: string; goal: string; want: "decide" | "split" }> = [
  { workspace: "Finance", want: "decide", goal: 'Every Monday at 8, if more than 5 invoices are overdue as of today, post them to #ap-alerts; otherwise post "Few overdue invoices" to #finance-ops.' },
  { workspace: "Finance", want: "split", goal: "Every Monday at 8, split the invoices overdue as of today: those more than 30 days past due are posted to #ap-alerts, the rest to #finance-ops." },
  { workspace: "Finance", want: "decide", goal: 'Every Monday at 8, if at least 1 invoice is overdue as of today, post them to #ap-alerts; otherwise post "All clear" to #finance-ops.' },
  { workspace: "Orders & Fulfilment", want: "decide", goal: 'Every morning at 7, if the total of lines outstanding across orders past their promise as of today is over 20, post "Backlog over 20 lines" to #fulfilment.' },
];

let failed = 0;
const ok = (c: boolean, what: string) => { console.log(`  ${c ? "ok  " : "FAIL"} ${what}`); if (!c) failed++; };

/** A task's output as JSON: a step envelope's rows (`results[0].data`), or the transform's own value. */
function outputOf(outputs: Record<string, unknown> | undefined): unknown {
  const raw = outputs?.value ?? outputs?.body;
  if (raw === undefined) return undefined;
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    const env = v as { results?: Array<{ data?: unknown }> };
    return Array.isArray(env?.results) ? env.results[0]?.data : v;
  } catch { return undefined; }
}

async function main() {
  const provider = await resolveGenerationProvider();
  console.log(`chat conditions e2e · model ${provider.model} (${provider.source})`);
  const wss = new Map((await workspaceRepo.list()).filter((w) => !w.deletedAt).map((w) => [w.name, w.id]));
  const made: Array<{ ws: string; flowId: string }> = [];
  const threads: Array<{ ws: string; id: string }> = [];
  let decideIfRan = false, otherwiseRan = false; // CONTROL: across the goals, a Decide's IF path and an otherwise both ran
  try {
    for (const g of GOALS) {
      const ws = wss.get(g.workspace);
      console.log(`\n${g.workspace} — “${g.goal}”`);
      if (!ws) { ok(false, "workspace missing"); continue; }
      const thread = await flowChatService.createThread(ws, { name: `chat conditions e2e ${Date.now().toString(36)}` } as never, AUTHOR);
      threads.push({ ws, id: thread.id });
      const out = await flowChatService.turn(ws, thread.id, { message: g.goal }, AUTHOR);
      if (out.flowId) made.push({ ws, flowId: out.flowId });
      console.log(`    turn: ${out.turn.status} — ${(out.turn.findingsJson as string[] | undefined)?.slice(0, 3).join(" | ") ?? ""}`);
      ok(out.turn.status === "applied" && !!out.flowId, `the chat turn built and saved it (${out.turn.status})`);
      if (!out.flowId || out.turn.status !== "applied") continue;
      const v = (await canvasOpen(ws, out.flowId)) as CanvasView;
      const f: EFlow = v.state;
      const branches = f.steps.filter((s): s is Extract<EFlow["steps"][number], { kind: "branch" }> => s.kind === "branch");
      const tests = branches.flatMap((b) => (b.conditions ?? []).map((c) => ({ b, op: c.op, subject: c.left.stepId, decide: decideTest(f, c.left.stepId), split: splitSide(f, c.left.stepId) })));
      ok(tests.some((t) => (g.want === "decide" ? t.decide : t.split)), `the saved flow has a ${g.want} (${tests.map((t) => (t.decide ? "decide" : t.split ? "split" : "has_rows")).join(", ") || "no condition"})`);
      // The run's inputs as a person gives them when they test-run: each declared, non-computed date input at an instant. Two
      // instants, far apart, so the paths can fall on different sides (the exit gate's "two instants"). ⚠ A SCHEDULED flow gets no
      // such value — I-352, recorded in the plan: "as of today" on a schedule is declared as an input nobody supplies.
      const ran = new Set<string>();
      for (const day of ["2026-01-05", "2026-12-28"]) {
        const inputs = Object.fromEntries(f.inputs.filter((i) => !i.computed).map((i) => [i.id, i.type === "DATETIME" ? `${day}T12:00:00Z` : i.format === "month" ? day.slice(0, 7) : day]));
        console.log(`    at ${day}: ${JSON.stringify(inputs)}`);
        const ex = await runDraft(ws, out.flowId, inputs);
        console.log(`      ${stepReport(ex)}`);
        ok(ex.state.current === "SUCCESS", `the draft run settles SUCCESS (${ex.state.current})`);
        if (ex.state.current !== "SUCCESS") { const logs = await kestra.getExecutionLogs(ex.id, "WARN").catch(() => []) as Array<{ message?: string }>; console.log(`      logs: ${JSON.stringify(logs.map((l) => l.message)).slice(0, 600)}`); continue; }
        const task = (id: string) => (ex.taskRunList ?? []).find((t) => t.taskId === id && t.state.current === "SUCCESS");
        const armRan = (branchId: string) => f.steps.filter((s) => s.dependsOn.includes(branchId) && s.kind !== "branch").some((s) => !!task(s.id));
        // The oracle, per condition: its typed test over the rows the run read, in the engine's own evaluator.
        const ctx = { inputs: {}, values: {} };
        for (const t of tests) {
          let holds: boolean | null = null;
          if (t.decide) {
            const input = outputOf(task(t.decide.subject)?.outputs as Record<string, unknown> | undefined);
            // A row test is its filter (some row passes); any other Decide ends in its keep-if. A has-none condition holds on the opposite.
            const last = { op: t.decide.anyRow ? "filter" : "keep_if", where: t.decide.where } as Comb;
            if (input !== undefined) holds = (withContext(ctx, () => [...t.decide!.before, last].reduce<unknown>((x, st) => evaluate(x as never, st), input)) as unknown[]).length > 0 !== (t.op === "none");
          } else if (t.split) {
            const rows = outputOf(task(t.split.subject)?.outputs as Record<string, unknown> | undefined);
            const where = t.split.side === "matched" ? t.split.where : { not: t.split.where };
            if (Array.isArray(rows)) holds = (withContext(ctx, () => evaluate(rows as never, { op: "filter", where } as Comb)) as unknown[]).length > 0;
          } else continue;
          if (holds === null) { ok(false, `${t.b.id}: the rows its test reads are not in the run's outputs`); continue; }
          if (t.b.elseOf) continue; // an else-if runs only when its links before it did not hold; its chain's IF is checked
          const r = armRan(t.b.id);
          if (r) ran.add(t.b.id);
          if (r && t.decide) decideIfRan = true;
          ok(r === holds, `${t.b.id}${t.split ? ` (${t.split.side})` : ""}: its test ${holds ? "holds" : "does not hold"} on the run's own rows, and its path ${r ? "RAN" : "did not run"}`);
          const other = branches.find((x) => x.elseOf === t.b.id && !x.conditions?.length);
          if (other) { const o = armRan(other.id); if (o) { ran.add(other.id); otherwiseRan = true; } ok(o === !holds, `${other.id} (otherwise): ${o ? "ran" : "did not run"}, the opposite of ${t.b.id}`); }
        }
      }
      console.log(`    paths that ran at either instant: ${[...ran].join(", ") || "none"}`);
    }
    ok(decideIfRan && otherwiseRan, `CONTROL: a Decide's IF path ran on some run (${decideIfRan}) and an otherwise on another (${otherwiseRan}) — both sides were exercised`);
  } catch (e) { ok(false, `threw: ${(e as Error).message.slice(0, 400)}`); }
  finally {
    for (const m of made) await flowService.remove(m.ws, m.flowId).catch(() => {});
    for (const t of threads) await flowChatRepo.deleteThread(t.ws, t.id).catch(() => {});
    console.log(`\n(${made.length} flow(s) and ${threads.length} thread(s) deleted)`);
  }
  console.log(failed ? `\n${failed} FAILED` : "\nall ok");
  process.exit(failed ? 1 : 0);
}
await main();
