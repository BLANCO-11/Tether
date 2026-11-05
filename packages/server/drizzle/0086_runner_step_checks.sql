-- pi-runtime (2026-10-10): what a step returned, checked against what it declared, kept on the step's record.
-- A prod run returned 3,387 employees with every average NULL and went green, because nothing looked at a step's
-- output. The runner now checks every step (flow-runner/runner/checks.py) and this is where the findings live.
alter table runner_step_results add column if not exists checks_json jsonb;
-- The builder's automatic test after each build turn, told apart from a run a person started.
alter table flow_executions add column if not exists auto_test boolean not null default false;
