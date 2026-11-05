/**
 * Three Finance automations a finance manager would recognise.
 * Programme 3, Stage 3.
 *
 * ── What makes these different from `src/showcase/` ─────────────────────────
 *
 * The showcase set is organised by CAPABILITY — one flow per feature, each
 * existing so a reviewer can click the feature. These are organised by JOB. Each
 * one is something somebody in accounts payable actually does every month, and
 * each is checked against `financeOracle()` rather than against "it went green".
 *
 * That distinction is the whole point of the stage. A flow that runs is not a
 * flow that is right: the measured baseline for this system is *1 of 3 scripts
 * achieved its objective first-pass*, and the one that failed *"hardcoded
 * `period="2023-10"`, emailed 0 of 11, and still exited 0 with
 * `tests_passed=true`"*. Only an oracle catches that, and only an oracle
 * computed from the dataset DEFINITION rather than from a query result.
 *
 * ── Why all three are Finance ───────────────────────────────────────────────
 *
 * Not because HR does not deserve one — because Finance is where the checking is
 * real. `finance:verify` runs every named query against `financeOracle()` at
 * three periods, so a flow built on those queries inherits a second, independent
 * implementation of the same answer. HR's demonstrations are the showcase set,
 * which is scored against `expectedScreening` in the same way.
 *
 * ── The units trap is deliberately live in flow 3 ───────────────────────────
 *
 * `invoices.amount_cents` and `expense_claims.amount_cents` are MINOR units;
 * `budgets.amount` is MAJOR. `spend_by_cost_centre` already does the ×100 and
 * returns both sides in cents — but it ALSO returns `budget_amount_major`, and
 * the `code` step is handed both. A fragment that reaches for the wrong one
 * reports every cost centre as 100× over budget, and the oracle catches it
 * because it knows exactly one centre is over. That is the `0–100` vs `0–1`
 * lesson from `hr_demo_alt`, reproduced where a flow can trip on it.
 *
 * ── Pebble, once ────────────────────────────────────────────────────────────
 *
 * Every value handed to a JSON position is built INSIDE jq and interpolated
 * whole (I-11). Pebble does not re-evaluate `{{ }}` inside a filter argument, and
 * `| first` unwraps a jq string into a raw string — so a rendered string
 * interpolated into a JSON body produces a 400 from Kestra that names nothing.
 * `| @json` re-encodes a string WITH its quotes wherever one has to stand alone.
 */
import type { FlowModel } from "../services/flow-compiler.service.js";

/** The query envelope, unwrapped. A `query` step's rows live at `.results[0].data`. */
const rows = (step: string) => `json(outputs.${step}.body).results[0].data`;

/** Every flow here is prefixed, for the same reason the showcase set is. */
export const SCENARIO_PREFIX = "finance-";

const SENDER = "ap-bot@acme-finance.example";
const AP_INBOX = "accounts-payable@acme-finance.example";

// ═══════════════════════════════════════════════════════════════════════════
// 1. Invoice aging — chase what is overdue, escalate what cannot be reached
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Split the overdue list by whether a chase can actually be delivered — AND
 * flatten every timestamp to a plain date on the way through.
 *
 * ⚠ The flattening is not cosmetic. It is the mitigation for the trap below, and
 * removing it breaks both consumers.
 *
 * ── The trap: a timestamp cannot cross into an http.Request body ────────────
 *
 * Measured on this flow's first three runs. `finance_demo` rows carry real dates
 * (`issue_date`, `effective_due_date`, `claim_date`), which Postgres returns as
 * `2026-04-30T00:00:00.000Z`. Hand a value containing one of those to `jq()`
 * inside a `tool` or `approval` step's body and Kestra dies with:
 *
 *     Unable to parse jq value '[{invoice_number=INV-2026-0025, …,
 *       issue_date=2026-03-16T00:00:00.000Z, …}]'
 *       with type 'java.util.ArrayList'
 *
 * The value in the message is a Java `toString()`, so it reads like malformed
 * DATA rather than like a value that could not be serialised — and it names
 * neither the field nor the reason. The same expression over the same rows works
 * perfectly in a `transform` step, which is what makes it so hard to see: the
 * step that fails is not the step that is wrong.
 *
 * It is invisible to HR, and that is why nothing caught it earlier: not one
 * column in `attendance_below_threshold` is a date, so `showcase-attendance
 * -screening` uses the identical construct and has always passed.
 *
 * ── The rule that falls out, and it is a good rule anyway ───────────────────
 *
 * **A tool step never consumes a raw query row.** A `transform` projects exactly
 * the fields the call needs, in the shape the call wants. That was worth doing
 * before this bug existed — it puts the payload's shape in one readable place
 * instead of inside a 400-character jq program — and it happens to make the
 * timestamp problem structurally impossible.
 */
