/**
 * `kestra-bindings` — I-286 and task 4's engine sample (compiled-builder phase 3): is the soundness fuzz's BINDING evaluator
 * what the engine does? The fuzz (`fuzzFlow`) decides what each call RECEIVES by reading `render.ts`; pipelines were proven
 * on the engine in phase 2, bindings never were. This runs the compiled flows themselves on Kestra and compares.
 *
 *   scripts/harness-in-net.sh packages/server/src/scenarios/kestra-bindings.ts [--flows=40] [--runs=2]
 *
 * For a sample of COMPLETE states the property walk reaches (the deployment's 10 catalogue fixtures):
 *  1. the compiled YAML is sent to Kestra's `flows/validate` — never deployed (task 4: "pass Kestra validateFlow for a
 *     sampled subset");
 *  2. a PROOF flow is derived from it: every call step's HTTP request becomes two `Return` tasks — `<id>__sent` renders the
 *     request body the engine WOULD have posted, `<id>` returns the fuzz's conforming response as the body — and `begin` /
 *     `complete` and every gate (its request and its Pause) are dropped. ⚠ The proof flow contains NO `http.Request` task and no `secret(`, asserted before it is
 *     deployed, so nothing can be sent anywhere (the mail allowlist here is a real domain). It lives in `foundry.system`
 *     and is deleted afterwards;
 *  3. the params Kestra rendered are compared with the fuzz's trace of the same run (`wire`, modulo null-valued keys — I-281),
 *     and the server's REAL executor coercion (`coerceDeclaredNumbers` / `coerceSqlParams`) of Kestra's params with the
 *     fuzz's `coerced`.
 * Negative controls: the same comparison against a WRONG evaluator (every digit-string believed to arrive as a number) and
 * against another run's data must both disagree somewhere, or a green verdict means nothing. No model calls. Exits 1 unless
 * every comparison agrees and both controls fire.
 */
import { readFileSync } from "node:fs";
import { complete, emptyFlow, engineEqual, fuzzFlow, walk, type CatalogueSnapshot, type EFlow, type FuzzRunTrace } from "@foundry/flow-edit";
import { compilerRenderInputs } from "../services/flow-typecheck.js";
import { gateRevisionModel } from "../services/flow.service.js";
import { namespaceFor } from "../services/kestra-client.service.js";
import { coerceDeclaredNumbers, coerceSqlParams } from "../services/query-row-numbers.js";
import type { FlowModel } from "../services/flow-compiler.service.js";
import type { RefInterface } from "../services/manifest-builder.service.js";

const base = process.env.KESTRA_BASE_URL, header = process.env.KESTRA_AUTH;
if (!base || !header) throw new Error("need KESTRA_BASE_URL and KESTRA_AUTH (run through scripts/harness-in-net.sh)");
const auth = { authorization: header };
const arg = (k: string, d: number) => Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d);
const FLOWS = arg("flows", 40), RUNS = arg("runs", 2), MAX_ROWS = 4;

type Fixture = { workspace: string; cat: CatalogueSnapshot; ifaces: Record<string, RefInterface> };
const CATALOGUES: Fixture[] = JSON.parse(readFileSync(new URL("../services/__fixtures__/engine-catalogues.json", import.meta.url), "utf8"));

/** A null-valued key is dropped by the engine (I-281); compare modulo those, recursively. */
const dropNulls = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(dropNulls) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => [k, dropNulls(x)])) : v;
const same = (a: unknown, b: unknown) => engineEqual(dropNulls(a), dropNulls(b));

