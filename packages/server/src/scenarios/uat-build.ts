/** UAT lifecycle · STAGE 1 — build an automation by conversing. */
import { http, load, save, log, head, AUTHOR } from "./uat-lifecycle.js";

const WS_NAME = "UAT lifecycle";

/**
 * A conversation a support lead would plausibly have. Deliberately underspecified
 * at the start: naming the query, the recipient and the date up front would test
 * a form, not a builder.
 */
const SCRIPT = [
  "every morning i want to know which support tickets have blown past their resolve target",
  "email that list to the support lead",
  "send it to support-lead@acme-support.example, from foundry@acme-support.example",
];

async function main() {
  const st = load();
  head("STAGE 1 · BUILD BY CONVERSING");

  const ws = await http("GET", "/workspaces");
  const found = (ws.body?.workspaces ?? []).find((w: any) => w.name === WS_NAME);
  if (!found) throw new Error(`workspace "${WS_NAME}" not found — run uat-lifecycle-setup first`);
  st.workspaceId = found.id;
  log(`workspace ${found.id}`);

  const thread = await http("POST", `/workspaces/${found.id}/flow-chat/threads`, {
    name: "Chase tickets past their resolve target",
  });
  if (thread.status !== 201) throw new Error(`thread: ${thread.status} ${thread.text}`);
  st.threadId = thread.body.thread.id;
  log(`thread ${st.threadId}\n`);

  for (const [i, message] of SCRIPT.entries()) {
    const t0 = Date.now();
    const r = await http("POST",
      `/workspaces/${found.id}/flow-chat/threads/${st.threadId}/turns`, { message });
    const ms = Date.now() - t0;
    const o = r.body ?? {};
    const t = o.turn ?? {};
    log(`── turn ${i + 1} (${ms} ms, HTTP ${r.status}) ────────────────────────────`);
    log(`   said:   ${message}`);
    log(`   status: ${t.status}`);
    if (t.changeText) log(`   change: ${t.changeText}`);
    if (t.findingsJson?.length) log(`   said back: ${JSON.stringify(t.findingsJson)}`);
    for (const k of Object.keys(t)) {
      if (!["id","threadId","workspaceId","status","changeText","findingsJson","createdAt","seq","opJson","createdBy","createdByKind"].includes(k))
        log(`   ${k}: ${JSON.stringify(t[k])?.slice(0, 200)}`);
    }
    if (t.opJson) log(`   op: ${JSON.stringify(t.opJson).slice(0, 300)}`);
    if (o.flowId) st.flowId = o.flowId;
    log("");
  }

  if (!st.flowId) {
    log("!! NO FLOW WAS CREATED — the conversation produced no automation.");
    save(st);
    process.exit(1);
  }

  const flow = await http("GET", `/workspaces/${found.id}/flows/${st.flowId}`);
  const model = flow.body?.flow?.draftRevision?.model ?? flow.body?.draftRevision?.model ?? flow.body?.model;
  log(`flow ${st.flowId}`);
  log(`raw flow keys: ${Object.keys(flow.body ?? {}).join(", ")}`);
  if (model) {
    log(`inputs: ${JSON.stringify(model.inputs ?? [])}`);
    log(`schedule: ${JSON.stringify(model.schedule ?? null)}`);
    log(`steps (${model.steps?.length ?? 0}):`);
    for (const s of model.steps ?? []) {
      log(`   ${s.id}  kind=${s.kind}  ref=${s.ref ?? "-"}  dependsOn=${JSON.stringify(s.dependsOn ?? [])}`);
      if (s.paramsExpr) log(`        paramsExpr: ${String(s.paramsExpr).slice(0, 160)}`);
      if (s.expr) log(`        expr: ${String(s.expr).slice(0, 160)}`);
    }
  } else {
    log(JSON.stringify(flow.body, null, 2).slice(0, 3000));
  }
  save(st);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
