/**
 * The labelled goal set for `build:measure` — phased-typed-build phase 0, D-250.
 *
 * Each goal carries the skeleton a PERSON would draw for it against the catalogue
 * as it stands on this deployment (read off `tools`, `datasource_operations` and
 * `datasource_queries` on 2026-09-23), and whether a refusal is the right answer.
 *
 * ⚠ **Labels were written from the catalogue, not from any draft.** The 2026-09-23
 * scratch run had already been read when these were written, so they are not
 * blind in the strict sense; the rule applied instead was that every ref below is
 * one the catalogue offers for the job, and no label was changed to match a
 * drafted flow. A correction is a new dated line with its reason, never an edit.
 *
 * ⚠ **PURE DATA** — no imports. A scenario's `main()` runs at import (CLAUDE.md),
 * so anything a test reads has to live somewhere that cannot drag the stack in.
 */

/**
 * One step a person would draw.
 *
 * A step is matched by `refs` when present (any drafted step whose ref is in the
 * list, whatever its kind — a DB operation and a tool are both "a read"), and by
 * `kind` otherwise (`approval`, `branch`, `transform`, `code`). A ref ending
 * `.*` matches ANY reader on that datasource, saved or generated — the drafter
 * writes a step-level reader from the schema when no saved one fits
 * (`fillGapsWithStepSql`), and its name is the model's choice.
 */
export interface LabelStep {
  /** A short name used by `edges`. Not compared with drafted step ids. */
  as: string;
  refs?: string[];
  kind?: string;
}

export interface BuildGoal {
  /** Stable id — quoted in results; never renumber. */
  id: string;
  /** Workspace NAME (ids differ per deployment). */
  workspace: string;
  goal: string;
  /** `draft` = the catalogue serves it. `refuse` = `insufficient_catalogue` is right. */
  expect: "draft" | "refuse";
  /** Required steps. Empty for a refusal. */
  steps: LabelStep[];
  /** `[a, b]` = b must be downstream of a (transitively). By `as`. */
  edges: Array<[string, string]>;
  /**
   * Extra drafted steps that do not count against the shape: any `transform`
   * always, plus steps whose ref is listed here (a second read a person might
   * reasonably add, `llm_complete` for a summary nobody asked to be verbatim).
   */
  mayAlsoUse?: string[];
  why: string;
}

const ATTENDANCE = ["hr_attendance_summary", "hr_attendance_daily", "hr_demo.employees_with_attendance", "hr_demo.attendance_period_rows"];
const EMAIL = ["tether_email_send", "mail_send", "mail_send_template", "test_email_send"];
const CHAT = ["chat_post_message"];

