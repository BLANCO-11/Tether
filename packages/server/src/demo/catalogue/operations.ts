/**
 * THE READERS each demo workspace holds — 2026-09-08.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * Measured before it did: four workspaces held **one** DB operation each, and
 * three tools. So every automation anybody could build was "read the one thing,
 * email it", and `needs_component` — the path where a turn notices there is no
 * reader and offers to build one — **fired zero times across eleven
 * conversations**, because a reusable-looking reader always existed. Flows
 * reused it even where it was plainly wrong: `orders_demo.past_due_orders` was
 * used for "unshipped orders", and `hiring_demo.expiring_offers` for "where
 * every candidate is in the process".
 *
 * ── ⚠ EVERY READER A NOTIFICATION COULD FOLLOW PROJECTS AN ADDRESS ──────────
 *
 * That is the point of the joins, and it is the fix for a measured defect
 * rather than a nicety. `past_due_orders` selected `customer_id` and never
 * joined `customers`, so a drafted flow wrote `{to: [.customer_email]}`, got
 * `null` eight times and failed at the last hop — and 14 of this deployment's
 * 29 transform steps had the same defect, most of them GREEN, because a jq read
 * of an absent key is null rather than an error. A reader whose rows cannot be
 * acted on invites exactly that guess.
 *
 * ── ⚠ TWO COMPILER LIMITS THESE SPECS ARE WRITTEN AROUND ────────────────────
 *
 * 1. **There is no `is_null` filter op.** `FILTER_OPS` is eq/neq/gt/gte/lt/lte/
 *    in/like. So "orders with no shipment" and "tickets with no first response"
 *    cannot be a filter. They are expressed as a `left` join that RETURNS the
 *    null, and the flow's own transform selects on it — which is honest: the
 *    absence is data, and a transform is where the product already filters.
 *
 * 2. **A column name cannot be qualified, and an ambiguous one silently
 *    resolves to the FIRST owner** (base table, then joins in spec order —
 *    `resolveColumn` returns on first hit and reports nothing). So `name` on a
 *    `tickets → customers → teams` join is `customers.name`, and there is no
 *    way to ask for `teams.name` at all. Every spec here is ordered so the
 *    intended table wins, and where it cannot be (a team's display name) the
 *    spec takes the unambiguous column instead — `contact_email`, which is the
 *    one a notification needs anyway. ⚠ **This is a real gap in the visual
 *    builder too**, not a quirk of seeding: a person joining two tables that
 *    share a column name gets the wrong one with no finding.
 */
import type { DbOperationSpecInput } from "../../services/db-operation.service.js";

export interface OperationSeed {
  name: string;
  description: string;
  spec: DbOperationSpecInput;
  /** Per-param prose. It is the drafter's WHOLE view of a parameter (I-126). */
  params: Record<string, string>;
  /**
   * compiled-builder D-323: the value a parameter TAKES whenever this operation means what its name says — `void_status` is
   * `void`, `prod_env` is `prod`. Declared as data, because in prose ("Use 'prod'") no builder can bind it and every build
   * asked the person for a constant they cannot know. Only fixed meanings: a threshold or a date is the person's to state.
   */
  defaults?: Record<string, string>;
  /** The shape of text a parameter takes where its column is typed as text — a `period` stored `YYYY-MM` is a `month`. */
  formats?: Record<string, "month" | "date">;
}

const AS_OF = "The date to judge against, YYYY-MM-DD. Normally today.";

