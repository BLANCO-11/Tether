/** UAT lifecycle · STAGE 4 — fire the armed flow four ways. */
import { http, load, save, log, head, sleep, APPROVER, BASE } from "./uat-lifecycle.js";

const INPUTS = { as_of: "2026-06-15T10:00:00Z" };

async function mk(st: any, type: string, name: string) {
  const r = await http("POST", `/workspaces/${st.workspaceId}/flows/${st.flowId}/triggers`,
    { name, type, config: { inputs: INPUTS }, enabled: false }, APPROVER);
  log(`   create ${type} → HTTP ${r.status} ${r.status >= 400 ? JSON.stringify(r.body).slice(0, 260) : ""}`);
  if (r.status >= 400) return null;
  const t = r.body?.trigger;
  const en = await http("PATCH", `/workspaces/${st.workspaceId}/flows/${st.flowId}/triggers/${t.id}`,
    { enabled: true }, APPROVER);
  log(`   enable        → HTTP ${en.status} ${en.status >= 400 ? JSON.stringify(en.body).slice(0, 260) : "enabled"}`);
  return { ...t, ...(en.body?.trigger ?? {}) };
}

async function settle(st: any, label: string) {
  for (let i = 0; i < 25; i++) {
    await sleep(2000);
    const l = await http("GET", `/workspaces/${st.workspaceId}/flow-executions?limit=5`);
    const e = (l.body?.executions ?? []).filter((x: any) => x.flowId === st.flowId)[0];
    const s = String(e?.engineStatus ?? "").toLowerCase();
    if (["success", "failed", "killed", "warning"].includes(s)) {
      log(`   ${label}: execution ${e.id} → ${e.engineStatus} (firedBy=${e.requestedByKind ?? "?"})`);
      return e;
    }
  }
  log(`   ${label}: never settled`);
  return null;
}

async function main() {
  const st = load();
  head("STAGE 4 · FIRE — manual, api, webhook, schedule");

  log("\n── 1. MANUAL / Fire now ────────────────────────────────");
  const man = await mk(st, "manual", "UAT manual");
  if (man) {
    const f = await http("POST",
      `/workspaces/${st.workspaceId}/flows/${st.flowId}/triggers/${man.id}/fire`, {}, APPROVER);
    log(`   fire          → HTTP ${f.status} ${JSON.stringify(f.body).slice(0, 200)}`);
    await settle(st, "manual");
  }

  log("\n── 2. API call ─────────────────────────────────────────");
  const api = await mk(st, "api", "UAT api");
  if (api) {
    log(`   token: ${api.token ? String(api.token).slice(0, 12) + "…" : "(none returned)"}`);
    const res = await fetch(`${BASE}/api/triggers/${api.token}/api`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${api.token}` },
      body: JSON.stringify({}),
    });
    log(`   POST /api/triggers/<token>/api → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    await settle(st, "api");
  }

  log("\n── 3. WEBHOOK ──────────────────────────────────────────");
  const wh = await mk(st, "webhook", "UAT webhook");
  if (wh) {
    const res = await fetch(`${BASE}/api/triggers/${wh.token}/webhook`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ignored: "the body is never read — inputs come from config" }),
    });
    log(`   POST /api/triggers/<token>/webhook → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    await settle(st, "webhook");
  }

  log("\n── 4. SCHEDULE ─────────────────────────────────────────");
  const sch = await http("POST", `/workspaces/${st.workspaceId}/flows/${st.flowId}/triggers`,
    { name: "UAT schedule", type: "schedule", config: { cron: "0 9 * * 1" } }, APPROVER);
  log(`   trigger-row route → HTTP ${sch.status} ${JSON.stringify(sch.body).slice(0, 300)}`);
  log(`   (D-18: a cron lives on the MODEL, so this refusal is correct.)`);
  save(st);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
