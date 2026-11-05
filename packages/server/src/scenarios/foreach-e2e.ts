/**
 * For each, end to end on Kestra (compiled-builder phase F, F2's gate — D-361). Proves the COMPILED loop runs, per item, on the
 * right path, in order — not merely that the run is green.
 *
 * For one workspace with a fillable reader, built from the engine's listed moves (`apply`), saved through `saveState` (lowering,
 * gate, compile, draft deploy), and run as a draft:
 *
 *   read ─▶ keep rows where <n> > input `floor`, at most 1000 ─▶ FOR EACH row (3 at a time, keep going):
 *                                                                   IF <n> > input `t` → tag "big: <n>"
 *                                                                   ELSE              → tag "small: <n>"
 *                                                                   merge → this row's result
 *                                                              ─▶ the loop's output (the flow's result)
 *
 * One flow, several runs, each against an oracle computed from the reader's OWN rows (read off the run, so the oracle is the data):
 *   - t at the smallest value: every row but the smallest takes IF — and identical rows each run once, in input order;
 *   - t at the largest: every row takes ELSE (CONTROL: a different split from the first run);
 *   - floor above the largest: the list is EMPTY — the loop runs nothing and its output is [];
 *   - with `ok` / `i` / `result` checked per row.
 *
 *   ./scripts/harness-in-net.sh packages/server/src/scenarios/foreach-e2e.ts [--workspace=<id>]
 *
 * No model calls. Every flow it creates is DELETED at the end. ⚠ `main()` runs at import — never import this from a test.
 */
import { apply, checkState, emptyFlow, holesOf, legalMoves, rng, rowOf, sampleLiteral, readableTy, type CatalogueSnapshot, type EFlow, type EngineOp, type Ty } from "@foundry/flow-edit";
import { saveState, canvasCreate } from "../services/builder/canvas.service.js";
import { flowService } from "../services/flow.service.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { systemAuthor } from "../services/revision-author.js";
import { builderCatalogue } from "../services/builder/builder.service.js";
import { runDraft, stepReport } from "./kestra-draft-run.js";
import { flowVisibilityService } from "../services/flow-visibility.service.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { LOOP_BATCH } from "../services/flow-compiler.service.js";

const only = process.argv.find((a) => a.startsWith("--workspace="))?.slice(12);
let failed = 0;
const ok = (c: boolean, what: string, detail = "") => { console.log(`  ${c ? "ok  " : "FAIL"} ${what}${c || !detail ? "" : `\n         ${detail}`}`); if (!c) failed++; };

function must(f: EFlow, op: EngineOp, cat: CatalogueSnapshot): EFlow {
  const r = apply(f, op, cat);
  if (!r.ok) throw new Error(`${op.op}: ${r.error}`);
  return r.flow;
}

/** Fill every port hole with a listed source, else a typed value that fits — the way a person answers. */
function fillPorts(f: EFlow, cat: CatalogueSnapshot, prefer?: (src: { from: string; stepId?: string }) => boolean): EFlow | null {
  const r = rng(11);
  for (let guard = 0; guard < 20; guard++) {
    const h = f.holes.find((x) => x.site.at === "port") as { site: { stepId: string; port: string } } | undefined;
    if (!h) return f;
    const m = legalMoves(f, cat).find((x) => x.op === "bind" && x.stepId === h.site.stepId && x.port === h.site.port) as { sources: Array<{ from: string; stepId?: string }>; literal: Ty | null } | undefined;
    if (!m) return null;
    const src = m.sources.find((s) => prefer?.(s)) ?? m.sources[0];
    let done = false;
    if (src) { const res = apply(f, { op: "bind", stepId: h.site.stepId, port: h.site.port, source: src as never }, cat); if (res.ok) { f = res.flow; done = true; } }
    for (let t = 0; t < 12 && !done && m.literal; t++) {
      const res = apply(f, { op: "bind", stepId: h.site.stepId, port: h.site.port, source: { from: "literal", value: sampleLiteral(m.literal, cat, r), provenance: "goal" } }, cat);
      if (res.ok) { f = res.flow; done = true; }
    }
    if (!done) return null;
  }
  return null;
}

