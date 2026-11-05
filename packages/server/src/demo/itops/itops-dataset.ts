/**
 * The IT operations demo dataset, and the independently-computed correct answer
 * for every claim an IT operations flow makes.
 *
 * ── ALL DATA IS SYNTHETIC ────────────────────────────────────────────────────
 *
 * Invented hostnames, invented people, invented CVE identifiers, every address
 * on an RFC 2606 reserved domain that can never resolve or receive mail. The
 * `CVE-2026-9xxxx` block is not a real CISA or NVD range and none of these
 * identifiers corresponds to a real advisory. Nothing is fetched from anywhere.
 * Never replace any of it with real data.
 *
 * ── WHY THIS ORACLE IS A SEPARATE FUNCTION FROM THE OTHER THREE ──────────────
 *
 * `itopsOracle()` is not a parameterisation of `expectedScreening()`,
 * `financeOracle()` or `legalOracle()` and must never become one. The swap
 * rehearsal established the reason and it has not changed: a shared oracle lets
 * a shared bug produce a wrong answer that agrees with itself. Four domains with
 * four independently written oracles is the only arrangement in which "the flow
 * agreed with the oracle" is evidence of anything.
 *
 * `itops-dataset.test.ts` asserts this module imports NOTHING — not from
 * `../hr-dataset`, not from `../finance/`, not from `../legal/`, not from
 * anywhere else. You cannot call what you have not imported.
 *
 * It is computed from the DEFINITIONS BELOW and from nothing else — never from a
 * query result and never from a flow run. Reading the database would make it a
 * second implementation of the same SQL, and the two would be wrong together the
 * first time somebody fixed a bug in one of them.
 *
 * ── EVERY INSTANT IS A LITERAL. THERE IS NO CLOCK READ IN THIS FILE ──────────
 *
 * A dataset whose traps move with the wall clock cannot have an oracle, and the
 * failure is invisible until the day a boundary row stops sitting on the
 * boundary. The test greps this file for a clock read, because the absence of a
 * call is not observable at runtime.
 *
 * ── THE TRAPS, AND WHAT EACH ONE COSTS SOMEBODY WHO MISSES IT ────────────────
 *
 *  T1. THE BUSINESS-HOURS CLOCK — the headline, and it INVERTS ANSWERS.
 *      For a service with `businessHoursOnly` the SLA clock runs only
 *      09:00–17:00 Mon–Fri. INC-1007 was opened 16:40 on a Friday and resolved
 *      09:20 the following Monday: it consumed FORTY MINUTES against a 480-minute
 *      budget. The obvious `resolved_at - opened_at` says 3,880 minutes and
 *      reports it breached. INC-1005 is the same inversion on an incident that
 *      resolved before the earliest as-of instant, and INC-1028 is the same
 *      inversion on an incident that is still OPEN — because a query author who
 *      fixes the resolved case and forgets the open one has fixed half of it.
 *
 *  T2. PAUSED TIME IS EXCLUDED. `INCIDENT_PAUSES` spans come off the resolve
 *      clock. INC-1009 is breached with pauses ignored and healthy with them
 *      honoured, on a 24x7 service so the pause is the ONLY variable. INC-1025
 *      is the same thing with `endedAt` NULL — a pause still running at the
 *      as-of instant, which is the case a query writer forgets, and it inverts
 *      too.
 *
 *  T1+T2. INC-1012 NEEDS BOTH, AND EACH CORRECTION ALONE STILL GETS IT WRONG.
 *      Naive: 8,400 minutes — breached. Business hours only: 1,680 — still
 *      breached. Raw elapsed minus raw pause: 2,400 — still breached. Both
 *      corrections together: 480 against a 1,440 budget — healthy. It is
 *      deliberate that no single fix rescues it.
 *
 *  T3. THE POLICY KEY IS TWO COLUMNS. `SLA_POLICIES` is keyed on
 *      (tier, priority) and neither column identifies a row alone. A bronze P1
 *      has 480 minutes to resolve; a platinum P1 has 60. INC-1006 consumed 300
 *      minutes on a bronze service with no business-hours or pause involvement
 *      at all: correct by tier, breached by priority alone. Four policy rows
 *      deliberately share `resolveMins = 480`, so a wrong lookup often lands on
 *      a plausible number and the cases where it does not are the ones that
 *      matter. This is `hr_demo`'s employee #14 in a second domain.
 *
 *  T4. SEVERITY IS NOT PRIORITY. CVE-2026-90001 is `critical` and sits on
 *      `sandbox-01`, which is NONPROD. Deriving urgency from severity alone
 *      pages the on-call engineer at 03:00 for a machine nobody depends on.
 *      CVE-2026-90011 on `dev-rpt-01` is a second one, so it cannot be dismissed
 *      as a single-row coincidence.
 *
 *  T5. KEV OUTRANKS SEVERITY. CVE-2026-90003 is only `medium` and is being
 *      actively exploited; CVE-2026-90004 is `high` and is not. Ordering by
 *      severity puts the wrong one first. CVE-2026-90010 is the surprising half:
 *      a `low` that outranks every non-KEV in the set. `kev` is a separate
 *      column precisely so an ordering has to read it.
 *
 *  T6. A FREEZE MEANS DEFER, NOT SKIP — and it is DATE-BOUNDED. Work due inside
 *      an active `CHANGE_FREEZES` window is deferred to the window's end and
 *      announced; dropping it is silent and looks exactly like there having been
 *      nothing to do. FRZ-3 is a freeze that ENDED in May: an `EXISTS (SELECT 1
 *      FROM change_freezes)` with no date bound defers every remediation for
 *      ever. FRZ-2 is scoped to one service, so a freeze somewhere must not stop
 *      work everywhere.
 *
 *  T7. NOT EVERY FINDING IS ACTIONABLE. CVE-2026-90005 has no fix available.
 *      Reporting it as remediation work asks somebody to apply a patch that does
 *      not exist.
 *
 *  T8. THE ESCALATION ADDRESS IS A TWO-LEVEL FALLBACK. team.escalationEmail ->
 *      org default. The DATA team has none of its own, and the org default is
 *      deliberately unequal to every team's, so a query that skips the team hop
 *      resolves a DIFFERENT address rather than the same one by luck. Legal's
 *      two-level notice fallback, in a fourth domain.
 *
 * ── THE BAND RULE, AND IT IS A THIRD KIND OF RULE ON PURPOSE ─────────────────
 *
 * `finance_demo` teaches a boundary with `>` ("due today is not overdue").
 * `legal_demo` teaches the opposite boundary with `<=`. This domain teaches a
 * FRACTION, which is neither:
 *
 *     breached  at or past 100% of the policy's own resolveMins
 *     at_risk   at or past  80%, below 100%
 *     healthy   below 80%
 *
 * ⚠ EIGHTY PER CENT OF THE POLICY'S OWN BUDGET, NEVER A FIXED NUMBER OF
 * MINUTES. A platinum P1 is at risk at 48 minutes and a bronze P4 at 5,760; a
 * hardcoded "at risk after 45 minutes" gets both wrong, in opposite directions.
 * The threshold is read back from `AT_RISK_FRACTION` everywhere, for the reason
 * `retentionDays()` is read back rather than written as `30`: a hardcoded
 * expectation is how a second default gets born.
 *
 * INC-1020 sits EXACTLY on 0.80 at the default as-of instant (192 minutes of a
 * 240-minute budget). The bound is inclusive, so it is at risk; an
 * implementation written with `>` calls it healthy and nobody is warned.
 *
 * ── THE THREE ARMS HAVE THREE DIFFERENT RECIPIENTS ──────────────────────────
 *
 * breached -> the owning team's escalation address (T8's fallback lives here)
 * at_risk  -> the owning team's ordinary contact address
 * healthy  -> the weekly digest, and no per-incident recipient at all
 *
 * That is why this domain is the right subject for `if` / `elif` / `else`: the
 * arms do not differ by a number in a message, they differ by WHO IS WOKEN UP.
 */

// ── As-of instants ───────────────────────────────────────────────────────────

