-- Project memory ledger (personal thin product Phase 4): curated facts a project's chats start with.
-- Not vectors — each row is an accepted decision / preference / open loop / note. Active rows inject into
-- chat context; superseded/discarded stay for history. Deleted with the project.
CREATE TABLE IF NOT EXISTS "project_memories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "kind" varchar(32) NOT NULL,
  "body" text NOT NULL,
  "status" varchar(32) NOT NULL DEFAULT 'active',
  "source" varchar(32) NOT NULL DEFAULT 'manual',
  "source_chat_id" uuid,
  "source_message_id" varchar(64),
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_project_memories_project_status" ON "project_memories" ("project_id", "status");
