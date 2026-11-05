-- Phase 4, task 4.11 — drop the monolithic path's tables.
--
-- ORDER AND `IF EXISTS` ARE BOTH DELIBERATE. drizzle-kit emitted the four
-- `DROP TABLE … CASCADE` statements FIRST and the dependent
-- `ALTER TABLE … DROP CONSTRAINT` statements after them. CASCADE has already
-- removed those constraints by then, so every one of the follow-ups fails with
-- `constraint … does not exist` — and the migration dies half-applied, with the
-- tables gone and `triggers.script_id` still present.
--
-- Dependants are therefore detached FIRST, and the drops are `IF EXISTS` so a
-- partially-applied run can be repeated.

ALTER TABLE "triggers" DROP CONSTRAINT IF EXISTS "triggers_script_id_scripts_id_fk";--> statement-breakpoint
ALTER TABLE "trigger_fires" DROP CONSTRAINT IF EXISTS "trigger_fires_execution_id_execution_results_id_fk";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_triggers_script";--> statement-breakpoint
ALTER TABLE "triggers" DROP COLUMN IF EXISTS "script_id";--> statement-breakpoint

-- `trigger_fires.execution_id` is KEPT as a plain uuid. `trigger_fires` is an
-- audit trail, and rewriting history to match a new schema is the one thing an
-- audit trail must not do. A flow fire always leaves it NULL — a flow execution
-- links the other way round, by `flow_executions.trigger_fire_id`.

DROP TABLE IF EXISTS "test_results" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "script_versions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "execution_results" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "scripts" CASCADE;
