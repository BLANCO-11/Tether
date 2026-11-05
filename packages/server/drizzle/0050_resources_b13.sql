-- B-13 · S-48 Resource list — ResourceCategory/owner/health/dependents + 9-status ResourceStatus
-- Widen `datasources` with nullable columns per B-13; dependents stays derived (never stored).
CREATE TABLE IF NOT EXISTS "datasources" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL);
-- resource_status: 9 values setup·draft·pending-review·approved·published·paused·failed·deprecated·archived
ALTER TABLE "datasources" ADD COLUMN IF NOT EXISTS "resource_status" text CHECK ("resource_status" IN ('setup','draft','pending-review','approved','published','paused','failed','deprecated','archived'));
ALTER TABLE "datasources" ADD COLUMN IF NOT EXISTS "owner_subject" text;
ALTER TABLE "datasources" ADD COLUMN IF NOT EXISTS "owner_name" varchar(255);
ALTER TABLE "datasources" ADD COLUMN IF NOT EXISTS "owner_avatar_url" text;
-- health: chip sentence kind; health_note is the free-text sentence per row (S-48)
ALTER TABLE "datasources" ADD COLUMN IF NOT EXISTS "health" text CHECK ("health" IN ('healthy','waiting_review','expires_soon','not_connected','superseded'));
ALTER TABLE "datasources" ADD COLUMN IF NOT EXISTS "health_note" text;
ALTER TABLE "datasources" ADD COLUMN IF NOT EXISTS "resource_category" text CHECK ("resource_category" IN ('datasource','connector','tool'));
ALTER TABLE "datasources" ADD COLUMN IF NOT EXISTS "has_mock_data" boolean DEFAULT false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_datasources_resource_status" ON "datasources" USING btree ("resource_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_datasources_health" ON "datasources" USING btree ("health");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_datasources_resource_category" ON "datasources" USING btree ("resource_category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_datasources_owner_subject" ON "datasources" USING btree ("owner_subject");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_datasources_has_mock" ON "datasources" USING btree ("has_mock_data");
