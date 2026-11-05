/**
 * GENERATED HR readers — 2026-09-09.
 *
 * The five reads `hr_demo` needs, proposed by `POST …/queries/propose` and frozen after FULL-ROW comparison (2026-09-09). Installed under the ORIGINAL refs by `showcase/seed.ts` and `kestra/phase1-prove.ts`.
 */

export interface GeneratedQuerySeed {
  name: string;
  description: string;
  sqlText: string;
  paramOrder: string[];
  paramsSchema: Record<string, { type: string; required: boolean; format?: "date" | "month"; description: string }>;
  need: string;
  verifiedSets: string[];
}

export const HR_GENERATED_QUERIES: GeneratedQuerySeed[] = [

  {
    need: `Below-threshold read with COALESCE dept/org threshold, percentages, exited/on_leave exclusion, bpchar cast, float8 casts.`,
    name: "attendance_below_threshold",
    description:
      "Employees below threshold — GENERATED, 11 rows identical at 2026-06 (2026-09-09).",
    sqlText: `
SELECT e.id AS employee_id, e.full_name AS full_name, e.work_email AS work_email, d.code AS department_code, am.attendance_rate::float8 AS attendance_rate, COALESCE(dept_policy.min_attendance_rate, org_policy.min_attendance_rate)::float8 AS min_attendance_rate FROM public.employees e JOIN public.attendance_monthly am ON am.employee_id = e.id LEFT JOIN public.departments d ON d.id = e.department_id LEFT JOIN LATERAL (SELECT pt.min_attendance_rate FROM public.policy_thresholds pt WHERE pt.department_id = d.id AND pt.effective_from <= to_date($1, 'YYYY-MM') ORDER BY pt.effective_from DESC, pt.id DESC LIMIT 1) dept_policy ON true LEFT JOIN LATERAL (SELECT pt.min_attendance_rate FROM public.policy_thresholds pt WHERE pt.department_id IS NULL AND pt.effective_from <= to_date($1, 'YYYY-MM') ORDER BY pt.effective_from DESC, pt.id DESC LIMIT 1) org_policy ON true WHERE am.period::bpchar = $1::bpchar AND e.status NOT IN ('exited', 'on_leave') AND am.attendance_rate < COALESCE(dept_policy.min_attendance_rate, org_policy.min_attendance_rate) ORDER BY e.id
    `.trim(),
    paramOrder: ["period"],
    paramsSchema: {
      period: { type: "string", required: true, format: "month", description: "The attendance period in YYYY-MM format." }
    },
    verifiedSets: ["2026-06:11 rows"],
  },
  {
    need: `Unreachable read with bounce-domain fact and letter-exact reasons; verified full-row identical.`,
    name: "flagged_unreachable",
    description:
      "Unreachable flagged employees — GENERATED, 2 rows identical (2026-09-09).",
    sqlText: `
SELECT e.id AS employee_id, e.full_name AS full_name, e.work_email AS work_email, d.code AS department_code, m.attendance_rate::float8 AS attendance_rate, CASE WHEN e.work_email IS NULL THEN 'no work email on record' ELSE 'address hard-bounces' END AS unreachable_reason FROM employees e JOIN attendance_monthly m ON m.employee_id = e.id LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN LATERAL (SELECT pt.min_attendance_rate FROM policy_thresholds pt WHERE pt.department_id = e.department_id AND pt.effective_from <= ($1 || '-01')::date ORDER BY pt.effective_from DESC, pt.id DESC LIMIT 1) dept_policy ON true LEFT JOIN LATERAL (SELECT pt.min_attendance_rate FROM policy_thresholds pt WHERE pt.department_id IS NULL AND pt.effective_from <= ($1 || '-01')::date ORDER BY pt.effective_from DESC, pt.id DESC LIMIT 1) org_policy ON true WHERE m.period = $1::bpchar AND m.attendance_rate < COALESCE(dept_policy.min_attendance_rate, org_policy.min_attendance_rate) AND e.status NOT IN ('exited', 'on_leave') AND (e.exit_date IS NULL OR e.exit_date > ($1 || '-01')::date) AND (e.work_email IS NULL OR e.work_email LIKE '%@acme-hr-bounce.example') ORDER BY e.id
    `.trim(),
    paramOrder: ["period"],
    paramsSchema: {
      period: { type: "string", required: true, format: "month", description: "The attendance period in YYYY-MM format." }
    },
    verifiedSets: [],
  },
  {
    need: `Rollup with FILTER breach counts, max() threshold, exclusions, float8 casts; verified full-row identical.`,
    name: "department_attendance_rollup",
    description:
      "Department rollup — GENERATED, 6 rows identical (2026-09-09).",
    sqlText: `
WITH scoped_attendance AS (
    SELECT
        d.code AS department_code,
        d.name AS department_name,
        am.employee_id,
        am.attendance_rate,
        threshold_values.min_attendance_rate
    FROM public.attendance_monthly am
    JOIN public.employees e
        ON e.id = am.employee_id
    JOIN public.departments d
        ON d.id = e.department_id
    LEFT JOIN LATERAL (
        SELECT COALESCE(
            (
                SELECT p.min_attendance_rate
                FROM public.policy_thresholds p
                WHERE p.department_id = e.department_id
                  AND p.effective_from <= to_date($1, 'YYYY-MM')
                ORDER BY p.effective_from DESC, p.id DESC
                LIMIT 1
            ),
            (
                SELECT p.min_attendance_rate
                FROM public.policy_thresholds p
                WHERE p.department_id IS NULL
                  AND p.effective_from <= to_date($1, 'YYYY-MM')
                ORDER BY p.effective_from DESC, p.id DESC
                LIMIT 1
            )
        ) AS min_attendance_rate
    ) threshold_values ON TRUE
    WHERE am.period = $1::bpchar
      AND e.status NOT IN ('exited', 'on_leave')
)
SELECT
    department_code,
    department_name,
    COUNT(DISTINCT employee_id)::int AS employees_with_data,
    COUNT(*) FILTER (WHERE attendance_rate < min_attendance_rate)::int AS below_threshold_count,
    round(avg(attendance_rate), 2)::float8 AS mean_attendance_rate,
    min(attendance_rate)::float8 AS worst_attendance_rate,
    max(min_attendance_rate)::float8 AS min_attendance_rate
FROM scoped_attendance
GROUP BY department_code, department_name
ORDER BY department_code
    `.trim(),
    paramOrder: ["period"],
    paramsSchema: {
      period: { type: "string", required: true, format: "month", description: "The attendance period in YYYY-MM format." }
    },
    verifiedSets: [],
  },
  {
    need: `Excluded read with letter-exact reasons (space, no colon); verified full-row identical.`,
    name: "attendance_excluded",
    description:
      "Excluded employees — GENERATED, 2 rows identical (2026-09-09).",
    sqlText: `
SELECT e.id AS employee_id, e.full_name AS full_name, e.status AS status, e.exit_date AS exit_date, CASE WHEN e.status = 'exited' THEN 'exited ' || COALESCE(e.exit_date::text, 'unknown date') WHEN e.status = 'on_leave' THEN 'on approved leave' ELSE e.status END AS exclusion_reason FROM public.employees e WHERE e.status IN ('exited', 'on_leave') AND EXISTS (SELECT 1 FROM public.attendance_monthly am WHERE am.employee_id = e.id AND am.period = $1::bpchar) ORDER BY e.id
    `.trim(),
    paramOrder: ["period"],
    paramsSchema: {
      period: { type: "string", required: true, format: "month", description: "The attendance period in YYYY-MM format." }
    },
    verifiedSets: [],
  },
  {
    need: `Threshold list with null-department-first ordering and float8 cast.`,
    name: "policy_thresholds",
    description:
      "Policy thresholds — GENERATED, 2 rows identical (2026-09-09).",
    sqlText: `
SELECT pt.department_id AS department_id, d.code AS department_code, pt.min_attendance_rate::float8 AS min_attendance_rate FROM public.policy_thresholds AS pt LEFT JOIN public.departments AS d ON d.id = pt.department_id ORDER BY pt.department_id NULLS FIRST
    `.trim(),
    paramOrder: [],
    paramsSchema: {},
    verifiedSets: [],
  },
];
