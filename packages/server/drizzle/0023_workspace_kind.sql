-- Mark a workspace that exists to serve a harness, so the UI can say so.
--
-- `HR (alt — swap rehearsal)` is provisioned by `demo:seed-alt` and is required
-- by `demo:rehearse` — it must not be deleted. But it is not a tenant, and
-- listed beside HR and Finance it reads as one.
--
-- A column, not a name prefix: a display name is text somebody will edit, and
-- "is this a real workspace?" must not depend on how it is spelled.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "kind" varchar(32);
--> statement-breakpoint

UPDATE "workspaces" SET "kind" = 'fixture' WHERE "name" LIKE 'HR (alt%';
