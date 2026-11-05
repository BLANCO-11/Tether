/**
 * ─────────────────────────────────────────────────────────────────────────────
 * RECRUITMENT — the seventh domain
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ **THE TRAP: AN APPLICATION IS NOT A CANDIDATE.** People apply to more than
 * one role. `COUNT(*) FROM applications` is the number of applications, and
 * every funnel built on it double-counts the keenest applicants — the ones most
 * likely to reach a late stage, so the error is biased towards the top of the
 * funnel rather than spread evenly. Anything reporting *people* must
 * `COUNT(DISTINCT candidate_id)`, and `pipeline_funnel` returns both so the gap
 * is visible instead of arguable.
 *
 * ⚠ **THE SECOND TRAP: "AT A STAGE" IS NOT "REACHED A STAGE".** A funnel built
 * from each application's CURRENT stage reports conversion as though everybody
 * who ever interviewed is still interviewing. A candidate rejected after an
 * interview reached the interview stage and belongs in its numerator. The
 * `furthest_stage_rank` column is what makes the difference computable, and the
 * two readings differ sharply here because most applications are rejected.
 *
 * ⚠ **THE THIRD: TIME-TO-HIRE HAS TWO DENOMINATORS.** From the requisition
 * OPENING (what the hiring manager waited) and from the candidate's APPLICATION
 * (what the candidate experienced). Both are legitimate, they answer different
 * questions, and quoting one as the other is the mistake — so both are returned,
 * named, in the same row.
 *
 * ⚠ **ALL DATA IS SYNTHETIC** — invented names on RFC 2606 `.example` domains.
 */
import type { DomainSpec } from "./domain.js";

const DDL = `
DROP TABLE IF EXISTS offers, interviews, applications, candidates, requisitions, stages, recruiters, org_settings CASCADE;

CREATE TABLE org_settings (
  id                    int PRIMARY KEY,
  target_days_to_hire   int NOT NULL,
  stale_application_days int NOT NULL,
  offer_expiry_days     int NOT NULL
);

-- ⚠ Ranked, and the rank is what makes "reached this stage" computable at all.
CREATE TABLE stages (
  code text PRIMARY KEY,
  name text NOT NULL,
  rank int NOT NULL
);

CREATE TABLE recruiters (
  id         int PRIMARY KEY,
  full_name  text NOT NULL,
  work_email text,
  active     boolean NOT NULL DEFAULT true
);

CREATE TABLE requisitions (
  id           int PRIMARY KEY,
  req_code     text UNIQUE NOT NULL,
  title        text NOT NULL,
  department   text NOT NULL,
  location     text NOT NULL,
  recruiter_id int REFERENCES recruiters(id),
  hiring_manager_email text,
  status       text NOT NULL,
  opened_at    timestamptz NOT NULL,
  closed_at    timestamptz,
  headcount    int NOT NULL DEFAULT 1
);

CREATE TABLE candidates (
  id       int PRIMARY KEY,
  full_name text NOT NULL,
  email    text,
  source   text NOT NULL
);

CREATE TABLE applications (
  id             int PRIMARY KEY,
  requisition_id int REFERENCES requisitions(id),
  candidate_id   int REFERENCES candidates(id),
  applied_at     timestamptz NOT NULL,
  current_stage  text REFERENCES stages(code),
  -- The FURTHEST stage this application ever reached. A rejected candidate keeps it.
  furthest_stage text REFERENCES stages(code),
  status         text NOT NULL,
  last_activity_at timestamptz NOT NULL
);

CREATE TABLE interviews (
  id             int PRIMARY KEY,
  application_id int REFERENCES applications(id),
  scheduled_at   timestamptz NOT NULL,
  panel          text NOT NULL,
  outcome        text
);

CREATE TABLE offers (
  id             int PRIMARY KEY,
  application_id int REFERENCES applications(id),
  made_at        timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  status         text NOT NULL,
  accepted_at    timestamptz
);
`;

const d = (month: number, day: number, hour = 10) =>
  `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`;

