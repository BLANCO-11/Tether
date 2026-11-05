-- Files a running step saved (an Excel report it built) so a tool call carries them by id. Swept after a day.
CREATE TABLE IF NOT EXISTS "step_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "flow_execution_id" uuid NOT NULL,
  "step_id" varchar(200),
  "name" varchar(255) NOT NULL,
  "size_bytes" integer NOT NULL,
  "content_enc" bytea NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_step_files_execution" ON "step_files" ("flow_execution_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_step_files_created" ON "step_files" ("created_at");
