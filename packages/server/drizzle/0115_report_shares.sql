-- Cost report emails (2026-10-26; renumbered from 0106 on merge): one row per emailed report — who sent it, to whom, which workspaces and period.
CREATE TABLE IF NOT EXISTS "report_shares" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sender_subject" text NOT NULL,
  "sender_email" text,
  "recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "workspace_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "workspace_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "period_from" text NOT NULL,
  "period_to" text NOT NULL,
  "filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "filename" text NOT NULL,
  "bytes" integer DEFAULT 0 NOT NULL,
  "run_count" integer DEFAULT 0 NOT NULL,
  "cost_usd" numeric(14, 6) DEFAULT '0' NOT NULL,
  "outcome" varchar(16) DEFAULT 'failed' NOT NULL,
  "failure_reason" text,
  CONSTRAINT "ck_report_shares_outcome" CHECK ("outcome" in ('sent', 'refused', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_report_shares_created" ON "report_shares" ("created_at");
