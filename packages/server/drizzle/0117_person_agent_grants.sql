-- Actions of a connected service a PERSON switched on for themselves in Forge Agent (pi-builder/agent-grants.ts), kept
-- per (workspace, person) so every Forge Agent chat of theirs in that workspace can use them — asked once, not per chat.
-- No automation gains one, and nobody else does: it is keyed on the person's identity subject.
-- `via`: whose connection it runs through — the person's own ("only for me"), or the workspace's (an Admin only). A
-- `personal` grant never falls back to the workspace's connection.
CREATE TABLE IF NOT EXISTS "plugin_person_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "subject" varchar(320) NOT NULL,
  "piece" text NOT NULL,
  "action" text NOT NULL,
  "via" varchar(16) NOT NULL CHECK ("via" IN ('personal', 'workspace')),
  "granted_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_plugin_person_grants" ON "plugin_person_grants" ("workspace_id", "subject", "piece", "action");
--> statement-breakpoint
-- The chat-only grants (0110) become the granter's own, so nothing anybody switched on is lost.
INSERT INTO "plugin_person_grants" ("workspace_id", "subject", "piece", "action", "via", "granted_by", "created_at")
SELECT DISTINCT ON (c."workspace_id", g->>'grantedBySubject', g->>'piece', g->>'action')
  c."workspace_id", g->>'grantedBySubject', g->>'piece', g->>'action',
  CASE WHEN g->>'via' = 'personal' THEN 'personal' ELSE 'workspace' END,
  COALESCE(g->>'grantedBy', g->>'grantedBySubject'),
  COALESCE(NULLIF(g->>'at', '')::timestamptz, now())
FROM "pi_chats" c, jsonb_array_elements(c."agent_grants") g
WHERE coalesce(g->>'grantedBySubject', '') <> '' AND coalesce(g->>'piece', '') <> '' AND coalesce(g->>'action', '') <> ''
ORDER BY c."workspace_id", g->>'grantedBySubject', g->>'piece', g->>'action', (g->>'at') DESC
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- One place an action is on for a person; the per-chat list is read by nothing now.
ALTER TABLE "pi_chats" DROP COLUMN IF EXISTS "agent_grants";
