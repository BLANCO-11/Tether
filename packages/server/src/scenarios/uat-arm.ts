/** UAT lifecycle · STAGE 3 — assign an approver, approve, confirm the live namespace. */
import { http, load, save, log, head, AUTHOR, APPROVER, SUPER } from "./uat-lifecycle.js";

async function main() {
  const st = load();
  head("STAGE 3 · ARM");

  log(`-- membership (as super admin "${SUPER}")`);
  const g = await http("POST", `/workspaces/${st.workspaceId}/members`,
    { subject: APPROVER, email: APPROVER, role: "approver" }, SUPER);
  log(`   grant approver → HTTP ${g.status} ${JSON.stringify(g.body).slice(0, 200)}`);

  const g2 = await http("POST", `/workspaces/${st.workspaceId}/members`,
    { subject: AUTHOR, email: AUTHOR, role: "author" }, SUPER);
  log(`   grant author   → HTTP ${g2.status} ${JSON.stringify(g2.body).slice(0, 200)}`);

  log(`\n-- the control: can a NON-member approve?`);
  const nope = await http("POST", `/workspaces/${st.workspaceId}/flows/${st.flowId}/approvals`,
    { revision: st.revision, note: "should be refused" }, "nobody@acme-support.example");
  log(`   stranger approves → HTTP ${nope.status} ${JSON.stringify(nope.body).slice(0, 220)}`);

  log(`\n-- the control: can the AUTHOR approve their own revision?`);
  const selfa = await http("POST", `/workspaces/${st.workspaceId}/flows/${st.flowId}/approvals`,
    { revision: st.revision, note: "self" }, AUTHOR);
  log(`   author approves  → HTTP ${selfa.status} ${JSON.stringify(selfa.body).slice(0, 220)}`);

  log(`\n-- the real approval, as the approver`);
  const flow = await http("GET", `/workspaces/${st.workspaceId}/flows/${st.flowId}`);
  const rev = flow.body?.flow?.draftRevision;
  st.revision = rev; save(st);
  const a = await http("POST", `/workspaces/${st.workspaceId}/flows/${st.flowId}/approvals`,
    { revision: rev, note: "UAT lifecycle probe — reviewed the draft run output." }, APPROVER);
  log(`   approve rev ${rev} → HTTP ${a.status}`);
  log(`   ${JSON.stringify(a.body).slice(0, 500)}`);

  const after = await http("GET", `/workspaces/${st.workspaceId}/flows/${st.flowId}`);
  log(`\n   flow.status=${after.body?.flow?.status}  armedRevision=${after.body?.flow?.armedRevision}`);
  log(`   approvalState: ${JSON.stringify(after.body?.approvalState)}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
