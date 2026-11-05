/**
 * Phase 1 — the security and engine assertions that `kestra:prove` does not cover.
 * archive/kestra-migration/09-risks-and-verification.md §13
 *
 *   pnpm kestra:verify
 *
 * `kestra:prove` answers "does a flow of declared steps produce the oracle's
 * answer". It says nothing about whether the boundaries hold when something
 * lies. This script attacks them:
 *
 *   assertion 6   a forged namespace → 403, never another workspace's token (R4)
 *   assertion 7   tokens are single-use per EXECUTION and they expire (R3, D-06)
 *   assertion 28  a refused `begin` halts the execution at step 1
 *   V2            does v1.3.29 honour flow-level `concurrency`?
 *
 * Every check states what it EXPECTS before it runs, so a failure names the
 * boundary that moved rather than just a status code.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { config } from "../config/index.js";
import { db } from "../db/index.js";
import { executionTokens } from "../db/schema.js";
import { kestra, namespaceFor, systemNamespace, KestraError } from "../services/kestra-client.service.js";
import { executionTokenService } from "../services/execution-token.service.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";

const FOUNDRY = (process.env.FOUNDRY_BASE_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
const HALT_FLOW_ID = "phase1-verify-forged-namespace";
const CROSS_FLOW_ID = "phase1-verify-cross-workspace";
const CONCURRENCY_FLOW_ID = "phase1-verify-concurrency";

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

let failures = 0;
let warnings = 0;

function check(label: string, actual: unknown, expected: unknown, note?: string) {
  const pass = String(actual) === String(expected);
  if (!pass) failures++;
  console.log(
    `    ${pass ? c.ok("PASS") : c.bad("FAIL")}  ${label.padEnd(52)} ` +
      (pass ? c.dim(String(expected)) : c.bad(`got=${actual} want=${expected}`)),
  );
  if (note) console.log(`          ${c.dim(note)}`);
}

function warn(label: string, detail: string) {
  warnings++;
  console.log(`    ${c.warn("WARN")}  ${label.padEnd(52)} ${c.dim(detail)}`);
}

async function post(path: string, body: unknown, auth?: string) {
  const res = await fetch(`${FOUNDRY}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep the text */
  }
  return { status: res.status, body: parsed as Record<string, unknown> };
}

