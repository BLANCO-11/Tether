/**
 * `pnpm --filter @foundry/server builder:converse` — the builder-stability corpus (plans/builder-stability-2026-10-01, Phase 5).
 *
 * Drives the REAL conversation entry points (`builderStart` / `builderAnswer`) over every conversation in
 * `conversations/corpus.json`, against each workspace's own catalogue and data, answering as the scripted person (`score.ts`),
 * and scores each against what it expects. Deletes every flow it creates. A MEASUREMENT: it exits non-zero only when it could
 * not run, never because conversations failed — the failures are the output.
 *
 *   --all               also the extended set (`corpus-extended.json`, 18 more) — the default is the 12-conversation core
 *   --only=H01,F02      a subset, by id
 *   --workspace=HR      one workspace
 *   --run               draft-run each complete build — ONLY when every tool it calls is ops-api's simulated capture
 *                       (`OPS_API_BASE`); a flow calling a tool that leaves the stack (real mail, a public URL) is reported
 *                       `skipped`, never run
 *   --out=<file>        write the full results as JSON
 *
 * On macOS it needs `scripts/harness-in-net.sh` (the server's network position), like every harness that may reach Kestra.
 */
import { dbOperationRepo } from "../repositories/db-operation.repo.js";
import { datasourceQueryRepo } from "../repositories/datasource-query.repo.js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { builderStart, builderAnswer, type BuilderTurn } from "../services/builder/conversation.js";
import { systemAuthor } from "../services/revision-author.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { flowService } from "../services/flow.service.js";
import { resolveGenerationProvider } from "../services/generation-provider.service.js";
import { answerFor, DEFAULT_PERSON, modelParts, readTests, runInputsFor, testedText, verdict, type Asked, type DeclaredInput, type Conversation, type Outcome } from "./conversations/score.js";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const ONLY = (arg("only") ?? "").split(",").filter(Boolean);
const WS = arg("workspace");
const RUN = process.argv.includes("--run");
const OUT = arg("out");
const MAX_TURNS = 8;

const here = dirname(fileURLToPath(import.meta.url));
const load = (f: string) => JSON.parse(readFileSync(join(here, "conversations", f), "utf8")) as Conversation[];
// `--corpus=<file>`: further conversations from a file (a spot check beside the corpus), never instead of it.
const extra = arg("corpus") ? JSON.parse(readFileSync(arg("corpus")!, "utf8")) as Conversation[] : [];
const corpus = [...load("corpus.json"), ...(process.argv.includes("--all") || ONLY.length ? load("corpus-extended.json") : []), ...extra]
  .filter((c) => (!ONLY.length || ONLY.includes(c.id)) && (!WS || c.workspace === WS));

const provider = await resolveGenerationProvider();
const model = (provider as { model?: string }).model ?? "unknown";
console.log(`builder:converse · model ${model} · ${corpus.length} conversation(s)${RUN ? " · with draft runs" : ""}`);

const workspaces = await workspaceRepo.list();
const author = systemAuthor("builder-converse");
const made: Array<{ ws: string; flow: string }> = [];
const results: Array<Outcome & { pass: boolean; why: string[] }> = [];

/** One exchange: answer while the builder asks, up to MAX_TURNS. */
async function converse(wsId: string, first: BuilderTurn, c: Conversation, o: Outcome, used: Set<number>): Promise<BuilderTurn> {
  let t = first;
  for (let i = 0; i < MAX_TURNS && t.status === "asks" && t.question && t.flowId; i++) {
    const q: Asked = { holeId: t.question.holeId, ask: t.question.ask, ...(t.question.options ? { options: t.question.options.map((x) => (typeof x === "string" ? x : (x as { label: string }).label)) } : {}) };
    const answer = answerFor(q, c, used);
    o.asked.push({ ...q, answer });
    o.questions++;
    t = await builderAnswer(wsId, t.flowId, answer.say, author);
    o.calls += t.calls;
  }
  return t;
}

