-- Per-user edge allow/deny + directory grants (personal thin).
CREATE TABLE IF NOT EXISTS "edge_trust_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "owner_subject" text NOT NULL,
  "effect" varchar(16) NOT NULL,
  "scope" varchar(32) NOT NULL,
  "pattern" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_edge_trust_rules" ON "edge_trust_rules" ("workspace_id","owner_subject","effect","scope","pattern");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_edge_trust_rules_owner" ON "edge_trust_rules" ("workspace_id","owner_subject");
