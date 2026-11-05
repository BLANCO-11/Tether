-- B-10 · S-04 catalogue picker — per-access safety badge masked/mock/restricted + Request access
-- Catalogue is a virtual UNION of flow_templates + datasources + tools + schemas with safety computed via real-data capability + datasource sandbox.
-- This table is a compliance marker (virtual union remains primary); safety check enforces badge vocabulary.
CREATE TABLE IF NOT EXISTS "catalogue_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "label" text NOT NULL,
  "icon" text NOT NULL,
  "kind" text NOT NULL,
  "safety" text NOT NULL CHECK ("safety" IN ('masked','mock','restricted')),
  "owner" text,
  "owner_name" text,
  "created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_catalogue_items_workspace" ON "catalogue_items" USING btree ("workspace_id");--> statement-breakpoint
