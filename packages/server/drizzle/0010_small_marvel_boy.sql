CREATE TABLE "datasource_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"datasource_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"sql_text" text NOT NULL,
	"param_order" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"params_schema" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_datasource_queries_name" UNIQUE("datasource_id","name")
);
--> statement-breakpoint
CREATE TABLE "execution_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"flow_execution_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_execution_tokens_hash" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "flow_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kestra_namespace" varchar(255) NOT NULL,
	"kestra_flow_id" varchar(255) NOT NULL,
	"kestra_execution_id" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'running' NOT NULL,
	"trigger_fire_id" uuid,
	"inputs_json" jsonb,
	"started_at" timestamp with time zone DEFAULT now(),
	"ended_at" timestamp with time zone,
	CONSTRAINT "uq_flow_executions_kestra" UNIQUE("kestra_execution_id")
);
--> statement-breakpoint
CREATE TABLE "flow_step_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_execution_id" uuid NOT NULL,
	"step_id" varchar(255) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"kestra_taskrun_id" varchar(255),
	"tether_run_id" varchar(255),
	"audit_verdict" varchar(10),
	"oracle_score" double precision,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_flow_step_runs_taskrun" UNIQUE("kestra_taskrun_id"),
	CONSTRAINT "uq_flow_step_runs_tether_run" UNIQUE("tether_run_id")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "slug" varchar(128);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "tenant_slug" varchar(128);--> statement-breakpoint
ALTER TABLE "datasource_queries" ADD CONSTRAINT "datasource_queries_datasource_id_datasources_id_fk" FOREIGN KEY ("datasource_id") REFERENCES "public"."datasources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_tokens" ADD CONSTRAINT "execution_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_tokens" ADD CONSTRAINT "execution_tokens_flow_execution_id_flow_executions_id_fk" FOREIGN KEY ("flow_execution_id") REFERENCES "public"."flow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_executions" ADD CONSTRAINT "flow_executions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_executions" ADD CONSTRAINT "flow_executions_trigger_fire_id_trigger_fires_id_fk" FOREIGN KEY ("trigger_fire_id") REFERENCES "public"."trigger_fires"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_step_runs" ADD CONSTRAINT "flow_step_runs_flow_execution_id_flow_executions_id_fk" FOREIGN KEY ("flow_execution_id") REFERENCES "public"."flow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_execution_tokens_exec" ON "execution_tokens" USING btree ("flow_execution_id");--> statement-breakpoint
CREATE INDEX "idx_flow_executions_workspace" ON "flow_executions" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_flow_step_runs_exec_step" ON "flow_step_runs" USING btree ("flow_execution_id","step_id");--> statement-breakpoint
-- Backfill immutable namespace slugs for workspaces that predate them (§5.0).
-- Derived from the display name ONCE, here, and never recomputed: a workspace
-- rename must not move its Kestra namespace, or its deployed flows and their
-- execution history detach from it.
UPDATE "workspaces"
   SET "slug" = regexp_replace(regexp_replace(lower("name"), '[^a-z0-9_-]+', '-', 'g'), '^-+|-+$', '', 'g')
 WHERE "slug" IS NULL;
--> statement-breakpoint
-- Existing installs have no tenant concept yet (there is no `tenants` table —
-- see DECISIONS.md D-03), so everything lands under one tenant slug. The
-- SEGMENT is what matters: it is mandatory in the namespace so that adding real
-- tenants later cannot collide two clients' "HR" workspaces.
UPDATE "workspaces" SET "tenant_slug" = 'default' WHERE "tenant_slug" IS NULL;
