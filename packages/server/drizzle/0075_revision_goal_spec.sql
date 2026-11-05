-- compiled-builder phase 4 (D-304): the confirmed GoalSpec and the build trace, stored with the revision they produced.
-- Nullable: every writer other than the new builder leaves them NULL. Not part of any hash or fingerprint.
ALTER TABLE "flow_revisions" ADD COLUMN IF NOT EXISTS "goal_spec" jsonb;
ALTER TABLE "flow_revisions" ADD COLUMN IF NOT EXISTS "build_trace" jsonb;
