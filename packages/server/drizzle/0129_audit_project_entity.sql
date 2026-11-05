-- Sharing boundaries phase 5: a project's changes (created, members, instructions, deleted) are audited as "project".
ALTER TABLE "audit_events" DROP CONSTRAINT IF EXISTS "audit_events_entity_check";
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_entity_check" CHECK ("entity" IN (
  'workflow','version','resource','run','incident','approval','policy','datasource','tool','trigger','secret','member',
  'flow','execution','template','chat','plugin','connection','project'
));
