/**
 * The showcase flows — one per capability, so each is clickable rather than
 * described.
 *
 * ⚠ **Every id here is deliberately outside the harness set.** `kestra:prove`
 * deploys `hr-attendance-screening`, `kestra:phase3` compiles
 * `hr-screening-compiled`, and `e2e:ui` uses `e2e-ui-journey`. A Foundry `flows`
 * row that reuses one of those slugs makes `POST /api/executions/begin` resolve
 * the Foundry row instead, and refuse the harness's own run with *"flow has no
 * approved revision"* — scenario A fails and nothing in the output points at the
 * cause. That cost a confusing debugging session; `showcase:seed` now asserts the
 * prefix, and `ui-honesty-check.sh` asserts it in the source.
 *
 * ── What each flow is FOR ────────────────────────────────────────────────────
 *
 * | flow | the capability it makes visible |
 * | :--- | :--- |
 * | `showcase-attendance-screening` | named queries · array-shaped fan-out (M1) · gate 2, because it carries a cron |
 * | `showcase-unreachable-escalation` | the authenticated tool · aggregation into ONE call · the empty case |
 * | `showcase-department-rollup` | a `code` fragment under `networkMode: none` · a declared output contract |
 * | `showcase-retry-recovery` | runtime retry: one 503, re-attempted, and the run survives |
 * | `showcase-llm-digest` | text generation, and the line it must not cross (terminal prose) |
 * | `showcase-routing` | per-item routing: one list, a destination per band, each filtered by its own `select(…)` |
 *
 * The expressions are single-line for the reason `hr-screening.model.ts` gives:
 * Pebble does not re-evaluate `{{ }}` inside a filter argument, and `| first`
 * unwraps a jq string into a raw string (I-11). Every value handed to a JSON
 * position is therefore built **inside jq** and interpolated whole — never
 * assembled by rendering text into a JSON body.
 */

import type { FlowModel } from "../services/flow-compiler.service.js";

/** Reserved by the verification harnesses. Nothing here may collide with these. */
export const HARNESS_FLOW_IDS = [
  "hr-attendance-screening",
  "hr-screening-compiled",
  "e2e-ui-journey",
] as const;

export const SHOWCASE_PREFIX = "showcase-";

const SENDER = "hr-bot@acme-hr.example";

// ── 1. the reference flow ────────────────────────────────────────────────────

/** A pure reshape into mailable / unmailable. No credential (R2), no decision. */
const PARTITION_EXPR =
  "{{ json(outputs.screen.body).results[0].data " +
  "| jq('{mailable: [.[] | select(.work_email != null) | . + " +
  "{subject: (\"Attendance below policy — \" + .department_code), " +
  "body: (\"Hi \" + .full_name + \", your attendance was \" + (.attendance_rate|tostring) + " +
  "\"% against a policy minimum of \" + (.min_attendance_rate|tostring) + \"%.\")}], " +
  "unmailable: [.[] | select(.work_email == null)]}') " +
  "| first }}";

/**
 * ONE taskrun for N emails (M1).
 *
 * Not a `ForEach`: each item would be its own taskrun, i.e. a database row and a
 * node in the step graph. A bouncing recipient comes back as a per-item result
 * rather than a step failure, which is what makes partial delivery a warning
 * instead of an outage — and it is why `showcase-unreachable-escalation` exists
 * to catch the bouncing case rather than this flow pretending it didn't happen.
 *
 * Picker-built: `sender` a literal, the rest fields off the partition's rows —
 * exactly what the inspector's "once for each row from partition" produces, so
 * rebuilding this step by hand needs no jq. The per-row wording lives in the
 * `transform` above, which is where jq belongs.
 */
const NOTIFY_PARAMS_EXPR =
  "{{ json(outputs.partition.value).mailable " +
  `| jq('[.[] | {"sender": "${SENDER}", "recipients": .work_email, ` +
  `"subject": .subject, "body": .body}]') ` +
  "| first }}";

