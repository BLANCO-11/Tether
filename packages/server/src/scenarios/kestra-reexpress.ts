/**
 * `kestra-reexpress` — the phase-2 exit gate ON THE ENGINE (compiled-builder 2d): every correct baseline transform's
 * ORIGINAL jq and its combinator RE-EXPRESSION, both run by Kestra (jackson-jq) over the same typed fixtures, judged by
 * the same `judgeReexpressions` the local-jq unit test uses. Local jq is the fast loop; this is the verdict.
 *
 *   scripts/harness-in-net.sh packages/server/src/scenarios/kestra-reexpress.ts
 *
 * Two passes: `reexpressPrograms` lists every (program, fixture) the judgement will ask for; one throwaway flow in
 * `foundry.system` runs them all (each a `Return` task, the fixture a typed JSON input, never spliced into the template);
 * the second pass judges from the engine's answers. Each program is wrapped as `{v: (…)}` so a bare string or a null
 * survives the render (I-282) and is read back exactly. Then the negative control: a wrong lowering must be caught on
 * the engine too. The flow is deleted afterwards. No model calls. Exits 1 unless the gate holds and the control fires.
 */
import { engineEqual, evaluatePipeline, judgeReexpressions, lowerPipeline, reexpressPrograms, typeTransform, type ProgramRunner } from "@foundry/flow-edit";

const base = process.env.KESTRA_BASE_URL, header = process.env.KESTRA_AUTH;
if (!base || !header) throw new Error("need KESTRA_BASE_URL and KESTRA_AUTH (run through scripts/harness-in-net.sh)");
const auth = { authorization: header };
const key = (program: string, input: unknown) => `${program}::${JSON.stringify(input)}`;

type Deps = Parameters<typeof judgeReexpressions>[1];
const deps: Deps = { lower: lowerPipeline, evaluate: evaluatePipeline, type: typeTransform, equal: engineEqual };

async function runOnEngine(pairs: Array<{ program: string; input: unknown }>): Promise<Map<string, unknown>> {
  const id = `reexpress-proof-${Date.now()}`;
  const inputs = [...new Map(pairs.map((p) => [JSON.stringify(p.input), p.input])).values()];
  const inputIx = new Map(inputs.map((v, i) => [JSON.stringify(v), i]));
  for (const p of pairs) if (p.program.includes("'")) throw new Error(`a program contains a single quote, which would close Pebble's string: ${p.program.slice(0, 80)}`);
  const yaml = [
    `id: ${id}`, "namespace: foundry.system", "inputs:",
    ...inputs.map((_, i) => `  - id: d${i}\n    type: JSON`),
    "tasks:",
    ...pairs.map((p, i) => {
      const format = `{{ inputs.d${inputIx.get(JSON.stringify(p.input))} | jq('{v: (${p.program})}') | first }}`;
      return `  - id: t${i}\n    type: io.kestra.plugin.core.debug.Return\n    allowFailure: true\n    format: ${JSON.stringify(format)}`;
    }),
  ].join("\n");
  const dep = await fetch(`${base}/api/v1/main/flows`, { method: "POST", headers: { ...auth, "content-type": "application/x-yaml" }, body: yaml });
  if (!dep.ok) throw new Error(`deploy ${dep.status}: ${(await dep.text()).slice(0, 400)}`);
  try {
    const form = new FormData();
    inputs.forEach((v, i) => form.append(`d${i}`, JSON.stringify(v)));
    const ex = (await (await fetch(`${base}/api/v1/main/executions/foundry.system/${id}`, { method: "POST", headers: auth, body: form })).json()) as { id: string };
    let e: { state: { current: string }; taskRunList?: Array<{ taskId: string; state: { current: string }; outputs?: { value?: string } }> } | undefined;
    for (let t = 0; t < 240; t++) {
      e = (await (await fetch(`${base}/api/v1/main/executions/${ex.id}`, { headers: auth })).json()) as typeof e;
      if (["SUCCESS", "FAILED", "WARNING", "KILLED"].includes(e!.state.current)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const out = new Map<string, unknown>();
    for (const tr of e?.taskRunList ?? []) {
      const p = pairs[Number(tr.taskId.slice(1))]!;
      const v = tr.outputs?.value;
      out.set(key(p.program, p.input), tr.state.current !== "SUCCESS" || v === undefined ? new Error(`task ${tr.taskId} ${tr.state.current}`) : (JSON.parse(v) as { v?: unknown }).v ?? null);
    }
    return out;
  } finally {
    await fetch(`${base}/api/v1/main/flows/foundry.system/${id}`, { method: "DELETE", headers: auth });
  }
}

async function judgeOnEngine(label: string, d: Deps) {
  const pairs = reexpressPrograms(d.lower);
  const uniq = [...new Map(pairs.map((p) => [key(p.program, p.input), p])).values()];
  const engine = await runOnEngine(uniq);
  const run: ProgramRunner = async (program, input) => {
    const v = engine.get(key(program, input));
    if (v === undefined) throw new Error("no engine answer for this program");
    if (v instanceof Error) throw v;
    return v;
  };
  const r = await judgeReexpressions(run, d);
  const agree = r.results.filter((x) => x.kind === "agree").length, div = r.results.filter((x) => x.kind === "diverges-as-declared").length;
  const fails = r.results.filter((x) => !x.ok);
  console.log(`\n${label}: ${uniq.length} programs on the engine · ${r.expressed} transforms expressed, ${r.notAdmitted.length} not admitted · fixtures: ${agree} agree, ${div} diverge as declared, ${fails.length} FAIL`);
  for (const x of r.results) console.log(`  ${x.kind === "agree" ? "agree   " : x.kind === "FAIL" ? "FAIL    " : "DIVERGES"} ${x.id} / ${x.fixture}${x.detail ? `\n           ${x.detail.replace(/\n/g, "\n           ").slice(0, 600)}` : ""}`);
  return { r, fails };
}

const main = await judgeOnEngine("the correct baseline transforms, re-expressed, on Kestra (jackson-jq)", deps);
console.log("\nnot admitted:");
for (const n of main.r.notAdmitted) console.log(`  ${n.id}\n      ${n.reason}`);
const control = await judgeOnEngine("NEGATIVE CONTROL (gt lowered as >=)", { ...deps, lower: (ty, p) => lowerPipeline(ty, p).replace(/ > /g, " >= ") });
const holds = main.fails.length === 0, fired = control.fails.some((x) => /UNSOUND/.test(x.detail ?? ""));
console.log(`\n${holds && fired ? "GATE HOLDS" : "GATE FAILED"}: every expressed transform agrees on the engine ${holds}, wrong lowering caught ${fired}`);
process.exit(holds && fired ? 0 : 1);