/** `finance_demo` — invoices, vendors, cost centres, expense claims. */
const FINANCE: OperationSeed[] = [
  {
    name: "invoices_past_due",
    description:
      "Invoices whose due date has passed, with the vendor's contact address and the cost " +
      "centre owner's, so either can be chased. An invoice due ON the as-of date is NOT overdue.",
    params: { as_of: AS_OF },
    spec: {
      base: { table: "invoices" },
      joins: [
        { table: "vendors", onLeft: "vendor_id", onRight: "id", kind: "inner" },
        { table: "cost_centres", onLeft: "cost_centre_id", onRight: "id", kind: "left" },
      ],
      columns: [
        { column: "invoice_number", alias: "invoice_number" },
        { column: "amount_cents", alias: "amount_cents" },
        { column: "currency", alias: "currency" },
        { column: "issue_date", alias: "issue_date" },
        { column: "due_date", alias: "due_date" },
        { column: "status", alias: "invoice_status" },
        // `name` and `contact_email` resolve to vendors — it is the first join.
        { column: "name", alias: "vendor_name" },
        { column: "contact_email", alias: "vendor_email" },
        { column: "payment_terms_days", alias: "payment_terms_days" },
        { column: "code", alias: "cost_centre" },
        { column: "owner_email", alias: "cost_centre_owner_email" },
      ],
      filters: [{ column: "due_date", op: "lt", param: "as_of" }],
      sort: [{ column: "due_date", dir: "asc" }],
      limit: 500,
    },
  },
  {
    name: "expense_claims_recent",
    description:
      "Expense claims submitted on or after a date, with the claimant's address and the cost " +
      "centre owner's. Amounts are in MINOR units (cents); `budgets.amount` is major — a " +
      "comparison needs a x100 on one side.",
    params: { from_date: "Earliest claim date to include, YYYY-MM-DD." },
    spec: {
      base: { table: "expense_claims" },
      joins: [
        { table: "employees", onLeft: "employee_id", onRight: "id", kind: "inner" },
        { table: "cost_centres", onLeft: "cost_centre_id", onRight: "id", kind: "left" },
      ],
      columns: [
        { column: "claim_code", alias: "claim_code" },
        { column: "category", alias: "category" },
        { column: "claim_date", alias: "claim_date" },
        { column: "amount_cents", alias: "amount_cents" },
        { column: "status", alias: "claim_status" },
        { column: "full_name", alias: "employee_name" },
        { column: "work_email", alias: "employee_email" },
        { column: "code", alias: "cost_centre" },
        { column: "owner_email", alias: "cost_centre_owner_email" },
      ],
      filters: [{ column: "claim_date", op: "gte", param: "from_date" }],
      sort: [{ column: "claim_date", dir: "desc" }],
      limit: 500,
    },
  },
  {
    name: "vendor_spend_summary",
    description:
      "One row per vendor: how many invoices and how much, for invoices issued on or after a " +
      "date. Totals are in MINOR units. Use this for a digest; use invoices_overdue to chase.",
    params: { from_date: "Earliest issue date to include, YYYY-MM-DD." },
    spec: {
      base: { table: "invoices" },
      joins: [{ table: "vendors", onLeft: "vendor_id", onRight: "id", kind: "inner" }],
      columns: [
        { column: "name", alias: "vendor_name" },
        { column: "contact_email", alias: "vendor_email" },
        // `id` resolves to invoices.id — the base table is the first owner.
        { column: "id", aggregate: "count", alias: "invoice_count" },
        { column: "amount_cents", aggregate: "sum", alias: "total_cents" },
      ],
      filters: [{ column: "issue_date", op: "gte", param: "from_date" }],
      limit: 200,
    },
  },
  {
    name: "invoice_period_rows",
    description:
      "Invoice rows with the chase math already done: the effective due date (explicit " +
      "terms win, else issue plus vendor-or-org terms) and days past the as-of date. " +
      "Overdue selection and bucketing live in the flow.",
    params: {
      terms_key: "Org-settings key holding the default payment terms, normally default_payment_terms_days.",
      as_of: "The date to judge against, YYYY-MM-DD. Normally today.",
      void_status: "Invoice status meaning void. Use 'void'.",
      credit_status: "Invoice status meaning credit note. Use 'credit'.",
    },
    defaults: { terms_key: "default_payment_terms_days", void_status: "void", credit_status: "credit" },
    spec: {
      base: { table: "invoices" },
      joins: [
        { table: "vendors", onLeft: "vendor_id", onRight: "id", kind: "inner" },
        { table: "cost_centres", onLeft: "cost_centre_id", onRight: "id", kind: "left" },
        {
          table: "org_settings",
          kind: "left",
          latestOne: {
            orderBy: [{ column: "key", dir: "asc" }],
            filters: [{ column: "key", op: "eq", param: "terms_key" }],
          },
        },
      ],
      aggregateJoins: [
        {
          table: "payments",
          groupBy: "invoice_id",
          onLeft: "id",
          kind: "left",
          aggregates: [{ column: "amount_cents", aggregate: "sum", alias: "paid_cents" }],
        },
      ],
      columns: [
        { column: "invoice_number", alias: "invoice_number" },
        { column: "vendor_code", alias: "vendor_code" },
        { column: "name", alias: "vendor_name" },
        { column: "contact_email", alias: "contact_email" },
        { column: "code", alias: "cost_centre_code" },
        { column: "issue_date", alias: "issue_date" },
        { column: "due_date", alias: "due_date" },
        { column: "amount_cents", alias: "amount_cents" },
        { column: "paid_cents", alias: "paid_cents" },
        { column: "payment_terms_days", alias: "payment_terms_days" },
        { column: "value", alias: "org_terms_days" },
        {
          compute: {
            coalesce: [
              { column: "due_date" },
              {
                addDays: {
                  value: { column: "issue_date" },
                  days: { coalesce: [{ column: "payment_terms_days" }, { column: "value" }] },
                },
              },
            ],
          },
          alias: "effective_due_date",
        },
        {
          compute: {
            diffDays: {
              start: {
                coalesce: [
                  { column: "due_date" },
                  {
                    addDays: {
                      value: { column: "issue_date" },
                      days: { coalesce: [{ column: "payment_terms_days" }, { column: "value" }] },
                    },
                  },
                ],
              },
              end: { param: "as_of", type: "date" },
            },
          },
          alias: "days_past_due",
        },
      ],
      filters: [
        { column: "status", op: "neq", param: "void_status" },
        { column: "status", op: "neq", param: "credit_status" },
      ],
      sort: [{ column: "invoice_number", dir: "asc" }],
      limit: 5000,
    },
  },
  {
    name: "claim_period_rows",
    description:
      "Expense claims for the period with the claimant, the cost centre, and the policy " +
      "limit in force on the claim's own date. Over-policy selection lives in the flow.",
    params: {
      period: "Month to report on, YYYY-MM.",
      rejected_status: "Claim status meaning rejected. Use 'rejected'.",
    },
    formats: { period: "month" },
    defaults: { rejected_status: "rejected" },
    spec: {
      base: { table: "expense_claims" },
      joins: [
        { table: "employees", onLeft: "employee_id", onRight: "id", kind: "inner" },
        { table: "cost_centres", onLeft: "cost_centre_id", onRight: "id", kind: "inner" },
        {
          table: "expense_policy",
          onLeft: "category",
          onRight: "category",
          kind: "left",
          latestOne: {
            orderBy: [
              { column: "effective_from", dir: "desc" },
              { column: "id", dir: "desc" },
            ],
            filters: [{ column: "effective_from", op: "lte", outerColumn: "claim_date" }],
          },
        },
      ],
      columns: [
        { column: "claim_code", alias: "claim_code" },
        { column: "full_name", alias: "employee_name" },
        { column: "work_email", alias: "employee_email" },
        { column: "code", alias: "cost_centre_code" },
        { column: "owner_email", alias: "cost_centre_owner_email" },
        { column: "category", alias: "category" },
        { column: "claim_date", alias: "claim_date" },
        { column: "amount_cents", alias: "amount_cents" },
        { column: "limit_cents", alias: "limit_cents" },
      ],
      filters: [
        { column: "status", op: "neq", param: "rejected_status" },
        { column: "claim_date", op: "month", param: "period" },
      ],
      sort: [{ column: "claim_code", dir: "asc" }],
      limit: 2000,
    },
  },
  {
    name: "centre_spend_sums",
    description:
      "One row per cost centre with its budget and its invoiced and claimed spend for the " +
      "period — every centre, including dormant ones with neither. Variance arithmetic " +
      "lives in the flow: cents math is presentation, not data.",
    params: {
      period: "Month to report on, YYYY-MM.",
      void_status: "Invoice status meaning void. Use 'void'.",
      rejected_status: "Claim status meaning rejected. Use 'rejected'.",
    },
    formats: { period: "month" },
    defaults: { void_status: "void", rejected_status: "rejected" },
    spec: {
      base: { table: "cost_centres" },
      aggregateJoins: [
        {
          table: "budgets",
          groupBy: "cost_centre_id",
          onLeft: "id",
          kind: "left",
          aggregates: [
            { column: "amount", aggregate: "sum", alias: "budget_dollars" },
            { column: "amount", aggregate: "max", alias: "budget_amount_major" },
          ],
          filters: [{ column: "period", op: "eq", param: "period" }],
        },
        {
          table: "invoices",
          groupBy: "cost_centre_id",
          onLeft: "id",
          kind: "left",
          aggregates: [{ column: "amount_cents", aggregate: "sum", alias: "invoice_cents" }],
          filters: [
            { column: "issue_date", op: "month", param: "period" },
            { column: "status", op: "neq", param: "void_status" },
          ],
        },
        {
          table: "expense_claims",
          groupBy: "cost_centre_id",
          onLeft: "id",
          kind: "left",
          aggregates: [{ column: "amount_cents", aggregate: "sum", alias: "claim_cents" }],
          filters: [
            { column: "claim_date", op: "month", param: "period" },
            { column: "status", op: "neq", param: "rejected_status" },
          ],
        },
      ],
      columns: [
        { column: "code", alias: "cost_centre_code" },
        { column: "name", alias: "cost_centre_name" },
        { column: "owner_email", alias: "owner_email" },
        { column: "budget_dollars", alias: "budget_dollars" },
        { column: "budget_amount_major", alias: "budget_amount_major" },
        { column: "invoice_cents", alias: "invoice_cents" },
        { column: "claim_cents", alias: "claim_cents" },
      ],
      sort: [{ column: "code", dir: "asc" }],
      limit: 500,
    },
  },
];

