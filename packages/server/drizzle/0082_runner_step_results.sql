-- pi-runtime P2 (plans/pi-runtime-2026-10-09): Foundry is the system of record for a Pi workflow's step results.
-- Kestra held step outputs for its own runs (R6) and Foundry kept a pointer; flow-runner has no store of its own, so the
-- result of every step it ran lands here — what Pi's fix loop reads, what the run page shows (P4) and what a run resumes
-- from after an approval (P5). Outputs are REDACTED before they are written (`redactSecrets`), never after.
-- `scope` is the item a step ran for inside a loop ('' outside one) — the convention 0081 set for approvals.
create table if not exists runner_step_results (
  id uuid primary key default gen_random_uuid(),
  flow_execution_id uuid not null references flow_executions(id) on delete cascade,
  step_id varchar(255) not null,
  scope varchar(64) not null default '',
  status varchar(16) not null check (status in ('succeeded', 'failed', 'skipped')),
  output_json jsonb,
  error text,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  constraint uq_runner_step_results unique (flow_execution_id, step_id, scope)
);
create index if not exists ix_runner_step_results_exec on runner_step_results (flow_execution_id);
