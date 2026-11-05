-- Secure edge setup (personal Phase 6): bootstrap setup links + connect approval before a device token is issued.
-- Setup token only authorises a *request* to connect; the owner Approves in Foundry; the agent then collects the device token once.
ALTER TABLE "edge_devices" DROP CONSTRAINT IF EXISTS "ck_edge_devices_status";
--> statement-breakpoint
ALTER TABLE "edge_devices" ADD CONSTRAINT "ck_edge_devices_status"
  CHECK ("status" in ('pairing', 'awaiting_connect', 'active', 'revoked'));
--> statement-breakpoint
ALTER TABLE "edge_devices" ADD COLUMN IF NOT EXISTS "wait_secret_hash" varchar(64);
--> statement-breakpoint
ALTER TABLE "edge_devices" ADD COLUMN IF NOT EXISTS "connect_token_once" text;
--> statement-breakpoint
ALTER TABLE "edge_devices" ADD COLUMN IF NOT EXISTS "agent_label" text;

CREATE TABLE IF NOT EXISTS "edge_setup_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "owner_subject" text NOT NULL,
  "token_hash" varchar(64) NOT NULL,
  "label" text NOT NULL DEFAULT 'This computer',
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_edge_setup_links_token_hash" ON "edge_setup_links" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_edge_setup_links_owner" ON "edge_setup_links" ("workspace_id", "owner_subject");
