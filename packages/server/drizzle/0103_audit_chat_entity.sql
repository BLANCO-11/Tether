-- rbac-observability (2026-10-15): an Admin opening somebody else's private chat is audited, so `chat` joins the
-- audit entity vocabulary (`AuditEntity` in services/audit.service.ts).
ALTER TABLE "audit_events" DROP CONSTRAINT IF EXISTS "audit_events_entity_check";
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_entity_check" CHECK ("entity" IN (
  'workflow','version','resource','run','incident','approval','policy','datasource','tool','trigger','secret','member',
  'flow','execution','template','chat'
));
