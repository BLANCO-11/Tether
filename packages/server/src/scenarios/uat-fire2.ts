/** UAT lifecycle · STAGE 4b — the two token-bearing receivers, done properly. */
import { http, load, log, head, sleep, APPROVER, BASE } from "./uat-lifecycle.js";

async function seen(st: any) {
  const l = await http("GET", `/workspaces/${st.workspaceId}/flow-executions?limit=20`);
  return new Set<string>((l.body?.executions ?? []).map((e: any) => String(e.id)));
}
async function newRun(st: any, before: Set<string>, label: string) {
  for (let i = 0; i < 25; i++) {
    await sleep(2000);
    const l = await http("GET", `/workspaces/${st.workspaceId}/flow-executions?limit=20`);
    const fresh = (l.body?.executions ?? []).filter(
      (e: any) => e.flowId === st.flowId && !before.has(e.id));
    const done = fresh.find((e: any) =>
      ["success", "failed", "killed", "warning"].includes(String(e.engineStatus).toLowerCase()));
    if (done) { log(`   ${label}: NEW execution ${done.id} → ${done.engineStatus}`); return done; }
  }
  log(`   ${label}: no new execution settled in 50s`);
  return null;
}

async function main() {
  const st = load();
  head("STAGE 4b · API + WEBHOOK receivers");
  const list = await http("GET", `/workspaces/${st.workspaceId}/flows/${st.flowId}/triggers`, undefined, APPROVER);
  const trigs = list.body?.triggers ?? [];
  log(`triggers on this flow: ${trigs.map((t: any) => `${t.type}${t.enabled ? "(on)" : "(off)"}`).join(", ")}\n`);

  for (const type of ["api", "webhook"]) {
    const t = trigs.find((x: any) => x.type === type);
    if (!t) { log(`── ${type}: no trigger row`); continue; }
    const path = t.webhookPath as string | null;
    log(`── ${type.toUpperCase()} ──────────────────────────────────`);
    log(`   webhookPath: ${path ?? "NULL — the client cannot build the URL"}`);
    if (!path) continue;
    const before = await seen(st);
    const tok = path.split("/")[3]!;
    const url = `${BASE}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(type === "api" ? { authorization: `Bearer ${tok}` } : {}) },
      // ⚠ api takes inputs FROM THE BODY (`inputsOverride ?? config.inputs`);
      // webhook never reads its body and uses the stored config.inputs.
      body: JSON.stringify(
        type === "api" ? { inputs: { as_of: "2026-06-15T10:00:00Z" } } : { ignored: true },
      ),
    });
    log(`   POST → HTTP ${res.status} ${(await res.text()).slice(0, 220)}`);
    await newRun(st, before, type);
    log("");
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
