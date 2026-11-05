CREATE TABLE "flow_chat_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"flow_id" uuid,
	"name" varchar(255) NOT NULL,
	"design_selection" jsonb,
	"created_by_kind" varchar(16) NOT NULL,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "flow_chat_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"message" varchar(2000) NOT NULL,
	"op_json" jsonb,
	"resolved_step_id" varchar(255),
	"resolved_by" varchar(16),
	"revision" integer,
	"findings_json" jsonb,
	"refusal_json" jsonb,
	"refusal_key" varchar(64),
	"attempts" integer DEFAULT 0 NOT NULL,
	"status" varchar(32) DEFAULT 'running' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"finished_at" timestamp with time zone,
	CONSTRAINT "uq_flow_chat_turns_seq" UNIQUE("thread_id","seq")
);
--> statement-breakpoint
ALTER TABLE "flow_chat_threads" ADD CONSTRAINT "flow_chat_threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_chat_threads" ADD CONSTRAINT "flow_chat_threads_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_chat_turns" ADD CONSTRAINT "flow_chat_turns_thread_id_flow_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."flow_chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_flow_chat_threads_workspace" ON "flow_chat_threads" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_flow_chat_turns_thread" ON "flow_chat_turns" USING btree ("thread_id","created_at");