-- Sharing boundaries phase 1 (plans/sharing-boundaries-2026-10-30, P1-I5 answered "A"): a chat may be shared with the
-- workspace TO READ. `private` — its owner (and Admins); `public` — every member reads the conversation, and only its
-- owner (or an Admin) continues, renames or deletes it.
ALTER TABLE "pi_chats" ADD COLUMN IF NOT EXISTS "visibility" varchar(16) DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "pi_chats" DROP CONSTRAINT IF EXISTS "pi_chats_visibility_check";--> statement-breakpoint
ALTER TABLE "pi_chats" ADD CONSTRAINT "pi_chats_visibility_check" CHECK ("visibility" IN ('private', 'public'));
