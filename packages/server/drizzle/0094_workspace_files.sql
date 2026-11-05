-- A workspace's files (Resources → Files): documents, sheets, images and text a workflow reads when it runs.
CREATE TABLE IF NOT EXISTS "workspace_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" varchar(255) NOT NULL,
  "content_type" varchar(120) NOT NULL,
  "size_bytes" integer NOT NULL CHECK ("size_bytes" > 0 AND "size_bytes" <= 52428800),
  "sha256" varchar(64) NOT NULL,
  "content_enc" bytea NOT NULL,
  "uploaded_by" varchar(320),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workspace_files_name" ON "workspace_files" ("workspace_id", "name");
