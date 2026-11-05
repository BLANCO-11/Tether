-- Plugins, phase 4 (plans/plugins-2026-10-27): connecting a service by signing in (OAuth).
--
-- 1. `plugin_oauth_apps` — per connector, the OAuth client Foundry signs in WITH: a client id and an encrypted secret
--    entered by a platform administrator, OR Foundry's own sign-in app (Microsoft Entra, decision 3), and the scopes it
--    asks for — narrowable below the connector's own list (decision 6), never widened.
-- 2. `plugin_oauth_states` — a sign-in that has started and not come back yet: which workspace, connector, person and
--    label it is for, and the PKCE verifier (encrypted). Single use, ten minutes; only a hash of the `state` is kept.
-- 3. `plugin_connections.owner_subject` — a connection owned by ONE person ("as me", for Forge Agent's confirmed
--    actions). NULL is the workspace's. A person's connection is never used by an automation.
-- 4. `plugin.oauth_app` joins the platform audit actions.

CREATE TABLE IF NOT EXISTS "plugin_oauth_apps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "piece" text NOT NULL,
  "use_sign_in_app" boolean DEFAULT false NOT NULL,
  "client_id" text,
  "client_secret_enc" text,
  "scopes" text[] DEFAULT '{}'::text[] NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "plugin_oauth_apps_piece_shape" CHECK ("piece" ~ '^@activepieces/piece-[a-z0-9][a-z0-9-]*$'),
  CONSTRAINT "plugin_oauth_apps_client" CHECK ("use_sign_in_app" OR ("client_id" IS NOT NULL AND "client_id" <> ''))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_plugin_oauth_apps_piece" ON "plugin_oauth_apps" ("piece");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "plugin_oauth_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "state_hash" text NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "piece" text NOT NULL,
  "label" text NOT NULL,
  "connection_id" uuid,
  "owner_subject" text,
  "subject" text NOT NULL,
  "subject_email" text,
  "code_verifier_enc" text,
  "props_enc" text,
  "redirect_uri" text NOT NULL,
  "scopes" text[] DEFAULT '{}'::text[] NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_plugin_oauth_states_hash" ON "plugin_oauth_states" ("state_hash");
--> statement-breakpoint

ALTER TABLE "plugin_connections" ADD COLUMN IF NOT EXISTS "owner_subject" text;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_plugin_connections_label";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_plugin_connections_label" ON "plugin_connections" ("workspace_id", "piece", COALESCE("owner_subject", ''), "label");
--> statement-breakpoint

ALTER TABLE "platform_audit_events" DROP CONSTRAINT IF EXISTS "platform_audit_events_action_known";
--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_action_known" CHECK (
  "action" IN ('grant', 'revoke', 'role.create', 'role.update', 'role.retire', 'deny',
               'plugin.install', 'plugin.upgrade', 'plugin.uninstall', 'plugin.hosts', 'plugin.oauth_app')
);
