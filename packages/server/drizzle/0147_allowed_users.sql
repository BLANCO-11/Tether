-- Who may sign in to this Tether by email code: an allowlist of users, each with a role.
-- Emails are stored lower-cased (the CHECK enforces it).
CREATE TABLE IF NOT EXISTS "allowed_users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" varchar(320) NOT NULL,
  "role" varchar(16) DEFAULT 'user' NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" text,
  "last_login_at" timestamp with time zone,
  CONSTRAINT "allowed_users_role_check" CHECK ("role" IN ('admin','user')),
  CONSTRAINT "allowed_users_email_lower_check" CHECK ("email" = lower("email"))
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_allowed_users_email" ON "allowed_users" ("email");
