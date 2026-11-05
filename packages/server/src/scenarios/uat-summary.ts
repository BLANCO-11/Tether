/** UAT lifecycle · summary + disarm. */
import { http, load, log, head, APPROVER } from "./uat-lifecycle.js";

async function main() {
  const st = load();
  head("EXECUTIONS");
  const l = await http("GET", `/workspaces/${st.workspaceId}/flow-executions?limit=30`);
  const mine = (l.body?.executions ?? []).filter((e: any) => e.flowId === st.flowId);
  for (const e of mine) {
    log(`${e.id}  ${String(e.engineStatus).padEnd(8)} status=${String(e.status).padEnd(10)} by=${e.requestedByKind ?? "-"}  ${e.startedAt}`);
  }
  log(`\n${mine.length} executions, ${mine.filter((e: any) => e.engineStatus === "success").length} success`);

  head("DISARM — this flow carries a live weekday cron");
  const r = await http("POST", `/workspaces/${st.workspaceId}/flows/${st.flowId}/approvals/revoke`,
    { reason: "UAT lifecycle probe finished — the cron must not fire unattended." }, APPROVER);
  log(`revoke → HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);

  for (const t of (await http("GET", `/workspaces/${st.workspaceId}/flows/${st.flowId}/triggers`, undefined, APPROVER)).body?.triggers ?? []) {
    const d = await http("PATCH", `/workspaces/${st.workspaceId}/flows/${st.flowId}/triggers/${t.id}`,
      { enabled: false }, APPROVER);
    log(`disable ${t.type} → HTTP ${d.status}`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
