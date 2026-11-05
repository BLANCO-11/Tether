-- builder-behaviour P7 (P4-I4): an approval INSIDE a loop asks about ONE item — one request row per item, each resumed on its own.
-- `scope` is the item (its row number, as the flow sends it); '' for a gate outside a loop, so every existing row keeps its meaning and
-- the uniqueness that stops a retried registration from asking twice still holds, now per item. `taskrun_id` is the registering task:
-- inside a loop its parent is the item's own branch, where that item's paused task is found (never "the first paused task by name").
alter table flow_step_approvals add column if not exists scope varchar(64) not null default '';
alter table flow_step_approvals add column if not exists taskrun_id varchar(255);
alter table flow_step_approvals drop constraint if exists uq_flow_step_approvals_step;
alter table flow_step_approvals add constraint uq_flow_step_approvals_step unique (flow_execution_id, step_id, scope);
