/**
 * GENERATED Finance readers — 2026-09-09.
 *
 * ── What this file is ────────────────────────────────────────────────────────
 *
 * The five reads `finance_demo` needs, proposed by `POST …/queries/propose`
 * from a need statement plus the introspected schema (names + types only — no
 * data ever reaches the model), then executed against the seeded database and
 * compared with the hand-written queries they replace before being frozen here.
 *
 * Each entry records the NEED it was proposed from, so a regeneration is a
 * re-proposal, not a re-derivation. Names are the ORIGINAL `finance_demo.*`
 * refs, so flow seeds keep working unchanged — only the SQL's provenance
 * changes, from hand-written to model-proposed-and-oracle-checked.
 *
 * ── Verification log (2026-09-09, period 2026-06 / as-of 2026-06-30) ─────────
 *
 * - claims_over_policy: row-identical (EXP-0010/0011/0015/0016, same overages).
 * - spend_by_cost_centre: value-identical across all 6 cost centres. One review
 *   round caught a credit-note sign flip (amounts are stored negative; the first
 *   proposal negated them again) — the need now states storage facts.
 * - invoices_overdue: 14/14 rows; bucket labels, unreachable_reason and the
 *   due-date-derived flag match. Needs carry the consumer column contract.
 * - duplicate_candidates: the Meridian Print pair, no parameters.
 * - vendor_terms: org default applied; zero parameters.
 */

export interface GeneratedQuerySeed {
  name: string;
  description: string;
  sqlText: string;
  paramOrder: string[];
  paramsSchema: Record<string, { type: string; required: boolean; format?: "date" | "month"; description: string }>;
  /** The need statement the SQL was proposed from — the regeneration input. */
  need: string;
}

