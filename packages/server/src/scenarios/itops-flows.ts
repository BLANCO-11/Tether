/**
 * Two IT operations automations a service-desk lead would recognise.
 *
 * ── ⚠ THE TWO FLOWS HAVE DELIBERATELY DIFFERENT BRANCH SHAPES, AND THAT
 *      CONTRAST IS THE MOST USEFUL THING IN THIS FILE ─────────────────────────
 *
 * `itops-sla-triage` uses an `if` / `elif` / `else` CHAIN. Its three arms are
 * mutually exclusive POLICIES — how loudly this run escalates — so exactly one
 * must fire.
 *
 * `itops-vuln-remediation` uses TWO INDEPENDENT GUARDS and is NOT a chain, on
 * purpose. Its two conditions describe DISJOINT SETS OF WORK that can both be
 * non-empty at once: some patches are inside a change freeze and some are not.
 * A chain there would announce the deferrals and then never raise the ticket for
 * the work that could have proceeded — silently, with the run green.
 *
 * The rule that falls out, and it is the one worth taking away:
 *
 *     A CHAIN is right when the arms are alternative ANSWERS to one question.
 *     SEPARATE GUARDS are right when each arm is its own piece of work.
 *
 * Reaching for the chain because it is the newer feature is how flow 2 gets
 * quietly broken, and nothing would fail: the YAML compiles, the run goes green,
 * and a batch of patches nobody was told about waits for a freeze that has
 * already lifted.
 *
 * ── What makes these different from `src/showcase/` ─────────────────────────
 *
 * The showcase set is organised by CAPABILITY — one flow per feature, so a
 * reviewer can click it. These are organised by JOB, like `finance-flows.ts`,
 * and each is scored against `itopsOracle()` rather than against "it went
 * green". A flow that runs is not a flow that is right.
 *
 * ── ⚠ WHY THE SLA CLOCK IS NOWHERE IN THIS FILE ────────────────────────────
 *
 * Because it is in the compiled operation, and that is the whole point. This
 * domain's headline failure is `resolved_at - opened_at` reporting breaches
 * that never happened, and it is not a mistake somebody makes through
 * carelessness — the wrong arithmetic is the obvious one and its answer looks
 * fine. So the elapsed figure and the two-column policy lookup are resolved in
 * `itops_demo.incident_sla_rows`, once, and these flows consume the ANSWER. A
 * trap resolved in the catalogue is structurally unreachable; a trap left for
 * a fragment to remember is one the measured baseline says will be missed.
 *
 * ⚠ The operation exposes consumed-minute PARTS, not the answer: gross clock,
 * gross business-hours, and per-pause overlaps, one row per incident×pause.
 * `consumed` is rebuilt per incident in the two shaping transforms below, on
 * the service's own clock minus its pauses — the same arithmetic the old
 * hand-written queries did in SQL, now stated once per arm in jq.
 *
 * ── ⚠ AND WHY THERE IS NO `agent`, `approval` OR NESTED `branch` IN AN ARM ──
 *
 * `validateModel` refuses all three by name. A `Pause` inside a conditional
 * block is unverified against this engine, and a wrong guess fails at RENDER
 * time — after approval, on a schedule. Neither flow here needs one: nothing in
 * either terminates anything, so neither owes gate 3. The flow that does is
 * `finops-waste-report`, which is a later stage.
 *
 * ── Pebble, once ────────────────────────────────────────────────────────────
 *
 * Every value handed to a JSON position is built INSIDE jq and interpolated
 * whole (I-11). Pebble does not re-evaluate `{{ }}` inside a filter argument,
 * and `| first` unwraps a jq string into raw text — so a rendered string
 * interpolated into a JSON body produces a 400 from Kestra that names nothing.
 * `@json` is jq's own encoder and belongs INSIDE the jq program (I-43).
 *
 * ⚠ EVERY TOOL `paramsExpr` ENDS `| first`, AND IT IS NOT OPTIONAL. Pebble's
 * `jq()` returns a LIST of results, so a program written `jq('[…]')` — one
 * result, which happens to be an array — renders as `[[…]]`. The step body then
 * carries an array whose first element is an array, and the callback refuses it
 * with `params: ["Expected object, received array"]`: a message about the SHAPE
 * of one element, which reads like the projection being wrong rather than like
 * one missing filter. All five expressions in this file were written without it
 * and all five failed identically on the first real run.
 *
 * ⚠ A `tool` step never consumes a raw query row (I-42). The operation rows
 * carry `deferred_until` and `shift_starts`/`shift_ends` as real timestamps,
 * and a timestamp crossing into an `http.Request` body dies with `Unable to
 * parse jq value … with type 'java.util.ArrayList'` — a message that names
 * neither the field nor the reason, and that the same expression does NOT
 * produce inside a `transform`. Every timestamp is flattened to a plain string
 * in a transform before it goes anywhere near a call.
 */

