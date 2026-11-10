/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE HR AUTOMATIONS A PERSON WHO DOES NOT WRITE CODE WOULD RECOGNISE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * These exist to be SHOWN. Every one is named for the job it does rather than
 * for the mechanism it uses, because the audience is somebody deciding whether
 * this product would save them work — not somebody reviewing a DAG.
 *
 * ── ⚠ WHY THE FIRST ONE IS THE ONE TO DEMO ──────────────────────────────────
 *
 * `hr-attendance-check` is the first flow in this repo with a SHARED TAIL after
 * a condition. Until the `merge` kind existed that was not merely awkward, it
 * was unexpressible: `armOf` is a blind transitive closure over `dependsOn`, so
 * any step reading an arm's output became part of that arm and ran only on that
 * path. The tail had to be copied into every arm, and the copies drift.
 *
 * So the shape a person actually asks for — *"warn them if there are any,
 * otherwise say all-clear, and either way tell me what happened"* — is
 * expressible for the first time here, and it is three sentences of plain
 * English mapping onto three parts of the flow.
 *
 * ── ⚠ THE MERGE READS `succeeded`, AND THAT IS WHY IT WORKS EITHER WAY ──────
 *
 * A merge coalesces its sources' RAW output, and every `tool` step's raw body is
 * Foundry's own envelope (`{results, succeeded, failed, warnings}`). So
 * `json(outputs.outcome.value).succeeded` is correct whichever arm ran — the
 * email arm and the chat arm return different payloads at `.results[0].data`
 * but the same envelope around them. Reading `.results[0].data` in the tail
 * would be reading a shape that depends on which arm won, which is exactly the
 * bug a shared tail invites.
 *
 * ── The idioms, all of them learned the hard way and none optional ──────────
 *
 *  * ⚠ **Every tool `paramsExpr` ends `| first`.** Pebble's `jq()` returns a
 *    LIST, so `jq('[…]')` renders as `[[…]]` and the callback refuses it with
 *    `params: ["Expected object, received array"]` — a message about the shape
 *    of one element, which reads like the projection being wrong.
 *  * ⚠ **A `tool` step never consumes a raw query row** (I-42). A transform
 *    projects the fields the call needs first.
 *  * ⚠ **`@json` is jq's encoder and goes INSIDE the program** (I-43).
 *  * ⚠ **`work_email` is NULL for contractors** and the projection drops them
 *    rather than emailing "None". That is the dataset's deliberate trap, and
 *    flow 2 is the one that then chases them properly.
 */

import type { FlowModel } from "../services/flow-compiler.service.js";

/** Every flow here is prefixed, exactly as the Finance and IT Ops sets are. */
export const HR_DEMO_PREFIX = "hr-";

const SENDER = "hr-bot@acme-hr.example";

/** The datasource envelope, unwrapped. Foundry's `body`, payload at `.results[0].data`. */
const rows = (step: string) => `json(outputs.${step}.body).results[0].data`;

/** A transform's envelope, unwrapped. A transform's jq result is at `.value`, not `.body`. */
const trows = (step: string) => `json(outputs.${step}.value)`;
/** A flow input every one of these takes: which month to report on. */
const PERIOD_INPUT = { id: "period", type: "STRING" as const, format: "month" as const, required: true };

/**
 * The one read that replaced every HR named query. `attendance_period_rows`
 * carries the month's figures WITH each employee's effective minimum — the
 * lateral effective-date join (department row preferred, org fallback) lives
 * inside the operation, so the flow's transforms read one input and stay
 * single-source: no Pebble-side merge of two step outputs, which the engine
 * cannot render (a map literal is Java syntax, not JSON).
 *
 * ⚠ `as_of` is `period + "-01"`, rendered by Pebble inside the JSON string.
 * `min_attendance_rate` arrives as a JSON string (pg numeric), so comparisons
 * go through `tonumber`. A null minimum means no threshold applies and the
 * employee is never flagged — the SQL's three-valued logic, stated plainly.
 */
