-- Admin simplify phase 2: invite a person by email, with their workspaces and roles (and optionally a platform role)
-- chosen in advance. At the person's first sign-in every entry becomes real before the first page loads.
-- Matching is by email, which is sound only because sign-in accepts one Entra tenant (auth.ts ALLOWED_TENANT_ID).
CREATE TABLE IF NOT EXISTS "person_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" text NOT NULL CHECK ("email" = lower("email")),
  "platform_role_key" varchar(64),
  "invited_by" text NOT NULL,
  "invited_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "accepted_subject" text,
  "revoked_at" timestamp with time zone,
  "revoked_by" text
);
--> statement-breakpoint
-- One open invitation per email: a second invite for the same person adds to it.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_person_invitations_open" ON "person_invitations" ("email")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "person_invitation_workspaces" (
  "invitation_id" uuid NOT NULL REFERENCES "person_invitations"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "role" varchar(16) NOT NULL CHECK ("role" IN ('viewer','author','approver','admin')),
  "added_by" text NOT NULL,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("invitation_id", "workspace_id")
);