async function draftRun(wsId: string, flowId: string, refs: string[], c: Conversation, declared: DeclaredInput[]): Promise<NonNullable<Outcome["run"]>> {
  // A call that stays INSIDE the stack is safe to run as a draft: ops-api's simulated services, and Foundry's own endpoints, which
  // decide draft-vs-live from the execution's namespace and capture a draft's message rather than deliver it (D-52, mail.ts).
  // Anything else leaves the stack and is not run.
  const { config } = await import("../config/index.js");
  const inStack = new Set([process.env.OPS_API_BASE, config.mail.selfBase].filter(Boolean).map((u) => new URL(u!).origin));
  const tools = await toolRepo.listByWorkspace(wsId);
  const leaves = tools.filter((t) => refs.includes(t.name) && (!t.url || !inStack.has(new URL(t.url).origin))).map((t) => t.name);
  if (leaves.length) return { state: "skipped", note: `calls ${leaves.join(", ")}, which leaves the stack` };
  const { runDraft } = await import("./kestra-draft-run.js");
  const ri = runInputsFor(declared, c.runInputs ?? {}, new Date());
  if (ri.missing.length) return { state: "error", note: `no value for run input(s) ${ri.missing.join(", ")}` };
  try {
    // The conversation is a PERSON's, and in the product the person who built it presses "Test run" — so the run is theirs ("email
    // me" is them). Their address is the corpus's test mailbox; a draft run CAPTURES mail, never delivers it, and the flow is
    // deleted after. Never a real person's identity.
    const ex = await runDraft(wsId, flowId, ri.inputs, undefined, { subject: "builder-converse:person", actor: DEFAULT_PERSON, kind: "user" });
    // A paused run (an approval step) holds one of the workspace's run slots until somebody decides: the corpus records the pause
    // and KILLS it, or five of them refuse every later run in the workspace with `budget_exceeded` (2026-10-02, run 16: H10, H11).
    if (ex.state.current === "PAUSED") { const { kestra } = await import("../services/kestra-client.service.js"); await kestra.killExecution(ex.id).catch((e) => console.log(`kill ${ex.id}: ${(e as Error).message}`)); }
    const bad = (ex.taskRunList ?? []).filter((t) => t.state.current !== "SUCCESS").map((t) => `${t.taskId}=${t.state.current}`).join(" · ");
    // A failed run says WHY: the engine's own error lines for the failed tasks (redaction is the engine log's, as the run page reads it).
    let why = "";
    if (ex.state.current === "FAILED") {
      const { kestra } = await import("../services/kestra-client.service.js");
      const logs = await kestra.getExecutionLogs(ex.id, "WARN").catch(() => []);
      why = logs.filter((l) => l.level === "ERROR" || l.level === "WARN").map((l) => `${l.taskId ?? ""}: ${l.message.split("\n")[0]!.slice(0, 700)}`).slice(0, 3).join(" | ");
    }
    return { state: ex.state.current, note: [bad, why, ri.filled.length ? `inputs as of today: ${ri.filled.join(", ")}` : ""].filter(Boolean).join(" · ") || undefined };
  } catch (e) {
    return { state: "error", note: (e as Error).message.slice(0, 300) };
  }
}

