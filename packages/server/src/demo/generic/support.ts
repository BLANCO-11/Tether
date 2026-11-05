/**
 * ─────────────────────────────────────────────────────────────────────────────
 * CUSTOMER SUPPORT — the fifth domain
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ **THE TRAP: A NON-RESPONSE IS NOT A SATISFIED CUSTOMER, AND AVERAGING SAYS
 * IT IS.** CSAT is collected by survey. Most people do not answer, and the ones
 * who do are not a random sample. So `avg(score)` over the responses is
 * arithmetically correct and answers a question nobody asked — it is the mean
 * score *among people who replied*, which here flatters a team whose response
 * rate is a fraction of its surveys.
 *
 * `csat_by_team` therefore returns `response_rate_pct` beside `avg_score` and
 * `responses` beside `surveys_sent`, and says a score without a response rate is
 * not an answer. This is `hr_demo`'s employee #14 in a fifth domain: the obvious
 * query returns a plausible number and the plausible number is wrong.
 *
 * ⚠ **THE SECOND TRAP: PRIORITY IS ESCALATED MID-LIFE.** A ticket opened
 * `normal` and escalated to `urgent` is measured against the URGENT budget, not
 * the one that applied when it opened. Using the opening priority is the
 * intuitive reading and it under-reports breaches — the tickets that got
 * escalated are precisely the ones somebody was worried about.
 *
 * ⚠ **THE THIRD: THE BUDGET IS KEYED ON (plan, priority), TWO COLUMNS.** An
 * enterprise 'urgent' allows 30 minutes to first response and a starter 'urgent'
 * allows 240. Both are "urgent", so a priority-only lookup returns a plausible
 * number for the wrong customer — `sla_policies` in the IT Operations domain,
 * reproduced here so the rule has to be read rather than remembered.
 *
 * ⚠ **ALL DATA IS SYNTHETIC.** Invented names on RFC 2606 reserved `.example`
 * domains, which cannot resolve or receive mail.
 */
import type { DomainSpec } from "./domain.js";

const DDL = `
DROP TABLE IF EXISTS csat_responses, ticket_events, tickets, customers, agents, teams, sla_policies, org_settings CASCADE;

CREATE TABLE org_settings (
  id                          int PRIMARY KEY,
  default_first_response_mins int NOT NULL,
  default_resolve_mins        int NOT NULL,
  csat_survey_after_hours     int NOT NULL
);

CREATE TABLE teams (
  code          text PRIMARY KEY,
  name          text NOT NULL,
  contact_email text NOT NULL
);

CREATE TABLE agents (
  id         int PRIMARY KEY,
  full_name  text NOT NULL,
  work_email text,
  team_code  text REFERENCES teams(code),
  active     boolean NOT NULL DEFAULT true
);

CREATE TABLE customers (
  id    int PRIMARY KEY,
  name  text NOT NULL,
  email text,
  plan  text NOT NULL
);

CREATE TABLE sla_policies (
  plan                text NOT NULL,
  priority            text NOT NULL,
  first_response_mins int NOT NULL,
  resolve_mins        int NOT NULL,
  PRIMARY KEY (plan, priority)
);

CREATE TABLE tickets (
  id                int PRIMARY KEY,
  ticket_code       text UNIQUE NOT NULL,
  customer_id       int REFERENCES customers(id),
  team_code         text REFERENCES teams(code),
  assignee_id       int REFERENCES agents(id),
  subject           text NOT NULL,
  priority          text NOT NULL,
  opened_priority   text NOT NULL,
  status            text NOT NULL,
  opened_at         timestamptz NOT NULL,
  first_response_at timestamptz,
  resolved_at       timestamptz
);

CREATE TABLE ticket_events (
  id        int PRIMARY KEY,
  ticket_id int REFERENCES tickets(id),
  kind      text NOT NULL,
  at        timestamptz NOT NULL,
  detail    text
);

CREATE TABLE csat_responses (
  id        int PRIMARY KEY,
  ticket_id int REFERENCES tickets(id),
  surveyed  boolean NOT NULL,
  score     int,
  comment   text
);
`;