/** A never-used Kestra execution id, so `begin` takes the create path. */
function syntheticExecutionId(tag: string) {
  return `verify-${tag}-${process.pid}-${Math.trunc(performance.now())}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 6 — a forged namespace must never yield a token
// ─────────────────────────────────────────────────────────────────────────────
async function assertion6(ns: ReturnType<typeof namespaceFor>, otherNamespace: string) {
  console.log(`\n  assertion 6 — forged namespace → 403 (R4)`);
  const secret = config.kestra.callbackSecret;

  const forgeries: Array<[string, string]> = [
    ["unknown tenant", "foundry.evil.hr"],
    ["unknown workspace", "foundry.default.does-not-exist"],
    ["wrong root prefix", "evil.default.hr"],
    ["no tenant segment", "foundry.hr"],
    ["path traversal in slug", "foundry.default.../foundry"],
  ];

  for (const [label, forged] of forgeries) {
    const r = await post(
      "/api/executions/begin",
      { namespace: forged, flowId: "x", executionId: syntheticExecutionId("f6"), inputs: {} },
      secret,
    );
    check(`403 for ${label}`, r.status, 403);
    if (r.body?.token) {
      failures++;
      console.log(`    ${c.bad("FAIL")}  a token was issued for a forged namespace — R4 breach`);
    }
  }

  // A synthetic execution id names no Kestra execution, so `begin` cannot verify
  // the claim and must refuse rather than fall back to the body.
  const unknownExecution = await post(
    "/api/executions/begin",
    { namespace: ns.value, flowId: "x", executionId: syntheticExecutionId("f6-unknown"), inputs: {} },
    secret,
  );
  check("403 for an execution id Kestra does not know", unknownExecution.status, 403);

  // Unauthenticated and wrong-secret must be 401, never 403 — a 403 here would
  // mean the namespace was parsed before the credential was checked.
  const noAuth = await post("/api/executions/begin", { namespace: ns.value, flowId: "x", executionId: "y" });
  check("401 with no callback credential", noAuth.status, 401);
  const badAuth = await post(
    "/api/executions/begin",
    { namespace: ns.value, flowId: "x", executionId: "y" },
    `${secret}x`,
  );
  check("401 with a wrong callback credential", badAuth.status, 401);

  // ── The one that matters ────────────────────────────────────────────────────
  // The five above fail on PARSING. This one can only fail on AUTHORISATION: a
  // real flow, deployed in HR's namespace, whose `begin` body claims a real
  // OTHER workspace. Before I-07 this returned 200 and handed over that
  // workspace's token.
  console.log(`    ${c.dim(`cross-workspace claim — flow in ${ns.value}, body claims ${otherNamespace}`)}`);
  const yaml = HALT_FLOW(CROSS_FLOW_ID, otherNamespace).replace(
    "namespace: PLACEHOLDER",
    `namespace: ${ns.value}`,
  );
  await kestra.deployFlow(ns, CROSS_FLOW_ID, yaml);
  const started = await kestra.startExecution(ns, CROSS_FLOW_ID, {}, { verify: "a6" });
  const execution = await waitForTerminal(started.id, 90_000);
  const begin = (execution.taskRunList ?? []).find((t) => t.taskId === "begin");

  check("cross-workspace claim fails the begin task", begin?.state.current ?? "MISSING", "FAILED");
  check("no flow_executions row for the claimed workspace", (await flowExecutionRepo.getByKestraId(started.id)) ? "created" : "none", "none");
  const leaked = await tokensMintedFor(started.id);
  check("no token was minted", leaked, 0);

  await kestra.deleteFlow(ns, CROSS_FLOW_ID).catch(() => {});
}

/** Tokens attached to any flow_execution carrying this Kestra execution id. */
async function tokensMintedFor(kestraExecutionId: string): Promise<number> {
  const fx = await flowExecutionRepo.getByKestraId(kestraExecutionId);
  if (!fx) return 0;
  return (await db.select().from(executionTokens).where(eq(executionTokens.flowExecutionId, fx.id))).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 7 — single-use per execution, and expiring
// ─────────────────────────────────────────────────────────────────────────────
async function assertion7(namespace: string, workspaceId: string) {
  console.log(`\n  assertion 7 — token lifecycle (R3, D-06)`);

  // Minted through the service against a real `flow_executions` row rather than
  // through `begin`. Since I-07, `begin` refuses any execution id Kestra does
  // not know, so bootstrapping through it would mean running a whole flow to
  // test a token — and the subject here is the token lifecycle, not the gate.
  // Assertions 6 and 28 exercise the gate end to end.
  const mk = async (tag: string) => {
    const fx = await flowExecutionRepo.create({
      workspaceId,
      kestraNamespace: namespace,
      kestraFlowId: HALT_FLOW_ID,
      kestraExecutionId: syntheticExecutionId(tag),
      status: "running",
      inputsJson: {},
    });
    return { id: fx.id, ...(await executionTokenService.mint({ workspaceId, flowExecutionId: fx.id })) };
  };

  const minted = await mk("f7");
  const token = minted.token;
  const flowExecutionId = minted.id;
  check("token minted for a live execution", token.length > 0, true);

  // The point of D-06: the SAME token must authenticate more than one callback.
  // A literal reading of "single use" would 401 here, and the flow would die at
  // step 2 with an authorisation error that looks like a misconfiguration.
  const first = await post(
    "/api/steps/datasource",
    { ref: "hr_demo.policy_thresholds", stepId: "v1", taskrunId: "tr-1", params: [{}] },
    token,
  );
  const second = await post(
    "/api/steps/datasource",
    { ref: "hr_demo.policy_thresholds", stepId: "v2", taskrunId: "tr-2", params: [{}] },
    token,
  );
  check("callback 1 accepted", first.status, 200);
  check("callback 2 accepted with the SAME token", second.status, 200, "D-06 — single-use is per execution, not per request");

  // A token names ONE execution. It must not be able to close another.
  const otherExec = await mk("f7-other");
  const otherFlowExecutionId = otherExec.id;
  const crossClose = await post(`/api/executions/${otherFlowExecutionId}/complete`, { status: "succeeded" }, token);
  check("token cannot complete a DIFFERENT execution", crossClose.status, 403);

  // Terminal — and the burn.
  const done = await post(`/api/executions/${flowExecutionId}/complete`, { status: "succeeded" }, token);
  check("complete accepted", done.status, 200);
  check("burned ≥1 token", Number(done.body?.tokensBurned ?? 0) >= 1, true);

  const afterBurn = await post(
    "/api/steps/datasource",
    { ref: "hr_demo.policy_thresholds", stepId: "v3", taskrunId: "tr-3", params: [{}] },
    token,
  );
  check("token rejected AFTER the execution completes", afterBurn.status, 401);

  // Expiry, tested independently of the burn: mint one already past its TTL and
  // present it over HTTP, so it is the middleware being tested and not `verify`
  // in isolation.
  const expired = await executionTokenService.mint({ workspaceId, flowExecutionId }, -1000);
  const expiredCall = await post(
    "/api/steps/datasource",
    { ref: "hr_demo.policy_thresholds", stepId: "v4", taskrunId: "tr-4", params: [{}] },
    expired.token,
  );
  check("expired token rejected", expiredCall.status, 401);

  const garbage = await post(
    "/api/steps/datasource",
    { ref: "hr_demo.policy_thresholds", stepId: "v5", taskrunId: "tr-5", params: [{}] },
    "not-a-token",
  );
  check("unknown token rejected", garbage.status, 401);
  check(
    "unknown and expired are indistinguishable",
    JSON.stringify(garbage.body),
    JSON.stringify(expiredCall.body),
    "distinguishing them is an oracle for which tokens exist",
  );

  // The parent API key must NOT authenticate a step callback — it names no
  // tenant, so there would be no workspace to resolve (see the middleware).
  if (config.parentApiKey) {
    const withParentKey = await post(
      "/api/steps/datasource",
      { ref: "hr_demo.policy_thresholds", stepId: "v6", taskrunId: "tr-6", params: [{}] },
      config.parentApiKey,
    );
    check("parent API key rejected on /api/steps/*", withParentKey.status, 401);
  }

  await flowExecutionRepo.update(otherFlowExecutionId, { status: "cancelled", endedAt: new Date() });
  await executionTokenService.burnForExecution(otherFlowExecutionId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 28 — a refused `begin` halts the execution at step 1
// ─────────────────────────────────────────────────────────────────────────────
const HALT_FLOW = (flowId: string, claimedNamespace: string) => `
id: ${flowId}
namespace: PLACEHOLDER

# Deliberately hostile: \`begin\` claims a namespace it does not live in. Foundry
# must 403, the task must fail, and NOTHING after it may run. If \`downstream\`
# produces a taskrun, a refused gate did not actually gate anything.
tasks:
  - id: begin
    type: io.kestra.plugin.core.http.Request
    uri: "http://server:4000/api/executions/begin"
    method: POST
    contentType: application/json
    headers:
      Authorization: "Bearer {{ secret('FOUNDRY_CALLBACK') }}"
    body: |
      {
        "namespace": "${claimedNamespace}",
        "flowId": "{{ flow.id }}",
        "executionId": "{{ execution.id }}",
        "inputs": {}
      }

  - id: downstream
    type: io.kestra.plugin.core.debug.Return
    format: "this must never run"
`;

async function assertion28(ns: ReturnType<typeof namespaceFor>) {
  console.log(`\n  assertion 28 — a refused begin halts at step 1`);
  const yaml = HALT_FLOW(HALT_FLOW_ID, "foundry.evil.hr").replace(
    "namespace: PLACEHOLDER",
    `namespace: ${ns.value}`,
  );
  await kestra.deployFlow(ns, HALT_FLOW_ID, yaml);

  const started = await kestra.startExecution(ns, HALT_FLOW_ID, {}, { phase: "1", verify: "a28" });
  const execution = await waitForTerminal(started.id, 90_000);

  const runs = execution.taskRunList ?? [];
  const begin = runs.find((t) => t.taskId === "begin");
  const downstream = runs.find((t) => t.taskId === "downstream");

  check("execution state", execution.state.current, "FAILED");
  check("begin state", begin?.state.current ?? "MISSING", "FAILED");
  check("downstream never ran", downstream ? "RAN" : "absent", "absent");

  const recorded = await flowExecutionRepo.getByKestraId(started.id);
  check("no flow_executions row was created", recorded ? "created" : "none", "none");

  await kestra.deleteFlow(ns, HALT_FLOW_ID).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// V2 — flow-level concurrency
// ─────────────────────────────────────────────────────────────────────────────
const CONCURRENCY_FLOW = (flowId: string) => `
id: ${flowId}
namespace: PLACEHOLDER

# V2. \`concurrency\` is how a flow is stopped from overlapping itself — the
# scheduled-automation case where run N+1 fires while N is still going. If
# v1.3.29 does not honour it, M3's per-workspace budget is the ONLY overlap
# control and the design has to say so.
concurrency:
  limit: 1
  behavior: QUEUE

tasks:
  - id: slow
    type: io.kestra.plugin.core.flow.Sleep
    duration: PT6S
`;

async function verifyV2(ns: ReturnType<typeof namespaceFor>) {
  console.log(`\n  V2 — flow-level concurrency in v1.3.29`);
  const yaml = CONCURRENCY_FLOW(CONCURRENCY_FLOW_ID).replace(
    "namespace: PLACEHOLDER",
    `namespace: ${ns.value}`,
  );

  const findings = (await kestra.validateFlow(yaml)) ?? [];
  const problems = findings.filter((f) => f.constraints);
  if (problems.length) {
    failures++;
    console.log(`    ${c.bad("FAIL")}  Kestra rejected \`concurrency\`:`);
    for (const p of problems) console.log(`          ${p.constraints}`);
    return;
  }
  check("`concurrency: {limit, behavior}` validates", "accepted", "accepted");

  await kestra.deployFlow(ns, CONCURRENCY_FLOW_ID, yaml);
  const deployed = await kestra.getFlow(ns, CONCURRENCY_FLOW_ID);
  const persisted = (deployed as unknown as { concurrency?: { limit?: number; behavior?: string } })
    .concurrency;
  check("limit survives the round trip", persisted?.limit ?? "absent", 1);
  check("behavior survives the round trip", persisted?.behavior ?? "absent", "QUEUE");

  // Three at once against limit 1. What matters is that Kestra HOLDS two of
  // them, not how it labels the held state.
  const started = await Promise.all([
    kestra.startExecution(ns, CONCURRENCY_FLOW_ID, {}, { verify: "v2" }),
    kestra.startExecution(ns, CONCURRENCY_FLOW_ID, {}, { verify: "v2" }),
    kestra.startExecution(ns, CONCURRENCY_FLOW_ID, {}, { verify: "v2" }),
  ]);

  let sawHeld = false;
  let maxRunning = 0;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const states = await Promise.all(started.map((e) => kestra.getExecution(e.id)));
    const current = states.map((s) => s.state.current);
    const running = current.filter((s) => s === "RUNNING").length;
    maxRunning = Math.max(maxRunning, running);
    if (current.some((s) => s === "QUEUED" || s === "CREATED")) sawHeld = true;
    if (current.every((s) => ["SUCCESS", "FAILED", "KILLED", "WARNING", "CANCELLED"].includes(s))) break;
  }

  check("never more than 1 RUNNING at a time", maxRunning <= 1, true, `peak concurrent = ${maxRunning}`);
  if (!sawHeld) {
    warn("no QUEUED/CREATED state observed", "1s polling can miss it; the peak-running check is the real assertion");
  }

  await kestra.deleteFlow(ns, CONCURRENCY_FLOW_ID).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// O4 — retention actually DELETES
