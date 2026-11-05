-- Plugins phase 9 (plans/plugins-2026-10-27): who sees an automation is separate from who switches it on.
-- An automation is private or public, chosen by its owner. Before this, approving one published it, so every
-- automation that was ever approved is public.
ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "visibility" varchar(16) DEFAULT 'private' NOT NULL;
--> statement-breakpoint
UPDATE "flows" SET "visibility" = 'public' WHERE "armed_revision" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "flows" DROP CONSTRAINT IF EXISTS "flows_visibility_check";
--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_visibility_check" CHECK ("visibility" IN ('private', 'public'));
--> statement-breakpoint
-- An approval row written by the automation's own owner, with no reviewer, because it uses only their own things.
ALTER TABLE "flow_approvals" ADD COLUMN IF NOT EXISTS "self_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Members may switch on their own private automations that use only their own things. On by default.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "self_enable" boolean DEFAULT true NOT NULL;
