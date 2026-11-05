CREATE TABLE "datasource_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"datasource_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"spec_json" jsonb NOT NULL,
	"compiled_sql" text NOT NULL,
	"params_schema" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_datasource_operations_name" UNIQUE("datasource_id","name")
);
--> statement-breakpoint
ALTER TABLE "datasource_operations" ADD CONSTRAINT "datasource_operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasource_operations" ADD CONSTRAINT "datasource_operations_datasource_id_datasources_id_fk" FOREIGN KEY ("datasource_id") REFERENCES "public"."datasources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_datasource_operations_workspace" ON "datasource_operations" USING btree ("workspace_id");