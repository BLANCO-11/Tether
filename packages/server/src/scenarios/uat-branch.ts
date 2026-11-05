/**
 * UAT lifecycle · COVERAGE — a BRANCHING flow, built by conversing.
 *
 * ⚠ The reason this is its own probe: **a branching flow that picks the wrong
 * arm is GREEN.** Every expression renders, every task that ran succeeded, and
 * the execution settles SUCCESS — because the tasks in the arm that should have
 * fired were never scheduled. So this reports WHICH task ids ran, not whether
 * the run went green.
 */
import { http, load, save, log, head, sleep } from "./uat-lifecycle.js";

const SCRIPT = [
  "show me support tickets that have gone past their resolve target",
  "if any of them are on the enterprise plan, post a message to the #escalations chat channel",
  "otherwise just email a summary to support-lead@acme-support.example from foundry@acme-support.example",
];

async function main() {
  const st = load();
  head("COVERAGE · A BRANCHING FLOW");

  const th = await http("POST", `/workspaces/${st.workspaceId}/flow-chat/threads`,
    { name: "Escalate enterprise breaches" });
  const threadId = th.body?.thread?.id;
  log(`thread ${threadId}\n`);
  let flowId: string | null = null;

  for (const [i, message] of SCRIPT.entries()) {
    const r = await http("POST",
      `/workspaces/${st.workspaceId}/flow-chat/threads/${threadId}/turns`, { message });
    const t = r.body?.turn ?? {};
    log(`── turn ${i + 1}  status=${t.status}`);
    log(`   said: ${message}`);
    if (t.findingsJson?.length) log(`   back: ${JSON.stringify(t.findingsJson).slice(0, 400)}`);
    if (t.opJson) log(`   op:   ${JSON.stringify(t.opJson).slice(0, 400)}`);
    if (r.body?.flowId) flowId = r.body.flowId;
    log("");
  }
  if (!flowId) { log("!! no flow"); process.exit(1); }
  (st as any).branchFlowId = flowId; save(st);

  const flow = await http("GET", `/workspaces/${st.workspaceId}/flows/${flowId}`);
  log(`flow ${flowId}  draft rev ${flow.body?.flow?.draftRevision}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
