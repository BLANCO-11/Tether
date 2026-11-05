ALTER TABLE "test_results" ADD COLUMN "audit_verdict" varchar(10);--> statement-breakpoint
ALTER TABLE "test_results" ADD COLUMN "audit_json" jsonb;