/**
 * The reporting instants this dataset is tuned for.
 *
 * As with HR, Finance and Legal the traps are tuned to the reporting moment and
 * a single one does not exercise them all. Run every harness at more than one.
 *
 *   2026-06-02T10:00:00Z  THE QUIET CASE. Tuesday morning. ZERO open incidents
 *                         breached and ZERO at risk — the only instant that
 *                         exercises the empty arm of the three-way branch, and
 *                         the arm a flow is most likely to get wrong because it
 *                         is the one nobody looks at. It is NOT an empty
 *                         dataset: INC-1002 is a genuine resolved breach and
 *                         INC-1005 is a business-hours inversion, so "nothing to
 *                         report" is still the wrong answer here.
 *   2026-06-15T14:00:00Z  Monday afternoon. 1 breached, 1 at risk, 1
 *                         unacknowledged, and the SCOPED freeze FRZ-2 is active
 *                         — so remediation defers on Payments assets and
 *                         proceeds everywhere else.
 *   2026-06-29T08:00:00Z  ⚠ THE ONLY INSTANT WHERE SOMETHING IS AT RISK AND
 *                         NOTHING HAS BREACHED. Two hours earlier than the
 *                         default and the difference matters: INC-1027 is at
 *                         87.5% of its budget rather than past it, and INC-1021
 *                         has not been raised yet. It exists because a
 *                         three-armed flow whose middle arm no instant selects
 *                         is a flow with an untested arm — `itops-verify.ts`
 *                         asserts that the three instants between them reach all
 *                         three arms, and without this one they reach two.
 *   2026-06-29T10:00:00Z  The default and the richest. 2 breached, 2 at risk
 *                         (one of them EXACTLY on the 0.80 boundary), 9 open
 *                         incidents in all, and the org-wide freeze FRZ-1 is
 *                         active — so every remediation defers and none is
 *                         dropped.
 *
 * Three things hold at EVERY instant, which is what makes them assertable
 * rather than tuned, and `itops:verify` checks all three at all three:
 *
 *   1. At least one incident is GENUINELY breached under the correct
 *      arithmetic, so "everything is fine" is never the right answer and a flow
 *      that returns nothing is caught.
 *   2. The naive arithmetic and the correct arithmetic DISAGREE about at least
 *      one incident, so a run cannot pass by accident on easy data.
 *   3. The breached set and the at-risk set are DISJOINT and their union is
 *      exactly the actionable set — the property that stops the two named
 *      queries drifting apart.
 */
/**
 * ⚠ NAMED, NOT INDEXED. Every instant here is tuned to the minute, so a caller
 * writing `ITOPS_AS_OF[1]` is pinning a trap by its POSITION — and inserting a
 * fourth instant in chronological order silently repoints it at a different one
 * while every test still passes. That happened: the at-risk-only instant below
 * was added between the scoped freeze and the default, and two assertions that
 * said "the scoped freeze" would have started checking something else.
 */
export const ITOPS_QUIET_AS_OF = "2026-06-02T10:00:00Z";
export const ITOPS_SCOPED_FREEZE_AS_OF = "2026-06-15T14:00:00Z";
export const ITOPS_AT_RISK_ONLY_AS_OF = "2026-06-29T08:00:00Z";
export const ITOPS_DEFAULT_AS_OF = "2026-06-29T10:00:00Z";

export const ITOPS_AS_OF = [
  ITOPS_QUIET_AS_OF,
  ITOPS_SCOPED_FREEZE_AS_OF,
  ITOPS_AT_RISK_ONLY_AS_OF,
  ITOPS_DEFAULT_AS_OF,
] as const;
export type ItopsAsOf = (typeof ITOPS_AS_OF)[number];

/**
 * The at-risk threshold, as a FRACTION of each policy's own resolve budget.
 *
 * Read this constant; never write `0.8` and never write a number of minutes.
 * Both halves matter: a second literal is a second default, and a fixed minute
 * count is wrong for every tier but the one it was written against.
 */
export const AT_RISK_FRACTION = 0.8;

/** Business hours, UTC. See `itops-schema.sql` for why there is no timezone column. */
export const BUSINESS_DAY_START_MIN = 9 * 60;
export const BUSINESS_DAY_END_MIN = 17 * 60;

/** How long an asset may go unseen before it is stale. Days. */
export const STALE_ASSET_DAYS = 30;

/** A domain that always hard-bounces, for the unreachable-recipient case. */
export const BOUNCING_DOMAIN = "acme-itops-bounce.example";

// ── Time arithmetic ──────────────────────────────────────────────────────────
//
// ⚠ Every function here takes and returns ISO strings and touches no clock.

const MS_PER_MIN = 60_000;

function ms(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`itops dataset: not an instant: ${iso}`);
  return t;
}

/** The obvious subtraction — what a first-draft query computes. Kept so the oracle can SHOW the difference. */
export function elapsedMinutes(fromIso: string, toIso: string): number {
  return Math.max(0, Math.round((ms(toIso) - ms(fromIso)) / MS_PER_MIN));
}

/**
 * Minutes of 09:00–17:00 Mon–Fri (UTC) between two instants.
 *
 * ⚠ Walks whole UTC days rather than doing closed-form arithmetic. The closed
 * form is shorter and gets weekends, part-days and spans that begin or end
 * outside the window wrong in ways that only show up on particular calendar
 * placements — which is exactly the class of bug this dataset exists to catch,
 * so the oracle must not contain one.
 */
export function businessMinutes(fromIso: string, toIso: string): number {
  const from = ms(fromIso);
  const to = ms(toIso);
  if (to <= from) return 0;

  let total = 0;
  // Start at midnight UTC of the from-day and walk forward one day at a time.
  const cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);

  for (let day = cursor.getTime(); day < to; day += 24 * 60 * MS_PER_MIN) {
    const weekday = new Date(day).getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (weekday === 0 || weekday === 6) continue;
    const open = day + BUSINESS_DAY_START_MIN * MS_PER_MIN;
    const close = day + BUSINESS_DAY_END_MIN * MS_PER_MIN;
    const start = Math.max(open, from);
    const end = Math.min(close, to);
    if (end > start) total += (end - start) / MS_PER_MIN;
  }
  return Math.round(total);
}

/** Whichever clock the service runs on. The one place the choice is made. */
export function clockMinutes(fromIso: string, toIso: string, businessHoursOnly: boolean): number {
  return businessHoursOnly ? businessMinutes(fromIso, toIso) : elapsedMinutes(fromIso, toIso);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.floor((ms(toIso) - ms(fromIso)) / (24 * 60 * MS_PER_MIN));
}

// ── Org settings ─────────────────────────────────────────────────────────────

export interface OrgSetting {
  key: string;
  value: string;
  description: string;
}

/**
 * ⚠ `escalation_fallback_email` is deliberately unequal to EVERY team's own
 * escalation address. With them equal, a query that skips the team-level hop
 * resolves the right address by luck and the trap is undetectable — which is
 * the mistake `legal_demo`'s first version made with its notice periods.
 */
export const ORG_SETTINGS: OrgSetting[] = [
  {
    key: "escalation_fallback_email",
    value: "it-major-incident@acme-itops.example",
    description: "Where an SLA breach goes when the owning team has no escalation address of its own.",
  },
  {
    key: "at_risk_fraction",
    value: "0.80",
    description: "An unresolved incident is at risk at or past this fraction of its resolve budget.",
  },
  {
    key: "business_day_start",
    value: "09:00",
    description: "Start of the SLA clock for a business-hours-only service, UTC.",
  },
  {
    key: "business_day_end",
    value: "17:00",
    description: "End of the SLA clock for a business-hours-only service, UTC.",
  },
  {
    key: "stale_asset_days",
    value: "30",
    description: "An asset unseen for longer than this is stale and its findings cannot be trusted.",
  },
];

// ── Teams ────────────────────────────────────────────────────────────────────

export interface Team {
  id: number;
  code: string;
  name: string;
  contactEmail: string;
  /** ⚠ NULL on DATA, on purpose — T8's second hop. */
  escalationEmail: string | null;
  timezone: string;
}

export const TEAMS: Team[] = [
  {
    id: 1,
    code: "PLATFORM",
    name: "Platform Engineering",
    contactEmail: "platform@acme-itops.example",
    escalationEmail: "platform-escalation@acme-itops.example",
    timezone: "UTC",
  },
  {
    id: 2,
    code: "PAYMENTS",
    name: "Payments",
    contactEmail: "payments@acme-itops.example",
    escalationEmail: "payments-major@acme-itops.example",
    timezone: "UTC",
  },
  {
    // ⚠ THE FALLBACK CASE. No escalation address of its own, and it owns two
    // services, so it has something breached at more than one as-of instant.
    id: 3,
    code: "DATA",
    name: "Data Platform",
    contactEmail: "data-platform@acme-itops.example",
    escalationEmail: null,
    timezone: "UTC",
  },
  {
    id: 4,
    code: "WORKPLACE",
    name: "Workplace IT",
    contactEmail: "workplace-it@acme-itops.example",
    escalationEmail: "workplace-leads@acme-itops.example",
    timezone: "UTC",
  },
  {
    // The bouncing recipient: a real-looking address on a domain that always
    // hard-bounces. For a page, an unserved send is not a failed email — nobody
    // was woken up. That is an escalation, not a logged warning.
    id: 5,
    code: "SECOPS",
    name: "Security Operations",
    contactEmail: "secops@acme-itops.example",
    escalationEmail: `secops-duty@${BOUNCING_DOMAIN}`,
    timezone: "UTC",
  },
];

// ── Services ─────────────────────────────────────────────────────────────────

export type Tier = "platinum" | "gold" | "silver" | "bronze";

export interface Service {
  id: number;
  code: string;
  name: string;
  tier: Tier;
  ownerTeamId: number;
  businessHoursOnly: boolean;
  criticalityNote: string;
}

