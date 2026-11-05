/**
 * A drafted trigger has NO SCHEDULE IN THE ENGINE.
 * ui-upgrade Phase 7 exit criterion · `pnpm --filter @foundry/server kestra:trigger-draft`
 *
 * ── ⚠ Why this asserts against KESTRA and not against Foundry's row ─────────
 *
 * `plan.md` Phase 7 words its exit criterion carefully: *"a new draft trigger
 * provably has no schedule in the engine — **assert against Kestra**, not against
 * Foundry's own row."* That is `CLAUDE.md`'s D-13 in a different costume. Foundry
 * and Kestra legitimately disagree about a flow's state, and the Foundry row is
 * the one that lies: `triggers.enabled = false` says what Foundry intends, while
 * what actually fires on a timer is a `Schedule` task inside the flow definition
 * the engine holds. A test reading `enabled === false` would pass over a
 * deployment that was firing every morning.
 *
 * ── ⚠ A control that cannot fail is worse than none (I-38) ──────────────────
 *
 * "There is no schedule in Kestra" is trivially true of a flow Kestra has never
 * heard of, so two of the seven checks below exist purely to stop this harness
 * reporting green over nothing:
 *
 *   - **C1** asserts the engine really holds this flow (in the DRAFT namespace,
 *     where `writeRevision` deploys every revision). Without it, checks 3 and 4
 *     are assertions about an empty string.
 *   - **C2** is the positive control: the same model, compiled with
 *     `withSchedule`, MUST contain `io.kestra.plugin.core.trigger.Schedule`. So
 *     the absence found in the deployed YAML is a fact about the deployment
 *     rather than about this file being unable to recognise a schedule.
 *
 * ── The surface ─────────────────────────────────────────────────────────────
 *
 * Services directly, not HTTP. This harness's subject is an ENGINE property, and
 * `e2e:ui`'s HTTP-only rule exists because its subject is the client's journey.
 * Same split `kestra:canvas` states for itself.
 */
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { triggerRepo } from "../repositories/trigger.repo.js";
import { flowService } from "../services/flow.service.js";
import { triggerService } from "../services/trigger.service.js";
import { flowCompiler, type FlowModel } from "../services/flow-compiler.service.js";
import { systemAuthor } from "../services/revision-author.js";
import { kestra } from "../services/kestra-client.service.js";
import { FINANCE_WORKSPACE_NAME } from "../demo/finance/provision-finance.js";

const KEEP = process.argv.includes("--keep");
const FLOW_ID = "trigger-draft-probe";
// ⚠ Numeric day-of-week. `assertCron` rejects `MON` — the compiler validates
// each field as a cron expression and does not accept day NAMES.
const CRON = "0 6 * * 1";

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(
    `  ${ok ? c.ok("PASS") : c.bad("FAIL")}  ${label}\n        ${c.dim(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)}`,
  );
}

/**
 * ⚠ It declares a `schedule` ON THE MODEL, which is the whole point. A flow with
 * no cron would make "no Schedule in the engine" true for an uninteresting
 * reason. The steps are a single `transform` so the model needs no manifest ref
 * and this harness cannot fail for reasons that are nothing to do with it.
 */
const MODEL: FlowModel = {
  id: FLOW_ID,
  inputs: [
    { id: "period", type: "STRING", required: true },
    { id: "region", type: "STRING", required: true, defaults: "emea" },
  ],
  schedule: { cron: CRON },
  steps: [{ id: "noop", kind: "transform", expr: "{{ inputs.period }}" }],
};

async function main() {
  const ws = (await workspaceRepo.list()).find((w) => w.name === FINANCE_WORKSPACE_NAME);
  if (!ws) {
    console.error(c.bad(`workspace "${FINANCE_WORKSPACE_NAME}" not found — run finance:seed first`));
    process.exit(2);
  }
  const { draft, live } = await flowService.namespaces(ws.id);

  // A previous run left behind is not a reason to fail; it is a reason to clean.
  const stale = (await flowService.list(ws.id)).find((r) => r.flow.kestraFlowId === FLOW_ID);
  if (stale) await flowService.remove(ws.id, stale.flow.id).catch(() => {});

  console.log(`\n${"─".repeat(76)}\nA drafted trigger has no schedule in the engine\n`);

  const { flow } = await flowService.create(
    ws.id,
    { name: "trigger draft probe", model: MODEL, author: systemAuthor("kestra:trigger-draft") },
  );
  const { drafted, skipped } = await triggerService.draftForFlow(ws.id, flow.id);

  // ── 1 · Foundry's side ────────────────────────────────────────────────────
  check("drafting produced a trigger", skipped, null);
  check("…and it is MANUAL, the only type that cannot arm a timer", drafted?.type, "manual");
  check("…and it is disabled", drafted?.enabled, false);
  // D-107: no invented value, and the plan's default is reported rather than copied.
  const stored = (await triggerRepo.get(drafted!.id))!.config as { inputs?: Record<string, unknown> };
  check("…and it stores no input value it was not given", stored.inputs, {});

  // ── 2 · C1 — the engine really holds this flow ────────────────────────────
  //
  // Without this, every assertion below is a statement about an empty string.
  const source = await kestra.getFlowSource(draft, FLOW_ID).catch(() => "");
  check("the ENGINE holds the flow in its draft namespace", source.includes(`id: ${FLOW_ID}`), true);

  // ── 3 · The criterion ─────────────────────────────────────────────────────
  check(
    "…and that deployed definition contains NO Schedule trigger",
    /io\.kestra\.plugin\.core\.trigger\.Schedule/.test(source),
    false,
  );
  const liveExists = await kestra
    .getFlow(live, FLOW_ID)
    .then(() => true)
    .catch(() => false);
  check("…and the LIVE namespace holds no version of it at all", liveExists, false);

  // ── 4 · C2 — the positive control ─────────────────────────────────────────
  //
  // ⚠ The same model, compiled the way approval compiles it. If this were also
  // schedule-free the check above would be measuring this file's eyesight rather
  // than the deployment.
  const armed = flowCompiler.compile(MODEL, { namespace: live, withSchedule: true });
  check(
    "CONTROL: the same model compiled for approval DOES carry one",
    /io\.kestra\.plugin\.core\.trigger\.Schedule/.test(armed.yaml) && armed.yaml.includes(CRON),
    true,
  );

  if (!KEEP) {
    await flowService.remove(ws.id, flow.id).catch(() => {});
    await kestra.deleteFlow(draft, FLOW_ID).catch(() => {});
  } else {
    console.log(c.dim(`\n  --keep: left flow ${flow.id} and its draft deployment in place`));
  }

  console.log(
    `\n${"─".repeat(76)}\n${passed} passed · ${failed} failed\n` +
      `${c.dim("Drafting is not arming: the trigger exists, and the engine holds no timer for it.")}\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(c.bad(`\n${(e as Error).stack ?? String(e)}`));
  process.exit(2);
});
