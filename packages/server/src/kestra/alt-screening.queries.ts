import type { NamedQuerySpec } from "../services/datasource-query.service.js";

/**
 * The **importing tenant's** named queries — `hr_demo_alt`, schema `hr`.
 * phase-6.md 6.3 · 04 §5.2
 *
 * These are the concrete form of Phase 6's central claim: **a flow travels, and
 * the schema coupling stays behind.** The origin flow selects from
 * `attendance_monthly` where rates are percentages; here the same shape comes
 * from a view where rates are fractions, off a composite-key rollup, with every
 * column named differently. None of that reaches the flow — the flow names a
 * query, and the query is written and reviewed by whoever owns this tenant.
 *
 * ── Two variants, and the second one is a NEGATIVE CONTROL ────────────────────
 *
 * They differ in exactly one respect: whether the rate is converted to the
 * percentage the travelling step CONTRACT declares. Everything else — the
 * signature, the column names, the row set — is identical.
 *
 *   presence_below_policy       ×100. Matches the contract. The correct config.
 *   presence_below_policy_raw   the alt's native 0–1 fraction. Wrong, silently.
 *
 * The `_raw` variant is not a mistake left in by accident; it is the measurement.
 * `refInterfaces` compares call signatures, so both variants pass import
 * validation identically and with no findings — which is the honest limit of what
 * an import can check (`flow-portability.service.ts`). Running both and scoring
 * against the alt oracle is what shows the difference, and it shows it as a
 * plausible number rather than an error: a shortfall of `0.2250` where the truth
 * is `22.50`.
 *
 * Without the control, `kestra:phase6` proving the positive case would be
 * indistinguishable from a harness that cannot detect a wrong answer at all.
 *
 * ⚠ Deliberately kept OUT of `src/demo/` — `demo:verify` and `demo:rehearse` are
 * the regression net and their files are not to be edited.
 */

/**
 * `hr.presence_vs_policy` already resolves the unit override against the org
 * default (the alt dataset's equivalent of the COALESCE trap), so neither variant
 * hand-writes that join. The comparison stays in FRACTIONS in the WHERE clause —
 * both sides are the view's native units there — and only the SELECT list
 * converts. Converting before comparing would work too and would obscure which
 * conversion is the variable.
 */
const BODY = (rateExpr: string, minExpr: string) => `
      SELECT
        p.staff_id                        AS employee_id,
        s.full_name,
        s.work_mailbox                    AS work_email,
        u.unit_code                       AS department_code,
        ${rateExpr}                       AS attendance_rate,
        ${minExpr}                        AS min_attendance_rate
      FROM hr.presence_vs_policy p
      JOIN hr.staff s      ON s.id = p.staff_id
      JOIN hr.org_units u  ON u.id = s.unit_id
      WHERE p.period = $1
        AND s.state = 'working'
        AND p.presence_rate < p.min_rate
      ORDER BY p.staff_id
    `.trim();

const PARAMS = {
  paramOrder: ["period"],
  paramsSchema: {
    period: { type: "string", required: true, description: "Reporting period, YYYY-MM" },
  },
};

export const ALT_SCREENING_QUERIES: NamedQuerySpec[] = [
  {
    name: "presence_below_policy",
    description:
      "Staff whose presence in the given period is below their unit's policy minimum, with the " +
      "unit override already resolved against the org default. Excludes anyone not currently " +
      "working. attendance_rate and min_attendance_rate are PERCENTAGES (0-100), converted from " +
      "this schema's native 0-1 fractions so they match the shared contract.",
    sqlText: BODY("(p.presence_rate * 100)::float8", "(p.min_rate * 100)::float8"),
    ...PARAMS,
  },
  {
    /**
     * The negative control. Identical in every respect except the missing ×100.
     *
     * A tenant would write this by taking the columns at face value — which is
     * exactly the mistake, and exactly the one no signature check can catch.
     */
    name: "presence_below_policy_raw",
    description:
      "IDENTICAL to presence_below_policy except that the rates are left in this schema's native " +
      "0-1 FRACTIONS. Used only by kestra:phase6 as a negative control: it satisfies the same " +
      "call signature, imports with no findings, and computes a wrong answer.",
    sqlText: BODY("p.presence_rate::float8", "p.min_rate::float8"),
    ...PARAMS,
  },
];