import type { FlowModel } from "../services/flow-compiler.service.js";

/** Every flow here is prefixed, for the same reason the Finance set is. */
export const ITOPS_SCENARIO_PREFIX = "itops-";

const SENDER = "itsm-bot@acme-itops.example";
const DEFAULT_AS_OF = "2026-06-29T10:00:00Z";

/** The query envelope, unwrapped. A `query` step's rows live at `.results[0].data`. */
const rows = (step: string) => `json(outputs.${step}.body).results[0].data`;

// ═══════════════════════════════════════════════════════════════════════════
// 1. SLA triage — page, ticket or digest. Exactly one of the three.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Project the breached incidents into exactly what a page needs.
 *
 * ⚠ TIMESTAMPS ARE FLATTENED HERE (I-42) and `elapsed_mins` is carried as a
 * number, because the summary a person is woken with has to say how far past the
 * budget the incident is. A page reading "INC-1021 breached" tells the person
 * nothing they can act on at 03:00.
 *
 * ⚠ THE BREACH ITSELF IS DERIVED HERE, not in the operation: one
 * `incident_sla_rows` read feeds both this projection and the at-risk one
 * below, so the arm that pages and the arm that tickets cannot disagree about
 * what breached. The operation exposes consumed-minute PARTS (gross clock,
 * gross business, per-pause overlaps); `consumed` is rebuilt per incident in
 * jq — gross on the service's own clock minus its pauses, floored at zero —
 * and breach is `consumed > resolve_budget_mins`.
 *
 * ⚠ TWO TRAPS IN THE PAUSE SUM, both mirroring the oracle: gate pause rows on
 * `pause_started_at != null` (the overlap columns read 0, not null, on
 * no-pause rows, so gating on the value would silently include them), and drop
 * non-positive overlaps with `select(. > 0)` (a pause outside the window must
 * not subtract). Minute fields arrive as strings, so every comparison parses
 * first — a string is always `> 0` in jq, which would defeat both gates.
 *
 * ⚠ `dedupe_key` IS THE INCIDENT CODE and nothing else. That is what stops this
 * flow, on its 15-minute schedule, ringing the same phone four times an hour.
 * A key derived from the timestamp or the summary text is distinct every run:
 * suppression never fires and the feature looks as though it is working.
 */
