-- compiled-builder I-301: a column's value domain (declared, or observed when the datasource opts in).
ALTER TABLE "schemas" ADD COLUMN IF NOT EXISTS "value_domain" jsonb;
ALTER TABLE "datasources" ADD COLUMN IF NOT EXISTS "observe_values" boolean DEFAULT false NOT NULL;
