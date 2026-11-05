/**
 * Phase 4 — `code` steps, verified against the running stack.
 * archive/kestra-migration/progress/phase-4.md
 *
 *   pnpm --filter @foundry/server kestra:phase4
 *
 * Named after the design's verification list: **20, 21, 22, 24 (V1), 26** live,
 *
 * ── What must be here rather than in a unit test ─────────────────────────────
 *
 * 18, 19, 23, 29, 30 and 32–36 are properties of the compiler and the triage
 * table, and they are asserted in `flow-compiler.test.ts`, `step-contract.test.ts`
 * and `failure-triage.test.ts` where they run in milliseconds. What CANNOT be
 * asserted there is anything about the container that actually runs:
 *
 *   * **V1 — R9's whole guarantee.** "The compiler emits `networkMode: none`" is
 *     a string comparison. "A fragment cannot open a socket" is a fact about
 *     Docker, and if it were false every unit test would still pass. It is
 *     checked here WITH A POSITIVE CONTROL, because a probe that fails to
 *     connect for an unrelated reason proves nothing.
 */
import { config } from "../config/index.js";
import { kestra, KestraError, type KestraExecution } from "../services/kestra-client.service.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowExecutionRepo, flowStepRunRepo } from "../repositories/flow-execution.repo.js";
import { flowService } from "../services/flow.service.js";
import { tenantMapper } from "../services/tenant-mapper.service.js";
import type { FlowModel } from "../services/flow-compiler.service.js";
import { assertConformance, type StepContract } from "../services/step-contract.service.js";
import { systemAuthor } from "../services/revision-author.js";


const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
  const pass = String(got) === String(want);
  if (!pass) failures++;
  console.log(
    `  ${pass ? c.ok("PASS") : c.bad("FAIL")}  ${label.padEnd(58)} ` +
      (pass ? c.dim(String(want)) : c.bad(`\n        got  ${got}\n        want ${want}`)),
  );
}

function checkThat(label: string, pass: boolean, detail = "") {
  if (!pass) failures++;
  console.log(`  ${pass ? c.ok("PASS") : c.bad("FAIL")}  ${label.padEnd(58)} ${c.dim(detail)}`);
}

async function waitFor(
  executionId: string,
  until: (e: KestraExecution) => boolean,
  timeoutMs = 240_000,
): Promise<KestraExecution> {
  const deadline = Date.now() + timeoutMs;
  let ex = await kestra.getExecution(executionId);
  while (Date.now() < deadline && !until(ex)) {
    await new Promise((r) => setTimeout(r, 1500));
    ex = await kestra.getExecution(executionId);
  }
  return ex;
}

const settled = (e: KestraExecution) => ["SUCCESS", "FAILED", "KILLED", "WARNING"].includes(e.state.current);
const paused = (e: KestraExecution) => e.state.current === "PAUSED";

function taskOutputs(ex: KestraExecution, taskId: string): Record<string, unknown> {
  return (ex.taskRunList ?? []).find((t) => t.taskId === taskId)?.outputs ?? {};
}
function fragmentResult(ex: KestraExecution, taskId: string): unknown {
  return (taskOutputs(ex, taskId).vars as Record<string, unknown> | undefined)?.result;
}
function taskState(ex: KestraExecution, taskId: string): string {
  return (ex.taskRunList ?? []).find((t) => t.taskId === taskId)?.state.current ?? "ABSENT";
}

/** Deploy a throwaway flow, run it to a condition, tear it down. */
async function runFlow(
  workspaceId: string,
  model: FlowModel,
  opts: { until?: (e: KestraExecution) => boolean; keep?: boolean; inputs?: Record<string, string> } = {},
): Promise<{ execution: KestraExecution; flowId: string }> {
  const stale = await flowRepo.getByKestraFlowId(workspaceId, model.id);
  if (stale) await flowService.remove(workspaceId, stale.id);
  const created = await flowService.create(workspaceId, {
    name: `phase4 ${model.id}`,
    model,
    author: systemAuthor("phase4-verify"),
  });
  const run = await flowService.testRun(workspaceId, created.flow.id, opts.inputs ?? {});
  const execution = await waitFor(run.kestraExecutionId, opts.until ?? settled);
  if (!opts.keep) await flowService.remove(workspaceId, created.flow.id);
  return { execution, flowId: created.flow.id };
}

