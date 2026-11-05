-- A SQLite datasource: the uploaded database file, encrypted at rest. See `datasourceFiles` in schema.ts.
CREATE TABLE IF NOT EXISTS "datasource_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "datasource_id" uuid REFERENCES "datasources"("id") ON DELETE CASCADE,
  "kind" varchar(16) DEFAULT 'sqlite' NOT NULL,
  "filename" varchar(255),
  "size_bytes" integer NOT NULL,
  "sha256" varchar(64) NOT NULL,
  "content_enc" bytea NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "datasource_files_kind_check" CHECK ("kind" IN ('sqlite')),
  CONSTRAINT "datasource_files_size_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 16777216)
);
CREATE INDEX IF NOT EXISTS "idx_datasource_files_workspace" ON "datasource_files" ("workspace_id");
CREATE INDEX IF NOT EXISTS "idx_datasource_files_datasource" ON "datasource_files" ("datasource_id");