export const SHOWCASE_SCREENING: FlowModel = {
  id: "showcase-attendance-screening",
  // `period` is a declared INPUT, so the worst measured failure of the old
  // monolithic path — a script that hardcoded `period="2023-10"` and emailed 0
  // of 11 — is not merely less likely here, it is inexpressible.
  inputs: [{ id: "period", type: "STRING", format: "month", defaults: "2026-06" }],
  steps: [
    { id: "fetch_policy", kind: "datasource", ref: "hr_demo.policy_thresholds", paramsExpr: "[{}]" },
    {
      id: "screen",
      kind: "datasource",
      ref: "hr_demo.attendance_below_threshold",
      paramsExpr: '[{ "period": "{{ inputs.period }}" }]',
    },
    // Reported, never emailed: a leaver and someone on approved medical leave.
    {
      id: "excluded",
      kind: "datasource",
      ref: "hr_demo.attendance_excluded",
      paramsExpr: '[{ "period": "{{ inputs.period }}" }]',
    },
    { id: "partition", kind: "transform", expr: PARTITION_EXPR, dependsOn: ["screen"] },
    {
      id: "notify",
      kind: "tool",
      ref: "mail_send",
      paramsExpr: NOTIFY_PARAMS_EXPR,
      dependsOn: ["partition"],
      timeoutSeconds: 120,
    },
  ],
  /**
   * The cron is the whole point of this flow being the armed one: a Kestra
   * Schedule trigger is part of the flow definition, so approving a revision
   * DEPLOYS it and revoking REMOVES it. 06:00 on Mondays — far enough out that
   * clicking through the showcase never fires it by accident.
   */
  schedule: { cron: "0 6 * * 1", timezone: "Europe/London" },
};

// ── 2. the authenticated tool, and one call instead of N ─────────────────────

/**
 * ONE ticket for the whole run, not one per employee — which is what
 * `ticket_create`'s own description asks for ("one summary ticket per automation
 * run for the audit trail"). The contrast with `notify` above is the point: the
 * same array-shaped mechanism produces N calls or 1 depending on what the
 * receiving service actually wants, and neither needs a loop construct.
 *
 * `if length == 0 then [] else …` is not defensive tidying. At `2026-05` the
 * dataset flags nobody, and an empty params array means the step makes **zero
 * tool calls** — so the empty case is visibly zero rather than a ticket
 * announcing "0 unreachable employees", which is how a quiet month becomes
 * indistinguishable from a broken run.
 */
const TICKET_EXPR =
  "{{ json(outputs.unreachable.body).results[0].data " +
  "| jq('if length == 0 then {calls: []} else {calls: [{" +
  'title: ("Attendance escalation — " + (length|tostring) + " unreachable employee(s)"), ' +
  'description: ([.[] | .full_name + " (" + .department_code + ") — " + .unreachable_reason] | join("; ")), ' +
  'priority: "high", ' +
  'labels: ["attendance", "unreachable"]' +
  "}]} end') | first }}";

/**
 * Picker-built over the `ticket` reshape: every param a field, nothing
 * composed. The aggregation (one ticket for the run, the empty case as zero
 * calls) lives in the `transform`, which is where jq belongs.
 */
const ESCALATE_PARAMS_EXPR =
  "{{ json(outputs.ticket.value).calls " +
  `| jq('[.[] | {"title": .title, "description": .description, ` +
  `"priority": .priority, "labels": .labels}]') ` +
  "| first }}";

export const SHOWCASE_ESCALATION: FlowModel = {
  id: "showcase-unreachable-escalation",
  inputs: [{ id: "period", type: "STRING", format: "month", defaults: "2026-06" }],
  steps: [
    {
      id: "unreachable",
      kind: "datasource",
      ref: "hr_demo.flagged_unreachable",
      paramsExpr: '[{ "period": "{{ inputs.period }}" }]',
    },
    { id: "ticket", kind: "transform", expr: TICKET_EXPR, dependsOn: ["unreachable"] },
    {
      // `ticket_create` is the ONE authenticated tool in the catalogue — header
      // style, `X-API-Key`. The other thirteen are keyless on purpose: an
      // endpoint that accepts every style cannot detect a wrong guess, so a
      // credential path that is exercised by exactly one tool is the only one
      // whose failure is visible in ops-api's `api_call_log.auth_ok`.
      id: "escalate",
      kind: "tool",
      ref: "ticket_create",
      paramsExpr: ESCALATE_PARAMS_EXPR,
      dependsOn: ["ticket"],
      timeoutSeconds: 60,
    },
  ],
  // Deliberately NO schedule and left unapproved by the seed: this is the flow
  // that demonstrates gate 2 refusing. Firing its trigger returns 403 until a
  // revision is approved.
};

