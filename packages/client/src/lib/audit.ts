// src/lib/audit.ts — audit explorer helpers (S-68).
// The pack captures two views of ONE immutable record: Plain English and Raw events.
// Every row carries its raw event behind a per-row disclosure.
// Operations: create · update · delete · publish · approve · reject · access · execute.
// Entity is an enum; where is a breadcrumb path (not prose).

export type AuditOperation =
  | "create"
  | "update"
  | "delete"
  | "publish"
  | "approve"
  | "reject"
  | "access"
  | "execute";

export type FDAuditEvent = {
  id: string;
  time: string; // ISO
  actor: string;
  operation: AuditOperation;
  entity: string;
  entityId?: string;
  description: string;
  where: string;
  raw?: unknown;
};

// Keep the formatter pure for testing and for the mono WHEN column.
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.getDate();
  const month = d.toLocaleString("en-GB", { month: "short" });
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${day} ${month}, ${hh}:${mm}`;
}

export const AUDIT_OPERATIONS: readonly AuditOperation[] = [
  "create",
  "update",
  "delete",
  "publish",
  "approve",
  "reject",
  "access",
  "execute",
] as const;

export function isAuditOperation(v: string): v is AuditOperation {
  return (AUDIT_OPERATIONS as readonly string[]).includes(v);
}

// The nine rows from S-68 § Copy — used as seeded fixture when the server has no table yet.
// They cover all five WHERE shapes and include System as a first-class actor.
export const AUDIT_FIXTURE: readonly FDAuditEvent[] = [
  {
    id: "evt-001",
    time: "2026-08-11T15:02:00.000Z",
    actor: "Devika Menon",
    operation: "update",
    entity: "workflow",
    entityId: "monthly-bto",
    description: "Changed how step 2 handles a failure on Monthly back-to-office compliance",
    where: "Monthly back-to-office compliance · v4 draft",
  },
  {
    id: "evt-002",
    time: "2026-08-11T11:32:00.000Z",
    actor: "Meera Iyer",
    operation: "execute",
    entity: "workflow",
    entityId: "monthly-bto",
    description: "Ran a test on mock data — it passed",
    where: "Monthly back-to-office compliance · v4 draft",
  },
  {
    id: "evt-003",
    time: "2026-08-11T09:02:00.000Z",
    actor: "Meera Iyer",
    operation: "create",
    entity: "workflow",
    entityId: "monthly-bto",
    description: "Asked the assistant to draft a monthly attendance workflow",
    where: "Monthly back-to-office compliance · v4 draft",
  },
  {
    id: "evt-004",
    time: "2026-08-09T16:02:00.000Z",
    actor: "Devika Menon",
    operation: "create",
    entity: "resource",
    entityId: "leave-db",
    description: "Submitted a breaking change to Leave management DB for review",
    where: "Resources · Leave management DB",
  },
  {
    id: "evt-005",
    time: "2026-08-09T10:15:00.000Z",
    actor: "Meera Iyer",
    operation: "access",
    entity: "resource",
    entityId: "payroll-extract",
    description: "Requested read access to Payroll extract",
    where: "Resources · Payroll extract",
  },
  {
    id: "evt-006",
    time: "2026-08-08T07:03:00.000Z",
    actor: "System",
    operation: "execute",
    entity: "run",
    entityId: "RUN-2026-08-08-0714",
    description: "Contractor timesheet chase failed at step 4",
    where: "Contractor timesheet chase · RUN-2026-08-08-0714",
  },
  {
    id: "evt-007",
    time: "2026-08-06T12:30:00.000Z",
    actor: "Meera Iyer",
    operation: "create",
    entity: "policy",
    entityId: "ai-change-approval",
    description: "Requested a policy exception to use autonomous mode",
    where: "Admin · Policies · AI change approval",
  },
  {
    id: "evt-008",
    time: "2026-08-03T11:20:00.000Z",
    actor: "Anita Rao",
    operation: "approve",
    entity: "approval",
    entityId: "EXC-2026-07-0042",
    description: "Approved Rahul Desai's July attendance exception",
    where: "Approvals · EXC-2026-07-0042",
  },
  {
    id: "evt-009",
    time: "2026-08-02T14:05:00.000Z",
    actor: "Devika Menon",
    operation: "access",
    entity: "resource",
    entityId: "hris-employee-master",
    description: "Granted Christopher Adebayo-Fernandes read access to HRIS employee master",
    where: "Resources · HRIS employee master",
  },
] as const;