export const SERVICES: Service[] = [
  { id: 1, code: "SVC-PAY", name: "Payments API", tier: "platinum", ownerTeamId: 2, businessHoursOnly: false, criticalityNote: "Card authorisation. Revenue stops when this stops." },
  { id: 2, code: "SVC-CHK", name: "Checkout Web", tier: "platinum", ownerTeamId: 2, businessHoursOnly: false, criticalityNote: "Customer-facing basket and payment pages." },
  // ⚠ T1's subject. Silver AND business-hours-only: the combination that makes
  // the naive arithmetic invert an answer rather than merely inflate a number.
  { id: 3, code: "SVC-RPT", name: "Reporting Portal", tier: "silver", ownerTeamId: 3, businessHoursOnly: true, criticalityNote: "Internal dashboards. Nobody reads them at 03:00." },
  { id: 4, code: "SVC-ETL", name: "Nightly ETL", tier: "gold", ownerTeamId: 3, businessHoursOnly: false, criticalityNote: "Runs overnight, so its clock cannot be a business-hours one." },
  { id: 5, code: "SVC-DSK", name: "Employee Helpdesk", tier: "bronze", ownerTeamId: 4, businessHoursOnly: true, criticalityNote: "Staff requests. Closed evenings and weekends." },
  { id: 6, code: "SVC-IDP", name: "Identity Provider", tier: "platinum", ownerTeamId: 1, businessHoursOnly: false, criticalityNote: "Single sign-on. Everything else depends on it." },
  // ⚠ T3's subject: a bronze service on a 24x7 clock, so the tier trap can be
  // exercised with NO business-hours involvement at all.
  { id: 7, code: "SVC-ARC", name: "Archive Storage", tier: "bronze", ownerTeamId: 1, businessHoursOnly: false, criticalityNote: "Cold storage. Slow is acceptable; lost is not." },
];

// ── SLA policies ─────────────────────────────────────────────────────────────

export type Priority = "P1" | "P2" | "P3" | "P4";

export interface SlaPolicy {
  tier: Tier;
  priority: Priority;
  respondMins: number;
  resolveMins: number;
}

/**
 * ⚠ TWO-COLUMN KEY, and FOUR rows deliberately share `resolveMins = 480`
 * (platinum P3, gold P2, silver P2, bronze P1).
 *
 * That collision is the point. A query that looks a budget up by priority alone
 * lands on a plausible number often enough to look correct, so the failure is
 * intermittent rather than obvious — and INC-1006 is the case where it is not.
 */
export const SLA_POLICIES: SlaPolicy[] = [
  { tier: "platinum", priority: "P1", respondMins: 15, resolveMins: 60 },
  { tier: "platinum", priority: "P2", respondMins: 30, resolveMins: 240 },
  { tier: "platinum", priority: "P3", respondMins: 60, resolveMins: 480 },
  { tier: "platinum", priority: "P4", respondMins: 240, resolveMins: 2880 },
  { tier: "gold", priority: "P1", respondMins: 30, resolveMins: 120 },
  { tier: "gold", priority: "P2", respondMins: 60, resolveMins: 480 },
  { tier: "gold", priority: "P3", respondMins: 120, resolveMins: 960 },
  { tier: "gold", priority: "P4", respondMins: 480, resolveMins: 4320 },
  { tier: "silver", priority: "P1", respondMins: 60, resolveMins: 240 },
  { tier: "silver", priority: "P2", respondMins: 120, resolveMins: 480 },
  { tier: "silver", priority: "P3", respondMins: 240, resolveMins: 1440 },
  { tier: "silver", priority: "P4", respondMins: 960, resolveMins: 5760 },
  { tier: "bronze", priority: "P1", respondMins: 120, resolveMins: 480 },
  { tier: "bronze", priority: "P2", respondMins: 240, resolveMins: 960 },
  { tier: "bronze", priority: "P3", respondMins: 480, resolveMins: 2880 },
  { tier: "bronze", priority: "P4", respondMins: 1440, resolveMins: 7200 },
];

// ── Incidents ────────────────────────────────────────────────────────────────

export type IncidentStatus = "open" | "acknowledged" | "resolved";

export interface Incident {
  id: number;
  code: string;
  serviceId: number;
  priority: Priority;
  summary: string;
  status: IncidentStatus;
  openedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  assigneeEmail: string | null;
  source: "person" | "monitor";
}

/**
 * ⚠ Read the trap map in this file's header before changing ANY instant here.
 *
 * Several of these are placed to the minute so that a specific arithmetic
 * mistake produces a specific wrong ANSWER, not a slightly wrong number. Moving
 * INC-1020 by nine minutes stops it sitting on the 0.80 boundary; moving
 * INC-1007 to a weekday stops it inverting at all. Every such placement is
 * called out in the comment above the row, and `itops-dataset.test.ts` pins the
 * consequences rather than the instants — so if you do move one, the test will
 * tell you what you took away.
 */
