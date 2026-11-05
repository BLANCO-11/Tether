-- Loops, branches and approvals on Foundry's runner (pi-runtime P5/P7, 2026-10-10).
-- A step record can now say it was not taken (the other side of a branch), is waiting (an approval), ran partly (a
-- loop where some items failed), or was rejected / expired (an approval nobody gave).
ALTER TABLE "runner_step_results" DROP CONSTRAINT IF EXISTS "runner_step_results_status_check";
ALTER TABLE "runner_step_results" ADD CONSTRAINT "runner_step_results_status_check"
  CHECK ("status" IN ('succeeded', 'failed', 'skipped', 'not_taken', 'waiting', 'partial', 'rejected', 'expired'));
-- The job a runner run was started with (everything but its token) — what a paused run is started again from.
ALTER TABLE "flow_executions" ADD COLUMN IF NOT EXISTS "runner_job" jsonb;
-- Every step output so far, while a run waits for an approval: what the resumed run replays instead of re-running.
-- Unredacted (the replay needs the real values); cleared when the run ends.
ALTER TABLE "flow_executions" ADD COLUMN IF NOT EXISTS "runner_memo" jsonb;