interface Built { flowId: string; readId: string; field: string; big: string; small: string; collect: string; after: string; notify: string | null }
let notifyRef: string | null = null;

async function build(ws: string): Promise<Built | null> {
  const { cat } = await builderCatalogue(ws);
  // A reader whose rows have a non-null whole-number or number field to compare.
  for (const [ref, sig] of Object.entries(cat.refs)) {
    if (sig.kind !== "query" && sig.kind !== "operation") continue;
    const row = rowOf(sig.payload);
    if (row.t !== "Record") continue;
    const field = Object.entries(row.fields).find(([, t]) => t.t === "Int" || t.t === "Number")?.[0];
    if (!field) continue;
    let f: EFlow;
    try {
      f = must(emptyFlow("fe"), { op: "declare_input", id: "floor", type: "FLOAT", defaults: "-1000000000" }, cat);
      f = must(f, { op: "declare_input", id: "t", type: "FLOAT", defaults: "0" }, cat);
      f = must(f, { op: "add_reader", id: "read", ref }, cat);
      const filled = fillPorts(f, cat);
      if (!filled) continue;
      f = filled;
      f = must(f, { op: "add_transform", id: "rows", from: "read", pipeline: [{ op: "filter", where: { cmp: "gt", left: { field }, right: { input: "floor" } } }, { op: "limit", n: { value: 1000, from: "catalogue" } }] }, cat);
      f = must(f, { op: "add_loop", id: "each", over: "rows", concurrency: 3 }, cat);
      f = must(f, { op: "add_transform", id: "big_test", from: "each", pipeline: [{ op: "keep_if", where: { cmp: "gt", left: { field }, right: { input: "t" } } }] }, cat);
      f = must(f, { op: "add_branch", id: "when_big", when: [{ stepId: "big_test", test: "any" }] }, cat);
      const tag = (word: string) => [{ op: "template" as const, as: "line", parts: [{ text: `${word}: ` }, { field }] }, { op: "project" as const, fields: [{ name: "line", from: "line" }] }];
      f = must(f, { op: "add_transform", id: "big", from: "each", pipeline: tag("big"), under: "when_big" }, cat);
      f = must(f, { op: "add_otherwise", id: "else_small", of: "when_big" }, cat);
      f = must(f, { op: "add_transform", id: "small", from: "each", pipeline: tag("small"), under: "else_small" }, cat);
      // A real call per item on the ELSE path, through Foundry's step API — its inputs from the item where one fits.
      for (const [tref, t] of Object.entries(cat.refs)) {
        if (t.kind !== "tool" || t.modelText) continue;
        const added = apply(f, { op: "add_call", id: "notify", ref: tref, under: "else_small" }, cat);
        if (!added.ok) continue;
        const filled = fillPorts(added.flow, cat, (x) => x.stepId === "each");
        if (filled) { f = filled; notifyRef = tref; break; }
      }
      f = must(f, { op: "add_merge", id: "tagged", sources: ["big", "small"] }, cat);
      f = must(f, { op: "close_loop", id: "results", loop: "each", result: "tagged" }, cat);
      // A step AFTER the loop reading its Foundry fields (D-363 amended: `ff_i`, `ff_ok`, `ff_result`) — proven on the engine below.
      f = must(f, { op: "add_transform", id: "after", from: "results", pipeline: [{ op: "filter", where: { notNull: "ff_result" } }, { op: "project", fields: [{ name: "n", from: "ff_i" }, { name: "worked", from: "ff_ok" }] }] }, cat);
      f = must(f, { op: "set_output", stepId: "results" }, cat);
    } catch (e) { console.log(`  (${ref}: ${(e as Error).message.slice(0, 160)} — next reader)`); continue; }
    const holes = holesOf(checkState(f, cat));
    if (holes.length) { console.log(`  (${ref}: ${holes.length} hole(s) left — next reader)`); continue; }
    console.log(`  reader ${ref}, comparing ${field}; the loop's output: ${JSON.stringify(readableTy(f, cat, "results")).slice(0, 160)}…`);
    const { flowId } = await canvasCreate(ws, `for each e2e (harness) ${Date.now().toString(36)}`);
    made.push({ ws, flowId });
    const saved = await saveState(ws, flowId, f, systemAuthor("foreach-e2e"), "canvas");
    ok(saved.status === "complete", `saved as a revision through writeRevision (${saved.status})`);
    console.log(`  a call per item on the ELSE path: ${notifyRef ?? "(no tool fillable here — none)"}`);
    return { flowId, readId: "read", field, big: "big", small: "small", collect: "results", after: "after", notify: notifyRef ? "notify" : null };
  }
  return null;
}