/** `support_demo` — tickets, customers, teams, agents, CSAT. */
const SUPPORT: OperationSeed[] = [
  {
    name: "tickets_by_status",
    description:
      "Tickets in one status, with the customer's address, the assignee's and the team's, plus " +
      "the response and resolution timestamps. `first_response_at` is NULL when nobody has " +
      "replied yet — that is data, not an error, and is how you find un-answered tickets.",
    params: { status: "One of: open, pending, waiting_for_reply, resolved, closed." },
    spec: {
      base: { table: "tickets" },
      joins: [
        { table: "customers", onLeft: "customer_id", onRight: "id", kind: "inner" },
        { table: "teams", onLeft: "team_code", onRight: "code", kind: "left" },
        { table: "agents", onLeft: "assignee_id", onRight: "id", kind: "left" },
      ],
      columns: [
        { column: "ticket_code", alias: "ticket_code" },
        { column: "subject", alias: "subject" },
        { column: "priority", alias: "priority" },
        { column: "opened_priority", alias: "opened_priority" },
        { column: "status", alias: "ticket_status" },
        { column: "opened_at", alias: "opened_at" },
        { column: "first_response_at", alias: "first_response_at" },
        { column: "resolved_at", alias: "resolved_at" },
        { column: "name", alias: "customer_name" },
        { column: "email", alias: "customer_email" },
        { column: "plan", alias: "plan" },
        { column: "team_code", alias: "team_code" },
        // ⚠ `contact_email` and not `name` for the team: `name` would resolve to
        // `customers.name`, the first join. There is no way to qualify it.
        { column: "contact_email", alias: "team_email" },
        { column: "full_name", alias: "assignee_name" },
        { column: "work_email", alias: "assignee_email" },
      ],
      filters: [{ column: "status", op: "eq", param: "status" }],
      sort: [{ column: "opened_at", dir: "asc" }],
      limit: 500,
    },
  },
  {
    name: "tickets_opened_since",
    description:
      "Every ticket opened on or after a date, whatever its status, with the customer's and the " +
      "team's addresses. Use this for a digest over a period; use tickets_by_status to act.",
    params: { since: "Earliest opened_at to include, YYYY-MM-DD." },
    spec: {
      base: { table: "tickets" },
      joins: [
        { table: "customers", onLeft: "customer_id", onRight: "id", kind: "inner" },
        { table: "teams", onLeft: "team_code", onRight: "code", kind: "left" },
      ],
      columns: [
        { column: "ticket_code", alias: "ticket_code" },
        { column: "subject", alias: "subject" },
        { column: "priority", alias: "priority" },
        { column: "status", alias: "ticket_status" },
        { column: "opened_at", alias: "opened_at" },
        { column: "first_response_at", alias: "first_response_at" },
        { column: "resolved_at", alias: "resolved_at" },
        { column: "name", alias: "customer_name" },
        { column: "email", alias: "customer_email" },
        { column: "plan", alias: "plan" },
        { column: "team_code", alias: "team_code" },
        { column: "contact_email", alias: "team_email" },
      ],
      filters: [{ column: "opened_at", op: "gte", param: "since" }],
      sort: [{ column: "opened_at", dir: "desc" }],
      limit: 500,
    },
  },
  {
    name: "csat_scores",
    description:
      "Survey responses at or below a score, with the ticket and the customer's address. " +
      "⚠ A non-response is NOT a satisfied customer: `surveyed` says whether anyone was asked, " +
      "and averaging over responders only answers a question nobody asked.",
    params: { max_score: "Highest score to include, 1-5. Use 3 for 'unhappy'." },
    spec: {
      base: { table: "csat_responses" },
      joins: [
        { table: "tickets", onLeft: "ticket_id", onRight: "id", kind: "inner" },
        { table: "customers", onLeft: "customer_id", onRight: "id", kind: "inner" },
      ],
      columns: [
        { column: "score", alias: "score" },
        { column: "surveyed", alias: "surveyed" },
        { column: "comment", alias: "comment" },
        { column: "ticket_code", alias: "ticket_code" },
        { column: "subject", alias: "subject" },
        { column: "team_code", alias: "team_code" },
        { column: "name", alias: "customer_name" },
        { column: "email", alias: "customer_email" },
      ],
      filters: [{ column: "score", op: "lte", param: "max_score" }],
      sort: [{ column: "score", dir: "asc" }],
      limit: 500,
    },
  },
  {
    name: "ticket_sla_rows",
    description:
      "Every open ticket with its customer, plan, owning team, assignee, age in clock " +
      "minutes, and resolution budget in minutes. Escalation is derived in the flow " +
      "(priority differs from opened_priority), not stored. The org default is the " +
      "single settings row — one row per ticket, never a fan-out.",
    params: {
      as_of: "The moment to judge against, ISO timestamp. Normally now.",
      resolved_status: "Status value meaning closed. Use 'resolved'.",
    },
    defaults: { resolved_status: "resolved" },
    spec: {
      base: { table: "tickets" },
      joins: [
        { table: "customers", onLeft: "customer_id", onRight: "id", kind: "inner" },
        {
          table: "sla_policies",
          onLeft: "plan",
          onRight: "plan",
          andOn: [{ left: "priority", right: "priority" }],
          kind: "left",
        },
        { table: "teams", onLeft: "team_code", onRight: "code", kind: "left" },
        { table: "agents", onLeft: "assignee_id", onRight: "id", kind: "left" },
        { table: "org_settings", kind: "left", latestOne: { orderBy: [{ column: "id", dir: "asc" }] } },
      ],
      columns: [
        { column: "ticket_code", alias: "ticket_code" },
        { column: "subject", alias: "subject" },
        { column: "name", alias: "customer_name" },
        { column: "plan", alias: "plan" },
        { column: "priority", alias: "priority" },
        { column: "opened_priority", alias: "opened_priority" },
        { column: "team_code", alias: "team_code" },
        { column: "contact_email", alias: "team_email" },
        { column: "full_name", alias: "assignee_name" },
        { column: "work_email", alias: "assignee_email" },
        { compute: { diffMinutes: { end: { param: "as_of" }, start: { column: "opened_at" } } }, alias: "age_mins" },
        { compute: { coalesce: [{ column: "resolve_mins" }, { column: "default_resolve_mins" }] }, alias: "resolve_budget_mins" },
      ],
      filters: [{ column: "status", op: "neq", param: "resolved_status" }],
      sort: [{ column: "opened_at", dir: "asc" }],
      limit: 2000,
    },
  },
];

