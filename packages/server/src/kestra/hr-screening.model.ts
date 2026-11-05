import type { FlowModel } from "../services/flow-compiler.service.js";

/**
 * Phase 1's screening flow, expressed as a MODEL rather than as YAML.
 * archive/kestra-migration/progress/phase-3.md
 *
 * This file is the compiler's falsification test. `hr-screening.flow.yml` is
 * hand-written and scores 3-of-3 against the oracle; if `flow-compiler.service.ts`
 * is a faithful emitter then compiling THIS produces a flow that scores the same.
 * `pnpm kestra:phase3` runs exactly that comparison, reusing `expectedScreening`
 * — the oracle written independently of both.
 *
 * Reconstructing it by hand is deliberate. Generating the model from the YAML
 * would test that the compiler agrees with a parser I also wrote; writing it out
 * and scoring the RESULT tests that it agrees with the dataset.
 *
 * ── The expressions are single-line on purpose ───────────────────────────────
 *
 * Pebble does not re-evaluate `{{ }}` inside a filter argument, and `| first`
 * unwraps a jq string into a raw string (ISSUES.md I-11). Both traps are in
 * `notify` below. Keeping each expression on one line also keeps the emitted
 * block scalar trivially comparable to the hand-written flow's.
 */

const SENDER = "hr-bot@acme-hr.example";

/** Split the flagged list into mailable and unmailable — a pure reshape, no credential (R2). */
const PARTITION_EXPR =
  "{{ json(outputs.screen.body).results[0].data " +
  "| jq('{mailable: [.[] | select(.work_email != null)], unmailable: [.[] | select(.work_email == null)]}') " +
  "| first }}";

/**
 * ONE taskrun for N emails (M1).
 *
 * Not a `ForEach`: each item would be its own taskrun, i.e. a database row and a
 * node in the step graph. A bouncing recipient comes back as a per-item result,
 * not a step failure — partial failure is a warning by design.
 */
const NOTIFY_PARAMS_EXPR =
  "{{ json(outputs.partition.value).mailable " +
  `| jq('[.[] | {sender: "${SENDER}", recipients: [.work_email], ` +
  'subject: ("Attendance below policy — " + .department_code), ' +
  'body: ("Hi " + .full_name + ", your attendance was " + (.attendance_rate|tostring) + ' +
  '"% against a policy minimum of " + (.min_attendance_rate|tostring) + "%.")}]\') ' +
  "| first }}";

export const HR_SCREENING_MODEL: FlowModel = {
  id: "hr-screening-compiled",
  // `period` is a declared INPUT. The worst measured failure — a script that
  // hardcoded period="2023-10" and emailed 0 of 11 — is not less likely here, it
  // is inexpressible: there is no literal to hardcode.
  inputs: [{ id: "period", type: "STRING", defaults: "2026-06" }],
  steps: [
    // The threshold arrives from a named query with the COALESCE pre-written, so
    // the "missing COALESCE to a policy default" failure cannot occur either.
    {
      id: "fetch_policy",
      kind: "datasource",
      ref: "hr_demo.policy_thresholds",
      paramsExpr: "[{}]",
    },
    {
      id: "screen",
      kind: "datasource",
      ref: "hr_demo.attendance_below_threshold",
      paramsExpr: '[{ "period": "{{ inputs.period }}" }]',
    },
    // Reported, never emailed.
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
   * What a person READS off a run: the policy it screened against and the people
   * it deliberately did not email. Declared as the flow's result (phase 7): a
   * canvas-authored flow's final stage refuses a data step nothing reads
   * (`unused_step`), and these two are read — by a person, from the result, not
   * by a later step. Not emitted and not in `structureHash`, so phase 3's oracle
   * scoring and the compiled YAML are unchanged.
   */
  output: {
    // The legacy single-step form rides beside the rows: the drafted-response
    // shape still requires it.
    stepId: "excluded",
    rows: [
      { name: "policy", type: "any", source: { from: "whole", stepId: "fetch_policy" } },
      { name: "excluded", type: "any", source: { from: "whole", stepId: "excluded" } },
    ],
  },
  /**
   * A cron the flow does not need in order to be correct, and that Phase 3 is
   * entirely about. It is emitted ONLY into the live namespace and ONLY for an
   * approved revision — 06:00 every Monday, far enough away that a verification
   * run never actually fires it.
   */
  schedule: { cron: "0 6 * * 1", timezone: "Europe/London" },
};