type Row = Record<string, unknown>;
const json = (raw: unknown): unknown => { try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return undefined; } };
const rowsOf = (outputs: Record<string, unknown> | undefined): Row[] | null => {
  const v = json(outputs?.body ?? outputs?.value) as { results?: Array<{ data?: unknown }> } | undefined;
  const d = v?.results?.[0]?.data;
  return Array.isArray(d) ? (d as Row[]) : null;
};

async function runOnce(ws: string, b: Built, floor: number, t: number, label: string) {
  console.log(`\n  ${label} (floor ${floor}, t ${t})`);
  const ex = await runDraft(ws, b.flowId, { floor: String(floor), t: String(t) });
  if (process.argv.includes("--dump")) for (const tr of (ex.taskRunList ?? []).slice(0, 14)) console.log(`DUMP ${JSON.stringify({ ...tr, outputs: tr.outputs ? Object.keys(tr.outputs) : null, attempts: undefined, state: tr.state.current })}`);
  console.log(`    ${stepReport(ex).slice(0, 400)}`);
  ok(ex.state.current === "SUCCESS", `the run settles SUCCESS (${ex.state.current})`);
  const task = (id: string) => (ex.taskRunList ?? []).filter((x) => x.taskId === id && x.state.current === "SUCCESS");
  const all = rowsOf(task(b.readId)[0]?.outputs as Record<string, unknown> | undefined);
  ok(all !== null, `the reader's rows are readable (${all?.length ?? "—"})`);
  if (!all) return null;
  const n = (r: Row) => r[b.field] as number;
  // The oracle: the rows in, in order, capped — each tagged by its own value.
  const inRows = all.filter((r) => typeof n(r) === "number" && n(r) > floor).slice(0, 1000);
  const out = json(task(b.collect)[0]?.outputs?.value) as Array<Row & { ff_i: number; ff_ok: boolean; ff_error?: string | null; ff_result: { line: string } | null }> | undefined;
  ok(Array.isArray(out), `the loop's output is readable (${Array.isArray(out) ? out.length : "—"} rows)`);
  if (!Array.isArray(out)) return null;
  ok(out.length === inRows.length, `one output row per item — ${inRows.length} in, ${out.length} out (identical rows included)`);
  ok(out.every((r, i) => r.ff_i === i), "the output is in input order (ff_i = 0, 1, 2, …)");
  const want = inRows.map((r) => `${n(r) > t ? "big" : "small"}: ${n(r)}`);
  const got = out.map((r) => (r.ff_ok ? r.ff_result?.line : "(not ok)"));
  const mism = want.findIndex((w, i) => !String(got[i]).startsWith(w.split(": ")[0]!) || Number(String(got[i]).split(": ")[1]) !== n(inRows[i]!));
  ok(mism < 0, `every item took its OWN path and carried its own value (${want.filter((w) => w.startsWith("big")).length} big, ${want.filter((w) => w.startsWith("small")).length} small)`, mism >= 0 ? `item ${mism}: want "${want[mism]}", got "${got[mism]}"` : "");
  // I-281: the engine drops a null-valued key, so a null `error` arrives ABSENT — the same value to a reader.
  ok(out.every((r) => r.ff_ok === true && (r.ff_error ?? null) === null), "every item ok, no error");
  ok(out.every((r, i) => n(r) === n(inRows[i]!)), "each output row carries its item's own fields");
  const after = json(task(b.after)[0]?.outputs?.value) as Array<{ n: number; worked: boolean }> | undefined;
  ok(Array.isArray(after) && after.length === out.length && after.every((r, i) => r.n === out[i]!.ff_i && r.worked === true),
    `a step after the loop reads its ff_ fields (${Array.isArray(after) ? after.length : "—"} rows of { n: ff_i, worked: ff_ok })`, JSON.stringify(after)?.slice(0, 200) ?? String(task(b.after)[0]?.outputs?.value).slice(0, 200));
  if (b.notify) {
    const calls = (ex.taskRunList ?? []).filter((x) => x.taskId === b.notify);
    const smalls = want.filter((w) => w.startsWith("small")).length;
    ok(calls.length === smalls && calls.every((c) => c.state.current === "SUCCESS"), `the step-API call ran once per ELSE item, each its own taskrun (${calls.length} of ${smalls}, ${new Set(calls.map((c) => (c as { id?: string }).id)).size} distinct)`);
  }
  // F3 (D-367): the run as Foundry shows it — one view per step, the loop's items folded from the engine's per-item taskruns.
  const row = await flowExecutionRepo.getByKestraId(ex.id);
  const shown = row ? await flowVisibilityService.get(ws, row.id) : null;
  const loopView = shown?.steps.find((s) => s.stepId === "each");
  ok(!!shown && new Set(shown.steps.map((s) => s.stepId)).size === shown.steps.length, "the run view has ONE view per step (the per-item taskruns folded)");
  ok(loopView?.items?.length === inRows.length && loopView.items.every((x, i) => x.i === i && x.status === "success"), `the loop's view lists every item in order (${loopView?.items?.length ?? "—"})`);
  ok(!!loopView?.items && loopView.items.every((x, i) => x.path.includes(n(inRows[i]!) > t ? b.big : b.small) && JSON.stringify(x.result) === JSON.stringify(out[i]!.ff_result)), "each item's path is the one it took, and its result the loop output's");
  const iterations = task(b.big).length + task(b.small).length;
  ok(iterations === inRows.length, `the body ran once per item (${iterations} of ${inRows.length})`);
  return { all, split: want.map((w) => w.split(":")[0]).join(",") };
}

