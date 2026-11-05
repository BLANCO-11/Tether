-- Workspace membership and roles — docs/GAPS.md §1.1.
--
-- Gate 2 and gate 3 refused SELF-approval and nothing else. There were no
-- roles, so anyone who could sign in could approve anything, and "a second pair
-- of eyes" meant only "a different string".
--
-- ⚠ EVERY EXISTING WORKSPACE STARTS WITH ZERO MEMBERS, and that is the whole
-- decision in this migration. There is no backfill, deliberately: backfilling
-- every signed-in identity as an admin would produce a role model that grants
-- the role to everyone, i.e. the control it replaces, with a table. Zero members
-- means approvals over HTTP are REFUSED on that workspace until somebody claims
-- it — fail-closed, visible on the first attempt, and fixed by one call to
-- POST /api/workspaces/:ws/members/claim.
--
-- The harnesses and seeds are unaffected: they call the services directly and
-- hold no identity, and the role check is a route-level authorisation on a
-- request (see workspace-member.service.ts for why it lives there).

CREATE TABLE IF NOT EXISTS workspace_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- The JWT `sub`. The stable identifier: an email can be reassigned, and a
  -- person who changes theirs must not silently become a different member.
  subject text NOT NULL,

  -- What gate 2 compares against `flow_revisions.created_by`, and what a human
  -- reads in the members list. Display and comparison; never identity.
  email text NOT NULL,

  -- author   — may write revisions. The default for a granted member.
  -- approver — may additionally approve a revision (gate 2) or a paused
  --            step (gate 3).
  -- admin    — may additionally grant and revoke membership.
  role text NOT NULL,

  -- Who granted it. The literal 'bootstrap' for the first member of an
  -- unclaimed workspace, so a claim is distinguishable from a grant for ever.
  granted_by text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  CONSTRAINT workspace_members_role_check CHECK (role IN ('author', 'approver', 'admin'))
);

-- One row per person per workspace. Two rows would mean two answers to "what
-- may this person do here", and the check would depend on row order.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_members_unique
  ON workspace_members (workspace_id, subject);

CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace
  ON workspace_members (workspace_id);