const ROUTE_EXPR =
  "{{ json(outputs.overdue.body).results[0].data " +
  "| jq('[.[] | select(.effective_due_date != null and .days_past_due > 0 and ((.amount_cents|tonumber) - ((.paid_cents // 0)|tonumber)) > 0) | " +
  "{invoice: .invoice_number, email: .contact_email, cost_centre: .cost_centre_code, " +
  "days: .days_past_due, bucket: (if .days_past_due <= 30 then \"1-30\" elif .days_past_due <= 60 then \"31-60\" else \"61-90\" end), " +
  "outstanding: (((.amount_cents|tonumber) - ((.paid_cents // 0)|tonumber)) / 100), " +
  "due: (.effective_due_date | split(\"T\")[0]), derived: (.due_date == null), vendor: .vendor_code, " +
  "unreachable_reason: (if .contact_email == null then \"no accounts-payable address on record\" elif (.contact_email | endswith(\"@acme-supply-bounce.example\")) then \"address hard-bounces\" else null end)}] | " +
  "{mailable: ([.[] | select(.unreachable_reason == null) | {invoice: .invoice, email: .email, cost_centre: .cost_centre, days: .days, bucket: .bucket, outstanding: .outstanding, due: .due, derived: .derived}]), " +
  "unreachable: ([.[] | select(.unreachable_reason != null) | {invoice: .invoice, vendor: .vendor, reason: .unreachable_reason, outstanding: .outstanding}])}') " +
  "| first }}";
/**
 * One email per overdue invoice, in ONE taskrun (M1).
 *
 * The tone escalates with the bucket, which is what makes this recognisable as a
 * real chase rather than a mail merge: 1-30 days is a reminder, 90+ is a demand.
 *
 * Amounts arrive already converted to major units by `route` — the ONE place in
 * this flow where units change, so there is one line to check rather than four.
 */
const CHASE_PARAMS_EXPR =
  "{{ json(outputs.route.value) " +
  `| jq('[.mailable[] | {sender: "${SENDER}", recipients: [.email], ` +
  'subject: ("Overdue invoice " + .invoice + " — " + (.days|tostring) + " days"), ' +
  'body: ((if .bucket == "1-30" then "This is a reminder that " ' +
  'elif .bucket == "31-60" then "Our records show that " ' +
  'else "This account is seriously overdue. " end) ' +
  '+ "invoice " + .invoice + " for $" + (.outstanding|tostring) ' +
  '+ " was due on " + .due ' +
  '+ (if .derived then " under your standard payment terms" else "" end) ' +
  '+ " and is now " + (.days|tostring) + " days past due. Cost centre " ' +
  '+ .cost_centre + ".")}]\') ' +
  "| first }}";

/**
 * ONE ticket for everything that could not be chased, or NO ticket at all.
 *
 * `if length == 0 then [] else …` is not defensive tidying: an empty params
 * array means the step makes **zero tool calls**, so a month with nothing
 * unreachable is visibly zero rather than a ticket announcing "0 unreachable
 * vendors". A quiet month and a broken run must not look the same.
 */
const ESCALATE_PARAMS_EXPR =
  "{{ json(outputs.route.value) " +
  "| jq('.unreachable | if length == 0 then [] else [{" +
  'title: ("Cannot chase " + (length|tostring) + " overdue invoice(s)"), ' +
  'priority: "high", ' +
  'labels: ["accounts-payable", "unreachable"], ' +
  'description: ([.[] | .invoice + " (" + .vendor + ", $" + (.outstanding|tostring) ' +
  '+ ") — " + .reason] | join("; "))' +
  "}] end') | first }}";