const PAGE_SHAPE_EXPR =
  `{{ ${rows("incidents")} ` +
  // ⚠ ONE derivation, TWO arms: `consumed` is rebuilt per incident group
  // exactly once, and the breach/at-risk selects project different fields
  // from the same groups. Two shaping transforms would duplicate the
  // arithmetic (a second way for the arms to disagree) and the second guard
  // could not sequence after its shape — a continuation branch may not
  // declare `dependsOn`, so a shape it reads would race it. Reading both
  // arms from `triage` keeps every guard downstream of one edge.
  // 0.8 is `org_settings` `at_risk_fraction`, inlined — jq cannot look it up.
  "| jq('(group_by(.incident_code) | map(" +
  ".[0] as $h | ($h.business_hours_only) as $flag | " +
  "(if $flag then $h.gross_biz_mins else $h.elapsed_mins end | tonumber) as $gross | " +
  "([.[] | select(.pause_started_at != null) | " +
  "(if $flag then .overlap_biz_mins else .overlap_clock_mins end) | " +
  "select(. != null) | tonumber | select(. > 0)] | add // 0) as $paused | " +
  "(([$gross - $paused, 0] | max)) as $consumed | " +
  "{h: $h, consumed: $consumed})) as $groups | " +
  "{pages: [$groups[] | select(.consumed > (.h.resolve_budget_mins | tonumber)) | " +
  "((.h.team_escalation | select(. != null and . != \"\")) // .h.org_escalation) as $esc | " +
  "{incident: .h.incident_code, service: .h.service_name, " +
  "priority: .h.priority, team: .h.team_code, esc: $esc, " +
  // `esc` is the two-level hop the oracle defines: the team's own escalation
  // address, else the org fallback — an empty team address counts as absent,
  // exactly like the oracle's truthiness test. At-risk tickets keep the team
  // contact (`to` below): a warning goes to the team, a page wakes the chain.
  "fallback: ($esc == .h.org_escalation), " +
  "used: .consumed, budget: (.h.resolve_budget_mins | tonumber), " +
  "over: (.consumed - (.h.resolve_budget_mins | tonumber)), " +
  // `naive` is the raw clock elapsed; `used` honours the service's clock.
  "naive: (.h.elapsed_mins | tonumber), " +
  'summary: .h.summary}], ' +
  "tickets: [$groups[] | " +
  "select(.consumed >= ((.h.resolve_budget_mins | tonumber) * 0.8) " +
  "and .consumed < (.h.resolve_budget_mins | tonumber)) | " +
  "{incident: .h.incident_code, service: .h.service_name, " +
  "priority: .h.priority, team: .h.team_code, to: .h.notify_email, " +
  "used: .consumed, budget: (.h.resolve_budget_mins | tonumber), " +
  "pct: (((.consumed * 100) / (.h.resolve_budget_mins | tonumber)) | floor), " +
  'summary: .h.summary}], n: length}\') ' +
  "| first }}";

/**
 * One page per breached incident, in ONE taskrun (M1).
 *
 * ⚠ The summary names the CORRECT consumed figure and the naive one beside it.
 * That is not decoration: the person woken is entitled to see that the clock
 * honoured their service's business hours, because the first question anybody
 * asks about a 03:00 page is whether it is real.
 */
const PAGE_PARAMS_EXPR =
  "{{ json(outputs.triage.value) " +
  "| jq('[.pages[] | {target: .esc, dedupe_key: .incident, severity: .priority, " +
  'summary: (.incident + " (" + .priority + ", " + .service + ") is " + ' +
  '((.over)|tostring) + " min past its " + ((.budget)|tostring) + "-min resolve budget. " + ' +
  '.summary + " [clock: " + ((.used)|tostring) + " min on the service\\u0027s own SLA clock; ' +
  'raw elapsed would read " + ((.naive)|tostring) + "]"), ' +
  "escalation_target: .esc}]') | first }}";


/**
 * One ticket per at-risk incident. `normal`, not `urgent`: these have time left,
 * and marking everything urgent is how a queue stops meaning anything.
 * Reads `triage` — the tickets array it projects beside pages (see above).
 */
const RISK_PARAMS_EXPR =
  "{{ json(outputs.triage.value) " +
  "| jq('[.tickets[] | " +
  '{title: (.incident + " at " + ((.pct)|tostring) + "% of SLA budget — " + .service), ' +
  'description: (.summary + "\\n\\nUsed " + ((.used)|tostring) + " of " + ' +
  '((.budget)|tostring) + " minutes on this service\\u0027s own SLA clock (business hours and ' +
  'paused time already excluded). It has NOT breached."), ' +
  'priority: "normal", assignee: .to, labels: [.team, .priority]}]' +
  "') | first }}";

