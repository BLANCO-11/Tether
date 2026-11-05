/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE DEMO FLOW PER GENERIC DOMAIN — each a condition with a shared tail
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * These are what a non-technical person is shown. Each is the same three
 * sentences of plain English:
 *
 *     if there is anything wrong, do the expensive thing about it
 *     otherwise say so
 *     and either way, report what happened
 *
 * The third sentence is the one that needed a `merge`. Before it existed, "and
 * either way" had to be written twice — once inside each arm — and the two
 * copies drift.
 *
 * ⚠ **THE TAIL READS `.succeeded` OFF THE MERGE, NEVER `.results[0].data`.**
 * A merge coalesces its sources' RAW output, and every tool step's raw body is
 * Foundry's envelope (`{results, succeeded, failed, warnings}`). The envelope is
 * the same whichever arm ran; the payload inside it is not. A tail that reads
 * the payload is a tail that depends on which arm won, which is the bug a merge
 * exists to prevent.
 *
 * ⚠ **THE PERIOD/AS-OF SPLICE IS `' ~ inputs.x ~ '`, NEVER `{{ inputs.x }}`.**
 * Pebble does not re-evaluate a template inside a filter argument (I-11), so a
 * nested one renders as literal braces in the message a person receives. It
 * applies to jq programs only — a `datasource` step's `paramsExpr` is plain JSON
 * with no jq around it, and those are written literally.
 *
 * ⚠ **EVERY TOOL `paramsExpr` ENDS `| first`.** Pebble's `jq()` returns a LIST,
 * so `jq('[…]')` renders as `[[…]]` and the callback refuses it with
 * `params: ["Expected object, received array"]` — a message about the shape of
 * one element, which reads like the projection being wrong.
 */
import type { FlowModel } from "../services/flow-compiler.service.js";

const rows = (step: string) => `json(outputs.${step}.body).results[0].data`;
const asOf = (e: string) => e.split("AS_OF").join("' ~ inputs.as_of ~ '");

const AS_OF_INPUT = { id: "as_of", type: "STRING" as const, required: true };

/** The shared tail, identical in shape across all three — see the header. */
const recordParams = (channel: string, subject: string) =>
  asOf(
    `{{ json(outputs.outcome.value) | jq('[{channel: "${channel}", author: "foundry-automation", ` +
      `text: ("${subject} at AS_OF — " + (.succeeded|tostring) + " action(s) delivered, " + ` +
      `(.failed|tostring) + " failed.")}]') | first }}`,
  );

