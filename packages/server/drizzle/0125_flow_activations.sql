-- Sharing boundaries phase 3 (plans/sharing-boundaries-2026-10-30, D4): "Turn on for me". A workflow shared with the
-- workspace that runs on EACH PERSON's own account has no single schedule: each person who turns it on gets their own,
-- on the APPROVED revision they confirmed. A newer approved revision pauses their copy until they look again
-- (`confirmed_revision` < the workflow's armed revision) — nothing runs on a version they have not seen.
CREATE TABLE IF NOT EXISTS "flow_activations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "flow_id" uuid NOT NULL REFERENCES "flows"("id") ON DELETE CASCADE,
  "subject" text NOT NULL,
  "actor" text NOT NULL,
  "confirmed_revision" integer NOT NULL,
  "cron" text,
  "timezone" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_flow_activations_person" ON "flow_activations" ("flow_id", "subject");