/**
 * The all-clear digest, and it names who is carrying the pager.
 *
 * ⚠ IT ALSO NAMES THE TEAMS WITH NOBODY ON CALL, which is the point. Workplace
 * IT has no out-of-hours rota — a business-hours helpdesk does not — and
 * `oncall_roster_rows` keeps every team on a null shift rather than dropping
 * the team from the result. A digest that listed only the covered teams would
 * read as full coverage.
 */
const DIGEST_PARAMS_EXPR =
  "{{ json(outputs.oncall.body).results[0].data " +
  "| jq('[{channel: \"#it-incidents\", author: \"foundry-automation\", " +
  'text: ("All clear: no incident has breached its SLA budget and none is at risk. ' +
  'Clocks honour each service\\u0027s business hours and exclude time awaiting the customer.' +
  '\\n\\nOn call: " + ' +
  // Nobody on call is a null `oncall_person`; the escalation address a team
  // without one falls back to is `team_escalation // org_escalation`.
  '([.[] | select(.oncall_person != null) | (.team_code + " — " + .oncall_person)] | join("; ")) + ' +
  '(if ([.[] | select(.oncall_person == null)] | length) > 0 then ' +
  '"\\n\\nNo rota: " + ([.[] | select(.oncall_person == null) | .team_code] | join(", ")) + ' +
  '" — incidents for these teams escalate to their listed address rather than waking anybody." ' +
  'else "" end))}]' +
  "') | first }}";

/**
 * ⚠ THE CHAIN, AND WHY IT IS A CHAIN.
 *
 * The three arms are alternative answers to ONE question — *how loudly does this
 * run escalate?* — so exactly one must fire:
 *
 *     anything breached      wake the on-call. The estate needs a person now.
 *     nothing breached, some at risk   ticket the teams. It needs attention today.
 *     neither                          digest. It is fine; here is the record.
 *
 * ⚠ THE COST IS STATED RATHER THAN HIDDEN: when something HAS breached, no
 * ticket is raised for the at-risk incidents. That is deliberate — the at-risk
 * list is not lost, it is in the page's own summary, so the person being woken
 * sees what else is close. What is chosen once is the ACTION, not the
 * information. If a deployment wants both, that is two independent guards, and
 * flow 2 below is what that looks like.
 *
 * ⚠ `length > 0` is evaluated on the SHAPING TRANSFORM's rows, not on the raw
 * operation rows: one `incident_sla_rows` read feeds both arms, so each guard
 * reads the same projection its arm will act on — `.pages` for the page arm,
 * `.tickets` for the ticket arm. A guard selecting its own subset would be a
 * second copy of the band predicate, free to disagree with the arm. The
 * terminal arm carries NO condition — that absence is what makes it the
 * catch-all.
 */
