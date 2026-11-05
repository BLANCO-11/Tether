-- Namespace slugs: heal the ones that were never assigned, then make the pair
-- unique so it cannot happen quietly again.
--
-- ── What went wrong ──────────────────────────────────────────────────────────
--
-- Migration 0010 added `slug` / `tenant_slug` and backfilled them ONCE. Nothing
-- ever wrote them afterwards: `workspaceService.create` did not set either, so
-- every workspace created through the product after 0010 carried NULL for both.
--
-- The symptom is badly placed. Such a workspace provisions perfectly — tools,
-- datasource, named queries, manifest, secrets, all fine — and fails only at the
-- first deploy, where `tenantMapper.namespacesFor` 409s because it cannot
-- address a namespace. So the thing that is broken is discovered long after the
-- thing that broke it, and it looks like a Kestra problem.
--
-- `workspaceService.create` now assigns both at creation. This repeats 0010's
-- backfill for anything created in between.

UPDATE "workspaces"
   SET "slug" = regexp_replace(regexp_replace(lower("name"), '[^a-z0-9_-]+', '-', 'g'), '^-+|-+$', '', 'g')
 WHERE "slug" IS NULL OR "slug" = '';
--> statement-breakpoint

-- A name that is entirely punctuation slugifies to the empty string, and
-- `namespaceFor` rejects an empty segment. Same fallback the service uses.
UPDATE "workspaces" SET "slug" = 'workspace' WHERE "slug" IS NULL OR "slug" = '';
--> statement-breakpoint

UPDATE "workspaces" SET "tenant_slug" = 'default' WHERE "tenant_slug" IS NULL OR "tenant_slug" = '';
--> statement-breakpoint

-- Disambiguate any duplicates the backfill just created, oldest keeps the bare
-- slug. Done before the index, or the index would fail to build and the
-- migration would stop halfway on exactly the deployment that needed it.
WITH ranked AS (
  SELECT "id",
         "slug",
         row_number() OVER (PARTITION BY "tenant_slug", "slug" ORDER BY "created_at", "id") AS n
    FROM "workspaces"
   WHERE "deleted_at" IS NULL
)
UPDATE "workspaces" w
   SET "slug" = ranked."slug" || '-' || ranked.n
  FROM ranked
 WHERE w."id" = ranked."id" AND ranked.n > 1;
--> statement-breakpoint

-- ⚠ The constraint that makes `workspaceRepo.getBySlugs` sound.
--
-- Kestra addresses a namespace by `<prefix>.<tenant_slug>.<slug>`, and
-- `getBySlugs` resolves that pair to ONE row with `LIMIT 1`. Two live workspaces
-- sharing the pair is therefore not a cosmetic clash — it is two tenants' flows
-- deployed into one namespace, with `POST /api/executions/begin` handing
-- whichever row it found first the other's execution token.
--
-- PARTIAL on `deleted_at IS NULL`: a soft-deleted workspace keeps its slug in the
-- table for history, and must not block a new workspace from taking the name.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workspaces_tenant_slug"
    ON "workspaces" ("tenant_slug", "slug")
 WHERE "deleted_at" IS NULL;
