import { config } from "./config/index.js";
import { createApp } from "./app.js";
import { startProgressServer } from "./ws/progress-server.js";
import { startTriggerScheduler } from "./services/trigger-scheduler.js";
import { reconcileAbandonedBuilds } from "./services/sandbox-autoprovision.service.js";
import { flowRunnerService } from "./services/flow-runner.service.js";
import { removeOrphanedSessionTrees } from "./pi-builder/sandbox-fs.js";
import { importLegacyAttachments } from "./pi-builder/service.js";
import { stepFileRepo } from "./repositories/step-file.repo.js";

async function main() {
  // Before any request: the last process's Forge sessions are gone, so their sandbox trees are too (sandbox-fs.ts).
  try {
    const cleaned = removeOrphanedSessionTrees();
    if (cleaned.trees || cleaned.draftFiles) {
      console.log(`[pi-builder] removed ${cleaned.trees} sandbox tree(s) and ${cleaned.draftFiles} unsaved draft attachment folder(s) left by the last run`);
    }
  } catch (e) {
    console.warn(`[pi-builder] could not clean up old sandboxes: ${(e as Error).message}`);
  }
  // Chat files kept on disk by the old layout move into their workflows' saved chats (0095), once.
  void importLegacyAttachments()
    .then((r) => {
      if (r.moved || r.left) console.log(`[pi-builder] moved ${r.moved} chat file(s) into saved chats; ${r.left} folder(s) left to retry`);
    })
    .catch((e) => console.warn(`[pi-builder] could not move old chat files: ${(e as Error).message}`));
  const app = createApp();

  app.listen(config.port, () => {
    console.log(`[server] Foundry Parent API listening on :${config.port} (${config.env})`);
  });

  // Live generation-progress WebSocket (parent → browser).
  startProgressServer(config.wsPort);

  // In-process scheduler for schedule/poll triggers.
  startTriggerScheduler();

  // Runner runs waiting at an approval for longer than the limit stop as `expired` (pi-runtime P5). Here, not in
  // the service module: harnesses import the services and must not expire a live server's runs.
  const expire = () =>
    void flowRunnerService.expireStaleApprovals().catch((e) => console.warn(`[flow-runner] approval expiry sweep failed: ${(e as Error).message}`));
  setInterval(expire, 60 * 60_000).unref();
  setTimeout(expire, 30_000).unref();

  // Files a step saved for an email are kept a day (`step-file.repo.ts`).
  const sweepFiles = () =>
    void stepFileRepo
      .sweep()
      .then((n) => n && console.log(`[step-files] swept ${n} saved file(s) older than a day`))
      .catch((e) => console.warn(`[step-files] sweep failed: ${(e as Error).message}`));
  setInterval(sweepFiles, 60 * 60_000).unref();
  setTimeout(sweepFiles, 60_000).unref();

  /**
   * ⚠ A sandbox build runs as a detached promise in THIS process, so every one
   * that was in flight when the last process ended is gone and its row still
   * claims it is running. Three datasources had read "building…" for seven days
   * against a panel promising two minutes. See `reconcileAbandonedBuilds`.
   *
   * ⚠ **Here, and deliberately not in `createApp`.** Every `kestra:*`, `demo:*`
   * and `scenarios:*` harness imports the services directly and never runs this
   * file — which is the point: those processes run alongside a live server, and
   * one of them booting must not mark that server's in-flight build abandoned.
   * The claim "at this instant no build can be in flight" is true of the API
   * process starting up and of nothing else.
   *
   * Unawaited and total: reconciliation is bookkeeping, and a database that is
   * not up yet must delay serving requests by nothing. A failure is logged and
   * the stale rows are simply reconciled at the next boot.
   */
  void reconcileAbandonedBuilds().catch((e) => {
    console.warn("[sandbox:auto] could not reconcile abandoned builds:", (e as Error).message);
  });

  // Unsaved draft tests waiting at a gate have no Approvals inbox entry (flow_id null). Forge sessions
  // from the last process are gone, so those waits can only rot in Activity — cancel them here.
  void flowRunnerService.reconcileOrphanedDraftWaits().catch((e) => {
    console.warn("[flow-runner] could not reconcile orphaned draft waits:", (e as Error).message);
  });
}

/**
 * ── ⚠ THE BACKSTOP, AND IT DELIBERATELY DOES NOT EXIT ───────────────────────
 *
 * `wrapAsyncRoutes` (see `middleware/async-routes.ts`) is the fix: a rejected
 * route promise becomes a response. This is what catches the case it cannot
 * reach — a rejection from the scheduler, a WebSocket handler, or a `void`-ed
 * promise anywhere in a service.
 *
 * Node 22 terminates the process on an unhandled rejection by default, and on
 * this deployment that meant **one malformed query string took the whole API
 * server down 15 times**, with every other person's request failing as
 * `fetch failed` while the container restarted. A logged rejection leaves one
 * piece of work broken; the default leaves everybody's broken.
 *
 * ⚠ **It is LOUD, and that is the whole of what makes it acceptable.** A guard
 * that swallowed these quietly would trade an obvious outage for an invisible
 * defect, which is the worse direction. Do not reduce this to a one-line warn.
 *
 * ⚠ `uncaughtException` is NOT handled here. An unhandled rejection leaves an
 * awaited value unresolved; a synchronous throw escaping every frame can leave
 * process state genuinely inconsistent, and carrying on then is a guess. That
 * one still exits.
 */
process.on("unhandledRejection", (reason) => {
  console.error(
    "[server] UNHANDLED REJECTION — the process is staying up and one piece of " +
      "work has been lost. This is a defect: a promise was rejected with nothing " +
      "awaiting it. Fix the call site.",
    reason instanceof Error ? (reason.stack ?? reason.message) : reason,
  );
});

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
