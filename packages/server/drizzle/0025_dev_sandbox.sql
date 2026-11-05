-- Programme 3 Stage 4 — the development sandbox.
--
-- A draft-namespace run reads Foundry-owned fixtures instead of the tenant's
-- real database. The rows are frozen HERE (insert-only, versioned, hashed); the
-- sandbox database is a projection that can be dropped and rebuilt from them.
--
-- Nothing here changes behaviour on its own: with no fixture row and a NULL
-- `sandbox_dsn_enc`, every datasource behaves exactly as it did before, and a
-- draft run reports `readFrom: "production"` rather than pretending otherwise.

ALTER TABLE "datasources" ADD COLUMN IF NOT EXISTS "sandbox_dsn_enc" text;
ALTER TABLE "datasources" ADD COLUMN IF NOT EXISTS "sandbox_db_name" varchar(63);
ALTER TABLE "datasources" ADD COLUMN IF NOT EXISTS "sandbox_fixture_version" integer;

CREATE TABLE IF NOT EXISTS "datasource_fixtures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "datasource_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "rows_json" jsonb NOT NULL,
  "ddl_sql" text NOT NULL,
  "schema_fingerprint" varchar(80) NOT NULL,
  "taxonomy_json" jsonb NOT NULL,
  "generated_by" varchar(20) NOT NULL,
  "model" varchar(120),
  "frozen_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "uq_datasource_fixtures_version" UNIQUE("datasource_id","version")
);

DO $$ BEGIN
  ALTER TABLE "datasource_fixtures" ADD CONSTRAINT "datasource_fixtures_datasource_id_datasources_id_fk"
    FOREIGN KEY ("datasource_id") REFERENCES "public"."datasources"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "idx_datasource_fixtures_ds" ON "datasource_fixtures" USING btree ("datasource_id");

-- Which database a `datasource` step actually read, recorded at the time of the
-- run. NULL for every other kind and for all history predating the sandbox —
-- and deliberately not backfilled: a draft run that read production before this
-- existed did read production, and stamping it `production` now would be
-- inventing a record nobody took.
ALTER TABLE "flow_step_runs" ADD COLUMN IF NOT EXISTS "read_from" varchar(12);
