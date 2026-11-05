-- GAPS.md §1.2 — `created_by` is self-asserted for anything not authored by a
-- signed-in person. ISSUES.md I-32.
--
-- Gate 2 refuses an approval whose approver matches `flow_revisions.created_by`.
-- The approver has been verified since Stage 9.1; the author was verified only
-- when the revision came through the browser, and the row did not record which.
-- So the refusal compared one value the server established against one it may
-- merely have been told.
--
-- This does not stop non-people writing revisions — harnesses, seeds, imports
-- and the CLI all must keep doing so, and "authorship requires a session" would
-- take the regression net down. It records whether anybody was there.

ALTER TABLE "flow_revisions" ADD COLUMN IF NOT EXISTS "created_by_kind" varchar(16);
--> statement-breakpoint

-- ⚠ The backfill is `unknown`, NOT `system`.
--
-- Existing rows came from browsers, harnesses, seeds, imports and the drafter,
-- and nothing distinguishes them now — that absence IS the gap. `user` would
-- manufacture the verification this column exists to make honest; `system`
-- would assert that no person was involved, which for the browser-authored rows
-- is simply false. `unknown` is the only value that claims what is known.
--
-- Same reasoning as 0025's refusal to backfill `flow_step_runs.read_from`: a
-- record nobody took must not be invented later.
UPDATE "flow_revisions" SET "created_by_kind" = 'unknown' WHERE "created_by_kind" IS NULL;
--> statement-breakpoint

-- NOT NULL and NO DEFAULT. A default lets a future writer omit the column and
-- silently acquire a provenance; with neither, `$inferInsert` makes omitting it
-- a compile error and the database makes it a loud one.
ALTER TABLE "flow_revisions" ALTER COLUMN "created_by_kind" SET NOT NULL;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "flow_revisions" ADD CONSTRAINT "ck_flow_revisions_created_by_kind"
    CHECK ("created_by_kind" IN ('user', 'system', 'unknown'));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- What the revision's kind said at the moment of approval.
--
-- The refusal itself is unchanged — it still compares strings, and it still
-- fires for a system author whose name matches, because `kestra:phase3` and
-- every seeded flow arm flows that way and refusing them outright would break
-- the regression net. This is the record: after the fact, "a second pair of eyes
-- was possible and happened" and "there was nobody to be the first pair" are
-- different rows rather than the same one.
ALTER TABLE "flow_approvals" ADD COLUMN IF NOT EXISTS "revision_author_kind" varchar(16);
--> statement-breakpoint

UPDATE "flow_approvals" SET "revision_author_kind" = 'unknown' WHERE "revision_author_kind" IS NULL;
--> statement-breakpoint

ALTER TABLE "flow_approvals" ALTER COLUMN "revision_author_kind" SET NOT NULL;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "flow_approvals" ADD CONSTRAINT "ck_flow_approvals_revision_author_kind"
    CHECK ("revision_author_kind" IN ('user', 'system', 'unknown'));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
