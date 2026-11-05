ALTER TABLE "flow_step_approvals" ADD COLUMN "kind" varchar(16) DEFAULT 'gate' NOT NULL;--> statement-breakpoint
ALTER TABLE "flow_step_approvals" ADD COLUMN "tether_run_id" varchar(255);--> statement-breakpoint
ALTER TABLE "flow_step_approvals" ADD COLUMN "question_id" varchar(255);--> statement-breakpoint
ALTER TABLE "flow_step_approvals" ADD COLUMN "questions" jsonb;--> statement-breakpoint
ALTER TABLE "flow_step_approvals" ADD COLUMN "answers" jsonb;--> statement-breakpoint
ALTER TABLE "flow_step_approvals" ADD COLUMN "expired_at" timestamp with time zone;