// ── 1. Sample complete states, preferring variety ─────────────────────────────
interface Sample { fx: Fixture; state: EFlow; seed: number }
function sample(): Sample[] {
  const out: Sample[] = [];
  const seen = new Map<string, number>();
  for (let seed = 60_000; out.length < FLOWS && seed < 70_000; seed++) {
    const fx = CATALOGUES[seed % CATALOGUES.length]!;
    const cat = { ...fx.cat, renderInputs: compilerRenderInputs };
    let st: EFlow | undefined;
    try {
      const w = walk(emptyFlow(`bind-${seed}`), cat, 1 + (seed % 30), seed);
      st = complete(w.at(-1)?.flow ?? emptyFlow(`bind-${seed}`), cat, seed).at(-1)?.flow;
    } catch { continue; }
    if (!st || st.holes.length || !st.steps.some((s) => s.kind === "tool" || s.kind === "datasource")) continue;
    // D-320: at least half the sample is conditional, while conditional flows are still being found.
    if (!st.steps.some((s) => s.kind === "branch") && out.filter((x) => !x.state.steps.some((s) => s.kind === "branch")).length >= Math.floor(FLOWS / 2) && seed < 68_000) continue;
    // A feature signature, so the sample is not 40 copies of one shape.
    const sources = new Set(st.steps.flatMap((s) => ("inputs" in s ? s.inputs.map((b) => b.source?.from ?? "none") : [])));
    const kinds = ["branch", "merge"].filter((k) => st!.steps.some((s) => s.kind === k));
    if (st.steps.some((s) => s.kind === "branch" && s.elseOf)) kinds.push(st.steps.some((s) => s.kind === "branch" && s.elseOf && !s.conditions?.length) ? "else" : "elif");
    const sig = [st.steps.some((s) => s.kind === "tool" && s.over) ? "fanout" : "", ...kinds, ...[...sources].sort()].join("+");
    if ((seen.get(sig) ?? 0) >= Math.max(3, Math.ceil(FLOWS / 8))) continue;
    seen.set(sig, (seen.get(sig) ?? 0) + 1);
    out.push({ fx, state: st, seed });
  }
  return out;
}

// ── 2. The proof flow: every call rendered, nothing sent ──────────────────────
/**
 * Every call, gate, `begin` and `complete` task is a LEAF, at whatever depth it sits (a guarded one is nested in an `If`'s
 * `then:`/`else:`, D-320). Each is found by its `- id:` line and ends at the next non-empty line indented no deeper than its
 * dash; it is replaced in place, at the same indent, so the `If` blocks around it are untouched.
 */
