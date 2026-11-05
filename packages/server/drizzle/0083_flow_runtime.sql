-- pi-runtime P3 (plans/pi-runtime-2026-10-09): which engine runs a flow.
-- `kestra` — the compiled FlowModel path (every flow that existed before this migration keeps that meaning).
-- `foundry` — a Pi-built bundle (workflow.json + step files) stored in flow_revisions.model_json and run by
-- flow-runner. Every Kestra seam branches on this ONCE; a value outside the two is refused here, not discovered
-- later as a flow nobody can run.
alter table flows add column if not exists runtime varchar(16) not null default 'kestra';
alter table flows drop constraint if exists ck_flows_runtime;
alter table flows add constraint ck_flows_runtime check (runtime in ('kestra', 'foundry'));
