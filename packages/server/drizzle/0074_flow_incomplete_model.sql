-- compiled-builder phase 3 (D-319): a flow's incomplete working copy, holes included. Never a revision.
ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "incomplete_model" jsonb;
