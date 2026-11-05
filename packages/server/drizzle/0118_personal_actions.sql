-- Personal connector actions (plans/personal-actions-2026-10-29): a member switches a connector's action on for
-- THEMSELVES — usable in their own Forge chats and in workflows they own, always through their own connection, never
-- the workspace's. `action` is the piece's action name, or `call_<hash>` for a declared call.
CREATE TABLE IF NOT EXISTS "plugin_personal_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "subject" text NOT NULL,
  "piece" text NOT NULL,
  "action" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_plugin_personal_actions_one" ON "plugin_personal_actions" ("workspace_id", "subject", "piece", "action");
--> statement-breakpoint
-- Whether members may switch a connector's actions on for themselves here. No row = allowed (the default an admin can
-- turn off); a row keeps who decided.
CREATE TABLE IF NOT EXISTS "plugin_personal_policy" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "piece" text NOT NULL,
  "allowed" boolean NOT NULL,
  "updated_by" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("workspace_id", "piece")
);
--> statement-breakpoint
-- One "for me" store (2026-10-29): 0117 kept a person's chat-switched actions in `plugin_person_grants`; they are the
-- same thing as these, so the personal ones move here. One switched on through the WORKSPACE's connection does not
-- move — a personal action never runs through the workspace's credentials; that person asks for it workspace-wide.
INSERT INTO "plugin_personal_actions" ("workspace_id", "subject", "piece", "action", "created_at")
SELECT "workspace_id", "subject", "piece", "action", "created_at" FROM "plugin_person_grants" WHERE "via" = 'personal'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DROP TABLE IF EXISTS "plugin_person_grants";
