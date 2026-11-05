-- B-08 reviewed_templates + B-09 chips most-used derived, 5 concurrent max.
-- Platform table, workspace scoping for copies (flow_templates) remains separate.
CREATE TABLE IF NOT EXISTS "reviewed_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "eyebrow" text,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "includes" text[],
  "usage_count" integer DEFAULT 0 NOT NULL,
  "is_curated" boolean DEFAULT false NOT NULL,
  "review_status" text,
  "created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_reviewed_templates_slug" ON "reviewed_templates" ("slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reviewed_templates_curated" ON "reviewed_templates" ("is_curated");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reviewed_templates_usage" ON "reviewed_templates" ("usage_count" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reviewed_templates_name" ON "reviewed_templates" USING btree ("name");
--> statement-breakpoint
INSERT INTO "reviewed_templates" ("slug","eyebrow","name","description","includes","usage_count","is_curated","review_status") VALUES
('monthly-compliance-check', 'REVIEWED', 'Monthly compliance check', 'Run monthly back-to-office compliance and notify exceptions.', ARRAY['Policy evaluation','Exception handling','Notifications']::text[], 120, true, 'reviewed'),
('chase-missing-submissions', 'REVIEWED', 'Chase missing submissions', 'Chase employees with missing timesheets or submissions and escalate.', ARRAY['Data collection','Reminders','Escalation']::text[], 95, true, 'reviewed'),
('new-joiner-setup', 'REVIEWED', 'New joiner setup', 'Automate new joiner onboarding across systems and notify stakeholders.', ARRAY['Account creation','Access provisioning','Welcome email']::text[], 110, true, 'reviewed'),
('monthly-compliance-report', 'REVIEWED', 'Monthly compliance report', 'Generate and distribute the monthly compliance report.', ARRAY['Report generation','Distribution','Audit log']::text[], 980, false, 'reviewed'),
('chase-missing-timesheets', 'REVIEWED', 'Chase missing timesheets', 'Remind and escalate missing timesheets before payroll lock.', ARRAY['Timesheet check','Reminders','Escalation']::text[], 870, false, 'reviewed'),
('weekly-leave-digest', 'REVIEWED', 'Weekly leave digest', 'Summarise weekly leave and share the digest with managers.', ARRAY['Leave aggregation','Digest email','Manager view']::text[], 750, false, 'reviewed'),
('expense-policy-breach-digest', 'REVIEWED', 'Expense policy breach digest', 'Detect expense policy breaches and send a digest.', ARRAY['Policy check','Breach detection','Digest']::text[], 720, false, 'reviewed'),
('payroll-extract-validation', 'REVIEWED', 'Payroll extract validation', 'Validate payroll extracts against HRIS and flag anomalies.', ARRAY['Extract fetch','Validation','Anomaly flagging']::text[], 640, false, 'reviewed'),
('attendance-swipe-reconciliation', 'REVIEWED', 'Attendance swipe reconciliation', 'Reconcile attendance swipes with leave and holidays.', ARRAY['Swipe ingestion','Reconciliation','Exception report']::text[], 600, false, 'reviewed'),
('leave-balance-sync', 'REVIEWED', 'Leave balance sync', 'Sync leave balances across systems and notify on drift.', ARRAY['Balance fetch','Sync','Notification']::text[], 580, false, 'reviewed'),
('onboarding-checklist', 'REVIEWED', 'Onboarding checklist', 'Track onboarding tasks and chase owners for completion.', ARRAY['Task list','Owner chase','Progress report']::text[], 560, false, 'reviewed'),
('offboarding-workflow', 'REVIEWED', 'Offboarding workflow', 'Orchestrate offboarding steps and revoke access.', ARRAY['Checklist','Access revocation','Handover']::text[], 540, false, 'reviewed'),
('quarterly-access-review', 'REVIEWED', 'Quarterly access review', 'Run quarterly access reviews and collect attestations.', ARRAY['Access inventory','Review request','Attestation']::text[], 520, false, 'reviewed'),
('vendor-invoice-approval', 'REVIEWED', 'Vendor invoice approval', 'Route vendor invoices for approval and post to ledger.', ARRAY['Invoice ingestion','Approval routing','Posting']::text[], 500, false, 'reviewed'),
('budget-variance-report', 'REVIEWED', 'Budget variance report', 'Compare budget vs actuals and highlight variances.', ARRAY['Budget fetch','Variance calc','Report']::text[], 480, false, 'reviewed'),
('headcount-report', 'REVIEWED', 'Headcount report', 'Produce headcount and movement report by department.', ARRAY['HRIS query','Aggregation','Distribution']::text[], 460, false, 'reviewed'),
('performance-review-reminders', 'REVIEWED', 'Performance review reminders', 'Remind managers and chase overdue performance reviews.', ARRAY['Review schedule','Reminders','Escalation']::text[], 440, false, 'reviewed'),
('training-compliance-tracker', 'REVIEWED', 'Training compliance tracker', 'Track training completion and chase non-compliant staff.', ARRAY['Training records','Compliance check','Chase']::text[], 420, false, 'reviewed'),
('asset-assignment', 'REVIEWED', 'Asset assignment', 'Assign assets to joiners and track acknowledgement.', ARRAY['Asset inventory','Assignment','Acknowledgement']::text[], 400, false, 'reviewed'),
('credential-expiry-alerts', 'REVIEWED', 'Credential expiry alerts', 'Alert owners of expiring credentials and track renewal.', ARRAY['Credential scan','Expiry check','Alerts']::text[], 380, false, 'reviewed'),
('incident-escalation', 'REVIEWED', 'Incident escalation', 'Escalate incidents based on severity and notify on-call.', ARRAY['Incident fetch','Severity routing','Notification']::text[], 360, false, 'reviewed'),
('customer-onboarding', 'REVIEWED', 'Customer onboarding', 'Automate customer onboarding and provision resources.', ARRAY['Provisioning','Welcome flow','Tracking']::text[], 340, false, 'reviewed'),
('contract-renewal-reminder', 'REVIEWED', 'Contract renewal reminder', 'Remind owners of upcoming contract renewals.', ARRAY['Contract scan','Reminder','Escalation']::text[], 320, false, 'reviewed'),
('purchase-order-approval', 'REVIEWED', 'Purchase order approval', 'Route purchase orders for approval and create records.', ARRAY['PO creation','Approval','Record']::text[], 300, false, 'reviewed'),
('travel-request-workflow', 'REVIEWED', 'Travel request workflow', 'Process travel requests and book approvals.', ARRAY['Request intake','Approval','Booking']::text[], 280, false, 'reviewed'),
('expense-reimbursement', 'REVIEWED', 'Expense reimbursement', 'Process expense reimbursements and notify finance.', ARRAY['Expense intake','Validation','Reimbursement']::text[], 260, false, 'reviewed'),
('time-off-request', 'REVIEWED', 'Time off request', 'Handle time-off requests with manager approval.', ARRAY['Request form','Manager approval','Calendar sync']::text[], 240, false, 'reviewed'),
('shift-schedule-sync', 'REVIEWED', 'Shift schedule sync', 'Sync shift schedules and notify on changes.', ARRAY['Schedule fetch','Sync','Notification']::text[], 220, false, 'reviewed'),
('benefits-enrollment', 'REVIEWED', 'Benefits enrollment', 'Guide benefits enrollment and track completion.', ARRAY['Enrollment flow','Tracking','Reminders']::text[], 200, false, 'reviewed'),
('compliance-training-digest', 'REVIEWED', 'Compliance training digest', 'Send periodic compliance training digests.', ARRAY['Training status','Digest','Reminders']::text[], 180, false, 'reviewed'),
('security-awareness-reminder', 'REVIEWED', 'Security awareness reminder', 'Send security awareness reminders and track acknowledgement.', ARRAY['Content delivery','Tracking','Follow-up']::text[], 160, false, 'reviewed'),
('data-retention-cleanup', 'REVIEWED', 'Data retention cleanup', 'Identify stale data and trigger retention cleanup.', ARRAY['Scan','Policy check','Cleanup']::text[], 140, false, 'reviewed'),
('policy-exception-request', 'REVIEWED', 'Policy exception request', 'Collect policy exception requests and route for approval.', ARRAY['Request intake','Approval routing','Audit']::text[], 130, false, 'reviewed'),
('resource-access-audit', 'REVIEWED', 'Resource access audit', 'Audit resource access and report over-privileged accounts.', ARRAY['Access scan','Audit','Report']::text[], 100, false, 'reviewed')
ON CONFLICT ("slug") DO NOTHING;
