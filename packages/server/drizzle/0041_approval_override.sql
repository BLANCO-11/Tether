-- A super admin may approve a revision they wrote, and the row says so.
--
-- ⚠ WHY THIS COLUMN EXISTS AT ALL. The self-approval refusal (§5.0) compares
-- the approver against `flow_revisions.created_by` and is the only thing
-- standing between "a second pair of eyes" and one person doing both halves. A
-- super admin is now exempt from it — asked for explicitly, and unavoidable on a
-- single-operator deployment where the person who writes the automation is the
-- only person who could ever approve it.
--
-- An exemption that left no trace would quietly turn every approval history into
-- one that cannot be read: "approved by a second person" and "approved by its
-- own author under an override" would be the same row. So the override is
-- RECORDED, defaulting false, and every existing row keeps the stronger meaning.
--
-- ⚠ NOT NULL with a default rather than nullable: a null would be a third state
-- ("nobody wrote down whether this was overridden") on a column whose whole
-- purpose is to make the distinction unambiguous.
ALTER TABLE "flow_approvals"
  ADD COLUMN IF NOT EXISTS "self_approved_override" boolean NOT NULL DEFAULT false;