export interface GenericFlowSpec {
  workspaceName: string;
  model: FlowModel;
  name: string;
  description: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Customer Support — chase the breaches, or say the desk is clear
// ═══════════════════════════════════════════════════════════════════════════

const SUPPORT_SHAPE =
  `{{ ${rows("breaching")} | jq('{items: [.[] | select((.age_mins|tonumber) > (.resolve_budget_mins|tonumber)) | ` +
  `{code: .ticket_code, subject: .subject, customer: .customer_name, plan: .plan, priority: .priority, ` +
  `escalated: (.priority != .opened_priority), team: .team_email, over: (((.age_mins|tonumber) - (.resolve_budget_mins|tonumber))|tostring)}], n: length}') | first }}`;

/**
 * One ticket per breach, to the OWNING TEAM's address rather than the assignee's.
 *
 * ⚠ The assignee may have no work email (the dataset's contractor), and a ticket
 * assigned to nobody is a ticket nobody works. The team address always exists.
 */
const SUPPORT_TICKETS =
  `{{ json(outputs.shape.value) | jq('[.items[] | {` +
  `title: (.code + " has missed its resolve target — " + .customer + " (" + .plan + ")"), ` +
  `description: (.subject + "\\n\\nOver the resolve budget by " + .over + " minutes. Priority " + ` +
  `.priority + (if .escalated then " (escalated since it was opened — judged against the budget ` +
  `that applies now)" else "" end) + "."), ` +
  `priority: "high", assignee: .team, labels: ["sla", .plan]}]') | first }}`;

const SUPPORT_CLEAR = asOf(
  `{{ ${rows("breaching")} | jq('[{channel: "#support-floor", author: "foundry-automation", ` +
    `text: "Support check at AS_OF: no open ticket has missed its resolve target. ` +
    `Budgets are read from the customer plan and the ticket\\u0027s current priority."}]') | first }}`,
);

const supportSlaCheck: FlowModel = {
  id: "support-sla-check",
  inputs: [AS_OF_INPUT],
  steps: [
    {
      id: "breaching",
      kind: "query",
      name: "Tickets past their resolve target",
      description:
        "Budgets come from the customer's plan AND the ticket's current priority — an escalated " +
        "ticket is judged by the budget that applies to it now.",
      ref: "support_demo.ticket_sla_rows",
      paramsExpr: `[{"as_of": "{{ inputs.as_of }}", "resolved_status": "resolved"}]`,
    },
    { id: "shape", kind: "transform", name: "Prepare one ticket per breach", expr: SUPPORT_SHAPE, dependsOn: ["breaching"] },
    {
      id: "any_breach",
      kind: "branch",
      name: "Has anything missed its target?",
      conditionExpr: `{{ json(outputs.shape.value) | jq('.items | length > 0') | first }}`,
      dependsOn: ["shape"],
    },
    { id: "raise", kind: "tool", name: "Raise them with the owning team", ref: "ticket_create", paramsExpr: SUPPORT_TICKETS, dependsOn: ["any_breach", "shape"] },
    { id: "none_breach", kind: "branch", name: "Otherwise", elseOf: "any_breach" },
    { id: "clear", kind: "tool", name: "Post the all-clear", ref: "chat_post_message", paramsExpr: SUPPORT_CLEAR, dependsOn: ["none_breach"] },
    {
      id: "outcome",
      kind: "merge",
      name: "Either way",
      description: "Whichever arm ran, its result arrives here, so the step after runs once on both paths.",
      sources: ["raise", "clear"],
    },
    { id: "record", kind: "tool", name: "Say what happened", ref: "chat_post_message", paramsExpr: recordParams("#support-floor", "Support SLA check"), dependsOn: ["outcome"] },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// Orders & Fulfilment — chase the late orders, or say dispatch is on time
// ═══════════════════════════════════════════════════════════════════════════

const ORDERS_ROLLUP =
  `{{ ${rows("late")} | jq('sort_by(.order_id) | group_by(.order_id) | map(select(.[0].days_past_promise > 0 and (map(select(.shipped_at != null)) | length) < length) | . as $g | ` +
  // ⚠ Select BEFORE binding: the late test reads the group (source rows),
  // never `$g` or the constructed aliases. `days_past_promise` is per-order
  // (every line of one order shares it), so testing `.[0]` tests the order.
  `($g | map(select(.shipped_at != null)) | length) as $shipped | ` +
  `{order_id: $g[0].order_id, order_code: $g[0].order_code, customer: $g[0].customer_name, ` +
  `customer_email: $g[0].customer_email, age: $g[0].age_days, days: $g[0].days_past_promise, ` +
  `live_lines: ($g | length), shipped: $shipped, ` +
  `value: ($g | map((.qty|tonumber) * (.unit_price_cents|tonumber) - (.line_discount_cents|tonumber)) | add)})') | first }}`;
const ORDERS_SHAPE =
  `{{ json(outputs.rollup.value) | jq('{items: [.[] | select(.customer_email != null) | ` +
  `{code: .order_code, customer: .customer, email: .customer_email, ` +
  `outstanding: ((.live_lines - .shipped)|tostring), late: (.days|tostring), ` +
  `value: (.value|tostring)}], n: length}') | first }}`;

/**
 * ⚠ **Customers with no email are DROPPED here**, exactly as the HR flow drops
 * contractors — and `orders_unreachable` is the query that then names them for a
 * person. Mailing `null` is worse than not mailing.
 */
const ORDERS_MAIL =
  `{{ json(outputs.shape.value) | jq('[.items[] | {` +
  `sender: "dispatch@acme-orders.example", recipients: [.email], ` +
  `subject: ("Update on your order " + .code), ` +
  `body: ("Your order " + .code + " is running late. " + .outstanding + ` +
  `" item(s) are still to ship, and we promised it " + .late + " day(s) ago. ` +
  `We are sorry — dispatch has been notified and will be in touch.")}]') | first }}`;

const ORDERS_CLEAR = asOf(
  `{{ ${rows("late")} | jq('[{channel: "#fulfilment", author: "foundry-automation", ` +
    `text: "Dispatch check at AS_OF: every open order is either fully shipped or still ` +
    `inside its promised date. A partly-shipped order counts as late, not as fulfilled."}]') | first }}`,
);

const ordersLateCheck: FlowModel = {
  id: "orders-late-check",
  inputs: [AS_OF_INPUT],
  steps: [
    {
      id: "late",
      kind: "query",
      name: "Orders past their promised date",
      description:
        "An order counts as shipped only when EVERY live line has shipped — a partial shipment " +
        "is not a fulfilled order.",
      ref: "orders_demo.open_order_line_rows",
      paramsExpr: `[{"as_of": "{{ inputs.as_of }}", "cancelled_status": "cancelled"}]`,
    },
    { id: "rollup", kind: "transform", name: "Roll up lines into late orders", description: "Groups the open lines by order and keeps the ones past their promise with something still to ship.", expr: ORDERS_ROLLUP, dependsOn: ["late"] },
    {
      id: "any_late",
      kind: "branch",
      name: "Is anything late?",
      conditionExpr: `{{ json(outputs.rollup.value) | jq('length > 0') | first }}`,
      dependsOn: ["rollup"],
    },
    { id: "shape", kind: "transform", name: "Prepare one update per customer", description: "Drops customers with no email address — they are chased separately.", expr: ORDERS_SHAPE, dependsOn: ["any_late", "rollup"] },
    { id: "notify", kind: "tool", name: "Email each customer", ref: "mail_send", paramsExpr: ORDERS_MAIL, dependsOn: ["shape"] },
    { id: "none_late", kind: "branch", name: "Otherwise", elseOf: "any_late" },
    { id: "clear", kind: "tool", name: "Post the all-clear", ref: "chat_post_message", paramsExpr: ORDERS_CLEAR, dependsOn: ["none_late"] },
    { id: "outcome", kind: "merge", name: "Either way", sources: ["notify", "clear"] },
    { id: "record", kind: "tool", name: "Say what happened", ref: "chat_post_message", paramsExpr: recordParams("#fulfilment", "Dispatch check"), dependsOn: ["outcome"] },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// Recruitment — chase the expiring offers, or say the pipeline is healthy
// ═══════════════════════════════════════════════════════════════════════════

const HIRING_SHAPE =
  `{{ ${rows("offers")} | jq('{items: [.[] | {role: .role_title, req: .req_code, ` +
  `candidate: .candidate_name, days: (.days_to_expiry|tostring), ` +
  `to: (.recruiter_email // .hiring_manager_email)}], n: length}') | first }}`;

/**
 * ⚠ **`.recruiter_email // .hiring_manager_email`** — jq's alternative operator,
 * INSIDE the jq program where it belongs. Three requisitions here have a
 * recruiter with no work address, and an offer nobody is told about is a lost
 * hire. The fallback is the hiring manager, who always has one.
 */
const HIRING_TICKETS =
  `{{ json(outputs.shape.value) | jq('[.items[] | {` +
  `title: ("Offer to " + .candidate + " for " + .role + " expires in " + .days + " day(s)"), ` +
  `description: ("Requisition " + .req + ". The offer lapses in " + .days + ` +
  `" day(s) and has not been accepted. Somebody should call today — an expired offer is a lost ` +
  `hire, not a warning to log."), ` +
  `priority: "urgent", assignee: .to, labels: ["offer", "expiring"]}]') | first }}`;

const HIRING_CLEAR = asOf(
  `{{ ${rows("offers")} | jq('[{channel: "#hiring", author: "foundry-automation", ` +
    `text: "Hiring check at AS_OF: no outstanding offer is close to expiring."}]') | first }}`,
);

const hiringOfferChase: FlowModel = {
  id: "hiring-offer-chase",
  inputs: [AS_OF_INPUT],
  steps: [
    {
      id: "offers",
      kind: "query",
      name: "Outstanding offers and how long is left",
      ref: "hiring_demo.outstanding_offer_rows",
      paramsExpr: `[{"as_of": "{{ inputs.as_of }}", "outstanding_status": "outstanding"}]`,
    },
    { id: "shape", kind: "transform", name: "Prepare a chase per offer", description: "Falls back to the hiring manager where the recruiter has no work email.", expr: HIRING_SHAPE, dependsOn: ["offers"] },
    {
      id: "any_offer",
      kind: "branch",
      name: "Is any offer outstanding?",
      conditionExpr: `{{ json(outputs.shape.value) | jq('.items | length > 0') | first }}`,
      dependsOn: ["shape"],
    },
    { id: "chase", kind: "tool", name: "Raise an urgent task for each", ref: "ticket_create", paramsExpr: HIRING_TICKETS, dependsOn: ["any_offer", "shape"] },
    { id: "none_offer", kind: "branch", name: "Otherwise", elseOf: "any_offer" },
    { id: "clear", kind: "tool", name: "Post the all-clear", ref: "chat_post_message", paramsExpr: HIRING_CLEAR, dependsOn: ["none_offer"] },
    { id: "outcome", kind: "merge", name: "Either way", sources: ["chase", "clear"] },
    { id: "record", kind: "tool", name: "Say what happened", ref: "chat_post_message", paramsExpr: recordParams("#hiring", "Hiring check"), dependsOn: ["outcome"] },
  ],
};

/**
 * ── The first `query` step ──────────────────────────────────────────────────
 *
 * All three flows above now read through `query` steps (DB operations compiled
 * from a visual spec) rather than `datasource` steps (generated SQL). This one
 * was the first, and it deliberately stays a digest (read → count → post):
 * branching and merging are proven by the other three.
 */
const OPERATION_DIGEST_SHAPE =
  `{{ ${rows("late_op")} | jq('{n: length, codes: [.[].order_code]}') | first }}`;

const OPERATION_DIGEST_POST = asOf(
  `{{ json(outputs.digest.value) | jq('[{channel: "#fulfilment", author: "foundry-automation", ` +
    `text: ("Operation-reader check at AS_OF: " + (.n|tostring) + " late order(s) via the compiled operation (" + (.codes|join(", ")) + ").")}]') | first }}`,
);

const ordersOperationDigest: FlowModel = {
  id: "orders-operation-check",
  inputs: [AS_OF_INPUT],
  steps: [
    {
      id: "late_op",
      kind: "query",
      name: "Late orders via the compiled operation",
      description:
        "The same question as orders-late-check, answered by a DB operation " +
        "compiled from a visual spec rather than by generated SQL.",
      ref: "orders_demo.orders_past_promised_date",
      paramsExpr: `[{"as_of": "{{ inputs.as_of }}"}]`,
    },
    { id: "digest", kind: "transform", name: "Count the late orders", expr: OPERATION_DIGEST_SHAPE, dependsOn: ["late_op"] },
    { id: "post", kind: "tool", name: "Post the digest", ref: "chat_post_message", paramsExpr: OPERATION_DIGEST_POST, dependsOn: ["digest"] },
  ],
};
export const GENERIC_FLOWS: GenericFlowSpec[] = [
  {
    workspaceName: "Customer Support",
    model: supportSlaCheck,
    name: "Chase tickets that missed their target",
    description:
      "Finds open tickets past their resolve target — budgets read from the customer's plan and " +
      "the ticket's current priority — and raises one with the owning team for each, or posts an " +
      "all-clear if there are none. Either way it reports what it did.",
  },
  {
    workspaceName: "Orders & Fulfilment",
    model: ordersLateCheck,
    name: "Tell customers when their order is late",
    description:
      "Finds orders past their promised date that are not fully shipped — a partly-shipped order " +
      "counts as late, not as fulfilled — and emails each customer, or posts an all-clear. " +
      "Customers with no email address are left to the separate chase.",
  },
  {
    workspaceName: "Recruitment",
    model: hiringOfferChase,
    name: "Chase offers before they expire",
    description:
      "Finds outstanding offers and raises an urgent task for each, addressed to the recruiter " +
      "or, where they have no work email, to the hiring manager. An expired offer is a lost hire.",
  },
  {
    workspaceName: "Orders & Fulfilment",
    model: ordersOperationDigest,
    name: "Digest late orders via the compiled operation",
    description:
      "Reads the same late orders through a `query` step (DB operation) and posts a count. " +
      "The proof that `query` runs, not a second chase.",
  },
];

