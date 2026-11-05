CREATE TABLE "tenant_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"max_concurrent_executions" integer DEFAULT 5 NOT NULL,
	"max_agent_runs_per_day" integer DEFAULT 50 NOT NULL,
	"max_tokens_per_day" bigint,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_tenant_budgets_workspace" UNIQUE("workspace_id")
);
--> statement-breakpoint
ALTER TABLE "tenant_budgets" ADD CONSTRAINT "tenant_budgets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;