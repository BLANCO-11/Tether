CREATE TABLE "flow_step_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_execution_id" uuid NOT NULL,
	"step_id" varchar(255) NOT NULL,
	"resume_task_id" varchar(255) NOT NULL,
	"summary" text NOT NULL,
	"context" jsonb,
	"decision" varchar(16),
	"decided_by" varchar(255),
	"decided_at" timestamp with time zone,
	"note" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_flow_step_approvals_step" UNIQUE("flow_execution_id","step_id")
);
--> statement-breakpoint
ALTER TABLE "flow_step_approvals" ADD CONSTRAINT "flow_step_approvals_flow_execution_id_flow_executions_id_fk" FOREIGN KEY ("flow_execution_id") REFERENCES "public"."flow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_flow_step_approvals_pending" ON "flow_step_approvals" USING btree ("decided_at");