/**
 * D-370 — a ONE-CALL loop runs in BATCHES: one real step-API call per chunk of up to LOOP_BATCH rows. Built from ops (a reader, a
 * bounded list, a loop, one tool call fed from the item, the loop finished on it), saved through the funnel, run on the engine.
 * The oracle for each item's `ff_ok` is the batch call's OWN envelope (`succeeded` per chunk), never the collector being tested.
 */
async function provesBatch(ws: string): Promise<boolean> {
  const { cat } = await builderCatalogue(ws);
  let sawSuccess = false, sawWholeFail = false;
  const tried = new Set<string>();
  for (const [ref, sig] of Object.entries(cat.refs)) {
    if (sawSuccess) break;
    if (sig.kind !== "query" && sig.kind !== "operation") continue;
    const row = rowOf(sig.payload);
    if (row.t !== "Record") continue;
    const num = Object.entries(row.fields).find(([, t]) => t.t === "Int" || t.t === "Number")?.[0];
    let base: EFlow;
    try {
      base = must(emptyFlow("fb"), { op: "declare_input", id: "floor", type: "FLOAT", defaults: "-1000000000" }, cat);
      base = must(base, { op: "add_reader", id: "read", ref }, cat);
      const filled = fillPorts(base, cat);
      if (!filled) continue;
      base = must(filled, { op: "add_transform", id: "rows", from: "read", pipeline: [...(num ? [{ op: "filter" as const, where: { cmp: "gt" as const, left: { field: num }, right: { input: "floor" } } }] : []), { op: "limit", n: { value: 1000, from: "catalogue" } }] }, cat);
      base = must(base, { op: "add_loop", id: "each", over: "rows", concurrency: 2 }, cat);
    } catch { continue; }
    // Every tool this reader's items can feed, one flow each, until a batch has actually SUCCEEDED (a whole batch failing is the
    // other case, and is checked too).
    for (const [tref, t] of Object.entries(cat.refs)) {
      if (sawSuccess) break;
      if (t.kind !== "tool" || t.modelText || tried.has(tref)) continue;
      const added = apply(base, { op: "add_call", id: "send", ref: tref, under: "each" }, cat);
      if (!added.ok) continue;
      const done = fillPorts(added.flow, cat, (x) => x.stepId === "each");
      const ins = (done?.steps.find((x) => x.id === "send") as { inputs: Array<{ source: { from: string; stepId?: string } | null }> } | undefined)?.inputs ?? [];
      // Batched only when every input is the item, a literal or a run input (D-370) — and at least one IS the item.
      if (!done || !ins.every((b) => !b.source || b.source.from !== "step" || b.source.stepId === "each") || !ins.some((b) => b.source?.from === "step" && b.source.stepId === "each")) continue;
      tried.add(tref);
      let f: EFlow;
      try { f = must(must(done, { op: "close_loop", id: "results", loop: "each", result: "send" }, cat), { op: "set_output", stepId: "results" }, cat); } catch { continue; }
      if (holesOf(checkState(f, cat)).length) continue;
      console.log(`  reader ${ref}, one call per item: ${tref} — batched`);
      const { flowId } = await canvasCreate(ws, `for each batch e2e (harness) ${Date.now().toString(36)}`);
      made.push({ ws, flowId });
      const saved = await saveState(ws, flowId, f, systemAuthor("foreach-e2e"), "canvas");
      ok(saved.status === "complete", `the one-call loop saved as a revision (${saved.status})`);
      for (const [floor, label] of [[-1e9, "every row"], [1e18, "an EMPTY list"]] as const) {
        if (floor > 0 && !num) continue;
        console.log(`\n  batched — ${label}`);
        const ex = await runDraft(ws, flowId, { floor: String(floor) });
        console.log(`    ${stepReport(ex).slice(0, 300)}`);
        ok(ex.state.current === "SUCCESS" || ex.state.current === "WARNING", `the run settles (${ex.state.current})`);
        const task = (id: string) => (ex.taskRunList ?? []).filter((x) => x.taskId === id);
        const rowsIn = json(task("each-rows")[0]?.outputs?.value) as Row[] | undefined;
        const n = rowsIn?.length ?? -1;
        ok(task("each-chunks").length === 1, "the rows were cut into batches (each-chunks ran)");
        const calls = task("send");
        ok(calls.length === Math.ceil(n / LOOP_BATCH), `ONE step-API call per batch of up to ${LOOP_BATCH}: ${n} items → ${calls.length} call(s)`);
        // Each batch's own envelope is the oracle: a batch that answered reports one result per row; one that failed whole
        // (the step API's 502 when EVERY call in it failed) has none, and all its items must read not ok.
        const envs = calls.map((c) => json(c.outputs?.body) as { results?: unknown[]; succeeded?: number } | undefined);
        const answered = envs.filter((e) => Array.isArray(e?.results));
        ok(answered.every((e) => e!.results!.length <= LOOP_BATCH) && answered.reduce((a, e) => a + e!.results!.length, 0) === n - (calls.length - answered.length ? calls.filter((_, k) => !Array.isArray(envs[k]?.results)).reduce((a, _, k) => a + Math.min(LOOP_BATCH, n - k * LOOP_BATCH), 0) : 0),
          `every batch that answered reports one result per row of its chunk (${answered.length} of ${calls.length} answered)`);
        const succeeded = answered.reduce((a, e) => a + (e?.succeeded ?? 0), 0);
        const out = json(task("results")[0]?.outputs?.value) as Array<Row & { ff_i: number; ff_ok: boolean; ff_error?: string; ff_result: unknown }> | undefined;
        ok(Array.isArray(out) && out.length === n, `one output row per item (${Array.isArray(out) ? out.length : "—"} of ${n})`);
        if (!Array.isArray(out) || !rowsIn) continue;
        ok(out.every((r, i) => r.ff_i === i && JSON.stringify({ ...r, ff_i: undefined, ff_ok: undefined, ff_error: undefined, ff_result: undefined }) === JSON.stringify({ ...rowsIn[i], _i: undefined })), "in input order, each row carrying its own item's fields");
        ok(out.filter((r) => r.ff_ok).length === succeeded, `ff_ok per item agrees with the batches' own count of successes (${succeeded} of ${n})`);
        ok(out.every((r) => (r.ff_ok ? r.ff_result != null : (r.ff_result ?? null) === null && !!r.ff_error)), "ff_result present exactly when the item worked; a failed item carries its error");
        const failedOne = out.find((r) => !r.ff_ok);
        if (failedOne) console.log(`    a failed item says: ${String(failedOne.ff_error).slice(0, 160)}`);
        const fx = await flowExecutionRepo.getByKestraId(ex.id);
        const shown = fx ? await flowVisibilityService.get(ws, fx.id) : null;
        const loopView = shown?.steps.find((x) => x.stepId === "each"), sendView = shown?.steps.filter((x) => x.stepId === "send") ?? [];
        ok(loopView?.items?.length === n && loopView.items.every((x, i) => x.i === i && (x.status === "success") === out[i]!.ff_ok), `the run view lists every ITEM in order, its status its own (${loopView?.items?.length ?? "—"})`);
        ok(n === 0 ? sendView.length === 0 : sendView.length === 1 && sendView[0]!.perItem?.ran === n, `the call is ONE view counted per item, not per batch (${sendView[0]?.perItem?.ran ?? 0} items)`);
        if (n > 0 && succeeded > 0) sawSuccess = true;
        if (n > 0 && answered.length < calls.length) sawWholeFail = true;
      }
    }
  }
  console.log(`\n  batched: a batch that succeeded ${sawSuccess ? "seen" : "NOT seen"}; a batch that failed whole ${sawWholeFail ? "seen" : "not seen"}`);
  return sawSuccess;
}

