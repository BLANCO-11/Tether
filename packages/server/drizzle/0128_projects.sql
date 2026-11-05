-- Sharing boundaries phase 5 (plans/sharing-boundaries-2026-10-30, D6): PROJECTS — a smaller circle inside a workspace
-- with shared context. An item lives in ONE place: My space (project_id NULL, private), a project (project_id set), or
-- the Workspace (project_id NULL, public). Members come from the workspace only; its owner (or an Admin) manages them.
-- Someone removed loses everything in it at once (membership IS the access); items they owned pass to the project's
-- owner. Deleting a project returns its items to their owners' My space — never to the workspace.
CREATE TABLE IF NOT EXISTS "projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  -- Shared context: what every Forge chat in the project is told (notes, conventions, who is who).
  "instructions" text NOT NULL DEFAULT '',
  "owner_subject" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_projects_name" ON "projects" ("workspace_id", lower("name"));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_members" (
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "subject" text NOT NULL,
  "added_by" text NOT NULL,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("project_id", "subject")
);--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "pi_chats" ADD COLUMN IF NOT EXISTS "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flows_project" ON "flows" ("project_id") WHERE "project_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pi_chats_project" ON "pi_chats" ("project_id") WHERE "project_id" IS NOT NULL;
