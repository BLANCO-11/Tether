-- Set-of-choices values are now recorded at EVERY schema read, for every engine (services/introspect/choice-set.ts):
-- the opt-in switch is gone. Its column held `false` on every datasource.
ALTER TABLE "datasources" DROP COLUMN IF EXISTS "observe_values";