// ── 3. a code fragment ───────────────────────────────────────────────────────

/**
 * The fragment. A function BODY, not a program (D-19).
 *
 * It does no I/O of its own — the compiler-emitted wrapper reads `input.json`,
 * checks the declared output keys **inside the container** before the value
 * crosses back, and enforces the 1 MB cap. There is no `print()`, which
 * `validateFragment` rejects precisely because a fragment that writes its own
 * output could pick its own channel and declare its own contract satisfied.
 *
 * It also has no network: `networkMode: none` on Kestra's Docker task runner, so
 * R9 is *"a fragment cannot reach the network"* rather than *"should not"*.
 * Nothing here needs it — the data arrives as an argument.
 *
 * Why this is a `code` step and not `transform`: it derives a breach share,
 * ranks on it and bands a severity. That is a judgement over the data, which is
 * what a fragment is for; reshaping alone would be a `transform`.
 *
 * `employees_below_policy` is summed across ALL departments including those it
 * skips, and that is the cross-check worth having: at `2026-06` it must equal
 * 11, the oracle's flagged total, computed independently from the dataset
 * definition. A fragment that dropped a department would still return a
 * plausible ranking, and this number is what catches it.
 *
 * ⚠ The 20% severity band is a demonstration threshold, not policy. It exists so
 * both bands appear in one run (SUP 21.4, ENG 21.1, MKT 20.0 high; SLS 18.2, FIN
 * 16.7 moderate) — nothing in the dataset says 20% is meaningful.
 */
const ASSESS_FRAGMENT = [
  "def run(payload):",
  "    rows = payload['departments']",
  "    breaching = []",
  "    total_below = 0",
  "    for r in rows:",
  "        n = r['employees_with_data']",
  "        k = r['below_threshold_count']",
  "        total_below += k",
  "        if k == 0 or n == 0:",
  "            continue",
  "        share = round(100.0 * k / n, 1)",
  "        breaching.append({",
  "            'department_code': r['department_code'],",
  "            'department_name': r['department_name'],",
  "            'below_threshold_count': k,",
  "            'employees_with_data': n,",
  "            'breach_share_pct': share,",
  "            'min_attendance_rate': r['min_attendance_rate'],",
  "            'worst_attendance_rate': r['worst_attendance_rate'],",
  "            'severity': 'high' if share >= 20.0 else 'moderate',",
  "        })",
  // Descending share, then department code. The tie-break is not cosmetic: two
  // departments on the same share would otherwise order by whatever the dict
  // iteration happened to produce, and the chat message would differ between
  // runs of an unchanged flow against unchanged data — which is indistinguishable
  // from the data having moved.
  "    breaching.sort(key=lambda d: (-d['breach_share_pct'], d['department_code']))",
  "    return {",
  "        'below_policy': breaching,",
  "        'department_count': len(rows),",
  "        'employees_below_policy': total_below,",
  "    }",
].join("\n");

/**
 * The one read behind both attendance-summary flows. `attendance_period_rows`
 * carries the month's figures WITH each employee's effective minimum (the
 * lateral effective-date join with org fallback lives inside the operation),
 * so the rollup below reads one step and stays single-source.
 */
const MONTH_ROWS_REF = "hr_demo.attendance_period_rows";
const MONTH_ROWS_PARAMS =
  '[{"period": "{{ inputs.period }}", "as_of": "{{ inputs.period }}-01", "not_exited": "exited", "not_on_leave": "on_leave"}]';

/**
 * The department table, computed here in jq from one row per employee — the
 * same reshape `hr-department-digest` carries, repeated verbatim so the two
 * flows cannot drift. Emits the seven aliases the fragment reads; the fragment
 * itself is untouched.
 */
