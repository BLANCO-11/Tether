-- Sharing boundaries phase 2 (plans/sharing-boundaries-2026-10-30, D2): a workflow shared with the workspace is
-- EDITABLE by its members by default; its owner can make it view-only. Editing never changes what runs unattended —
-- an approval binds a revision, so an edit is a new draft that needs approving again.
ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "others_may_edit" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Every workflow that exists today was shared under the old rule, where only its owner could change it. Keep that:
-- they start view-only, and their owners choose. The default (editable) applies to what is shared from now on.
UPDATE "flows" SET "others_may_edit" = false WHERE "created_at" < now();
