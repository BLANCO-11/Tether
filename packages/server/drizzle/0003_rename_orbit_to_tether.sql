-- Rename the runtime-reference columns from the old "Orbit" brand to "Tether"
-- (the runtime repo rebranded; see plans/tether-rename-plan.md §4 Class B).
--
-- HAND-WRITTEN, deliberately. `drizzle-kit generate` prompts for each of these
-- and defaults to "create column", which would silently drop the existing run
-- history. RENAME COLUMN is metadata-only, instant, and preserves every value.
ALTER TABLE "workspaces" RENAME COLUMN "orbit_tenant_id" TO "tether_tenant_id";
--> statement-breakpoint
ALTER TABLE "workspaces" RENAME COLUMN "orbit_api_key" TO "tether_api_key";
--> statement-breakpoint
ALTER TABLE "scripts" RENAME COLUMN "orbit_session_id" TO "tether_session_id";
--> statement-breakpoint
ALTER TABLE "scripts" RENAME COLUMN "orbit_run_id" TO "tether_run_id";
--> statement-breakpoint
ALTER TABLE "test_results" RENAME COLUMN "orbit_run_id" TO "tether_run_id";
