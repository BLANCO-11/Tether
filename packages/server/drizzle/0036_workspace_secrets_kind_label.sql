ALTER TABLE "workspace_secrets" ADD COLUMN "kind" varchar(32);--> statement-breakpoint
ALTER TABLE "workspace_secrets" ADD COLUMN "label" varchar(255);