export const INCIDENTS: Incident[] = [
  { id: 1, code: "INC-1001", serviceId: 1, priority: "P4", summary: "Elevated 4xx on the refunds endpoint", status: "resolved", openedAt: "2026-06-01T09:00:00Z", acknowledgedAt: "2026-06-01T09:05:00Z", resolvedAt: "2026-06-01T10:00:00Z", assigneeEmail: "sam.reyes@acme-itops.example", source: "monitor" },

  // ⚠ AS-OF 1's GENUINE BREACH. 600 minutes against a 480-minute platinum P3
  // budget, on a 24x7 service with no pause — so it is breached under EVERY
  // arithmetic. It exists so that "nothing to report" is the wrong answer even
  // at the quiet instant, where a flow returning an empty set would otherwise
  // look correct.
  { id: 2, code: "INC-1002", serviceId: 2, priority: "P3", summary: "Checkout basket fails to persist for guest sessions", status: "resolved", openedAt: "2026-06-01T06:00:00Z", acknowledgedAt: "2026-06-01T06:10:00Z", resolvedAt: "2026-06-01T16:00:00Z", assigneeEmail: "sam.reyes@acme-itops.example", source: "person" },

  { id: 3, code: "INC-1003", serviceId: 7, priority: "P3", summary: "Archive retrieval latency above baseline", status: "resolved", openedAt: "2026-06-02T08:00:00Z", acknowledgedAt: "2026-06-02T08:20:00Z", resolvedAt: "2026-06-03T06:00:00Z", assigneeEmail: "dana.okoro@acme-itops.example", source: "monitor" },

  { id: 4, code: "INC-1004", serviceId: 1, priority: "P1", summary: "Card authorisation timeouts, all regions", status: "resolved", openedAt: "2026-06-03T02:10:00Z", acknowledgedAt: "2026-06-03T02:14:00Z", resolvedAt: "2026-06-03T04:30:00Z", assigneeEmail: "sam.reyes@acme-itops.example", source: "monitor" },

  // ⚠ T1 AT THE EARLIEST INSTANT. Friday 16:00 to Monday 09:30 on a
  // business-hours service: 90 business minutes against a 960-minute budget, and
  // 3,930 minutes if you subtract the timestamps. Breached naively, healthy
  // correctly — so the quiet as-of instant still carries a disagreement, and a
  // harness cannot pass there by having nothing to get wrong.
  { id: 5, code: "INC-1005", serviceId: 5, priority: "P2", summary: "Shared printer queue stuck in the Dublin office", status: "resolved", openedAt: "2026-05-29T16:00:00Z", acknowledgedAt: "2026-06-01T09:10:00Z", resolvedAt: "2026-06-01T09:30:00Z", assigneeEmail: "jo.whitfield@acme-itops.example", source: "person" },

  // ⚠ T3, ISOLATED. A bronze P1 has 480 minutes; a platinum P1 has 60. This one
  // consumed 300 on a 24x7 service with no pause, so neither the business-hours
  // clock nor the pause table is involved: the ONLY way to get it wrong is to
  // look the budget up by priority and ignore the tier.
  { id: 6, code: "INC-1006", serviceId: 7, priority: "P1", summary: "Archive replication halted to the secondary region", status: "resolved", openedAt: "2026-06-09T22:00:00Z", acknowledgedAt: "2026-06-09T22:30:00Z", resolvedAt: "2026-06-10T03:00:00Z", assigneeEmail: "dana.okoro@acme-itops.example", source: "monitor" },

  // ⚠ T1, THE HEADLINE. Friday 16:40 to Monday 09:20 = FORTY business minutes
  // against a 480-minute budget. The obvious subtraction says 3,880 and reports
  // a breach that never happened. If you change one row in this file, do not
  // change this one.
  { id: 7, code: "INC-1007", serviceId: 3, priority: "P2", summary: "Scheduled sales report did not publish", status: "resolved", openedAt: "2026-06-05T16:40:00Z", acknowledgedAt: "2026-06-05T16:45:00Z", resolvedAt: "2026-06-08T09:20:00Z", assigneeEmail: "priya.nandi@acme-itops.example", source: "person" },

  { id: 8, code: "INC-1008", serviceId: 6, priority: "P2", summary: "SAML assertions rejected for one identity provider", status: "resolved", openedAt: "2026-06-08T11:00:00Z", acknowledgedAt: "2026-06-08T11:10:00Z", resolvedAt: "2026-06-08T13:30:00Z", assigneeEmail: "dana.okoro@acme-itops.example", source: "monitor" },

  // ⚠ T2, ISOLATED. 24x7 service, so the pause is the only variable: 1,320
  // minutes elapsed, 1,200 of them awaiting the customer, 120 consumed against a
  // 240-minute budget. Breached with pauses ignored, healthy with them honoured.
  { id: 9, code: "INC-1009", serviceId: 1, priority: "P2", summary: "Settlement file rejected by the acquirer", status: "resolved", openedAt: "2026-06-08T08:00:00Z", acknowledgedAt: "2026-06-08T08:05:00Z", resolvedAt: "2026-06-09T06:00:00Z", assigneeEmail: "sam.reyes@acme-itops.example", source: "person" },

  { id: 10, code: "INC-1010", serviceId: 4, priority: "P3", summary: "Nightly load finished late after a source delay", status: "resolved", openedAt: "2026-06-10T01:00:00Z", acknowledgedAt: "2026-06-10T01:30:00Z", resolvedAt: "2026-06-10T05:00:00Z", assigneeEmail: "priya.nandi@acme-itops.example", source: "monitor" },

  { id: 11, code: "INC-1011", serviceId: 2, priority: "P1", summary: "Checkout returning 503 behind the edge cache", status: "resolved", openedAt: "2026-06-10T19:00:00Z", acknowledgedAt: "2026-06-10T19:03:00Z", resolvedAt: "2026-06-10T19:45:00Z", assigneeEmail: "sam.reyes@acme-itops.example", source: "monitor" },

  // ⚠ T1 AND T2 TOGETHER, AND EACH CORRECTION ALONE STILL GETS IT WRONG.
  //     naive                        8,400  breached
  //     business hours only          1,680  STILL breached
  //     raw elapsed minus raw pause  2,400  STILL breached
  //     both, correctly                480  healthy (budget 1,440)
  // There is no single fix that rescues it. That is the whole point of the row.
  { id: 12, code: "INC-1012", serviceId: 3, priority: "P3", summary: "Finance dashboard showing stale figures", status: "resolved", openedAt: "2026-06-11T15:00:00Z", acknowledgedAt: "2026-06-11T15:20:00Z", resolvedAt: "2026-06-17T11:00:00Z", assigneeEmail: "priya.nandi@acme-itops.example", source: "person" },

  { id: 13, code: "INC-1013", serviceId: 1, priority: "P1", summary: "Authorisation success rate collapsed for one BIN range", status: "resolved", openedAt: "2026-06-15T12:30:00Z", acknowledgedAt: "2026-06-15T12:35:00Z", resolvedAt: "2026-06-15T18:00:00Z", assigneeEmail: "sam.reyes@acme-itops.example", source: "monitor" },

  // Unacknowledged for fifteen hours: raised by a monitor overnight and never
  // picked up. `acknowledgedAt` NULL is the state the respond clock exists for.
  { id: 14, code: "INC-1014", serviceId: 4, priority: "P3", summary: "ETL worker OOM-killed on the enrichment stage", status: "resolved", openedAt: "2026-06-14T23:00:00Z", acknowledgedAt: null, resolvedAt: "2026-06-15T16:00:00Z", assigneeEmail: null, source: "monitor" },

  // ⚠ THE NEGATIVE CONTROL FOR T1. A business-hours service that IS genuinely
  // breached — 4,710 business minutes against 2,880. Without it, "apply the
  // business-hours clock and everything comes out healthy" would be a strategy
  // that scores full marks.
  { id: 15, code: "INC-1015", serviceId: 5, priority: "P3", summary: "Laptop refresh requests unactioned for a fortnight", status: "resolved", openedAt: "2026-06-15T09:30:00Z", acknowledgedAt: "2026-06-15T09:50:00Z", resolvedAt: "2026-06-26T16:00:00Z", assigneeEmail: "jo.whitfield@acme-itops.example", source: "person" },

  { id: 16, code: "INC-1016", serviceId: 6, priority: "P3", summary: "Token refresh loop for a single tenant", status: "resolved", openedAt: "2026-06-18T07:00:00Z", acknowledgedAt: "2026-06-18T07:20:00Z", resolvedAt: "2026-06-18T13:00:00Z", assigneeEmail: "dana.okoro@acme-itops.example", source: "monitor" },

  { id: 17, code: "INC-1017", serviceId: 2, priority: "P2", summary: "Address lookup provider degraded", status: "resolved", openedAt: "2026-06-22T09:00:00Z", acknowledgedAt: "2026-06-22T09:04:00Z", resolvedAt: "2026-06-22T11:30:00Z", assigneeEmail: "sam.reyes@acme-itops.example", source: "monitor" },

  // ⚠ T1 WITH NO WEEKEND IN IT. Tuesday 10:00 to Wednesday 11:00: 540 business
  // minutes against 1,440, and 1,500 if you subtract the timestamps. It exists
  // because "the business-hours trap is really the weekend trap" is a plausible
  // and wrong reading of INC-1005 and INC-1007 — here the overnight hours alone
  // are enough to invert the answer.
  { id: 18, code: "INC-1018", serviceId: 3, priority: "P3", summary: "Report export truncating at ten thousand rows", status: "resolved", openedAt: "2026-06-23T10:00:00Z", acknowledgedAt: "2026-06-23T10:30:00Z", resolvedAt: "2026-06-24T11:00:00Z", assigneeEmail: "priya.nandi@acme-itops.example", source: "person" },

  { id: 19, code: "INC-1019", serviceId: 4, priority: "P4", summary: "Backfill job retried twice before succeeding", status: "resolved", openedAt: "2026-06-24T02:00:00Z", acknowledgedAt: "2026-06-24T02:40:00Z", resolvedAt: "2026-06-25T02:00:00Z", assigneeEmail: "priya.nandi@acme-itops.example", source: "monitor" },

  // ⚠ EXACTLY ON THE 0.80 BOUNDARY at the default as-of instant: 192 minutes of
  // a 240-minute platinum P2 budget. The bound is INCLUSIVE, so this is at risk.
  // An implementation written with `>` calls it healthy and nobody is warned.
  { id: 20, code: "INC-1020", serviceId: 2, priority: "P2", summary: "Intermittent 502s from the checkout API gateway", status: "acknowledged", openedAt: "2026-06-29T06:48:00Z", acknowledgedAt: "2026-06-29T06:52:00Z", resolvedAt: null, assigneeEmail: "sam.reyes@acme-itops.example", source: "monitor" },

  // Breached and still open. Platinum P1: 90 minutes against 60.
  { id: 21, code: "INC-1021", serviceId: 6, priority: "P1", summary: "Sign-in failing for all federated users", status: "acknowledged", openedAt: "2026-06-29T08:30:00Z", acknowledgedAt: "2026-06-29T08:33:00Z", resolvedAt: null, assigneeEmail: "dana.okoro@acme-itops.example", source: "monitor" },

  // ⚠ AT RISK CORRECTLY, BREACHED NAIVELY — on an OPEN incident. 1,380 business
  // minutes of 1,440 (95.8%); 7,140 if you subtract the timestamps. It is the
  // proof that T1 applies to the band calculation too, not only to the
  // did-it-breach question, which is the half a query author fixes second.
  { id: 22, code: "INC-1022", serviceId: 3, priority: "P3", summary: "Scheduled extract failing for the EMEA region", status: "acknowledged", openedAt: "2026-06-24T11:00:00Z", acknowledgedAt: "2026-06-24T11:20:00Z", resolvedAt: null, assigneeEmail: "priya.nandi@acme-itops.example", source: "person" },

  { id: 23, code: "INC-1023", serviceId: 5, priority: "P4", summary: "Meeting-room display stuck on a login prompt", status: "acknowledged", openedAt: "2026-06-29T09:15:00Z", acknowledgedAt: "2026-06-29T09:20:00Z", resolvedAt: null, assigneeEmail: "jo.whitfield@acme-itops.example", source: "person" },

  // ⚠ T2 on an OPEN incident, with a CLOSED pause. 840 minutes elapsed, 720 of
  // them paused, 120 consumed of 480. Breached naively, healthy correctly.
  { id: 24, code: "INC-1024", serviceId: 1, priority: "P3", summary: "Reconciliation mismatch pending merchant confirmation", status: "acknowledged", openedAt: "2026-06-28T20:00:00Z", acknowledgedAt: "2026-06-28T20:05:00Z", resolvedAt: null, assigneeEmail: "sam.reyes@acme-itops.example", source: "person" },

  // ⚠ T2 WITH `endedAt` NULL — a pause STILL RUNNING at the as-of instant, which
  // is the case a query writer forgets because the obvious join finds no end to
  // subtract to. 2,760 elapsed, 2,640 still paused, 120 consumed of 480.
  { id: 25, code: "INC-1025", serviceId: 4, priority: "P2", summary: "Upstream vendor feed suspended pending their fix", status: "acknowledged", openedAt: "2026-06-27T12:00:00Z", acknowledgedAt: "2026-06-27T12:10:00Z", resolvedAt: null, assigneeEmail: "priya.nandi@acme-itops.example", source: "monitor" },

  // Unacknowledged and unassigned: within its resolve budget, past its respond
  // budget. The two clocks answer differently, which is why there are two.
  { id: 26, code: "INC-1026", serviceId: 6, priority: "P2", summary: "Directory sync lagging by two hours", status: "open", openedAt: "2026-06-29T09:00:00Z", acknowledgedAt: null, resolvedAt: null, assigneeEmail: null, source: "monitor" },

  // Breached and still open. Platinum P3: 540 minutes against 480.
  { id: 27, code: "INC-1027", serviceId: 2, priority: "P3", summary: "Promotional pricing not applying at basket", status: "acknowledged", openedAt: "2026-06-29T01:00:00Z", acknowledgedAt: "2026-06-29T01:05:00Z", resolvedAt: null, assigneeEmail: "sam.reyes@acme-itops.example", source: "person" },

  // ⚠ T8'S SUBJECT AT THE MIDDLE INSTANT. Owned by DATA, which has no
  // escalation address of its own, so its breach recipient must come from
  // `org_settings.escalation_fallback_email`. Opened at 08:00 — BEFORE the
  // business day — so the clock starts at 09:00 and 300 of a 240-minute silver
  // P1 budget are consumed by 14:00. A query that starts the clock at
  // `opened_at` regardless gets 360 and the same answer for the wrong reason,
  // which is why the assertion is on the MINUTES and not only on the band.
  { id: 30, code: "INC-1030", serviceId: 3, priority: "P1", summary: "Reporting portal unreachable for every user", status: "resolved", openedAt: "2026-06-15T08:00:00Z", acknowledgedAt: "2026-06-15T09:05:00Z", resolvedAt: "2026-06-15T15:30:00Z", assigneeEmail: "priya.nandi@acme-itops.example", source: "monitor" },

  // ⚠ T8'S SUBJECT AT THE DEFAULT INSTANT, and open rather than resolved. Gold
  // P1, 24x7, 180 minutes against 120. DATA again, so the breach escalates
  // through the org fallback while INC-1021 and INC-1027 escalate through their
  // own teams — three breaches, two different resolution paths, in one run.
  { id: 29, code: "INC-1029", serviceId: 4, priority: "P1", summary: "Nightly load has not started for two cycles", status: "acknowledged", openedAt: "2026-06-29T07:00:00Z", acknowledgedAt: "2026-06-29T07:10:00Z", resolvedAt: null, assigneeEmail: "priya.nandi@acme-itops.example", source: "monitor" },

  // ⚠ T1 on an OPEN incident over a weekend: 180 business minutes of 960, and
  // 4,020 if you subtract. Healthy correctly, breached naively — so the quiet
  // arm of the branch is reached only by a flow that got the clock right.
  { id: 28, code: "INC-1028", serviceId: 5, priority: "P2", summary: "New starter cannot access the shared drive", status: "acknowledged", openedAt: "2026-06-26T15:00:00Z", acknowledgedAt: "2026-06-26T15:10:00Z", resolvedAt: null, assigneeEmail: "jo.whitfield@acme-itops.example", source: "person" },
];

