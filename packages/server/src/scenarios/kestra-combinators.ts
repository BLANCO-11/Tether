/**
 * `kestra:combinators` — the ENGINE PROOF of every combinator lowering (compiled-builder 2d; the admission kit's authority).
 *
 *   scripts/harness-in-net.sh packages/server/src/scenarios/kestra-combinators.ts
 *
 * Kestra runs jackson-jq, not C jq, so local jq (the unit test) is a fast loop and this is the verdict. One throwaway flow
 * in `foundry.system` (two segments: it can never mint an execution token, D-09), deleted afterwards. Each case is one
 * `Return` task whose format is EXACTLY the shape `lowerTransformProgram` emits for a transform:
 *   {{ <rows> | jq('(<program>) | if type == "string" then {text: .} else . end') | first }}
 * with the fixture passed as a typed JSON flow INPUT, never spliced into the template, so an apostrophe or a newline in a
 * fixture cannot change the program. Exits 1 unless every case agrees with the evaluator AND the negative control fires.
 */
import { SLICE_1_CASES, SLICE_2_CASES, SLICE_3_CASES, SLICE_4_CASES, SLICE_5_CASES, SLICE_6_CASES, SLICE_7_CASES, SLICE_C_CASES, admit, lowerPipeline, spliceInputs, withContext, type AdmissionCase } from "@foundry/flow-edit";

const ALL_CASES: AdmissionCase[] = [...SLICE_1_CASES, ...SLICE_2_CASES, ...SLICE_3_CASES, ...SLICE_4_CASES, ...SLICE_5_CASES, ...SLICE_6_CASES, ...SLICE_7_CASES, ...SLICE_C_CASES];
const ctxOf = (c: AdmissionCase) => ({ inputs: Object.fromEntries(Object.entries(c.inputs ?? {}).map(([k, v]) => [k, v.ty])) });
const lowered = (c: AdmissionCase, lowerFn: typeof lowerPipeline) => withContext(ctxOf(c), () => lowerFn(c.inputTy, c.pipeline));

const base = process.env.KESTRA_BASE_URL, header = process.env.KESTRA_AUTH;
if (!base || !header) throw new Error("need KESTRA_BASE_URL and KESTRA_AUTH (run through scripts/harness-in-net.sh)");
const auth = { authorization: header };

const keyOf = (program: string, input: unknown) => `${program}::${JSON.stringify(input)}`;

async function runOnEngine(cases: AdmissionCase[], lowerFn: typeof lowerPipeline): Promise<Map<string, unknown>> {
  const id = `combinators-proof-${Date.now()}`;
  const yaml = [
    `id: ${id}`,
    "namespace: foundry.system",
    "inputs:",
    ...cases.map((_, i) => `  - id: d${i}\n    type: JSON`),
    // Flow inputs the combinators read (ids are unique across cases by construction of the fixtures).
    ...cases.flatMap((c) => Object.entries(c.inputs ?? {}).map(([k, v]) => `  - id: ${k}\n    type: ${v.kestra}`)),
    "tasks:",
    ...cases.map((c, i) => {
      // EXACTLY the transform wrapper, with inputs spliced the way the compiler will (`spliceInputs`).
      const program = `(${lowered(c, lowerFn)}) | if type == "string" then {text: .} else . end`;
      const format = `{{ inputs.d${i} | jq(${spliceInputs(program)}) | first }}`;
      return `  - id: c${i}\n    type: io.kestra.plugin.core.debug.Return\n    allowFailure: true\n    format: ${JSON.stringify(format)}`;
    }),
  ].join("\n");
  const dep = await fetch(`${base}/api/v1/main/flows`, { method: "POST", headers: { ...auth, "content-type": "application/x-yaml" }, body: yaml });
  if (!dep.ok) throw new Error(`deploy ${dep.status}: ${(await dep.text()).slice(0, 400)}`);
  try {
    const form = new FormData();
    cases.forEach((c, i) => form.append(`d${i}`, JSON.stringify(c.input)));
    for (const c of cases) for (const [k, v] of Object.entries(c.inputs ?? {})) form.append(k, String(v.value));
    const ex = await (await fetch(`${base}/api/v1/main/executions/foundry.system/${id}`, { method: "POST", headers: auth, body: form })).json() as { id: string };
    let e: { state: { current: string }; taskRunList?: Array<{ taskId: string; state: { current: string }; outputs?: { value?: string } }> } | undefined;
    for (let t = 0; t < 90; t++) {
      e = (await (await fetch(`${base}/api/v1/main/executions/${ex.id}`, { headers: auth })).json()) as typeof e;
      if (["SUCCESS", "FAILED", "WARNING", "KILLED"].includes(e!.state.current)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const out = new Map<string, unknown>();
    for (const tr of e?.taskRunList ?? []) {
      const c = cases[Number(tr.taskId.slice(1))]!;
      const v = tr.outputs?.value;
      out.set(keyOf(lowered(c, lowerFn), c.input), tr.state.current !== "SUCCESS" || v === undefined ? new Error(`task ${tr.taskId} ${tr.state.current}`)
        // ⚠ ENGINE FACT (I-282): a null result RENDERS as the empty string. Mapped back to null here so the comparison
        // is about the value; the rule that stops a real transform ending in null is `typeTransform`.
        : v === "" ? null : JSON.parse(v));
    }
    return out;
  } finally {
    await fetch(`${base}/api/v1/main/flows/foundry.system/${id}`, { method: "DELETE", headers: auth });
  }
}

async function proof(label: string, lowerFn: typeof lowerPipeline) {
  const engine = await runOnEngine(ALL_CASES, lowerFn);
  // The kit asks the runner per case; the runner answers from the one execution, by the case it is asked about.
  const report = await admit(ALL_CASES, async (program, input) => {
    const v = engine.get(keyOf(program, input));
    if (v === undefined) throw new Error("no engine answer for this case");
    if (v instanceof Error) throw v;
    return v;
  }, lowerFn);
  console.log(`\n${label}: ${report.admitted ? "ADMITTED" : "REFUSED"}`);
  for (const r of report.results) console.log(`  ${r.ok ? "agree   " : "DISAGREE"} ${r.case}${r.detail ? `\n           ${r.detail.slice(0, 300)}` : ""}`);
  return report.admitted;
}

const ok = await proof("slices 1-7 on Kestra (jackson-jq)", lowerPipeline);
// Negative control: the same deliberately wrong lowering the unit test uses must be refused on the engine too.
const wrong = ((ty, p) => lowerPipeline(ty, p).replace(/ < /g, " <= ")) as typeof lowerPipeline;
const refused = !(await proof("NEGATIVE CONTROL (lt lowered as <=)", wrong));
console.log(`\n${ok && refused ? "PROOF HOLDS" : "PROOF FAILED"}: slice admitted on the engine ${ok}, wrong lowering refused ${refused}`);
process.exit(ok && refused ? 0 : 1);
