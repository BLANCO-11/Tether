-- Identities that have presented a verified token to this API.
--
-- ⚠ NOT a user directory and deliberately not called `users`. A row means
-- "this subject made at least one request carrying an identity token that
-- verified against RUNTIME_JWT_SECRET" — nothing about accounts, entitlement or
-- whether the person is who the token says (I-13: anything holding the signing
-- secret mints any identity). It exists so a super admin can assign somebody to
-- a workspace by picking them, instead of transcribing an opaque subject by hand.
--
-- ⚠ NOTHING IS BACKFILLED, and there is no source to backfill from. Sign-ins
-- were only ever a stdout log line in the Next process. An invented row would
-- be a person this deployment never saw, which is the failure mode the whole
-- product's honesty rules exist to prevent.
CREATE TABLE IF NOT EXISTS "platform_users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- The JWT `sub`. The key, for the same reason `workspace_members.subject` is:
  -- an email can be reassigned, and a person changing theirs must not become a
  -- second row (nor inherit the previous holder's assignments).
  "subject" text NOT NULL,
  "email" text NOT NULL,
  "name" text,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- One row per subject: the upsert's conflict target, so it has to be UNIQUE
-- rather than merely indexed.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_platform_users_subject" ON "platform_users" ("subject");
-- The list is ordered by it.
CREATE INDEX IF NOT EXISTS "idx_platform_users_last_seen" ON "platform_users" ("last_seen_at");