for (const c of corpus) {
  const ws = workspaces.find((w: { name: string }) => w.name === c.workspace);
  const o: Outcome = { id: c.id, workspace: c.workspace, status: "error", questions: 0, calls: 0, seconds: 0, asked: [], unmet: [], readback: [] };
  const t0 = Date.now();
  const used = new Set<number>();
  if (!ws) o.error = `no workspace called ${c.workspace}`;
  else {
    try {
      let t = await builderStart(ws.id, c.goal, author);
      o.calls += t.calls;
      o.readback = t.readback;
      if (t.flowId) made.push({ ws: ws.id, flow: t.flowId });
      t = await converse(ws.id, t, c, o, used);
      // Later messages: an edit of the flow the first exchange built.
      for (const msg of c.then ?? []) {
        if (!t.flowId || t.status !== "complete") break;
        const flowId: string = t.flowId;
        t = await builderStart(ws.id, msg, author, flowId);
        o.calls += t.calls;
        t = await converse(ws.id, t, c, o, used);
      }
      o.status = t.status;
      o.unmet = t.unmet;
      if (t.readback.length) o.readback = t.readback;
      // The understanding the build ended on — its actions and wiring — so a wrong build shows its own cause (diagnosis only).
      if (t.flowId) {
        const inc = await flowService.getIncomplete(ws.id, t.flowId).catch(() => null) as { build?: { goalSpec?: { spec?: { sinks?: unknown; wiring?: unknown; shapes?: unknown } } } } | null;
        const sp = inc?.build?.goalSpec?.spec;
        if (sp) (o as unknown as Record<string, unknown>).understood = { sinks: sp.sinks, wiring: sp.wiring, shapes: sp.shapes };
      }
      const flow = t.flowId ? await flowRepo.get(ws.id, t.flowId) : undefined;
      const rev = flow && flow.draftRevision > 0 ? await flowRepo.getRevision(flow.id, flow.draftRevision) : undefined;
      if (rev) {
        o.parts = modelParts(rev.modelJson);
        // The built model itself, for reading a build's structure (inputs, a branch inside a loop) — diagnosis only, never scored here.
        (o as unknown as Record<string, unknown>).model = rev.modelJson;
        // The saved readers' own rules: a condition a chosen reader applies is applied (its owner declared it).
        const defs: Record<string, string> = {};
        for (const ref of o.parts.refs) {
          const op = await dbOperationRepo.getByRef(ws.id, ref).catch(() => undefined);
          if (op) { defs[ref] = readTests(op.operation.specJson); continue; }
          const dot = ref.indexOf(".");
          const q = dot > 0 ? await datasourceQueryRepo.resolveRef(ws.id, ref.slice(0, dot), ref.slice(dot + 1)).catch(() => undefined) : undefined;
          const sql = (q as { query?: { sqlText?: string }; sqlText?: string } | undefined);
          const text = sql?.query?.sqlText ?? sql?.sqlText;
          if (text) defs[ref] = text.slice(Math.max(0, text.search(/\bwhere\b/i)));
        }
        o.tested = testedText(rev.modelJson, defs);
      }
      if (RUN && t.status === "complete" && flow && o.parts) o.run = await draftRun(ws.id, flow.id, o.parts.refs, c, ((rev?.modelJson as { inputs?: DeclaredInput[] } | undefined)?.inputs) ?? []);
      // A failed run keeps what it ran: the declared inputs and the first steps' bindings, to name the value that failed.
      if (o.run?.state === "FAILED" && rev) { const m = rev.modelJson as { inputs?: unknown; steps?: Array<Record<string, unknown>> }; o.diag = { ...(o.diag ?? {}), inputs: m.inputs, steps: (m.steps ?? []).slice(0, 2).map((x) => ({ id: x.id, kind: x.kind, ref: x.ref, paramsExpr: x.paramsExpr, inputs: x.inputs, whole: JSON.stringify(x).slice(0, 4000) })) }; }
      if (t.status !== "complete" && t.flowId) {
        const view = await flowService.getIncomplete(ws.id, t.flowId).catch(() => null);
        const build = view?.build as { goalSpec?: Record<string, unknown>; trace?: Record<string, unknown> } | undefined;
        const model = view?.model as { holes?: unknown } | undefined;
        const gs = (build?.goalSpec as { spec?: Record<string, unknown> } | undefined)?.spec;
        if (build) o.diag = { sources: gs?.sources, values: gs?.values, conditions: gs?.conditions, gaps: build.trace?.gaps, holes: model?.holes };
      }
    } catch (e) {
      o.error = (e as Error).message.slice(0, 400);
    }
  }
  o.seconds = Math.round((Date.now() - t0) / 1000);
  const why = verdict(c, o);
  results.push({ ...o, pass: !why.length, why });
  console.log(`${why.length ? "✗" : "✓"} ${c.id.padEnd(4)} ${c.workspace.padEnd(34)} ${o.status.padEnd(10)} ${o.questions}q ${String(o.calls).padStart(2)} calls ${String(o.seconds).padStart(3)}s${o.run ? ` · run ${o.run.state}` : ""}`);
  for (const w of why) console.log(`       · ${w}`);
}

for (const m of made) { try { await flowService.remove(m.ws, m.flow); } catch (e) { console.log(`cleanup ${m.flow}: ${(e as Error).message}`); } }

const pass = results.filter((r) => r.pass).length;
const complete = results.filter((r) => r.status === "complete").length;
const qs = results.filter((r) => r.status === "complete").map((r) => r.questions).sort((a, b) => a - b);
console.log(`\n══ ${pass}/${results.length} met expectation · ${complete} complete · median questions per complete build ${qs.length ? qs[Math.floor(qs.length / 2)] : "—"} · model ${model} · ${made.length} flow(s) cleaned up`);
if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), model, run: RUN, results }, null, 2));
process.exit(0);