export const FINANCE_INVOICE_CHASE: FlowModel = {
  id: "finance-invoice-chase",
  // A declared INPUT, never a literal. The worst measured failure of the old
  // monolithic path was a hardcoded reporting date; here that is inexpressible.
  inputs: [{ id: "as_of", type: "STRING", defaults: "2026-06-30" }],
  steps: [
    {
      id: "overdue",
      kind: "query",
      ref: "finance_demo.invoice_period_rows",
      paramsExpr: '[{ "terms_key": "default_payment_terms_days", "as_of": "{{ inputs.as_of }}", "void_status": "void", "credit_status": "credit" }]',
    },
    { id: "route", kind: "transform", expr: ROUTE_EXPR, dependsOn: ["overdue"] },
    {
      id: "chase",
      kind: "tool",
      ref: "mail_send",
      paramsExpr: CHASE_PARAMS_EXPR,
      dependsOn: ["route"],
      timeoutSeconds: 120,
      /**
       * ⚠ Retry is safe HERE and would not be everywhere.
       *
       * `stepExecutionService.tool` throws only when EVERY item failed, so
       * "7 of 10 sent, retry sends all 10 again" is structurally impossible.
       * The residual is stated rather than hidden: a call whose *response* was
       * lost had its effect, and a retry would repeat it.
       */
      retry: { maxAttempts: 3, backoff: "exponential", intervalSeconds: 5 },
    },
    {
      id: "escalate",
      kind: "tool",
      ref: "ticket_create",
      paramsExpr: ESCALATE_PARAMS_EXPR,
      dependsOn: ["route"],
      timeoutSeconds: 60,
    },
  ],
  /**
   * Weekly, Monday 07:00. The cron lives on the MODEL (D-18) — Foundry refuses
   * to create a `schedule` trigger row for a flow, because that would be a
   * second way to fire it on a timer that no approval covers. Approving this
   * revision deploys the schedule; revoking removes it.
   */
  schedule: { cron: "0 7 * * 1", timezone: "Europe/London" },
};

// ═══════════════════════════════════════════════════════════════════════════
// 2. Expense claims over policy — a person decides before anyone is told
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Project the claims into exactly what the gate and the notice need.
 *
 * Same rule as `route` above, and the same reason: `claim_date` is a timestamp,
 * and a timestamp inside a `tool` or `approval` body kills the step with a
 * message that names neither. It is flattened to `YYYY-MM-DD` here, in the one
 * step kind that can carry it.
 */
const CLAIMS_SHAPE_EXPR =
  "{{ json(outputs.claims.body).results[0].data " +
  "| jq('{claims: [.[] | select(((.amount_cents|tonumber) - (.limit_cents|tonumber)) > 0) | {claim: .claim_code, who: .employee_name, email: .employee_email, " +
  "owner: .cost_centre_owner_email, cost_centre: .cost_centre_code, category: .category, " +
  'on: (.claim_date | split("T")[0]), ' +
  "amount: ((.amount_cents|tonumber) / 100), cap: ((.limit_cents|tonumber) / 100), " +
  "over: (((.amount_cents|tonumber) - (.limit_cents|tonumber)) / 100)}]}') " +
  "| first }}";
/**
 * ⚠ `@json` is load-bearing, and it belongs INSIDE the jq program.
 *
 * Two separate traps, one line:
 *
 *   - Without `@json` at all, `| first` unwraps a jq STRING into raw text, so
 *     the summary lands in the JSON body unquoted and Kestra rejects the task
 *     with `JsonParseException` naming neither the step nor the field.
 *   - Written as a PEBBLE filter — `| jq('…') | @json | first` — it fails
 *     earlier and differently: `ParserException: Unexpected character [@]`.
 *     There is no Pebble filter called `@json`; it is jq's own encoder. Measured
 *     on this flow's first run.
 */