// ── Pauses ───────────────────────────────────────────────────────────────────

export interface IncidentPause {
  id: number;
  incidentId: number;
  reason: string;
  startedAt: string;
  /** NULL = still paused at the as-of instant. INC-1025 is that case. */
  endedAt: string | null;
}

/**
 * ⚠ NO TWO PAUSES ON ONE INCIDENT OVERLAP, and the test asserts it.
 *
 * Merging overlapping spans before subtracting them is a real and separate
 * concern; leaving overlaps in the data here would entangle it with T2 and make
 * a wrong answer impossible to attribute. If overlap handling is ever worth
 * teaching, it gets its own incident and its own note.
 */
export const INCIDENT_PAUSES: IncidentPause[] = [
  { id: 1, incidentId: 9, reason: "awaiting_customer", startedAt: "2026-06-08T09:00:00Z", endedAt: "2026-06-09T05:00:00Z" },
  { id: 2, incidentId: 12, reason: "awaiting_customer", startedAt: "2026-06-12T10:00:00Z", endedAt: "2026-06-16T14:00:00Z" },
  { id: 3, incidentId: 24, reason: "awaiting_customer", startedAt: "2026-06-28T21:00:00Z", endedAt: "2026-06-29T09:00:00Z" },
  { id: 4, incidentId: 25, reason: "awaiting_vendor", startedAt: "2026-06-27T14:00:00Z", endedAt: null },
  // A short pause on an incident that is healthy either way — present so that
  // "a pause implies a trap" is not a pattern a reader can rely on.
  { id: 5, incidentId: 17, reason: "awaiting_customer", startedAt: "2026-06-22T09:30:00Z", endedAt: "2026-06-22T10:00:00Z" },
];

// ── On call ──────────────────────────────────────────────────────────────────

export interface OnCallShift {
  id: number;
  teamId: number;
  /** ⚠ HALF-OPEN: [startsAt, endsAt). A closed upper bound double-covers the
   *  handover instant and "who is on call" returns two people for one team. */
  startsAt: string;
  endsAt: string;
  personName: string;
  personEmail: string;
  escalationTo: string | null;
}

/**
 * ⚠ WORKPLACE HAS NO SHIFTS AT ALL, and that is realistic rather than an
 * omission: a business-hours helpdesk has no out-of-hours rota. It is the "no
 * row" case, and a flow that pages the on-call engineer with an inner join
 * silently DROPS a Workplace incident instead of escalating it. Whoever writes
 * the paging step has to decide what happens when nobody is on call, and this
 * is the row that makes them decide.
 */
export const ON_CALL: OnCallShift[] = [
  { id: 7, teamId: 1, startsAt: "2026-06-01T08:00:00Z", endsAt: "2026-06-22T08:00:00Z", personName: "Ada Lindqvist", personEmail: "ada.lindqvist@acme-itops.example", escalationTo: "platform-escalation@acme-itops.example" },
  { id: 1, teamId: 1, startsAt: "2026-06-22T08:00:00Z", endsAt: "2026-06-29T08:00:00Z", personName: "Marc Villalobos", personEmail: "marc.villalobos@acme-itops.example", escalationTo: "platform-escalation@acme-itops.example" },
  { id: 2, teamId: 1, startsAt: "2026-06-29T08:00:00Z", endsAt: "2026-07-06T08:00:00Z", personName: "Dana Okoro", personEmail: "dana.okoro@acme-itops.example", escalationTo: "platform-escalation@acme-itops.example" },
  { id: 3, teamId: 2, startsAt: "2026-06-01T08:00:00Z", endsAt: "2026-06-15T08:00:00Z", personName: "Sam Reyes", personEmail: "sam.reyes@acme-itops.example", escalationTo: "payments-major@acme-itops.example" },
  { id: 4, teamId: 2, startsAt: "2026-06-15T08:00:00Z", endsAt: "2026-07-06T08:00:00Z", personName: "Ines Kovač", personEmail: "ines.kovac@acme-itops.example", escalationTo: "payments-major@acme-itops.example" },
  { id: 5, teamId: 3, startsAt: "2026-06-01T08:00:00Z", endsAt: "2026-07-06T08:00:00Z", personName: "Priya Nandi", personEmail: "priya.nandi@acme-itops.example", escalationTo: null },
  { id: 6, teamId: 5, startsAt: "2026-06-01T08:00:00Z", endsAt: "2026-07-06T08:00:00Z", personName: "Tomas Aguirre", personEmail: "tomas.aguirre@acme-itops.example", escalationTo: `secops-duty@${BOUNCING_DOMAIN}` },
];

// ── Assets ───────────────────────────────────────────────────────────────────

export interface Asset {
  id: number;
  hostname: string;
  os: string;
  environment: "prod" | "nonprod";
  serviceId: number | null;
  ownerTeamId: number;
  lastSeenAt: string | null;
}

