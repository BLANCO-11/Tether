CREATE TABLE "flow_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"approver_user_id" varchar(255) NOT NULL,
	"approver_kind" varchar(20) DEFAULT 'client_admin' NOT NULL,
	"note" text,
	"approved_at" timestamp with time zone DEFAULT now(),
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"manifest_fingerprint" varchar(71) NOT NULL,
	"stale_at" timestamp with time zone,
	"stale_reason" text
);
--> statement-breakpoint
CREATE TABLE "flow_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"model_json" jsonb NOT NULL,
	"compiled_yaml_hash" varchar(71) NOT NULL,
	"structure_hash" varchar(71) NOT NULL,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_flow_revisions_revision" UNIQUE("flow_id","revision")
);
--> statement-breakpoint
CREATE TABLE "flow_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"step_id" varchar(255) NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" varchar(20) NOT NULL,
	"config_json" jsonb NOT NULL,
	"generated_code" text,
	"manifest_refs_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "uq_flow_steps_step" UNIQUE("flow_id","revision","step_id")
);
--> statement-breakpoint
CREATE TABLE "flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"kestra_flow_id" varchar(255) NOT NULL,
	"draft_revision" integer DEFAULT 0 NOT NULL,
	"armed_revision" integer,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_flows_workspace_flow_id" UNIQUE("workspace_id","kestra_flow_id")
);
--> statement-breakpoint
ALTER TABLE "triggers" ALTER COLUMN "script_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "flow_executions" ADD COLUMN "flow_id" uuid;--> statement-breakpoint
ALTER TABLE "flow_executions" ADD COLUMN "flow_revision" integer;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "flow_id" uuid;--> statement-breakpoint
ALTER TABLE "flow_approvals" ADD CONSTRAINT "flow_approvals_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_revisions" ADD CONSTRAINT "flow_revisions_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_steps" ADD CONSTRAINT "flow_steps_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_flow_approvals_revision" ON "flow_approvals" USING btree ("flow_id","revision");--> statement-breakpoint
CREATE INDEX "idx_flow_steps_revision" ON "flow_steps" USING btree ("flow_id","revision");--> statement-breakpoint
CREATE INDEX "idx_flows_workspace" ON "flows" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "flow_executions" ADD CONSTRAINT "flow_executions_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_triggers_flow" ON "triggers" USING btree ("flow_id");