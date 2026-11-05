-- Rename the seven capability values to catalogue names, and constrain the column.
--
-- `workspace_member_capabilities` is REUSED as the individual-grant store rather
-- than replaced: its shape is already right — `(workspace_id, subject,
-- capability, granted_by, created_at)` with a correct unique index — and a new
-- table would mean two stores answering "what was this person granted directly",
-- which is the duplication this whole feature exists to remove.
--
--   edit-workflows  ->  flows.write
--   publish         ->  flows.arm
--   approve         ->  flows.approve
--   resources       ->  resources.read
--   real-data       ->  realdata.use
--   admin           ->  DROPPED
--   platform-admin  ->  DROPPED
--
-- ⚠ **THE TWO DROPS ARE THE BEHAVIOUR CHANGE** (INV-10). `admin` and
-- `platform-admin` were ROLES WEARING A CAPABILITY'S CLOTHES. A capability is a
-- thing you may do; those two were a statement about who somebody is. They are
-- re-expressed as a preset assignment and a platform role respectively, and
-- `rbac:backfill`'s dry run names every affected person BEFORE anything is
-- written — dropping a grant silently is the one outcome this migration must not
-- produce.
--
-- ⚠ **THE CHECK IS ADDED *VALID*, AFTER VERIFYING EVERY ROW MAPS** — the 0038
-- precedent. A NOT VALID constraint would grandfather in exactly the rows it
-- exists to prevent. The DO block below RAISES on any value not in the rename
-- table, so an unmapped value stops the migration with a message naming it
-- rather than being quietly renamed to nothing or left behind to fail the CHECK.
--
-- ⚠ **IT OPERATED ON ZERO ROWS WHEN IT WAS WRITTEN, AND A GREEN RUN HERE PROVES
-- NOTHING ABOUT THE MAPPING.** Measured 2026-09-12 on this deployment:
-- `workspace_member_capabilities` held **0** rows and `workspace_members` held
-- **0**, against 8 live workspaces. The mapping is proven against a fixture in
-- `src/auth/role-presets.test.ts` ("0065's rename lands every surviving value in
-- the catalogue") instead, because that test runs whether or not the table has
-- ever held anything. This note is here so nobody later reads a clean migration
-- log as evidence the rename was exercised.

DO $$
DECLARE
  unmapped text;
  affected integer;
BEGIN
  SELECT string_agg(DISTINCT capability, ', ')
    INTO unmapped
    FROM workspace_member_capabilities
   WHERE capability NOT IN (
     'edit-workflows', 'publish', 'approve', 'resources', 'admin',
     'platform-admin', 'real-data'
   );

  IF unmapped IS NOT NULL THEN
    RAISE EXCEPTION
      'workspace_member_capabilities holds value(s) this rename does not map: %. '
      'Add them to 0065 deliberately, or remove the rows. Refusing to add the '
      'CHECK over rows it would reject.', unmapped;
  END IF;

  SELECT count(*) INTO affected FROM workspace_member_capabilities;
  RAISE NOTICE '0065: % capability row(s) to rename', affected;
END
$$;
--> statement-breakpoint

-- ⚠ **DROP THE OLD CONSTRAINT FIRST, AND BEFORE THE UPDATES.**
--
-- 0042 constrained this column to the seven legacy values. Adding the new
-- constraint without dropping that one leaves TWO mutually exclusive CHECKs on
-- one column, and the table becomes completely unwritable — no legacy value and
-- no catalogue value can be inserted. It must also come before the UPDATEs
-- below, which rewrite rows to catalogue names the old constraint rejects.
--
-- ⚠ **THIS WAS A REAL DEFECT IN THIS MIGRATION, CAUGHT BY A TEST AND NOT BY
-- READING**, and it is exactly what the note above predicted: the first version
-- of 0065 ran GREEN against this deployment because the table held zero rows,
-- and it would have failed on the first UPDATE against any deployment that had
-- ever granted a capability. A clean migration log is not evidence.
ALTER TABLE "workspace_member_capabilities"
  DROP CONSTRAINT IF EXISTS "workspace_member_capabilities_capability_check";
--> statement-breakpoint

UPDATE "workspace_member_capabilities" SET "capability" = 'flows.write'   WHERE "capability" = 'edit-workflows';
--> statement-breakpoint
UPDATE "workspace_member_capabilities" SET "capability" = 'flows.arm'     WHERE "capability" = 'publish';
--> statement-breakpoint
UPDATE "workspace_member_capabilities" SET "capability" = 'flows.approve' WHERE "capability" = 'approve';
--> statement-breakpoint
UPDATE "workspace_member_capabilities" SET "capability" = 'resources.read' WHERE "capability" = 'resources';
--> statement-breakpoint
UPDATE "workspace_member_capabilities" SET "capability" = 'realdata.use'  WHERE "capability" = 'real-data';
--> statement-breakpoint

-- INV-10. The backfill reports these before they are removed; see its dry run.
DELETE FROM "workspace_member_capabilities" WHERE "capability" IN ('admin', 'platform-admin');
--> statement-breakpoint

-- INV-2. Generated from `src/auth/permissions.ts`; workspace tier only, because
-- an individual grant is workspace-scoped and `platform.*` belongs to the
-- platform tier's own tables.
ALTER TABLE "workspace_member_capabilities"
  ADD CONSTRAINT "workspace_member_capabilities_in_catalogue" CHECK (
  capability IN (
      'flows.read', 'flows.write', 'flows.run', 'flows.approve', 'flows.arm', 'runs.read',
      'runs.replay', 'approvals.read', 'approvals.decide', 'datasources.read',
      'datasources.write', 'datasources.query.write', 'tools.read', 'tools.write',
      'secrets.read', 'secrets.write', 'catalogue.read', 'catalogue.write', 'templates.read',
      'templates.write', 'resources.read', 'audit.read', 'members.read', 'members.grant',
      'roles.write', 'incidents.read', 'incidents.write', 'gates.read', 'gates.write',
      'budget.read', 'budget.write', 'breakglass.read', 'breakglass.activate', 'realdata.use',
      'search.read', 'bootstrap.read', 'scenarios.read', 'steps.try'
    )
  );
