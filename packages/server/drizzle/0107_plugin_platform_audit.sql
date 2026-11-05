-- Plugins: installing, upgrading, uninstalling a connector and approving its hosts are deployment-wide acts, so they
-- are recorded in the platform audit record. Its two vocabularies grow by those actions and the `plugin` entity.
ALTER TABLE "platform_audit_events" DROP CONSTRAINT IF EXISTS "platform_audit_events_action_known";
--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_action_known" CHECK (
  "action" IN ('grant', 'revoke', 'role.create', 'role.update', 'role.retire', 'deny',
               'plugin.install', 'plugin.upgrade', 'plugin.uninstall', 'plugin.hosts')
);
--> statement-breakpoint
ALTER TABLE "platform_audit_events" DROP CONSTRAINT IF EXISTS "platform_audit_events_entity_known";
--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_entity_known" CHECK (
  "entity" IN ('platform_role', 'workspace_role', 'member', 'permission', 'plugin')
);
