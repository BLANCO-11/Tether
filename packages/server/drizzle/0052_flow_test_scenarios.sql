-- B-18 · flow_test_scenarios — scenario picker data for S-20
-- S-20 Test this workflow: 5 equal radio Saved/Edge/AI/Manual/Real, panel population 142 normal month, edge why worth running, AI textarea, Real 5-part modal.
-- Real is NOT a kind (real is namespace D-52, never a fixture); saved is a fixture, edge-case carries reason, ai-generated stores description, manual stores row JSON.
-- Uses next free idx 52 (after B-10 51). Honest-empty when no scenarios — population not faked.
CREATE TABLE IF NOT EXISTS "flow_test_scenarios" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "flow_id" uuid NOT NULL REFERENCES "flows"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('saved','edge-case','ai-generated','manual')),
  "population" text NOT NULL,
  "reason" text,
  "fixture_id" uuid REFERENCES "datasource_fixtures"("id") ON DELETE SET NULL,
  "created_by_subject" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flow_test_scenarios_workspace_flow" ON "flow_test_scenarios" USING btree ("workspace_id","flow_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flow_test_scenarios_flow_kind" ON "flow_test_scenarios" USING btree ("flow_id","kind");--> statement-breakpoint
COMMENT ON TABLE "flow_test_scenarios" IS 'B-18 S-20 scenario picker: saved|edge-case|ai-generated|manual (real is namespace D-52, not a kind). saved is fixture binding, edge-case reason = why worth running, population e.g. 142 employees · normal month required, fixture_id SET NULL on fixture delete. Mock-only scenarios; real data never stored as scenario.';--> statement-breakpoint
COMMENT ON COLUMN "flow_test_scenarios"."population" IS 'Population line e.g. 142 employees · normal month — required, not faked; honest-empty when no scenarios.';--> statement-breakpoint
COMMENT ON COLUMN "flow_test_scenarios"."reason" IS 'Edge-case: why worth running. Nullable, used only for edge-case kind.';--> statement-breakpoint
COMMENT ON COLUMN "flow_test_scenarios"."fixture_id" IS 'Nullable FK to datasource_fixtures SET NULL. Real namespace D-52 never a fixture.'; 
