-- Restricted workspaces (plans/restricted-workspaces-2026-10-29): a workspace its own admins close to everyone above
-- it. Off for every existing workspace.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "restricted" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "restricted_by" text;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "restricted_at" timestamp with time zone;
--> statement-breakpoint
-- A super admin's time-bound, audited way into a restricted workspace.
CREATE TABLE IF NOT EXISTS "workspace_emergency_access" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "subject" text NOT NULL,
  "email" text,
  "reason" text NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone,
  "ended_by" text,
  CONSTRAINT "workspace_emergency_access_window" CHECK ("expires_at" > "started_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_emergency_access_ws" ON "workspace_emergency_access" ("workspace_id", "subject");
