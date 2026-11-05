-- B-12: flow_step_flags — persisted builder flags the readiness sheet resolves (S-10, S-13, law 6).
-- Six flags on flagship draft: restricted, assumption, low-confidence, missing-input ×2, unresolved-decision
-- plus draft-level "No successful test run" (step_number NULL, blocking).
CREATE TABLE IF NOT EXISTS "flow_step_flags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "flow_revision_id" uuid NOT NULL REFERENCES "flow_revisions"("id") ON DELETE CASCADE,
  "step_number" integer,
  "kind" text NOT NULL CHECK ("kind" IN ('restricted','assumption','low-confidence','missing-input','unresolved-decision')),
  "title" text NOT NULL,
  "consequence" text NOT NULL,
  "blocking" boolean NOT NULL,
  "options" jsonb,
  "status" text NOT NULL DEFAULT 'open' CHECK ("status" IN ('open','resolved','deferred')),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_flow_step_flags_revision_step_kind" ON "flow_step_flags" ("flow_revision_id","step_number","kind");
CREATE INDEX IF NOT EXISTS "idx_flow_step_flags_revision" ON "flow_step_flags" ("flow_revision_id");
CREATE INDEX IF NOT EXISTS "idx_flow_step_flags_status" ON "flow_step_flags" ("flow_revision_id","status");