const CLAIMS_SUMMARY_EXPR =
  "{{ json(outputs.shape.value) " +
  "| jq('(.claims | if length == 0 then \"No claims exceeded policy this period.\" else " +
  '("Notify " + (length|tostring) + " employee(s) that their claim is over policy, ' +
  'totalling $" + ([.[] | .over] | add | tostring) + " over.") end) | @json\') ' +
  "| first }}";

/** The EVIDENCE, not a count. An approver asked to approve "4 emails" without
    knowing to whom is being asked to rubber-stamp. */
const CLAIMS_CONTEXT_EXPR = "{{ json(outputs.shape.value) | jq('{claims: .claims}') | first }}";

const CLAIM_NOTICE_PARAMS_EXPR =
  "{{ json(outputs.shape.value) " +
  `| jq('[.claims[] | select(.email != null) | {sender: "${SENDER}", ` +
  "recipients: [.email], cc: [.owner], " +
  'subject: ("Expense claim " + .claim + " is over policy"), ' +
  'body: ("Your " + .category + " claim of $" + (.amount|tostring) ' +
  '+ " dated " + .on + " is $" + (.over|tostring) ' +
  '+ " above the $" + (.cap|tostring) + " limit for that category. ' +
  'It has been sent to " + .owner + " for a decision.")}]\') ' +
  "| first }}";

export const FINANCE_EXPENSE_POLICY: FlowModel = {
  id: "finance-expense-policy",
  inputs: [{ id: "period", type: "STRING", defaults: "2026-06" }],
  steps: [
    {
      id: "claims",
      kind: "query",
      ref: "finance_demo.claim_period_rows",
      paramsExpr: '[{ "period": "{{ inputs.period }}", "rejected_status": "rejected" }]',
    },
    { id: "shape", kind: "transform", expr: CLAIMS_SHAPE_EXPR, dependsOn: ["claims"] },
    {
      id: "notify_gate",
      kind: "approval",
      summaryExpr: CLAIMS_SUMMARY_EXPR,
      contextExpr: CLAIMS_CONTEXT_EXPR,
      dependsOn: ["shape"],
      // Bounded. An unbounded pause holds an M3 budget slot for ever.
      awaitSeconds: 86_400,
    },
    {
      id: "notify",
      kind: "tool",
      ref: "mail_send",
      paramsExpr: CLAIM_NOTICE_PARAMS_EXPR,
      dependsOn: ["notify_gate"],
      timeoutSeconds: 120,
    },
  ],
  // No cron. A flow that waits for a person should not start itself at 03:00 and
  // sit paused until somebody notices — it is fired from the product, or by a
  // manual trigger, when there is someone to answer it.
};

// ═══════════════════════════════════════════════════════════════════════════
// 3. Budget versus actual — the units trap, a fragment, and a model seam
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The fragment: rank cost centres by overspend.
 *
 * ⚠ It is handed BOTH `budget_amount_major` (dollars) and `budget_cents`, and
 * it must use the second. That is the units trap, live: reaching for the major
 * figure reports every cost centre as ~100× over budget, which reads like a
 * catastrophe rather than like a bug, and the oracle is what catches it.
 *
 * A function BODY, not a program (D-19). It defines `run(payload)`; a fixed
 * compiler-emitted wrapper does all the I/O, checks the declared output keys
 * inside the container, and enforces the 1 MB cap. It cannot print, cannot
 * reach the network (`networkMode: none`), and holds no credential.
 */
const VARIANCE_FRAGMENT = `
def run(payload):
    rows = payload["centres"]

    # Both sides in MINOR units. \`budget_amount_major\` is on every row and is
    # deliberately NOT used: it is dollars, and comparing it to a cents actual
    # reports a 100x overspend on every line.
    over = [
        {
            "code": r["cost_centre_code"],
            "name": r["cost_centre_name"],
            "owner": r["owner_email"],
            "budget_cents": int(r["budget_cents"]),
            "actual_cents": int(r["actual_cents"]),
            "variance_cents": int(r["actual_cents"]) - int(r["budget_cents"]),
        }
        for r in rows
        if int(r["actual_cents"]) > int(r["budget_cents"])
    ]
    over.sort(key=lambda x: -x["variance_cents"])

    # A cost centre with no budget row and no spend is dormant, not compliant.
    # Reported separately, because "0 of 0" and "under budget" are different
    # facts and only one of them is worth a manager's attention.
    dormant = [
        r["cost_centre_code"]
        for r in rows
        if int(r["actual_cents"]) == 0 and int(r["budget_cents"]) == 0
    ]

    return {
        "over_budget": over,
        "over_budget_count": len(over),
        "dormant_cost_centres": dormant,
        "total_overspend_cents": sum(x["variance_cents"] for x in over),
    }
`.trim();