const at = (day: number, hour: number) =>
  `2026-06-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`;

const TEAMS: unknown[][] = [
  ["billing", "Billing Support", "billing-support@acme-support.example"],
  ["tech", "Technical Support", "tech-support@acme-support.example"],
  ["onboard", "Onboarding", "onboarding@acme-support.example"],
];

const AGENTS: unknown[][] = [
  [1, "Rita Alvarez", "rita.alvarez@acme-support.example", "billing", true],
  [2, "Tom Beckett", "tom.beckett@acme-support.example", "billing", true],
  [3, "Ana Silva", "ana.silva@acme-support.example", "tech", true],
  [4, "Dev Prasad", "dev.prasad@acme-support.example", "tech", true],
  // ⚠ No work email — a contractor. Anything that emails assignees must cope,
  // exactly as the HR domain's contractor forces it to.
  [5, "Jo Nkemdirim", null, "onboard", true],
  [6, "Marek Novak", "marek.novak@acme-support.example", "onboard", false],
];

const CUSTOMERS: unknown[][] = [
  [1, "Northwind Traders", "ops@northwind.example", "enterprise"],
  [2, "Contoso Ltd", "help@contoso.example", "enterprise"],
  [3, "Fabrikam Inc", "support@fabrikam.example", "business"],
  [4, "Tailspin Toys", "team@tailspin.example", "business"],
  [5, "Wingtip Papers", null, "starter"],
  [6, "Lucerne Publishing", "hello@lucerne.example", "starter"],
];

const SLA: unknown[][] = [
  ["enterprise", "urgent", 30, 240],
  ["enterprise", "high", 60, 480],
  ["enterprise", "normal", 240, 1440],
  ["business", "urgent", 60, 480],
  ["business", "high", 120, 960],
  ["business", "normal", 480, 2880],
  ["starter", "urgent", 240, 1440],
  ["starter", "high", 480, 2880],
  ["starter", "normal", 1440, 5760],
];

/**
 * ⚠ **T-1006 IS THE ESCALATION TRAP.** Opened `normal` on an enterprise plan
 * (1440-minute resolve budget), escalated to `urgent` (240). By the default
 * as-of it has consumed far more than the budget that now applies and far less
 * than the one it opened with — so reading `opened_priority` says it is fine.
 */
const TICKETS: unknown[][] = [
  [1001, "T-1001", 1, "billing", 1, "Invoice shows the wrong currency", "high", "high", "resolved", at(1, 9), at(1, 9), at(1, 14)],
  [1002, "T-1002", 1, "tech", 3, "API returns 500 on bulk export", "urgent", "urgent", "resolved", at(2, 8), at(2, 8), at(2, 10)],
  [1003, "T-1003", 2, "tech", 4, "SSO login loop after password reset", "urgent", "urgent", "open", at(3, 7), at(3, 8), null],
  [1004, "T-1004", 3, "billing", 2, "Duplicate charge on renewal", "high", "high", "resolved", at(3, 11), at(3, 12), at(4, 15)],
  [1005, "T-1005", 4, "onboard", 5, "Cannot import the starter template", "normal", "normal", "open", at(4, 10), at(4, 13), null],
  [1006, "T-1006", 2, "tech", 3, "Reports time out for large accounts", "urgent", "normal", "open", at(4, 9), at(4, 10), null],
  [1007, "T-1007", 5, "onboard", 5, "Welcome email never arrived", "normal", "normal", "open", at(5, 9), null, null],
  [1008, "T-1008", 6, "billing", 1, "Where do I download receipts", "normal", "normal", "resolved", at(5, 10), at(5, 11), at(5, 16)],
  [1009, "T-1009", 1, "tech", 4, "Webhook retries are duplicating", "high", "high", "open", at(6, 8), at(6, 9), null],
  [1010, "T-1010", 3, "tech", 3, "Search index is stale by a day", "normal", "normal", "resolved", at(8, 9), at(8, 14), at(10, 11)],
  [1011, "T-1011", 4, "billing", 2, "Tax rate wrong for our region", "high", "high", "open", at(9, 9), at(9, 10), null],
  [1012, "T-1012", 2, "onboard", 5, "Need a second sandbox", "normal", "normal", "resolved", at(9, 12), at(9, 15), at(11, 10)],
  [1013, "T-1013", 6, "tech", 4, "Mobile app crashes on upload", "urgent", "urgent", "open", at(10, 8), at(10, 14), null],
  [1014, "T-1014", 5, "billing", 1, "Cancel our plan", "normal", "normal", "resolved", at(11, 9), at(11, 10), at(11, 13)],
  [1015, "T-1015", 1, "onboard", 5, "Bulk user provisioning fails", "high", "high", "open", at(12, 9), null, null],
  [1016, "T-1016", 3, "tech", 3, "Rate limit hit at 100 rps", "normal", "normal", "resolved", at(12, 11), at(12, 12), at(13, 9)],
  [1017, "T-1017", 4, "onboard", 5, "Training session reschedule", "normal", "normal", "resolved", at(13, 10), at(13, 11), at(13, 15)],
  [1018, "T-1018", 2, "billing", 2, "PO number missing on invoice", "normal", "normal", "open", at(14, 9), at(14, 10), null],
];