/** `orders_demo` — orders, customers, lines, shipments, inventory. */
const ORDERS: OperationSeed[] = [
  {
    name: "orders_past_promised_date",
    description:
      "Orders whose promised date has passed, WITH the customer's name and email address so " +
      "they can be told. Also carries the shipment's `shipped_at`, which is NULL when nothing " +
      "has shipped — a partial shipment is not a fulfilled order, so filter on it rather than " +
      "assuming a shipment row means done.",
    params: { as_of: AS_OF },
    spec: {
      base: { table: "orders" },
      joins: [
        { table: "customers", onLeft: "customer_id", onRight: "id", kind: "inner" },
        { table: "shipments", onLeft: "id", onRight: "order_id", kind: "left" },
      ],
      columns: [
        { column: "order_code", alias: "order_code" },
        { column: "status", alias: "order_status" },
        { column: "channel", alias: "channel" },
        { column: "placed_at", alias: "placed_at" },
        { column: "promised_at", alias: "promised_at" },
        { column: "name", alias: "customer_name" },
        { column: "email", alias: "customer_email" },
        { column: "segment", alias: "segment" },
        { column: "shipped_at", alias: "shipped_at" },
        { column: "carrier", alias: "carrier" },
        { column: "tracking", alias: "tracking" },
      ],
      filters: [{ column: "promised_at", op: "lt", param: "as_of" }],
      sort: [{ column: "promised_at", dir: "asc" }],
      limit: 500,
    },
  },
  {
    name: "order_lines_by_status",
    description:
      "Order lines in one status, with the product, the order and the customer's address. " +
      "⚠ A CANCELLED line is not revenue — `line_status` says which. Prices are in MINOR units.",
    params: { line_status: "One of: pending, allocated, shipped, cancelled." },
    spec: {
      base: { table: "order_lines" },
      joins: [
        { table: "orders", onLeft: "order_id", onRight: "id", kind: "inner" },
        { table: "customers", onLeft: "customer_id", onRight: "id", kind: "inner" },
        { table: "products", onLeft: "sku", onRight: "sku", kind: "left" },
      ],
      columns: [
        { column: "sku", alias: "sku" },
        { column: "qty", alias: "qty" },
        { column: "unit_price_cents", alias: "unit_price_cents" },
        { column: "line_discount_cents", alias: "line_discount_cents" },
        { column: "status", alias: "line_status" },
        { column: "order_code", alias: "order_code" },
        { column: "promised_at", alias: "promised_at" },
        { column: "name", alias: "customer_name" },
        { column: "email", alias: "customer_email" },
        { column: "category", alias: "category" },
      ],
      filters: [{ column: "status", op: "eq", param: "line_status" }],
      limit: 500,
    },
  },
  {
    name: "stock_below_threshold",
    description:
      "Inventory at or below an on-hand threshold, with the product and the warehouse's contact " +
      "address so somebody can be told to reorder. `reserved` is already promised to an order.",
    params: { max_on_hand: "Highest on-hand count to include. Try the org's low_stock_threshold." },
    spec: {
      base: { table: "inventory" },
      joins: [
        { table: "products", onLeft: "sku", onRight: "sku", kind: "inner" },
        { table: "warehouses", onLeft: "warehouse_code", onRight: "code", kind: "inner" },
      ],
      columns: [
        { column: "sku", alias: "sku" },
        { column: "on_hand", alias: "on_hand" },
        { column: "reserved", alias: "reserved" },
        { column: "warehouse_code", alias: "warehouse_code" },
        { column: "name", alias: "product_name" },
        { column: "category", alias: "category" },
        { column: "discontinued", alias: "discontinued" },
        { column: "region", alias: "region" },
        { column: "contact_email", alias: "warehouse_email" },
      ],
      filters: [{ column: "on_hand", op: "lte", param: "max_on_hand" }],
      sort: [{ column: "on_hand", dir: "asc" }],
      limit: 500,
    },
  },
  {
    name: "open_order_line_rows",
    description:
      "Every non-cancelled order line with its order, customer, value parts, ship state, " +
      "and age against the promise. Rollup (per-order totals, late test) lives in the " +
      "flow — one compiled SQL shape feeds every per-order question. A null shipped_at " +
      "means not yet shipped.",
    params: {
      as_of: "The moment to judge against, ISO timestamp. Normally now.",
      cancelled_status: "Line status meaning void. Use 'cancelled'.",
    },
    defaults: { cancelled_status: "cancelled" },
    spec: {
      base: { table: "order_lines" },
      joins: [
        { table: "orders", onLeft: "order_id", onRight: "id", kind: "inner" },
        { table: "customers", onLeft: "customer_id", onRight: "id", kind: "inner" },
        { table: "shipments", onLeft: "id", onRight: "order_line_id", kind: "left" },
      ],
      columns: [
        { column: "order_id", alias: "order_id" },
        { column: "order_code", alias: "order_code" },
        { column: "name", alias: "customer_name" },
        { column: "email", alias: "customer_email" },
        { column: "segment", alias: "segment" },
        { column: "channel", alias: "channel" },
        { column: "status", alias: "line_status" },
        { column: "qty", alias: "qty" },
        { column: "unit_price_cents", alias: "unit_price_cents" },
        { column: "line_discount_cents", alias: "line_discount_cents" },
        { column: "shipped_at", alias: "shipped_at" },
        { compute: { diffDays: { end: { param: "as_of" }, start: { column: "placed_at" } } }, alias: "age_days" },
        { compute: { diffDays: { end: { param: "as_of" }, start: { column: "promised_at" } } }, alias: "days_past_promise" },
      ],
      filters: [{ column: "status", op: "neq", param: "cancelled_status" }],
      sort: [{ column: "promised_at", dir: "asc" }],
      limit: 5000,
    },
  },
];

