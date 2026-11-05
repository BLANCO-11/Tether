/** UAT lifecycle · STAGE 5b — approve the scheduled revision, verify the LIVE cron. */
import { http, load, save, log, head, APPROVER } from "./uat-lifecycle.js";
import { kestra } from "../services/kestra-client.service.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";

async function main() {
  const st = load();
  head("STAGE 5b · APPROVE THE SCHEDULE, THEN LOOK AT KESTRA");
  const before = await http("GET", `/workspaces/${st.workspaceId}/flows/${st.flowId}`);
  const rev = before.body?.flow?.draftRevision;
  log(`draft ${rev}, armed ${before.body?.flow?.armedRevision}`);

  const a = await http("POST", `/workspaces/${st.workspaceId}/flows/${st.flowId}/approvals`,
    { revision: rev, note: "UAT probe — the scheduled revision." }, APPROVER);
  log(`approve rev ${rev} → HTTP ${a.status}`);
  if (a.status >= 400) log(`  ${JSON.stringify(a.body).slice(0, 600)}`);

  const after = await http("GET", `/workspaces/${st.workspaceId}/flows/${st.flowId}`);
  log(`status=${after.body?.flow?.status} armed=${after.body?.flow?.armedRevision}`);
  st.revision = rev; save(st);

  // ── The claim that matters: did a Schedule trigger reach the LIVE namespace?
  const ws = await workspaceRepo.get(st.workspaceId!);
  const flow = await flowRepo.get(st.workspaceId!, st.flowId!);
  const ns = `foundry.${ws!.tenantSlug}.${ws!.slug}`;
  head("LIVE NAMESPACE");
  log(`namespace: ${ns}`);
  try {
    const live = await kestra.getFlow({ value: ns } as never, flow!.kestraFlowId);
    log(`deployed:  ${live ? "yes" : "no"}`);
    log(`triggers:  ${JSON.stringify((live as any)?.triggers ?? [])}`);
  } catch (e) {
    log(`kestra: ${(e as Error).message}`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
