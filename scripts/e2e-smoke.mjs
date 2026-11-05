// End-to-end smoke test for the Foundry Parent App.
// Walks the full journey against the live stack (parent API + Docker):
//   workspace → dummy tool → datasource → introspect → manifest → generate
//   → poll to completion → execute in container → trigger → fire.
// Usage: node scripts/e2e-smoke.mjs
const B = process.env.PARENT_API_URL ?? "http://localhost:4000";
const K = process.env.PARENT_API_KEY ?? "dev-parent-key";

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
  return ok;
}
async function api(path, init = {}) {
  const res = await fetch(`${B}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-api-key": K, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 0. Can this deployment reach a model?
  //
  // ⚠ This used to be an agent-runtime health probe, asserting `reachable &&
  // llmConnected`, and it was a HARD failure of `pnpm e2e` — so the whole smoke
  // test went red whenever the agent runtime was down, including for the journey
  // below, which does not use it. Generation has gone through the gateway since
  // D-35, and that probe's `llmConnected` is this repo's canonical false green
  // (it "verifies" an LLM by listing models). So the probe asks the transport the
  // journey actually depends on. See task 1.8.
  //
  // That runtime is gone with the `agent` step kind. This journey had none, which is why
  // its absence is no longer allowed to fail the run.
  const h = await api("/api/generation/llm/models", { method: "POST", body: "{}" });
  check(
    "Generation gateway reachable",
    h.status === 200 && Array.isArray(h.body?.models),
    h.body?.message ?? `${(h.body?.models ?? []).length} model(s)`,
  );

  // 1. workspace
  const ws = await api("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: `e2e-${Date.now()}`, description: "e2e smoke" }),
  });
  const wsId = ws.body?.workspace?.id;
  check("Create workspace", ws.status === 201 && !!wsId, wsId);

  // 2. dummy tool
  const tool = await api(`/api/workspaces/${wsId}/tools/dummy/generate`, {
    method: "POST",
    body: JSON.stringify({ name: "echoTool", method: "POST", sample: { ok: true } }),
  });
  check("Generate dummy tool", tool.status === 201 && tool.body?.tool?.kind === "dummy");

  // 3. datasource → introspect (point at the parent's own Postgres)
  const ds = await api(`/api/workspaces/${wsId}/datasources`, {
    method: "POST",
    body: JSON.stringify({
      name: "selfpg",
      type: "postgres",
      connectionString: "postgres://foundry:foundry@localhost:5433/foundry_parent",
      secretEnvName: "SELF_DB_URL",
    }),
  });
  const dsId = ds.body?.datasource?.id;
  check("Create datasource", ds.status === 201 && !!dsId);
  const refresh = await api(`/api/workspaces/${wsId}/datasources/${dsId}/schema/refresh`, { method: "POST" });
  check("Introspect schema", refresh.body?.tables > 0, `${refresh.body?.tables} tables`);

  // 4. manifest
  const man = await api(`/api/workspaces/${wsId}/manifest`);
  check("Build manifest", man.body?.version >= 1 && man.body?.summaryXml?.includes("manifestSummary"));

  // 5. generate a script
  const gen = await api(`/api/workspaces/${wsId}/scripts`, {
    method: "POST",
    body: JSON.stringify({
      task: "Write a Python script that prints the JSON array [1,2,3]. Stdlib only, self-contained.",
      title: "e2e gen",
    }),
  });
  const scriptId = gen.body?.script?.id;
  check("Start generation", gen.status === 202 && !!scriptId, `full manifest: ${gen.body?.fullManifestDelivered}`);

  // 6. poll to completion
  let status = "generating";
  for (let i = 0; i < 80 && status === "generating"; i++) {
    await sleep(4000);
    const s = await api(`/api/workspaces/${wsId}/scripts/${scriptId}`);
    status = s.body?.script?.status;
  }
  check("Generation completed", status === "completed", `status=${status}`);

  // 7. execute in container
  let execOk = false;
  let execOut = "";
  if (status === "completed") {
    const ex = await api(`/api/workspaces/${wsId}/scripts/${scriptId}/execute`, {
      method: "POST",
      body: JSON.stringify({ network: false }),
    });
    execOk = ex.body?.execution?.status === "succeeded";
    execOut = (ex.body?.execution?.stdoutText ?? "").trim();
  }
  check("Execute in container", execOk, execOut);

  // 8. trigger + fire
  let fireOk = false;
  if (status === "completed") {
    const t = await api(`/api/workspaces/${wsId}/scripts/${scriptId}/triggers`, {
      method: "POST",
      body: JSON.stringify({ name: "e2e-manual", type: "manual" }),
    });
    const tid = t.body?.trigger?.id;
    const fire = await api(`/api/workspaces/${wsId}/scripts/${scriptId}/triggers/${tid}/fire`, { method: "POST" });
    fireOk = fire.status === 202 && !!fire.body?.executionId;
  }
  check("Create + fire trigger", fireOk);

  // cleanup
  await api(`/api/workspaces/${wsId}`, { method: "DELETE" });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("e2e crashed:", e);
  process.exit(1);
});
