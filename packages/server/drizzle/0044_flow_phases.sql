-- B-11: flow_phases — background frames for the builder canvas (S-07)
-- Phases are per-revision background frames, not collapsible groups (flows/02:48).
-- S-07 / S-10 / S-29 share the same 7 phases; lane gap 56px is CSS only.
CREATE TABLE IF NOT EXISTS "flow_phases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "flow_revision_id" uuid NOT NULL REFERENCES "flow_revisions"("id") ON DELETE CASCADE,
  "label" text NOT NULL,
  "summary" text,
  "lane" integer NOT NULL,
  "ordinal" integer NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_flow_phases_revision" ON "flow_phases" ("flow_revision_id", "ordinal");
CREATE INDEX IF NOT EXISTS "idx_flow_phases_revision_id" ON "flow_phases" ("flow_revision_id");
-- Each step may belong to one phase (background frame). Nullable so existing rows stay valid.
ALTER TABLE "flow_steps" ADD COLUMN IF NOT EXISTS "phase_id" uuid REFERENCES "flow_phases"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "idx_flow_steps_phase" ON "flow_steps" ("phase_id");
