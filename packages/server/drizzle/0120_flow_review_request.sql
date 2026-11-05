-- Sharing boundaries phase 1 (plans/sharing-boundaries-2026-10-30): reviewers judge whether a workflow is valid, and see
-- a PRIVATE one only when its owner asks them to (or once it is live). The owner's ask names the revision to review;
-- approving any revision answers it; the owner may withdraw it.
ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "review_requested_revision" integer;--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "review_requested_by" text;--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "review_requested_at" timestamp with time zone;
