/**
 * A condition on ONE value, end to end on Kestra (compiled-builder phase C, C3 — D-371). Proves the lowering the compiler meets
 * nothing new for runs, and that the RIGHT path runs, not merely that the run is green.
 *
 * For one workspace with a fillable reader, built ONLY from canvas actions (the engine's listed moves, the way a person builds it):
 *
 *   read ─▶ IF the count of read > a  ─▶ count rows (if path)
 *           ELSE IF the count > b     ─▶ count rows (elif path)   ← its test is placed AHEAD of the chain (`before`)
 *           ELSE                      ─▶ count rows (else path)
 *
 * saved through `writeRevision` (lowering, gate, compile, draft deploy) and run as a draft. Three flows, thresholds chosen from
 * the reader's own row count n (read off the first run, so the oracle is the data, not a guess):
 *   (1) a = b = 1e9      → ELSE   — and its path's count gives n
 *   (2) a = n - 1        → IF
 *   (3) a = n, b = n - 1 → ELSE IF
 * Each run must succeed, run exactly its path's step, and NOT run the other two. CONTROL: the three runs pick three different
 * paths, so a flow that ran every path, or always the same one, fails.
 *
 *   ./scripts/harness-in-net.sh /repo/packages/server/src/scenarios/decide-e2e.ts [--workspace=<id>]
 *
 * No model calls. Every flow it creates is DELETED at the end. ⚠ `main()` runs at import — never import this from a test.
 */
import { canvasCreate, canvasOpen, canvasAct, canvasSave, type CanvasView, type ActionView } from "../services/builder/canvas.service.js";
import { flowService } from "../services/flow.service.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { systemAuthor } from "../services/revision-author.js";
import { armMembers, rng, sampleLiteral, splitSide, type Ty } from "@foundry/flow-edit";
import { builderCatalogue } from "../services/builder/builder.service.js";
import { runDraft, stepReport } from "./kestra-draft-run.js";

const only = process.argv.find((a) => a.startsWith("--workspace="))?.slice(12);
let failed = 0;
const ok = (c: boolean, what: string) => { console.log(`  ${c ? "ok  " : "FAIL"} ${what}`); if (!c) failed++; };

async function act(ws: string, flowId: string, v: CanvasView, pick: (a: ActionView) => boolean, value?: string): Promise<CanvasView> {
  const a = v.actions.find(pick);
  if (!a) throw new Error("no such action listed");
  const r = await canvasAct(ws, flowId, { state: v.state, sig: v.sig, actionId: a.id, ...(value !== undefined ? { value } : {}) });
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r;
}
const op = (a: ActionView) => a.op as { op: string; [k: string]: unknown } | undefined;

/** The reader with every required input filled — a listed source first, else a typed value that fits. Null when none fills. */
async function withReader(ws: string, flowId: string, v: CanvasView): Promise<CanvasView | null> {
  const reader = v.actions.find((a) => op(a)?.op === "add_reader" && op(a)!.ref && !op(a)!.under);
  if (!reader) return null;
  v = await act(ws, flowId, v, (a) => a.id === reader.id);
  const { cat } = await builderCatalogue(ws);
  const r = rng(7);
  for (let guard = 0; guard < 10; guard++) {
    const port = v.state.holes.find((h) => h.site.at === "port") as { site: { stepId: string; port: string } } | undefined;
    if (!port) return v;
    const here = v.actions.filter((a) => a.where.at === "port" && a.where.stepId === port.site.stepId && a.where.port === port.site.port);
    const src = here.find((a) => op(a)?.op === "bind"), slot = here.find((a) => a.slot);
    if (src) { v = await act(ws, flowId, v, (a) => a.id === src.id); continue; }
    if (!slot) return null;
    let done = false;
    for (let t = 0; t < 12 && !done; t++) {
      const res = await canvasAct(ws, flowId, { state: v.state, sig: v.sig, actionId: slot.id, value: sampleLiteral(slot.slot!.ty as Ty, cat, r) });
      if (!("refused" in res)) { v = res; done = true; }
    }
    if (!done) return null;
  }
  return null;
}

/** "count rows of <read>" dropped into one path. */
const countUnder = (ws: string, flowId: string, v: CanvasView, readId: string, under: string) =>
  act(ws, flowId, v, (a) => op(a)?.op === "add_transform" && op(a)!.from === readId && op(a)!.under === under && /count rows/.test(a.label));

interface Built { flowId: string; paths: { if: string; elif: string; else: string } }