// ⚠ An OBJECT literal with a span inside it, never a whole-body template: since
// 2026-09-15 the compiler refuses a code feed it cannot see is an object
// (`checkCodeInputExpr`, run 4171a39b). A transform's `.value` is already JSON
// text, so it drops straight in as the value.
const VARIANCE_INPUT_EXPR = '{"centres": {{ outputs.spend.value }}}';

/**
 * ⚠ A `code` step's output is `outputs.<id>.vars.result`, NOT `outputs.<id>.value`.
 *
 * `.value` is a `transform`'s output; the two kinds address differently and the
 * failure is `Unable to find \`value\` used in the expression …`, which reads as
 * "the step produced nothing" rather than "you asked for the wrong field".
 * Measured on this flow's first run.
 */
const VARIANCE_OUT = "outputs.variance.vars.result";

/**
 * ⚠ The model seam — and it is a LEAF, which is not a compromise but the rule.
 *
 * D-34: `llm_complete`'s output is terminal, never load-bearing. The tool's own
 * description is blunter still: *"the output is NOT deterministic and NOTHING
 * downstream may read it … never put it on a path that decides whether money
 * moves."* This flow is about money moving, so the paragraph hangs off the side
 * of the graph and is consumed by nobody — it is recorded on the run and in
 * ops-api's call log, where a person reads it.
 *
 * The first draft of this file had the digest embed the paragraph. That is the
 * exact shape the rule forbids, and it is how a real digest here once *"ranked
 * two departments in an order its own numbers contradicted"*: the figures were
 * right and the prose around them was not, and the prose is what was read.
 *
 * The instruction says "no numbers beyond those given" and "do not rank" for the
 * same reason. It is a hint, not a control — the control is that the node is a
 * leaf.
 */
const COMMENTARY_PARAMS_EXPR =
  "{{ " + VARIANCE_OUT + " " +
  "| jq('[{instruction: \"Write two sentences of plain-English commentary for a cost centre owner. " +
  "Use only the figures given. Do not rank, re-order, total or add anything.\", " +
  'input: ("Cost centres over budget this period: " ' +
  "+ (if .over_budget_count == 0 then \"none\" else ([.over_budget[] | .name + \" by $\" " +
  '+ ((.variance_cents / 100)|tostring)] | join("; ")) end) ' +
  '+ ". Dormant cost centres: " ' +
  '+ (if (.dormant_cost_centres | length) == 0 then "none" ' +
  'else (.dormant_cost_centres | join(", ")) end) + ".")}]\') ' +
  "| first }}";

/**
 * The digest. Every figure comes from the fragment — deterministic code over
 * cents — and nothing here reads the model's paragraph.
 */
const DIGEST_PARAMS_EXPR =
  "{{ " + VARIANCE_OUT + " " +
  `| jq('[{sender: "${SENDER}", recipients: ["${AP_INBOX}"], ` +
  'subject: ("Budget variance — " + (.over_budget_count|tostring) + " cost centre(s) over"), ' +
  'body: ((if .over_budget_count == 0 then "Every cost centre is within budget this period." ' +
  'else ("Over budget, largest first:\\n" ' +
  '+ ([.over_budget[] | "  " + .code + " " + .name + " — actual $" ' +
  '+ ((.actual_cents / 100)|tostring) + " against $" + ((.budget_cents / 100)|tostring) ' +
  '+ ", over by $" + ((.variance_cents / 100)|tostring)] | join("\\n")) ' +
  '+ "\\n\\nTotal overspend: $" + ((.total_overspend_cents / 100)|tostring)) end) ' +
  '+ (if (.dormant_cost_centres | length) == 0 then "" ' +
  'else ("\\n\\nDormant (no budget, no spend): " + (.dormant_cost_centres | join(", "))) end))}]\') ' +
  "| first }}";