const STAGES: unknown[][] = [
  ["applied", "Applied", 1],
  ["screen", "Recruiter screen", 2],
  ["interview", "Interview", 3],
  ["final", "Final panel", 4],
  ["offer", "Offer", 5],
  ["hired", "Hired", 6],
];

const RECRUITERS: unknown[][] = [
  [1, "Priya Raman", "priya.raman@acme-hiring.example", true],
  [2, "Sam Okonjo", "sam.okonjo@acme-hiring.example", true],
  // ⚠ No work email. Anything that mails the owning recruiter must cope.
  [3, "Lena Fischer", null, true],
  [4, "Hugo Martins", "hugo.martins@acme-hiring.example", false],
];

const REQS: unknown[][] = [
  [1, "REQ-101", "Backend Engineer", "Engineering", "London", 1, "eng-lead@acme-hiring.example", "open", d(3, 2), null, 2],
  [2, "REQ-102", "Product Designer", "Design", "Remote", 2, "design-lead@acme-hiring.example", "open", d(3, 16), null, 1],
  [3, "REQ-103", "Data Analyst", "Data", "London", 1, "data-lead@acme-hiring.example", "open", d(4, 6), null, 1],
  [4, "REQ-104", "Support Specialist", "Support", "Manchester", 3, "support-lead@acme-hiring.example", "open", d(4, 20), null, 2],
  [5, "REQ-105", "Finance Analyst", "Finance", "London", 2, "fin-lead@acme-hiring.example", "closed", d(2, 10), d(5, 8), 1],
  // ⚠ Open since March with no recruiter email reachable — the escalation case.
  [6, "REQ-106", "Platform Engineer", "Engineering", "Remote", 3, "eng-lead@acme-hiring.example", "open", d(3, 9), null, 1],
];

/**
 * ⚠ **Candidates 1, 4 and 7 each apply to TWO requisitions.** That is what makes
 * `COUNT(*)` and `COUNT(DISTINCT candidate_id)` disagree, and it is the whole
 * point of the first trap.
 */
const CANDIDATES: unknown[][] = [
  [1, "Alex Doyle", "alex.doyle@mail.example", "referral"],
  [2, "Bea Ncube", "bea.ncube@mail.example", "job board"],
  [3, "Cai Zhang", "cai.zhang@mail.example", "agency"],
  [4, "Dana Kowalski", "dana.kowalski@mail.example", "referral"],
  [5, "Eli Barros", "eli.barros@mail.example", "job board"],
  [6, "Farah Haddad", "farah.haddad@mail.example", "careers site"],
  [7, "Gus Lindqvist", "gus.lindqvist@mail.example", "job board"],
  [8, "Hana Suzuki", "hana.suzuki@mail.example", "agency"],
  [9, "Ivan Petrov", null, "careers site"],
  [10, "Jo Mensah", "jo.mensah@mail.example", "referral"],
];

/**
 * 16 applications over 10 candidates.
 *
 * ⚠ `furthest_stage` DIFFERS from `current_stage` on every rejected row, and that
 * is the second trap made concrete: A-6 is `current_stage = 'applied'` and
 * `furthest_stage = 'interview'` — a candidate who interviewed and was turned
 * down. A funnel keyed on `current_stage` puts them back at the top.
 */