/** `hiring_demo` — offers, applications, candidates, requisitions. */
const HIRING: OperationSeed[] = [
  {
    name: "offers_expiring_status",
    description:
      "Offers expiring on or before a date, with the candidate's name and email and the hiring " +
      "manager's, so either can be chased. `offer_status` says whether it is still outstanding.",
    params: { by_date: "Latest expiry date to include, YYYY-MM-DD." },
    spec: {
      base: { table: "offers" },
      joins: [
        { table: "applications", onLeft: "application_id", onRight: "id", kind: "inner" },
        { table: "candidates", onLeft: "candidate_id", onRight: "id", kind: "inner" },
        { table: "requisitions", onLeft: "requisition_id", onRight: "id", kind: "inner" },
      ],
      columns: [
        { column: "made_at", alias: "made_at" },
        { column: "expires_at", alias: "expires_at" },
        { column: "status", alias: "offer_status" },
        { column: "accepted_at", alias: "accepted_at" },
        { column: "full_name", alias: "candidate_name" },
        { column: "email", alias: "candidate_email" },
        { column: "req_code", alias: "req_code" },
        { column: "title", alias: "role_title" },
        { column: "department", alias: "department" },
        { column: "hiring_manager_email", alias: "hiring_manager_email" },
      ],
      filters: [{ column: "expires_at", op: "lte", param: "by_date" }],
      sort: [{ column: "expires_at", dir: "asc" }],
      limit: 500,
    },
  },
  {
    name: "applications_inactive_since",
    description:
      "Applications with no activity since a date, with the candidate's address, the recruiter's " +
      "and the hiring manager's. ⚠ `current_stage` is where a candidate IS; `furthest_stage` is " +
      "the furthest they REACHED — a rejected candidate still reached the interview stage.",
    params: { inactive_since: "Applications with last_activity_at before this date, YYYY-MM-DD." },
    spec: {
      base: { table: "applications" },
      joins: [
        { table: "candidates", onLeft: "candidate_id", onRight: "id", kind: "inner" },
        { table: "requisitions", onLeft: "requisition_id", onRight: "id", kind: "inner" },
        { table: "recruiters", onLeft: "recruiter_id", onRight: "id", kind: "left" },
      ],
      columns: [
        { column: "applied_at", alias: "applied_at" },
        { column: "current_stage", alias: "current_stage" },
        { column: "furthest_stage", alias: "furthest_stage" },
        { column: "status", alias: "application_status" },
        { column: "last_activity_at", alias: "last_activity_at" },
        { column: "full_name", alias: "candidate_name" },
        { column: "email", alias: "candidate_email" },
        { column: "source", alias: "source" },
        { column: "req_code", alias: "req_code" },
        { column: "title", alias: "role_title" },
        { column: "department", alias: "department" },
        { column: "hiring_manager_email", alias: "hiring_manager_email" },
        { column: "work_email", alias: "recruiter_email" },
      ],
      filters: [{ column: "last_activity_at", op: "lt", param: "inactive_since" }],
      sort: [{ column: "last_activity_at", dir: "asc" }],
      limit: 500,
    },
  },
  {
    name: "requisitions_by_status",
    description:
      "Requisitions in one status, with the recruiter's and the hiring manager's addresses and " +
      "the headcount still to fill. ⚠ An application is not a candidate — people apply twice, " +
      "so counting applications double-counts the keenest applicants.",
    params: { status: "One of: open, on_hold, filled, cancelled." },
    spec: {
      base: { table: "requisitions" },
      joins: [{ table: "recruiters", onLeft: "recruiter_id", onRight: "id", kind: "left" }],
      columns: [
        { column: "req_code", alias: "req_code" },
        { column: "title", alias: "role_title" },
        { column: "department", alias: "department" },
        { column: "location", alias: "location" },
        { column: "status", alias: "requisition_status" },
        { column: "opened_at", alias: "opened_at" },
        { column: "closed_at", alias: "closed_at" },
        { column: "headcount", alias: "headcount" },
        { column: "hiring_manager_email", alias: "hiring_manager_email" },
        { column: "full_name", alias: "recruiter_name" },
        { column: "work_email", alias: "recruiter_email" },
      ],
      filters: [{ column: "status", op: "eq", param: "status" }],
      sort: [{ column: "opened_at", dir: "asc" }],
      limit: 500,
    },
  },
  {
    name: "outstanding_offer_rows",
    description:
      "Outstanding offers made at or before the cutoff, with requisition, candidate, " +
      "recruiter and expiry. Urgency (days to expiry) lives in the flow — SQL states " +
      "the deadline, presentation decides the hurry. A recruiter without a work email " +
      "falls back to the hiring manager in the flow.",
    params: {
      as_of: "Latest made-at to include, ISO date or timestamp. Normally today.",
      outstanding_status: "Offer status meaning awaiting signature. Use 'outstanding'.",
    },
    defaults: { outstanding_status: "outstanding" },
    spec: {
      base: { table: "offers" },
      joins: [
        { table: "applications", onLeft: "application_id", onRight: "id", kind: "inner" },
        { table: "requisitions", onLeft: "requisition_id", onRight: "id", kind: "inner" },
        { table: "candidates", onLeft: "candidate_id", onRight: "id", kind: "inner" },
        { table: "recruiters", onLeft: "recruiter_id", onRight: "id", kind: "left" },
      ],
      columns: [
        { compute: { diffDays: { end: { column: "expires_at" }, start: { param: "as_of" } } }, alias: "days_to_expiry" },
        { column: "req_code", alias: "req_code" },
        { column: "title", alias: "role_title" },
        { column: "full_name", alias: "candidate_name" },
        { column: "email", alias: "candidate_email" },
        { column: "made_at", alias: "made_at" },
        { column: "expires_at", alias: "expires_at" },
        { column: "work_email", alias: "recruiter_email" },
        { column: "hiring_manager_email", alias: "hiring_manager_email" },
      ],
      filters: [
        { column: "status", op: "eq", param: "outstanding_status" },
        { column: "made_at", op: "lte", param: "as_of" },
      ],
      sort: [{ column: "expires_at", dir: "asc" }],
      limit: 500,
    },
  },
];
/** `itops_demo` — incidents, services, SLA policies, on-call, vulnerabilities.
 *
 * ── ⚠ CONSUMED MINUTES, FAITHFULLY ──────────────────────────────────────────
 * A breach is consumed minutes past budget, where consumed is the service's own
 * clock (business-hours services count Mon–Fri 09–17 UTC; the rest count wall
 * time) less paused time on that same clock, floored at zero. The old
 * hand-written queries computed exactly this, and the fixture oracle defines
 * it as correct — a clock-time shortcut pages four incidents the oracle calls
 * healthy, measured 2026-09-09, so the shortcut is refused here.
 *
 * The SQL stays branchless: the operation exposes the parts (gross elapsed on
 * both clocks, per-pause overlaps on both clocks, the service's clock flag)
 * and the flow picks per service and sums per incident. One row per
 * (incident, pause); incidents without pauses yield one null-pause row, and
 * the flow's `group_by` collapses both shapes identically.
 */