// ─────────────────────────────────────────────────────────────────────────────
const PURGE_TARGET_FLOW = (flowId: string) => `
id: ${flowId}
namespace: PLACEHOLDER
tasks:
  - id: noop
    type: io.kestra.plugin.core.debug.Return
    format: "purge target"
`;

const PURGE_NOW_FLOW = (flowId: string, targetNamespace: string, targetFlowId: string) => `
id: ${flowId}
namespace: PLACEHOLDER

# Same tasks as retention.flow.yml, but endDate = now and SCOPED to one throwaway
# flow — so it proves deletion without touching anything real.
tasks:
  - id: purge
    type: io.kestra.plugin.core.execution.PurgeExecutions
    namespace: "${targetNamespace}"
    flowId: "${targetFlowId}"
    endDate: "{{ now() }}"
    states: [SUCCESS, WARNING, FAILED, KILLED, CANCELLED]
    purgeExecution: true
    purgeLog: true
    purgeMetric: true
    purgeStorage: true
`;

async function verifyO4(ns: ReturnType<typeof namespaceFor>) {
  console.log(`\n  O4 — retention deletes, not just runs`);

  // The deployed policy exists and is scheduled. A retention flow nobody
  // triggers is the same as no retention flow.
  type Trigger = { type?: string; cron?: string };
  let policy: { triggers?: Trigger[] } | null = null;
  try {
    policy = (await kestra.getFlow(systemNamespace(), "retention")) as unknown as { triggers?: Trigger[] };
  } catch {
    /* reported below */
  }
  check("foundry.system/retention is deployed", policy ? "yes" : "MISSING", "yes", "deploy it with `pnpm kestra:system`");
  const schedule = policy?.triggers?.find((t: Trigger) => t.type?.endsWith("trigger.Schedule"));
  check("it has a Schedule trigger", schedule?.cron ?? "none", schedule?.cron ?? "a cron");

  // A system flow must not be able to obtain a tenant token. `foundry.system`
  // has no tenant segment, so `begin` cannot resolve it — asserted, because that
  // guarantee is a property of the namespace SHAPE and a prefix change would
  // break it silently.
  const systemBegin = await post(
    "/api/executions/begin",
    { namespace: systemNamespace().value, flowId: "retention", executionId: syntheticExecutionId("o4"), inputs: {} },
    config.kestra.callbackSecret,
  );
  check("a foundry.system flow cannot obtain a token", systemBegin.status, 403);

  // Now prove the purge deletes. Three throwaway executions, then a purge scoped
  // to exactly that flow with endDate = now.
  const targetId = "phase1-verify-purge-target";
  const purgerId = "phase1-verify-purge-now";
  await kestra.deployFlow(
    ns,
    targetId,
    PURGE_TARGET_FLOW(targetId).replace("namespace: PLACEHOLDER", `namespace: ${ns.value}`),
  );
  for (let i = 0; i < 3; i++) {
    const e = await kestra.startExecution(ns, targetId, {}, { verify: "o4" });
    await waitForTerminal(e.id, 60_000);
  }
  const before = (await kestra.listExecutions(ns, { flowId: targetId, size: 50 })).total;
  check("3 throwaway executions exist", before >= 3, true, `found ${before}`);

  await kestra.deployFlow(
    ns,
    purgerId,
    PURGE_NOW_FLOW(purgerId, ns.value, targetId).replace("namespace: PLACEHOLDER", `namespace: ${ns.value}`),
  );
  const purgeRun = await waitForTerminal(
    (await kestra.startExecution(ns, purgerId, {}, { verify: "o4" })).id,
    90_000,
  );
  const purged = (purgeRun.taskRunList ?? []).find((t) => t.taskId === "purge");
  const counts = (purged?.outputs ?? {}) as Record<string, number>;
  check("purge task succeeded", purged?.state.current ?? "MISSING", "SUCCESS");
  check("executionsCount > 0", (counts.executionsCount ?? 0) > 0, true, `outputs = ${JSON.stringify(counts)}`);

  const after = (await kestra.listExecutions(ns, { flowId: targetId, size: 50 })).total;
  check("the executions are gone", after, 0, `${before} → ${after}`);

  await kestra.deleteFlow(ns, targetId).catch(() => {});
  await kestra.deleteFlow(ns, purgerId).catch(() => {});
}

