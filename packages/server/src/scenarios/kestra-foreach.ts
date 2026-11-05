/**
 * `kestra:foreach` — the ENGINE PROOF for the loop box (compiled-builder phase F, F0; E-F0.1 made repeatable).
 *
 *   scripts/harness-in-net.sh packages/server/src/scenarios/kestra-foreach.ts
 *
 * Throwaway flows in `foundry.system` (two segments: never an execution token, D-09), deleted afterwards. The shape proved is
 * the one the compiler will emit for a loop whose body is richer than one call: rows NUMBERED first (`_i`), a
 * `core.flow.ForEach` over them, an `If` per item whose arms read `parent.taskrun.value`, a per-item collector coalescing the
 * arms with `??`, and a tail that sorts the collected map back into input order.
 *
 * Asked at TWO thresholds (different arms fire for different items), each against an oracle computed here from the fixture:
 *   - every row runs once, identical rows included, and the tail is in input order
 *   - a nested field (`address.city`) reads per item
 *   - one item's result step fails: with `allowFailure` the others still run, that item reads FAILED, the run ends WARNING
 * CONTROLS, each of which must FIRE (without them "it works" could be the engine ignoring us):
 *   - looping over the raw rows (no `_i`) runs FEWER iterations than rows — the collapse the numbering exists to prevent
 *   - without `allowFailure` the whole run FAILS
 *   - an arm reading `taskrun.value` (not `parent.`) gets nothing: every item reads FAILED
 * Exits 1 unless every assertion holds and every control fires.
 */
import { collectBatchExpr } from "../services/flow-compiler.service.js";
const base = process.env.KESTRA_BASE_URL, header = process.env.KESTRA_AUTH;
if (!base || !header) throw new Error("need KESTRA_BASE_URL and KESTRA_AUTH (run through scripts/harness-in-net.sh)");
const auth = { authorization: header };

interface Row { name: string; n: number; address: { city: string }; fail?: boolean }
// Two identical rows (b), one that fails (c), and a nested field on every row.
const ROWS: Row[] = [
  { name: "a", n: 5, address: { city: "Leeds" } },
  { name: "b", n: 50, address: { city: "York" } },
  { name: "b", n: 50, address: { city: "York" } },
  { name: "c", n: 500, address: { city: "Hull" }, fail: true },
  { name: "d", n: 20, address: { city: "Bath" } },
];

type Variant = { numbered: boolean; keepGoing: boolean; armReads: "parent" | "self" };
const GOOD: Variant = { numbered: true, keepGoing: true, armReads: "parent" };

const y = (s: string) => JSON.stringify(s);
function flowYaml(id: string, v: Variant): string {
  const item = v.armReads === "parent" ? "parent.taskrun.value" : "taskrun.value";
  const allow = v.keepGoing ? "\n            allowFailure: true" : "";
  const values = v.numbered ? "{{ outputs.number.value }}" : "{{ inputs.rows | jq('.') | first | toJson }}";
  return [
    `id: ${id}`,
    "namespace: foundry.system",
    "inputs:",
    "  - id: rows\n    type: JSON",
    "  - id: t\n    type: INT",
    "tasks:",
    "  - id: number",
    "    type: io.kestra.plugin.core.debug.Return",
    `    format: ${y("{{ inputs.rows | jq('[to_entries[] | .value + {_i: .key}]') | first | toJson }}")}`,
    "  - id: loop",
    "    type: io.kestra.plugin.core.flow.ForEach",
    `    values: ${y(values)}`,
    "    concurrencyLimit: 2",
    "    tasks:",
    "      - id: city",
    "        type: io.kestra.plugin.core.debug.Return",
    `        format: ${y("{{ json(taskrun.value).address.city }}")}`,
    "      - id: decide",
    "        type: io.kestra.plugin.core.flow.If",
    `        condition: ${y("{{ json(taskrun.value).n > inputs.t }}")}`,
    "        then:",
    "          - id: big",
    "            type: io.kestra.plugin.core.debug.Return" + allow,
    // The failing row's result step fails for real (a parse error), so its output is absent — as a failed call's would be.
    `            format: ${y(`{% if json(${item}).fail ?? false %}{{ json('{not json') }}{% else %}big:{{ json(${item}).name }}{% endif %}`)}`,
    "        else:",
    "          - id: small",
    "            type: io.kestra.plugin.core.debug.Return" + allow,
    `            format: ${y(`small:{{ json(${item}).name }}`)}`,
    "      - id: pick",
    "        type: io.kestra.plugin.core.debug.Return",
    `        format: ${y("{{ {'i': json(taskrun.value)._i ?? -1, 'r': outputs.big[taskrun.value].value ?? outputs.small[taskrun.value].value ?? 'FAILED', 'c': outputs.city[taskrun.value].value} | toJson }}")}`,
    "  - id: tail",
    "    type: io.kestra.plugin.core.debug.Return",
    `    format: ${y("{{ outputs.pick | jq('[.[] | .value | fromjson] | sort_by(.i)') | first | toJson }}")}`,
  ].join("\n");
}

