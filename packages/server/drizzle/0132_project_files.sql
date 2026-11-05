-- Project files: documents a project's members share, and every chat in the project can open. Seen only by the
-- project's members (and Admins), like everything else in a project. Deleted with the project: files have no owner's
-- My space to go back to. Same types and per-file limit as workspace Files; contents encrypted at rest.
CREATE TABLE IF NOT EXISTS "project_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" varchar(255) NOT NULL,
  "content_type" varchar(120) NOT NULL,
  "size_bytes" integer NOT NULL,
  "sha256" varchar(64) NOT NULL,
  "content_enc" bytea NOT NULL,
  "uploaded_by" text,
  "uploaded_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_project_files_name" ON "project_files" ("project_id", "name");
