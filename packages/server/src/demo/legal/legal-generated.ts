/**
 * GENERATED Legal readers — 2026-09-09.
 *
 * The five reads `legal_demo` needs, proposed by `POST …/queries/propose`
 * from need statements plus the introspected schema (names + types only) and
 * frozen here after FULL-ROW comparison against the hand-written queries they
 * replace — sets first, then every column of every row (the set-diff passed
 * twice while values diverged, so sets alone are not the gate). Names are the
 * ORIGINAL `legal_demo.*` refs so flow seeds keep working unchanged.
 *
 * Review rounds that shaped the needs: lower-bound window dropping missed
 * deadlines; status=open filter on acknowledged incidents (itops carryover);
 * uncorrelated pause scans; uncast date arithmetic; unquoted intervals; CTE
 * column drops; empty-string owners; missing fix predicates. Needs carry the
 * standing mechanics block (casts, quotes, CTE column carry, qualified
 * columns) because variants regress it when shortened.
 */

export interface GeneratedQuerySeed {
  name: string;
  description: string;
  sqlText: string;
  paramOrder: string[];
  paramsSchema: Record<string, { type: string; required: boolean; format?: "date" | "month"; description: string }>;
  need: string;
  /** Oracle sets this SQL was verified against, per reporting date. */
  verifiedSets: string[];
}

