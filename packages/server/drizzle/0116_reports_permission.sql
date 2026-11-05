-- Cost reports (2026-10-26; renumbered from 0107 to follow the connector migrations, which also extend this list): the catalogue gains `reports.read` ("Read cost reports", an Admin's), so the two CHECKs that
-- hold a workspace permission are regenerated from `src/auth/permissions.ts` (INV-2). The platform list is unchanged.
-- Admin holds it through the preset (code), so no role row needs a backfill.

ALTER TABLE "workspace_role_permissions" DROP CONSTRAINT IF EXISTS "workspace_role_permissions_in_catalogue";
--> statement-breakpoint
ALTER TABLE "workspace_role_permissions"
  ADD CONSTRAINT "workspace_role_permissions_in_catalogue" CHECK (
  permission IN (
    'flows.read', 'flows.write', 'flows.run', 'flows.approve', 'flows.arm', 'runs.read', 'runs.replay',
    'reports.read', 'approvals.read', 'approvals.decide', 'datasources.read', 'datasources.write',
    'datasources.query.write', 'tools.read', 'tools.write', 'secrets.read', 'secrets.write', 'plugins.read',
    'plugins.enable', 'catalogue.read', 'catalogue.write', 'templates.read', 'templates.write', 'resources.read',
    'audit.read', 'members.read', 'content.read.others', 'members.grant', 'roles.write', 'incidents.read',
    'incidents.write', 'gates.read', 'gates.write', 'budget.read', 'budget.write', 'breakglass.read',
    'breakglass.activate', 'realdata.use', 'search.read', 'bootstrap.read', 'scenarios.read', 'steps.try'
  )
  );
--> statement-breakpoint

ALTER TABLE "workspace_member_capabilities" DROP CONSTRAINT IF EXISTS "workspace_member_capabilities_in_catalogue";
--> statement-breakpoint
ALTER TABLE "workspace_member_capabilities"
  ADD CONSTRAINT "workspace_member_capabilities_in_catalogue" CHECK (
  capability IN (
    'flows.read', 'flows.write', 'flows.run', 'flows.approve', 'flows.arm', 'runs.read', 'runs.replay',
    'reports.read', 'approvals.read', 'approvals.decide', 'datasources.read', 'datasources.write',
    'datasources.query.write', 'tools.read', 'tools.write', 'secrets.read', 'secrets.write', 'plugins.read',
    'plugins.enable', 'catalogue.read', 'catalogue.write', 'templates.read', 'templates.write', 'resources.read',
    'audit.read', 'members.read', 'content.read.others', 'members.grant', 'roles.write', 'incidents.read',
    'incidents.write', 'gates.read', 'gates.write', 'budget.read', 'budget.write', 'breakglass.read',
    'breakglass.activate', 'realdata.use', 'search.read', 'bootstrap.read', 'scenarios.read', 'steps.try'
  )
  );
