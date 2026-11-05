-- Web access (2026-10-30, plans/builtin-tools-2026-10-30): the built-in `web_fetch` tool reads public web addresses.
-- On for every workspace; its admins may switch it off. Private, internal and metadata addresses are always refused.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "web_access" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
-- Every fetch, by a workflow step (execution_id) or by Forge while building (session_id). The address is stored with
-- credential-shaped query values redacted. Refusals are recorded too (ok = false, error says why).
CREATE TABLE IF NOT EXISTS "web_fetches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "execution_id" uuid,
  "step_id" varchar(255),
  "session_id" varchar(64),
  "actor" varchar(255),
  "url" text NOT NULL,
  "final_url" text,
  "status" integer,
  "content_type" varchar(255),
  "bytes" integer,
  "duration_ms" integer,
  "ok" boolean NOT NULL,
  "error" text,
  "at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_web_fetches_ws_at" ON "web_fetches" ("workspace_id", "at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_web_fetches_execution" ON "web_fetches" ("execution_id");