const fragment = (body: string[]) => body.join("\n");

async function main() {
  console.log(`\nPhase 4 — code steps\n${"═".repeat(72)}`);

  const ws = (await workspaceRepo.list()).find((w) => w.name === "HR");
  if (!ws) throw new Error('workspace "HR" not found — run `pnpm demo:seed` first');
  const ns = tenantMapper.namespacesFor(ws);

  const health = await kestra.health();
  if (!health.reachable) throw new Error(`Kestra unreachable at ${health.baseUrl}: ${health.detail}`);
  if (!health.authenticated) throw new Error(`Kestra rejected KESTRA_AUTH: ${health.detail}`);
  if (!config.kestra.callbackSecret) {
    throw new Error("KESTRA_CALLBACK_SECRET is unset — POST /api/executions/begin refuses everything");
  }
  console.log(`draft namespace  ${c.dim(ns.draft.value)}`);
  console.log(`fragment image   ${c.dim(config.kestra.fragmentImage)}`);
  console.log(`network mode     ${c.dim(config.kestra.fragmentNetworkMode)}`);
  console.log(`kestra           ${c.dim(`${health.edition} ${health.version} @ ${health.baseUrl}`)}\n`);

  // ── 20. a fragment IS a unit test: declared input in, declared output out ──
  console.log(`${"─".repeat(72)}\n20  a fragment runs against its contract, with no datasource and no network\n`);

  const contract: StepContract = {
    stepId: "screen",
    purpose: "flag rows below a threshold",
    input: [
      { name: "rows", type: "array", items: "object" },
      { name: "threshold", type: "number" },
    ],
    output: [
      { name: "flagged", type: "array", items: "object" },
      { name: "count", type: "number" },
    ],
  };

  const { execution: unit } = await runFlow(ws.id, {
    id: "phase4_unit",
    steps: [
      {
        id: "screen",
        kind: "code",
        // The trap employee: #14 at 80.95% is above the org-wide 80% default and
        // below Engineering's 85% override. A fragment that hardcoded 80 would
        // return 1 here instead of 2 — and it CANNOT hardcode 80, because the
        // threshold arrives as a declared input (04 §5.3).
        inputExpr: `{"rows": [{"id": 14, "pct": 80.95}, {"id": 7, "pct": 79.0}, {"id": 3, "pct": 92.0}], "threshold": 85}`,
        outputKeys: ["flagged", "count"],
        code: fragment([
          "def run(payload):",
          "    t = payload['threshold']",
          "    flagged = [r for r in payload['rows'] if r['pct'] < t]",
          "    return {'flagged': flagged, 'count': len(flagged)}",
        ]),
      },
    ],
  });
  check("execution state", unit.state.current, "SUCCESS");
  const result = fragmentResult(unit, "screen") as { flagged?: unknown[]; count?: number };
  check("the fragment returned its declared output", assertConformance(result, contract).ok, true);
  check("…and the threshold came from the CONTRACT, not a literal", result?.count, 2);
  check(
    "the wrapper stamped the contract as satisfied",
    (taskOutputs(unit, "screen").vars as Record<string, unknown>)?.contract_ok,
    true,
  );

  // ── 21 + 24 (V1). The one that cannot be faked in a unit test ─────────────
  console.log(`\n${"─".repeat(72)}\n21/24  V1 — a fragment CANNOT reach the network  ${c.dim("(with a positive control)")}\n`);

  const probe = (label: string) => ({
    id: `phase4_net_${label}`,
    steps: [
      {
        id: "probe",
        kind: "code" as const,
        inputExpr: "{}",
        outputKeys: ["foundry_api", "public_dns", "cloud_metadata", "demo_db"],
        code: fragment([
          "import socket",
          "def run(payload):",
          "    out = {}",
          "    targets = [('foundry_api', 'server', 4000), ('public_dns', '1.1.1.1', 53),",
          "               ('cloud_metadata', '169.254.169.254', 80), ('demo_db', 'postgres', 5432)]",
          "    for name, host, port in targets:",
          "        try:",
          "            s = socket.create_connection((host, port), timeout=4)",
          "            s.close()",
          "            out[name] = 'CONNECTED'",
          "        except Exception as e:",
          "            out[name] = type(e).__name__",
          "    return out",
        ]),
      },
    ],
  });

  // `socket` is rejected by `validateFragment` at GENERATION time — this probe
  // goes straight to the compiler, which is the point: it asks what the
  // CONTAINER permits, not what the validator permits.
  const { execution: netOff } = await runFlow(ws.id, probe("off"));
  check("probe ran", netOff.state.current, "SUCCESS");
  const off = (fragmentResult(netOff, "probe") ?? {}) as Record<string, string>;
  for (const target of ["foundry_api", "public_dns", "cloud_metadata", "demo_db"]) {
    checkThat(`  ${target} is unreachable from the fragment`, off[target] !== "CONNECTED", off[target]);
  }

  // The positive control. Without it, "every socket failed" is equally
  // consistent with a broken probe, a missing base image, or a typo in a
  // hostname — and R9 would be resting on a test that cannot fail.
  const savedMode = config.kestra.fragmentNetworkMode;
  (config.kestra as { fragmentNetworkMode: string }).fragmentNetworkMode = "bridge";
  try {
    const { execution: netOn } = await runFlow(ws.id, probe("on"));
    const on = (fragmentResult(netOn, "probe") ?? {}) as Record<string, string>;
    checkThat(
      "  CONTROL: the same probe DOES connect on a normal network",
      on.public_dns === "CONNECTED",
      `public_dns=${on.public_dns}`,
    );
  } finally {
    (config.kestra as { fragmentNetworkMode: string }).fragmentNetworkMode = savedMode;
  }

  // ── 22. no credential ever enters the container ───────────────────────────
  console.log(`\n${"─".repeat(72)}\n22  the container receives no credential and no environment\n`);

  const { execution: envEx } = await runFlow(ws.id, {
    id: "phase4_env",
    steps: [
      {
        id: "peek",
        kind: "code",
        inputExpr: "{}",
        outputKeys: ["names", "leaking_values"],
        code: fragment([
          "import os",
          "def run(payload):",
          "    # Values, not names. A name-shaped check flagged the python image's",
          "    # own GPG_KEY — the Python release-signing key, which is public by",
          "    # definition and baked into the base image, not something Foundry",
          "    # passed. What matters is whether a CREDENTIAL crossed the boundary.",
          "    markers = ('postgres://', 'mysql://', 'Bearer ', 'Basic ', 'foundry-kestra-callback')",
          "    leaking = sorted(k for k, v in os.environ.items() if any(m in v for m in markers))",
          "    return {'names': sorted(os.environ), 'leaking_values': leaking}",
        ]),
      },
    ],
  });
  const env = (fragmentResult(envEx, "peek") ?? {}) as { names?: string[]; leaking_values?: string[] };
  checkThat(
    "no env var carries a DSN, a token or the callback secret",
    (env.leaking_values ?? []).length === 0,
    JSON.stringify(env.leaking_values ?? []),
  );
  // Names too, against the base image's OWN set. Anything outside it was put
  // there by Kestra or by the compiler, and neither should be putting anything
  // there at all (04 §5.3.2 — "no env vars, no volumes, no mounted config").
  const IMAGE_ENV = new Set([
    // From `python:3.12-slim` and the container runtime. GPG_KEY is Python's
    // release-signing key — public by definition, and the reason this check is
    // by NAME as well as by value rather than by name alone.
    "PATH", "HOSTNAME", "HOME", "LANG", "PWD", "SHLVL", "TERM", "GPG_KEY",
    "PYTHON_VERSION", "PYTHON_SHA256", "PYTHON_SETUPTOOLS_VERSION", "PYTHON_PIP_VERSION",
    "PYTHON_GET_PIP_URL", "PYTHON_GET_PIP_SHA256",
    // Set by `plugin-script-python` itself, not by Foundry. Enumerated rather
    // than pattern-matched so that a FIFTH one appearing fails this assertion —
    // which is the only way "Kestra passes nothing sensitive" stays true across
    // a plugin bump rather than being true on the day it was written.
    "PYTHONUNBUFFERED", "PIP_DISABLE_PIP_VERSION_CHECK", "PIP_ROOT_USER_ACTION", "WORKING_DIR",
  ]);
  const unexpected = (env.names ?? []).filter((n) => !IMAGE_ENV.has(n));
  checkThat(
    "the container's environment is the base image's and nothing more",
    unexpected.length === 0,
    unexpected.length ? JSON.stringify(unexpected) : `${(env.names ?? []).length} vars, all from the image`,
  );

  // ── the wrapper turns a bad fragment into a CLASSIFIABLE failure ──────────
  console.log(`\n${"─".repeat(72)}\nW   a contract violation fails AT the step, named, not three steps later\n`);

  const { execution: badEx } = await runFlow(ws.id, {
    id: "phase4_violation",
    steps: [
      {
        id: "wrong",
        kind: "code",
        inputExpr: `{"rows": []}`,
        outputKeys: ["flagged", "count"],
        // Returns only one of the two declared fields.
        code: fragment(["def run(payload):", "    return {'flagged': []}"]),
      },
    ],
  });
  check("the execution failed", badEx.state.current, "FAILED");
  check("…at the offending step", taskState(badEx, "wrong"), "FAILED");
  const badVars = (taskOutputs(badEx, "wrong").vars ?? {}) as Record<string, unknown>;
  check("…with a classifiable reason", badVars.failure_class, "contract_violation");
  checkThat(
    "…naming the field that was missing",
    String(badVars.detail ?? "").includes("count"),
    String(badVars.detail ?? "").slice(0, 90),
  );

  // ── 26. flow_step_runs duplicates nothing Kestra owns ─────────────────────
  console.log(`\n${"─".repeat(72)}\n26  flow_step_runs stores POINTERS, not a second copy of the run\n`);

  const fx = await flowExecutionRepo.getByKestraId(unit.id);
  const rows = fx ? await flowStepRunRepo.listByExecution(fx.id) : [];
  // A `code` step never calls back into Foundry, so it has no pointer row at
  // all — its entire record is Kestra's taskrun (R6). Asserted rather than
  // assumed, because "add a row so the UI has something to read" is exactly the
  // change that would start the divergence R6 forbids.
  checkThat(
    "a code step writes no Foundry-side step row",
    !rows.some((r) => r.stepId === "screen"),
    `${rows.length} row(s) for this execution`,
  );
  const cols = Object.keys(rows[0] ?? {});
  for (const forbidden of ["status", "startedAt", "durationMs", "inputJson", "outputJson"]) {
    checkThat(`  no \`${forbidden}\` column on flow_step_runs`, !cols.includes(forbidden));
  }

  // ── clean up the probe flows ──────────────────────────────────────────────
  for (const id of ["phase4_net_on"]) {
    try {
      await kestra.deleteFlow(ns.draft, id);
    } catch (e) {
      if (!(e instanceof KestraError && e.status === 404)) throw e;
    }
  }

  console.log(`\n${"═".repeat(72)}`);
  console.log(failures === 0 ? c.ok("Phase 4 assertions: all green") : c.bad(`${failures} assertion(s) FAILED`));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(c.bad(`\nphase4-verify failed: ${(e as Error).message}`));
  console.error(e);
  process.exit(1);
});
