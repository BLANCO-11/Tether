-- compiled-builder phase 2c (E0.7 G1): a tool declares what it returns.
ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "output_schema" jsonb;