export const ITOPS_SLA_TRIAGE: FlowModel = {
  id: "itops-sla-triage",
  inputs: [{ id: "as_of", type: "STRING", defaults: DEFAULT_AS_OF }],
  steps: [
    /**
     * One read feeds both arms. `incident_sla_rows` returns every open
     * incident with its elapsed minutes and resolve budget; the breach and
     * at-risk bands are selected in the two shaping transforms below, each of
     * which the corresponding guard reads back.
     */
    {
      id: "incidents",
      kind: "query",
      ref: "itops_demo.incident_sla_rows",
      paramsExpr: '[{ "as_of": "{{ inputs.as_of }}", "fallback_key": "escalation_fallback_email" }]',
    },
    {
      id: "oncall",
      kind: "query",
      ref: "itops_demo.oncall_roster_rows",
      paramsExpr: '[{ "as_of": "{{ inputs.as_of }}", "fallback_key": "escalation_fallback_email" }]',
    },

    // ── arm 1: something has breached ─────────────────────────────────────
    // The shaping transform runs BEFORE the guard it feeds, so the guard and
    // the page read the same rows. `triage` is top-level; `page` names `wake`
    // explicitly to stay inside the arm.
    { id: "triage", kind: "transform", expr: PAGE_SHAPE_EXPR, dependsOn: ["incidents"] },
    {
      id: "wake",
      kind: "branch",
      name: "Anything breached?",
      conditionExpr: "{{ json(outputs.triage.value) | jq('.pages | length > 0') | first }}",
      /**
       * ⚠ **A step that READS another step's output must DEPEND on it**, and
       * this chain declared none of it. Every guard and projection here reaches
       * into `incidents`, `triage`, `atrisk_shape` or `oncall` by expression while declaring no
       * `dependsOn` at all — so the engine ran it correctly (tasks are emitted
       * in order) and the CANVAS drew four disconnected clusters, which reads
       * as four unrelated automations rather than one triage chain.
       *
       * The picture is not decoration: `dependsOn` is the only topology the
       * canvas has, so an undeclared read is an invisible link. Declaring it
       * costs nothing at runtime and is the truth about what this step needs.
       */
      dependsOn: ["triage"],
    },
    {
      id: "page",
      kind: "tool",
      ref: "page_oncall",
      paramsExpr: PAGE_PARAMS_EXPR,
      dependsOn: ["triage", "wake"],
      timeoutSeconds: 120,
      /**
       * ⚠ RETRY IS SAFE HERE ONLY BECAUSE THE SERVICE DEDUPLICATES.
       *
       * `stepExecutionService.tool` throws only when EVERY item failed, so
       * "2 of 3 paged, retry pages all 3 again" cannot silently double-page:
       * the paging service suppresses the repeat on `dedupe_key`. Without that
       * suppression a retry here would ring somebody's phone twice, and this
       * would be the wrong step to put a retry on.
       */
      retry: { maxAttempts: 3, backoff: "exponential", intervalSeconds: 5 },
    },

    // ── arm 2: nothing breached, but something is close ──────────────────
    // No second shape: `triage` projects the tickets array beside pages (see
    // PAGE_SHAPE_EXPR), so this guard reads it — downstream of the same edge
    // as `wake`, with no race and no duplicated arithmetic.
    {
      id: "queue",
      kind: "branch",
      name: "Anything at risk?",
      elseOf: "wake",
      conditionExpr: "{{ json(outputs.triage.value) | jq('.tickets | length > 0') | first }}",
    },
    {
      id: "ticket",
      kind: "tool",
      ref: "ticket_create",
      paramsExpr: RISK_PARAMS_EXPR,
      dependsOn: ["queue", "triage"],
      timeoutSeconds: 60,
    },

    // ── arm 3: all clear ─────────────────────────────────────────────────
    // ⚠ NO condition. That absence is what makes it the catch-all; a freshly
    // added unconfigured arm carries an empty condition instead, which is why
    // the compiler tests for the KEY and not for falsiness.
    { id: "quiet", kind: "branch", name: "Otherwise", elseOf: "queue" },
    {
      id: "digest",
      kind: "tool",
      ref: "chat_post_message",
      paramsExpr: DIGEST_PARAMS_EXPR,
      // Reads `oncall`; see `wake`'s note on undeclared reads.
      dependsOn: ["quiet", "oncall"],
      timeoutSeconds: 60,
    },
  ],
  /**
   * Every 15 minutes. The cron lives on the MODEL (D-18) — Foundry refuses a
   * `schedule` trigger row for a flow, because that would be a second way to
   * fire it on a timer that no approval covers.
   *
   * ⚠ A 15-MINUTE SCHEDULE IS ONLY DEFENSIBLE BECAUSE OF THE DEDUPLICATION. On a
   * paging service without it, this cron pages the same person four times an
   * hour for one unresolved incident.
   */
  schedule: { cron: "*/15 * * * *", timezone: "UTC" },
};

