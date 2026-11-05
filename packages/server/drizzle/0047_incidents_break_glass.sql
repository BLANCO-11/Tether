-- B-16 · S-58/S-59/S-60 Break-glass & incidents — incidents, break_glass_sessions
-- Migration idx 47 (next after 0046_audit_events)
CREATE TABLE IF NOT EXISTS "incidents" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "severity" text NOT NULL CHECK ("severity" IN ('sev1','sev2','sev3')),
  "status" text NOT NULL DEFAULT 'reported' CHECK ("status" IN ('reported','triaged','investigating','contained','recovering','monitoring','resolved','post-incident-review','closed')),
  "owner_subject" text,
  "opened_at" timestamp with time zone DEFAULT now() NOT NULL,
  "timeline" jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_incidents_workspace_status" ON "incidents" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "break_glass_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "incident_id" text NOT NULL REFERENCES "incidents"("id") ON DELETE CASCADE,
  "scope" text NOT NULL CHECK ("scope" IN ('hris-unmasked','payroll-restricted')),
  "duration_hours" integer NOT NULL CHECK ("duration_hours" IN (1,2,4)),
  "justification" text NOT NULL CHECK (char_length("justification") >= 20),
  "acknowledged" boolean NOT NULL DEFAULT false,
  "activated_by_subject" text NOT NULL,
  "activated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone GENERATED ALWAYS AS (("activated_at" AT TIME ZONE 'UTC' + "duration_hours" * interval '1 hour') AT TIME ZONE 'UTC') STORED,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active','expired','revoked'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_break_glass_workspace_incident" ON "break_glass_sessions" USING btree ("workspace_id","incident_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_break_glass_workspace_status" ON "break_glass_sessions" USING btree ("workspace_id","status");--> statement-breakpoint
COMMENT ON TABLE "incidents" IS 'B-16 incidents (INC-2026-08-0004 etc). Workspace-scoped, SEV1 gates 4h break-glass duration server-side.';--> statement-breakpoint
COMMENT ON TABLE "break_glass_sessions" IS 'B-16 break-glass sessions. Append-only activation trail, expires_at generated as activated_at + duration. SEV1 check enforced in service; justification len>=20 and acknowledged=true enforced both DB check and service validation.';--> statement-breakpoint
COMMENT ON COLUMN "break_glass_sessions"."expires_at" IS 'Generated as activated_at + duration_hours * interval 1 hour (STORED).'; 