export const LEGAL_GENERATED_QUERIES: GeneratedQuerySeed[] = [

  {
    need: `Renewal deadlines for auto-renewing contracts with two-hop notice fallback, six-condition eligibility, upper-bound-only window, missed bucket, cycle-bounded already_noticed, letter-exact reasons; verified full-row identical.`,
    name: "contracts_renewal_due",
    description:
      "AUTO-RENEWING notice deadlines — GENERATED, full-row identical at 2026-06-30 (9 rows) and set-exact at 2026-04-30/05-31 (2026-09-09).",
    sqlText: `
WITH eligible AS (SELECT c.contract_code, c.title, cp.counterparty_code, cp.name AS counterparty_name, cp.contact_email, c.owner_email, c.type_code, COALESCE(c.notice_period_days, ct.default_notice_period_days, os.value::integer) AS effective_notice_days, c.auto_renew, c.renewal_term_months, c.end_date, c.value_cents, c.id AS contract_id FROM public.contracts AS c JOIN public.counterparties AS cp ON cp.id = c.counterparty_id LEFT JOIN public.contract_types AS ct ON ct.code = c.type_code JOIN public.org_settings AS os ON os.key = 'default_notice_period_days' WHERE c.status = 'active' AND c.end_date IS NOT NULL AND c.superseded_by_id IS NULL AND c.signed_date IS NOT NULL AND c.start_date <= $1::date AND $1::date <= c.end_date AND c.auto_renew = TRUE), deadlines AS (SELECT e.*, e.end_date - e.effective_notice_days AS notice_deadline, (e.end_date - e.effective_notice_days) - $1::date AS days_to_deadline FROM eligible AS e WHERE e.end_date - e.effective_notice_days <= $1::date + $2::integer), classified AS (SELECT d.*, CASE WHEN d.days_to_deadline < 0 THEN 'missed' WHEN d.days_to_deadline <= 14 THEN '0-14' WHEN d.days_to_deadline <= 30 THEN '15-30' WHEN d.days_to_deadline <= 90 THEN '31-90' ELSE '90+' END AS urgency_bucket, EXISTS (SELECT 1 FROM public.notice_log AS nl WHERE nl.contract_id = d.contract_id AND nl.notice_type IN ('renewal_reminder', 'non_renewal') AND nl.sent_date BETWEEN $1::date - $2::integer AND $1::date) AS already_noticed, CASE WHEN d.contact_email IS NULL THEN 'no notice address on record' WHEN d.contact_email LIKE '%@cinder-analytics-bounce.example' THEN 'address hard-bounces' END AS unreachable_reason FROM deadlines AS d) SELECT contract_code, title, counterparty_code, counterparty_name, contact_email, owner_email, type_code, effective_notice_days, notice_deadline, days_to_deadline, urgency_bucket, auto_renew, renewal_term_months, end_date, value_cents, already_noticed, unreachable_reason FROM classified ORDER BY notice_deadline, contract_code LIMIT $3::integer
    `.trim(),
    paramOrder: ["as_of", "lookahead_days", "row_limit"],
    paramsSchema: {
      as_of: { type: "string", required: true, format: "date", description: "The date used to evaluate contract eligibility, notice deadlines, and recent notices, in YYYY-MM-DD format." },
      lookahead_days: { type: "number", required: true, description: "The number of days ahead for the renewal deadline window and backward notice search window." },
      row_limit: { type: "number", required: true, description: "The maximum number of rows to return." }
    },
    verifiedSets: ["2026-04-30:{}", "2026-05-31:{C-2024-011,C-2025-006,C-2025-007,C-2026-002,C-2026-008,C-2026-009}", "2026-06-30:{C-2024-001,C-2024-011,C-2025-006,C-2025-007,C-2025-010,C-2025-021,C-2026-002,C-2026-008,C-2026-009}"],
  },
  {
    need: `Fixed-term notice deadlines over the complementary population, disjoint from the auto-renew read; verified full-row identical.`,
    name: "contracts_expiring_no_autorenew",
    description:
      "FIXED-TERM notice deadlines — GENERATED, full-row identical at 2026-06-30 (5 rows) and set-exact at both earlier dates (2026-09-09).",
    sqlText: `
WITH eligible_contracts AS ( SELECT c.contract_code, c.title, cp.counterparty_code, cp.name AS counterparty_name, cp.contact_email, c.owner_email, c.type_code, COALESCE(c.notice_period_days, ct.default_notice_period_days, os.value::integer) AS effective_notice_days, c.auto_renew, c.renewal_term_months, c.end_date, c.value_cents FROM public.contracts AS c LEFT JOIN public.counterparties AS cp ON cp.id = c.counterparty_id LEFT JOIN public.contract_types AS ct ON ct.code = c.type_code LEFT JOIN public.org_settings AS os ON os.key = 'default_notice_period_days' WHERE c.status = 'active' AND c.end_date IS NOT NULL AND c.superseded_by_id IS NULL AND c.signed_date IS NOT NULL AND c.start_date <= $1::date AND $1::date <= c.end_date AND c.auto_renew = false ), deadlines AS ( SELECT e.*, e.end_date - e.effective_notice_days AS notice_deadline FROM eligible_contracts AS e ), annotated AS ( SELECT d.*, d.notice_deadline - $1::date AS days_to_deadline, CASE WHEN d.notice_deadline - $1::date < 0 THEN 'missed' WHEN d.notice_deadline - $1::date <= 14 THEN '0-14' WHEN d.notice_deadline - $1::date <= 30 THEN '15-30' WHEN d.notice_deadline - $1::date <= 90 THEN '31-90' ELSE '90+' END AS urgency_bucket, EXISTS ( SELECT 1 FROM public.notice_log AS nl WHERE nl.contract_id = (SELECT c.id FROM public.contracts AS c WHERE c.contract_code = d.contract_code AND c.title = d.title AND c.end_date = d.end_date AND c.auto_renew = d.auto_renew LIMIT 1) AND nl.notice_type IN ('renewal_reminder', 'non_renewal') AND nl.sent_date BETWEEN ($1::date - ($2::integer * INTERVAL '1 day'))::date AND $1::date ) AS already_noticed, CASE WHEN d.contact_email IS NULL THEN 'no notice address on record' WHEN d.contact_email LIKE '%@cinder-analytics-bounce.example' THEN 'address hard-bounces' END AS unreachable_reason FROM deadlines AS d WHERE d.notice_deadline <= ($1::date + ($2::integer * INTERVAL '1 day'))::date ) SELECT contract_code, title, counterparty_code, counterparty_name, contact_email, owner_email, type_code, effective_notice_days, notice_deadline, days_to_deadline, urgency_bucket, auto_renew, renewal_term_months, end_date, value_cents, already_noticed, unreachable_reason FROM annotated ORDER BY notice_deadline, contract_code
    `.trim(),
    paramOrder: ["as_of", "lookahead_days"],
    paramsSchema: {
      as_of: { type: "string", required: true, format: "date", description: "The date used to evaluate contract activity, notice deadlines, and sent notices, in YYYY-MM-DD format." },
      lookahead_days: { type: "number", required: true, description: "The number of calendar days to look ahead for notice deadlines and back from as_of when checking prior notices." }
    },
    verifiedSets: ["2026-04-30:{C-2025-004,C-2025-005}", "2026-05-31:{C-2025-004,C-2025-005,C-2025-022}", "2026-06-30:{C-2025-004,C-2025-005,C-2025-022,C-2025-023,C-2026-020}"],
  },
  {
    need: `Obligations due with waived exclusion, evidence-table completion, empty-string-safe owner fallback; verified full-row identical.`,
    name: "obligations_due",
    description:
      "Obligations due with evidence-table completion — GENERATED, full-row identical 14 rows at 2026-06-30 (2026-09-09).",
    sqlText: `
WITH open_obligations AS (SELECT o.obligation_code, c.contract_code, o.description, o.obligation_type, COALESCE(NULLIF(o.owner_email, ''), c.owner_email) AS resolved_owner_email, (o.owner_email IS NULL OR o.owner_email = '') AS owner_inherited, o.due_date, o.due_date - $1::date AS days_to_due, o.due_date < $1::date AS overdue, o.recurrence FROM public.obligations o JOIN public.contracts c ON c.id = o.contract_id WHERE o.status IS DISTINCT FROM 'waived' AND NOT EXISTS (SELECT 1 FROM public.obligation_completions oc WHERE oc.obligation_id = o.id AND oc.completed_date <= $1::date) AND (o.due_date < $1::date OR o.due_date <= $1::date + ($2::integer * INTERVAL '1 day'))) SELECT obligation_code, contract_code, description, obligation_type, resolved_owner_email, owner_inherited, due_date, days_to_due, overdue, recurrence FROM open_obligations ORDER BY days_to_due, obligation_code
    `.trim(),
    paramOrder: ["as_of", "lookahead_days"],
    paramsSchema: {
      as_of: { type: "string", required: true, format: "date", description: "The date used to determine completion, overdue status, and the due-date window, in YYYY-MM-DD format." },
      lookahead_days: { type: "number", required: true, description: "The number of days after the as-of date to include obligations due soon." }
    },
    verifiedSets: [],
  },
  {
    need: `Non-standard clauses with multiple-not-amount cap semantics and nullable rating filter; verified full-row identical.`,
    name: "nonstandard_clause_register",
    description:
      "Non-standard clause register — GENERATED, full-row identical 7 rows (2026-09-09).",
    sqlText: `
WITH clause_rows AS (SELECT c.contract_code, cp.counterparty_code, cp.name AS counterparty_name, c.owner_email, cc.clause_type, cc.risk_rating, cc.liability_cap_multiple, cc.summary FROM public.contract_clauses AS cc JOIN public.contracts AS c ON c.id = cc.contract_id JOIN public.counterparties AS cp ON cp.id = c.counterparty_id WHERE cc.is_non_standard AND ($1::text IS NULL OR cc.risk_rating = $1::text)) SELECT contract_code, counterparty_code, counterparty_name, owner_email, clause_type, risk_rating, liability_cap_multiple AS liability_cap_multiple_x, summary FROM clause_rows ORDER BY contract_code, clause_type
    `.trim(),
    paramOrder: ["risk_rating"],
    paramsSchema: {
      risk_rating: { type: "string", required: true, description: "Optional exact risk rating filter; supply null to include all risk ratings." }
    },
    verifiedSets: [],
  },
  {
    need: `Per-counterparty rollup: live means status active only (not-yet-started actives count); deadline MIN over live rows with end dates, not superseded, deadline >= as_of; fallback-computed; letter-exact contact states. Verified full-row identical at 2026-05-31 and 2026-06-30.`,
    name: "counterparty_contract_summary",
    description:
      "Per-counterparty summary — GENERATED, full-row identical 11 rows at 2026-05-31 and 2026-06-30 (2026-09-09).",
    sqlText: `
WITH live_contracts AS (SELECT c.counterparty_id, c.value_cents, CASE WHEN c.end_date IS NOT NULL AND c.superseded_by_id IS NULL THEN c.end_date - COALESCE(c.notice_period_days, ct.default_notice_period_days, (SELECT os.value::integer FROM public.org_settings os WHERE os.key = 'default_notice_period_days')) END AS notice_deadline FROM public.contracts c LEFT JOIN public.contract_types ct ON ct.code = c.type_code WHERE c.status = 'active') SELECT cp.counterparty_code AS counterparty_code, cp.name AS name, COUNT(lc.counterparty_id)::integer AS live_contracts, COALESCE(SUM(lc.value_cents), 0)::bigint AS total_value_cents, MIN(lc.notice_deadline) FILTER (WHERE lc.notice_deadline >= $1) AS next_notice_deadline, CASE WHEN NULLIF(TRIM(cp.contact_email), '') IS NULL THEN 'no_contact_email' WHEN cp.contact_email LIKE '%@cinder-analytics-bounce.example' THEN 'bouncing' ELSE 'ok' END AS contact_status FROM public.counterparties cp LEFT JOIN live_contracts lc ON lc.counterparty_id = cp.id GROUP BY cp.counterparty_code, cp.name, cp.contact_email ORDER BY cp.counterparty_code
    `.trim(),
    paramOrder: ["as_of"],
    paramsSchema: {
      as_of: { type: "string", required: true, format: "date", description: "The date used to include only notice deadlines on or after it, in YYYY-MM-DD format." }
    },
    verifiedSets: ["2026-05-31:11 rows", "2026-06-30:11 rows"],
  },
];