const EVENTS: unknown[][] = [
  [1, 1006, "escalated", at(4, 12), "normal -> urgent, customer escalated to their account manager"],
  [2, 1003, "reassigned", at(3, 9), "billing -> tech"],
  [3, 1013, "escalated", at(10, 9), "high -> urgent"],
];

/**
 * ⚠ **THE RESPONSE RATE IS DELIBERATELY LOPSIDED.** Nine tickets were answered
 * and nine were surveyed and ignored. A leaderboard built on `avg_score` alone
 * ranks teams on a handful of replies; adding the response rate makes the number
 * unusable, which is the correct outcome.
 */
const CSAT: unknown[][] = [
  [1, 1001, true, 5, "Sorted quickly"],
  [2, 1002, true, 4, null],
  [3, 1004, true, 2, "Took two days and I had to chase"],
  [4, 1008, true, 5, null],
  [5, 1010, true, 3, null],
  [6, 1012, true, 5, "Very helpful"],
  [7, 1014, true, 1, "Cancelling because of this"],
  [8, 1016, true, 4, null],
  [9, 1017, true, 5, null],
  [10, 1005, true, null, null],
  [11, 1007, true, null, null],
  [12, 1015, true, null, null],
  [13, 1003, true, null, null],
  [14, 1009, true, null, null],
  [15, 1011, true, null, null],
  [16, 1013, true, null, null],
  [17, 1018, true, null, null],
  [18, 1006, true, null, null],
];

const AS_OF = {
  as_of: { type: "string", required: true, description: "Instant to measure against, ISO-8601." },
};

/**
 * ⚠ **Joins on `(plan, priority)` and uses `t.priority` — the CURRENT priority,
 * never `opened_priority`.** Both trap choices are resolved HERE rather than
 * left to a flow, for the reason the IT Operations domain states: a trap
 * resolved in the catalogue is structurally unreachable, and a trap left for a
 * fragment to remember is one the measured baseline says will be missed.
 */
const SCORED = `
scored AS (
  SELECT t.id, t.ticket_code, t.subject, t.status, t.team_code, t.priority,
         t.opened_priority, c.name AS customer_name, c.plan, c.email AS customer_email,
         a.full_name AS assignee_name, a.work_email AS assignee_email, a.active AS assignee_active,
         tm.contact_email AS team_email,
         t.opened_at, t.first_response_at, t.resolved_at,
         COALESCE(p.first_response_mins, o.default_first_response_mins) AS first_response_budget_mins,
         COALESCE(p.resolve_mins, o.default_resolve_mins)               AS resolve_budget_mins,
         GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - t.opened_at)) / 60)::int AS age_mins
    FROM tickets t
    JOIN customers c ON c.id = t.customer_id
    LEFT JOIN agents a ON a.id = t.assignee_id
    LEFT JOIN teams tm ON tm.code = t.team_code
    LEFT JOIN sla_policies p ON p.plan = c.plan AND p.priority = t.priority
    CROSS JOIN org_settings o
   WHERE o.id = 1
)`;

