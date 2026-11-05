-- docs/GAPS.md §1.1b — gate 3 has nobody to compare a decider against.
--
-- Gate 2 refuses self-approval because a revision records an AUTHOR. An
-- execution recorded nobody: it was started by a schedule, a trigger or a test
-- run, and "who asked for this run" was not a thing the system knew. So gate 3's
-- role check was the whole control, with no second layer behind it.
--
-- ⚠ **The requester does NOT travel to Kestra.** The engine gets a uuid pointing
-- at a row here — the same shape `foundry_trigger_fire` already uses, and for a
-- sharper reason: a label is stored in Kestra's database and rendered in
-- `kestra-ui`, so putting an email or an identity subject in one would push
-- person-data into a system that has no tenant isolation and is documented as
-- internal-engineers-only. `begin` resolves the pointer and verifies the
-- workspace, so a stale or wrong id links nothing rather than linking across
-- tenants.

CREATE TABLE IF NOT EXISTS "flow_run_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "flow_id" uuid REFERENCES "flows"("id") ON DELETE SET NULL,

  -- The identity `sub`. What a self-decision refusal compares on, because an
  -- email can be reassigned — the same reason `workspace_members` is keyed on it.
  "subject" text,

  -- For display and for the refusal message. Never used to decide identity.
  "actor" text NOT NULL,

  -- user | replay | trigger | system.
  --
  -- `schedule` is deliberately ABSENT: a scheduled execution is started by Kestra
  -- from the flow definition and never passes through a Foundry route, so it
  -- creates no row here at all and the execution's kind stays `schedule` by
  -- virtue of having no pointer. A value nothing can write would be an enum
  -- member that reads as reachable.
  "kind" text NOT NULL,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "flow_run_requests_kind_check"
    CHECK ("kind" IN ('user', 'replay', 'trigger', 'system'))
);

CREATE INDEX IF NOT EXISTS "flow_run_requests_workspace_idx"
  ON "flow_run_requests" ("workspace_id");

-- Copied ONTO the execution at `begin`, not read through the pointer later.
-- Same rule as `flow_executions.flow_revision` and `flow_step_runs.read_from`:
-- deriving it later would let a deleted or edited request row rewrite the
-- history of a run that already happened.
ALTER TABLE "flow_executions"
  ADD COLUMN IF NOT EXISTS "requested_by" text,
  ADD COLUMN IF NOT EXISTS "requested_by_subject" text,
  ADD COLUMN IF NOT EXISTS "requested_by_kind" varchar(16);

-- ⚠ Backfilled to `unknown`, never to `schedule` or `system`. 111 existing rows
-- were started by harnesses, browsers, triggers and schedules and nothing
-- recorded which — that absence IS the gap, and asserting one of them would be
-- inventing a fact. Same decision as migration 0026's `created_by_kind`.
UPDATE "flow_executions" SET "requested_by_kind" = 'unknown' WHERE "requested_by_kind" IS NULL;
