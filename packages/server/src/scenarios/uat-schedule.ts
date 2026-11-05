/** UAT lifecycle · STAGE 5 — a cron on the MODEL (D-18), then re-approve. */
import { http, load, save, log, head, APPROVER } from "./uat-lifecycle.js";

async function main() {
  const st = load();
  head("STAGE 5 · SCHEDULE");

  log("-- ask chat for a schedule");
  const r = await http("POST",
    `/workspaces/${st.workspaceId}/flow-chat/threads/${st.threadId}/turns`,
    { message: "run this automatically every weekday at 9am" });
  const t = r.body?.turn ?? {};
  log(`   status: ${t.status}`);
  if (t.findingsJson?.length) log(`   said back: ${JSON.stringify(t.findingsJson).slice(0, 500)}`);
  if (t.opJson) log(`   op: ${JSON.stringify(t.opJson).slice(0, 300)}`);

  const flow = await http("GET", `/workspaces/${st.workspaceId}/flows/${st.flowId}`);
  const rev = flow.body?.flow?.draftRevision;
  log(`\n   draftRevision now ${rev} (armed ${flow.body?.flow?.armedRevision})`);

  log("\n-- approve the scheduled revision (this DEPLOYS a live cron)");
  const a = await http("POST", `/workspaces/${st.workspaceId}/flows/${st.flowId}/approvals`,
    { revision: rev, note: "UAT probe — scheduled revision." }, APPROVER);
  log(`   approve rev ${rev} → HTTP ${a.status}`);
  log(`   ${JSON.stringify(a.body).slice(0, 600)}`);
  st.revision = rev; save(st);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
