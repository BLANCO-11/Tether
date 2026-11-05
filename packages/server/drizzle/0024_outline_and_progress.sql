ALTER TABLE "flow_generation_jobs" ADD COLUMN IF NOT EXISTS "outline_json" jsonb;--> statement-breakpoint
ALTER TABLE "flow_generation_jobs" ADD COLUMN IF NOT EXISTS "progress_json" jsonb;--> statement-breakpoint
-- `workspaces.kind` was added by 0023 (hand-written); drizzle-kit re-proposed it
-- because 0023's snapshot did not record it. IF NOT EXISTS makes this a no-op
-- against every database that has already run 0023, and correct against one
-- restored from a backup taken before it. 0024's snapshot IS complete, so the
-- drift ends here.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "kind" varchar(32);