function proofFlow(yaml: string, id: string, calls: string[], gates: string[]): string {
  const [head, tasksPart] = yaml.split(/\ntasks:\n/);
  if (!tasksPart) throw new Error("compiled YAML has no tasks section");
  const lines = tasksPart.split("\n");
  const out: string[] = [];
  const indent = (l: string) => l.length - l.trimStart().length;
  for (let i = 0; i < lines.length; ) {
    const m = /^(\s*)- id: (\S+)$/.exec(lines[i]!);
    const tid = m?.[2];
    const leaf = tid && (tid === "begin" || tid === "complete" || calls.includes(tid) || gates.includes(tid) || gates.some((g) => tid === `${g}_await`));
    if (!m || !leaf) { out.push(lines[i]!); i++; continue; }
    const k = m[1]!.length;
    let j = i + 1;
    while (j < lines.length && (lines[j] === "" || indent(lines[j]!) > k)) j++;
    const block = lines.slice(i, j);
    i = j;
    // `begin`/`complete` and every gate (its request and its Pause) carry no data downstream (the fuzz skips a gate).
    if (!calls.includes(tid)) continue;
    const pad = " ".repeat(k);
    const at = block.findIndex((l) => l === `${pad}  body: |`);
    if (at < 0) throw new Error(`call \`${tid}\` has no block-scalar body`);
    const body = block.slice(at + 1).filter((l) => l.startsWith(`${pad}    `) || l === "");
    out.push(`${pad}- id: ${tid}__sent`, `${pad}  type: io.kestra.plugin.core.debug.Return`, `${pad}  format: |`, ...body);
    out.push(`${pad}- id: ${tid}`, `${pad}  type: io.kestra.plugin.core.debug.Return`, `${pad}  format: "{{ inputs.r_${tid} }}"`);
  }
  let h = head!.replace(/^id: .*$/m, `id: ${id}`).replace(/^namespace: .*$/m, "namespace: foundry.system");
  const extra = calls.map((c) => `  - id: r_${c}\n    type: STRING`).join("\n");
  h = /\ninputs:\n/.test(h) ? h.replace(/\ninputs:\n/, `\ninputs:\n${extra}\n`) : `${h}\ninputs:\n${extra}`;
  let y = `${h}\ntasks:\n${out.join("\n").replace(/\n+$/, "")}\n`;
  for (const c of calls) y = y.split(`outputs.${c}.body`).join(`outputs.${c}.value`);
  // ⚠ The safety of this harness is these two lines: no request task, no secret, or it does not deploy.
  if (/http\.Request|secret\(|\/api\/steps\/|\/api\/executions\//.test(y)) throw new Error(`proof flow \`${id}\` still reaches out:\n${y}`);
  return y;
}

async function kestra(path: string, init: RequestInit = {}) {
  const r = await fetch(`${base}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
  return r;
}

async function execute(id: string, form: FormData): Promise<{ state: string; outputs: Map<string, string>; failed: string[]; ran: Set<string>; refused?: string }> {
  const ex = (await (await kestra(`/api/v1/main/executions/foundry.system/${id}`, { method: "POST", body: form })).json()) as { id?: string; message?: string };
  // Refused at CREATION (e.g. a required input the fuzz drew as ""): the run never starts, so nothing inside it can go wrong.
  if (!ex.id) return { state: "REFUSED", outputs: new Map(), failed: [], ran: new Set(), refused: String(ex.message ?? JSON.stringify(ex)).slice(0, 200) };
  let e: { state: { current: string }; taskRunList?: Array<{ taskId: string; state: { current: string }; outputs?: { value?: string } }> } | undefined;
  for (let t = 0; t < 120; t++) {
    e = (await (await kestra(`/api/v1/main/executions/${ex.id}`)).json()) as typeof e;
    if (["SUCCESS", "FAILED", "WARNING", "KILLED"].includes(e!.state.current)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const outputs = new Map<string, string>();
  const failed: string[] = [];
  const ran = new Set((e?.taskRunList ?? []).filter((t) => t.state.current === "SUCCESS").map((t) => t.taskId));
  const logs = failedTasks(e) ? ((await (await kestra(`/api/v1/main/logs/${ex.id}?minLevel=ERROR`)).json().catch(() => [])) as Array<{ taskId?: string; message?: string }>) : [];
  for (const tr of e?.taskRunList ?? []) {
    if (tr.state.current !== "SUCCESS") failed.push(`${tr.taskId}: ${(logs.find((l) => l.taskId === tr.taskId)?.message ?? "no log").slice(0, 300)}`);
    if (tr.outputs?.value !== undefined) outputs.set(tr.taskId, tr.outputs.value);
  }
  return { state: e?.state.current ?? "UNKNOWN", outputs, failed, ran };
}

const failedTasks = (e: { taskRunList?: Array<{ state: { current: string } }> } | undefined) => (e?.taskRunList ?? []).some((t) => t.state.current !== "SUCCESS");

/** The fuzz's response for a call, as Foundry's step API envelopes it (`results[i].data`, one per call). */
const envelope = (responses: unknown[]) => JSON.stringify({ results: responses.map((data) => ({ data })), succeeded: responses.length, failed: 0, warnings: [] });

/** A wrong evaluator, for the control: believes a digit-string arrives as a number. */
const wrongly = (ps: Record<string, unknown>[]) => ps.map((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : v])));

async function main() {
  const samples = sample();
  console.log(`sampled ${samples.length} complete flows`);
  // What the sample COVERS of D-320 — a construct absent here was not checked on the engine.
  const has = (p: (st: EFlow) => boolean) => samples.filter((x) => p(x.state)).length;
  const kindOf = (st: EFlow, id: string) => st.steps.find((s) => s.id === id)?.kind;
  const branchesOf = (st: EFlow) => st.steps.filter((s): s is EFlow["steps"][number] & { kind: "branch" } => s.kind === "branch");
  console.log(`covers: conditional ${has((st) => branchesOf(st).length > 0)} · on a reader ${has((st) => branchesOf(st).some((b) => b.conditions?.some((c) => kindOf(st, c.left.stepId) === "datasource")))} · on a transform ${has((st) => branchesOf(st).some((b) => b.conditions?.some((c) => kindOf(st, c.left.stepId) === "transform")))} · two tests ${has((st) => branchesOf(st).some((b) => (b.conditions?.length ?? 0) > 1))} · none ${has((st) => branchesOf(st).some((b) => b.conditions?.some((c) => c.op === "none")))} · elif ${has((st) => branchesOf(st).some((b) => b.elseOf && b.conditions?.length))} · else ${has((st) => branchesOf(st).some((b) => b.elseOf && !b.conditions?.length))} · guarded call ${has((st) => st.steps.some((s) => (s.kind === "tool" || s.kind === "datasource") && s.dependsOn.some((d) => kindOf(st, d) === "branch")))} · merge ${has((st) => st.steps.some((s) => s.kind === "merge"))} · merge with a top-level fallback ${has((st) => st.steps.some((s) => s.kind === "merge" && !st.steps.find((x) => x.id === s.sources.at(-1))!.dependsOn.some((d) => kindOf(st, d) === "branch")))}`);
  let validated = 0, compared = 0, agreeWire = 0, agreeCoerced = 0, controlWrong = 0, controlOther = 0, controlComparable = 0;
  // D-320: which steps ran (so which arm), and what each merge produced.
  const arms = { runs: 0, agree: 0, taken: 0, untaken: 0, merges: 0, mergeAgree: 0, controlFlip: 0, controlFlipComparable: 0 };
  const failures: string[] = [];
  const notRunnable: string[] = [];
  const allowances = { dbBool: 0, pgArray: 0 };
  for (const [n, { fx, state, seed }] of samples.entries()) {
    const cat = { ...fx.cat, renderInputs: compilerRenderInputs };
    const { compiled } = await gateRevisionModel(state as unknown as FlowModel, {
      catalogue: async () => cat, refNames: Object.keys(fx.ifaces), interfaces: fx.ifaces, allowedModels: [], contracts: {},
      compile: { namespace: namespaceFor("bind", "check", "draft"), withSchedule: false, labels: {} },
    });
    // Task 4: the engine's own validator, on the YAML as compiled.
    const v = await kestra("/api/v1/main/flows/validate", { method: "POST", headers: { "content-type": "application/x-yaml" }, body: compiled.yaml });
    const verdict = (await v.json()) as Array<{ constraints?: string }>;
    if (!v.ok || verdict.some((x) => x.constraints)) failures.push(`[${fx.workspace}] seed ${seed}: Kestra validate refused: ${JSON.stringify(verdict).slice(0, 400)}`);
    else validated++;

    const calls = state.steps.filter((s) => s.kind === "tool" || s.kind === "datasource").map((s) => s.id);
    const id = `bind-proof-${Date.now()}-${n}`;
    const yaml = proofFlow(compiled.yaml, id, calls, state.steps.filter((s) => s.kind === "approval").map((s) => s.id));
    const dep = await kestra("/api/v1/main/flows", { method: "POST", headers: { "content-type": "application/x-yaml" }, body: yaml });
    if (!dep.ok) { failures.push(`[${fx.workspace}] seed ${seed}: proof deploy ${dep.status}: ${(await dep.text()).slice(0, 300)}`); continue; }
    try {
      const report = fuzzFlow(state, cat, RUNS, seed, cat, { maxRows: MAX_ROWS, trace: true });
      if (report.errors.length) { failures.push(`[${fx.workspace}] seed ${seed}: the fuzz itself failed: ${report.errors[0]}`); continue; }
      const traces = report.traces!;
      for (const [k, t] of traces.entries()) {
        const form = new FormData();
        for (const i of state.inputs) if (i.defaults === undefined && t.inputs[i.id] !== null && t.inputs[i.id] !== undefined) form.append(i.id, String(t.inputs[i.id]));
        for (const c of t.calls) form.append(`r_${c.stepId}`, envelope(c.responses));
        // A call the fuzz never reached (an earlier failure) gets an empty envelope so the flow still runs.
        for (const c of calls) if (!t.calls.some((x) => x.stepId === c)) form.append(`r_${c}`, envelope([]));
        const run = await execute(id, form);
        if (run.refused) { notRunnable.push(`[${fx.workspace}] seed ${seed} run ${k}: ${run.refused} (inputs ${JSON.stringify(t.inputs).slice(0, 160)})`); continue; }
        if (run.failed.length) { failures.push(`[${fx.workspace}] seed ${seed} run ${k}: engine ${run.state}, failed ${run.failed.join(" · ")}\n  proof flow task: ${yaml.split("\n  - id: ").find((b) => run.failed.some((f) => f.startsWith(b.split("\n")[0]!)))?.slice(0, 700)}`); continue; }
        // D-320: the steps that ran on the engine are the ones the fuzz ran — which arm, exactly. A call ran iff its `__sent` did.
        const judged = state.steps.filter((s) => s.kind === "transform" || s.kind === "merge" || s.kind === "tool" || s.kind === "datasource").map((s) => s.id);
        const engineRan = new Set(judged.filter((sid) => run.ran.has(calls.includes(sid) ? `${sid}__sent` : sid)));
        const fuzzRan = new Set(judged.filter((sid) => t.ran.includes(sid)));
        if (state.steps.some((s) => s.kind === "branch")) {
          arms.runs++;
          const guarded = state.steps.filter((s) => s.dependsOn.some((d) => state.steps.find((x) => x.id === d)?.kind === "branch")).map((s) => s.id);
          arms.taken += guarded.filter((g) => fuzzRan.has(g)).length;
          arms.untaken += guarded.filter((g) => !fuzzRan.has(g)).length;
          if ([...engineRan].sort().join() === [...fuzzRan].sort().join()) arms.agree++;
          else failures.push(`[${fx.workspace}] seed ${seed} run ${k}: a different ARM ran\n  engine: ${[...engineRan].join(", ")}\n  fuzz:   ${[...fuzzRan].join(", ")}`);
          // CONTROL: flip every guarded step's fate — an arm check that cannot tell taken from untaken would agree with this too.
          if (guarded.length) { arms.controlFlipComparable++; const flipped = new Set(judged.filter((sid) => guarded.includes(sid) ? !fuzzRan.has(sid) : fuzzRan.has(sid))); if ([...engineRan].sort().join() !== [...flipped].sort().join()) arms.controlFlip++; }
        }
        for (const mg of state.steps.filter((s) => s.kind === "merge")) {
          arms.merges++;
          const got = run.outputs.get(mg.id);
          let v: unknown;
          try { v = got === undefined ? undefined : JSON.parse(got); } catch { v = got; }
          if (same(v, t.values[mg.id])) arms.mergeAgree++;
          else failures.push(`[${fx.workspace}] seed ${seed} run ${k}: merge \`${mg.id}\` differs\n  engine: ${String(got).slice(0, 300)}\n  fuzz:   ${JSON.stringify(t.values[mg.id]).slice(0, 300)}`);
        }
        const other: FuzzRunTrace | undefined = traces[(k + 1) % traces.length] !== t ? traces[(k + 1) % traces.length] : undefined;
        for (const c of t.calls) {
          const sent = run.outputs.get(`${c.stepId}__sent`);
          if (sent === undefined) { failures.push(`[${fx.workspace}] seed ${seed} run ${k}: \`${c.stepId}\` rendered nothing`); continue; }
          let params: Record<string, unknown>[];
          try { params = (JSON.parse(sent) as { params: Record<string, unknown>[] }).params; }
          catch { failures.push(`[${fx.workspace}] seed ${seed} run ${k}: \`${c.stepId}\`'s rendered body is not JSON: ${sent.slice(0, 200)}`); continue; }
          compared++;
          if (same(params, c.wire)) agreeWire++;
          else failures.push(`[${fx.workspace}] seed ${seed} run ${k}: \`${c.stepId}\` WIRE differs\n  engine: ${JSON.stringify(params).slice(0, 400)}\n  fuzz:   ${JSON.stringify(c.wire).slice(0, 400)}`);
          // The executor's real coercion of what the engine sent, against the fuzz's model of it.
          const ref = state.steps.find((s) => s.id === c.stepId) as { ref?: string };
          const schema = Object.fromEntries((fx.ifaces[ref.ref ?? ""]?.params ?? []).map((p) => [p.name, { type: p.type }]));
          const real = params.map((p) => (c.kind === "datasource" ? coerceSqlParams(p, schema) : coerceDeclaredNumbers(p, schema)));
          // Two differences are the DATABASE's, not the executor's, and the fuzz models the database: a Bool param sent as
          // "true" is cast by Postgres; a declared array becomes a Postgres literal the driver sends as text. Counted, not hidden.
          const modelled = c.coerced.map((p, i) => Object.fromEntries(Object.entries(p).map(([key, val]) => {
            const r = real[i]?.[key];
            if (c.kind === "datasource" && typeof val === "boolean" && r === String(val)) { allowances.dbBool++; return [key, r]; }
            if (c.kind === "datasource" && Array.isArray(val) && typeof r === "string" && r.startsWith("{")) { allowances.pgArray++; return [key, r]; }
            return [key, val];
          })));
          if (same(real, modelled)) agreeCoerced++;
          else failures.push(`[${fx.workspace}] seed ${seed} run ${k}: \`${c.stepId}\` COERCED differs\n  executor: ${JSON.stringify(real).slice(0, 400)}\n  fuzz:     ${JSON.stringify(c.coerced).slice(0, 400)}`);
          // Controls: a wrong evaluator, and another run's data. Counted only where they COULD differ.
          if (!same(wrongly(c.wire), c.wire)) { controlComparable++; if (!same(params, wrongly(c.wire))) controlWrong++; }
          const o = other?.calls.find((x) => x.stepId === c.stepId);
          if (o && !same(o.wire, c.wire) && !same(params, o.wire)) controlOther++;
        }
      }
    } finally {
      await kestra(`/api/v1/main/flows/foundry.system/${id}`, { method: "DELETE" });
    }
  }
  console.log(`validated ${validated}/${samples.length} · calls compared ${compared} · wire agrees ${agreeWire} · coerced agrees ${agreeCoerced}`);
  console.log(`allowances (the database's casts, modelled by the fuzz): Bool ${allowances.dbBool} · array ${allowances.pgArray}`);
  console.log(`CONTROL wrong evaluator: disagreed ${controlWrong} of ${controlComparable} comparable · CONTROL other run's data: disagreed ${controlOther}`);
  console.log(`D-320 arms: ${arms.agree}/${arms.runs} conditional runs ran the same steps (guarded steps taken ${arms.taken} · not taken ${arms.untaken}) · merges ${arms.mergeAgree}/${arms.merges} · CONTROL flipped arms disagreed ${arms.controlFlip} of ${arms.controlFlipComparable}`);
  console.log(`refused at creation by the engine (the run never starts): ${notRunnable.length}`);
  for (const f of notRunnable.slice(0, 6)) console.log(`  NOT RUNNABLE ${f}`);
  for (const f of failures.slice(0, 12)) console.log(`FAIL ${f}`);
  const held = failures.length === 0 && compared > 0 && agreeWire === compared && agreeCoerced === compared && arms.runs > 0 && arms.agree === arms.runs && arms.mergeAgree === arms.merges && arms.taken > 0 && arms.untaken > 0 && arms.merges > 0;
  const controls = controlWrong > 0 && controlOther > 0 && arms.controlFlip === arms.controlFlipComparable && arms.controlFlipComparable > 0;
  console.log(held && controls ? "I-286 HOLDS: the fuzz's binding evaluator is what the engine renders" : `I-286 ${held ? "" : "FAILS"}${controls ? "" : " — a control did not fire"}`);
  process.exit(held && controls ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