export const SUPPORT_DOMAIN: DomainSpec = {
  key: "support",
  workspaceName: "Customer Support",
  dbName: "support_demo",
  roRole: "support_ro",
  secretEnv: "SUPPORT_DB_URL",
  description:
    "A support desk: tickets, SLA budgets that depend on the customer's plan as well as the " +
    "ticket's priority, and satisfaction scores that mean nothing without the response rate " +
    "beside them.",
  opsServices: ["mail", "chat", "ticketing", "llm"],
  ddl: DDL,
  tables: [
    { table: "org_settings", columns: ["id", "default_first_response_mins", "default_resolve_mins", "csat_survey_after_hours"], rows: [[1, 480, 2880, 24]] },
    { table: "teams", columns: ["code", "name", "contact_email"], rows: TEAMS },
    { table: "agents", columns: ["id", "full_name", "work_email", "team_code", "active"], rows: AGENTS },
    { table: "customers", columns: ["id", "name", "email", "plan"], rows: CUSTOMERS },
    { table: "sla_policies", columns: ["plan", "priority", "first_response_mins", "resolve_mins"], rows: SLA },
    { table: "tickets", columns: ["id", "ticket_code", "customer_id", "team_code", "assignee_id", "subject", "priority", "opened_priority", "status", "opened_at", "first_response_at", "resolved_at"], rows: TICKETS },
    { table: "ticket_events", columns: ["id", "ticket_id", "kind", "at", "detail"], rows: EVENTS },
    { table: "csat_responses", columns: ["id", "ticket_id", "surveyed", "score", "comment"], rows: CSAT },
  ],
  queries: [
    {
      name: "tickets_awaiting_first_reply",
      description:
        "Open tickets nobody has replied to yet that are already past the first-response budget " +
        "for their customer's PLAN and their CURRENT priority. The budget is a two-column " +
        "lookup: an enterprise 'urgent' allows 30 minutes and a starter 'urgent' allows 240, so " +
        "a priority-only lookup lands on a plausible number for the wrong customer.",
      sqlText: `WITH${SCORED}
SELECT ticket_code, subject, customer_name, plan, priority, team_code, team_email,
       assignee_name, assignee_email, age_mins, first_response_budget_mins,
       (age_mins - first_response_budget_mins) AS over_by_mins
  FROM scored
 WHERE status <> 'resolved' AND first_response_at IS NULL
   AND age_mins > first_response_budget_mins
 ORDER BY (age_mins - first_response_budget_mins) DESC, ticket_code`,
      paramOrder: ["as_of"],
      paramsSchema: AS_OF,
    },
    {
      name: "tickets_breaching_resolve",
      description:
        "Open tickets past their resolve budget. Measured against the priority the ticket " +
        "carries NOW, not the one it opened with — an escalated ticket is judged by the budget " +
        "that applies to it today, which is the whole point of escalating it. was_escalated " +
        "flags the ones where the two differ.",
      sqlText: `WITH${SCORED}
SELECT ticket_code, subject, customer_name, plan, priority, opened_priority,
       (priority <> opened_priority) AS was_escalated,
       team_code, team_email, assignee_name, assignee_email,
       age_mins, resolve_budget_mins, (age_mins - resolve_budget_mins) AS over_by_mins
  FROM scored
 WHERE status <> 'resolved' AND age_mins > resolve_budget_mins
 ORDER BY (age_mins - resolve_budget_mins) DESC, ticket_code`,
      paramOrder: ["as_of"],
      paramsSchema: AS_OF,
    },
    {
      name: "tickets_at_risk",
      description:
        "Open tickets at or past 80% of their resolve budget but not yet over it — still worth " +
        "chasing. Disjoint from tickets_breaching_resolve by construction, so the two together " +
        "are every open ticket under time pressure and neither double-counts.",
      sqlText: `WITH${SCORED}
SELECT ticket_code, subject, customer_name, plan, priority, team_code, team_email,
       assignee_name, assignee_email, age_mins, resolve_budget_mins,
       ((age_mins * 100) / NULLIF(resolve_budget_mins, 0)) AS pct_of_budget
  FROM scored
 WHERE status <> 'resolved'
   AND age_mins >= (resolve_budget_mins * 0.8)
   AND age_mins <= resolve_budget_mins
 ORDER BY pct_of_budget DESC, ticket_code`,
      paramOrder: ["as_of"],
      paramsSchema: AS_OF,
    },
    {
      name: "csat_by_team",
      description:
        "Satisfaction per team, WITH the response rate beside it. A mean score on its own is " +
        "the average among people who replied, which is not the same question — one team here " +
        "scores well on a handful of responses out of many surveys. Never rank teams on " +
        "avg_score without reading responses and response_rate_pct in the same row.",
      sqlText: `
SELECT t.code AS team_code, t.name AS team_name, t.contact_email,
       COUNT(*) FILTER (WHERE r.surveyed)                        AS surveys_sent,
       COUNT(*) FILTER (WHERE r.score IS NOT NULL)               AS responses,
       COALESCE(ROUND(AVG(r.score) FILTER (WHERE r.score IS NOT NULL), 2), 0)::float8 AS avg_score,
       CASE WHEN COUNT(*) FILTER (WHERE r.surveyed) = 0 THEN 0
            ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE r.score IS NOT NULL)
                       / COUNT(*) FILTER (WHERE r.surveyed), 1) END::float8 AS response_rate_pct
  FROM teams t
  LEFT JOIN tickets tk ON tk.team_code = t.code
   AND tk.resolved_at IS NOT NULL AND tk.resolved_at <= $1::timestamptz
  LEFT JOIN csat_responses r ON r.ticket_id = tk.id
 GROUP BY t.code, t.name, t.contact_email
 ORDER BY t.code`,
      paramOrder: ["as_of"],
      paramsSchema: AS_OF,
    },
    {
      name: "tickets_unassignable",
      description:
        "Open tickets whose assignee has no work email or is inactive — the ones an automated " +
        "nudge cannot reach, so a person has to. Reporting them is what stops them being " +
        "silently dropped by every flow that emails assignees.",
      sqlText: `WITH${SCORED}
SELECT ticket_code, subject, customer_name, priority, team_code, team_email, assignee_name,
       CASE WHEN assignee_name IS NULL THEN 'no assignee'
            WHEN assignee_email IS NULL THEN 'assignee has no work email'
            ELSE 'assignee is inactive' END AS reason
  FROM scored
 WHERE status <> 'resolved'
   AND (assignee_name IS NULL OR assignee_email IS NULL OR NOT assignee_active)
 ORDER BY ticket_code`,
      paramOrder: ["as_of"],
      paramsSchema: AS_OF,
    },
    {
      name: "open_ticket_summary",
      description:
        "One row per team: how many open tickets, how many past their resolve budget, how many " +
        "at risk, and the oldest one's age in minutes. The read a digest is built from.",
      sqlText: `WITH${SCORED}
SELECT team_code,
       COUNT(*) FILTER (WHERE status <> 'resolved')                                    AS open_tickets,
       COUNT(*) FILTER (WHERE status <> 'resolved' AND age_mins > resolve_budget_mins) AS breaching,
       COUNT(*) FILTER (WHERE status <> 'resolved' AND age_mins >= resolve_budget_mins * 0.8
                              AND age_mins <= resolve_budget_mins)                     AS at_risk,
       COALESCE(MAX(age_mins) FILTER (WHERE status <> 'resolved'), 0)                  AS oldest_open_mins
  FROM scored
 GROUP BY team_code
 ORDER BY team_code`,
      paramOrder: ["as_of"],
      paramsSchema: AS_OF,
    },
  ],
};

export const SUPPORT_DEFAULT_AS_OF = "2026-06-15T10:00:00Z";
