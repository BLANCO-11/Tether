CREATE TABLE "workspace_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"value_enc" text NOT NULL,
	"sandbox_value_enc" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_workspace_secrets_name" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
ALTER TABLE "stub_call_log" ADD COLUMN "auth_presented" boolean;--> statement-breakpoint
ALTER TABLE "stub_call_log" ADD COLUMN "auth_ok" boolean;--> statement-breakpoint
ALTER TABLE "stub_call_log" ADD COLUMN "auth_via" varchar(64);--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "auth_style" varchar(16);--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "auth_param_name" varchar(128);--> statement-breakpoint
ALTER TABLE "workspace_secrets" ADD CONSTRAINT "workspace_secrets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;