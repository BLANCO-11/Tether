-- Per-person read shares (personal thin product Phase 5): grant a People-listed member read access to a
-- chat or a run without moving it to the Workspace or a project. No public links. Deleted with the workspace.
CREATE TABLE IF NOT EXISTS "item_shares" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "kind" varchar(16) NOT NULL,
  "item_id" uuid NOT NULL,
  "subject" text NOT NULL,
  "granted_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ck_item_shares_kind" CHECK ("kind" in ('chat', 'run'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_item_shares_item_subject" ON "item_shares" ("kind", "item_id", "subject");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_item_shares_subject" ON "item_shares" ("workspace_id", "subject", "kind");
