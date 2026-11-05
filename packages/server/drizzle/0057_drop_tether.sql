-- Drop the agent-runtime join keys and the question columns that travelled with
-- them. The runtime they addressed is gone; a column named after it is a
-- reference the next reader has to chase.
--
-- ⚠ MEASURED BEFORE THE DROP, on this deployment: flow_step_runs with a
-- tether_run_id = 0, flow_step_approvals with a tether_run_id = 0, and
-- flow_step_approvals with kind = 'question' = 0. So this is data-lossless and
-- is a plain DROP COLUMN rather than an archive-then-drop — the same reasoning,
-- and the same measurement, as migration 0032 when workspaces.tether_tenant_id
-- and tether_api_key went.
--
-- ⚠ `kind` STAYS on flow_step_approvals, now with one value. The decide path
-- branching on a FACT rather than on the presence of a JSON key is the I-14
-- lesson, and a second thing that waits for a person is a shape this table
-- should be able to take again without a migration.

DROP INDEX IF EXISTS "idx_flow_step_runs_awaiting_resume";
ALTER TABLE "flow_step_runs" DROP CONSTRAINT IF EXISTS "uq_flow_step_runs_tether_run";
ALTER TABLE "flow_step_runs" DROP COLUMN IF EXISTS "tether_run_id";

ALTER TABLE "flow_step_approvals" DROP COLUMN IF EXISTS "tether_run_id";
ALTER TABLE "flow_step_approvals" DROP COLUMN IF EXISTS "question_id";
ALTER TABLE "flow_step_approvals" DROP COLUMN IF EXISTS "questions";

-- ⚠ The M4 daily budget went with it. `checkAgentRun` was its only reader and
-- the agent step was that check's only caller, so the column, its config default
-- and its env var were a setting nothing consulted — every signal saying a
-- ceiling existed, and only a grep saying otherwise (GAPS §6.4, Redis).
ALTER TABLE "tenant_budgets" DROP COLUMN IF EXISTS "max_agent_runs_per_day";
