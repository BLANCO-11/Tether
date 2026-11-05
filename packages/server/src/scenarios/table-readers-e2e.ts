/**
 * Slice 5d end-to-end probe (D-311), ZERO model calls: on a schema-only workspace, a HAND-WRITTEN spec whose source is a table
 * reader is built by the solver, saved through the one funnel, typechecked there, and draft-run on Kestra. Proves the step-local
 * statement path (spec → compileOperation SQL → executor) before any measurement spends a model call. The goal is not one of the
 * labelled goals; the flow is removed afterwards. `harness-in-net.sh` it.
 */
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowService } from "../services/flow.service.js";
import * as builder from "../services/builder/builder.service.js";
import { systemAuthor } from "../services/revision-author.js";
import { typecheckFlow } from "../services/flow-typecheck.js";
import { runDraft } from "./kestra-draft-run.js";
import { kestra } from "../services/kestra-client.service.js";

const WS = process.argv.find((a) => a.startsWith("--workspace="))?.slice(12) ?? "Orders & Fulfilment (schema-only)";
const TABLE = process.argv.find((a) => a.startsWith("--table="))?.slice(8) ?? "warehouses";
/** `--passed=<field>`: add a run-day condition (the field's date is before the day it runs). */
const PASSED = process.argv.find((a) => a.startsWith("--passed="))?.slice(9);
/** `--older=<field>:<days>`: the field's date is more than N days before the day it runs. */
const OLDER = process.argv.find((a) => a.startsWith("--older="))?.slice(8)?.split(":");
/** `--group=<field>:<sumfield>`: one row per <field>, with the count and the total of <sumfield>, largest total first (a shape). */
const GROUP = process.argv.find((a) => a.startsWith("--group="))?.slice(8)?.split(":");

