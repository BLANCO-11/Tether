CREATE TABLE "stub_call_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tool_name" varchar(64),
	"method" varchar(8) NOT NULL,
	"path" varchar(256) NOT NULL,
	"query" jsonb,
	"body" jsonb,
	"status_code" integer NOT NULL,
	"result_count" integer,
	"duration_ms" integer,
	"called_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "stub_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" varchar(64) NOT NULL,
	"author" varchar(128) NOT NULL,
	"text" text,
	"blocks" jsonb,
	"posted_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "stub_mail_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" varchar(128) NOT NULL,
	"sender" varchar(256) NOT NULL,
	"recipients" jsonb NOT NULL,
	"cc" jsonb,
	"subject" text,
	"body" text,
	"attachments" jsonb,
	"template_key" varchar(64),
	"status" varchar(16) DEFAULT 'sent' NOT NULL,
	"bounce_reason" text,
	"sent_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "stub_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_key" varchar(32) NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"priority" varchar(16) DEFAULT 'normal',
	"status" varchar(16) DEFAULT 'open',
	"assignee" varchar(256),
	"labels" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "stub_tickets_ticket_key_unique" UNIQUE("ticket_key")
);
--> statement-breakpoint
CREATE INDEX "idx_stub_call_log_called" ON "stub_call_log" USING btree ("called_at");--> statement-breakpoint
CREATE INDEX "idx_stub_chat_posted" ON "stub_chat_messages" USING btree ("posted_at");--> statement-breakpoint
CREATE INDEX "idx_stub_mail_sent" ON "stub_mail_outbox" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "idx_stub_tickets_created" ON "stub_tickets" USING btree ("created_at");