export const BUILD_GOALS: BuildGoal[] = [
  // ── HR — the reliability set (`reliability-goals.ts`), same ids and wording ──
  {
    id: "R01", workspace: "HR", expect: "draft",
    goal: "Every month, email employees whose attendance is below 80 percent a reminder",
    steps: [{ as: "read", refs: ATTENDANCE }, { as: "send", refs: EMAIL }],
    edges: [["read", "send"]],
    why: "Filter over a per-row rate, then fan-out email.",
  },
  {
    id: "R02", workspace: "HR", expect: "draft",
    goal: "Each month, find employees whose attendance is below their own department's threshold, and email each of them a warning",
    steps: [{ as: "read", refs: ATTENDANCE }, { as: "send", refs: EMAIL }],
    edges: [["read", "send"]],
    mayAlsoUse: ["hr_list_departments", ...ATTENDANCE],
    why: "Threshold from a second source; a second read is reasonable.",
  },
  {
    id: "R03", workspace: "HR", expect: "draft",
    goal: "List everyone in the Engineering department with their manager and work email",
    steps: [{ as: "read", refs: ["hr_list_employees"] }],
    edges: [],
    mayAlsoUse: ["hr_get_manager", "hr_list_departments", "hr_get_employee"],
    why: "The floor: one read, no delivery.",
  },
  {
    id: "R04", workspace: "HR", expect: "draft",
    goal: "Send the HR ops channel a weekly summary of how many people are below 80 percent attendance",
    steps: [{ as: "read", refs: ATTENDANCE }, { as: "post", refs: CHAT }],
    edges: [["read", "post"]],
    mayAlsoUse: ["llm_complete"],
    why: "A count, to a channel.",
  },
  {
    id: "R05", workspace: "HR", expect: "draft",
    goal: "Every month, write a short plain-English summary of the attendance situation and post it to the HR ops channel",
    steps: [{ as: "read", refs: ATTENDANCE }, { as: "write", refs: ["llm_complete"] }, { as: "post", refs: CHAT }],
    edges: [["read", "write"], ["write", "post"]],
    why: "`llm_complete` as a leaf-feeding summary (D-34).",
  },
  {
    id: "R06", workspace: "HR", expect: "draft",
    goal: "Each month, email employees below 80 percent attendance — but let a person review the list before anything is sent",
    steps: [{ as: "read", refs: ATTENDANCE }, { as: "gate", kind: "approval" }, { as: "send", refs: EMAIL }],
    edges: [["read", "gate"], ["gate", "send"]],
    why: "Gate 3 spliced BEFORE the send.",
  },
  {
    id: "R07", workspace: "HR", expect: "draft",
    goal: "Post to the HR ops channel every approved leave request that starts in a period I give, with the employee's name and the type of leave",
    steps: [{ as: "read", refs: ["hr_demo.*"] }, { as: "post", refs: CHAT }],
    edges: [["read", "post"]],
    mayAlsoUse: ["hr_list_employees", "hr_demo.*"],
    why:
      "No saved leave reader; `hr_demo.leave_requests` is introspected, so the drafter writes a " +
      "reader from the schema. ⚠ CORRECTED 2026-09-23 from `refuse`: that label predates " +
      "`fillGapsWithStepSql` and the rule \"use a saved reader if it exists, else create one from " +
      "the schema\" (D-258). Written before any in-repo round was scored.",
  },
  {
    id: "R08", workspace: "HR", expect: "draft",
    goal: "Email each employee their own attendance figure for last month",
    steps: [{ as: "read", refs: ATTENDANCE }, { as: "send", refs: EMAIL }],
    edges: [["read", "send"]],
    mayAlsoUse: ["hr_list_employees"],
    why: "Fan-out, no filter.",
  },
  {
    id: "R09", workspace: "HR", expect: "draft",
    goal: "Find employees with no work email recorded and tell the HR ops channel who they are",
    steps: [{ as: "read", refs: ["hr_list_employees", "hr_demo.employees_with_attendance"] }, { as: "post", refs: CHAT }],
    edges: [["read", "post"]],
    why: "A null filter, then one post.",
  },
  {
    id: "R10", workspace: "HR", expect: "draft",
    goal: "Every month, check attendance against each department's threshold, ask a person to confirm, then email the people who are below it and post a count to the HR ops channel",
    steps: [
      { as: "read", refs: ATTENDANCE }, { as: "gate", kind: "approval" },
      { as: "send", refs: EMAIL }, { as: "post", refs: CHAT },
    ],
    edges: [["read", "gate"], ["gate", "send"], ["gate", "post"]],
    mayAlsoUse: ["hr_list_departments", ...ATTENDANCE],
    why: "Two deliveries, both behind one gate.",
  },
  {
    id: "R11", workspace: "HR", expect: "draft",
    goal: "Notify the HR ops channel when someone's attendance drops below 80 percent",
    steps: [{ as: "read", refs: ATTENDANCE }, { as: "post", refs: CHAT }],
    edges: [["read", "post"]],
    why: "A guarded post; a `branch` is optional (any transform/branch extra is fine).",
  },
  {
    id: "R12", workspace: "HR", expect: "refuse",
    goal: "Look up which office each employee sits in and post the desk occupancy per floor to the HR ops channel",
    steps: [], edges: [],
    why: "Declared a refusal in `reliability-goals.ts` (control 2); kept as declared.",
  },

  // ── Cross-domain ──
  {
    id: "F1", workspace: "Finance", expect: "draft",
    goal: "Every Monday, email each vendor with past-due invoices a reminder listing their invoice numbers and amounts",
    steps: [{ as: "read", refs: ["finance_demo.invoices_past_due", "finance_demo.invoices_overdue"] }, { as: "send", refs: EMAIL }],
    edges: [["read", "send"]],
    mayAlsoUse: ["finance_demo.vendor_terms"],
    why: "Group rows by vendor, one mail per vendor. A transform can group; a code step is also acceptable.",
  },
  {
    id: "F2", workspace: "Finance", expect: "draft",
    goal: "Post a plain-English monthly summary of spend by cost centre to the finance channel",
    steps: [
      { as: "read", refs: ["finance_demo.centre_spend_sums", "finance_demo.spend_by_cost_centre"] },
      { as: "write", refs: ["llm_complete"] }, { as: "post", refs: CHAT },
    ],
    edges: [["read", "write"], ["write", "post"]],
    why: "Read → summarise → post.",
  },
  {
    id: "F3", workspace: "Finance", expect: "draft",
    goal: "Raise a ticket for every expense claim over policy this period",
    steps: [{ as: "read", refs: ["finance_demo.claims_over_policy", "finance_demo.claim_period_rows"] }, { as: "raise", refs: ["ticket_create"] }],
    edges: [["read", "raise"]],
    why: "The named query resolves the policy trap; fan-out tickets.",
  },
  {
    id: "L1", workspace: "Legal", expect: "draft",
    goal: "Each week, email the owner of every contract whose renewal notice deadline is coming up",
    steps: [{ as: "read", refs: ["legal_demo.contracts_renewal_due", "legal_demo.contracts_expiring_no_autorenew"] }, { as: "send", refs: EMAIL }],
    edges: [["read", "send"]],
    mayAlsoUse: ["legal_demo.contracts_renewal_due", "legal_demo.contracts_expiring_no_autorenew"],
    why: "Both deadline queries are defensible; owner addresses are in the rows.",
  },
  {
    id: "L2", workspace: "Legal", expect: "draft",
    goal: "Post the obligations due this month to the legal channel",
    steps: [{ as: "read", refs: ["legal_demo.obligations_due"] }, { as: "post", refs: CHAT }],
    edges: [["read", "post"]],
    mayAlsoUse: ["llm_complete"],
    why: "One read, one post.",
  },
  {
    id: "I1", workspace: "IT Operations", expect: "draft",
    goal: "Every 15 minutes, page on-call for incidents that have breached their SLA",
    steps: [{ as: "read", refs: ["itops_demo.incidents_sla_breached", "itops_demo.incident_sla_rows"] }, { as: "page", refs: ["page_oncall"] }],
    edges: [["read", "page"]],
    mayAlsoUse: ["itops_demo.oncall_now", "itops_demo.oncall_roster_rows"],
    why: "Paging dedupes; retry-safe.",
  },
  {
    id: "I2", workspace: "IT Operations", expect: "draft",
    goal: "Open a ticket for each actionable production vulnerability",
    steps: [{ as: "read", refs: ["itops_demo.vulns_actionable_prod", "itops_demo.vuln_finding_rows"] }, { as: "raise", refs: ["ticket_create"] }],
    edges: [["read", "raise"]],
    mayAlsoUse: ["itops_demo.changes_blocked_by_freeze"],
    why: "One read, fan-out tickets.",
  },
  {
    id: "S1", workspace: "Customer Support", expect: "draft",
    goal: "Email the support leads a daily digest of tickets opened since yesterday",
    steps: [{ as: "read", refs: ["support_demo.tickets_opened_since"] }, { as: "send", refs: EMAIL }],
    edges: [["read", "send"]],
    mayAlsoUse: ["llm_complete"],
    why: "Digest may be summarised; recipients are an input.",
  },
  {
    id: "S2", workspace: "Customer Support", expect: "draft",
    goal: "Post CSAT scores by team to the support channel every week",
    steps: [{ as: "read", refs: ["support_demo.csat_scores"] }, { as: "post", refs: CHAT }],
    edges: [["read", "post"]],
    mayAlsoUse: ["llm_complete"],
    why: "`csat_scores` is the reader.",
  },
  {
    id: "O1", workspace: "Orders & Fulfilment", expect: "draft",
    goal: "Email customers whose orders are past the promised date to apologise",
    steps: [{ as: "read", refs: ["orders_demo.orders_past_promised_date"] }, { as: "send", refs: EMAIL }],
    edges: [["read", "send"]],
    why: "Reader projects the address.",
  },
  {
    id: "O2", workspace: "Orders & Fulfilment", expect: "draft",
    goal: "Raise a warehouse ticket for each item below its stock threshold",
    steps: [{ as: "read", refs: ["orders_demo.stock_below_threshold"] }, { as: "raise", refs: ["ticket_create"] }],
    edges: [["read", "raise"]],
    why: "The reader exists by name; a refusal here is false (I-201).",
  },
  {
    id: "C1", workspace: "Recruitment", expect: "draft",
    goal: "Send a weekly report of candidates who received job offers to the recruiting channel",
    steps: [{ as: "read", refs: ["ML_ZERO_DB.*"] }, { as: "post", refs: CHAT }],
    edges: [["read", "post"]],
    mayAlsoUse: ["llm_complete", "ML_ZERO_DB.*"],
    why:
      "No saved reader, but `ML_ZERO_DB` carries offer tables (`offer_and_fitment`, …), so a " +
      "generated reader is right. ⚠ CORRECTED 2026-09-23 from `refuse`, same reason as R07. " +
      "Its draft run is refused by the 25-table mock cap (I-200) — an `environment` failure.",
  },
];
