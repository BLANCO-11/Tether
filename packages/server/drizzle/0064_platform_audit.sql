-- The platform-tier audit record.
--
-- ⚠ **A SECOND STORE, AND THAT MUST NEVER BE READER-VISIBLE** (INV-17).
-- Workspace-scoped access events go to `audit_events` with `operation: "access"`
-- and `entity: "member" | "policy"` — values that table ALREADY permits, which is
-- why no migration alters it (research M-2, and INV-16 wants it untouched).
-- Deployment-level events have no workspace to belong to, so they come here.
-- `GET /api/platform/audit` unions the two in one time order, because "which
-- table was it written to" is not a question a reader of an audit trail should
-- ever have to answer.
--
-- ⚠ **`before`/`after` CARRY THE GRANT, NEVER THE PROTECTED RESOURCE** (FR-034).
-- A denial entry records that somebody was refused `flows.read` on a workspace.
-- It records no part of the flow they were refused — an audit trail that leaks
-- the thing it is protecting is a second copy of the exposure, readable by
-- exactly the people a denial says should not see it.
--
-- ⚠ **`repeat_count` IS THE BOUND ON DENIAL RECORDING.** A refused caller in a
-- retry loop can write unboundedly many identical rows, and an audit store that
-- can be filled by an unauthenticated-ish caller is a denial-of-service on the
-- record itself. The first refusal is written immediately; identical repeats
-- within the window increment this instead. A restart loses a COUNT, never the
-- FACT — which is the right half to lose.

CREATE TABLE IF NOT EXISTS "platform_audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "time" timestamp with time zone DEFAULT now() NOT NULL,
  "actor" text NOT NULL,
  "actor_email" text,
  "action" text NOT NULL,
  "subject" text,
  "entity" text NOT NULL,
  "entity_id" text,
  "before" jsonb,
  "after" jsonb,
  "repeat_count" integer DEFAULT 1 NOT NULL,
  -- Added VALID over an empty table: this table is created in this same
  -- migration, so there are no rows to grandfather in (the 0038 precedent).
  CONSTRAINT "platform_audit_events_action_known" CHECK (
    "action" IN ('grant', 'revoke', 'role.create', 'role.update', 'role.retire', 'deny')
  ),
  CONSTRAINT "platform_audit_events_entity_known" CHECK (
    "entity" IN ('platform_role', 'workspace_role', 'member', 'permission')
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_platform_audit_events_time"
  ON "platform_audit_events" ("time");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_platform_audit_events_actor"
  ON "platform_audit_events" ("actor");