const ROLLUP_EXPR =
  "{{ json(outputs.month_rows.body).results[0].data " +
  "| jq('sort_by(.department_code) | group_by(.department_code) | map(. as $g | " +
  "($g | map(.attendance_rate | tonumber)) as $rates | ($g | map(.min_attendance_rate | tonumber? // null)) as $floors | " +
  "{department_code: $g[0].department_code, department_name: $g[0].department_name, " +
  "employees_with_data: ($g | map(.employee_id) | unique | length), " +
  "below_threshold_count: ([$g[] | select(.min_attendance_rate != null and (.attendance_rate | tonumber) < (.min_attendance_rate | tonumber))] | length), " +
  "mean_attendance_rate: ((($rates | add) / ($rates | length) * 100 | round) / 100), " +
  "worst_attendance_rate: ($rates | min), min_attendance_rate: ($floors | max)})') | first }}";

/** Built inside jq and interpolated whole — the input.json body must be JSON, and
 *  rendering text into a JSON position is I-11. */
// An OBJECT literal with a span inside it — the compiler refuses a code feed it
// cannot see is an object (`checkCodeInputExpr`, since 2026-09-15).
const ASSESS_INPUT_EXPR = '{"departments": {{ outputs.rollup.value }}}';

/**
 * The message. `blocks` is omitted rather than sent empty — an optional
 * parameter present-but-empty and absent are different requests, and the stub
 * records what it was actually sent.
 *
 * A one-element `calls` reshape, so the chat step below is picker-built: three
 * fields, nothing composed. The conditional wording is the transform's job.
 */
const ROLLUP_MESSAGE_EXPR =
  "{{ outputs.assess.vars.result " +
  "| jq('if (.below_policy | length) == 0 then {calls: " +
  '[{channel: "#hr-ops", author: "foundry-showcase", ' +
  'text: ("Attendance roll-up: no employee was below policy in any of " + (.department_count|tostring) + " department(s).")}]} ' +
  "else {calls: [{channel: \"#hr-ops\", author: \"foundry-showcase\", " +
  'text: ((.employees_below_policy|tostring) + " employee(s) below policy across " + ' +
  '(.below_policy | length | tostring) + " of " + (.department_count|tostring) + " department(s) — " + ' +
  '([.below_policy[] | .department_code + " " + (.below_threshold_count|tostring) + "/" + (.employees_with_data|tostring) + " (" + (.breach_share_pct|tostring) + "%, " + .severity + ")"] | join(", ")))}]} ' +
  "end') | first }}";
const ANNOUNCE_PARAMS_EXPR =
  "{{ json(outputs.message.value).calls " +
  `| jq('[.[] | {"channel": .channel, "author": .author, "text": .text}]') ` +
  "| first }}";

export const SHOWCASE_ROLLUP: FlowModel = {
  id: "showcase-department-rollup",
  inputs: [{ id: "period", type: "STRING", format: "month", defaults: "2026-06" }],
  steps: [
    {
      id: "month_rows",
      kind: "query",
      ref: MONTH_ROWS_REF,
      paramsExpr: MONTH_ROWS_PARAMS,
    },
    {
      id: "rollup",
      kind: "transform",
      expr: ROLLUP_EXPR,
      dependsOn: ["month_rows"],
    },
    {
      id: "assess",
      kind: "code",
      code: ASSESS_FRAGMENT,
      inputExpr: ASSESS_INPUT_EXPR,
      // DERIVED from what the fragment returns, and the two must agree — the
      // wrapper checks these keys in the container, so a mismatch is a
      // `contract_violation` naming the step rather than a KeyError three steps
      // downstream.
      outputKeys: ["below_policy", "department_count", "employees_below_policy"],
      dependsOn: ["rollup"],
      timeoutSeconds: 120,
    },
    { id: "message", kind: "transform", expr: ROLLUP_MESSAGE_EXPR, dependsOn: ["assess"] },
    {
      id: "announce",
      kind: "tool",
      ref: "chat_post_message",
      paramsExpr: ANNOUNCE_PARAMS_EXPR,
      dependsOn: ["message"],
      timeoutSeconds: 60,
    },
  ],
};

// ── 4. runtime retry ─────────────────────────────────────────────────────────

