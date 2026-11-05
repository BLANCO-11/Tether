-- A held (captured) message's attachments as files, one encrypted row each (2026-10-13). They were kept inline in
-- email_sends.captured_attachments and returned with every message in the Email box list, so anything past 5 MB was
-- not kept at all: a test run's report showed a name and nothing to open. Read one at a time now, at any size the
-- mail route accepts.
CREATE TABLE IF NOT EXISTS "email_held_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email_send_id" uuid NOT NULL REFERENCES "email_sends"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "position" integer NOT NULL,
  "name" varchar(255) NOT NULL,
  "content_type" varchar(120) NOT NULL,
  "size_bytes" integer NOT NULL,
  "content_enc" bytea NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_email_held_files_send_position" ON "email_held_files" ("email_send_id", "position");