const APPS: unknown[][] = [
  // id, req, cand, applied_at, current_stage, furthest_stage, status, last_activity
  [1, 1, 1, d(3, 5), "offer", "offer", "active", d(6, 2)],
  [2, 1, 2, d(3, 8), "interview", "interview", "active", d(6, 10)],
  [3, 1, 3, d(3, 12), "applied", "screen", "rejected", d(4, 1)],
  [4, 1, 4, d(3, 20), "final", "final", "active", d(6, 9)],
  [5, 2, 5, d(3, 18), "screen", "screen", "active", d(4, 2)],
  [6, 2, 1, d(3, 22), "applied", "interview", "rejected", d(4, 28)],
  [7, 2, 6, d(4, 1), "hired", "hired", "hired", d(5, 20)],
  [8, 3, 7, d(4, 10), "interview", "interview", "active", d(6, 11)],
  [9, 3, 8, d(4, 14), "applied", "applied", "active", d(4, 14)],
  [10, 3, 4, d(4, 18), "applied", "screen", "rejected", d(5, 3)],
  [11, 4, 9, d(4, 25), "screen", "screen", "active", d(5, 30)],
  [12, 4, 10, d(5, 1), "applied", "applied", "active", d(5, 1)],
  [13, 4, 7, d(5, 4), "applied", "applied", "active", d(5, 4)],
  [14, 5, 2, d(2, 14), "hired", "hired", "hired", d(5, 8)],
  [15, 6, 3, d(3, 15), "final", "final", "active", d(6, 12)],
  [16, 6, 5, d(3, 28), "applied", "screen", "rejected", d(4, 20)],
];

const INTERVIEWS: unknown[][] = [
  [1, 1, d(4, 5), "eng panel", "pass"],
  [2, 2, d(5, 20), "eng panel", "pass"],
  [3, 4, d(5, 28), "eng panel", "pass"],
  [4, 6, d(4, 20), "design panel", "fail"],
  [5, 7, d(4, 25), "design panel", "pass"],
  [6, 8, d(6, 1), "data panel", null],
  [7, 15, d(6, 5), "platform panel", "pass"],
];

const OFFERS: unknown[][] = [
  // ⚠ Offer 1 is OUTSTANDING and expires soon — the chase case.
  [1, 1, d(6, 8), d(6, 18), "outstanding", null],
  [2, 7, d(5, 10), d(5, 24), "accepted", d(5, 20)],
  [3, 14, d(4, 28), d(5, 12), "accepted", d(5, 8)],
];

const AS_OF = {
  as_of: { type: "string", required: true, description: "Instant to measure against, ISO-8601." },
};

const SCORED = `
app_scored AS (
  SELECT a.id, a.requisition_id, a.candidate_id, a.applied_at, a.status,
         a.current_stage, a.furthest_stage, a.last_activity_at,
         cs.rank AS current_rank, fs.rank AS furthest_rank,
         r.req_code, r.title, r.department, r.location, r.status AS req_status,
         r.opened_at AS req_opened_at, r.hiring_manager_email,
         rc.full_name AS recruiter_name, rc.work_email AS recruiter_email, rc.active AS recruiter_active,
         c.full_name AS candidate_name, c.email AS candidate_email, c.source,
         GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - a.last_activity_at)) / 86400)::int AS days_since_activity,
         GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - a.applied_at)) / 86400)::int       AS days_since_applied,
         GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - r.opened_at)) / 86400)::int        AS days_req_open
    FROM applications a
    JOIN requisitions r ON r.id = a.requisition_id
    JOIN candidates c   ON c.id = a.candidate_id
    JOIN stages cs      ON cs.code = a.current_stage
    JOIN stages fs      ON fs.code = a.furthest_stage
    LEFT JOIN recruiters rc ON rc.id = r.recruiter_id
)`;

