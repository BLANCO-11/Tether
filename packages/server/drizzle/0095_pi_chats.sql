-- Saved chats (2026-10-12): every Forge conversation is its own record from the person's first message, whether or
-- not it ever builds a workflow. Visible to the whole workspace, kept until someone deletes it; a workflow it built is
-- linked (and the chat outlives the workflow). Replaces pi_flow_chats, which kept a chat only once it had a workflow.
CREATE TABLE IF NOT EXISTS "pi_chats" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "flow_id" uuid REFERENCES "flows"("id") ON DELETE SET NULL,
  "title" varchar(200) NOT NULL,
  "goal" text NOT NULL DEFAULT '',
  "created_by_subject" varchar(320),
  "created_by_name" varchar(320),
  "messages" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "forge_session" text,
  "draft_bundle" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_pi_chats_workspace" ON "pi_chats" ("workspace_id", "updated_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_pi_chats_flow" ON "pi_chats" ("flow_id");
--> statement-breakpoint
-- A chat's files: what the person attached (and, later, what Forge made), encrypted like workspace Files.
CREATE TABLE IF NOT EXISTS "pi_chat_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "chat_id" uuid NOT NULL REFERENCES "pi_chats"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL,
  "name" varchar(255) NOT NULL,
  "content_type" varchar(120) NOT NULL,
  "size_bytes" integer NOT NULL CHECK ("size_bytes" > 0 AND "size_bytes" <= 52428800),
  "content_enc" bytea NOT NULL,
  "origin" varchar(16) NOT NULL DEFAULT 'person' CHECK ("origin" IN ('person', 'forge')),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_pi_chat_files_name" ON "pi_chat_files" ("chat_id", "name");
--> statement-breakpoint
-- Every workflow's conversation moves over as one chat. Its title is the person's first message (the flow's name when
-- there is none), its author whoever sent that message.
INSERT INTO "pi_chats" ("workspace_id", "flow_id", "title", "goal", "created_by_subject", "created_by_name", "messages", "forge_session", "created_at", "updated_at")
SELECT
  f."workspace_id",
  c."flow_id",
  left(coalesce(
    nullif(btrim(regexp_replace((SELECT m->>'text' FROM jsonb_array_elements(c."messages") m WHERE m->>'role' = 'user' LIMIT 1), '\s+', ' ', 'g')), ''),
    nullif(btrim(f."name"), ''),
    'Untitled chat'), 80),
  coalesce(f."description", ''),
  (SELECT m->'by'->>'subject' FROM jsonb_array_elements(c."messages") m WHERE m->>'role' = 'user' LIMIT 1),
  (SELECT m->'by'->>'name' FROM jsonb_array_elements(c."messages") m WHERE m->>'role' = 'user' LIMIT 1),
  c."messages",
  c."forge_session",
  coalesce((SELECT (m->>'at')::timestamptz FROM jsonb_array_elements(c."messages") m LIMIT 1), c."updated_at"),
  c."updated_at"
FROM "pi_flow_chats" c
JOIN "flows" f ON f."id" = c."flow_id"
WHERE jsonb_array_length(c."messages") > 0 OR c."forge_session" IS NOT NULL;
--> statement-breakpoint
DROP TABLE IF EXISTS "pi_flow_chats";