const ROWS_REF = "hr_demo.attendance_period_rows";
const ROWS_PARAMS = `[{"period": "{{ inputs.period }}", "as_of": "{{ inputs.period }}-01", "not_exited": "exited", "not_on_leave": "on_leave"}]`;

// ═══════════════════════════════════════════════════════════════════════════
// 1. Monthly attendance check — warn, or say all-clear, and report either way
// ═══════════════════════════════════════════════════════════════════════════

const RECORD_PARAMS =
  `{{ json(outputs.outcome.value) | jq('[{channel: "#hr-ops", author: "foundry-automation", ` +
  `text: ("Attendance check for PERIOD_PLACEHOLDER finished — " + (.succeeded|tostring) + ` +
  `" action(s) delivered, " + (.failed|tostring) + " failed.")}]') | first }}`;

/**
 * Splice the run's period into a jq program's literal text.
 *
 * ⚠ **`' ~ inputs.period ~ '`, NOT `{{ inputs.period }}` — this is I-11 and the
 * checker catches it, but only after you have written it.** Pebble does not
 * re-evaluate a `{{ … }}` that sits inside a filter argument, so a nested
 * template renders as the literal seven characters `{{ inpu…` in the email a
 * person receives. The fix is to CONCATENATE at the Pebble level: close the jq
 * program's quote, `~ inputs.period ~`, reopen it.
 *
 * ⚠ It applies to jq programs ONLY. A call step's `paramsExpr` is plain
 * JSON with no jq around it, so `{{ inputs.period }}` is correct there and those
 * are written literally rather than going through this.
 */
const withPeriod = (e: string) => e.split("PERIOD_PLACEHOLDER").join("' ~ inputs.period ~ '");

/**
 * Project the flagged employees into exactly what the warning template needs.
 *
 * ⚠ **Contractors are dropped HERE, by name.** `work_email` is NULL for them
 * (the dataset's trap), and `mail_send`'s own description says never to pass a
 * null recipient. Filtering in the transform means the count the tail reports is
 * the count actually emailed, rather than a number that includes people nobody
 * could reach — which is the "emailed 0 of 11 and exited 0" failure in
 * miniature.
 */
const WARN_SHAPE = `{{ ${trows("flagged")} | jq('{people: [.[] | select(.work_email != null) | ` +
  `{name: .full_name, email: .work_email, dept: .department_code, ` +
  `rate: (.attendance_rate|tostring), floor: (.min_attendance_rate|tostring)}], n: length}') | first }}`;

/** One templated warning per reachable employee, in ONE taskrun (M1). */
const WARN_PARAMS = `{{ json(outputs.warn_shape.value) | jq('[.people[] | ` +
  `{sender: "${SENDER}", template: "attendance_warning", recipients: [.email], ` +
  `variables: {full_name: .name, period: "PERIOD_PLACEHOLDER", attendance_rate: .rate, ` +
  `min_attendance_rate: .floor, department_name: .dept}}]') | first }}`;

/**
 * The all-clear. It names the period, because "all clear" with no month in it is
 * a message nobody can file or check later.
 */
const ALLCLEAR_PARAMS =
  `{{ ${trows("flagged")} | jq('[{channel: "#hr-ops", author: "foundry-automation", ` +
  `text: "Attendance check for PERIOD_PLACEHOLDER: every employee met their department threshold. ` +
  `Nobody was emailed."}]') | first }}`;
