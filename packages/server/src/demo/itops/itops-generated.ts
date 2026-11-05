/**
 * GENERATED IT Operations readers — 2026-09-09.
 *
 * The seven reads `itops_demo` needs, proposed by `POST …/queries/propose`
 * from need statements plus the introspected schema (names + types only) and
 * frozen here after oracle comparison at all four ITOPS_AS_OF instants (see
 * `verify-itops.ts` for the oracle). Names are the ORIGINAL `itops_demo.*`
 * refs so flow seeds keep working unchanged.
 *
 * Review rounds that shaped the needs (kept, because they are the traps):
 * stale dropped a serviceless prod asset (join contract); SLA mixed up the
 * org-fallback key, filtered status=open, and summed uncorrelated pauses;
 * at-risk missed the pause correlation; freeze dropped serviceless assets,
 * guessed state=open, and omitted the fix predicate. Each is a need wording
 * fix, not a SQL edit — regeneration is re-proposal.
 */

export interface GeneratedQuerySeed {
  name: string;
  description: string;
  sqlText: string;
  paramOrder: string[];
  paramsSchema: Record<string, { type: string; required: boolean; description: string }>;
  need: string;
}

export const ITOPS_GENERATED_QUERIES: GeneratedQuerySeed[] = [

  {
    need: `NEED recorded in proposal log 2026-09-09: breached read with full clock/join/pause/escalation contract (business-minutes 9-17 Mon-Fri UTC, tier+priority policy join, null-guarded pauses correlated per incident, org fallback key escalation_fallback_email).`,
    name: "incidents_sla_breached",
    description:
      "Open incidents that have used their whole resolve budget — GENERATED, oracle-matched on membership AND consumed minutes at all 4 as-of instants (2026-09-09).",
    sqlText: `
WITH base AS (SELECT i.id, i.incident_code, i.priority, i.summary, i.opened_at, i.resolved_at, s.service_code, s.name AS service_name, s.tier, s.business_hours_only, t.team_code, t.name AS team_name, t.escalation_email, sp.respond_mins, sp.resolve_mins, LEAST(COALESCE(i.resolved_at, $1), $1) AS window_end FROM public.incidents AS i JOIN public.services AS s ON s.id = i.service_id JOIN public.teams AS t ON t.id = s.owner_team_id JOIN public.sla_policies AS sp ON sp.tier = s.tier AND sp.priority = i.priority WHERE i.opened_at <= $1 AND (i.resolved_at IS NULL OR i.resolved_at > $1)), elapsed AS (SELECT b.*, GREATEST(FLOOR(EXTRACT(EPOCH FROM (b.window_end - b.opened_at)) / 60), 0)::integer AS naive_elapsed_mins, CASE WHEN b.business_hours_only THEN COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (LEAST(b.window_end AT TIME ZONE 'UTC', d.day + time '17:00:00') - GREATEST(b.opened_at AT TIME ZONE 'UTC', d.day + time '09:00:00'))) / 60) FROM generate_series(date_trunc('day', b.opened_at AT TIME ZONE 'UTC'), date_trunc('day', b.window_end AT TIME ZONE 'UTC'), interval '1 day') AS d(day) WHERE EXTRACT(ISODOW FROM d.day) < 6 AND LEAST(b.window_end AT TIME ZONE 'UTC', d.day + time '17:00:00') > GREATEST(b.opened_at AT TIME ZONE 'UTC', d.day + time '09:00:00')), 0) ELSE GREATEST(EXTRACT(EPOCH FROM (b.window_end - b.opened_at)) / 60, 0) END AS elapsed_clock_mins FROM base AS b), pause_values AS (SELECT e.id, p.id AS pause_id, CASE WHEN p.id IS NULL THEN 0 ELSE CASE WHEN e.business_hours_only THEN COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (LEAST(x.pause_end AT TIME ZONE 'UTC', d.day + time '17:00:00') - GREATEST(x.pause_start AT TIME ZONE 'UTC', d.day + time '09:00:00'))) / 60) FROM generate_series(date_trunc('day', x.pause_start AT TIME ZONE 'UTC'), date_trunc('day', x.pause_end AT TIME ZONE 'UTC'), interval '1 day') AS d(day) WHERE EXTRACT(ISODOW FROM d.day) < 6 AND LEAST(x.pause_end AT TIME ZONE 'UTC', d.day + time '17:00:00') > GREATEST(x.pause_start AT TIME ZONE 'UTC', d.day + time '09:00:00')), 0) ELSE GREATEST(EXTRACT(EPOCH FROM (x.pause_end - x.pause_start)) / 60, 0) END END AS paused_clock_mins FROM elapsed AS e LEFT JOIN public.incident_pauses AS p ON p.incident_id = e.id CROSS JOIN LATERAL (SELECT GREATEST(COALESCE(p.started_at, e.opened_at), e.opened_at) AS pause_start, LEAST(COALESCE(p.ended_at, $1), e.window_end) AS pause_end) AS x), pause_totals AS (SELECT id, COALESCE(SUM(paused_clock_mins), 0) AS paused_clock_mins FROM pause_values GROUP BY id), measures AS (SELECT e.*, FLOOR(e.elapsed_clock_mins)::integer AS elapsed_mins, FLOOR(pt.paused_clock_mins)::integer AS paused_mins, GREATEST(FLOOR(e.elapsed_clock_mins - pt.paused_clock_mins), 0)::integer AS consumed_mins FROM elapsed AS e JOIN pause_totals AS pt ON pt.id = e.id) SELECT m.incident_code, m.service_code, m.service_name, m.tier, m.priority, m.summary, m.team_code, m.team_name, m.respond_mins, m.resolve_mins, m.consumed_mins, m.naive_elapsed_mins, m.paused_mins, m.consumed_mins::numeric / NULLIF(m.resolve_mins, 0) AS fraction_used, COALESCE(NULLIF(m.escalation_email, ''), NULLIF(os.value, '')) AS notify_email, (NULLIF(m.escalation_email, '') IS NULL) AS escalated_via_org_fallback FROM measures AS m LEFT JOIN public.org_settings AS os ON os.key = 'escalation_fallback_email' WHERE m.consumed_mins >= m.resolve_mins ORDER BY fraction_used DESC, m.incident_code
    `.trim(),
    paramOrder: ["as_of"],
    paramsSchema: {
      as_of: { type: "string", required: true, description: "The as-of timestamp in ISO-8601 format with timezone." }
    },
  },
  {
    need: `Same clock contract as breached; threshold consumed >= resolve * org_settings at_risk_fraction, disjoint from breached.`,
    name: "incidents_sla_at_risk",
    description:
      "Open incidents at or past 80% of budget but not over — GENERATED, oracle-matched at all 4 as-of instants (2026-09-09).",
    sqlText: `
WITH incident_windows AS (
    SELECT
        i.id,
        i.incident_code,
        i.summary,
        i.priority,
        i.opened_at AT TIME ZONE 'UTC' AS opened_at_utc,
        LEAST(COALESCE(i.resolved_at, $1::timestamptz), $1::timestamptz) AT TIME ZONE 'UTC' AS window_end_utc,
        s.service_code,
        s.name AS service_name,
        s.tier,
        s.business_hours_only,
        t.team_code,
        t.name AS team_name,
        t.contact_email AS notify_email,
        p.respond_mins,
        p.resolve_mins
    FROM public.incidents i
    JOIN public.services s ON s.id = i.service_id
    JOIN public.teams t ON t.id = s.owner_team_id
    JOIN public.sla_policies p ON p.tier = s.tier AND p.priority = i.priority
    WHERE i.resolved_at IS NULL OR i.resolved_at > $1::timestamptz
),
incident_business_seconds AS (
    SELECT
        w.id,
        COALESCE(SUM(
            GREATEST(
                0,
                EXTRACT(EPOCH FROM
                    LEAST(w.window_end_utc, d.day + INTERVAL '17 hours')
                    - GREATEST(w.opened_at_utc, d.day + INTERVAL '9 hours')
                )
            )
        ), 0) AS business_seconds
    FROM incident_windows w
    LEFT JOIN LATERAL generate_series(
        date_trunc('day', w.opened_at_utc),
        date_trunc('day', w.window_end_utc),
        INTERVAL '1 day'
    ) AS d(day)
        ON w.opened_at_utc < w.window_end_utc
       AND EXTRACT(ISODOW FROM d.day) < 6
    GROUP BY w.id
),
pause_windows AS (
    SELECT
        w.id AS incident_id,
        p.id AS pause_id,
        GREATEST(p.started_at AT TIME ZONE 'UTC', w.opened_at_utc) AS pause_start_utc,
        LEAST(COALESCE(p.ended_at, $1::timestamptz) AT TIME ZONE 'UTC', w.window_end_utc) AS pause_end_utc
    FROM incident_windows w
    JOIN public.incident_pauses p ON p.incident_id = w.id
    WHERE p.started_at IS NOT NULL
),
pause_business_seconds AS (
    SELECT
        p.incident_id,
        COALESCE(SUM(
            GREATEST(
                0,
                EXTRACT(EPOCH FROM
                    LEAST(p.pause_end_utc, d.day + INTERVAL '17 hours')
                    - GREATEST(p.pause_start_utc, d.day + INTERVAL '9 hours')
                )
            )
        ), 0) AS business_seconds
    FROM pause_windows p
    LEFT JOIN LATERAL generate_series(
        date_trunc('day', p.pause_start_utc),
        date_trunc('day', p.pause_end_utc),
        INTERVAL '1 day'
    ) AS d(day)
        ON p.pause_start_utc < p.pause_end_utc
       AND EXTRACT(ISODOW FROM d.day) < 6
    GROUP BY p.incident_id
),
calculated AS (
    SELECT
        w.incident_code,
        w.service_code,
        w.service_name,
        w.tier,
        w.priority,
        w.summary,
        w.team_code,
        w.team_name,
        w.respond_mins,
        w.resolve_mins,
        FLOOR(
            GREATEST(
                0,
                CASE
                    WHEN w.business_hours_only THEN b.business_seconds - COALESCE(pb.business_seconds, 0)
                    ELSE EXTRACT(EPOCH FROM (w.window_end_utc - w.opened_at_utc)) - COALESCE(pb.business_seconds, 0)
                END
            ) / 60
        )::integer AS consumed_mins,
        FLOOR(GREATEST(0, EXTRACT(EPOCH FROM (w.window_end_utc - w.opened_at_utc))) / 60)::integer AS naive_elapsed_mins,
        FLOOR(COALESCE(pb.business_seconds, 0) / 60)::integer AS paused_mins,
        w.notify_email
    FROM incident_windows w
    JOIN incident_business_seconds b ON b.id = w.id
    LEFT JOIN pause_business_seconds pb ON pb.incident_id = w.id
)
SELECT
    c.incident_code,
    c.service_code,
    c.service_name,
    c.tier,
    c.priority,
    c.summary,
    c.team_code,
    c.team_name,
    c.respond_mins,
    c.resolve_mins,
    c.consumed_mins,
    c.naive_elapsed_mins,
    c.paused_mins,
    c.consumed_mins::numeric / NULLIF(c.resolve_mins, 0) AS fraction_used,
    c.notify_email
FROM calculated c
CROSS JOIN (
    SELECT value::numeric AS at_risk_fraction
    FROM public.org_settings
    WHERE key = 'at_risk_fraction'
) setting
WHERE c.consumed_mins >= c.resolve_mins * setting.at_risk_fraction
  AND c.consumed_mins < c.resolve_mins
ORDER BY fraction_used DESC, c.incident_code
    `.trim(),
    paramOrder: ["as_of"],
    paramsSchema: {
      as_of: { type: "string", required: true, description: "The as-of timestamp, including timezone information, used to determine incident openness and clip running windows and pauses." }
    },
  },
  {
    need: `Response-clock read with base-CTE column-carry rule.`,
    name: "incidents_unacknowledged",
    description:
      "Open incidents past their response budget unacknowledged — GENERATED, oracle-matched at all 4 as-of instants (2026-09-09).",
    sqlText: `
WITH base AS (
    SELECT
        i.incident_code,
        s.service_code,
        s.name AS service_name,
        s.tier,
        i.priority,
        i.summary,
        t.team_code,
        t.contact_email AS notify_email,
        i.opened_at,
        p.respond_mins,
        s.business_hours_only,
        i.opened_at AT TIME ZONE 'UTC' AS opened_utc,
        LEAST(COALESCE(i.resolved_at, $1::timestamptz), $1::timestamptz) AT TIME ZONE 'UTC' AS window_end_utc
    FROM public.incidents AS i
    JOIN public.services AS s
      ON s.id = i.service_id
    JOIN public.teams AS t
      ON t.id = s.owner_team_id
    JOIN public.sla_policies AS p
      ON p.tier = s.tier
     AND p.priority = i.priority
    WHERE i.acknowledged_at IS NULL
      AND i.opened_at <= $1::timestamptz
      AND (i.resolved_at IS NULL OR i.resolved_at > $1::timestamptz)
), clocked AS (
    SELECT
        b.*,
        CASE
            WHEN b.business_hours_only THEN
                FLOOR(COALESCE(business.business_seconds, 0) / 60)::integer
            ELSE
                GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (b.window_end_utc - b.opened_utc)) / 60)::integer)
        END AS respond_consumed_mins
    FROM base AS b
    LEFT JOIN LATERAL (
        SELECT SUM(EXTRACT(EPOCH FROM (
            LEAST(b.window_end_utc, d + INTERVAL '17 hours')
            - GREATEST(b.opened_utc, d + INTERVAL '9 hours')
        ))) AS business_seconds
        FROM generate_series(
            date_trunc('day', b.opened_utc),
            date_trunc('day', b.window_end_utc),
            INTERVAL '1 day'
        ) AS d
        WHERE EXTRACT(ISODOW FROM d) < 6
          AND LEAST(b.window_end_utc, d + INTERVAL '17 hours') > GREATEST(b.opened_utc, d + INTERVAL '9 hours')
    ) AS business ON TRUE
)
SELECT
    incident_code,
    service_code,
    service_name,
    tier,
    priority,
    summary,
    team_code,
    notify_email,
    opened_at,
    respond_mins,
    respond_consumed_mins
FROM clocked
WHERE respond_consumed_mins > respond_mins
ORDER BY opened_at, incident_code
    `.trim(),
    paramOrder: ["as_of"],
    paramsSchema: {
      as_of: { type: "string", required: true, description: "The as-of timestamp in ISO-8601 format, used to determine incident openness and clip the response window." }
    },
  },
  {
    need: `Prod missing patches with stated staleness rule and active_freeze CTE naming.`,
    name: "vulns_actionable_prod",
    description:
      "Missing prod patches with fixes — GENERATED, 15/15 rows with KEV ordering and freeze carry (2026-09-09).",
    sqlText: `
SELECT v.cve, v.title, v.severity, v.kev, a.hostname, a.environment, s.service_code, t.team_code, t.contact_email AS notify_email, av.detected_at, (a.last_seen_at IS NULL OR a.last_seen_at < ($1::timestamptz - make_interval(days => stale_settings.value::integer))) AS asset_stale, active_freeze.ends_at AS deferred_until, active_freeze.freeze_code AS blocked_by_freeze FROM public.asset_vulnerabilities av JOIN public.assets a ON a.id = av.asset_id JOIN public.vulnerabilities v ON v.cve = av.cve LEFT JOIN public.services s ON s.id = a.service_id LEFT JOIN public.teams t ON t.id = a.owner_team_id CROSS JOIN public.org_settings stale_settings LEFT JOIN LATERAL (SELECT cf.ends_at, cf.freeze_code FROM public.change_freezes cf WHERE cf.starts_at <= $1::timestamptz AND $1::timestamptz < cf.ends_at AND (cf.service_id = a.service_id OR cf.service_id IS NULL) ORDER BY cf.ends_at, cf.id LIMIT 1) active_freeze ON TRUE WHERE av.state = 'missing' AND a.environment = 'prod' AND v.fix_available = TRUE AND stale_settings.key = 'stale_asset_days' ORDER BY v.kev DESC, CASE WHEN v.severity = 'critical' THEN 1 WHEN v.severity = 'high' THEN 2 WHEN v.severity = 'medium' THEN 3 ELSE 4 END, v.cvss DESC NULLS LAST, v.cve, a.hostname
    `.trim(),
    paramOrder: ["as_of"],
    paramsSchema: {
      as_of: { type: "string", required: true, description: "The timestamp used to evaluate asset staleness and active change freezes, in ISO-8601 format." }
    },
  },
  {
    need: `Freeze subset with asset-owner joins, serviceless retention, state/fix literals.`,
    name: "changes_blocked_by_freeze",
    description:
      "Frozen findings — GENERATED, row-for-row match after review rounds (2026-09-09).",
    sqlText: `
SELECT av.cve AS cve, v.title AS title, v.severity AS severity, v.kev AS kev, a.hostname AS hostname, s.service_code AS service_code, t.team_code AS team_code, t.escalation_email AS notify_email, cf.ends_at AS deferred_until, cf.freeze_code AS blocked_by_freeze FROM public.asset_vulnerabilities AS av JOIN public.assets AS a ON a.id = av.asset_id JOIN public.vulnerabilities AS v ON v.cve = av.cve JOIN public.teams AS t ON t.id = a.owner_team_id LEFT JOIN public.services AS s ON s.id = a.service_id JOIN public.change_freezes AS cf ON cf.starts_at <= $1 AND $1 < cf.ends_at AND (cf.service_id IS NULL OR cf.service_id = a.service_id) WHERE av.state = 'missing' AND a.environment = 'prod' AND v.fix_available = TRUE ORDER BY deferred_until, cve, hostname
    `.trim(),
    paramOrder: ["as_of"],
    paramsSchema: {
      as_of: { type: "string", required: true, description: "The timestamp used to determine which change freezes are active, in ISO 8601 format." }
    },
  },
  {
    need: `Pager carriers with every-team-appears and fallback-key rules.`,
    name: "oncall_now",
    description:
      "Pager carriers per team — GENERATED, all 5 teams incl. nobody-on-call (2026-09-09).",
    sqlText: `
SELECT t.team_code, t.name AS team_name, t.contact_email, COALESCE(NULLIF(t.escalation_email, ''), os.value) AS escalation_email, (NULLIF(t.escalation_email, '') IS NULL) AS escalation_via_org_fallback, oc.person_name, oc.person_email, oc.starts_at AS shift_starts_at, oc.ends_at AS shift_ends_at, (oc.id IS NULL) AS nobody_on_call FROM public.teams AS t LEFT JOIN public.org_settings AS os ON os.key = 'escalation_fallback_email' LEFT JOIN public.on_call AS oc ON oc.team_id = t.id AND oc.starts_at <= $1::timestamp with time zone AND $1::timestamp with time zone < oc.ends_at ORDER BY t.team_code, oc.starts_at
    `.trim(),
    paramOrder: ["as_of"],
    paramsSchema: {
      as_of: { type: "string", required: true, description: "The ISO-8601 timestamp with timezone at which to determine the active on-call shift." }
    },
  },
  {
    need: `Staleness read with asset-owner join contract.`,
    name: "assets_stale",
    description:
      "Unseen assets — GENERATED, 2/2 rows incl. serviceless asset (2026-09-09).",
    sqlText: `
SELECT assets.hostname, assets.os, assets.environment, services.service_code, teams.team_code, teams.contact_email AS notify_email, assets.last_seen_at, CASE WHEN assets.last_seen_at IS NULL THEN NULL ELSE $1::timestamptz - assets.last_seen_at END AS unseen_for FROM public.assets AS assets JOIN public.teams AS teams ON teams.id = assets.owner_team_id LEFT JOIN public.services AS services ON services.id = assets.service_id CROSS JOIN (SELECT value FROM public.org_settings WHERE key = 'stale_asset_days') AS settings WHERE assets.last_seen_at IS NULL OR assets.last_seen_at < $1::timestamptz - make_interval(days => settings.value::integer) ORDER BY assets.last_seen_at IS NOT NULL, assets.hostname
    `.trim(),
    paramOrder: ["as_of"],
    paramsSchema: {
      as_of: { type: "string", required: true, description: "The as-of timestamp with timezone in ISO-8601 format." }
    },
  },
];
