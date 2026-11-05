-- B-06: capability grants — 7 verbs vs 3 roles. Per-workspace per-person grants beyond role bundle.
-- Authoritative verbs: edit-workflows, publish, approve, resources, admin, platform-admin, real-data
-- Roles are bundles: author ⊇? approver ⊇ admin (see mapping.md §4). This table stores explicit grants.
CREATE TABLE IF NOT EXISTS "workspace_member_capabilities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "subject" text NOT NULL,
  "capability" text NOT NULL CHECK ("capability" IN ('edit-workflows','publish','approve','resources','admin','platform-admin','real-data')),
  "granted_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workspace_member_capabilities_unique" ON "workspace_member_capabilities" ("workspace_id","subject","capability");
CREATE INDEX IF NOT EXISTS "idx_workspace_member_capabilities_workspace" ON "workspace_member_capabilities" ("workspace_id");
CREATE INDEX IF NOT EXISTS "idx_workspace_member_capabilities_subject" ON "workspace_member_capabilities" ("workspace_id","subject");
