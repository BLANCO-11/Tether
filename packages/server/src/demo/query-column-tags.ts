/**
 * The demo named queries' COMPUTED result columns, tagged as their owner declares them (services/query-column-tags.ts).
 * Only columns no column comment reaches: each is a fallback expression, so the database names no source column.
 * Keyed `<datasource>.<query>`; checked against the described columns when applied (a column the query does not return is refused).
 */
export const QUERY_COLUMN_TAGS: Readonly<Record<string, Readonly<Record<string, QueryColumnTag>>>> = {
  // COALESCE(NULLIF(team.escalation_email, ''), NULLIF(org.escalation_fallback_email, '')) — the address a breach pages.
  "itops_demo.incidents_sla_breached": { notify_email: "email" },
  // The team's escalation address, else the org-wide fallback.
  "itops_demo.oncall_now": { escalation_email: "email" },
  // The obligation's owner, else the contract's (the two-level fallback).
  "legal_demo.obligations_due": { resolved_owner_email: "email" },
  // Finance's amounts are MINOR units (cents) — the units trap its dataset teaches (`amount_cents` is minor, `budgets.amount` major;
  // these queries already ×100 the budget). Computed (SUM / ×100 / differences), so no column comment reaches them.
  "finance_demo.spend_by_cost_centre": { budget_cents: "minor_units", invoice_cents: "minor_units", claim_cents: "minor_units", actual_cents: "minor_units", variance_cents: "minor_units" },
  "finance_demo.invoices_overdue": { outstanding_cents: "minor_units" },
  "finance_demo.claims_over_policy": { amount_cents: "minor_units", limit_cents: "minor_units", over_by_cents: "minor_units" },
};

import type { QueryColumnTag } from "../services/query-column-tags.js";

export const columnTagsFor = (datasource: string, query: string) => ({ ...(QUERY_COLUMN_TAGS[`${datasource}.${query}`] ?? {}) });
