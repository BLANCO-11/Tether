-- The platform tier — roles ABOVE a workspace.
--
-- This replaces two things that were standing in for a platform tier and should
-- not have been: `requireDeploymentAdmin` (satisfied by being an admin in ANY
-- workspace — so one tenant's administrator could change a deployment-wide
-- setting) and `SUPER_ADMIN_EMAILS` being the only authority above a workspace,
-- which made every deployment-level act an all-or-nothing grant.
--
-- ⚠ **INV-13 — NO ROW HERE CAN CONFER SUPER ADMIN.** There is no
-- `platform.superadmin` permission in the catalogue and no code path from a row
-- in this table to `config.isSuperAdmin`, which reads the environment and
-- nothing else. The allowlist stays the un-grantable root. If somebody ever adds
-- a permission that resolves to it, this comment is the thing they are
-- contradicting.
--
-- ⚠ **INV-15 — `builtin = true` refuses edit and delete.** Same reasoning as the
-- presets: a built-in role somebody can edit is a built-in role that can be
-- edited into something nobody reviewed, on every deployment that ships it.
--
-- ⚠ **ONLY `platform.members.grant` CONFERS ANYTHING INTO A WORKSPACE**, and it
-- confers exactly `members.read` + `members.grant` — see
-- `src/auth/platform-conferral.ts` (spec D-9). So `auditor` and `support` hold
-- no key of that map and confer NOTHING: a holder of either sees no workspace and
-- reads no tenant data, which is what FR-021 and SC-010 require.

CREATE TABLE IF NOT EXISTS "platform_roles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "description" text,
  "permissions" text[] NOT NULL,
  "builtin" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- INV-2, platform tier only: every element must be a catalogue permission AND
  -- carry the `platform.` prefix. Generated from `src/auth/permissions.ts`.
  CONSTRAINT "platform_roles_permissions_in_catalogue" CHECK (
    "permissions" <@ ARRAY[
      'platform.workspaces.write', 'platform.members.grant', 'platform.users.read',
      'platform.roles.write', 'platform.generation.write', 'platform.audit.read',
      'platform.localusers.write', 'platform.ops.read', 'platform.toolmodel.read',
      'platform.toolmodel.write', 'platform.signals.read'
    ]::text[]
  )
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "platform_role_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject" text NOT NULL,
  "email" text NOT NULL,
  "role_key" text NOT NULL REFERENCES "platform_roles"("key") ON DELETE CASCADE,
  "granted_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_platform_role_assignments_unique"
  ON "platform_role_assignments" ("subject", "role_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_platform_role_assignments_subject"
  ON "platform_role_assignments" ("subject");
--> statement-breakpoint

-- The three built-in roles.
--
-- ⚠ `support` holds `platform.ops.read` and `platform.signals.read` because
-- reading the outbox and the four silent-failure signals is what a support role
-- is FOR; without them it can see who exists and nothing about whether the system
-- is working. It deliberately does NOT hold `platform.toolmodel.*` — support
-- reads, it does not change what the deployment generates or calls models with.
--
-- ON CONFLICT DO NOTHING so a re-run is a no-op rather than a duplicate-key
-- failure. It is NOT an upsert: overwriting a built-in role's permissions on
-- every migration run would silently undo a deliberate future change to this
-- migration's successor.
INSERT INTO "platform_roles" ("key", "name", "description", "permissions", "builtin")
VALUES
  (
    'platform-admin',
    'Platform administrator',
    'Runs the deployment. Can create workspaces and grant access in every one of them. Cannot read tenant data — but can grant themselves the ability to, and that grant is recorded.',
    ARRAY[
      'platform.workspaces.write', 'platform.members.grant', 'platform.users.read',
      'platform.roles.write', 'platform.generation.write', 'platform.localusers.write',
      'platform.audit.read', 'platform.ops.read', 'platform.toolmodel.read',
      'platform.toolmodel.write', 'platform.signals.read'
    ]::text[],
    true
  ),
  (
    'auditor',
    'Auditor',
    'Reads the audit record across every workspace, and nothing else. Sees no workspace and no tenant data.',
    ARRAY['platform.audit.read']::text[],
    true
  ),
  (
    'support',
    'Support',
    'Reads who exists, the audit record, the tool layer and the system signals. Changes nothing.',
    ARRAY[
      'platform.users.read', 'platform.audit.read', 'platform.ops.read',
      'platform.signals.read'
    ]::text[],
    true
  )
ON CONFLICT ("key") DO NOTHING;
