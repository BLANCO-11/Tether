-- compiled-builder phase 2b (I-271, G13, I-278): declared metadata becomes typeable.
ALTER TABLE "schemas" ADD COLUMN IF NOT EXISTS "semantic_tag" text;
--> statement-breakpoint
ALTER TABLE "datasource_queries" ADD COLUMN IF NOT EXISTS "described_json" jsonb;
