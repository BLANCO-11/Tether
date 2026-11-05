-- Plugins (plans/plugins-2026-10-27, phases 1 and 3): connectors installed for the deployment, and each workspace's
-- connections to them.
--
-- 1. `plugin_installs` — the deployment's installed pieces. The connector's own manifest is the RUNTIME copy; this is
--    the record of who installed what, at which version and integrity, and which hosts it was approved to reach.
-- 2. `plugin_connections` — one connection of one workspace to one piece. The VALUE lives encrypted in
--    `workspace_secrets` under `secret_name` (the same store every tool credential uses, so a plugin tool reads its
--    connection the way any tool reads its key); this row holds only names, never a value.
-- 3. Three permissions join the catalogue (`plugins.read`, `plugins.enable`, `platform.plugins.install`), so the
--    three CHECKs that hold a permission are regenerated from `src/auth/permissions.ts` (INV-2), and the built-in
--    platform administrator gains the install permission.
-- 4. `plugin` and `connection` join the audit entity vocabulary.

CREATE TABLE IF NOT EXISTS "plugin_installs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "piece" text NOT NULL,
  "version" text NOT NULL,
  "integrity" text NOT NULL,
  "license" text,
  "display_name" text NOT NULL,
  "logo_url" text,
  "hosts" text[] DEFAULT '{}'::text[] NOT NULL,
  "installed_by" text NOT NULL,
  "installed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "plugin_installs_piece_shape" CHECK ("piece" ~ '^@activepieces/piece-[a-z0-9][a-z0-9-]*$'),
  CONSTRAINT "plugin_installs_version_exact" CHECK ("version" ~ '^\d+\.\d+\.\d+$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_plugin_installs_piece" ON "plugin_installs" ("piece");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "plugin_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "piece" text NOT NULL,
  "label" text NOT NULL,
  "auth_type" text NOT NULL,
  "secret_name" text NOT NULL,
  "field_names" text[] DEFAULT '{}'::text[] NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_tested_at" timestamp with time zone,
  "last_test_ok" boolean,
  "last_test_message" text,
  CONSTRAINT "plugin_connections_auth_type" CHECK ("auth_type" IN ('SECRET_TEXT', 'BASIC_AUTH', 'CUSTOM_AUTH', 'OAUTH2', 'NONE'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_plugin_connections_label" ON "plugin_connections" ("workspace_id", "piece", "label");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_plugin_connections_secret" ON "plugin_connections" ("workspace_id", "secret_name");
--> statement-breakpoint

ALTER TABLE "workspace_role_permissions" DROP CONSTRAINT IF EXISTS "workspace_role_permissions_in_catalogue";
--> statement-breakpoint
ALTER TABLE "workspace_role_permissions"
  ADD CONSTRAINT "workspace_role_permissions_in_catalogue" CHECK (
  permission IN (
    'flows.read', 'flows.write', 'flows.run', 'flows.approve', 'flows.arm', 'runs.read',
    'runs.replay', 'approvals.read', 'approvals.decide', 'datasources.read',
    'datasources.write', 'datasources.query.write', 'tools.read', 'tools.write',
    'secrets.read', 'secrets.write', 'plugins.read', 'plugins.enable', 'catalogue.read',
    'catalogue.write', 'templates.read', 'templates.write', 'resources.read', 'audit.read',
    'members.read', 'content.read.others', 'members.grant', 'roles.write', 'incidents.read',
    'incidents.write', 'gates.read', 'gates.write', 'budget.read', 'budget.write',
    'breakglass.read', 'breakglass.activate', 'realdata.use', 'search.read', 'bootstrap.read',
    'scenarios.read', 'steps.try'
  )
  );
--> statement-breakpoint

ALTER TABLE "workspace_member_capabilities" DROP CONSTRAINT IF EXISTS "workspace_member_capabilities_in_catalogue";
--> statement-breakpoint
ALTER TABLE "workspace_member_capabilities"
  ADD CONSTRAINT "workspace_member_capabilities_in_catalogue" CHECK (
  capability IN (
    'flows.read', 'flows.write', 'flows.run', 'flows.approve', 'flows.arm', 'runs.read',
    'runs.replay', 'approvals.read', 'approvals.decide', 'datasources.read',
    'datasources.write', 'datasources.query.write', 'tools.read', 'tools.write',
    'secrets.read', 'secrets.write', 'plugins.read', 'plugins.enable', 'catalogue.read',
    'catalogue.write', 'templates.read', 'templates.write', 'resources.read', 'audit.read',
    'members.read', 'content.read.others', 'members.grant', 'roles.write', 'incidents.read',
    'incidents.write', 'gates.read', 'gates.write', 'budget.read', 'budget.write',
    'breakglass.read', 'breakglass.activate', 'realdata.use', 'search.read', 'bootstrap.read',
    'scenarios.read', 'steps.try'
  )
  );
--> statement-breakpoint

ALTER TABLE "platform_roles" DROP CONSTRAINT IF EXISTS "platform_roles_permissions_in_catalogue";
--> statement-breakpoint
ALTER TABLE "platform_roles"
  ADD CONSTRAINT "platform_roles_permissions_in_catalogue" CHECK (
    "permissions" <@ ARRAY[
      'platform.workspaces.write', 'platform.members.grant', 'platform.users.read',
      'platform.roles.write', 'platform.generation.write', 'platform.audit.read',
      'platform.localusers.write', 'platform.ops.read', 'platform.toolmodel.read',
      'platform.toolmodel.write', 'platform.plugins.install', 'platform.signals.read'
    ]::text[]
  );
--> statement-breakpoint

UPDATE "platform_roles"
   SET "permissions" = (SELECT array_agg(DISTINCT p ORDER BY p) FROM unnest("permissions" || ARRAY['platform.plugins.install']::text[]) AS p),
       "updated_at" = now()
 WHERE "key" = 'platform-admin' AND NOT ('platform.plugins.install' = ANY("permissions"));
--> statement-breakpoint

ALTER TABLE "audit_events" DROP CONSTRAINT IF EXISTS "audit_events_entity_check";
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_entity_check" CHECK ("entity" IN (
  'workflow','version','resource','run','incident','approval','policy','datasource','tool','trigger','secret','member',
  'flow','execution','template','chat','plugin','connection'
));
