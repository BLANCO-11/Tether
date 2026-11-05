-- B-15 · S-68 Audit explorer — audit_events immutable record
-- Append-only: no UPDATE or DELETE is granted; writes only via INSERT.
-- Workspace-scoped. Two views (Plain English and Raw) are projections of the same rows.
CREATE TABLE IF NOT EXISTS "audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "time" timestamp with time zone DEFAULT now() NOT NULL,
  "actor" text NOT NULL,
  "operation" text NOT NULL CHECK ("operation" IN ('create','update','delete','publish','approve','reject','access','execute')),
  "entity" text NOT NULL CHECK ("entity" IN ('workflow','version','resource','run','incident','approval','policy','datasource','tool','trigger','secret','member','flow','execution','template')),
  "entity_id" text,
  "description" text NOT NULL,
  "where_text" text NOT NULL,
  "where_entity_type" text,
  "where_entity_id" text,
  "raw" jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_events_workspace_time" ON "audit_events" USING btree ("workspace_id","time" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_events_workspace_actor" ON "audit_events" USING btree ("workspace_id","actor");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_events_workspace_operation" ON "audit_events" USING btree ("workspace_id","operation");--> statement-breakpoint
COMMENT ON TABLE "audit_events" IS 'Append-only immutable audit record (B-15). No UPDATE or DELETE is granted; writes only via INSERT. Plain English and raw events are two views of the same rows.';--> statement-breakpoint
-- Enforce append-only at privilege level: no UPDATE or DELETE for PUBLIC.
REVOKE UPDATE, DELETE ON "audit_events" FROM PUBLIC;
