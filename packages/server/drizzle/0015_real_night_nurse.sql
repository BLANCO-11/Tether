CREATE TABLE "flow_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"bundle_json" jsonb NOT NULL,
	"source_flow_id" uuid,
	"source_revision" integer,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_flow_templates_name" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
ALTER TABLE "flow_executions" ADD COLUMN "replay_of_id" uuid;--> statement-breakpoint
ALTER TABLE "flow_executions" ADD COLUMN "replay_from_step" varchar(255);--> statement-breakpoint
ALTER TABLE "flow_templates" ADD CONSTRAINT "flow_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_templates" ADD CONSTRAINT "flow_templates_source_flow_id_flows_id_fk" FOREIGN KEY ("source_flow_id") REFERENCES "public"."flows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_flow_templates_workspace" ON "flow_templates" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "flow_executions" ADD CONSTRAINT "flow_executions_replay_of_id_flow_executions_id_fk" FOREIGN KEY ("replay_of_id") REFERENCES "public"."flow_executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_flow_executions_replay_of" ON "flow_executions" USING btree ("replay_of_id");