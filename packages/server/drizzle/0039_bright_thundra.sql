CREATE TABLE "email_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"flow_execution_id" uuid,
	"step_id" text,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolved_from" varchar(16),
	"subject" text,
	"outcome" varchar(16) NOT NULL,
	"graph_message_id" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "ck_email_sends_outcome" CHECK ("email_sends"."outcome" in ('sent', 'refused', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "mail_recipient_allowlist" jsonb;--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_flow_execution_id_flow_executions_id_fk" FOREIGN KEY ("flow_execution_id") REFERENCES "public"."flow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_email_sends_execution" ON "email_sends" USING btree ("flow_execution_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_email_sends_workspace" ON "email_sends" USING btree ("workspace_id","created_at");