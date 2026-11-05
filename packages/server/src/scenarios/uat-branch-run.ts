/**
 * UAT lifecycle · run the branching flow and report WHICH TASKS RAN.
 *
 * ⚠ A branching flow that picks the wrong arm settles SUCCESS: the tasks in the
 * arm that should have fired were never scheduled, so nothing failed. The only
 * evidence is the task list, which is why this probe reports it instead of the
 * status.
 */
import { http, load, log, head, sleep } from "./uat-lifecycle.js";

async function main() {
  const st: any = load();
  const flowId = st.branchFlowId;
  head(`COVERAGE · DOES THE RIGHT ARM FIRE?  as_of=${process.argv[2] ?? "2026-06-15T10:00:00Z"}`);

  const before = new Set<string>(
    ((await http("GET", `/workspaces/${st.workspaceId}/flow-executions?limit=30`)).body?.executions ?? [])
      .map((e: any) => String(e.id)));

  const r = await http("POST", `/workspaces/${st.workspaceId}/flows/${flowId}/test-run`,
    { inputs: { as_of: process.argv[2] ?? "2026-06-15T10:00:00Z" } });
  log(`test-run → HTTP ${r.status} ${JSON.stringify(r.body)}`);
  if (r.status >= 400) { log(r.text.slice(0, 900)); return; }

  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const l = await http("GET", `/workspaces/${st.workspaceId}/flow-executions?limit=30`);
    const e = (l.body?.executions ?? []).find((x: any) => x.flowId === flowId && !before.has(String(x.id)));
    if (!e) continue;
    const s = String(e.engineStatus).toLowerCase();
    if (!["success", "failed", "killed", "warning"].includes(s)) continue;

    const d = await http("GET", `/workspaces/${st.workspaceId}/flow-executions/${e.id}`);
    const v = d.body ?? {};
    log(`\nexecution ${e.id} → ${v.engineStatus}`);
    log(`\nTASKS THAT ACTUALLY RAN:`);
    for (const s2 of v.steps ?? []) {
      log(`   ${String(s2.stepId ?? s2.id).padEnd(28)} ${s2.kind ?? "-"}  ${s2.status ?? s2.state ?? ""}`);
      if (s2.error) log(`      error: ${JSON.stringify(s2.error).slice(0, 300)}`);
    }
    log(`\nDECLARED IN THE MODEL:`);
    const rev = await http("GET", `/workspaces/${st.workspaceId}/flows/${flowId}`);
    log(`   draft revision ${rev.body?.flow?.draftRevision}`);
    return;
  }
  log("never settled");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
