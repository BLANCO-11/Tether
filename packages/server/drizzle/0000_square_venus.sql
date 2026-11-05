CREATE TABLE "datasources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" varchar(50) NOT NULL,
	"connection_string_enc" text NOT NULL,
	"secret_env_name" varchar(255),
	"test_status" varchar(20),
	"last_tested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "execution_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"script_id" uuid NOT NULL,
	"container_image" varchar(512),
	"exit_code" integer,
	"stdout_text" text,
	"stderr_text" text,
	"duration_ms" bigint,
	"memory_usage_mb" double precision,
	"status" varchar(20) NOT NULL,
	"requirements_file_path" varchar(1024),
	"started_at" timestamp with time zone DEFAULT now(),
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "schemas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"datasource_id" uuid NOT NULL,
	"entity_type" varchar(20) NOT NULL,
	"entity_name" varchar(255) NOT NULL,
	"column_name" varchar(255),
	"column_type" varchar(100),
	"is_primary_key" boolean DEFAULT false,
	"is_foreign_key" boolean DEFAULT false,
	"foreign_key_reference" varchar(255),
	"nullable" boolean DEFAULT true,
	"character_maximum_length" integer,
	"row_count_estimate" bigint,
	"null_percentage" numeric(5, 2),
	"extracted_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "schemas_datasource_id_entity_type_entity_name_column_name_unique" UNIQUE("datasource_id","entity_type","entity_name","column_name")
);
--> statement-breakpoint
CREATE TABLE "script_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"script_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"code" text NOT NULL,
	"diff_from_previous" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"orbit_session_id" varchar(255),
	"orbit_run_id" varchar(255),
	"title" varchar(512),
	"description" text,
	"language" varchar(20),
	"code" text NOT NULL,
	"prompt_used" text,
	"manifest_version" integer,
	"status" varchar(20) DEFAULT 'draft',
	"version_number" integer DEFAULT 1,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "test_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"script_id" uuid NOT NULL,
	"orbit_run_id" varchar(255),
	"overall_status" varchar(20),
	"summary" text,
	"tests_ran" boolean DEFAULT false,
	"tests_passed" boolean,
	"test_command" text,
	"test_output" text,
	"syntax_check_passed" boolean,
	"dependency_resolution_ok" boolean,
	"dry_run_exit_code" integer,
	"schema_alignment_verified" boolean,
	"endpoint_connectivity_ok" boolean,
	"dependencies_json" jsonb,
	"warnings_json" jsonb,
	"generated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"url" varchar(2048),
	"method" varchar(10),
	"description" text,
	"params_schema" jsonb,
	"is_dummy" boolean DEFAULT false,
	"dummy_response_template" jsonb,
	"secret_env_name" varchar(255),
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "trigger_fires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger_id" uuid NOT NULL,
	"execution_id" uuid,
	"fired_by" varchar(20) NOT NULL,
	"payload" jsonb,
	"fired_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"script_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" varchar(20) NOT NULL,
	"config" jsonb,
	"webhook_token" varchar(128),
	"enabled" boolean DEFAULT true,
	"last_fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "workspace_manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"hash" varchar(80) NOT NULL,
	"manifest_xml" text NOT NULL,
	"summary_xml" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "workspace_manifests_workspace_id_version_unique" UNIQUE("workspace_id","version")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"orbit_tenant_id" varchar(255),
	"orbit_api_key" varchar(512),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "datasources" ADD CONSTRAINT "datasources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_results" ADD CONSTRAINT "execution_results_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schemas" ADD CONSTRAINT "schemas_datasource_id_datasources_id_fk" FOREIGN KEY ("datasource_id") REFERENCES "public"."datasources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_versions" ADD CONSTRAINT "script_versions_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_fires" ADD CONSTRAINT "trigger_fires_trigger_id_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_fires" ADD CONSTRAINT "trigger_fires_execution_id_execution_results_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."execution_results"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_manifests" ADD CONSTRAINT "workspace_manifests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_executions_script" ON "execution_results" USING btree ("script_id");--> statement-breakpoint
CREATE INDEX "idx_executions_started" ON "execution_results" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_schemas_datasource" ON "schemas" USING btree ("datasource_id");--> statement-breakpoint
CREATE INDEX "idx_schemas_entity" ON "schemas" USING btree ("entity_type","entity_name");--> statement-breakpoint
CREATE INDEX "idx_trigger_fires_trigger" ON "trigger_fires" USING btree ("trigger_id","fired_at");--> statement-breakpoint
CREATE INDEX "idx_triggers_script" ON "triggers" USING btree ("script_id");--> statement-breakpoint
CREATE INDEX "idx_manifests_workspace" ON "workspace_manifests" USING btree ("workspace_id","version");