const ITOPS: OperationSeed[] = [
  {
    name: "incident_sla_rows",
    description:
      "Open incidents (unresolved, or resolved after the cutoff) with service, owning " +
      "team, SLA budget, elapsed clock minutes, gross business minutes, the team's " +
      "escalation address plus the org fallback, and one row per pause with its " +
      "overlap on both clocks. The flow derives consumed minutes (service clock " +
      "less pauses, floored at zero) and the escalation recipient (team address, " +
      "else org fallback) — SQL states the parts, the flow does the choosing. " +
      "Every (tier, priority) in the data has a policy row, so no org fallback " +
      "on budget — an uncovered tier would surface as a null budget, loudly.",
    params: {
      as_of: "The moment to judge against, ISO timestamp. Normally now.",
      fallback_key: "Org-settings key for the fallback escalation address. Use 'escalation_fallback_email'.",
    },
    defaults: { fallback_key: "escalation_fallback_email" },
    spec: {
      base: { table: "incidents" },
      joins: [
        { table: "services", onLeft: "service_id", onRight: "id", kind: "inner" },
        { table: "teams", onLeft: "owner_team_id", onRight: "id", kind: "inner" },
        {
          table: "sla_policies",
          onLeft: "tier",
          onRight: "tier",
          andOn: [{ left: "priority", right: "priority" }],
          kind: "left",
        },
        { table: "incident_pauses", onLeft: "id", onRight: "incident_id", kind: "left" },
        {
          table: "org_settings",
          kind: "left",
          latestOne: {
            orderBy: [{ column: "key", dir: "asc" }],
            filters: [{ column: "key", op: "eq", param: "fallback_key" }],
          },
        },
      ],
      columns: [
        { column: "incident_code", alias: "incident_code" },
        { column: "priority", alias: "priority" },
        { column: "summary", alias: "summary" },
        { column: "service_code", alias: "service_code" },
        { column: "name", alias: "service_name" },
        { column: "tier", alias: "tier" },
        { column: "business_hours_only", alias: "business_hours_only" },
        { column: "team_code", alias: "team_code" },
        { column: "contact_email", alias: "notify_email" },
        { column: "escalation_email", alias: "team_escalation" },
        { column: "value", alias: "org_escalation" },
        { column: "resolve_mins", alias: "resolve_budget_mins" },
        // ⚠ The window ends at `as_of`, not at resolution: a `resolved_at`
        // later than `as_of` is a future this reading must not count, so the
        // endpoint is LEAST(coalesce(resolved, as_of), as_of) — exactly the
        // oracle's `resolvedByAsOf ? resolvedAt : asOf`. A bare coalesce
        // over-pages every incident resolved after the reading.
        { compute: { diffMinutes: { end: { least: { first: { coalesce: [{ column: "resolved_at" }, { param: "as_of" }] }, second: { param: "as_of" } } }, start: { column: "opened_at" } } }, alias: "elapsed_mins" },
        { compute: { businessMinutes: { end: { least: { first: { coalesce: [{ column: "resolved_at" }, { param: "as_of" }] }, second: { param: "as_of" } } }, start: { column: "opened_at" } } }, alias: "gross_biz_mins" },
        { column: "started_at", alias: "pause_started_at" },
        { column: "ended_at", alias: "pause_ended_at" },
        {
          compute: {
            diffMinutes: {
              start: { greatest: { first: { column: "started_at" }, second: { column: "opened_at" } } },
              end: { least: { first: { coalesce: [{ column: "ended_at" }, { column: "resolved_at" }, { param: "as_of" }] }, second: { least: { first: { coalesce: [{ column: "resolved_at" }, { param: "as_of" }] }, second: { param: "as_of" } } } } },
            },
          },
          alias: "overlap_clock_mins",
        },
        {
          compute: {
            businessMinutes: {
              start: { greatest: { first: { column: "started_at" }, second: { column: "opened_at" } } },
              end: { least: { first: { coalesce: [{ column: "ended_at" }, { column: "resolved_at" }, { param: "as_of" }] }, second: { least: { first: { coalesce: [{ column: "resolved_at" }, { param: "as_of" }] }, second: { param: "as_of" } } } } },
            },
          },
          alias: "overlap_biz_mins",
        },
      ],
      filters: [
        { column: "opened_at", op: "lte", param: "as_of" },
        { column: "resolved_at", op: "is_null", orGroup: "open" },
        { column: "resolved_at", op: "gt", param: "as_of", orGroup: "open" },
      ],
      sort: [{ column: "opened_at", dir: "asc" }],
      limit: 2000,
    },
  },
  {
    name: "oncall_roster_rows",
    description:
      "Every team with its contact, escalation chain, and the shift covering as_of — " +
      "one row per team, shift columns null when nobody is rostered. The org fallback " +
      "address is looked up by key so a renamed key fails loudly at install, not " +
      "silently at 03:00.",
    params: {
      as_of: "The moment the shift must cover, ISO timestamp. Normally now.",
      fallback_key: "Org-settings key for the fallback address. Use 'escalation_fallback_email'.",
    },
    defaults: { fallback_key: "escalation_fallback_email" },
    spec: {
      base: { table: "teams" },
      joins: [
        {
          table: "org_settings",
          kind: "left",
          latestOne: {
            orderBy: [{ column: "key", dir: "asc" }],
            filters: [{ column: "key", op: "eq", param: "fallback_key" }],
          },
        },
        {
          table: "on_call",
          onLeft: "id",
          onRight: "team_id",
          kind: "left",
          latestOne: {
            orderBy: [{ column: "starts_at", dir: "desc" }],
            filters: [
              { column: "starts_at", op: "lte", param: "as_of" },
              { column: "ends_at", op: "gt", param: "as_of" },
            ],
          },
        },
      ],
      columns: [
        { column: "team_code", alias: "team_code" },
        { column: "name", alias: "team_name" },
        { column: "contact_email", alias: "contact_email" },
        { column: "escalation_email", alias: "team_escalation" },
        { column: "value", alias: "org_escalation" },
        { column: "person_name", alias: "oncall_person" },
        { column: "person_email", alias: "oncall_email" },
        { column: "starts_at", alias: "shift_starts" },
        { column: "ends_at", alias: "shift_ends" },
      ],
      sort: [{ column: "team_code", dir: "asc" }],
      limit: 200,
    },
  },
  {
    name: "vuln_finding_rows",
    description:
      "Unfixed findings on prod assets with a fix available, with severity, age, owner, " +
      "staleness limit, and any active change freeze. The flow splits proceed/deferred " +
      "on deferred_until and computes staleness from age_days against the limit — " +
      "SQL states the dates, presentation decides the hurry.",
    params: {
      as_of: "The moment to judge against, ISO timestamp. Normally now.",
      stale_key: "Org-settings key for the stale-asset threshold in days. Use 'stale_asset_days'.",
      missing_state: "Finding state meaning still unfixed. Use 'missing'.",
      prod_env: "Environment value for production. Use 'prod'.",
      fix_present: "Fix-availability flag. Always pass JSON true — the compiler has no boolean literal, so truth travels as a parameter.",
    },
    defaults: { stale_key: "stale_asset_days", missing_state: "missing", prod_env: "prod", fix_present: "true" },
    spec: {
      base: { table: "asset_vulnerabilities" },
      joins: [
        { table: "assets", onLeft: "asset_id", onRight: "id", kind: "inner" },
        { table: "vulnerabilities", onLeft: "cve", onRight: "cve", kind: "inner" },
        { table: "services", onLeft: "service_id", onRight: "id", kind: "left" },
        { table: "teams", onLeft: "owner_team_id", onRight: "id", kind: "left" },
        {
          table: "org_settings",
          kind: "left",
          latestOne: {
            orderBy: [{ column: "key", dir: "asc" }],
            filters: [{ column: "key", op: "eq", param: "stale_key" }],
          },
        },
        {
          table: "change_freezes",
          onLeft: "service_id",
          onRight: "service_id",
          kind: "left",
          latestOne: {
            orderBy: [{ column: "ends_at", dir: "asc" }],
            orUnmatched: true,
            filters: [
              { column: "starts_at", op: "lte", param: "as_of" },
              { column: "ends_at", op: "gt", param: "as_of" },
            ],
          },
        },
      ],
      columns: [
        { column: "cve", alias: "cve" },
        { column: "title", alias: "title" },
        { column: "severity", alias: "severity" },
        { column: "kev", alias: "kev" },
        { column: "hostname", alias: "hostname" },
        { column: "service_code", alias: "service_code" },
        { column: "team_code", alias: "team_code" },
        { column: "contact_email", alias: "notify_email" },
        { compute: { diffDays: { end: { param: "as_of" }, start: { column: "last_seen_at" } } }, alias: "age_days" },
        { column: "value", alias: "stale_limit_days" },
        { column: "ends_at", alias: "deferred_until" },
        { column: "freeze_code", alias: "blocked_by_freeze" },
      ],
      filters: [
        { column: "state", op: "eq", param: "missing_state" },
        { column: "environment", op: "eq", param: "prod_env" },
        { column: "fix_available", op: "eq", param: "fix_present" },
      ],
      sort: [{ column: "cve", dir: "asc" }],
      limit: 2000,
    },
  },
];

