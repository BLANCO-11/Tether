-- Mock data on onboarding (Slice A) — fixture readiness, per-run prod override, nullable prod DSN.
--
-- `datasource_fixtures` gains the readiness/version columns the mock build reports
-- through (no new table; the JSON mock file is a derived cache, not a source of
-- truth). A freshly inserted row is `building`, never usable — `failed` and "no
-- row" are DIFFERENT states and neither satisfies hasMock, so existing fixtures
-- read as unusable until rebuilt under the ops runbook (no backfill, by design).
--
-- `flow_executions` gains the per-run prod opt-in (row-carried, never a Kestra
-- label; live runs ignore it and always read prod).
--
-- `datasources.connection_string_enc` becomes nullable for mock-only-until-linked
-- rows: a datasource may exist with mock fixtures before any production
-- credential is attached. NULL means "no production credential" — every
-- decrypt() call-site must handle it and refuse prod paths, never throw
-- malformed-ciphertext on it.
ALTER TABLE "datasource_fixtures" ADD COLUMN IF NOT EXISTS "mock_status" varchar(16) DEFAULT 'building' NOT NULL;
--> statement-breakpoint
ALTER TABLE "datasource_fixtures" ADD COLUMN IF NOT EXISTS "mock_error" text;
--> statement-breakpoint
ALTER TABLE "datasource_fixtures" DROP CONSTRAINT IF EXISTS "datasource_fixtures_mock_status_check";
--> statement-breakpoint
ALTER TABLE "datasource_fixtures" ADD CONSTRAINT "datasource_fixtures_mock_status_check" CHECK ("mock_status" IN ('building','ready','failed'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_datasource_fixtures_mock_status" ON "datasource_fixtures" USING btree ("mock_status");
--> statement-breakpoint
ALTER TABLE "flow_executions" ADD COLUMN IF NOT EXISTS "use_prod_override" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "datasources" ALTER COLUMN "connection_string_enc" DROP NOT NULL;
