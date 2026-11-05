-- Personal thin: bind an edge job to the Forge chat that started it so the
-- Background watcher can list it and post the result without Forge polling.
ALTER TABLE "edge_jobs" ADD COLUMN IF NOT EXISTS "session_id" text;
CREATE INDEX IF NOT EXISTS "ix_edge_jobs_session" ON "edge_jobs" ("workspace_id", "session_id") WHERE "session_id" IS NOT NULL;
