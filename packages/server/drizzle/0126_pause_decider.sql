-- Sharing boundaries (plans/sharing-boundaries-2026-10-30, P1-I3): a Forge approval step may NAME who decides it
-- (`approval.decider`, a member's email). Resolved to that member's identity subject when the run pauses — never at
-- decision time, so a later change to the member list cannot reassign a pause already waiting. NULL: nobody named; the
-- run's own decider applies (whose account it used, else the workflow's owner).
ALTER TABLE "flow_step_approvals" ADD COLUMN IF NOT EXISTS "decider_subject" text;
