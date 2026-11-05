export const PACK = {
  eyebrow: "LEAVE MANAGEMENT DB \u00b7 SCHEMA V3",
  title: "Dependency impact report",
  purpose: "Four workflows use the changed approval field. Nothing updates until each owner reviews the impact.",
  submitLabel: "Submit resource change",
  noticeTitle: "Headcount reconciliation is blocked",
  noticeBody: "It reads `approved_flag` as a boolean and has no rule for PENDING.",
  heads: ["WORKFLOW", "OWNER", "FIELD USE", "IMPACT", "REQUIRED ACTION"] as const,
  rows: [
    {
      workflow: "Contractor timesheet chase",
      owner: "Meera Iyer",
      fieldUse: "approved_flag",
      impact: "Blocked",
      action: "Map PENDING before next run",
    },
    {
      workflow: "Monthly back-to-office compliance",
      owner: "Meera Iyer",
      fieldUse: "approval_status = true",
      impact: "Review",
      action: "Confirm existing behaviour",
    },
    {
      workflow: "Leave balance monthly digest",
      owner: "Meera Iyer",
      fieldUse: "approved_flag",
      impact: "Review",
      action: "Confirm existing behaviour",
    },
    {
      workflow: "Headcount reconciliation",
      owner: "Devika Menon",
      fieldUse: "approval_status = true",
      impact: "Review",
      action: "Confirm existing behaviour",
    },
  ] as const,
  successTitle: "Change submitted for owner review",
  successBody:
    "Each of the four dependent workflow owners has been notified. Nothing changes in production until every one of them has reviewed the impact.",
} as const;
