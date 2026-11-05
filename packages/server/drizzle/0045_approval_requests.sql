-- B-14 · S-37 Approvals inbox — unified approval_requests queue (one queue, six types)
-- ⚠ approval_requests is not flow_approvals — separate table (phases/10, phasing requires distinct binding)
-- Six types: exception (EXC-), publication (PUB-), access_request (ACC-), recovery (REC-), policy_exception (POL-), resource_change (RES-)
-- approval_policy: all | any | quorum (UX-005)
CREATE TABLE IF NOT EXISTS "approval_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "type" text NOT NULL CHECK ("type" IN ('exception','publication','access_request','recovery','policy_exception','resource_change')),
  "subject_entity_type" text NOT NULL,
  "subject_entity_id" text NOT NULL,
  "subject_label" text NOT NULL,
  "requester_subject" text NOT NULL,
  "risk" text NOT NULL CHECK ("risk" IN ('low','medium','high')),
  "raised_at" timestamp with time zone DEFAULT now() NOT NULL,
  "due_at" timestamp with time zone,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','approved','rejected','withdrawn')),
  "approval_policy" text NOT NULL CHECK ("approval_policy" IN ('all','any','quorum'))
);
CREATE INDEX IF NOT EXISTS "idx_approval_requests_workspace_status" ON "approval_requests" ("workspace_id","status");
CREATE INDEX IF NOT EXISTS "idx_approval_requests_workspace_requester" ON "approval_requests" ("workspace_id","requester_subject");

CREATE TABLE IF NOT EXISTS "approval_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "request_id" uuid NOT NULL REFERENCES "approval_requests"("id") ON DELETE CASCADE,
  "approver_subject" text NOT NULL,
  "role" text NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('approved','rejected')),
  "comment" text,
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_approval_decisions_request" ON "approval_decisions" ("request_id");
