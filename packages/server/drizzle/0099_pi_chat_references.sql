-- Workflow references (2026-10-17): a Workflow Builder chat may reference up to 3 SAVED workflows of its own
-- workspace to learn from. Each row pins one saved revision; the card and the code at that revision are kept on the
-- row so the reference stays readable after the referenced workflow is deleted (flow_id then goes NULL). Data files
-- are never copied. See plans/workflow-references-2026-10-16/ (a label: plans/ is gitignored).
CREATE TABLE IF NOT EXISTS "pi_chat_references" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "chat_id" uuid NOT NULL REFERENCES "pi_chats"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "flow_id" uuid REFERENCES "flows"("id") ON DELETE SET NULL,
  "flow_name_snapshot" varchar(200) NOT NULL,
  "revision" integer NOT NULL,
  "card_md" text NOT NULL,
  "bundle_json" jsonb NOT NULL,
  "added_by_subject" varchar(320),
  "added_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_pi_chat_references_flow" ON "pi_chat_references" ("chat_id", "flow_id") WHERE "flow_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_pi_chat_references_chat" ON "pi_chat_references" ("chat_id");
