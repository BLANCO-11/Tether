/**
 * Start a draft run and wait for it to settle.
 *
 * ── ⚠ WHY THIS IS ITS OWN MODULE AND NOT A FUNCTION IN `itops-seed.ts` ──────
 *
 * **A scenario script's `main()` runs at IMPORT.** `itops-verify.ts` imported
 * `runDraft` from `itops-seed.ts` and silently re-ran the entire seed —
 * rebuilding the manifest, writing two new revisions and re-arming both flows —
 * with its own output interleaved into the verifier's. It was visible only
 * because the seed prints; a harness that imported something quieter would have
 * done the same work invisibly.
 *
 * This is the second instance in the repository. `propose-measure.test.ts`
 * imported `propose-measure.ts` to reach its adjudicator and loaded the repos,
 * the config and the gateway client into a test process — which is why
 * `propose-adjudicate.ts`, `db-operation-readback.ts` and
 * `flow-expression-rules.ts` are all separate modules today. CLAUDE.md states
 * the rule outright: **do not import a `scenarios/*.ts` or `kestra/*.ts` script.
 * Extract what you need.** This is that extraction, done the moment the rule was
 * broken rather than after the second symptom.
 */
import { flowService } from "../services/flow.service.js";
import { kestra, type KestraExecution } from "../services/kestra-client.service.js";

/**
 * The states Kestra considers final.
 *
 * ⚠ `PAUSED` is NOT among them and is returned rather than waited through. A
 * gated flow parks there by design and would otherwise sit until the timeout,
 * reported as "stuck" — the exact opposite of what happened. The CALLER decides
 * what a pause means; this function only refuses to pretend it is a success.
 */
const SETTLED = ["SUCCESS", "FAILED", "KILLED", "WARNING"];

export async function runDraft(
  workspaceId: string,
  flowId: string,
  inputs: Record<string, string>,
  timeoutMs = 240_000,
  /** Who pressed "Test run" — `system` unless the caller is acting out a person (the conversation corpus). */
  requester?: Parameters<typeof flowService.testRun>[3],
): Promise<KestraExecution> {
  const started = await flowService.testRun(workspaceId, flowId, inputs, ...(requester ? [requester] as const : []));
  const deadline = Date.now() + timeoutMs;
  let last: KestraExecution | undefined;
  while (Date.now() < deadline) {
    last = await kestra.getExecution(started.kestraExecutionId);
    if (SETTLED.includes(last.state.current) || last.state.current === "PAUSED") return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    `execution ${started.kestraExecutionId} did not settle within ${timeoutMs / 1000}s ` +
      `(last state ${last?.state.current ?? "unknown"})`,
  );
}

/** `taskId=STATE · …` for one execution — the "what actually ran" line. */
export function stepReport(ex: KestraExecution): string {
  return (ex.taskRunList ?? []).map((t) => `${t.taskId}=${t.state.current}`).join(" · ");
}