// ═══════════════════════════════════════════════════════════════════════════
// 2. Vulnerability remediation — TWO GUARDS, deliberately not a chain
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Split the actionable findings into what can proceed and what a freeze defers,
 * preserving the KEV-first order the query returned.
 *
 * ⚠ THE ORDER COMES FROM THE QUERY AND MUST NOT BE RE-SORTED HERE. A
 * known-exploited `medium` outranks a `high` that nobody is attacking, and a
 * `low` under active exploitation outranks two criticals that are not. Anything
 * here that reached for `severity` would bury the one finding that matters
 * underneath nine that do not — which is the natural thing to write, and is why
 * the ordering is in SQL where it is written once.
 *
 * ⚠ `stale` is CARRIED, not filtered on. A host nobody has heard from in
 * longer than the staleness window may have been patched or may be gone; its
 * findings cannot be trusted either way. Dropping those rows hides real
 * exposure and keeping them unmarked creates a queue nobody can clear, so the
 * flag travels and the ticket says so. The operation carries `age_days`
 * against a TEXT `stale_limit_days`, so the comparison parses the limit here.
 */
const VULN_SPLIT_EXPR =
  `{{ ${rows("vulns")} ` +
  "| jq('{proceed: [.[] | select(.deferred_until == null) | " +
  "{cve: .cve, host: .hostname, sev: .severity, kev: .kev, team: .team_code, " +
  "to: .notify_email, stale: (.age_days > (.stale_limit_days|tonumber)), title: .title}], " +
  "deferred: [.[] | select(.deferred_until != null) | " +
  "{cve: .cve, host: .hostname, sev: .severity, kev: .kev, team: .team_code, " +
  'to: .notify_email, until: (.deferred_until | tostring | split("T")[0]), ' +
  "freeze: .blocked_by_freeze, title: .title}]}') " +
  "| first }}";

/** One ticket per finding that can be applied now, KEV first. */
const PATCH_PARAMS_EXPR =
  "{{ json(outputs.split.value) " +
  "| jq('[.proceed[] | " +
  '{title: ((if .kev then "[EXPLOITED] " else "" end) + .cve + " on " + .host + " — " + .sev), ' +
  'description: (.title + "\\n\\nA fix is available and no change freeze applies." + ' +
  '(if .kev then "\\n\\nThis CVE is KNOWN-EXPLOITED. It outranks higher-severity findings that ' +
  'are not being attacked." else "" end) + ' +
  '(if .stale then "\\n\\n⚠ This host has not been seen for longer than the staleness window. ' +
  'Reconcile it before patching — the finding may already be fixed, or the host may be gone." ' +
  'else "" end)), ' +
  'priority: (if .kev then "urgent" else "high" end), assignee: .to, ' +
  "labels: [.team, .sev, (if .kev then \"kev\" else \"no-kev\" end)]}]') | first }}";

/**
 * ONE announcement listing everything the freeze defers, with the instant it
 * lifts.
 *
 * ⚠ A FREEZE DEFERS; IT NEVER CANCELS. Dropping this work is silent and looks
 * exactly like there having been nothing to do — so the deferral is announced,
 * the list is in the message, and the date it resumes is in the subject.
 */
const DEFER_PARAMS_EXPR =
  "{{ json(outputs.split.value) " +
  "| jq('[{sender: \"" + SENDER + "\", " +
  "recipients: ([.deferred[] | .to] | unique), " +
  'template: "freeze_deferral_notice", ' +
  "variables: {count: (.deferred | length | tostring), " +
  'freeze_name: (.deferred[0].freeze // "a change freeze"), ' +
  'resume_at: (.deferred[0].until // "the end of the freeze"), ' +
  'detail: ([.deferred[] | ((if .kev then "[EXPLOITED] " else "" end) + .cve + " on " + ' +
  '.host + " (" + .sev + ")")] | join("\\n"))}}]' +
  "') | first }}";

/**
 * ⚠ TWO INDEPENDENT GUARDS, AND NOT A CHAIN. READ THIS BEFORE "TIDYING" IT.
 *
 * `deferred` and `proceed` are DISJOINT SETS OF WORK, not alternative answers.
 * Both can be non-empty in the same run: at the middle as-of instant a freeze
 * scoped to Payments defers four findings while eleven elsewhere proceed. An
 * `elseOf` chain here would announce the four and never raise the eleven
 * tickets — the YAML compiles, the run goes green, and a batch of patches
 * nobody was told about waits for a freeze that has already lifted.
 *
 * `itops-flows.test.ts` asserts that NEITHER branch here carries `elseOf`, with
 * the reason in the assertion message, because this is the one place in the
 * repository where the newer feature is the wrong answer.
 */