export const ASSETS: Asset[] = [
  { id: 1, hostname: "pay-api-01.acme-itops.example", os: "ubuntu-22.04", environment: "prod", serviceId: 1, ownerTeamId: 2, lastSeenAt: "2026-06-29T06:00:00Z" },
  { id: 2, hostname: "pay-api-02.acme-itops.example", os: "ubuntu-22.04", environment: "prod", serviceId: 1, ownerTeamId: 2, lastSeenAt: "2026-06-29T06:00:00Z" },
  { id: 3, hostname: "chk-web-01.acme-itops.example", os: "ubuntu-22.04", environment: "prod", serviceId: 2, ownerTeamId: 2, lastSeenAt: "2026-06-29T05:30:00Z" },
  { id: 4, hostname: "rpt-app-01.acme-itops.example", os: "rhel-9", environment: "prod", serviceId: 3, ownerTeamId: 3, lastSeenAt: "2026-06-28T22:00:00Z" },
  { id: 5, hostname: "etl-worker-01.acme-itops.example", os: "rhel-9", environment: "prod", serviceId: 4, ownerTeamId: 3, lastSeenAt: "2026-06-29T04:00:00Z" },
  { id: 6, hostname: "etl-worker-02.acme-itops.example", os: "rhel-9", environment: "prod", serviceId: 4, ownerTeamId: 3, lastSeenAt: "2026-06-29T04:00:00Z" },
  { id: 7, hostname: "idp-01.acme-itops.example", os: "debian-12", environment: "prod", serviceId: 6, ownerTeamId: 1, lastSeenAt: "2026-06-29T07:00:00Z" },
  // ⚠ T4's subject: a NONPROD sandbox carrying a `critical`. Severity-only
  // urgency pages somebody at 03:00 for a machine nobody depends on.
  { id: 8, hostname: "sandbox-01.acme-itops.example", os: "ubuntu-22.04", environment: "nonprod", serviceId: 1, ownerTeamId: 2, lastSeenAt: "2026-06-28T18:00:00Z" },
  { id: 9, hostname: "sandbox-02.acme-itops.example", os: "ubuntu-22.04", environment: "nonprod", serviceId: null, ownerTeamId: 1, lastSeenAt: "2026-06-27T18:00:00Z" },
  // T4's second, so it cannot be dismissed as one odd row.
  { id: 10, hostname: "dev-rpt-01.acme-itops.example", os: "rhel-9", environment: "nonprod", serviceId: 3, ownerTeamId: 3, lastSeenAt: "2026-06-26T20:00:00Z" },
  { id: 11, hostname: "arc-store-01.acme-itops.example", os: "debian-12", environment: "prod", serviceId: 7, ownerTeamId: 1, lastSeenAt: "2026-06-29T03:00:00Z" },
  { id: 12, hostname: "dsk-print-01.acme-itops.example", os: "windows-2022", environment: "prod", serviceId: 5, ownerTeamId: 4, lastSeenAt: "2026-06-28T16:00:00Z" },
  // ⚠ STALE AT EVERY AS-OF INSTANT, and it carries two criticals in PROD. An
  // asset nobody has heard from in three months is one whose findings cannot be
  // trusted either way — it may be patched, or it may be gone. Reporting it as
  // ordinary remediation work is a queue nobody can clear.
  { id: 13, hostname: "legacy-01.acme-itops.example", os: "centos-7", environment: "prod", serviceId: null, ownerTeamId: 1, lastSeenAt: "2026-04-02T11:00:00Z" },
  // Stale at the LAST instant only, so staleness has to be computed against the
  // as-of date rather than hardcoded as a list of two hostnames.
  { id: 14, hostname: "dsk-kiosk-01.acme-itops.example", os: "windows-2022", environment: "nonprod", serviceId: 5, ownerTeamId: 4, lastSeenAt: "2026-05-20T09:00:00Z" },
];

// ── Vulnerabilities ──────────────────────────────────────────────────────────

export type Severity = "critical" | "high" | "medium" | "low";

export interface Vulnerability {
  /** ⚠ INVENTED. The `CVE-2026-9xxxx` block is not a real identifier range. */
  cve: string;
  title: string;
  severity: Severity;
  cvss: number;
  publishedAt: string;
  /** ⚠ KNOWN-EXPLOITED. Outranks severity, and is a separate column so an
   *  ordering has to read it rather than infer it from `cvss`. */
  kev: boolean;
  /** ⚠ T7. No fix, no remediation work — asking somebody to apply a patch that
   *  does not exist is a ticket that can never be closed. */
  fixAvailable: boolean;
}

export const VULNERABILITIES: Vulnerability[] = [
  { cve: "CVE-2026-90001", title: "Unauthenticated deserialisation in the report renderer", severity: "critical", cvss: 9.8, publishedAt: "2026-05-12", kev: false, fixAvailable: true },
  { cve: "CVE-2026-90002", title: "Privilege escalation via a world-writable unit file", severity: "high", cvss: 8.1, publishedAt: "2026-05-18", kev: true, fixAvailable: true },
  // ⚠ T5. `medium`, and actively exploited. It outranks CVE-2026-90004, which is
  // `high` and is not. `ORDER BY severity` puts them the wrong way round.
  { cve: "CVE-2026-90003", title: "Path traversal in the archive extractor", severity: "medium", cvss: 5.4, publishedAt: "2026-06-02", kev: true, fixAvailable: true },
  { cve: "CVE-2026-90004", title: "Heap overflow in the TLS session cache", severity: "high", cvss: 7.5, publishedAt: "2026-04-28", kev: false, fixAvailable: true },
  // ⚠ T7's subject. High, in production, and there is nothing to apply.
  { cve: "CVE-2026-90005", title: "Signature bypass in the update verifier", severity: "high", cvss: 7.2, publishedAt: "2026-06-10", kev: false, fixAvailable: false },
  { cve: "CVE-2026-90006", title: "Cross-site scripting in the admin console", severity: "medium", cvss: 6.1, publishedAt: "2026-03-30", kev: false, fixAvailable: true },
  { cve: "CVE-2026-90007", title: "Information disclosure in verbose error pages", severity: "low", cvss: 3.1, publishedAt: "2026-02-14", kev: false, fixAvailable: true },
  { cve: "CVE-2026-90008", title: "Remote code execution in the image codec", severity: "critical", cvss: 9.1, publishedAt: "2026-06-15", kev: true, fixAvailable: true },
  { cve: "CVE-2026-90009", title: "Denial of service through a decompression bomb", severity: "medium", cvss: 4.9, publishedAt: "2026-01-22", kev: false, fixAvailable: true },
  // ⚠ T5's surprising half: a `low` that outranks every non-KEV in the set,
  // including two criticals. If the ordering looks wrong to you, read `kev`.
  { cve: "CVE-2026-90010", title: "Predictable temporary file name in the log rotator", severity: "low", cvss: 2.7, publishedAt: "2026-06-08", kev: true, fixAvailable: true },
  { cve: "CVE-2026-90011", title: "Authentication bypass in the management port", severity: "critical", cvss: 9.6, publishedAt: "2026-05-05", kev: false, fixAvailable: true },
  { cve: "CVE-2026-90012", title: "Server-side request forgery in the webhook fetcher", severity: "high", cvss: 8.8, publishedAt: "2026-06-19", kev: false, fixAvailable: true },
];

export interface AssetVulnerability {
  assetId: number;
  cve: string;
  state: "missing" | "installed" | "not_applicable";
  detectedAt: string;
}

export const ASSET_VULNERABILITIES: AssetVulnerability[] = [
  { assetId: 1, cve: "CVE-2026-90003", state: "missing", detectedAt: "2026-06-03" },
  { assetId: 1, cve: "CVE-2026-90007", state: "missing", detectedAt: "2026-02-20" },
  { assetId: 2, cve: "CVE-2026-90004", state: "missing", detectedAt: "2026-05-01" },
  { assetId: 2, cve: "CVE-2026-90006", state: "installed", detectedAt: "2026-04-02" },
  { assetId: 2, cve: "CVE-2026-90010", state: "missing", detectedAt: "2026-06-09" },
  { assetId: 3, cve: "CVE-2026-90008", state: "missing", detectedAt: "2026-06-16" },
  { assetId: 3, cve: "CVE-2026-90012", state: "missing", detectedAt: "2026-06-20" },
  { assetId: 3, cve: "CVE-2026-90005", state: "missing", detectedAt: "2026-06-11" },
  { assetId: 4, cve: "CVE-2026-90002", state: "missing", detectedAt: "2026-05-19" },
  { assetId: 4, cve: "CVE-2026-90009", state: "not_applicable", detectedAt: "2026-01-25" },
  { assetId: 5, cve: "CVE-2026-90004", state: "missing", detectedAt: "2026-05-01" },
  { assetId: 5, cve: "CVE-2026-90010", state: "missing", detectedAt: "2026-06-09" },
  { assetId: 6, cve: "CVE-2026-90012", state: "missing", detectedAt: "2026-06-20" },
  { assetId: 6, cve: "CVE-2026-90003", state: "missing", detectedAt: "2026-06-03" },
  { assetId: 7, cve: "CVE-2026-90005", state: "missing", detectedAt: "2026-06-11" },
  { assetId: 7, cve: "CVE-2026-90002", state: "installed", detectedAt: "2026-05-20" },
  { assetId: 8, cve: "CVE-2026-90001", state: "missing", detectedAt: "2026-05-13" },
  { assetId: 8, cve: "CVE-2026-90003", state: "missing", detectedAt: "2026-06-03" },
  { assetId: 9, cve: "CVE-2026-90006", state: "missing", detectedAt: "2026-04-01" },
  { assetId: 10, cve: "CVE-2026-90011", state: "missing", detectedAt: "2026-05-06" },
  { assetId: 11, cve: "CVE-2026-90009", state: "missing", detectedAt: "2026-01-23" },
  { assetId: 12, cve: "CVE-2026-90012", state: "missing", detectedAt: "2026-06-21" },
  { assetId: 12, cve: "CVE-2026-90006", state: "installed", detectedAt: "2026-04-05" },
  { assetId: 13, cve: "CVE-2026-90001", state: "missing", detectedAt: "2026-05-14" },
  { assetId: 13, cve: "CVE-2026-90011", state: "missing", detectedAt: "2026-05-06" },
  { assetId: 14, cve: "CVE-2026-90007", state: "missing", detectedAt: "2026-02-21" },
];

