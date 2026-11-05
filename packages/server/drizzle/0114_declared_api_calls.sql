-- Declared API calls (plans/declared-api-calls-2026-10-29): a connector's raw call fixed in advance — method, path
-- template with typed blanks, fixed query, which inputs go in the body. Keyed by the HASH of what it does; the tool's
-- address carries the hash, so an edit is a new row and a new address. Rows are kept: an automation still pointing at
-- an old address fails by name, never silently runs a different call.
CREATE TABLE IF NOT EXISTS "plugin_declared_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "piece" text NOT NULL,
  "name" text NOT NULL,
  "display_name" text NOT NULL,
  "description" text NOT NULL,
  "declaration" jsonb NOT NULL,
  "hash" varchar(16) NOT NULL,
  "pack" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_plugin_declared_calls_hash" ON "plugin_declared_calls" ("workspace_id", "piece", "hash");
