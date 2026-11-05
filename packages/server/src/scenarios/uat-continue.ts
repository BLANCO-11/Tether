/** UAT lifecycle · continue an existing conversation with more turns. */
import { http, load, save, log, head } from "./uat-lifecycle.js";

async function main() {
  const st = load();
  const msgs = process.argv.slice(2);
  if (!st.workspaceId || !st.threadId) throw new Error("no thread in state — run uat-build first");
  head(`CONTINUE · ${msgs.length} turn(s)`);

  for (const message of msgs) {
    const t0 = Date.now();
    const r = await http("POST",
      `/workspaces/${st.workspaceId}/flow-chat/threads/${st.threadId}/turns`, { message });
    const t = r.body?.turn ?? {};
    log(`── (${Date.now() - t0} ms, HTTP ${r.status}) ──────────────────────────`);
    log(`   said:   ${message}`);
    log(`   status: ${t.status}`);
    if (t.findingsJson?.length) log(`   said back: ${JSON.stringify(t.findingsJson)}`);
    if (t.opJson) log(`   op: ${JSON.stringify(t.opJson).slice(0, 400)}`);
    if (r.body?.flowId) st.flowId = r.body.flowId;
    log("");
  }
  save(st);

  const flow = await http("GET", `/workspaces/${st.workspaceId}/flows/${st.flowId}`);
  const rev = flow.body?.flow?.draftRevision;
  st.revision = rev;
  save(st);
  const steps = await http("GET",
    `/workspaces/${st.workspaceId}/flows/${st.flowId}/revisions/${rev}/steps`);
  head(`MODEL · revision ${rev}`);
  for (const s of steps.body?.steps ?? []) {
    log(`${s.stepId ?? s.id}  kind=${s.kind}  ref=${s.ref ?? "-"}  dependsOn=${JSON.stringify(s.dependsOn ?? [])}`);
    for (const k of ["paramsExpr", "expr", "conditionExpr"]) {
      if (s[k]) log(`     ${k}: ${String(s[k]).slice(0, 220)}`);
    }
  }
  log(`\napprovalState: ${JSON.stringify(flow.body?.approvalState)}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