// ── Change freezes ───────────────────────────────────────────────────────────

export interface ChangeFreeze {
  id: number;
  code: string;
  name: string;
  startsAt: string;
  endsAt: string;
  /** NULL = every service, including assets with no service at all. */
  serviceId: number | null;
  reason: string;
}

/**
 * ⚠ THE DATE BOUND IS THE TRAP, NOT THE FREEZE.
 *
 * FRZ-3 ended in May and is still a row. `WHERE EXISTS (SELECT 1 FROM
 * change_freezes)` defers every remediation for ever and reports it as correct
 * behaviour. That is `legal_demo`'s date-bounded notice suppression in a fourth
 * domain, and it is the single easiest mistake to make against this table.
 *
 * FRZ-2 is scoped to one service, so "a freeze is on" must not stop work
 * everywhere; FRZ-1 is org-wide, so at the default as-of instant everything
 * defers and NOTHING is dropped.
 */
export const CHANGE_FREEZES: ChangeFreeze[] = [
  { id: 1, code: "FRZ-1", name: "Quarter close", startsAt: "2026-06-26T18:00:00Z", endsAt: "2026-07-01T06:00:00Z", serviceId: null, reason: "Financial quarter close. No production change without a major-incident bridge." },
  { id: 2, code: "FRZ-2", name: "Payments card-scheme audit", startsAt: "2026-06-14T00:00:00Z", endsAt: "2026-06-16T12:00:00Z", serviceId: 1, reason: "On-site audit of the payment path. Payments assets only." },
  { id: 3, code: "FRZ-3", name: "Spring datacentre migration", startsAt: "2026-05-01T00:00:00Z", endsAt: "2026-05-04T08:00:00Z", serviceId: null, reason: "Completed. Present so that an unbounded EXISTS over this table is wrong." },
];

// ── Lookups ──────────────────────────────────────────────────────────────────

const teamById = new Map(TEAMS.map((t) => [t.id, t]));
const serviceById = new Map(SERVICES.map((s) => [s.id, s]));
const assetById = new Map(ASSETS.map((a) => [a.id, a]));
const vulnByCve = new Map(VULNERABILITIES.map((v) => [v.cve, v]));
const pausesByIncident = new Map<number, IncidentPause[]>();
for (const p of INCIDENT_PAUSES) {
  const list = pausesByIncident.get(p.incidentId) ?? [];
  list.push(p);
  pausesByIncident.set(p.incidentId, list);
}

export function orgSetting(key: string): string {
  const found = ORG_SETTINGS.find((s) => s.key === key);
  if (!found) throw new Error(`itops dataset: no org setting "${key}"`);
  return found.value;
}

/**
 * ⚠ THE TWO-COLUMN LOOKUP, and the only one in this file.
 *
 * There is deliberately no `policyForPriority(priority)` overload. A convenience
 * that takes one half of a composite key is the exact mistake T3 exists to catch,
 * and offering it here would put the bug inside the oracle.
 */
export function slaPolicy(tier: Tier, priority: Priority): SlaPolicy {
  const found = SLA_POLICIES.find((p) => p.tier === tier && p.priority === priority);
  if (!found) throw new Error(`itops dataset: no SLA policy for ${tier}/${priority}`);
  return found;
}

/** ⚠ T8's two-level hop: the team's own address, then the org default. Never null. */
export function escalationRecipient(team: Team): { email: string; viaOrgFallback: boolean } {
  return team.escalationEmail
    ? { email: team.escalationEmail, viaOrgFallback: false }
    : { email: orgSetting("escalation_fallback_email"), viaOrgFallback: true };
}

// ── Bands ────────────────────────────────────────────────────────────────────

export type Band = "breached" | "at_risk" | "healthy";

/**
 * ⚠ The fraction is INCLUSIVE at both bounds and read from `AT_RISK_FRACTION`.
 *
 * `>=`, not `>`: INC-1020 sits exactly on 0.80 at the default instant, and an
 * exclusive bound leaves it healthy with nobody warned. Never rewrite this in
 * minutes — 80% of a platinum P1 is 48 minutes and 80% of a bronze P4 is 5,760.
 */
export function bandFor(consumedMins: number, resolveMins: number): Band {
  const fraction = consumedMins / resolveMins;
  if (fraction >= 1) return "breached";
  if (fraction >= AT_RISK_FRACTION) return "at_risk";
  return "healthy";
}

// ── The SLA computation ──────────────────────────────────────────────────────

export interface IncidentSlaRow {
  incidentCode: string;
  serviceCode: string;
  serviceName: string;
  tier: Tier;
  priority: Priority;
  summary: string;
  businessHoursOnly: boolean;
  ownerTeamCode: string;
  ownerTeamName: string;
  respondMins: number;
  resolveMins: number;
  openedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  /** Resolved AT OR BEFORE the as-of instant. An incident resolved later is still open here. */
  resolvedByAsOf: boolean;
  /** The correct figure: the service's own clock, less paused time on that same clock. */
  consumedMins: number;
  /** What `resolved_at - opened_at` gives. Kept so the oracle can SHOW the gap. */
  naiveElapsedMins: number;
  pausedMins: number;
  fraction: number;
  band: Band;
  /** The band the naive arithmetic would have produced. */
  naiveBand: Band;
  /** ⚠ The evidence for T1/T2: the two arithmetics reach different ANSWERS. */
  disagrees: boolean;
  /** ⚠ The evidence for T3: some other tier's row for this priority changes the band. */
  tierSensitive: boolean;
  respondConsumedMins: number;
  unacknowledged: boolean;
  /** Resolved per band. `null` on the healthy arm — a digest has no per-incident recipient. */
  recipientEmail: string | null;
  escalatedViaOrgFallback: boolean;
}

/** Minutes of a pause that fall inside [from, to), on the service's own clock. */
function pausedOnClock(
  incident: Incident,
  from: string,
  to: string,
  businessHoursOnly: boolean,
): number {
  let total = 0;
  for (const p of pausesByIncident.get(incident.id) ?? []) {
    // An open pause runs to the end of the measured window, which is the case
    // INC-1025 exists for.
    const start = p.startedAt > from ? p.startedAt : from;
    const rawEnd = p.endedAt ?? to;
    const end = rawEnd < to ? rawEnd : to;
    if (end <= start) continue;
    total += clockMinutes(start, end, businessHoursOnly);
  }
  return total;
}

/**
 * ⚠ REFUSES an incident that had not been raised yet.
 *
 * Without the throw it returns a consumed time of zero, which reads as a
 * perfectly healthy incident rather than as a caller mistake — and a band of
 * `healthy` computed over an incident that does not exist is the quiet kind of
 * wrong answer this whole dataset is built to catch. `itopsOracle` filters on
 * `openedAt <= asOf` before it gets here.
 */
export function incidentSla(incident: Incident, asOf: string): IncidentSlaRow {
  if (incident.openedAt > asOf) {
    throw new Error(`itops oracle: ${incident.code} was not raised until ${incident.openedAt} (as of ${asOf})`);
  }
  const service = serviceById.get(incident.serviceId)!;
  const team = teamById.get(service.ownerTeamId)!;
  const policy = slaPolicy(service.tier, incident.priority);

  const resolvedByAsOf = incident.resolvedAt !== null && incident.resolvedAt <= asOf;
  const end = resolvedByAsOf ? incident.resolvedAt! : asOf;

  const grossMins = clockMinutes(incident.openedAt, end, service.businessHoursOnly);
  const pausedMins = pausedOnClock(incident, incident.openedAt, end, service.businessHoursOnly);
  // ⚠ Clamped at zero. Subtracting a RAW pause duration from a BUSINESS-HOURS
  // elapsed figure can go negative — a weekend pause removes no business
  // minutes at all — and a negative consumed time reads as a healthy incident.
  // Clamping here does not hide that mistake, because both clocks are the
  // service's own; it is a floor on arithmetic, not a repair.
  const consumedMins = Math.max(0, grossMins - pausedMins);

  const naiveElapsedMins = elapsedMinutes(incident.openedAt, end);

  const band = bandFor(consumedMins, policy.resolveMins);
  const naiveBand = bandFor(naiveElapsedMins, policy.resolveMins);

  // T3's evidence, computed rather than declared: would ANY other tier's row for
  // this priority have produced a different band?
  const tierSensitive = SLA_POLICIES.filter(
    (p) => p.priority === incident.priority && p.tier !== service.tier,
  ).some((p) => bandFor(consumedMins, p.resolveMins) !== band);

  const ackBy =
    incident.acknowledgedAt !== null && incident.acknowledgedAt <= asOf
      ? incident.acknowledgedAt
      : null;
  const respondConsumedMins = clockMinutes(
    incident.openedAt,
    ackBy ?? asOf,
    service.businessHoursOnly,
  );
  const unacknowledged =
    ackBy === null && !resolvedByAsOf && respondConsumedMins > policy.respondMins;

  const escalation = escalationRecipient(team);
  const recipientEmail =
    band === "breached" ? escalation.email : band === "at_risk" ? team.contactEmail : null;

  return {
    incidentCode: incident.code,
    serviceCode: service.code,
    serviceName: service.name,
    tier: service.tier,
    priority: incident.priority,
    summary: incident.summary,
    businessHoursOnly: service.businessHoursOnly,
    ownerTeamCode: team.code,
    ownerTeamName: team.name,
    respondMins: policy.respondMins,
    resolveMins: policy.resolveMins,
    openedAt: incident.openedAt,
    acknowledgedAt: incident.acknowledgedAt,
    resolvedAt: incident.resolvedAt,
    resolvedByAsOf,
    consumedMins,
    naiveElapsedMins,
    pausedMins,
    fraction: consumedMins / policy.resolveMins,
    band,
    naiveBand,
    disagrees: band !== naiveBand,
    tierSensitive,
    respondConsumedMins,
    unacknowledged,
    recipientEmail,
    escalatedViaOrgFallback: band === "breached" && escalation.viaOrgFallback,
  };
}

