-- pi-runtime P6 (plans/pi-runtime-2026-10-09): a Pi flow's builder conversation, kept with the flow.
-- Pi runs stateless (--no-session) and the session lived only in the server's memory, so reopening a flow — or a
-- server restart — lost the whole conversation. One row per flow, replaced as the conversation grows; the welcome
-- line is not stored (it is written fresh on every open). Deleted with its flow.
create table if not exists pi_flow_chats (
  flow_id uuid primary key references flows(id) on delete cascade,
  workspace_id uuid not null,
  messages jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
