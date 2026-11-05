-- B-02 pins per-person oid, unique workspace_id,subject,flow_id, idx54
CREATE TABLE IF NOT EXISTS "pins" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "subject" text NOT NULL,
  "flow_id" uuid NOT NULL REFERENCES "flows"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_pins_workspace_subject_flow" ON "pins" USING btree ("workspace_id","subject","flow_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pins_workspace_subject" ON "pins" USING btree ("workspace_id","subject");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx54" ON "pins" USING btree ("flow_id");