async function build(ws: string, a: number, b: number): Promise<Built | null> {
  const { flowId } = await canvasCreate(ws, `decide e2e (harness) ${Date.now().toString(36)}`);
  try {
    let v = await withReader(ws, flowId, (await canvasOpen(ws, flowId)) as CanvasView);
    if (!v) { await flowService.remove(ws, flowId); return null; }
    const readId = v.state.steps[0]!.id;
    const decide = (x: ActionView, of?: string) => !!x.decide && x.decide.subject === readId && x.decide.counts && x.decide.cmp === "gt" && x.decide.of === of;
    v = await act(ws, flowId, v, (x) => decide(x), String(a));
    const ifId = v.state.steps.find((s) => s.kind === "branch")!.id;
    v = await countUnder(ws, flowId, v, readId, ifId);
    v = await act(ws, flowId, v, (x) => decide(x, ifId), String(b));
    const elifId = v.state.steps.find((s) => s.kind === "branch" && s.id !== ifId)!.id;
    v = await countUnder(ws, flowId, v, readId, elifId);
    v = await act(ws, flowId, v, (x) => op(x)?.op === "add_otherwise" && op(x)!.of === elifId && !op(x)!.when);
    const elseId = v.state.steps.find((s) => s.kind === "branch" && s.id !== ifId && s.id !== elifId)!.id;
    v = await countUnder(ws, flowId, v, readId, elseId);
    v = await act(ws, flowId, v, (x) => op(x)?.op === "set_output" && op(x)!.stepId === readId);
    ok(v.complete, `IF count > ${a} / ELSE IF count > ${b} / ELSE: complete, built from canvas actions only`);
    // Each path's own step: the step in that arm.
    const inArm = (branch: string) => armMembers(v!.state, branch)[0]!;
    const paths = { if: inArm(ifId), elif: inArm(elifId), else: inArm(elseId) };
    const saved = await canvasSave(ws, flowId, { state: v.state, sig: v.sig }, systemAuthor("decide-e2e"));
    ok(saved.status === "complete", `saved as a revision through writeRevision (${saved.status})`);
    return { flowId, paths };
  } catch (e) { await flowService.remove(ws, flowId); throw e; }
}

const countOf = (outputs: Record<string, unknown> | undefined): number | null => {
  const raw = outputs?.value;
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    // A count's output is its one record, `{"n":10}`.
    const n = (v as { n?: unknown } | null)?.n;
    return typeof n === "number" ? n : null;
  } catch { return null; }
};

/** The reader's rows, from its task's output: the step envelope, `results[0].data`. */
const rowsOf = (outputs: Record<string, unknown> | undefined): Array<Record<string, unknown>> | null => {
  try {
    const raw = outputs?.value ?? outputs?.body;
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    const data = (v as { results?: Array<{ data?: unknown }> })?.results?.[0]?.data;
    return Array.isArray(data) ? data as Array<Record<string, unknown>> : null;
  } catch { return null; }
};

/**
 * A SPLIT on Kestra (C2, D-373): the reader's rows divided by "<a number field> is more than t" into the matched rows and the rest,
 * each exit counting its own rows. Built from canvas actions only. Two runs — t below the field's largest value (both exits run,
 * the matched count is the oracle's), and t at the largest (no row matches: the matched exit does NOT run, the rest has them all).
 * Every run: the two exits' rows are disjoint and together are the reader's rows — checked by count against the reader's own
 * output. A null in the field counts as the rest (D-372). CONTROL: the two runs ran different exits.
 */
