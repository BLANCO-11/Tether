-- Sharing boundaries phase 4 (plans/sharing-boundaries-2026-10-30, P3-I1): a person with more than one connection of
-- their own to a service says which one their runs use — asked once, remembered per (workspace, person, service).
-- Used when a workflow runs on EACH PERSON's own account; never a fall-back: a choice that is no longer theirs is asked
-- again.
CREATE TABLE IF NOT EXISTS "person_account_choices" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "subject" text NOT NULL,
  "piece" text NOT NULL,
  "connection_id" uuid NOT NULL,
  "chosen_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("workspace_id", "subject", "piece")
);