export const FINANCE_GENERATED_QUERIES: GeneratedQuerySeed[] = [
  {
    need: `Unpaid invoices past their due date as of a single date parameter as_of (YYYY-MM-DD). Output columns, spelled exactly: invoice_number, vendor_code, vendor_name, contact_email, cost_centre_code, issue_date, effective_due_date, due_date_derived (boolean), days_past_due (integer), outstanding_cents, bucket (one of 1-30, 31-60, 61-90, 90+), unreachable_reason (nullable text). Rules: effective_due_date is the invoice due_date, or issue_date plus the vendors payment_terms_days, or issue_date plus the org_settings default_payment_terms_days where the vendor has none; due_date_derived is true when the invoice due_date was null; outstanding_cents is amount_cents minus recorded payments from the payments table (exclude void and credit invoices entirely); an invoice due exactly on as_of is NOT overdue; bucket 1-30 means days_past_due <= 30, 31-60 means 31..60, 61+ above 60; unreachable_reason is no accounts-payable address on record when contact_email is null, address hard-bounces when it ends in @acme-supply-bounce.example, else null. Amounts are MINOR cents. The ONLY parameter is as_of`,
    name: "invoices_overdue",
    description:
      "Every unpaid invoice past its due date as of a given date — GENERATED, verified row-for-row against the hand-written query it replaces (2026-09-09).",
    sqlText: `
WITH payment_totals AS (SELECT invoice_id, SUM(amount_cents) AS paid_cents FROM public.payments GROUP BY invoice_id), invoice_details AS (SELECT i.invoice_number, v.vendor_code, v.name AS vendor_name, v.contact_email, c.code AS cost_centre_code, i.issue_date, CASE WHEN i.due_date IS NOT NULL THEN i.due_date ELSE i.issue_date + COALESCE(v.payment_terms_days, (SELECT value::integer FROM public.org_settings WHERE key = 'default_payment_terms_days')) END AS effective_due_date, (i.due_date IS NULL) AS due_date_derived, i.amount_cents - COALESCE(p.paid_cents, 0) AS outstanding_cents FROM public.invoices AS i LEFT JOIN public.vendors AS v ON v.id = i.vendor_id LEFT JOIN public.cost_centres AS c ON c.id = i.cost_centre_id LEFT JOIN payment_totals AS p ON p.invoice_id = i.id WHERE (i.status IS NULL OR lower(i.status) NOT IN ('void', 'credit'))), overdue_invoices AS (SELECT invoice_number, vendor_code, vendor_name, contact_email, cost_centre_code, issue_date, effective_due_date, due_date_derived, $1::date - effective_due_date AS days_past_due, outstanding_cents FROM invoice_details WHERE effective_due_date < $1::date AND outstanding_cents > 0) SELECT invoice_number, vendor_code, vendor_name, contact_email, cost_centre_code, issue_date, effective_due_date, due_date_derived, days_past_due, outstanding_cents, CASE WHEN days_past_due <= 30 THEN '1-30' WHEN days_past_due <= 60 THEN '31-60' ELSE '61-90' END AS bucket, CASE WHEN contact_email IS NULL THEN 'no accounts-payable address on record' WHEN contact_email LIKE '%@acme-supply-bounce.example' THEN 'address hard-bounces' ELSE NULL END AS unreachable_reason FROM overdue_invoices ORDER BY days_past_due DESC, effective_due_date, invoice_number
    `.trim(),
    paramOrder: ["as_of"],
    paramsSchema: {
      as_of: { type: "string", required: true, format: "date", description: "The date used to determine whether an invoice is overdue, in YYYY-MM-DD format." }
    },
  },
  {
    need: `Invoices that look like duplicate billing as of a date: same vendor, same amount, same issue date under more than one invoice number, considering only invoices issued on or before as_of. Exclude void and credit as literals. Single param as_of.`,
    name: "duplicate_candidates",
    description:
      "Invoices that look like duplicate billing — GENERATED, verified against the hand-written query it replaces (2026-09-09).",
    sqlText: `
SELECT STRING_AGG(invoice_number, ', ' ORDER BY invoice_number) AS invoice_numbers
FROM public.invoices
WHERE issue_date <= $1
  AND invoice_number IS NOT NULL
  AND status IS DISTINCT FROM 'void'
  AND status IS DISTINCT FROM 'credit'
GROUP BY vendor_id, amount_cents, issue_date
HAVING COUNT(invoice_number) >= 2
ORDER BY invoice_numbers
    `.trim(),
    paramOrder: ["as_of"],
    paramsSchema: {
      as_of: { type: "string", required: true, format: "date", description: "The date through which invoices may be included, in YYYY-MM-DD format." }
    },
  },
  {
    need: `Expense claims in a reporting period given as a single period parameter YYYY-MM that exceed their category policy limit and have not been rejected, with claimant name and email and how far over the limit each claim is. The ONLY parameter is period (YYYY-MM); select the period with to_char(claim_date, YYYY-MM) = period. A claim joins the policy row of its category effective on its claim date; amounts are MINOR cents; exclude rejected claims`,
    name: "claims_over_policy",
    description:
      "Expense claims over their category policy limit — GENERATED, verified row-identical against the hand-written query it replaces (2026-09-09).",
    sqlText: `
SELECT ec.claim_code AS claim_code, e.full_name AS employee_name, e.work_email AS employee_email, cc.code AS cost_centre_code, cc.owner_email AS cost_centre_owner_email, ec.category AS category, ec.claim_date AS claim_date, ec.amount_cents AS amount_cents, p.limit_cents AS limit_cents, ec.amount_cents - p.limit_cents AS over_by_cents FROM public.expense_claims AS ec JOIN public.employees AS e ON e.id = ec.employee_id JOIN public.cost_centres AS cc ON cc.id = ec.cost_centre_id CROSS JOIN LATERAL (SELECT ep.limit_cents FROM public.expense_policy AS ep WHERE ep.category = ec.category AND ep.effective_from <= ec.claim_date ORDER BY ep.effective_from DESC, ep.id DESC LIMIT 1) AS p WHERE ec.status IS DISTINCT FROM 'rejected' AND to_char(ec.claim_date, 'YYYY-MM') = $1 AND ec.amount_cents > p.limit_cents
    `.trim(),
    paramOrder: ["period"],
    paramsSchema: {
      period: { type: "string", required: true, format: "month", description: "The claim period in YYYY-MM format." }
    },
  },
  {
    need: `Budget versus actual for every cost centre in a reporting period given as YYYY-MM, including cost centres that spent nothing, with owner email. Facts: budgets.amount is MAJOR dollars, multiply by 100 for cents; invoice and claim amounts are MINOR cents; a row belongs to the period when to_char(issue_date or claim_date, YYYY-MM) equals the period; invoice statuses are open, paid, void, credit — exclude ONLY void; credit-note amounts are already stored NEGATIVE so sum invoice amounts raw, no sign flip; exclude rejected claims`,
    name: "spend_by_cost_centre",
    description:
      "Budget versus actual per cost centre — GENERATED, verified value-identical against the hand-written query it replaces (2026-09-09).",
    sqlText: `
WITH budget_totals AS (SELECT cost_centre_id, (COALESCE(SUM(amount), 0) * 100)::bigint AS budget_cents FROM public.budgets WHERE period = $1 GROUP BY cost_centre_id), invoice_totals AS (SELECT cost_centre_id, COALESCE(SUM(amount_cents), 0)::bigint AS invoice_cents FROM public.invoices WHERE to_char(issue_date, 'YYYY-MM') = $1 AND status IS DISTINCT FROM 'void' GROUP BY cost_centre_id), claim_totals AS (SELECT cost_centre_id, COALESCE(SUM(amount_cents), 0)::bigint AS claim_cents FROM public.expense_claims WHERE to_char(claim_date, 'YYYY-MM') = $1 AND status IS DISTINCT FROM 'rejected' GROUP BY cost_centre_id), amounts AS (SELECT cc.code AS cost_centre_code, cc.name AS cost_centre_name, cc.owner_email AS owner_email, COALESCE(bt.budget_cents, 0::bigint) AS budget_cents, COALESCE(it.invoice_cents, 0::bigint) AS invoice_cents, COALESCE(ct.claim_cents, 0::bigint) AS claim_cents FROM public.cost_centres AS cc LEFT JOIN budget_totals AS bt ON bt.cost_centre_id = cc.id LEFT JOIN invoice_totals AS it ON it.cost_centre_id = cc.id LEFT JOIN claim_totals AS ct ON ct.cost_centre_id = cc.id) SELECT cost_centre_code, cost_centre_name, owner_email, budget_cents, invoice_cents, claim_cents, (invoice_cents + claim_cents)::bigint AS actual_cents, ((invoice_cents + claim_cents) - budget_cents)::bigint AS variance_cents, (invoice_cents + claim_cents) > budget_cents AS over_budget FROM amounts
    `.trim(),
    paramOrder: ["period"],
    paramsSchema: {
      period: { type: "string", required: true, format: "month", description: "The budget and transaction period in YYYY-MM format." }
    },
  },
  {
    need: `Every vendor with its effective payment terms in days (own terms where set, otherwise the org_settings row whose key is the literal default_payment_terms_days), contact email and reachability. This query takes NO parameters`,
    name: "vendor_terms",
    description:
      "Effective vendor payment terms — GENERATED, verified against the hand-written query it replaces (2026-09-09).",
    sqlText: `
SELECT v.vendor_code AS vendor_code, v.payment_terms_days AS own_terms_days, COALESCE(v.payment_terms_days, s.value::integer) AS effective_terms_days, (v.payment_terms_days IS NULL) AS uses_org_default FROM public.vendors AS v LEFT JOIN public.org_settings AS s ON s.key = 'default_payment_terms_days'
    `.trim(),
    paramOrder: [],
    paramsSchema: {},
  },];
