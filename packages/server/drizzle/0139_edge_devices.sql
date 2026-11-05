-- Edge agent devices (personal thin product Phase 6): a host pairs with a short OTP, then holds a
-- device credential for polling jobs. Pairing codes are short-lived and single-use; the device token
-- hash is stored (never the raw token). Deleted with the workspace.
CREATE TABLE IF NOT EXISTS "edge_devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "owner_subject" text NOT NULL,
  "status" varchar(32) NOT NULL DEFAULT 'pairing',
  "pairing_code_hash" varchar(64),
  "pairing_expires_at" timestamp with time zone,
  "token_hash" varchar(64),
  "last_seen_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "ck_edge_devices_status" CHECK ("status" in ('pairing', 'active', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_edge_devices_ws_owner" ON "edge_devices" ("workspace_id", "owner_subject");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_edge_devices_token_hash" ON "edge_devices" ("token_hash") WHERE "token_hash" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "edge_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "device_id" uuid NOT NULL REFERENCES "edge_devices"("id") ON DELETE CASCADE,
  "kind" varchar(32) NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" varchar(32) NOT NULL DEFAULT 'pending',
  "approval_id" uuid,
  "result" jsonb,
  "error" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  CONSTRAINT "ck_edge_jobs_kind" CHECK ("kind" in ('run_command', 'read_path', 'write_path')),
  CONSTRAINT "ck_edge_jobs_status" CHECK ("status" in ('pending', 'awaiting_approval', 'approved', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_edge_jobs_device_status" ON "edge_jobs" ("device_id", "status");
