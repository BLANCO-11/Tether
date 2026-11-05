/**
 * `builder:measure` — the ONE builder (compiled-builder phase 4, task 5) over the labelled goal set, scored exactly as
 * `goalset:measure` scores the old path (`scoreBuild`, D-309), so the two numbers compare like for like.
 *
 *   pnpm --filter @foundry/server builder:measure --goals=dev.json,regression.json --out=rows.json [--rounds=2] [--only=D01]
 *   … --gate --gate-log=<file>      (required for a held-out goal — the seal, D-313)
 *   … --replay=<rows.json> [--strip-asks]   NO model call: each goal's spec is the one a previous run saved (`row.spec`),
 *        re-checked by code (`recheck`) — so a SOLVER change is measured deterministically, apart from the model's variance.
 *        `--strip-asks` drops every `ask_person` value first: the experiment "code, not the model, decides what to ask".
 *
 * Per goal: `understand` (one strict call; the readback is CONFIRMED as-is — no correction, the harness has no opinion),
 * `run` with the label as the person (each question matched to a slot by code, `builder-slots.ts`, answered with the label's
 * answer or left unanswered), `save`, a DRAFT run of a complete flow, then the flow is deleted.
 *
 * Recorded beside the score (plan §7): M1 — a save the funnel refused (must be 0: the engine only reaches valid states);
 * M4 — D-294's loop rules over the trace; M5 — questions per build; M9 — model calls per build; reply-shape errors
 * (`GatewayDefect`: a reply outside its strict schema, never retried); and the per-move trace.
 *
 * ⚠ This is a MEASUREMENT: it exits non-zero only if it could not run or left flows behind. `main()` runs at import — never
 * import this file from a test; what is assertable lives in `builder-slots.ts` and `goalset-score.ts`.
 * ⚠ Model calls cost money. The model is printed beside every number, read from `resolveGenerationProvider()`.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { inference } from "../services/inference.service.js";
import * as builder from "../services/builder/builder.service.js";
import type { BuildQuestion, BuildTrace } from "../services/builder/build.js";
import { systemAuthor } from "../services/revision-author.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowService } from "../services/flow.service.js";
import { kestra } from "../services/kestra-client.service.js";
import { resolveGenerationProvider } from "../services/generation-provider.service.js";
import { typecheckFlow } from "../services/flow-typecheck.js";
import { runDraft } from "./kestra-draft-run.js";
import { coerce, harnessDefault, labelInputValue, scoreBuild, type Goal, type Score } from "./goalset-score.js";
import { conditionKinds, perItemKind, replyFor, slotOf, statusOf } from "./builder-slots.js";
import { sealCheck } from "../demo/heldout/seal.js";
import { contamination, promptExamples } from "./prompt-contamination.js";
import { goalSpecPrompt } from "../services/builder/goal-spec.js";
import { specTables } from "../services/builder/table-readers.js";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const flag = (k: string) => process.argv.includes(`--${k}`);
const GOALS = (arg("goals") ?? "").split(",").filter(Boolean);
const ROUNDS = Number(arg("rounds") ?? 2);
const ONLY = (arg("only") ?? "").split(",").filter(Boolean);
const OUT = arg("out");
const GATE = flag("gate");
const GATE_LOG = arg("gate-log");
const PREFIX = "builder-measure ";
const REPLAY = arg("replay");
const STRIP_ASKS = flag("strip-asks");

// Every inference call, whoever makes it: label, time, whether it threw. The builder's trace holds its own calls too; this
// also sees `understand`'s, and any call a failure cut short.
type Call = { label: string; ms: number; ok: boolean };
let calls: Call[] = [];
const orig = inference.complete.bind(inference);
(inference as unknown as { complete: typeof inference.complete }).complete = (async (prompt: string, opts?: { label?: string }) => {
  const t = Date.now();
  try { const r = await orig(prompt, opts as never); calls.push({ label: String(opts?.label ?? ""), ms: Date.now() - t, ok: true }); return r; }
  catch (e) { calls.push({ label: String(opts?.label ?? ""), ms: Date.now() - t, ok: false }); throw e; }
}) as typeof inference.complete;

interface Row {
  round: number; id: string; workspace: string; goal: string; outcomeLabel: string;
  harness?: string;
  readback?: string[]; dropped?: unknown; specOutcome?: string; spec?: unknown;
  questions: Array<{ holeId: string; ask: string; round: number; slot: string; reply: string | null; filled?: boolean }>;
  status?: string; message?: string; saveRefused?: string;
  trace?: BuildTrace; loopProblems?: string[];
  /** The engine state the build ended in — steps and holes, for reading WHY a build stalled. */
  final?: { steps: unknown[]; holes: Array<{ id: string; reason: string; owner: string }> };
  /** Phase C: the kinds of condition the build made (`conditionKinds`). */
  conditions?: ReturnType<typeof conditionKinds>;
  /** Phase F: how the build acts per item (`perItemKind`). */
  perItem?: ReturnType<typeof perItemKind>;
  flowId?: string; refs?: string[]; tables?: string[];
  inputs?: Record<string, { value: string; source: "label" | "harness-default" }>;
  typecheck?: { errors: string[]; warnings: string[] };
  run?: string; runError?: string;
  calls: Call[]; secs?: number;
  score?: Score;
}