/**
 * The tool the retry flow calls. Registered by `showcase:seed`, deliberately NOT
 * added to `demo/tool-catalogue.ts`.
 *
 * That catalogue is the regression net's subject — `demo:verify` and
 * `demo:rehearse` are written against those 14 tools — and a 15th whose entire
 * purpose is to fail would be a permanent asterisk on every count they report.
 * It also does not belong to the HR domain in any sense: it reads no employee
 * data, it is a fixture for demonstrating the engine's behaviour.
 */
export const FLAKY_TOOL = {
  name: "flaky_probe",
  method: "GET" as const,
  urlPath: "/flaky",
  description:
    "A deliberately unreliable reachability probe, for demonstrating runtime retry. " +
    "Fails the first `failures` calls for a given `key` with HTTP 503, then succeeds and " +
    "reports which attempt it was. The counter is derived from the call log, so it survives " +
    "an API-server restart and is visible afterwards. ALL DATA IS SYNTHETIC.",
  paramsSchema: {
    key: {
      type: "string",
      required: true,
      description:
        "Groups attempts. Pass the execution id so each run starts fresh; reusing a key " +
        "across runs means the second run succeeds first time.",
    },
    failures: {
      type: "integer",
      required: false,
      description: "How many calls to fail before succeeding, 0-4. Default 1.",
    },
  },
};

/**
 * Reads the probe's own account of what happened. `.attempt` comes from the
 * ENDPOINT, not from Kestra, which is what makes the message checkable: it says
 * "succeeded on attempt 2" because the second request was genuinely the second
 * request to reach the service, not because the flow assumed a retry occurred.
 *
 * A one-element `calls` reshape, so the report step below is picker-built: three
 * fields, nothing composed. The conditional wording is the transform's job.
 */
const RETRY_MESSAGE_EXPR =
  "{{ json(outputs.probe.body).results[0].data " +
  '| jq(\'{calls: [{channel: "#hr-ops", author: "foundry-showcase", ' +
  'text: (if .recovered then ("Reachability probe recovered: attempt " + (.attempt|tostring) + ' +
  '" succeeded after " + ((.attempt - 1)|tostring) + " HTTP 503(s). The run continued rather than failing.") ' +
  'else ("Reachability probe succeeded first time (attempt " + (.attempt|tostring) + ").") end)}]}\') ' +
  "| first }}";

const RETRY_REPORT_EXPR =
  "{{ json(outputs.message.value).calls " +
  `| jq('[.[] | {"channel": .channel, "author": .author, "text": .text}]') ` +
  "| first }}";
/**
 * The one genuinely missing loop, made clickable.
 *
 * Array-shaped fan-out (M1) and the redraft loop already existed; a *transient*
 * failure killed the run permanently, because the compiler emitted no `retry:`
 * block at all. This flow provokes one 503 and recovers from it.
 *
 * ── Why the key is the EXECUTION id ─────────────────────────────────────────
 *
 * `flaky_probe` counts prior calls per key, so a fixed key would fail once ever
 * — the first run would demonstrate a retry and every run after it would sail
 * through, which is the least useful possible demo. `{{ execution.id }}` gives
 * each run its own counter, and `execution` is one of the five roots the D-22
 * expression allowlist permits.
 *
 * `maxAttempts: 3` against `failures: 1` is deliberate headroom: the flow only
 * needs two, and the third exists so that a *second* transient failure — the
 * engine being briefly busy, the API server mid-restart — still recovers rather
 * than turning the showcase red for a reason unrelated to what it demonstrates.
 */
export const SHOWCASE_RETRY: FlowModel = {
  id: "showcase-retry-recovery",
  steps: [
    {
      id: "probe",
      kind: "tool",
      ref: "flaky_probe",
      // Hand-written, and deliberately so: `{{ execution.id }}` names the
      // EXECUTION root, which the picker's single-call form cannot emit (it
      // only wires flow inputs and literals). The raw hatch exists for this.
      paramsExpr: '[{ "key": "{{ execution.id }}", "failures": 1 }]',
      // Safe here in the strong sense: the probe writes nothing. The general
      // rule and its one residual (a lost response looks like a failure) are in
      // `StepRetry` — read that before putting `retry` on a step that sends mail.
      retry: { maxAttempts: 3, intervalSeconds: 5 },
      timeoutSeconds: 30,
    },
    {
      // The probe's account of itself, reshaped for the report step below.
      id: "message",
      kind: "transform",
      expr: RETRY_MESSAGE_EXPR,
      dependsOn: ["probe"],
    },
    {
      id: "report",
      kind: "tool",
      ref: "chat_post_message",
      paramsExpr: RETRY_REPORT_EXPR,
      dependsOn: ["message"],
      timeoutSeconds: 60,
    },
  ],
};

