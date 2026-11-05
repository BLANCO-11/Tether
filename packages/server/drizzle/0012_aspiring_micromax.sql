ALTER TABLE "flow_step_runs" ADD COLUMN "resume_task_id" varchar(255);--> statement-breakpoint
ALTER TABLE "flow_step_runs" ADD COLUMN "resumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "flow_step_runs" ADD COLUMN "failure_class" varchar(32);--> statement-breakpoint
ALTER TABLE "flow_step_runs" ADD COLUMN "triage_route" varchar(24);--> statement-breakpoint
ALTER TABLE "flow_step_runs" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_flow_step_runs_awaiting_resume" ON "flow_step_runs" USING btree ("tether_run_id") WHERE "flow_step_runs"."tether_run_id" IS NOT NULL AND "flow_step_runs"."resumed_at" IS NULL;