async function main() {
  if (!GOALS.length || !OUT) throw new Error("need --goals=… and --out=…");
  const provider = await resolveGenerationProvider();
  console.log(`builder:measure · model ${provider.model} (${provider.source}) · rounds ${ROUNDS}`);
  const goals: Goal[] = GOALS.flatMap((p) => JSON.parse(readFileSync(p, "utf8")) as Goal[]).filter((g) => !ONLY.length || ONLY.includes(g.id));
  // ⚠ THE SEAL (D-313), before any model call: held-out goals run only at a logged gate.
  const refusal = sealCheck(goals, GATE, GATE_LOG);
  if (refusal) { console.error(refusal); process.exit(3); }
  // A prompt example copied from a goal being measured makes the number a memory test, not a build test. Refused before any model
  // call; reported by goal ID only, so a held-out goal's words are never printed.
  const dirty = contamination(promptExamples(goalSpecPrompt("x", { items: [] })), goals);
  if (dirty.length) { console.error(`refused: ${dirty.length} prompt example(s) appear in goals being measured — ${dirty.map((d) => `${d.goals.length} goal(s) [${d.goals.join(",")}]`).join("; ")}. Replace the examples.`); process.exit(3); }
  if (GATE && GATE_LOG) appendFileSync(GATE_LOG, `\n- gate run ${new Date().toISOString()} · builder · model ${provider.model} · goals ${goals.map((g) => g.id).join(",")} · out ${OUT}\n`);

  // Replay: the saved spec per goal id (round 1 of that run). A goal with none is skipped, stated — never re-asked of the model.
  const saved = new Map<string, unknown>();
  if (REPLAY) for (const r of (JSON.parse(readFileSync(REPLAY, "utf8")) as { rows: Array<{ id: string; round: number; spec?: unknown }> }).rows) if (r.round === 1 && r.spec) saved.set(r.id, r.spec);
  if (REPLAY) console.log(`replay of ${REPLAY} · ${saved.size} saved specs · model NOT called${STRIP_ASKS ? " · ask_person values stripped" : ""}`);
  const ws = new Map((await workspaceRepo.list()).filter((w: any) => !w.deletedAt).map((w: any) => [w.name, w.id as string]));
  const rows: Row[] = [];
  const touched = new Set<string>();

  for (let round = 1; round <= ROUNDS; round++) {
    for (const g of goals) {
      const wsId = ws.get(g.workspace);
      const row: Row = { round, id: g.id, workspace: g.workspace, goal: g.goal, outcomeLabel: g.label.outcome, questions: [], calls: [] };
      rows.push(row);
      if (!wsId) { row.harness = `no workspace "${g.workspace}"`; console.log(`r${round} ${g.id} SKIPPED — ${row.harness}`); continue; }
      touched.add(wsId);
      calls = [];
      const t0 = Date.now();
      let result: builder.RunResult | undefined;
      try {
        const { items, cat } = await builder.builderCatalogue(wsId);
        let understood: builder.Understood;
        if (REPLAY) {
          const spec = saved.get(g.id) as { values: Array<{ from: string }> } | undefined;
          if (!spec) { row.harness = "no saved spec to replay"; console.log(`r${round} ${g.id} SKIPPED — ${row.harness}`); continue; }
          const s = STRIP_ASKS ? { ...spec, values: spec.values.filter((v) => v.from !== "ask_person") } : spec;
          understood = builder.recheck({ goal: g.goal, texts: [g.goal], spec: s as never }, items);
        } else understood = await builder.understand(g.goal, items, builder.modelChooser);
        const u = builder.withDrafts(understood, cat); // D-324: drafts shown, then accepted
        row.readback = u.readback; row.dropped = u.checked.dropped; row.specOutcome = u.outcome; row.spec = u.checked.spec;
        // The label is the person: each question matched to its slot by code, answered with the label's answer or not at all.
        const taken = new Map<string, string>();
        const answerer = async (qs: BuildQuestion[]) => qs.map((q) => {
          const slot = slotOf(g, q, taken), reply = replyFor(g, slot);
          row.questions.push({ holeId: q.holeId, ask: q.ask, round: q.round, slot, reply });
          return reply;
        });
        result = await builder.run(u, items, cat, builder.modelChooser, answerer);
        row.trace = result.trace; row.loopProblems = result.loopProblems;
        if (result.understood) { row.readback = result.understood.readback; row.spec = result.understood.checked.spec; } // after the person said what they meant
        row.final = { steps: result.flow.steps, holes: result.flow.holes.map((h) => ({ id: h.id, reason: h.reason, owner: h.owner })) };
        row.conditions = conditionKinds(result.flow);
        row.perItem = perItemKind(result.flow);
        for (const q of row.questions) q.filled = result.trace.questions.find((x) => x.holeId === q.holeId)?.filled;
        row.status = statusOf(result);
        if (result.status === "complete" || result.status === "incomplete") {
          try {
            const saved = await builder.save(wsId, result.understood ?? u, result, systemAuthor(), `${PREFIX}${g.id} r${round}`);
            row.flowId = saved.flowId;
            if (saved.revision) {
              const rev = await flowRepo.getRevision(saved.flowId, saved.revision);
              const model = rev?.modelJson as { steps: Array<{ ref?: string }>; inputs?: Array<{ id: string; type?: string; defaults?: unknown }> };
              row.refs = [...new Set((model.steps ?? []).map((s) => s.ref).filter((r): r is string => !!r))];
              row.tables = [...new Set((model.steps ?? []).flatMap((s) => specTables((s as { sqlSpec?: unknown }).sqlSpec)))];
              row.inputs = {};
              for (const i of model.inputs ?? []) {
                const fromLabel = labelInputValue(g, i.id);
                row.inputs[i.id] = fromLabel !== null ? { value: coerce(fromLabel, i.type), source: "label" } : { value: i.defaults != null && i.defaults !== "" ? String(i.defaults) : harnessDefault(i), source: "harness-default" };
              }
              try {
                const ds = await typecheckFlow(wsId, model as never);
                row.typecheck = { errors: ds.filter((d) => d.severity === "error").map((d) => d.code), warnings: ds.filter((d) => d.severity === "warning").map((d) => d.code) };
              } catch (e) { row.typecheck = { errors: [`CHECKER CRASH: ${(e as Error).message}`], warnings: [] }; }
              try {
                const ex = await runDraft(wsId, saved.flowId, Object.fromEntries(Object.entries(row.inputs).map(([k, v]) => [k, v.value])), 180_000);
                row.run = ex.state.current;
                if (ex.state.current === "PAUSED") await kestra.killExecution(ex.id).catch(() => {});
                if (ex.state.current !== "SUCCESS" && ex.state.current !== "PAUSED") {
                  const logs: Array<{ taskId?: string; message?: string }> = await kestra.getExecutionLogs(ex.id, "ERROR").catch(() => []);
                  row.runError = (logs[0] ? `${logs[0].taskId}: ${logs[0].message}` : "(no error log)").replace(/\s+/g, " ").slice(0, 1500);
                }
              } catch (e) { row.run = "harness-error"; row.runError = String((e as Error).message).slice(0, 500); }
            }
          } catch (e) {
            // M1: the engine reached a state the save funnel refused. Must never happen; recorded, never retried.
            row.saveRefused = String((e as Error).message).slice(0, 800);
            row.status = "save_refused";
          }
        }
      } catch (e) {
        row.status = statusOf({ error: e });
        row.message = String((e as Error).message).slice(0, 500);
      }
      row.secs = Math.round((Date.now() - t0) / 1000);
      row.calls = calls;
      row.score = scoreBuild(g, { status: row.status!, questions: row.questions.map((q) => ({ text: q.ask, slot: q.slot })), refusedFor: [], refs: row.refs, run: row.run, ...(row.tables?.length ? { tables: row.tables } : {}), ...(row.conditions ? { conditions: row.conditions } : {}), ...(row.perItem ? { perItem: row.perItem } : {}) });

      for (const f of (await flowRepo.listByWorkspace(wsId)).filter((f: any) => String(f.name).startsWith(PREFIX))) await flowService.remove(wsId, f.id).catch(() => {});
      console.log(
        `r${round} ${g.id.padEnd(4)} ${g.label.outcome.padEnd(7)} ${row.score.pass ? "PASS" : "FAIL"} status=${row.status} q=${row.questions.length}/${row.score.expectedQuestions}` +
          ` moves=${row.trace?.moves.length ?? 0} calls=${calls.length} stop=${row.trace?.stop ?? "-"} run=${row.run ?? "-"} ${row.secs}s ${row.score.failures.map((f) => `${f.kind}(${f.detail.slice(0, 50)})`).join(" ")}`,
      );
      if (row.loopProblems?.length) console.log(`       LOOP: ${row.loopProblems.join(" · ")}`);
      if (row.saveRefused) console.log(`       SAVE REFUSED (M1): ${row.saveRefused.slice(0, 300)}`);
      if (row.runError) console.log(`       run: ${row.runError.slice(0, 300)}`);
      if (row.message) console.log(`       build: ${row.message.slice(0, 300)}`);
      writeFileSync(OUT, JSON.stringify({ model: provider.model, at: new Date().toISOString(), partial: true, rows }, null, 2));
    }
  }

  let left = 0;
  for (const wsId of touched) left += (await flowRepo.listByWorkspace(wsId)).filter((f: any) => String(f.name).startsWith(PREFIX)).length;
  const scored = rows.filter((r) => r.score);
  const n = (xs: number[]) => ({ n: xs.length, mean: xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : 0, max: xs.length ? Math.max(...xs) : 0 });
  const summary = {
    model: provider.model, rows: rows.length, scored: scored.length,
    pass: scored.filter((r) => r.score!.pass).length,
    byLabel: Object.fromEntries(["builds", "asks", "cannot"].map((o) => { const s = scored.filter((r) => r.outcomeLabel === o); return [o, `${s.filter((r) => r.score!.pass).length}/${s.length}`]; })),
    status: scored.reduce<Record<string, number>>((a, r) => ((a[r.status!] = (a[r.status!] ?? 0) + 1), a), {}),
    failures: scored.flatMap((r) => r.score!.failures.map((f) => f.kind)).reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {}),
    M1_saveRefused: rows.filter((r) => r.saveRefused && !r.saveRefused.startsWith("spec match:")).length,
    // M11 (phase 5 task 7): a build the spec-match check refused — the flow did not do what its confirmed spec says. Must be 0.
    M11_specMismatch: rows.filter((r) => r.saveRefused?.startsWith("spec match:")).length,
    M4_loops: rows.filter((r) => r.loopProblems?.length).length,
    M5_questions: n(scored.map((r) => r.questions.length)),
    M9_calls: n(scored.map((r) => r.calls.length)),
    replyShapeErrors: rows.filter((r) => r.status === "gateway_defect").length,
    runs: scored.filter((r) => r.run).reduce<Record<string, number>>((a, r) => ((a[r.run!] = (a[r.run!] ?? 0) + 1), a), {}),
    secs: n(scored.map((r) => r.secs ?? 0)),
    harness: rows.filter((r) => r.harness).map((r) => `${r.id}#${r.round}: ${r.harness}`),
    left,
  };
  console.log(`\n${JSON.stringify(summary)}`);
  writeFileSync(OUT, JSON.stringify({ model: provider.model, at: new Date().toISOString(), summary, rows }, null, 2));
  process.exit(left ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
