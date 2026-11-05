-- B-17 · S-42 My attendance status — per-employee attendance aggregation (consumer)
-- per-employee 02:00 IST, workspace-scoped, subject derived from identity (never query param)
CREATE TABLE IF NOT EXISTS "attendance_daily" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "subject" text NOT NULL,
  "date" date NOT NULL,
  "hours_in_office" numeric NOT NULL,
  "source" text,
  PRIMARY KEY ("workspace_id","subject","date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "attendance_compliance" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "subject" text NOT NULL,
  "period" text NOT NULL,
  "days_in_office" integer NOT NULL,
  "required_days" integer NOT NULL,
  "avg_hours" interval NOT NULL,
  "last_calculated_at" timestamp with time zone NOT NULL,
  "next_calculation_at" timestamp with time zone NOT NULL,
  "compliant" boolean NOT NULL,
  "history" jsonb,
  PRIMARY KEY ("workspace_id","subject","period")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_attendance_daily_workspace_subject" ON "attendance_daily" USING btree ("workspace_id","subject");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_attendance_daily_date" ON "attendance_daily" USING btree ("date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_attendance_compliance_workspace_subject" ON "attendance_compliance" USING btree ("workspace_id","subject");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_attendance_compliance_period" ON "attendance_compliance" USING btree ("period");