async function waitForTerminal(executionId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let execution = await kestra.getExecution(executionId);
  while (Date.now() < deadline) {
    if (["SUCCESS", "FAILED", "KILLED", "WARNING", "CANCELLED"].includes(execution.state.current)) break;
    await sleep(1500);
    execution = await kestra.getExecution(executionId);
  }
  return execution;
}

async function main() {
  console.log(`\nPhase 1 — verification assertions 6, 7, 28 and V2\n${"─".repeat(60)}`);

  const all = await workspaceRepo.list();
  const hr = all.find((w) => w.name === "HR");
  if (!hr?.slug || !hr.tenantSlug) throw new Error('workspace "HR" (with slugs) not found — run `pnpm demo:seed`');
  const other = all.find((w) => w.id !== hr.id && w.slug && w.tenantSlug);
  if (!other) throw new Error("need a second slugged workspace for the cross-workspace check");

  const ns = namespaceFor(hr.tenantSlug, hr.slug);
  const otherNs = namespaceFor(other.tenantSlug!, other.slug!);
  console.log(`workspace HR      ${c.dim(`${ns.value}  ${hr.id}`)}`);
  console.log(`other workspace   ${c.dim(`${otherNs.value}  ${other.id}`)}`);

  if (!config.kestra.callbackSecret) throw new Error("KESTRA_CALLBACK_SECRET is unset");
  const health = await kestra.health();
  if (!health.authenticated) throw new Error(`Kestra not reachable/authenticated: ${health.detail}`);

  await assertion6(ns, otherNs.value);
  await assertion7(ns.value, hr.id);
  await assertion28(ns);
  await verifyV2(ns);
  await verifyO4(ns);

  console.log(
    `\n${"─".repeat(60)}\n` +
      (failures === 0 ? c.ok("all assertions passed") : c.bad(`${failures} assertion(s) FAILED`)) +
      (warnings ? c.warn(`  ·  ${warnings} warning(s)`) : "") +
      "\n",
  );
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  if (e instanceof KestraError) {
    console.error(c.bad(`\nKestra error ${e.status}:`), e.message);
    console.error(JSON.stringify(e.body, null, 2)?.slice(0, 2000));
  } else {
    console.error(c.bad("\nfailed:"), (e as Error).message, "\n", (e as Error).stack);
  }
  process.exit(1);
});
