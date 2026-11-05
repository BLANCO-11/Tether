-- rbac-observability (2026-10-15): an automation has an owner.
--
-- A draft is private to its owner (and to Admins); an approved automation is published to the whole workspace.
-- Backfill: the person whose Forge chat built it (the earliest chat linked to the flow). Nothing else records a
-- SUBJECT — `flow_revisions.created_by` is a name — so every other existing flow stays NULL: visible to Admins and
-- Reviewers, and to everyone once published, until an Admin assigns an owner.

ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "owner_subject" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flows_owner_subject" ON "flows" ("workspace_id", "owner_subject");
--> statement-breakpoint
UPDATE "flows" f
   SET "owner_subject" = c."created_by_subject"
  FROM (
    SELECT DISTINCT ON ("flow_id") "flow_id", "created_by_subject"
      FROM "pi_chats"
     WHERE "flow_id" IS NOT NULL AND "created_by_subject" IS NOT NULL
     ORDER BY "flow_id", "created_at"
  ) c
 WHERE f."id" = c."flow_id" AND f."owner_subject" IS NULL;