type Exec = { state: { current: string }; taskRunList?: Array<{ taskId: string; value?: string; state: { current: string }; outputs?: { value?: string } }> };
async function run(v: Variant, t: number): Promise<Exec> {
  const id = `foreach-proof-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const dep = await fetch(`${base}/api/v1/main/flows`, { method: "POST", headers: { ...auth, "content-type": "application/x-yaml" }, body: flowYaml(id, v) });
  if (!dep.ok) throw new Error(`deploy ${dep.status}: ${(await dep.text()).slice(0, 400)}`);
  try {
    const form = new FormData();
    form.append("rows", JSON.stringify(ROWS));
    form.append("t", String(t));
    const ex = (await (await fetch(`${base}/api/v1/main/executions/foundry.system/${id}`, { method: "POST", headers: auth, body: form })).json()) as { id: string };
    let e: Exec | undefined;
    for (let s = 0; s < 120; s++) {
      e = (await (await fetch(`${base}/api/v1/main/executions/${ex.id}`, { headers: auth })).json()) as Exec;
      if (["SUCCESS", "FAILED", "WARNING", "KILLED"].includes(e.state.current)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return e!;
  } finally {
    await fetch(`${base}/api/v1/main/flows/foundry.system/${id}`, { method: "DELETE", headers: auth });
  }
}

let failures = 0;
const check = (ok: boolean, what: string, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `\n         ${detail}`}`); if (!ok) failures++; };
const iterations = (e: Exec) => (e.taskRunList ?? []).filter((r) => r.taskId === "city").length;