const workspaces = (await workspaceRepo.list()).filter((w) => !w.deletedAt && (!only || w.id === only));
const made: Array<{ ws: string; flowId: string }> = [];
let proved = false;
try {
  for (const w of workspaces) {
    if (proved) break;
    console.log(`\n${w.name}`);
    notifyRef = null;
    const b = await build(w.id);
    if (!b) { console.log("  (no fillable reader with a number field here — next workspace)"); continue; }
    const first = await runOnce(w.id, b, -1e9, 1e9, "every row, threshold above all (ELSE for every item)");
    if (!first) break;
    const values = first.all.map((r) => r[b.field]).filter((x): x is number => typeof x === "number").sort((a, c) => a - c);
    if (values.length < 2 || values[0] === values.at(-1)) { ok(false, `${b.field} has fewer than two distinct values — cannot split the items`); break; }
    const second = await runOnce(w.id, b, -1e9, values[0]!, "every row, threshold at the smallest (IF for all but the smallest)");
    ok(!!second && second.split !== first.split, "CONTROL: the two thresholds split the items differently");
    const dupes = values.length !== new Set(first.all.map((r) => JSON.stringify(r))).size;
    console.log(`    (${dupes ? "the rows include identical ones" : "no two rows identical here — identity is proven by kestra:foreach"})`);
    const empty = await runOnce(w.id, b, values.at(-1)!, 0, "floor above the largest (an EMPTY list)");
    ok(!!empty, "an empty list runs the loop over nothing and its output is []");
    console.log(`\n${w.name} — a one-call loop, in batches (D-370)`);
    ok(await provesBatch(w.id), "a one-call loop was built, run in batches and read back");
    proved = true;
  }
  ok(proved, "a workspace with a fillable reader was found and proven");
} catch (e) { ok(false, `threw: ${(e as Error).message.slice(0, 400)}`); }
finally {
  for (const m of made) await flowService.remove(m.ws, m.flowId);
  console.log(`\n(${made.length} flow(s) deleted)`);
}
console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
