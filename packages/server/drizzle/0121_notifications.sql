-- Sharing boundaries phase 1 (plans/sharing-boundaries-2026-10-30): a notice to one person, kept until they have seen
-- it. First use: an Admin opened your private chat, workflow or test run (Q1 — the owner is SHOWN it, not only
-- audited). The bell lists these beside run activity.
CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "subject" text NOT NULL,
  "kind" varchar(32) NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "href" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "read_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_recipient" ON "notifications" ("workspace_id", "subject", "created_at");