// ── 5. text generation, and the line it must not cross ───────────────────────

/**
 * The `llm_complete` step's params — built in jq, whole, and interpolated once.
 *
 * ⚠ THIS IS THE I-11 CASE THE OTHER FLOWS ONLY ALMOST HIT. Every existing tool
 * step passes ids, dates and enum codes; this one passes an LLM prompt built
 * from an upstream step's output, which is arbitrary text with quotes, newlines
 * and whatever the rollup returned. Rendering that into a JSON position
 * produces a body Kestra rejects with a 400 that names nothing.
 *
 * So `(. | tostring)` runs INSIDE jq: jq emits a correctly escaped
 * JSON string, and Pebble interpolates a value that is already valid JSON. The
 * same rule every expression that carries free text into a JSON body follows.
 *
 * `max_tokens` is a real number, not a formality: too low truncates, and the
 * tool returns 422 `output_truncated` rather than a 200 over half a sentence.
 * 500 is sized for the two short paragraphs the instruction asks for.
 */
const DIGEST_PARAMS_EXPR =
  "{{ json(outputs.rollup.value) " +
  "| jq('[{instruction: \"Write two short paragraphs for an internal HR email summarising " +
  "these department attendance figures. Say which departments look worst and by how much. " +
  "Use only the numbers given.\", input: (. | tostring), max_tokens: 500}]') " +
  "| first }}";

/**
 * The generated text goes into a chat message body and stops there.
 *
 * `.results[0].data.text` is read as a VALUE and passed through — it is not
 * parsed, matched, counted or branched on, and nothing downstream reads it at
 * all. That is the whole rule: the output is terminal. If this step instead did
 * `if (.text | test("urgent"))` the flow would work in testing and behave
 * differently on a Tuesday, and it would present as the flow being broken rather
 * than as the model having had a different opinion.
 *
 * jq again, for the same reason as above: the text is prose, and prose goes into
 * a JSON body only via a JSON encoder.
 */
const DIGEST_MESSAGE_EXPR =
  "{{ json(outputs.summarise.body) " +
  '| jq(\'{calls: [{channel: "#hr-ops", author: "foundry-showcase", ' +
  'text: ("Attendance digest (generated text — not a calculation):\\n\\n" + .results[0].data.text)}]}\') ' +
  "| first }}";

const DIGEST_POST_EXPR =
  "{{ json(outputs.message.value).calls " +
  `| jq('[.[] | {"channel": .channel, "author": .author, "text": .text}]') ` +
  "| first }}";

/**
 * The LLM tool, clickable.
 *
 * ── What this flow demonstrates, and what it deliberately does not ──────────
 *
 * A query step reads the month's figures and a transform rolls them up by
 * department. A tool step turns them into prose. A reshape wraps that prose
 * for chat, and a second tool step posts it.
 * The arithmetic is done by SQL and the writing is done by a model, and the
 * boundary between them is exactly where the non-determinism is allowed to
 * start.
 *
 * ⚠ It is NOT scored by the oracle, and it must never be. `expectedScreening`
 * checks which eleven people were mailed and never the wording, which is what
 * keeps the regression net meaningful — a scenario whose pass condition includes
 * generated prose is a scenario that fails on a good day for no reason. This
 * flow's assertions (`showcase:verify`) are structural: the step succeeded, the
 * text is non-empty, the chat message contains it.
 *
 * The `summarise` params stay hand-written, and deliberately so: they wire the
 * WHOLE upstream output (`(. | tostring)`) into ONE call, which the
 * picker's per-row mappings cannot express. The raw hatch exists for this.
 *
 * Left unapproved and not seeded with a test run: a run costs a real completion
 * against a billable credential, and a seed that spends money every time someone
 * provisions a demo is a surprise nobody asked for. Press the button.
 */
