-- Device → Foundry → plugin relay: paired edge asks Foundry to run a connected-plugin
-- action with the owner's configured connection (never secrets on the device).
CREATE TABLE IF NOT EXISTS "edge_relay_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "device_id" uuid NOT NULL REFERENCES "edge_devices"("id") ON DELETE cascade,
  "owner_subject" text NOT NULL,
  "tool" text NOT NULL,
  "params" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "summary" text NOT NULL,
  "status" varchar(32) DEFAULT 'pending' NOT NULL,
  "proposal_id" text,
  "session_id" text,
  "chat_id" uuid,
  "result" text,
  "result_json" jsonb,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "ix_edge_relay_device" ON "edge_relay_requests" ("device_id", "status");
CREATE INDEX IF NOT EXISTS "ix_edge_relay_owner" ON "edge_relay_requests" ("workspace_id", "owner_subject", "status");
