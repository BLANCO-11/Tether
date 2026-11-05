-- Admin simplify phase 1: one person, one record. When two ids turn out to be one person, access and ownership move
-- to the current id and the old id is recorded here, so history written under it (audit, approvals, usage) still names
-- the person. Insert-only; a row is never rewritten.
CREATE TABLE IF NOT EXISTS "platform_user_aliases" (
  "old_subject" text PRIMARY KEY,
  "subject" text NOT NULL,
  "email" text,
  "reason" varchar(32) NOT NULL CHECK ("reason" IN ('email_was_id', 'admin_merge')),
  "merged_by" text,
  "merged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_platform_user_aliases_subject" ON "platform_user_aliases" ("subject");
