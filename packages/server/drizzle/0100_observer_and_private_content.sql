-- rbac-observability (2026-10-15): the Observer role, one new permission, and one platform read-only role.
--
-- 1. `workspace_members.role` gains `viewer` (shown as Observer — read-only: the published automations, their live
--    runs, who is here).
-- 2. The catalogue gains `content.read.others` ("See everyone's private work"), so the two CHECKs that hold a
--    workspace permission are regenerated from `src/auth/permissions.ts` (INV-2). The platform list is unchanged.
-- 3. The built-in `support` platform role is merged into `auditor`: one read-only platform profile. The auditor
--    takes support's four reads, every support holder becomes an auditor, and `support` is removed.

ALTER TABLE "workspace_members" DROP CONSTRAINT IF EXISTS "workspace_members_role_check";
--> statement-breakpoint
ALTER TABLE "workspace_members"
  ADD CONSTRAINT "workspace_members_role_check" CHECK (role IN ('viewer', 'author', 'approver', 'admin'));
--> statement-breakpoint

ALTER TABLE "workspace_role_permissions" DROP CONSTRAINT IF EXISTS "workspace_role_permissions_in_catalogue";
--> statement-breakpoint
ALTER TABLE "workspace_role_permissions"
  ADD CONSTRAINT "workspace_role_permissions_in_catalogue" CHECK (
  permission IN (
    'flows.read', 'flows.write', 'flows.run', 'flows.approve', 'flows.arm', 'runs.read',
    'runs.replay', 'approvals.read', 'approvals.decide', 'datasources.read',
    'datasources.write', 'datasources.query.write', 'tools.read', 'tools.write',
    'secrets.read', 'secrets.write', 'catalogue.read', 'catalogue.write', 'templates.read',
    'templates.write', 'resources.read', 'audit.read', 'members.read', 'content.read.others',
    'members.grant', 'roles.write', 'incidents.read', 'incidents.write', 'gates.read',
    'gates.write', 'budget.read', 'budget.write', 'breakglass.read', 'breakglass.activate',
    'realdata.use', 'search.read', 'bootstrap.read', 'scenarios.read', 'steps.try'
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
    'secrets.read', 'secrets.write', 'catalogue.read', 'catalogue.write', 'templates.read',
    'templates.write', 'resources.read', 'audit.read', 'members.read', 'content.read.others',
    'members.grant', 'roles.write', 'incidents.read', 'incidents.write', 'gates.read',
    'gates.write', 'budget.read', 'budget.write', 'breakglass.read', 'breakglass.activate',
    'realdata.use', 'search.read', 'bootstrap.read', 'scenarios.read', 'steps.try'
  )
  );
--> statement-breakpoint

UPDATE "platform_roles"
   SET "name" = 'Auditor',
       "description" = 'Read-only across the deployment: who exists, the audit record, the tool layer, system health and usage. Changes nothing, and sees no workspace content.',
       "permissions" = (
         SELECT array_agg(DISTINCT p ORDER BY p)
           FROM unnest("permissions" || ARRAY[
             'platform.users.read', 'platform.audit.read', 'platform.ops.read', 'platform.signals.read'
           ]::text[]) AS p
       ),
       "updated_at" = now()
 WHERE "key" = 'auditor';
--> statement-breakpoint

INSERT INTO "platform_role_assignments" ("subject", "email", "role_key", "granted_by")
SELECT a."subject", a."email", 'auditor', a."granted_by"
  FROM "platform_role_assignments" a
 WHERE a."role_key" = 'support'
   AND EXISTS (SELECT 1 FROM "platform_roles" WHERE "key" = 'auditor')
ON CONFLICT ("subject", "role_key") DO NOTHING;
--> statement-breakpoint

DELETE FROM "platform_roles" WHERE "key" = 'support' AND EXISTS (SELECT 1 FROM "platform_roles" WHERE "key" = 'auditor');
