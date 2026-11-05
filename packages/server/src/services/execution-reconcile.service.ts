import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { executionTokenService } from "./execution-token.service.js";
import { kestra, KestraError } from "./kestra-client.service.js";

/** Kestra states that mean the execution will never call `complete`. */
const KESTRA_TERMINAL: Record<string, "succeeded" | "failed" | "cancelled"> = {
  SUCCESS: "succeeded",
  WARNING: "succeeded",
  FAILED: "failed",
  KILLED: "cancelled",
  CANCELLED: "cancelled",
};

/**
 * Close Foundry rows whose Kestra execution has already finished, and return the
 * count still genuinely in flight.
 *
 * ── Why this exists (I-10) ──────────────────────────────────────────────────
 *
 * `complete` is a TASK IN THE FLOW, so an execution that FAILS never reaches it
 * and its `flow_executions` row stays `running` for ever. Each failure therefore
 * consumes an M3 concurrency slot permanently: five failed runs against the
 * default budget of five is a workspace bricked by a fairness control, and the
 * error it reports ("5 in flight") is true and useless.
 *
 * Kestra is the system of record for execution state (R6), so this never
 * *invents* a status — it copies the terminal one Kestra reports. A row Kestra
 * has no record of at all is closed as `cancelled`: Kestra's own retention purge
 * deletes old executions (O4), and a row whose execution has been purged is by
 * definition not running. Any OTHER error (Kestra down, a timeout) leaves the row
 * alone and counts it as running, because guessing there would close a live
 * execution and let the budget be exceeded.
 *
 * ── Why it moved out of `routes/executions.ts` ──────────────────────────────
 *
 * It lived beside `begin`, which was the only caller — and that was the bug.
 * `flow-replay.service.ts` charges the SAME budget (a partial replay does not
 * execute `begin`, D-26, so it re-applies the checks itself) and had no
 * reconciliation at all. So the replay path refused with 429 as soon as five
 * failed runs had accumulated, and would never recover on its own.
 *
 * It presents as a harness or a user hitting "replay" on a failed run — which is
 * exactly when failed runs exist — and the two paths disagreeing about the same
 * number is the sort of thing that reads as flakiness. `kestra:phase6` found it
 * by deliberately creating failed runs and then replaying them.
 *
 * Call it ONLY on the refusal path. It is a Kestra round trip per in-flight row,
 * and the count only has to be exactly right at the moment something is about to
 * be refused for it.
 */
export async function reconcileRunning(workspaceId: string): Promise<number> {
  const rows = await flowExecutionRepo.listRunning(workspaceId);
  let stillRunning = 0;
  for (const row of rows) {
    let status: "succeeded" | "failed" | "cancelled" | null = null;
    try {
      const record = await kestra.getExecution(row.kestraExecutionId);
      status = KESTRA_TERMINAL[record.state.current] ?? null;
    } catch (e) {
      if (e instanceof KestraError && e.status === 404) status = "cancelled";
      else {
        stillRunning++;
        continue;
      }
    }
    if (status) {
      await flowExecutionRepo.update(row.id, { status, endedAt: new Date() });
      await executionTokenService.burnForExecution(row.id);
    } else {
      stillRunning++;
    }
  }
  return stillRunning;
}