// ── Vulnerability remediation ────────────────────────────────────────────────

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export interface VulnRow {
  cve: string;
  title: string;
  severity: Severity;
  cvss: number;
  kev: boolean;
  hostname: string;
  environment: "prod" | "nonprod";
  serviceCode: string | null;
  ownerTeamCode: string;
  ownerTeamEmail: string;
  detectedAt: string;
  assetStale: boolean;
  /** ⚠ T6. Non-null means DEFERRED, never dropped, and this is when it may proceed. */
  deferredUntil: string | null;
  blockedByFreeze: string | null;
}

/**
 * ⚠ KEV FIRST, SEVERITY SECOND. This ordering is the whole of T5.
 *
 * `ORDER BY severity DESC` is the natural thing to write and it buries
 * CVE-2026-90003 — a `medium` under active exploitation — beneath two criticals
 * that nobody is attacking. If a reader thinks this comparator looks wrong,
 * that reaction IS the trap, and the fix is to read `kev`.
 */
export function compareVulns(a: VulnRow, b: VulnRow): number {
  if (a.kev !== b.kev) return a.kev ? -1 : 1;
  const rank = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (rank !== 0) return rank;
  if (b.cvss !== a.cvss) return b.cvss - a.cvss;
  return a.cve.localeCompare(b.cve) || a.hostname.localeCompare(b.hostname);
}

export function isAssetStale(asset: Asset, asOf: string): boolean {
  if (!asset.lastSeenAt) return true;
  return daysBetween(asset.lastSeenAt, asOf) > STALE_ASSET_DAYS;
}

/** Freezes in force at the instant. ⚠ Half-open: `startsAt <= asOf < endsAt`. */
export function activeFreezes(asOf: string): ChangeFreeze[] {
  return CHANGE_FREEZES.filter((f) => f.startsAt <= asOf && asOf < f.endsAt);
}

// ── The oracle ───────────────────────────────────────────────────────────────

export interface OnCallRow {
  teamCode: string;
  personName: string;
  personEmail: string;
  escalationTo: string | null;
}

export interface ItopsOracle {
  asOf: string;
  atRiskFraction: number;

  /** Every incident that exists at the instant, ordered by code. */
  incidents: IncidentSlaRow[];
  open: IncidentSlaRow[];
  breached: IncidentSlaRow[];
  atRisk: IncidentSlaRow[];
  healthy: IncidentSlaRow[];
  /** Resolved by the instant AND over budget on the correct arithmetic. */
  resolvedBreaches: IncidentSlaRow[];
  unacknowledged: IncidentSlaRow[];
  bandCounts: Record<Band, number>;

  /** Codes where the naive and the correct arithmetic reach different bands. */
  disagreements: string[];
  /** Codes where some other tier's budget for the same priority changes the band. */
  tierSensitive: string[];
  /** Breaches whose recipient came from the org fallback rather than the team. */
  orgFallbackEscalations: string[];

  onCall: OnCallRow[];
  /** ⚠ Teams with NOBODY on call at this instant. Never an empty concept. */
  teamsWithNoOnCall: string[];

  staleAssets: string[];
  actionableVulns: VulnRow[];
  deferredVulns: VulnRow[];
  proceedingVulns: VulnRow[];
  activeFreezes: string[];
  /** T4's evidence: `critical` findings that are NOT production. */
  nonprodCriticals: string[];
  /** T7's evidence: findings excluded because no fix exists. */
  noFixAvailable: string[];
}

/**
 * The correct answer, computed from the definitions above and from nothing else.
 *
 * Never make this read the database, and never let it import another domain's
 * oracle. Both turn the second implementation that makes agreement meaningful
 * into a second copy of the same mistake.
 */
export function itopsOracle(asOf: string = ITOPS_DEFAULT_AS_OF): ItopsOracle {
  const incidents = INCIDENTS.filter((i) => i.openedAt <= asOf)
    .map((i) => incidentSla(i, asOf))
    .sort((a, b) => a.incidentCode.localeCompare(b.incidentCode));

  const open = incidents.filter((i) => !i.resolvedByAsOf);
  const breached = open.filter((i) => i.band === "breached");
  const atRisk = open.filter((i) => i.band === "at_risk");
  const healthy = open.filter((i) => i.band === "healthy");
  const resolvedBreaches = incidents.filter(
    (i) => i.resolvedByAsOf && i.consumedMins > i.resolveMins,
  );

  const freezes = activeFreezes(asOf);

  const actionableVulns: VulnRow[] = [];
  const nonprodCriticals: string[] = [];
  const noFixAvailable: string[] = [];

  for (const av of ASSET_VULNERABILITIES) {
    if (av.state !== "missing") continue;
    const asset = assetById.get(av.assetId)!;
    const vuln = vulnByCve.get(av.cve)!;
    const team = teamById.get(asset.ownerTeamId)!;
    const service = asset.serviceId === null ? null : serviceById.get(asset.serviceId)!;

    if (vuln.severity === "critical" && asset.environment !== "prod") {
      nonprodCriticals.push(`${av.cve}@${asset.hostname}`);
    }
    // T4: production only. A critical on a sandbox is not a page.
    if (asset.environment !== "prod") continue;
    // T7: there is nothing to apply.
    if (!vuln.fixAvailable) {
      noFixAvailable.push(`${av.cve}@${asset.hostname}`);
      continue;
    }

    // T6. An org-wide freeze (`serviceId` null) covers every asset, INCLUDING
    // one with no service at all; a scoped freeze covers only its own service.
    const applicable = freezes.filter(
      (f) => f.serviceId === null || f.serviceId === asset.serviceId,
    );
    const blocking = applicable.sort((a, b) => (a.endsAt < b.endsAt ? 1 : -1))[0] ?? null;

    actionableVulns.push({
      cve: vuln.cve,
      title: vuln.title,
      severity: vuln.severity,
      cvss: vuln.cvss,
      kev: vuln.kev,
      hostname: asset.hostname,
      environment: asset.environment,
      serviceCode: service?.code ?? null,
      ownerTeamCode: team.code,
      ownerTeamEmail: team.contactEmail,
      detectedAt: av.detectedAt,
      assetStale: isAssetStale(asset, asOf),
      deferredUntil: blocking?.endsAt ?? null,
      blockedByFreeze: blocking?.code ?? null,
    });
  }
  actionableVulns.sort(compareVulns);

  const onCall: OnCallRow[] = ON_CALL.filter((s) => s.startsAt <= asOf && asOf < s.endsAt)
    .map((s) => ({
      teamCode: teamById.get(s.teamId)!.code,
      personName: s.personName,
      personEmail: s.personEmail,
      escalationTo: s.escalationTo,
    }))
    .sort((a, b) => a.teamCode.localeCompare(b.teamCode));

  const covered = new Set(onCall.map((o) => o.teamCode));

  return {
    asOf,
    atRiskFraction: AT_RISK_FRACTION,
    incidents,
    open,
    breached,
    atRisk,
    healthy,
    resolvedBreaches,
    unacknowledged: incidents.filter((i) => i.unacknowledged),
    bandCounts: {
      breached: breached.length,
      at_risk: atRisk.length,
      healthy: healthy.length,
    },
    disagreements: incidents.filter((i) => i.disagrees).map((i) => i.incidentCode),
    tierSensitive: incidents.filter((i) => i.tierSensitive).map((i) => i.incidentCode),
    orgFallbackEscalations: breached
      .filter((i) => i.escalatedViaOrgFallback)
      .map((i) => i.incidentCode),
    onCall,
    teamsWithNoOnCall: TEAMS.filter((t) => !covered.has(t.code))
      .map((t) => t.code)
      .sort(),
    staleAssets: ASSETS.filter((a) => isAssetStale(a, asOf))
      .map((a) => a.hostname)
      .sort(),
    actionableVulns,
    deferredVulns: actionableVulns.filter((v) => v.deferredUntil !== null),
    proceedingVulns: actionableVulns.filter((v) => v.deferredUntil === null),
    activeFreezes: freezes.map((f) => f.code).sort(),
    nonprodCriticals: nonprodCriticals.sort(),
    noFixAvailable: noFixAvailable.sort(),
  };
}