export const hrAttendanceCheck: FlowModel = {
  id: "hr-attendance-check",
  inputs: [PERIOD_INPUT],
  steps: [
    {
      id: "month_rows",
      kind: "query",
      name: "This month's figures with thresholds",
      ref: ROWS_REF,
      paramsExpr: ROWS_PARAMS,
    },
    {
      id: "flagged",
      kind: "transform",
      name: "Find everyone below their threshold",
      description:
        "Each department can set its own minimum. The row already carries the employee's " +
        "effective figure — department's own, else the org-wide default, never a hardcoded " +
        "80 — so this only compares and projects.",
      expr:
        `{{ ${rows("month_rows")} | jq('[.[] | select(.min_attendance_rate != null and (.attendance_rate | tonumber) < (.min_attendance_rate | tonumber)) | ` +
        `{employee_id: .employee_id, full_name: .full_name, work_email: .work_email, ` +
        `department_code: .department_code, attendance_rate: (.attendance_rate | tonumber), ` +
        `min_attendance_rate: (.min_attendance_rate | tonumber)}]') | first }}`,
      dependsOn: ["month_rows"],
    },
    {
      id: "some_flagged",
      kind: "branch",
      name: "Was anyone below?",
      conditionExpr: `{{ ${trows("flagged")} | jq('length > 0') | first }}`,
      dependsOn: ["flagged"],
    },
    {
      id: "warn_shape",
      kind: "transform",
      name: "Prepare one warning per person",
      description: "Drops contractors, who have no work email — they are chased separately.",
      expr: withPeriod(WARN_SHAPE),
      dependsOn: ["some_flagged"],
    },
    {
      id: "warn",
      kind: "tool",
      name: "Email each of them",
      ref: "mail_send_template",
      paramsExpr: withPeriod(WARN_PARAMS),
      dependsOn: ["warn_shape"],
    },
    {
      id: "none_flagged",
      kind: "branch",
      name: "Otherwise",
      // ⚠ No condition and no `dependsOn`. The `elseOf` link is what places it;
      // a continuation that also depended on `flagged` would sit inside the arm
      // it is the alternative to, and the compiler refuses exactly that.
      elseOf: "some_flagged",
    },
    {
      id: "allclear",
      kind: "tool",
      name: "Post the all-clear",
      ref: "chat_post_message",
      paramsExpr: withPeriod(ALLCLEAR_PARAMS),
      dependsOn: ["none_flagged"],
    },
    {
      id: "outcome",
      kind: "merge",
      name: "Either way",
      description:
        "Whichever arm ran, its result arrives here — so the step after this runs once, " +
        "on both paths, instead of being copied into each arm.",
      sources: ["warn", "allclear"],
    },
    {
      id: "record",
      kind: "tool",
      name: "Say what happened",
      ref: "chat_post_message",
      paramsExpr: withPeriod(RECORD_PARAMS),
      dependsOn: ["outcome"],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// 2. Chase the people the check could not reach
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ⚠ **This flow is the OTHER half of flow 1, and the pair is the lesson.**
 *
 * Flow 1 drops employees with no work email, because emailing `null` is worse
 * than not emailing. That would quietly lose them — the exact shape of "emailed
 * 0 of 11 and still exited 0" — if nothing else picked them up. This does: one
 * ticket, for a person to handle, listing everybody the automated path could not
 * reach.
 *
 * ⚠ **ONE ticket, not one per person.** `ticket_create`'s own description says
 * to batch the detail into the description rather than calling it per row. A
 * queue with eleven near-identical tickets is a queue nobody works.
 */
const UNREACHABLE_SHAPE = `{{ ${trows("unreachable")} | jq('{n: length, ` +
  `names: [.[] | (.full_name + " (" + (.reason // "no work email") + ")")] | join("; ")}') | first }}`;

const UNREACHABLE_TICKET = `{{ json(outputs.chase_shape.value) | jq('[{` +
  `title: ("Attendance: " + (.n|tostring) + " employee(s) could not be emailed for PERIOD_PLACEHOLDER"), ` +
  `description: ("These employees were below their attendance threshold but the automation could not " + ` +
  `"reach them by email, so nobody has been told. Please follow up by another route.\\n\\n" + .names), ` +
  `priority: "normal", labels: ["attendance", "unreachable"]}]') | first }}`;

export const hrChaseUnreachable: FlowModel = {
  id: "hr-chase-unreachable",
  inputs: [PERIOD_INPUT],
  steps: [
    {
      id: "month_rows",
      kind: "query",
      name: "This month's figures with thresholds",
      ref: ROWS_REF,
      paramsExpr: ROWS_PARAMS,
    },
    {
      id: "unreachable",
      kind: "transform",
      name: "Who could not be emailed",
      description:
        "Below threshold AND beyond email's reach: no address on record, or one that " +
        "hard-bounces. The bounce rule reads in jq — it is a string match, not data. " +
        "Exited-after-the-first-month staff are out: their address dying with the " +
        "contract is expected, not a failure to reach.",
      expr: withPeriod(
        `{{ ${rows("month_rows")} | jq('("PERIOD_PLACEHOLDER-01" as $asof | [.[] | ` +
        `select(.min_attendance_rate != null and (.attendance_rate | tonumber) < (.min_attendance_rate | tonumber)) | ` +
        `select(.exit_date == null or .exit_date > $asof) | ` +
        `select(.work_email == null or (.work_email | endswith("@acme-hr-bounce.example"))) | ` +
        `{employee_id: .employee_id, full_name: .full_name, work_email: .work_email, ` +
        `department_code: .department_code, attendance_rate: (.attendance_rate | tonumber), ` +
        `min_attendance_rate: (.min_attendance_rate | tonumber), ` +
        `unreachable_reason: (if .work_email == null then "no work email on record" else "address hard-bounces" end)}])') | first }}`),
      dependsOn: ["month_rows"],
    },
    {
      id: "any_unreachable",
      kind: "branch",
      name: "Is there anyone?",
      description: "No ticket is raised when there is nobody — an empty ticket is noise.",
      conditionExpr: `{{ ${trows("unreachable")} | jq('length > 0') | first }}`,
      dependsOn: ["unreachable"],
    },
    {
      id: "chase_shape",
      kind: "transform",
      name: "Gather them into one list",
      expr: UNREACHABLE_SHAPE,
      dependsOn: ["any_unreachable"],
    },
    {
      id: "chase",
      kind: "tool",
      name: "Raise one ticket for all of them",
      ref: "ticket_create",
      paramsExpr: withPeriod(UNREACHABLE_TICKET),
      dependsOn: ["chase_shape"],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// 3. The monthly digest a department head reads
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ⚠ **`llm_complete` IS THE LAST STEP AND NOTHING READS IT** (D-34). The figures
 * come from the query; the model only words them. It earned that rule on its
 * first real run: a digest whose numbers were all correct ranked two departments
 * in an order its own numbers contradicted.
 *
 * So the email carries the model's paragraph AND the rollup itself — the prose
 * is a courtesy, the table is the answer.
 */
const DIGEST_INSTRUCTION =
  "Write two short paragraphs for a department head summarising these attendance figures for " +
  "PERIOD_PLACEHOLDER. Use only the numbers given. Do not rank, score or recommend anything.";

const BRIEF_PARAMS = `{{ ${trows("rollup")} | jq('[{instruction: "${DIGEST_INSTRUCTION}", ` +
  `input: (. | tostring)}]') | first }}`;

/**
 * ⚠ **THE WHOLE BODY GOES INTO jq, and the field is plucked INSIDE it.** The
 * obvious spelling — `json(outputs.brief.body).results[0].data.text | jq(…)` —
 * FAILED on the first real run:
 *
 *     Unable to parse jq value 'For 2026-06, Engineering had 19 employees…
 *
 * because plucking the field first hands jq a raw multi-line string, and jq's
 * input must be valid JSON. A model's prose has newlines and quotes in it, so
 * this breaks exactly when the step does its job. Keeping the whole envelope as
 * jq's input and reaching for `.results[0].data.text` inside the program means
 * jq does the escaping itself.
 */
const DIGEST_EMAIL = "{{ json(outputs.brief.body) | jq('[{" +
  `sender: "${SENDER}", recipients: ["hr-lead@acme-hr.example"], ` +
  `subject: "Attendance digest — PERIOD_PLACEHOLDER", body: .results[0].data.text}]') | first }}`;

export const hrDepartmentDigest: FlowModel = {
  id: "hr-department-digest",
  inputs: [PERIOD_INPUT],
  steps: [
    {
      id: "month_rows",
      kind: "query",
      name: "This month's figures with thresholds",
      ref: ROWS_REF,
      paramsExpr: ROWS_PARAMS,
    },
    {
      id: "rollup",
      kind: "transform",
      name: "Attendance by department",
      description:
        "The department table the email carries: per-department headcount, how many fell " +
        "below their own threshold, the mean, the worst rate, and the highest threshold in " +
        "play. Computed here, in jq, from one row per employee — the rollup SQL's CTE " +
        "and filtered aggregates have no visual spelling, so they live here instead.",
      expr:
        `{{ ${rows("month_rows")} | jq('sort_by(.department_code) | group_by(.department_code) | map(. as $g | ` +
        `($g | map(.attendance_rate | tonumber)) as $rates | ($g | map(.min_attendance_rate | tonumber? // null)) as $floors | ` +
        `{department_code: $g[0].department_code, department_name: $g[0].department_name, ` +
        `employees_with_data: ($g | map(.employee_id) | unique | length), ` +
        `below_threshold_count: ([$g[] | select(.min_attendance_rate != null and (.attendance_rate | tonumber) < (.min_attendance_rate | tonumber))] | length), ` +
        `mean_attendance_rate: ((($rates | add) / ($rates | length) * 100 | round) / 100), ` +
        `worst_attendance_rate: ($rates | min), min_attendance_rate: ($floors | max)})') | first }}`,
      dependsOn: ["month_rows"],
    },
    {
      id: "brief",
      kind: "tool",
      name: "Put it in words",
      description:
        "Wording only. Every figure comes from the query above — this step is told not to rank " +
        "or recommend, and nothing downstream reads its decisions.",
      ref: "llm_complete",
      paramsExpr: withPeriod(BRIEF_PARAMS),
      dependsOn: ["rollup"],
    },
    {
      id: "send",
      kind: "tool",
      name: "Email the digest",
      // ⚠ `mail_send`, deliberately NOT `tether_email_send`. That one is REAL
      // delivery to a live mailbox and addresses "whoever started the run" —
      // which a scheduled or seeded run has no answer for. A demo flow that
      // depends on a human starter is a demo that fails when nobody is looking.
      description: "Simulated demo mail — visible in the outbox, nothing is delivered.",
      ref: "mail_send",
      paramsExpr: withPeriod(DIGEST_EMAIL),
      dependsOn: ["brief"],
    },
  ],
};

/** A flow plus the words shown beside it on the flows list. */
export type HrDemoSpec = { model: FlowModel; name: string; description: string };

/**
 * ⚠ **The descriptions are written for the person being shown the product**, not
 * for a reviewer. Each says what job the automation does and what decision it
 * makes — because on the flows list that sentence is the only thing on screen.
 */
export const HR_DEMO_SCENARIOS: HrDemoSpec[] = [
  {
    model: hrAttendanceCheck,
    name: "Monthly attendance check",
    description:
      "Finds everyone whose attendance fell below their own department's threshold, emails each " +
      "of them a warning — or posts an all-clear if there is nobody — and then reports what it " +
      "did, either way. The each-way step is the interesting part: it runs once, on both paths, " +
      "rather than being copied into both.",
  },
  {
    model: hrChaseUnreachable,
    name: "Chase the ones we could not email",
    description:
      "The other half of the attendance check. Contractors have no work address, so the " +
      "automated warning cannot reach them — this raises ONE ticket listing all of them for a " +
      "person to follow up, instead of letting them fall through the gap silently.",
  },
  {
    model: hrDepartmentDigest,
    name: "Department attendance digest",
    description:
      "Emails a per-department attendance summary for the month, with a short written " +
      "introduction. Every figure comes from the query; the model only puts them into words and " +
      "nothing downstream reads what it wrote.",
  },
];

export const HR_DEMO_FLOWS: FlowModel[] = HR_DEMO_SCENARIOS.map((s) => s.model);