async function main() {
  const ws = (await workspaceRepo.list()).find((w) => w.name === WS);
  if (!ws) throw new Error(`no workspace ${WS}`);
  const { items, cat } = await builder.builderCatalogue(ws.id);
  const ref = items.items.find((i) => i.ref.endsWith(`.table.${TABLE}`))?.ref;
  if (!ref) throw new Error(`no table reader for ${TABLE}`);
  const goal = `post the ${TABLE} list in #fulfilment${OLDER ? ` older than ${OLDER[1]} days` : ""}${GROUP ? ` per ${GROUP[0]} with the total ${GROUP[1]}, largest first` : ""}`;
  const u = builder.withDrafts(builder.recheck({ goal, texts: [goal], spec: {
    sources: [{ ref, quote: `the ${TABLE} list` }], sinks: [{ ref: "chat_post_message", quote: "post" }],
    values: [{ role: "channel", from: "goal", quote: "#fulfilment", fills: "chat_post_message.channel" }],
    conditions: PASSED ? [{ quote: "#fulfilment", by: "the_flow", field: `${ref}.${PASSED}`, test: "date_passed", value: "" }]
      : OLDER ? [{ quote: `older than ${OLDER[1]} days`, by: "the_flow", field: `${ref}.${OLDER[0]}`, test: "older_than_days", value: OLDER[1]! }] : [], schedule: null,
    ...(GROUP ? { shapes: [{ over: ref, stages: [
      { op: "group", quote: `per ${GROUP[0]}`, by: [`${ref}.${GROUP[0]}`], measures: [{ fn: "count", field: null }, { fn: "sum", field: `${ref}.${GROUP[1]}` }] },
      { op: "sort", quote: "largest first", field: "stage:0:1", dir: "desc" },
    ] }] } : {}), missing: null, unclear: [],
  } as never }, items), cat);
  console.log("readback:\n  " + u.readback.join("\n  "));
  const r = await builder.run(u, items, cat, builder.modelChooser, async (qs) => { console.log("asked:", qs.map((q) => q.ask)); return qs.map(() => null); });
  console.log(`status ${r.status} · holes ${r.flow.holes.length} · unmet ${r.trace.unmet?.join(" | ") ?? "-"}`);
  const reader = r.flow.steps.find((s) => (s as { ref?: string }).ref === ref) as { sql?: string; datasourceRef?: string } | undefined;
  console.log(`reader lowered: sql ${reader?.sql ? "yes" : "NO"} · datasource ${reader?.datasourceRef ?? "-"}`);
  console.log(`inputs: ${JSON.stringify(r.flow.inputs)}`);
  if (r.status !== "complete") { process.exit(2); }
  const saved = await builder.save(ws.id, u, r, systemAuthor(), `table-readers-e2e ${Date.now().toString(36)}`);
  try {
    const rev = await flowRepo.getRevision(saved.flowId, saved.revision!);
    const ds = await typecheckFlow(ws.id, rev!.modelJson as never);
    console.log(`funnel: saved revision ${saved.revision} · typecheck errors ${ds.filter((d) => d.severity === "error").map((d) => d.code).join(",") || "none"}`);
    const ex = await runDraft(ws.id, saved.flowId, {}, 180_000);
    console.log(`draft run: ${ex.state.current}`);
    const where = ex.taskRunList?.find((t: { taskId: string }) => t.taskId.startsWith("where"));
    if (where) {
      const full = await kestra.getExecution(ex.id).catch(() => null) as { taskRunList?: Array<{ taskId: string; outputs?: { value?: string } }> } | null;
      const out = full?.taskRunList?.find((t) => t.taskId === where.taskId)?.outputs?.value;
      let n: number | string = "?";
      try { const v = JSON.parse(String(out)); n = Array.isArray(v) ? v.length : "not a list"; } catch { n = "unreadable"; }
      console.log(`where step ran: ${where.state?.current} · rows kept ${n}`);
      if (GROUP) console.log(`grouped output: ${String(out).slice(0, 400)}`);
      const rd = full?.taskRunList?.find((t) => t.taskId.startsWith("read"))?.outputs?.value;
      const rt = full?.taskRunList?.find((t) => t.taskId.startsWith("read")) as { outputs?: Record<string, unknown> } | undefined;
      console.log(`read outputs keys ${Object.keys(rt?.outputs ?? {}).join(",")} · body head ${JSON.stringify(rt?.outputs).slice(0, 300)}`);
      try { const v = JSON.parse(String((rt?.outputs as { body?: string } | undefined)?.body)) as { results?: Array<{ data?: unknown[] }> };
        const cut = new Date(Date.now() - Number(OLDER?.[1] ?? 0) * 86_400_000).toISOString().slice(0, 10);
        const fld = OLDER?.[0] ?? PASSED ?? "promised_at";
        const data = (v.results?.[0]?.data ?? []) as Array<Record<string, string | null>>;
        if (GROUP) {
          const tot = new Map<string, { n: number; s: number }>();
          for (const x of data) { const k = x[GROUP[0]!]; if (k == null) continue; const t = tot.get(String(k)) ?? { n: 0, s: 0 }; t.n++; t.s += Number(x[GROUP[1]!] ?? 0); tot.set(String(k), t); }
          console.log(`oracle groups (largest total first): ${JSON.stringify([...tot].sort((a, b) => b[1].s - a[1].s))}`);
        }
        console.log(`oracle over the rows the reader returned: ${data.filter((x) => x[fld] && x[fld]!.slice(0, 10) < cut).length} of ${data.length} have a ${fld} day before ${cut}`); console.log(`read step rows ${v.results?.[0]?.data?.length ?? "?"} · sample promised_at ${JSON.stringify((v.results?.[0]?.data as Array<{ promised_at?: unknown }> | undefined)?.slice(0, 3).map((x) => x.promised_at))}`); } catch { console.log("read output unreadable"); }
    }
    if (ex.state.current !== "SUCCESS") {
      const logs: Array<{ taskId?: string; message?: string }> = await kestra.getExecutionLogs(ex.id, "ERROR").catch(() => []);
      console.log(`error: ${(logs[0] ? `${logs[0].taskId}: ${logs[0].message}` : "(none)").replace(/\s+/g, " ").slice(0, 600)}`);
    }
  } finally {
    await flowService.remove(ws.id, saved.flowId).catch(() => {});
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
