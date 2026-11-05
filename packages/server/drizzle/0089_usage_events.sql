-- Observability (pi-runtime P-OBS, 2026-10-10): one row per thing that costs or counts — a model call, a tool call,
-- a read. Who, which workflow, what for (building / test / live), how many tokens, what it cost, how long, whether it
-- worked. Run outcomes are NOT here: flow_executions already holds them.
CREATE TABLE IF NOT EXISTS "usage_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "at" timestamptz NOT NULL DEFAULT now(),
  "purpose" varchar(16) NOT NULL CHECK ("purpose" IN ('building', 'test', 'live')),
  "kind" varchar(16) NOT NULL CHECK ("kind" IN ('llm', 'tool', 'read')),
  "source" varchar(32) NOT NULL,
  "subject" varchar(255),
  "actor" varchar(255),
  "flow_id" uuid REFERENCES "flows"("id") ON DELETE SET NULL,
  "flow_name" text,
  "session_id" varchar(64),
  "execution_id" uuid,
  "step_id" varchar(255),
  "model" varchar(255),
  "tool" varchar(255),
  "tokens_in" integer,
  "tokens_out" integer,
  "tokens_cached" integer,
  "cost_usd" numeric(14, 8),
  "duration_ms" integer,
  "ok" boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS "ix_usage_events_ws_at" ON "usage_events" ("workspace_id", "at");
CREATE INDEX IF NOT EXISTS "ix_usage_events_flow" ON "usage_events" ("flow_id");
CREATE INDEX IF NOT EXISTS "ix_usage_events_session" ON "usage_events" ("session_id");