export const FINANCE_BUDGET_VARIANCE: FlowModel = {
  id: "finance-budget-variance",
  inputs: [{ id: "period", type: "STRING", defaults: "2026-06" }],
  steps: [
    {
      id: "sums",
      kind: "query",
      name: "Budget and spend by cost centre",
      ref: "finance_demo.centre_spend_sums",
      paramsExpr: '[{ "period": "{{ inputs.period }}", "void_status": "void", "rejected_status": "rejected" }]',
    },
    {
      id: "spend",
      kind: "transform",
      name: "Cents on both sides",
      description:
        "Budgets arrive in dollars, spend in cents — the units meet here, in minor units, " +
        "before the fragment ever sees them. `budget_amount_major` rides along untouched " +
        "so the fragment still has the wrong figure to avoid.",
      expr:
        `{{ ${rows("sums")} | jq('map({cost_centre_code: .cost_centre_code, cost_centre_name: .cost_centre_name, ` +
        `owner_email: .owner_email, budget_amount_major: (.budget_amount_major | tonumber? // null), ` +
        `budget_cents: (((.budget_dollars // 0) | tonumber) * 100), ` +
        `actual_cents: (((.invoice_cents // 0) | tonumber) + ((.claim_cents // 0) | tonumber))})') | first }}`,
      dependsOn: ["sums"],
    },
    {
      id: "variance",
      kind: "code",
      code: VARIANCE_FRAGMENT,
      inputExpr: VARIANCE_INPUT_EXPR,
      // DERIVED from what the fragment returns. The wrapper checks these keys
      // inside the container, so a mismatch is a `contract_violation` naming
      // this step rather than a KeyError two steps downstream.
      outputKeys: ["over_budget", "over_budget_count", "dormant_cost_centres", "total_overspend_cents"],
      dependsOn: ["spend"],
      timeoutSeconds: 120,
    },
    {
      id: "commentary",
      kind: "tool",
      ref: "llm_complete",
      paramsExpr: COMMENTARY_PARAMS_EXPR,
      dependsOn: ["variance"],
      timeoutSeconds: 120,
    },
    {
      id: "digest",
      kind: "tool",
      ref: "mail_send",
      paramsExpr: DIGEST_PARAMS_EXPR,
      // ⚠ Depends on `variance`, NOT on `commentary`. The two are siblings, and
      // the fork is visible on the canvas: the branch carrying the model seam
      // ends there, and the branch carrying the figures reaches the send.
      dependsOn: ["variance"],
      timeoutSeconds: 120,
    },
  ],
  schedule: { cron: "0 8 1 * *", timezone: "Europe/London" },
};

export type ScenarioSpec = {
  model: FlowModel;
  name: string;
  description: string;
  /** Left unapproved on purpose, and why — rendered by the seed. */
  unapprovedBecause?: string;
};

export const FINANCE_SCENARIOS: ScenarioSpec[] = [
  {
    model: FINANCE_INVOICE_CHASE,
    name: "Chase overdue invoices",
    description:
      "Every Monday: find invoices past their due date, email the vendor a chase whose tone " +
      "matches how late it is, and open one ticket for anything that cannot be emailed at all.",
  },
  {
    model: FINANCE_EXPENSE_POLICY,
    name: "Expense claims over policy",
    description:
      "Find claims above their category limit, then WAIT for a person. Nothing is sent until " +
      "somebody approves it, and rejecting stops the run rather than sending a refusal.",
    unapprovedBecause:
      "left unapproved deliberately: arming a flow that pauses for a human means a schedule " +
      "can park a run in somebody's inbox at 03:00. Fire it from the product instead.",
  },
  {
    model: FINANCE_BUDGET_VARIANCE,
    name: "Budget versus actual",
    description:
      "Monthly: compare each cost centre's spend against its budget, rank the overspends, and " +
      "email a digest of the figures. A model writes a short commentary alongside — on its own " +
      "branch, read by a person and by no later step.",
  },
];
