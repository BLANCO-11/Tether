-- B-19 · release_gates — publish review 4 gates (S-24)
-- S-24 Publish review gates: Successful test / No open blockers / All resources published / Publication approval
-- Three-state ✓/✗/◷: enabled gates enforce met/unmet/pending; disabled = not enforced (still returned).
-- satisfiedBy quoted verbatim when blocked; flow_id NULL = workspace default, non-NULL = per-flow override.
CREATE TABLE IF NOT EXISTS "release_gates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "flow_id" uuid REFERENCES "flows"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "satisfied_by" text NOT NULL,
  "policy_id" text,
  "ordinal" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_release_gates_workspace" ON "release_gates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_release_gates_workspace_flow" ON "release_gates" USING btree ("workspace_id","flow_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_release_gates_workspace_flow_name" ON "release_gates" USING btree ("workspace_id","flow_id","name");--> statement-breakpoint
