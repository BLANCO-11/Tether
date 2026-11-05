CREATE TABLE "flow_generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"goal" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"status" varchar(32) DEFAULT 'running' NOT NULL,
	"flow_id" uuid,
	"result_json" jsonb,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now(),
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "flow_generation_jobs" ADD CONSTRAINT "flow_generation_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_generation_jobs" ADD CONSTRAINT "flow_generation_jobs_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_flow_generation_jobs_workspace" ON "flow_generation_jobs" USING btree ("workspace_id","created_at");