export const SHOWCASE_LLM_DIGEST: FlowModel = {
  id: "showcase-llm-digest",
  inputs: [{ id: "period", type: "STRING", format: "month", defaults: "2026-06" }],
  steps: [
    {
      id: "month_rows",
      kind: "query",
      ref: MONTH_ROWS_REF,
      paramsExpr: MONTH_ROWS_PARAMS,
    },
    {
      id: "rollup",
      kind: "transform",
      expr: ROLLUP_EXPR,
      dependsOn: ["month_rows"],
    },
    {
      id: "summarise",
      kind: "tool",
      ref: "llm_complete",
      paramsExpr: DIGEST_PARAMS_EXPR,
      dependsOn: ["rollup"],
      // Generation is decode-bound; a 500-token answer is seconds, not
      // milliseconds, and the default step timeout would make a slow gateway
      // look like a broken tool.
      timeoutSeconds: 180,
    },
    {
      // The generated prose, reshaped for the post step below. Read as a VALUE
      // and passed through — never parsed, matched, counted or branched on.
      id: "message",
      kind: "transform",
      expr: DIGEST_MESSAGE_EXPR,
      dependsOn: ["summarise"],
    },
    {
      id: "post",
      kind: "tool",
      ref: "chat_post_message",
      paramsExpr: DIGEST_POST_EXPR,
      dependsOn: ["message"],
      timeoutSeconds: 60,
    },
  ],
};

// ── 6. per-item routing: one list, a destination per band ────────────────────

/**
 * The builder's if/elif, made clickable.
 *
 * One flagged list fans out to THREE destinations, and every item lands where
 * its own `attendance_rate` says it should: below 70% each person is emailed,
 * 70% and up each person is named in chat, and the severe names ALSO travel as
 * a bare list whose elements become messages whole. No destination sees another
 * one's rows — each carries its own `select(…)`, and a `select` matching
 * nothing is a valid no-op rather than an error.
 *
 * Every call step here is picker-built: literals, fields off the rows, the item
 * itself, and one "only rows where" predicate each. Rebuilding any of them by
 * hand needs no jq; the list-shaping (`names`) is a `transform`, which is where
 * jq belongs.
 */
export const SHOWCASE_ROUTING: FlowModel = {
  id: "showcase-routing",
  inputs: [{ id: "period", type: "STRING", format: "month", defaults: "2026-06" }],
  steps: [
    {
      id: "screen",
      kind: "datasource",
      ref: "hr_demo.attendance_below_threshold",
      paramsExpr: '[{ "period": "{{ inputs.period }}" }]',
    },
    {
      id: "severe",
      kind: "tool",
      ref: "mail_send",
      paramsExpr:
        "{{ json(outputs.screen.body).results[0].data " +
        `| jq('[.[] | select((.attendance_rate | tonumber?) < 70) | {"sender": "${SENDER}", ` +
        `"recipients": .work_email, "subject": "Attendance follow-up required", ` +
        `"body": "Your attendance is below 70% — please see your manager this week."}]') ` +
        "| first }}",
      dependsOn: ["screen"],
      timeoutSeconds: 120,
    },
    {
      id: "mild",
      kind: "tool",
      ref: "chat_post_message",
      paramsExpr:
        "{{ json(outputs.screen.body).results[0].data " +
        `| jq('[.[] | select((.attendance_rate | tonumber?) >= 70) | {"channel": "#hr-ops", ` +
        `"author": "foundry-showcase", "text": .full_name}]') ` +
        "| first }}",
      dependsOn: ["screen"],
      timeoutSeconds: 60,
    },
    {
      // The severe names as a bare list — no columns, just values. The `shout`
      // step below maps the item itself.
      id: "names",
      kind: "transform",
      expr:
        "{{ json(outputs.screen.body).results[0].data " +
        `| jq('{names: [.[] | select((.attendance_rate | tonumber?) < 70) | .full_name]}') ` +
        "| first }}",
      dependsOn: ["screen"],
    },
    {
      id: "shout",
      kind: "tool",
      ref: "chat_post_message",
      paramsExpr:
        "{{ json(outputs.names.value).names " +
        `| jq('[.[] | {"channel": "#hr-ops", "author": "foundry-showcase", "text": .}]') ` +
        "| first }}",
      dependsOn: ["names"],
      timeoutSeconds: 60,
    },
  ],
};

