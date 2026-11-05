-- Custom workspace roles — a named set of permissions, scoped to ONE workspace.
--
-- Three tables: the role, what it carries, and who holds it. They are separate
-- because they answer three different questions and change at three different
-- rates; a single table with an array column cannot express "this permission was
-- added to this role by this person at this time", which FR-033 requires.
--
-- ⚠ **RETIRING IS A TIMESTAMP, NEVER A DELETE** (INV-7). A deleted role leaves
-- audit entries referencing a name nobody can look up, and FR-033 forbids editing
-- the audit to repair that. The partial unique index is therefore on live rows
-- only, so a retired "Finance Reviewer" does not block a new one.
--
-- ⚠ **INV-8 IS A CHECK, NOT A SERVICE VALIDATION.** A workspace role carrying a
-- `platform.*` permission is privilege escalation by role authoring. The service
-- also refuses it, but a service is one refactor away from forgetting to look and
-- the database is not. The list below is GENERATED from
-- `src/auth/permissions.ts` by `permissionCheckSql(column, "workspace")`, and
-- `permissions.test.ts` regenerates it and compares — so adding a permission
-- without touching this constraint fails a test in one second rather than
-- failing a row insert in production six weeks later.

CREATE TABLE IF NOT EXISTS "workspace_roles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "retired_at" timestamp with time zone
);
--> statement-breakpoint

-- Two live roles with the same name in one workspace are two answers to "what
-- does Finance Reviewer mean". Case-insensitive, and scoped to live rows only.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workspace_roles_name_live"
  ON "workspace_roles" ("workspace_id", lower("name"))
  WHERE "retired_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_roles_workspace"
  ON "workspace_roles" ("workspace_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "workspace_role_permissions" (
  "role_id" uuid NOT NULL REFERENCES "workspace_roles"("id") ON DELETE CASCADE,
  "permission" text NOT NULL,
  "granted_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workspace_role_permissions_pk" PRIMARY KEY ("role_id", "permission"),
  -- INV-8 + INV-2. Generated from the catalogue; workspace tier only.
  CONSTRAINT "workspace_role_permissions_in_catalogue" CHECK (
  permission IN (
    'flows.read', 'flows.write', 'flows.run', 'flows.approve', 'flows.arm', 'runs.read',
    'runs.replay', 'approvals.read', 'approvals.decide', 'datasources.read',
    'datasources.write', 'datasources.query.write', 'tools.read', 'tools.write',
    'secrets.read', 'secrets.write', 'catalogue.read', 'catalogue.write', 'templates.read',
    'templates.write', 'resources.read', 'audit.read', 'members.read', 'members.grant',
    'roles.write', 'incidents.read', 'incidents.write', 'gates.read', 'gates.write',
    'budget.read', 'budget.write', 'breakglass.read', 'breakglass.activate', 'realdata.use',
    'search.read', 'bootstrap.read', 'scenarios.read', 'steps.try'
  )
  )
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "workspace_role_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "subject" text NOT NULL,
  "role_id" uuid NOT NULL REFERENCES "workspace_roles"("id") ON DELETE CASCADE,
  "granted_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workspace_role_assignments_unique"
  ON "workspace_role_assignments" ("workspace_id", "subject", "role_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_role_assignments_subject"
  ON "workspace_role_assignments" ("workspace_id", "subject");