async function splitProof(ws: string): Promise<void> {
  console.log("  — split —");
  const buildSplit = async (t: number | null) => {
    const { flowId } = await canvasCreate(ws, `split e2e (harness) ${Date.now().toString(36)}`);
    made.push({ ws, flowId });
    let v = await withReader(ws, flowId, (await canvasOpen(ws, flowId)) as CanvasView);
    if (!v) return null;
    const readId = v.state.steps[0]!.id;
    const choice = v.actions.find((a) => a.split?.subject === readId && a.split.cmp === "gt" && ["Int", "Number"].includes(((a.slot?.ty ?? {}) as { t?: string }).t ?? ""));
    if (!choice) return null;
    const field = choice.split!.field;
    if (t === null) return { flowId, readId, field, v: null };
    v = await act(ws, flowId, v, (a) => a.id === choice.id, String(t));
    const branches = v.state.steps.filter((s) => s.kind === "branch").map((s) => s.id);
    const side = (b: string) => v!.state.steps.find((s) => s.kind === "transform" && flowShapeSide(v!, s.id)?.branchId === b)!.id;
    const [matched, rest] = [side(branches[0]!), side(branches[1]!)];
    v = await act(ws, flowId, v, (a) => op(a)?.op === "add_transform" && op(a)!.from === matched && op(a)!.under === branches[0] && /count rows/.test(a.label));
    v = await act(ws, flowId, v, (a) => op(a)?.op === "add_transform" && op(a)!.from === rest && op(a)!.under === branches[1] && /count rows/.test(a.label));
    v = await act(ws, flowId, v, (a) => op(a)?.op === "set_output" && op(a)!.stepId === readId);
    ok(v.complete, `split on ${field} > ${t}: complete, built from canvas actions only`);
    const exits = { matched: armMembers(v.state, branches[0]!)[0]!, rest: armMembers(v.state, branches[1]!)[0]! };
    const saved = await canvasSave(ws, flowId, { state: v.state, sig: v.sig }, systemAuthor("decide-e2e"));
    ok(saved.status === "complete", `saved as a revision (${saved.status})`);
    return { flowId, readId, field, exits };
  };
  // The field's values, read off a run of the reader itself — the oracle is the data.
  const probe = await buildSplit(1e9);
  if (!probe || !("exits" in probe)) { console.log("  (no number field to split on here — skipped)"); return; }
  const runOnce = async (b: NonNullable<typeof probe> & { exits: { matched: string; rest: string } }, t: number) => {
    const ex = await runDraft(ws, b.flowId, {});
    console.log(`    ${stepReport(ex)}`);
    ok(ex.state.current === "SUCCESS", `the run settles SUCCESS (${ex.state.current})`);
    const task = (id: string) => (ex.taskRunList ?? []).find((x) => x.taskId === id && x.state.current === "SUCCESS");
    const rows = rowsOf(task(b.readId)?.outputs as Record<string, unknown> | undefined);
    ok(rows !== null, `the reader's rows are readable (${rows?.length ?? "—"})`);
    if (!rows) return null;
    const want = rows.filter((r) => typeof r[b.field] === "number" && (r[b.field] as number) > t).length;
    const got = { matched: task(b.exits.matched) ? countOf(task(b.exits.matched)!.outputs as Record<string, unknown>) : null, rest: task(b.exits.rest) ? countOf(task(b.exits.rest)!.outputs as Record<string, unknown>) : null };
    ok((got.matched ?? 0) === want && (want > 0) === (got.matched !== null), `matched exit: ${want} row(s) by the oracle, ${got.matched === null ? "did not run" : `ran with ${got.matched}`}`);
    ok((got.rest ?? 0) === rows.length - want && (rows.length - want > 0) === (got.rest !== null), `the rest: ${rows.length - want} row(s), ${got.rest === null ? "did not run" : `ran with ${got.rest}`} — disjoint, and together the ${rows.length}`);
    return { ran: `${got.matched !== null}|${got.rest !== null}`, rows };
  };
  const r1 = await runOnce(probe as never, 1e9);
  const values = (r1?.rows ?? []).map((r) => r[probe.field]).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  if (values.length < 2 || values[0] === values.at(-1)) { console.log(`  (${probe.field} has fewer than two distinct values — the both-exits run skipped)`); return; }
  const t = values[0]!; // below the largest: some rows match, and the smallest does not
  const b2 = await buildSplit(t);
  const r2 = b2 && "exits" in b2 ? await runOnce(b2 as never, t) : null;
  ok(!!r1 && !!r2 && r1.ran !== r2.ran, "CONTROL: the two runs ran different exits");
}
const flowShapeSide = (v: CanvasView, id: string) => splitSide(v.state, id);

const workspaces = (await workspaceRepo.list()).filter((w) => !w.deletedAt && (!only || w.id === only));
const made: Array<{ ws: string; flowId: string }> = [];
let proved = false;
try {
  for (const w of workspaces) {
    if (proved) break;
    console.log(`\n${w.name}`);
    const run = async (a: number, b: number, want: "if" | "elif" | "else") => {
      const built = await build(w.id, a, b);
      if (!built) return null;
      made.push({ ws: w.id, flowId: built.flowId });
      const ex = await runDraft(w.id, built.flowId, {});
      const ran = new Set((ex.taskRunList ?? []).filter((t) => t.state.current === "SUCCESS").map((t) => t.taskId));
      console.log(`    ${stepReport(ex)}`);
      ok(ex.state.current === "SUCCESS", `the run settles SUCCESS (${ex.state.current})`);
      for (const p of ["if", "elif", "else"] as const)
        ok(ran.has(built.paths[p]) === (p === want), `${p} path ${p === want ? "RAN" : "did not run"} (${built.paths[p]})`);
      const mine = (ex.taskRunList ?? []).find((t) => t.taskId === built.paths[want]);
      return { n: countOf(mine?.outputs as Record<string, unknown> | undefined), picked: (["if", "elif", "else"] as const).filter((p) => ran.has(built.paths[p])) };
    };
    const first = await run(1e9, 1e9, "else");
    if (!first) { console.log("  (no fillable reader here — next workspace)"); continue; }
    const n = first.n;
    ok(typeof n === "number", `the else path counted the reader's rows (n = ${n})`);
    if (typeof n !== "number") break;
    const second = await run(n - 1, 1e9, "if");
    const third = await run(n, n - 1, "elif");
    // CONTROL: three runs, three different paths — a flow running every path, or always one, cannot pass.
    ok(new Set([first, second, third].map((r) => r?.picked.join(","))).size === 3, "the three runs took three different paths");
    await splitProof(w.id);
    proved = true;
  }
  ok(proved, "a workspace with a fillable reader was found and proven");
} catch (e) { ok(false, `threw: ${(e as Error).message.slice(0, 300)}`); }
finally {
  for (const m of made) await flowService.remove(m.ws, m.flowId);
  console.log(`\n(${made.length} flow(s) deleted)`);
}
console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