export const SHOWCASE_FLOWS = [
  {
    model: SHOWCASE_SCREENING,
    name: "Attendance screening",
    description:
      "The reference automation. Three named queries, a pure reshape, and one taskrun that " +
      "emails every flagged employee. Carries a Monday cron, so approving a revision arms a " +
      "real Kestra schedule and revoking removes it.",
    /**
     * Approved by the seed, so gate 2 is visible in its satisfied state — which
     * requires a successful draft run FIRST, because gate 1 refuses to approve a
     * flow that has never completed one. `showcase:seed` does not work around
     * that; it performs the sequence.
     */
    arm: true,
    testRun: true,
    unapprovedBecause: "",
  },
  {
    model: SHOWCASE_ESCALATION,
    name: "Unreachable escalation",
    description:
      "The employees the screening flow cannot email — no address, or an address that " +
      "hard-bounces — raised as one ticket through the catalogue's only authenticated tool. " +
      "Left unapproved on purpose: firing its trigger is a 403 until someone approves it.",
    arm: false,
    // Run anyway: gate 1 then reads satisfied, so approving it in the UI is one
    // click and the 403 is genuinely gate 2 rather than gate 1 wearing its badge.
    testRun: true,
    unapprovedBecause: "left unapproved on purpose: this is the flow that shows gate 2 refusing",
  },
  {
    model: SHOWCASE_ROLLUP,
    name: "Department roll-up",
    description:
      "A generated Python fragment ranks departments by how far their mean attendance sits " +
      "below policy, then posts the result to chat. The fragment runs with no network, no " +
      "credentials and no volumes, and its output keys are checked inside the container.",
    arm: false,
    testRun: true,
    unapprovedBecause:
      "left unapproved: approving it in the UI is the one-click way to see gate 2 satisfied",
  },
  {
    model: SHOWCASE_RETRY,
    name: "Retry recovery",
    description:
      "A step whose backend returns HTTP 503 on the first call and succeeds on the second. " +
      "Kestra re-runs the task rather than failing the run, and the step graph shows " +
      "“attempt 2” against it. The recovered run settles as WARNING, not SUCCESS, so " +
      "“it worked on the second go” is recorded rather than hidden.",
    arm: false,
    // Test-run by the seed, because the whole claim is that it recovers — a
    // seeded retry demo nobody has run is an assertion, not a demonstration.
    testRun: true,
    unapprovedBecause:
      "left unapproved — nothing here needs arming; the point is the run it just made",
  },
  {
    model: SHOWCASE_LLM_DIGEST,
    name: "Attendance digest",
    description:
      "SQL computes the figures; a language model writes them up; the write-up is posted to " +
      "chat. The generated text is read by a person and by nothing else — no step parses it, " +
      "branches on it or counts anything in it, which is the only condition under which a " +
      "non-deterministic step belongs in an automation.",
    arm: false,
    /**
     * NOT test-run by the seed. Every run spends a real completion against a
     * billable credential, and a provisioning script that costs money each time
     * it runs is a surprise. It also depends on a provider being configured,
     * which is an operator action rather than a seed's.
     */
    testRun: false,
    unapprovedBecause:
      "left unapproved — configure a provider on the AI provider page, then run it by hand",
  },
  {
    model: SHOWCASE_ROUTING,
    name: "Per-item routing",
    description:
      "One flagged list, three destinations: below 70% each person is emailed, 70% and up " +
      "each person is named in chat, and the severe names also travel as a bare list. Every " +
      "call step is picker-built — literals, fields, the item itself, one row filter each.",
    arm: false,
    // Run: every call is simulated, and the run is what proves the `select(…)`
    // predicates route each item to its branch — including `>=`, which the
    // branch guards do not offer.
    testRun: true,
    unapprovedBecause: "left unapproved — run it by hand to watch each item land in its branch",
  },
] as const;
