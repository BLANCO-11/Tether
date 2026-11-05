import type { FlowModel } from "../services/flow-compiler.service.js";
import type { StepContract } from "../services/step-contract.service.js";

/**
 * The flow Phase 6's exit criterion travels. phase-6.md 6.2/6.3
 *
 * `hr-screening.model.ts` cannot be it, for a reason worth stating: it has **no
 * `code` step.** 08 §10's exit criterion is *"export a flow, import it into
 * `hr_demo_alt`, **regenerate its code steps**, and assert it produces the alt
 * oracle's answer"* — and a flow with nothing to regenerate satisfies that
 * sentence vacuously. It would prove that a `datasource` ref can be remapped,
 * which is true and is not the claim.
 *
 * So this is the screening flow with one `code` step added, and the step is
 * chosen to sit exactly where the two datasets disagree.
 *
 * ── Why `worst_shortfall` is the number that matters ─────────────────────────
 *
 * `hr_demo` expresses attendance as a PERCENTAGE (0–100); `hr_demo_alt`
 * expresses it as a FRACTION (0–1). A count of flagged rows is identical either
 * way — the comparison is rate-vs-threshold and both sides scale together — so a
 * flow that only counted would pass against both datasets and detect nothing.
 *
 * A shortfall does not scale away. `85 − 62.5 = 22.5` becomes `0.85 − 0.625 =
 * 0.225`, and **0.225 is a perfectly plausible-looking answer**: no exception, no
 * empty result, no failed step. It is the exact failure class this migration
 * exists to remove, reproduced deliberately so the harness can be shown to catch
 * it. See `alt-screening.queries.ts`.
 *
 * ── The contract carries the unit, because nothing else can ──────────────────
 *
 * A fragment sees its contract and nothing else (assertion 18) — no manifest, no
 * schema, no sibling. So `0-100` in the input field's description is the ONLY
 * place a travelling recipe can state its units, and the importing tenant's
 * query is the only place they can be satisfied. That division is Phase 6's
 * finding in one line.
 */

export const PORTABLE_RANK_CONTRACT: Omit<StepContract, "stepId"> = {
  purpose:
    "count the flagged rows and report the largest shortfall below the policy minimum",
  input: [
    {
      name: "rows",
      type: "array",
      items: "object",
      description:
        "each row has attendance_rate and min_attendance_rate, both PERCENTAGES in 0-100",
    },
  ],
  output: [
    { name: "flagged_count", type: "number" },
    {
      name: "worst_shortfall",
      type: "number",
      description: "largest (min_attendance_rate - attendance_rate), in percentage points",
    },
  ],
};

/**
 * `paramsExpr` for `notify`.
 *
 * Both I-11 traps are in here, exactly as in `hr-screening.model.ts`: `~` rather
 * than a nested `{{ }}` inside a filter argument, and `| first` to unwrap the jq
 * string. Kept identical so that if the compiler ever regresses on either, this
 * flow fails in the same place the Phase 3 one does.
 */
const SENDER = "hr-bot@acme-hr.example";
const NOTIFY_PARAMS_EXPR =
  "{{ json(outputs.screen.body).results[0].data " +
  `| jq('[.[] | select(.work_email != null) | {sender: "${SENDER}", recipients: [.work_email], ` +
  'subject: ("Attendance below policy — " + .department_code), ' +
  'body: ("Hi " + .full_name + ", your attendance was " + (.attendance_rate|tostring) + ' +
  '" against a policy minimum of " + (.min_attendance_rate|tostring) + ".")}]\') ' +
  "| first }}";

/**
 * `code` is the placeholder rather than a real fragment.
 *
 * The model is only ever used to CREATE the origin flow, and creating it goes
 * through generation — so writing a body here would mean the exported bundle's
 * contract and the origin's code came from different authors, and "the fragment
 * refitted" would be untestable because there was never a first fitting.
 * `flowCompiler` rejects this placeholder by name (assertion 30), so it cannot
 * reach Kestra by accident.
 */
export const PORTABLE_SCREENING_MODEL: FlowModel = {
  id: "hr-screening-portable",
  inputs: [{ id: "period", type: "STRING", required: true }],
  steps: [
    {
      id: "screen",
      kind: "datasource",
      // The ONE ref that has to be remapped on import. Deliberately one: the
      // remapping mechanism is the same for N, and a single mapping keeps the
      // harness output readable.
      ref: "hr_demo.attendance_below_threshold",
      paramsExpr: '[{ "period": "{{ inputs.period }}" }]',
    },
    {
      id: "rank",
      kind: "code",
      code: "needs_regeneration",
      inputExpr: '{"rows": {{ json(outputs.screen.body).results[0].data }}}',
      outputKeys: ["flagged_count", "worst_shortfall"],
      dependsOn: ["screen"],
    },
    {
      id: "notify",
      kind: "tool",
      ref: "mail_send",
      paramsExpr: NOTIFY_PARAMS_EXPR,
      dependsOn: ["rank"],
      timeoutSeconds: 120,
    },
  ],
};