export const HIRING_DOMAIN: DomainSpec = {
  key: "hiring",
  workspaceName: "Recruitment",
  dbName: "hiring_demo",
  roRole: "hiring_ro",
  secretEnv: "HIRING_DB_URL",
  description:
    "A hiring pipeline: which applications have gone quiet, which offers are about to expire, " +
    "and a funnel that counts people rather than applications — the same person applies twice.",
  opsServices: ["mail", "chat", "ticketing", "llm"],
  ddl: DDL,
  tables: [
    { table: "org_settings", columns: ["id", "target_days_to_hire", "stale_application_days", "offer_expiry_days"], rows: [[1, 45, 14, 10]] },
    { table: "stages", columns: ["code", "name", "rank"], rows: STAGES },
    { table: "recruiters", columns: ["id", "full_name", "work_email", "active"], rows: RECRUITERS },
    { table: "requisitions", columns: ["id", "req_code", "title", "department", "location", "recruiter_id", "hiring_manager_email", "status", "opened_at", "closed_at", "headcount"], rows: REQS },
    { table: "candidates", columns: ["id", "full_name", "email", "source"], rows: CANDIDATES },
    { table: "applications", columns: ["id", "requisition_id", "candidate_id", "applied_at", "current_stage", "furthest_stage", "status", "last_activity_at"], rows: APPS },
    { table: "interviews", columns: ["id", "application_id", "scheduled_at", "panel", "outcome"], rows: INTERVIEWS },
    { table: "offers", columns: ["id", "application_id", "made_at", "expires_at", "status", "accepted_at"], rows: OFFERS },
  ],
  queries: [
    {
      name: "applications_gone_quiet",
      description:
        "Active applications with no activity for longer than the org-wide stale window — the " +
        "candidates who are waiting to hear back and nobody has noticed. Measured from " +
        "last_activity_at, not from applied_at: an application that moved last week is not stale " +
        "because it was submitted three months ago.",
      sqlText: `WITH${SCORED}
SELECT a.req_code, a.title, a.department, a.candidate_name, a.candidate_email,
       a.current_stage, a.days_since_activity, a.days_since_applied,
       a.recruiter_name, a.recruiter_email, a.hiring_manager_email, o.stale_application_days
  FROM app_scored a CROSS JOIN org_settings o
 WHERE o.id = 1 AND a.status = 'active' AND a.req_status = 'open'
   AND a.days_since_activity > o.stale_application_days
 ORDER BY a.days_since_activity DESC, a.req_code`,
      paramOrder: ["as_of"],
      paramsSchema: AS_OF,
    },
    {
      name: "offers_expiring",
      description:
        "Outstanding offers ALREADY MADE as of the given instant, and how many days are left " +
        "before they lapse. A negative days_to_expiry means it has already expired and nobody " +
        "chased it — which is a lost hire, not a warning to log.",
      sqlText: `WITH${SCORED}
SELECT a.req_code, a.title, a.candidate_name, a.candidate_email,
       of.made_at, of.expires_at,
       (EXTRACT(EPOCH FROM (of.expires_at - $1::timestamptz)) / 86400)::int AS days_to_expiry,
       a.recruiter_name, a.recruiter_email, a.hiring_manager_email
  FROM offers of
  JOIN app_scored a ON a.id = of.application_id
 WHERE of.status = 'outstanding'
   -- ⚠ AN OFFER THAT HAS NOT BEEN MADE YET CANNOT BE CHASED. Without this the
   -- query ignores as_of entirely and reports an offer dated June when asked
   -- about March — which is not merely wrong, it makes the query's empty case
   -- unreachable, so a branching flow built on it can never take its other arm.
   -- Found by running the flow at an instant where the answer should have been
   -- "nothing", which is the only thing that could have found it.
   AND of.made_at <= $1::timestamptz
 ORDER BY of.expires_at`,
      paramOrder: ["as_of"],
      paramsSchema: AS_OF,
    },
    {
      name: "pipeline_funnel",
      description:
        "The funnel, per stage, counted BOTH ways. reached_applications counts applications " +
        "that ever got to this stage; reached_people counts DISTINCT candidates. They differ " +
        "because the same person applies to more than one role, and the gap is biased towards " +
        "the keenest applicants — who are also the ones most likely to reach a late stage. " +
        "Never quote one as the other.",
      sqlText: `WITH${SCORED}
SELECT s.code AS stage_code, s.name AS stage_name, s.rank,
       COUNT(a.id) FILTER (WHERE a.furthest_rank >= s.rank)                        AS reached_applications,
       COUNT(DISTINCT a.candidate_id) FILTER (WHERE a.furthest_rank >= s.rank)      AS reached_people,
       COUNT(a.id) FILTER (WHERE a.current_rank = s.rank AND a.status = 'active')   AS currently_here
  FROM stages s
  LEFT JOIN app_scored a ON a.req_status = 'open'
 GROUP BY s.code, s.name, s.rank
 ORDER BY s.rank`,
      paramOrder: ["as_of"],
      paramsSchema: AS_OF,
    },
    {
      name: "time_to_hire",
      description:
        "Every hire, with BOTH elapsed times: days_from_requisition is what the hiring manager " +
        "waited, days_from_application is what the candidate experienced. They answer different " +
        "questions and quoting one as the other is the mistake — so both are here, named, in " +
        "the same row, with the org-wide target beside them.",
      sqlText: `WITH${SCORED}
SELECT a.req_code, a.title, a.department, a.candidate_name, a.source,
       a.req_opened_at, a.applied_at, of.accepted_at,
       (EXTRACT(EPOCH FROM (of.accepted_at - a.req_opened_at)) / 86400)::int AS days_from_requisition,
       (EXTRACT(EPOCH FROM (of.accepted_at - a.applied_at)) / 86400)::int    AS days_from_application,
       o.target_days_to_hire
  FROM app_scored a
  JOIN offers of ON of.application_id = a.id AND of.status = 'accepted'
  CROSS JOIN org_settings o
 WHERE o.id = 1 AND of.accepted_at <= $1::timestamptz
 ORDER BY of.accepted_at DESC`,
      paramOrder: ["as_of"],
      paramsSchema: AS_OF,
    },
    {
      name: "requisitions_open_too_long",
      description:
        "Open requisitions past the org-wide time-to-hire target with nobody at offer stage yet " +
        "— the roles that are quietly not getting filled. Carries how many applications are " +
        "still active on each, because an empty pipeline and a stalled one need different " +
        "answers.",
      sqlText: `WITH${SCORED}
SELECT r.req_code, r.title, r.department, r.location, r.headcount,
       GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - r.opened_at)) / 86400)::int AS days_open,
       o.target_days_to_hire,
       rc.full_name AS recruiter_name, rc.work_email AS recruiter_email, r.hiring_manager_email,
       COUNT(a.id) FILTER (WHERE a.status = 'active') AS active_applications,
       COUNT(a.id) FILTER (WHERE a.furthest_rank >= 4) AS reached_final_or_better
  FROM requisitions r
  CROSS JOIN org_settings o
  LEFT JOIN recruiters rc ON rc.id = r.recruiter_id
  LEFT JOIN app_scored a ON a.requisition_id = r.id
 WHERE o.id = 1 AND r.status = 'open'
   AND EXTRACT(EPOCH FROM ($1::timestamptz - r.opened_at)) / 86400 > o.target_days_to_hire
 GROUP BY r.req_code, r.title, r.department, r.location, r.headcount, r.opened_at,
          o.target_days_to_hire, rc.full_name, rc.work_email, r.hiring_manager_email
HAVING COUNT(a.id) FILTER (WHERE a.current_stage IN ('offer','hired')) = 0
 ORDER BY days_open DESC`,
      paramOrder: ["as_of"],
      paramsSchema: AS_OF,
    },
    {
      name: "requisitions_unreachable",
      description:
        "Open requisitions whose recruiter has no work email or is inactive — the ones an " +
        "automated nudge cannot reach, so a person has to. The hiring manager's address is " +
        "carried as the fallback route.",
      sqlText: `
SELECT r.req_code, r.title, r.department, r.hiring_manager_email,
       rc.full_name AS recruiter_name,
       CASE WHEN rc.id IS NULL THEN 'no recruiter assigned'
            WHEN rc.work_email IS NULL THEN 'recruiter has no work email'
            ELSE 'recruiter is inactive' END AS reason
  FROM requisitions r
  LEFT JOIN recruiters rc ON rc.id = r.recruiter_id
 WHERE r.status = 'open'
   AND (rc.id IS NULL OR rc.work_email IS NULL OR NOT rc.active)
 ORDER BY r.req_code`,
      paramOrder: [],
      paramsSchema: {},
    },
  ],
};

export const HIRING_DEFAULT_AS_OF = "2026-06-15T10:00:00Z";