for (const t of [10, 100]) {
  console.log(`\nthreshold ${t}`);
  const e = await run(GOOD, t);
  check(e.state.current === "WARNING", "one failing item ends the run WARNING, not FAILED", e.state.current);
  check(iterations(e) === ROWS.length, `every row runs once, identical rows included (${ROWS.length})`, `ran ${iterations(e)}`);
  const tail = e.taskRunList?.find((r) => r.taskId === "tail")?.outputs?.value;
  const got = tail ? (JSON.parse(tail) as Array<{ i: number; r: string; c: string }>) : [];
  const want = ROWS.map((row, i) => ({ i, r: row.n > t && row.fail ? "FAILED" : `${row.n > t ? "big" : "small"}:${row.name}`, c: row.address.city }));
  check(JSON.stringify(got) === JSON.stringify(want), "the tail is one line per row, in input order, each on its own arm, the failure FAILED, the nested field read", `got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);
}

console.log("\ncontrols (each must fire)");
{
  const e = await run({ ...GOOD, numbered: false }, 10);
  check(iterations(e) < ROWS.length, "CONTROL: raw rows (no _i) collapse identical items", `ran ${iterations(e)} of ${ROWS.length}`);
}
{
  const e = await run({ ...GOOD, keepGoing: false }, 10);
  check(e.state.current === "FAILED", "CONTROL: without allowFailure one item fails the run", e.state.current);
}
{
  const e = await run({ ...GOOD, armReads: "self" }, 10);
  const tail = e.taskRunList?.find((r) => r.taskId === "tail")?.outputs?.value;
  const rs = tail ? (JSON.parse(tail) as Array<{ r: string }>).map((x) => x.r) : [];
  check(rs.length === ROWS.length && rs.every((r) => r === "FAILED"), "CONTROL: an arm reading taskrun.value (not parent.) gets nothing — every item FAILED", JSON.stringify(rs));
}

// ── Batches (phase F, F4b / D-370, I-346): the numbered rows cut into chunks by jq, a ForEach over the CHUNKS, each chunk's rows
// intact inside — the shape a one-call loop compiles to. Chunks of 2 over the 5 rows ⇒ 3 chunks; every row's `_i` exactly once.
function chunkYaml(id: string, size: number): string {
  return [
    `id: ${id}`,
    "namespace: foundry.system",
    "inputs:",
    "  - id: rows\n    type: JSON",
    "tasks:",
    "  - id: number",
    "    type: io.kestra.plugin.core.debug.Return",
    `    format: ${y("{{ inputs.rows | jq('[to_entries[] | .value + {_i: .key}]') | first | toJson }}")}`,
    "  - id: chunks",
    "    type: io.kestra.plugin.core.debug.Return",
    `    format: ${y(`{{ json(outputs.number.value) | jq('[range(0; length; ${size}) as $k | .[$k:$k + ${size}]]') | first | toJson }}`)}`,
    "  - id: batch",
    "    type: io.kestra.plugin.core.flow.ForEach",
    `    values: ${y("{{ outputs.chunks.value }}")}`,
    "    concurrencyLimit: 2",
    "    tasks:",
    "      - id: call",
    "        type: io.kestra.plugin.core.debug.Return",
    // What a batch body builds: one object per row of THIS chunk, from the row's own fields (the fan-out's jq shape).
    `        format: ${y("{{ json(taskrun.value) | jq('[.[] | {i: ._i, who: .name, city: .address.city}]') | first | toJson }}")}`,
    "  - id: tail",
    "    type: io.kestra.plugin.core.debug.Return",
    `    format: ${y("{{ outputs.call | jq('[.[] | .value | fromjson] | add | sort_by(.i)') | first | toJson }}")}`,
  ].join("\n");
}
async function runChunks(size: number): Promise<Exec> {
  const id = `foreach-chunks-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const dep = await fetch(`${base}/api/v1/main/flows`, { method: "POST", headers: { ...auth, "content-type": "application/x-yaml" }, body: chunkYaml(id, size) });
  if (!dep.ok) throw new Error(`deploy ${dep.status}: ${(await dep.text()).slice(0, 400)}`);
  try {
    const form = new FormData();
    form.append("rows", JSON.stringify(ROWS));
    const ex = (await (await fetch(`${base}/api/v1/main/executions/foundry.system/${id}`, { method: "POST", headers: auth, body: form })).json()) as { id: string };
    let e: Exec | undefined;
    for (let s = 0; s < 120; s++) {
      e = (await (await fetch(`${base}/api/v1/main/executions/${ex.id}`, { headers: auth })).json()) as Exec;
      if (["SUCCESS", "FAILED", "WARNING", "KILLED"].includes(e.state.current)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return e!;
  } finally {
    await fetch(`${base}/api/v1/main/flows/foundry.system/${id}`, { method: "DELETE", headers: auth });
  }
}
console.log("\nbatches (chunks of 2)");
{
  const e = await runChunks(2);
  const calls = (e.taskRunList ?? []).filter((r) => r.taskId === "call");
  check(e.state.current === "SUCCESS", "the chunked run settles SUCCESS", e.state.current);
  check(calls.length === 3, "5 rows in chunks of 2 ⇒ 3 batch calls", `ran ${calls.length}`);
  check(calls.every((c) => { try { const v = JSON.parse(c.value ?? ""); return Array.isArray(v) && v.length >= 1 && v.length <= 2; } catch { return false; } }), "each batch receives its chunk as an array of at most 2 rows", JSON.stringify(calls.map((c) => c.value)).slice(0, 300));
  const tail = e.taskRunList?.find((r) => r.taskId === "tail")?.outputs?.value;
  const got = tail ? (JSON.parse(tail) as Array<{ i: number; who: string; city: string }>) : [];
  const want = ROWS.map((r, i) => ({ i, who: r.name, city: r.address.city }));
  check(JSON.stringify(got) === JSON.stringify(want), "every row's object exactly once, identical rows included, rejoined in input order by _i", `got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);
}
{
  const e = await runChunks(5);
  check((e.taskRunList ?? []).filter((r) => r.taskId === "call").length === 1, "CONTROL: chunks of 5 over 5 rows ⇒ ONE batch call (the chunk size is what cuts)");
}

// The COMPILER's own batched output (D-370, `collectBatchExpr`) run on the engine across several chunks: each chunk's pick carries
// its item numbers and a batch envelope (one item failing, as the step API reports a per-item failure); the output must be one
// row per item, in input order, ff_ok / ff_error / ff_result from that item's results[k].
function joinYaml(id: string): string {
  const envelope = "{{ json(taskrun.value) | jq('{results: [.[] | if (.fail // false) then {ok: false, error: \"HTTP 400\"} else {ok: true, data: {who: .name}} end]} | tojson') | first }}";
  return [
    `id: ${id}`,
    "namespace: foundry.system",
    "inputs:",
    "  - id: rows\n    type: JSON",
    "tasks:",
    "  - id: each-rows",
    "    type: io.kestra.plugin.core.debug.Return",
    `    format: ${y("{{ inputs.rows | jq('[to_entries[] | .value + {_i: .key}]') | first | toJson }}")}`,
    "  - id: each-chunks",
    "    type: io.kestra.plugin.core.debug.Return",
    `    format: ${y("{{ json(outputs['each-rows'].value) | jq('[range(0; length; 2) as $k | .[$k:$k + 2]]') | first | toJson }}")}`,
    "  - id: each",
    "    type: io.kestra.plugin.core.flow.ForEach",
    `    values: ${y("{{ outputs['each-chunks'].value }}")}`,
    "    concurrencyLimit: 2",
    "    tasks:",
    "      - id: post",
    "        type: io.kestra.plugin.core.debug.Return",
    `        format: ${y(envelope)}`,
    "      - id: each-pick",
    "        type: io.kestra.plugin.core.debug.Return",
    `        format: ${y("{{ {'is': json(taskrun.value) | jq('[.[] | ._i]') | first, 'r': outputs.post[taskrun.value].value ?? '__no_result__'} | toJson }}")}`,
    "  - id: results",
    "    type: io.kestra.plugin.core.debug.Return",
    `    format: |\n${collectBatchExpr("each").split("\n").map((l) => `      ${l}`).join("\n")}`,
  ].join("\n");
}
console.log("\nthe compiler's batched output, joined on the engine (3 chunks)");
{
  const id = `foreach-join-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const dep = await fetch(`${base}/api/v1/main/flows`, { method: "POST", headers: { ...auth, "content-type": "application/x-yaml" }, body: joinYaml(id) });
  if (!dep.ok) { check(false, "the join flow deploys", `${dep.status}: ${(await dep.text()).slice(0, 400)}`); }
  else {
    try {
      const form = new FormData();
      form.append("rows", JSON.stringify(ROWS));
      const ex = (await (await fetch(`${base}/api/v1/main/executions/foundry.system/${id}`, { method: "POST", headers: auth, body: form })).json()) as { id: string };
      let e: Exec | undefined;
      for (let s2 = 0; s2 < 120; s2++) {
        e = (await (await fetch(`${base}/api/v1/main/executions/${ex.id}`, { headers: auth })).json()) as Exec;
        if (["SUCCESS", "FAILED", "WARNING", "KILLED"].includes(e.state.current)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      check(e!.state.current === "SUCCESS", "the join run settles SUCCESS", e!.state.current);
      const raw = e!.taskRunList?.find((r) => r.taskId === "results")?.outputs?.value;
      const got = raw ? (JSON.parse(raw) as Array<Record<string, unknown>>).map((r) => [r.ff_i, r.name, r.ff_ok, r.ff_error ?? null, (r.ff_result as { who?: string } | null)?.who ?? null]) : [];
      const want = ROWS.map((r, i) => [i, r.name, !r.fail, r.fail ? "HTTP 400" : null, r.fail ? null : r.name]);
      check(JSON.stringify(got) === JSON.stringify(want), "one row per item in input order, identical rows included; the failing item not ok with its own error, the rest carrying their result", `got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);
    } finally { await fetch(`${base}/api/v1/main/flows/foundry.system/${id}`, { method: "DELETE", headers: auth }); }
  }
}

console.log(`\n${failures ? `PROOF FAILED (${failures})` : "PROOF HOLDS"}`);
process.exit(failures ? 1 : 0);