export const ITOPS_VULN_REMEDIATION: FlowModel = {
  id: "itops-vuln-remediation",
  inputs: [{ id: "as_of", type: "STRING", defaults: DEFAULT_AS_OF }],
  steps: [
    {
      id: "vulns",
      kind: "query",
      ref: "itops_demo.vuln_finding_rows",
      paramsExpr: '[{ "as_of": "{{ inputs.as_of }}", "stale_key": "stale_asset_days", "missing_state": "missing", "prod_env": "prod", "fix_present": true }]',
    },
    { id: "split", kind: "transform", expr: VULN_SPLIT_EXPR, dependsOn: ["vulns"] },

    // ── guard A: work that can proceed ───────────────────────────────────
    {
      id: "any_now",
      kind: "branch",
      name: "Anything to patch now?",
      conditionExpr: "{{ json(outputs.split.value) | jq('.proceed | length > 0') | first }}",
      dependsOn: ["split"],
    },
    {
      id: "patch_tickets",
      kind: "tool",
      ref: "ticket_create",
      paramsExpr: PATCH_PARAMS_EXPR,
      dependsOn: ["any_now"],
      timeoutSeconds: 120,
    },

    // ── guard B: work a freeze defers. INDEPENDENT of guard A. ───────────
    {
      id: "any_frozen",
      kind: "branch",
      name: "Anything deferred by a freeze?",
      conditionExpr: "{{ json(outputs.split.value) | jq('.deferred | length > 0') | first }}",
      dependsOn: ["split"],
    },
    {
      id: "announce",
      kind: "tool",
      ref: "mail_send_template",
      paramsExpr: DEFER_PARAMS_EXPR,
      dependsOn: ["any_frozen"],
      timeoutSeconds: 60,
    },
  ],
  /** Daily at 06:00, before the working day, so the queue is ready. */
  schedule: { cron: "0 6 * * *", timezone: "UTC" },
};

export type ScenarioSpec = {
  model: FlowModel;
  name: string;
  description: string;
  /** Left unapproved on purpose, and why — rendered by the seed. */
  unapprovedBecause?: string;
};

export const ITOPS_SCENARIOS: ScenarioSpec[] = [
  {
    model: ITOPS_SLA_TRIAGE,
    name: "SLA triage — page, ticket or digest",
    description:
      "Every 15 minutes: page the on-call for anything that has breached its SLA budget, or " +
      "ticket the owning teams for anything at risk, or post an all-clear digest. Exactly one " +
      "of the three, because they are alternative answers to one question. The SLA clock " +
      "honours each service's business hours and excludes time awaiting the customer — the " +
      "compiled operation owns that arithmetic, so no step here subtracts timestamps. Repeat pages for the same " +
      "incident are suppressed by the paging service, which is what makes a 15-minute schedule " +
      "safe rather than a way to ring somebody's phone four times an hour.",
  },
  {
    model: ITOPS_VULN_REMEDIATION,
    name: "Vulnerability remediation, freeze-aware",
    description:
      "Daily: raise a ticket for every missing patch on a production host where a fix exists, " +
      "known-exploited findings first, and separately announce anything a change freeze has " +
      "deferred. TWO INDEPENDENT GUARDS rather than a chain, because both sets of work can be " +
      "non-empty at once — a chain would announce the deferrals and never raise the tickets " +
      "for the work that could have proceeded. Excludes non-production hosts (a critical on a " +
      "sandbox is not a page) and findings with no fix available.",
  },
];

export const ITOPS_FLOWS: FlowModel[] = ITOPS_SCENARIOS.map((s) => s.model);
