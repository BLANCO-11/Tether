ALTER TABLE "datasources" ADD COLUMN "schema_allowlist" jsonb DEFAULT '["public"]'::jsonb;--> statement-breakpoint
ALTER TABLE "schemas" ADD COLUMN "entity_schema" varchar(255);