/** `hr_demo` — attendance rows with their effective minimum, leavers on record.
 *
 * ── ⚠ THE THRESHOLD LOOKUP IS A LATERAL, NOT A JOIN ─────────────────────────
 * The old named queries resolved each employee's minimum inside SQL (a lateral
 * effective-date join with an org-wide fallback). A plain join cannot express
 * "newest row wins", so this is a `latestOne` lookup: the department's newest
 * applicable row preferred, the org row (`department_id` null) as fallback,
 * both ordered inside one correlated subquery. A threshold nobody can see
 * being picked is a threshold nobody reviewed — the readback names it.
 */
const HR: OperationSeed[] = [
  {
    name: "attendance_period_rows",
    description:
      "One row per employee with an attendance record for the period: the rate, the address, " +
      "the department, and the employment facts the chase rules need (status, exit date). " +
      "Leavers and people on leave are EXCLUDED here — they are reported by name, not chased.",
    params: {
      period: "Month to report on, YYYY-MM.",
      not_exited: "Employment status meaning exited. Excluded here — leavers are reported, not chased. Use 'exited'.",
      not_on_leave: "Employment status meaning on leave. Excluded here for the same reason. Use 'on_leave'.",
      as_of: "Latest policy date to honour, YYYY-MM-DD. Normally the period's last day.",
    },
    formats: { period: "month" },
    defaults: { not_exited: "exited", not_on_leave: "on_leave" },
    spec: {
      base: { table: "attendance_monthly" },
      joins: [
        { table: "employees", onLeft: "employee_id", onRight: "id", kind: "inner" },
        { table: "departments", onLeft: "department_id", onRight: "id", kind: "left" },
        {
          table: "policy_thresholds",
          onLeft: "department_id",
          onRight: "department_id",
          kind: "left",
          latestOne: {
            orderBy: [
              { column: "department_id", dir: "asc" },
              { column: "effective_from", dir: "desc" },
              { column: "id", dir: "desc" },
            ],
            orUnmatched: true,
            filters: [{ column: "effective_from", op: "lte", param: "as_of" }],
          },
        },
      ],
      columns: [
        { column: "employee_id", alias: "employee_id" },
        { column: "full_name", alias: "full_name" },
        { column: "work_email", alias: "work_email" },
        { column: "code", alias: "department_code" },
        { column: "name", alias: "department_name" },
        { column: "attendance_rate", alias: "attendance_rate" },
        { column: "min_attendance_rate", alias: "min_attendance_rate" },
        { column: "status", alias: "status" },
        { column: "exit_date", alias: "exit_date" },
        { column: "period", alias: "period" },
      ],
      filters: [
        { column: "period", op: "eq", param: "period" },
        { column: "status", op: "neq", param: "not_exited" },
        { column: "status", op: "neq", param: "not_on_leave" },
      ],
      sort: [{ column: "employee_id", dir: "asc" }],
      limit: 5000,
    },
  },
  {
    name: "employees_with_attendance",
    description:
      "Employees in the given employment states who have an attendance record for the period — " +
      "the leavers-and-leave report. The reason wording lives in the flow: it is presentation, " +
      "not data.",
    params: {
      statuses: "Employment states to include, e.g. [exited, on_leave].",
      period: "Month to report on, YYYY-MM.",
    },
    formats: { period: "month" },
    spec: {
      base: { table: "employees" },
      joins: [{ table: "attendance_monthly", onLeft: "id", onRight: "employee_id", kind: "inner" }],
      columns: [
        { column: "id", alias: "employee_id" },
        { column: "full_name", alias: "full_name" },
        { column: "work_email", alias: "work_email" },
        { column: "status", alias: "status" },
        { column: "exit_date", alias: "exit_date" },
      ],
      filters: [
        { column: "status", op: "in", param: "statuses" },
        { column: "period", op: "eq", param: "period" },
      ],
      sort: [{ column: "id", dir: "asc" }],
      limit: 500,
    },
  },
];

/** Keyed by DATASOURCE NAME, which is what a `query` step's ref is prefixed with. */
export const CATALOGUE_OPERATIONS: Record<string, OperationSeed[]> = {
  finance_demo: FINANCE,
  support_demo: SUPPORT,
  orders_demo: ORDERS,
  hiring_demo: HIRING,
  hr_demo: HR,
  itops_demo: ITOPS,
};
