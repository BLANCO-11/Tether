/** UAT lifecycle · STAGE 2 — a draft (test) run, and its outputs. */
import { http, load, save, log, head, sleep } from "./uat-lifecycle.js";

async function main() {
  const st = load();
  head("STAGE 2 · TEST RUN");
  const r = await http("POST", `/workspaces/${st.workspaceId}/flows/${st.flowId}/test-run`, { inputs: { as_of: "2026-06-15T10:00:00Z" } });
  log(`POST test-run → HTTP ${r.status}`);
  if (r.status >= 400) { log(r.text.slice(0, 1200)); process.exit(1); }
  log(`body: ${JSON.stringify(r.body)}`);
  // ⚠ test-run returns {revision} and NO execution id — the id is stripped at
  // the route (I-22). So find the run the way a client must: list and take the
  // newest for this flow.
  await sleep(2500);
  const list = await http("GET", `/workspaces/${st.workspaceId}/flow-executions?limit=10`);
  const mine = (list.body?.executions ?? []).filter((e: any) => e.flowId === st.flowId);
  const execId = mine[0]?.id;
  log(`execution ${execId}  (found by listing; ${mine.length} for this flow)`);
  if (!execId) { log(JSON.stringify(list.body).slice(0, 1500)); process.exit(1); }
  st.executions = [...(st.executions ?? []), execId];
  save(st);

  let last = "";
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const d = await http("GET", `/workspaces/${st.workspaceId}/flow-executions/${execId}`);
    const e = d.body?.execution ?? d.body;
    const status = e?.engineStatus ?? e?.status;
    if (status !== last) { log(`  [${i * 2}s] engineStatus=${status}  status=${e?.status}`); last = status; }
    if (["success", "failed", "killed", "warning", "succeeded"].includes(String(status).toLowerCase())) {
      head("OUTPUTS");
      log(`engineStatus: ${status}`);
      for (const s of e?.steps ?? []) {
        log(`\n── ${s.stepId ?? s.id}  (${s.kind ?? "?"})  ${s.status ?? s.state ?? ""}`);
        if (s.readFrom) log(`   readFrom: ${s.readFrom}`);
        const out = s.output ?? s.result ?? s.outputs;
        if (out !== undefined) log(`   output: ${JSON.stringify(out).slice(0, 700)}`);
        if (s.error) log(`   error: ${JSON.stringify(s.error).slice(0, 500)}`);
      }
      if (!e?.steps?.length) log(`(no steps in the view)\n${JSON.stringify(e, null, 2).slice(0, 2500)}`);
      const mail = await http("GET", `/workspaces/${st.workspaceId}/flow-executions/${execId}/emails`);
      log(`\nemails endpoint → HTTP ${mail.status}: ${JSON.stringify(mail.body).slice(0, 600)}`);
      process.exit(0);
    }
  }
  log("!! never settled in 120s");
}
main().catch((e) => { console.error(e); process.exit(1); });
