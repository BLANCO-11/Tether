/**
 * GENERATED generic flow-needed readers — 2026-09-09.
 *
 * The three reads the generic demo flows need — the only generic named queries with consumers. Proposed by `POST …/queries/propose` and frozen after FULL-ROW comparison (2026-09-09). Installed by `scenarios/generic-seed.ts` before authoring flows, mirroring a person building the reader first. The other 15 generic queries have no consumers and are dropped, not regenerated.
 */

export interface GeneratedQuerySeed {
  name: string;
  description: string;
  sqlText: string;
  paramOrder: string[];
  paramsSchema: Record<string, { type: string; required: boolean; description: string }>;
  need: string;
  verifiedSets: string[];
}

export const GENERIC_GENERATED_QUERIES: GeneratedQuerySeed[] = [

  {
    need: `Breach read with plan+current-priority budgets, plain elapsed clock, escalation flag.`,
    name: "tickets_breaching_resolve",
    description:
      "Breaching support tickets — GENERATED, 9 rows identical at 2026-06-15 (2026-09-09).",
    sqlText: `
WITH ticket_ages AS (
  SELECT
    t.ticket_code,
    t.subject,
    c.name AS customer_name,
    c.plan,
    t.priority,
    t.opened_priority,
    COALESCE(t.priority <> t.opened_priority, false) AS was_escalated,
    t.team_code,
    tm.contact_email AS team_email,
    a.full_name AS assignee_name,
    a.work_email AS assignee_email,
    floor(GREATEST(EXTRACT(EPOCH FROM ($1::timestamptz - t.opened_at)) / 60, 0)) AS age_mins,
    COALESCE(sp.resolve_mins, os.default_resolve_mins) AS resolve_budget_mins
  FROM public.tickets AS t
  JOIN public.customers AS c ON c.id = t.customer_id
  LEFT JOIN public.sla_policies AS sp
    ON sp.plan = c.plan
   AND sp.priority = t.priority
  LEFT JOIN public.org_settings AS os ON os.id = 1
  LEFT JOIN public.teams AS tm ON tm.code = t.team_code
  LEFT JOIN public.agents AS a ON a.id = t.assignee_id
  WHERE t.status <> 'resolved'
)
SELECT
  ticket_code,
  subject,
  customer_name,
  plan,
  priority,
  opened_priority,
  was_escalated,
  team_code,
  team_email,
  assignee_name,
  assignee_email,
  age_mins,
  resolve_budget_mins,
  age_mins - resolve_budget_mins AS over_by_mins
FROM ticket_ages
WHERE age_mins > resolve_budget_mins
ORDER BY over_by_mins DESC, ticket_code
    `.trim(),
    paramOrder: ["as_of"],
    paramsSchema: {
      as_of: { type: "string", required: true, description: "The instant to judge ticket age against, supplied as a timestamptz value such as 2026-09-09T12:00:00Z." }
    },
    verifiedSets: ["2026-06-15T10:00:00Z:9 rows"],
  },
  {
    need: `Past-promise read with per-line shipment counting and float8 value.`,
    name: "orders_past_promise",
    description:
      "Past-promise orders — GENERATED, 8 rows identical (2026-09-09).",
    sqlText: `
WITH live_lines AS (SELECT ol.order_id, ol.id, ol.qty, ol.unit_price_cents, ol.line_discount_cents, EXISTS (SELECT 1 FROM public.shipments AS s WHERE s.order_line_id = ol.id) AS has_shipment FROM public.order_lines AS ol WHERE ol.status <> 'cancelled'), order_rollup AS (SELECT order_id, COUNT(*) AS live_lines, COUNT(*) FILTER (WHERE has_shipment) AS shipped_lines, SUM(qty::numeric * unit_price_cents::numeric - line_discount_cents::numeric) AS order_value_cents FROM live_lines GROUP BY order_id) SELECT o.order_code AS order_code, c.name AS customer_name, c.email AS customer_email, c.segment AS segment, o.channel AS channel, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($1 - o.placed_at)) / 86400)) AS age_days, FLOOR(EXTRACT(EPOCH FROM ($1 - o.promised_at)) / 86400) AS days_past_promise, r.live_lines AS live_lines, r.shipped_lines AS shipped_lines, r.live_lines - r.shipped_lines AS lines_outstanding, (r.order_value_cents / 100.0)::float8 AS order_value FROM public.orders AS o JOIN order_rollup AS r ON r.order_id = o.id LEFT JOIN public.customers AS c ON c.id = o.customer_id WHERE o.status <> 'cancelled' AND o.promised_at IS NOT NULL AND o.promised_at < $1 AND r.live_lines > r.shipped_lines ORDER BY days_past_promise DESC, order_code
    `.trim(),
    paramOrder: ["as_of"],
    paramsSchema: {
      as_of: { type: "string", required: true, description: "The timestamp with time zone used to calculate order age and days past promise." }
    },
    verifiedSets: [],
  },
  {
    need: `Offers read with made_at<=as_of emptiness guard; verified full-row identical.`,
    name: "offers_expiring",
    description:
      "Expiring offers — GENERATED, 1 row identical (2026-09-09).",
    sqlText: `
SELECT r.req_code, r.title, c.full_name AS candidate_name, c.email AS candidate_email, o.made_at, o.expires_at, FLOOR(EXTRACT(EPOCH FROM (o.expires_at - $1)) / 86400) AS days_to_expiry, rec.full_name AS recruiter_name, rec.work_email AS recruiter_email, r.hiring_manager_email FROM public.offers AS o JOIN public.applications AS a ON a.id = o.application_id JOIN public.requisitions AS r ON r.id = a.requisition_id JOIN public.candidates AS c ON c.id = a.candidate_id JOIN public.recruiters AS rec ON rec.id = r.recruiter_id WHERE o.status = 'outstanding' AND o.made_at <= $1 ORDER BY o.expires_at
    `.trim(),
    paramOrder: ["as_of"],
    paramsSchema: {
      as_of: { type: "string", required: true, description: "The timestamp used to determine whether the offer has been made and to calculate whole days until expiry, in timestamptz format." }
    },
    verifiedSets: [],
  },
];
