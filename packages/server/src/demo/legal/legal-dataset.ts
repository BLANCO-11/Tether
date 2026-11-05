/**
 * The Legal demo dataset, and the independently-computed correct answer for
 * every claim a Legal flow makes.
 *
 * ── ALL DATA IS SYNTHETIC ────────────────────────────────────────────────────
 *
 * Invented counterparties, invented people, every address on an RFC 2606
 * reserved domain that can never resolve or receive mail. Nothing here is
 * derived from a real company or a real contract. Never replace it with real
 * data.
 *
 * ── WHY THE ORACLE IS A SEPARATE FUNCTION FROM FINANCE'S AND HR'S ────────────
 *
 * `legalOracle()` is not a parameterisation of `financeOracle()` or
 * `expectedScreening()` and must never become one. The swap rehearsal
 * established the reason: a shared oracle lets a shared bug produce a wrong
 * answer that agrees with itself. Three domains with three independently written
 * oracles is the only arrangement where "the flow agreed with the oracle" is
 * evidence. `legal-dataset.test.ts` asserts this module imports nothing from
 * `../finance/`, `../hr-dataset` or `../alt/`.
 *
 * It is also computed from the DEFINITIONS BELOW, never from a query result and
 * never from a flow run. If it read the database it would be a second
 * implementation of the same SQL, and the two would be wrong together the first
 * time somebody fixed a bug in one.
 *
 * ── EVERY DATE IS A LITERAL. THERE IS NO CLOCK READ IN THIS FILE ─────────────
 *
 * A dataset whose traps move with the wall clock cannot have an oracle, and the
 * failure is invisible until the day a boundary row stops being on the boundary.
 * `legal-dataset.test.ts` greps this file for a clock read, because the absence
 * of a call is not observable at runtime.
 *
 * ── THE TRAPS, AND WHAT EACH ONE COSTS SOMEBODY WHO MISSES IT ────────────────
 *
 *  1. THE INCLUSIVE BOUNDARY, AND IT IS THE OPPOSITE OF FINANCE'S RULE.
 *     `finance_demo` teaches "due today is not overdue" (`>`). Here, a notice
 *     deadline ON the as-of date is the LAST DAY notice can be served, so it
 *     belongs in the report and in the `0-14` bucket. `<=`, not `<`. Exactly one
 *     contract sits on it at each as-of date: C-2025-004 at 2026-04-30,
 *     C-2025-005 at 2026-05-31, C-2026-008 at 2026-06-30. A developer carrying
 *     Finance's `<` across silently drops the one contract still saveable.
 *  2. THE TWO-LEVEL NOTICE FALLBACK. contract -> contract type -> org default.
 *     C-2024-001 needs BOTH hops (NULL on an `msa`, whose type default is also
 *     NULL) and is the HIGHEST-VALUE contract in the dataset, so a COALESCE that
 *     stops at the type level loses precisely the expensive one. C-2026-002
 *     exercises the middle hop alone, and the org default (45) is deliberately
 *     DIFFERENT from every type default, so a query that skips straight to
 *     `org_settings` gets C-2026-002 wrong by 15 days. Both shortcuts are caught
 *     by a specific contract -- which the first version of this dataset did not
 *     manage, because org and `saas` were both 60.
 *  3. THE EVERGREEN CONTRACT (C-2019-012, `end_date` NULL). No renewal date
 *     exists. It must be excluded by an explicit predicate; NULL date arithmetic
 *     sorts it to the top of a "most urgent" list rather than dropping it.
 *  4. SUPERSESSION (C-2023-013 -> C-2026-014). The successor holds the live
 *     dates. Reporting the superseded row chases a counterparty about a contract
 *     that no longer governs -- and its deadline (2026-07-02) lands inside a
 *     reporting window, so the exclusion is load-bearing rather than incidental.
 *     The negative control is C-2025-015 / C-2025-016: same title prefix,
 *     DIFFERENT counterparties, no chain. A rule keyed on the title flags them.
 *  5. THE AUTO-RENEW INVERSION -- the load-bearing one. Same date arithmetic,
 *     one boolean, two opposite actions and two opposite recipients. See
 *     `legal-schema.sql`'s header. Resolved STRUCTURALLY by two named queries.
 *  6. THE OBLIGATION OWNER FALLBACK. OBL-003 has no owner of its own and must
 *     resolve to its contract's. Without the COALESCE the reminder goes nowhere.
 *  7. STALE STATUS AND SETTLED STATUS. OBL-004 has a completion row and still
 *     reads `open` -- completion comes from `obligation_completions`, never from
 *     `status`. OBL-005 is `waived` and past due: settled is settled, and it must
 *     never be chased however overdue.
 *  8. DATE-BOUNDED SUPPRESSION. C-2025-010 was noticed inside the current
 *     window (suppress) and C-2024-011 was noticed in a PRIOR cycle (notify
 *     again). An `EXISTS` over `notice_log` with no date bound suppresses
 *     C-2024-011 and it auto-renews in silence.
 *  9. UNMAILABLE AND BOUNCING COUNTERPARTIES. CP-BRIGHT has no address at all;
 *     CP-CINDER is on a domain that always hard-bounces. Both have something
 *     actionable at the default as-of date and at no other. For a LEGAL notice an
 *     unserved send is not a failed email -- the notice period never started.
 *     That is an escalation, not a logged warning.
 *
 * ── THE ONE ELIGIBILITY RULE THAT IS NOT IN THE SPEC, AND WHY IT MATTERS ─────
 *
 * A contract that has NOT STARTED is not a renewal decision: `start_date > asOf`
 * excludes it, exactly as `financeOracle()` skips an invoice whose `issueDate`
 * is after the reporting date. It is what makes the empty case at 2026-04-30
 * possible at all -- C-2026-008 and C-2026-009 have deadlines inside April's
 * 90-day window and are absent at April only because they had not started. See
 * `session-notes.md`, "Surprises" #1, before changing it.
 */

// ── As-of dates ──────────────────────────────────────────────────────────────

/**
 * The reporting dates this dataset is tuned for.
 *
 * Like the HR and Finance datasets, the traps are tuned to the reporting date
 * and a single one does not exercise them all. Run every harness at more than
 * one:
 *
 *   2026-04-30   ZERO renewals due and ZERO obligations overdue -- the empty
 *                case, and the only date that exercises it. Scoped to the
 *                RENEWAL query: `contracts_expiring_no_autorenew` returns two
 *                rows here, and it has to. A missed or boundary auto-renew
 *                deadline at May or June necessarily lies inside April's 90-day
 *                window, so "both deadline queries empty at April" and "the
 *                buckets populated at June" cannot both be true.
 *   2026-05-31   6 renewals due (1 missed), 3 lapse-risk (1 on the boundary),
 *                1 obligation overdue.
 *   2026-06-30   The default and the richest: 9 renewals due with ALL FOUR
 *                urgency buckets populated (one of them sitting exactly ON the
 *                90-day horizon), 5 lapse-risk (3 missed), 6
 *                obligations overdue, and the only date where the unmailable and
 *                the bouncing counterparty both have something actionable.
 *
 * Three things hold at EVERY as-of date, which is what makes them assertable
 * rather than tuned: exactly one contract sits ON the notice boundary, exactly
 * one obligation's status is stale, and exactly one counterparty has zero live
 * contracts.
 */
export const LEGAL_AS_OF_DATES = ["2026-04-30", "2026-05-31", "2026-06-30"] as const;
export type LegalAsOf = (typeof LEGAL_AS_OF_DATES)[number];

/** The default reporting date. */
export const LEGAL_DEFAULT_AS_OF: LegalAsOf = "2026-06-30";

/**
 * Org-wide notice period, the LAST resort of the two-level fallback.
 *
 * ⚠ 45 AND NOT 60, AND THE ODD NUMBER IS THE WHOLE POINT. It must differ from
 * every `contract_types.default_notice_period_days`, or the two-level fallback is
 * not discriminating and both single-level shortcuts pass anyway:
 *
 *   COALESCE(contract, org_default)  -- skips the TYPE level. Wrong for
 *     C-2026-002 (`saas`, 60): it resolves 45 and the deadline moves 15 days.
 *   COALESCE(contract, type_default) -- skips THIS level. Wrong for C-2024-001
 *     (`msa`, NULL): it resolves NULL, the comparison is NULL, and the most
 *     valuable contract in the dataset silently vanishes from the report.
 *
 * `legal-dataset.test.ts` asserts the middle hop resolves to something OTHER
 * than this constant, which is what caught the first version where both were 60
 * and neither shortcut could be detected.
 */
export const DEFAULT_NOTICE_PERIOD_DAYS = 45;

/** How far ahead a renewal watchlist looks by default. */
export const DEFAULT_LOOKAHEAD_DAYS = 90;

/**
 * The domain that always hard-bounces.
 *
 * ops-api matches the SUFFIX `-bounce.example` (`isBouncingAddress`), not a
 * literal, so a third dataset's undeliverable address bounces without a third
 * constant on that side.
 */
export const BOUNCING_DOMAIN = "cinder-analytics-bounce.example";

// ── Date helpers -- pure, UTC, no clock ──────────────────────────────────────

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

// ── Reference data ───────────────────────────────────────────────────────────

export interface OrgSetting {
  key: string;
  value: string;
  description: string;
}

export const ORG_SETTINGS: OrgSetting[] = [
  {
    key: "default_notice_period_days",
    value: String(DEFAULT_NOTICE_PERIOD_DAYS),
    description:
      "Notice period when neither the contract nor its type states one. The LAST of three levels: contract -> contract type -> here.",
  },
  {
    key: "renewal_lookahead_days",
    value: String(DEFAULT_LOOKAHEAD_DAYS),
    description: "How far ahead a renewal watchlist looks from the as-of date.",
  },
  {
    key: "obligation_reminder_lead_days",
    value: "14",
    description: "How far ahead an obligation reminder is sent to its owner.",
  },
  {
    key: "default_governing_law",
    value: "Delaware, USA",
    description: "Governing law used where a contract states none.",
  },
];

export interface LegalEntity {
  id: number;
  code: string;
  name: string;
  jurisdiction: string;
}

export const LEGAL_ENTITIES: LegalEntity[] = [
  { id: 1, code: "LE-US", name: "Acme Technologies Inc.", jurisdiction: "Delaware, USA" },
  { id: 2, code: "LE-UK", name: "Acme Technologies Ltd.", jurisdiction: "England and Wales" },
];

export interface Counterparty {
  id: number;
  code: string;
  name: string;
  /** NULL for the one counterparty with no notice address on record. */
  contactEmail: string | null;
  country: string;
  /** Soft reference to finance_demo.vendors.vendor_code. NEVER a foreign key. */
  vendorCode: string | null;
  status: "active" | "inactive";
}

export const COUNTERPARTIES: Counterparty[] = [
  { id: 1, code: "CP-NORTH", name: "Northwind Logistics LLC", contactEmail: "contracts@northwind-logistics.example", country: "United States", vendorCode: "V-NWL", status: "active" },
  { id: 2, code: "CP-ORCH", name: "Orchard Data Systems GmbH", contactEmail: "legal@orchard-data.example", country: "Germany", vendorCode: "V-ODS", status: "active" },
  { id: 3, code: "CP-HARBOR", name: "Harbour Legal Partners", contactEmail: "contracts@harbour-legal.example", country: "United Kingdom", vendorCode: "V-HLP", status: "active" },
  // TRAP 9a -- no notice address at all. Never pass a null recipient to the mail
  // tool; report it by another channel and escalate.
  { id: 4, code: "CP-BRIGHT", name: "Brightpath Consulting", contactEmail: null, country: "United States", vendorCode: "V-BPC", status: "active" },
  { id: 5, code: "CP-STONE", name: "Stonebridge Facilities", contactEmail: "estates@stonebridge-facilities.example", country: "United Kingdom", vendorCode: null, status: "active" },
  { id: 6, code: "CP-VERT", name: "Verdant Cloud Services", contactEmail: "billing@verdant-cloud.example", country: "Ireland", vendorCode: "V-VCS", status: "active" },
  // TRAP 9b -- always hard-bounces. A 202 from the mail tool means NOTHING was
  // delivered, and for a legal notice that means the notice period never started.
  { id: 7, code: "CP-CINDER", name: "Cinder Analytics", contactEmail: `notices@${BOUNCING_DOMAIN}`, country: "United States", vendorCode: "V-CAN", status: "active" },
  { id: 8, code: "CP-KESTREL", name: "Kestrel Print & Media", contactEmail: "hello@kestrel-print.example", country: "United States", vendorCode: "V-KPM", status: "active" },
  { id: 9, code: "CP-LUMEN", name: "Lumen Security Advisors", contactEmail: "contracts@lumen-security.example", country: "Canada", vendorCode: null, status: "active" },
  { id: 10, code: "CP-QUAY", name: "Quayside Staffing", contactEmail: "admin@quayside-staffing.example", country: "United Kingdom", vendorCode: "V-QSS", status: "active" },
  // TRAP 9c -- the EMPTY-GROUP case. It has a contract row, but no LIVE one, so
  // an inner join on live contracts drops it entirely. A counterparty whose
  // contracts have all lapsed is exactly what a summary exists to surface.
  { id: 11, code: "CP-DORMANT", name: "Dormant Holdings Co", contactEmail: "archive@dormant-holdings.example", country: "United States", vendorCode: null, status: "inactive" },
];

export interface ContractType {
  id: number;
  code: string;
  name: string;
  /** NULL for two of the six -- the MIDDLE hop of the two-level fallback. */
  defaultNoticePeriodDays: number | null;
  requiresDpa: boolean;
}

export const CONTRACT_TYPES: ContractType[] = [
  // NULL: an MSA's notice period is always negotiated per contract, so the type
  // has no default and a contract that also states none falls all the way through
  // to org_settings. C-2024-001 is that contract.
  { id: 1, code: "msa", name: "Master Services Agreement", defaultNoticePeriodDays: null, requiresDpa: false },
  { id: 2, code: "nda", name: "Non-Disclosure Agreement", defaultNoticePeriodDays: 30, requiresDpa: false },
  { id: 3, code: "dpa", name: "Data Processing Agreement", defaultNoticePeriodDays: 30, requiresDpa: true },
  { id: 4, code: "sow", name: "Statement of Work", defaultNoticePeriodDays: 14, requiresDpa: false },
  { id: 5, code: "saas", name: "SaaS Subscription", defaultNoticePeriodDays: 60, requiresDpa: true },
  // NULL: a lease's notice period is on the lease.
  { id: 6, code: "lease", name: "Property Lease", defaultNoticePeriodDays: null, requiresDpa: false },
];

export type ContractStatus = "draft" | "active" | "expired" | "terminated" | "superseded";

export interface Contract {
  id: number;
  code: string;
  title: string;
  counterpartyId: number;
  legalEntityId: number;
  typeCode: string;
  ownerEmail: string;
  startDate: string;
  /** NULL = EVERGREEN. No renewal date exists. */
  endDate: string | null;
  autoRenew: boolean;
  renewalTermMonths: number | null;
  /** NULL = resolve via the contract type, then org_settings. */
  noticePeriodDays: number | null;
  /** MINOR units (cents). */
  valueCents: number;
  currency: string;
  status: ContractStatus;
  supersededById: number | null;
  /** NULL for a draft only. A draft is not yet a contract. */
  signedDate: string | null;
  governingLaw: string;
}

const US = 1;
const UK = 2;
const DE_LAW = "Delaware, USA";
const EW_LAW = "England and Wales";

export const CONTRACTS: Contract[] = [
  // TRAP 2 -- the TWO-HOP contract. `noticePeriodDays` NULL on type `msa`, whose
  // own default is NULL, so the notice period is the org-wide 45 and the deadline
  // is 2026-08-31. It is also the HIGHEST-VALUE contract here, by design: a
  // COALESCE that stops at the type level resolves NULL for it, and the most
  // valuable contract in the dataset silently vanishes from the report.
  { id: 1, code: "C-2024-001", title: "Master Services Agreement — Northwind Logistics", counterpartyId: 1, legalEntityId: US, typeCode: "msa", ownerEmail: "contracts.lead@acme-legal.example", startDate: "2024-07-01", endDate: "2026-10-15", autoRenew: true, renewalTermMonths: 12, noticePeriodDays: null, valueCents: 48_000_000, currency: "USD", status: "active", supersededById: null, signedDate: "2024-06-20", governingLaw: DE_LAW },

  // TRAP 2, middle hop ALONE: NULL on type `saas`, which defaults to 60 -- and 60
  // is deliberately NOT the org-wide 45, so a COALESCE that skips the type level
  // resolves 45 here and moves the deadline by 15 days.
  // Starts 2026-05-10, so it is absent at 2026-04-30 (not yet in force) even
  // though its deadline 2026-07-20 is inside April's window.
  { id: 2, code: "C-2026-002", title: "SaaS Subscription — Verdant Cloud Services", counterpartyId: 6, legalEntityId: US, typeCode: "saas", ownerEmail: "eng.lead@acme-legal.example", startDate: "2026-05-10", endDate: "2026-09-18", autoRenew: true, renewalTermMonths: 12, noticePeriodDays: null, valueCents: 9_600_000, currency: "USD", status: "active", supersededById: null, signedDate: "2026-04-24", governingLaw: DE_LAW },

  // Outside every window (deadline 2026-10-31). A dataset where everything is in
  // the window cannot show that the window predicate works.
  { id: 3, code: "C-2025-003", title: "Data Processing Agreement — Orchard Data Systems", counterpartyId: 2, legalEntityId: UK, typeCode: "dpa", ownerEmail: "security.lead@acme-legal.example", startDate: "2025-09-15", endDate: "2026-11-30", autoRenew: true, renewalTermMonths: 12, noticePeriodDays: 30, valueCents: 1_200_000, currency: "USD", status: "active", supersededById: null, signedDate: "2025-09-01", governingLaw: EW_LAW },

  // TRAP 1 -- ON THE BOUNDARY at 2026-04-30 (end 2026-07-29 less 90 days).
  // Non-auto-renewing, so the lapse warning goes INWARD to facilities@.
  // Missed at 2026-05-31 and 2026-06-30, where it exercises the `missed` bucket.
  { id: 4, code: "C-2025-004", title: "Property Lease — Stonebridge Facilities (Bristol)", counterpartyId: 5, legalEntityId: UK, typeCode: "lease", ownerEmail: "facilities@acme-legal.example", startDate: "2025-04-01", endDate: "2026-07-29", autoRenew: false, renewalTermMonths: null, noticePeriodDays: 90, valueCents: 21_600_000, currency: "USD", status: "active", supersededById: null, signedDate: "2025-03-10", governingLaw: EW_LAW },

  // TRAP 1 -- ON THE BOUNDARY at 2026-05-31 (end 2026-06-30 less 30 days).
  { id: 5, code: "C-2025-005", title: "Statement of Work — Quayside Staffing (Phase 2)", counterpartyId: 10, legalEntityId: UK, typeCode: "sow", ownerEmail: "procurement@acme-legal.example", startDate: "2025-12-01", endDate: "2026-06-30", autoRenew: false, renewalTermMonths: null, noticePeriodDays: 30, valueCents: 4_500_000, currency: "USD", status: "active", supersededById: null, signedDate: "2025-11-20", governingLaw: EW_LAW },

  // TRAP 9a lives here -- CP-BRIGHT has no notice address, and this contract is
  // in the renewal window at the default as-of date, so a flow must handle it.
  { id: 6, code: "C-2025-006", title: "Consulting Agreement — Brightpath Consulting", counterpartyId: 4, legalEntityId: US, typeCode: "msa", ownerEmail: "procurement@acme-legal.example", startDate: "2025-05-01", endDate: "2026-11-15", autoRenew: true, renewalTermMonths: 12, noticePeriodDays: 90, valueCents: 7_800_000, currency: "USD", status: "active", supersededById: null, signedDate: "2025-04-18", governingLaw: DE_LAW },

  // TRAP 9b lives here -- CP-CINDER always hard-bounces, and this contract is in
  // the renewal window at the default as-of date.
  { id: 7, code: "C-2025-007", title: "SaaS Subscription — Cinder Analytics", counterpartyId: 7, legalEntityId: US, typeCode: "saas", ownerEmail: "eng.lead@acme-legal.example", startDate: "2025-06-01", endDate: "2026-10-05", autoRenew: true, renewalTermMonths: 12, noticePeriodDays: 60, valueCents: 3_600_000, currency: "USD", status: "active", supersededById: null, signedDate: "2025-05-15", governingLaw: DE_LAW },

  // TRAP 1 + TRAP 5 -- ON THE BOUNDARY at the DEFAULT as-of date 2026-06-30, and
  // AUTO-RENEWING, which is what puts the inclusive-boundary trap in
  // `contracts_renewal_due` rather than only in the internal-facing query.
  // Starts 2026-05-01, so it is absent at 2026-04-30 and the empty case survives.
  { id: 8, code: "C-2026-008", title: "SaaS Pilot — Lumen Security Advisors", counterpartyId: 9, legalEntityId: US, typeCode: "saas", ownerEmail: "security.lead@acme-legal.example", startDate: "2026-05-01", endDate: "2026-08-29", autoRenew: true, renewalTermMonths: 12, noticePeriodDays: 60, valueCents: 1_800_000, currency: "USD", status: "active", supersededById: null, signedDate: "2026-04-20", governingLaw: DE_LAW },

  // The MISSED auto-renew deadline (2026-05-20) -- the `missed` bucket in the
  // renewal query. Starts 2026-05-05, so it is absent at 2026-04-30.
  { id: 9, code: "C-2026-009", title: "Print & Media Framework — Kestrel Print & Media", counterpartyId: 8, legalEntityId: US, typeCode: "msa", ownerEmail: "procurement@acme-legal.example", startDate: "2026-05-05", endDate: "2026-08-18", autoRenew: true, renewalTermMonths: 12, noticePeriodDays: 90, valueCents: 2_400_000, currency: "USD", status: "active", supersededById: null, signedDate: "2026-04-28", governingLaw: DE_LAW },

  // TRAP 8a -- ALREADY NOTICED inside the current window (notice_log, 2026-06-20).
  // A second reminder is duplicate contact with a counterparty.
  { id: 10, code: "C-2025-010", title: "Logistics Services Agreement — Northwind Logistics", counterpartyId: 1, legalEntityId: US, typeCode: "msa", ownerEmail: "contracts.lead@acme-legal.example", startDate: "2025-02-01", endDate: "2026-10-31", autoRenew: true, renewalTermMonths: 12, noticePeriodDays: 60, valueCents: 6_000_000, currency: "USD", status: "active", supersededById: null, signedDate: "2025-01-20", governingLaw: DE_LAW },

  // TRAP 8b -- the NEGATIVE CONTROL for suppression. Its only notice is from the
  // PRIOR cycle (2025-08-10). An `EXISTS` with no date bound suppresses this
  // contract and it auto-renews in silence.
  { id: 11, code: "C-2024-011", title: "Cloud Hosting Agreement — Verdant Cloud Services", counterpartyId: 6, legalEntityId: US, typeCode: "saas", ownerEmail: "eng.lead@acme-legal.example", startDate: "2024-09-01", endDate: "2026-10-20", autoRenew: true, renewalTermMonths: 12, noticePeriodDays: 60, valueCents: 5_400_000, currency: "USD", status: "active", supersededById: null, signedDate: "2024-08-15", governingLaw: DE_LAW },

  // TRAP 3 -- EVERGREEN. No end date, so no renewal and no deadline.
  { id: 12, code: "C-2019-012", title: "Mutual Non-Disclosure Agreement — Harbour Legal Partners", counterpartyId: 3, legalEntityId: UK, typeCode: "nda", ownerEmail: "legal.ops@acme-legal.example", startDate: "2019-06-01", endDate: null, autoRenew: false, renewalTermMonths: null, noticePeriodDays: null, valueCents: 0, currency: "USD", status: "active", supersededById: null, signedDate: "2019-05-20", governingLaw: EW_LAW },

  // TRAP 4 -- SUPERSEDED. Its deadline would be 2026-07-02, inside a reporting
  // window, so excluding it is load-bearing rather than incidental.
  { id: 13, code: "C-2023-013", title: "Master Services Agreement — Orchard Data Systems (2023)", counterpartyId: 2, legalEntityId: UK, typeCode: "msa", ownerEmail: "contracts.lead@acme-legal.example", startDate: "2023-01-01", endDate: "2026-08-31", autoRenew: true, renewalTermMonths: 12, noticePeriodDays: 60, valueCents: 15_000_000, currency: "USD", status: "superseded", supersededById: 14, signedDate: "2022-12-15", governingLaw: EW_LAW },

  // The successor. It holds the live dates.
  { id: 14, code: "C-2026-014", title: "Master Services Agreement — Orchard Data Systems (2026)", counterpartyId: 2, legalEntityId: UK, typeCode: "msa", ownerEmail: "contracts.lead@acme-legal.example", startDate: "2026-01-01", endDate: "2027-12-31", autoRenew: true, renewalTermMonths: 12, noticePeriodDays: 60, valueCents: 18_000_000, currency: "USD", status: "active", supersededById: null, signedDate: "2025-12-10", governingLaw: EW_LAW },

  // TRAP 4, NEGATIVE CONTROL -- 15 and 16 share a title prefix and have DIFFERENT
  // counterparties. A supersession rule keyed on the title flags them; only
  // `superseded_by_id` establishes a chain.
  { id: 15, code: "C-2025-015", title: "Facilities Support Agreement — Stonebridge Facilities", counterpartyId: 5, legalEntityId: UK, typeCode: "msa", ownerEmail: "facilities@acme-legal.example", startDate: "2025-10-01", endDate: "2027-03-31", autoRenew: true, renewalTermMonths: 12, noticePeriodDays: 60, valueCents: 3_000_000, currency: "USD", status: "active", supersededById: null, signedDate: "2025-09-15", governingLaw: EW_LAW },
  { id: 16, code: "C-2025-016", title: "Facilities Support Agreement — Quayside Staffing", counterpartyId: 10, legalEntityId: UK, typeCode: "msa", ownerEmail: "facilities@acme-legal.example", startDate: "2025-11-01", endDate: "2027-04-30", autoRenew: true, renewalTermMonths: 12, noticePeriodDays: 60, valueCents: 2_100_000, currency: "USD", status: "active", supersededById: null, signedDate: "2025-10-12", governingLaw: EW_LAW },

  // A DRAFT -- no signed date. Not yet a contract, so it belongs in no report.
  { id: 17, code: "C-2026-017", title: "Statement of Work — Lumen Security Advisors (Assessment)", counterpartyId: 9, legalEntityId: US, typeCode: "sow", ownerEmail: "security.lead@acme-legal.example", startDate: "2026-08-01", endDate: "2026-12-31", autoRenew: false, renewalTermMonths: null, noticePeriodDays: 14, valueCents: 1_500_000, currency: "USD", status: "draft", supersededById: null, signedDate: null, governingLaw: DE_LAW },

  // TERMINATED. Its deadline (2026-07-12) lands inside April's window, so the
  // status exclusion has to do real work.
  { id: 18, code: "C-2024-018", title: "Analytics Services Agreement — Cinder Analytics", counterpartyId: 7, legalEntityId: US, typeCode: "msa", ownerEmail: "eng.lead@acme-legal.example", startDate: "2024-03-01", endDate: "2026-09-10", autoRenew: true, renewalTermMonths: 12, noticePeriodDays: 60, valueCents: 2_700_000, currency: "USD", status: "terminated", supersededById: null, signedDate: "2024-02-14", governingLaw: DE_LAW },

  // EXPIRED before every as-of date.
  { id: 19, code: "C-2023-019", title: "Print Services Agreement — Kestrel Print & Media", counterpartyId: 8, legalEntityId: US, typeCode: "msa", ownerEmail: "procurement@acme-legal.example", startDate: "2023-05-01", endDate: "2026-04-15", autoRenew: false, renewalTermMonths: null, noticePeriodDays: 30, valueCents: 900_000, currency: "USD", status: "expired", supersededById: null, signedDate: "2023-04-10", governingLaw: DE_LAW },

  // EDGE CASE -- a 90-day notice on a 2.5-month term, so the notice deadline
  // (2026-06-03) falls BEFORE the contract's own start date (2026-06-15).
  // Reportable, not an error, and `days_to_deadline` is negative: it must not
  // render as "-27 days to act" without saying the window has closed.
  { id: 20, code: "C-2026-020", title: "Short-Term Data Processing Agreement — Orchard Data Systems", counterpartyId: 2, legalEntityId: UK, typeCode: "dpa", ownerEmail: "security.lead@acme-legal.example", startDate: "2026-06-15", endDate: "2026-09-01", autoRenew: false, renewalTermMonths: null, noticePeriodDays: 90, valueCents: 600_000, currency: "USD", status: "active", supersededById: null, signedDate: "2026-06-01", governingLaw: EW_LAW },

  // ⚠ THE HORIZON CONTROL, and it exists because a perturbation test found the
  // upper bound was UNTESTABLE without it. Its deadline is 2026-09-28, which is
  // EXACTLY the horizon at the default as-of date (2026-06-30 + 90 days). So:
  //
  //     `deadline <= horizon`  -> this contract is IN the window   (correct)
  //     `deadline <  horizon`  -> this contract silently DISAPPEARS
  //
  // Before this row existed, changing `<=` to `<` in `legal-queries.ts` broke
  // nothing and `legal:verify` stayed green — the classic control that cannot
  // fail. The boundary at the as-of END of the window was covered (C-2026-008);
  // the horizon END was not. Do not move this deadline off 2026-09-28.
  { id: 21, code: "C-2025-021", title: "Security Advisory Retainer — Lumen Security Advisors", counterpartyId: 9, legalEntityId: US, typeCode: "msa", ownerEmail: "security.lead@acme-legal.example", startDate: "2025-03-01", endDate: "2026-11-27", autoRenew: true, renewalTermMonths: 12, noticePeriodDays: 60, valueCents: 4_200_000, currency: "USD", status: "active", supersededById: null, signedDate: "2025-02-18", governingLaw: DE_LAW },
  { id: 22, code: "C-2025-022", title: "Staffing Framework — Quayside Staffing", counterpartyId: 10, legalEntityId: UK, typeCode: "msa", ownerEmail: "procurement@acme-legal.example", startDate: "2025-07-01", endDate: "2026-09-25", autoRenew: false, renewalTermMonths: null, noticePeriodDays: 30, valueCents: 3_300_000, currency: "USD", status: "active", supersededById: null, signedDate: "2025-06-15", governingLaw: EW_LAW },
  { id: 23, code: "C-2025-023", title: "Property Lease — Stonebridge Facilities (Leeds)", counterpartyId: 5, legalEntityId: UK, typeCode: "lease", ownerEmail: "facilities@acme-legal.example", startDate: "2025-01-01", endDate: "2026-12-31", autoRenew: false, renewalTermMonths: null, noticePeriodDays: 120, valueCents: 12_000_000, currency: "USD", status: "active", supersededById: null, signedDate: "2024-12-10", governingLaw: EW_LAW },

  // TRAP 9c -- the ONLY contract for CP-DORMANT, and it is expired. That
  // counterparty therefore has ZERO LIVE contracts while still having a row.
  { id: 24, code: "C-2022-024", title: "Advisory Agreement — Dormant Holdings Co", counterpartyId: 11, legalEntityId: US, typeCode: "msa", ownerEmail: "legal.ops@acme-legal.example", startDate: "2022-01-01", endDate: "2025-12-31", autoRenew: false, renewalTermMonths: null, noticePeriodDays: 60, valueCents: 750_000, currency: "USD", status: "expired", supersededById: null, signedDate: "2021-12-15", governingLaw: DE_LAW },
];

export interface ContractRelationship {
  id: number;
  parentContractId: number;
  childContractId: number;
  relationship: "amends" | "sow_under" | "dpa_for";
}

export const CONTRACT_RELATIONSHIPS: ContractRelationship[] = [
  { id: 1, parentContractId: 14, childContractId: 3, relationship: "dpa_for" },
  { id: 2, parentContractId: 14, childContractId: 20, relationship: "dpa_for" },
  { id: 3, parentContractId: 1, childContractId: 10, relationship: "sow_under" },
  { id: 4, parentContractId: 22, childContractId: 5, relationship: "sow_under" },
  { id: 5, parentContractId: 21, childContractId: 17, relationship: "sow_under" },
];

export interface ContractClause {
  id: number;
  contractId: number;
  clauseType: string;
  isNonStandard: boolean;
  riskRating: "low" | "medium" | "high";
  /** A MULTIPLE of annual value, not currency. NULL where no cap is stated. */
  liabilityCapMultiple: number | null;
  summary: string;
}

export const CONTRACT_CLAUSES: ContractClause[] = [
  { id: 1, contractId: 1, clauseType: "liability_cap", isNonStandard: false, riskRating: "low", liabilityCapMultiple: 1.0, summary: "Liability capped at one times annual contract value." },
  { id: 2, contractId: 1, clauseType: "termination_for_convenience", isNonStandard: false, riskRating: "low", liabilityCapMultiple: null, summary: "Either party may terminate on 90 days' written notice." },
  { id: 3, contractId: 1, clauseType: "auto_renew", isNonStandard: false, riskRating: "medium", liabilityCapMultiple: null, summary: "Renews for successive 12-month terms unless notice is served." },
  { id: 4, contractId: 2, clauseType: "data_processing", isNonStandard: false, riskRating: "low", liabilityCapMultiple: null, summary: "Processor obligations incorporated by reference to the DPA." },
  { id: 5, contractId: 2, clauseType: "liability_cap", isNonStandard: true, riskRating: "high", liabilityCapMultiple: 5.0, summary: "Liability capped at FIVE times annual value — above the one-times standard." },
  { id: 6, contractId: 3, clauseType: "sub_processor_consent", isNonStandard: true, riskRating: "medium", liabilityCapMultiple: null, summary: "Sub-processors may be appointed without prior written consent." },
  { id: 7, contractId: 4, clauseType: "assignment_change_of_control", isNonStandard: false, riskRating: "low", liabilityCapMultiple: null, summary: "Assignment permitted to an affiliate on notice." },
  { id: 8, contractId: 4, clauseType: "indemnity", isNonStandard: true, riskRating: "high", liabilityCapMultiple: null, summary: "UNCAPPED indemnity for third-party property damage." },
  { id: 9, contractId: 5, clauseType: "liability_cap", isNonStandard: false, riskRating: "low", liabilityCapMultiple: 1.0, summary: "Liability capped at one times fees paid under this statement of work." },
  { id: 10, contractId: 6, clauseType: "termination_for_convenience", isNonStandard: true, riskRating: "medium", liabilityCapMultiple: null, summary: "Termination for convenience available to the counterparty only." },
  { id: 11, contractId: 7, clauseType: "liability_cap", isNonStandard: false, riskRating: "medium", liabilityCapMultiple: 2.0, summary: "Liability capped at two times annual subscription value." },
  { id: 12, contractId: 7, clauseType: "data_processing", isNonStandard: false, riskRating: "low", liabilityCapMultiple: null, summary: "Standard contractual clauses incorporated for international transfers." },
  { id: 13, contractId: 8, clauseType: "auto_renew", isNonStandard: false, riskRating: "medium", liabilityCapMultiple: null, summary: "Automatic renewal for a further 12 months absent 60 days' notice." },
  { id: 14, contractId: 10, clauseType: "indemnity", isNonStandard: false, riskRating: "low", liabilityCapMultiple: null, summary: "Mutual indemnity for third-party intellectual property claims." },
  { id: 15, contractId: 11, clauseType: "liability_cap", isNonStandard: true, riskRating: "high", liabilityCapMultiple: 0.25, summary: "Liability capped at a QUARTER of annual value — below the standard floor." },
  { id: 16, contractId: 14, clauseType: "assignment_change_of_control", isNonStandard: true, riskRating: "high", liabilityCapMultiple: null, summary: "Counterparty may terminate on our change of control." },
  { id: 17, contractId: 15, clauseType: "liability_cap", isNonStandard: false, riskRating: "low", liabilityCapMultiple: 1.0, summary: "Liability capped at one times annual charges." },
  { id: 18, contractId: 21, clauseType: "audit_rights", isNonStandard: false, riskRating: "medium", liabilityCapMultiple: null, summary: "Annual audit on 30 days' notice." },
  { id: 19, contractId: 22, clauseType: "indemnity", isNonStandard: false, riskRating: "low", liabilityCapMultiple: null, summary: "Standard mutual indemnity." },
  { id: 20, contractId: 23, clauseType: "termination_for_convenience", isNonStandard: true, riskRating: "medium", liabilityCapMultiple: null, summary: "No termination for convenience before the third anniversary." },
];

export interface Obligation {
  id: number;
  code: string;
  contractId: number;
  description: string;
  obligationType: "report" | "payment" | "notice" | "audit" | "deletion";
  /** NULL for exactly one -- it falls back to the contract's owner. */
  ownerEmail: string | null;
  dueDate: string;
  recurrence: "none" | "monthly" | "quarterly" | "annual";
  /** NOT authoritative. See TRAP 7. */
  status: "open" | "complete" | "waived";
  notes: string | null;
}

export const OBLIGATIONS: Obligation[] = [
  { id: 1, code: "OBL-001", contractId: 1, description: "Quarterly service performance report to the counterparty.", obligationType: "report", ownerEmail: "legal.ops@acme-legal.example", dueDate: "2026-07-15", recurrence: "quarterly", status: "open", notes: null },
  { id: 2, code: "OBL-002", contractId: 1, description: "Annual security attestation to be delivered under clause 11.", obligationType: "audit", ownerEmail: "security.lead@acme-legal.example", dueDate: "2026-05-15", recurrence: "annual", status: "open", notes: null },
  // TRAP 6 -- no owner of its own. Resolves to C-2026-002's owner.
  { id: 3, code: "OBL-003", contractId: 2, description: "Data deletion certificate for the migration dataset.", obligationType: "deletion", ownerEmail: null, dueDate: "2026-06-20", recurrence: "none", status: "open", notes: "Owner not recorded — resolves to the contract owner." },
  // TRAP 7a -- COMPLETED (evidence row dated 2026-06-05) and still reads `open`.
  { id: 4, code: "OBL-004", contractId: 3, description: "Refresh and publish the approved sub-processor list.", obligationType: "report", ownerEmail: "security.lead@acme-legal.example", dueDate: "2026-06-10", recurrence: "annual", status: "open", notes: "Register not updated after the evidence was filed." },
  // TRAP 7b -- WAIVED and past due. Settled is settled; never chase it.
  { id: 5, code: "OBL-005", contractId: 4, description: "Dilapidations survey ahead of lease expiry.", obligationType: "audit", ownerEmail: "facilities@acme-legal.example", dueDate: "2026-05-20", recurrence: "none", status: "waived", notes: "Waived by the landlord in writing." },
  { id: 6, code: "OBL-006", contractId: 5, description: "Final deliverable acceptance sign-off.", obligationType: "report", ownerEmail: "procurement@acme-legal.example", dueDate: "2026-06-25", recurrence: "none", status: "open", notes: null },
  { id: 7, code: "OBL-007", contractId: 6, description: "Monthly progress report to the engagement sponsor.", obligationType: "report", ownerEmail: "procurement@acme-legal.example", dueDate: "2026-07-01", recurrence: "monthly", status: "open", notes: null },
  { id: 8, code: "OBL-008", contractId: 7, description: "Annual penetration-test evidence from the supplier.", obligationType: "audit", ownerEmail: "security.lead@acme-legal.example", dueDate: "2026-08-01", recurrence: "annual", status: "open", notes: null },
  { id: 9, code: "OBL-009", contractId: 10, description: "Insurance certificate renewal to be filed.", obligationType: "notice", ownerEmail: "contracts.lead@acme-legal.example", dueDate: "2026-07-10", recurrence: "annual", status: "open", notes: null },
  { id: 10, code: "OBL-010", contractId: 11, description: "Uptime credit reconciliation for the preceding quarter.", obligationType: "payment", ownerEmail: "eng.lead@acme-legal.example", dueDate: "2026-06-05", recurrence: "quarterly", status: "open", notes: null },
  { id: 11, code: "OBL-011", contractId: 12, description: "Return or destroy confidential material on request.", obligationType: "deletion", ownerEmail: "legal.ops@acme-legal.example", dueDate: "2026-09-30", recurrence: "none", status: "complete", notes: null },
  { id: 12, code: "OBL-012", contractId: 14, description: "Quarterly service review with the counterparty.", obligationType: "report", ownerEmail: "contracts.lead@acme-legal.example", dueDate: "2026-07-31", recurrence: "quarterly", status: "open", notes: null },
  { id: 13, code: "OBL-013", contractId: 15, description: "Annual facilities inspection and report.", obligationType: "audit", ownerEmail: "facilities@acme-legal.example", dueDate: "2026-06-15", recurrence: "annual", status: "open", notes: null },
  { id: 14, code: "OBL-014", contractId: 16, description: "Staffing compliance audit for the framework.", obligationType: "audit", ownerEmail: "procurement@acme-legal.example", dueDate: "2026-08-15", recurrence: "annual", status: "open", notes: null },
  { id: 15, code: "OBL-015", contractId: 21, description: "Advisory retainer usage report for the quarter.", obligationType: "report", ownerEmail: "security.lead@acme-legal.example", dueDate: "2026-06-28", recurrence: "quarterly", status: "open", notes: null },
  { id: 16, code: "OBL-016", contractId: 22, description: "Right-to-work re-verification for placed staff.", obligationType: "audit", ownerEmail: "procurement@acme-legal.example", dueDate: "2026-07-20", recurrence: "annual", status: "complete", notes: null },
  { id: 17, code: "OBL-017", contractId: 23, description: "Service-charge reconciliation payment.", obligationType: "payment", ownerEmail: "facilities@acme-legal.example", dueDate: "2026-05-05", recurrence: "annual", status: "complete", notes: null },
  { id: 18, code: "OBL-018", contractId: 1, description: "Annual insurance evidence to the counterparty.", obligationType: "report", ownerEmail: "contracts.lead@acme-legal.example", dueDate: "2026-05-01", recurrence: "annual", status: "complete", notes: null },
  { id: 19, code: "OBL-019", contractId: 6, description: "Background-check attestation for consultants.", obligationType: "audit", ownerEmail: "procurement@acme-legal.example", dueDate: "2026-06-01", recurrence: "annual", status: "complete", notes: null },
  { id: 20, code: "OBL-020", contractId: 8, description: "Pilot exit plan to be agreed before renewal.", obligationType: "report", ownerEmail: "security.lead@acme-legal.example", dueDate: "2026-08-20", recurrence: "none", status: "open", notes: null },
  { id: 21, code: "OBL-021", contractId: 9, description: "Return of supplied media assets.", obligationType: "deletion", ownerEmail: "procurement@acme-legal.example", dueDate: "2026-08-10", recurrence: "none", status: "complete", notes: null },
  { id: 22, code: "OBL-022", contractId: 20, description: "Update the record of processing activities.", obligationType: "report", ownerEmail: "security.lead@acme-legal.example", dueDate: "2026-07-05", recurrence: "none", status: "open", notes: null },
];

export interface ObligationCompletion {
  id: number;
  obligationId: number;
  completedDate: string;
  evidenceRef: string;
  completedBy: string;
}

export const OBLIGATION_COMPLETIONS: ObligationCompletion[] = [
  // TRAP 7a -- this one's obligation still reads `open`.
  { id: 1, obligationId: 4, completedDate: "2026-06-05", evidenceRef: "EV-2026-0041", completedBy: "security.lead@acme-legal.example" },
  { id: 2, obligationId: 11, completedDate: "2026-06-12", evidenceRef: "EV-2026-0044", completedBy: "legal.ops@acme-legal.example" },
  { id: 3, obligationId: 16, completedDate: "2026-06-18", evidenceRef: "EV-2026-0047", completedBy: "procurement@acme-legal.example" },
  { id: 4, obligationId: 17, completedDate: "2026-05-04", evidenceRef: "EV-2026-0033", completedBy: "facilities@acme-legal.example" },
  { id: 5, obligationId: 18, completedDate: "2026-04-28", evidenceRef: "EV-2026-0029", completedBy: "contracts.lead@acme-legal.example" },
  { id: 6, obligationId: 19, completedDate: "2026-05-28", evidenceRef: "EV-2026-0038", completedBy: "procurement@acme-legal.example" },
  { id: 7, obligationId: 21, completedDate: "2026-06-25", evidenceRef: "EV-2026-0049", completedBy: "procurement@acme-legal.example" },
];

export interface NoticeLogEntry {
  id: number;
  contractId: number;
  noticeType: "renewal_reminder" | "non_renewal" | "termination" | "lapse_warning";
  sentDate: string;
  /** NULL where no email address was used -- a postal notice has none. */
  sentTo: string | null;
  channel: "email" | "post" | "portal";
}

export const NOTICE_LOG: NoticeLogEntry[] = [
  // TRAP 8a -- inside the current window at the default as-of date: SUPPRESS.
  { id: 1, contractId: 10, noticeType: "renewal_reminder", sentDate: "2026-06-20", sentTo: "contracts@northwind-logistics.example", channel: "email" },
  // TRAP 8b -- a PRIOR cycle. This contract must be noticed AGAIN.
  { id: 2, contractId: 11, noticeType: "renewal_reminder", sentDate: "2025-08-10", sentTo: "billing@verdant-cloud.example", channel: "email" },
  { id: 3, contractId: 4, noticeType: "lapse_warning", sentDate: "2026-04-25", sentTo: "facilities@acme-legal.example", channel: "email" },
  // A postal notice, so no email address was used.
  { id: 4, contractId: 13, noticeType: "non_renewal", sentDate: "2025-11-05", sentTo: null, channel: "post" },
  { id: 5, contractId: 19, noticeType: "termination", sentDate: "2026-03-20", sentTo: "hello@kestrel-print.example", channel: "email" },
];

// ── Derived helpers, all pure ────────────────────────────────────────────────

const typeByCode = new Map(CONTRACT_TYPES.map((t) => [t.code, t]));
const contractById = new Map(CONTRACTS.map((c) => [c.id, c]));
const counterpartyById = new Map(COUNTERPARTIES.map((c) => [c.id, c]));

/**
 * The notice period that actually applies, resolving the TWO-LEVEL fallback.
 *
 * Both hops are mandatory. Skipping the middle one is wrong for C-2026-002;
 * skipping the last one is wrong for C-2024-001, the most valuable contract in
 * the dataset. `legal-queries.ts` resolves the same chain in SQL so a generated
 * fragment cannot get it wrong.
 */
export function effectiveNoticeDays(contract: Contract): number {
  if (contract.noticePeriodDays !== null) return contract.noticePeriodDays;
  const type = typeByCode.get(contract.typeCode);
  if (type?.defaultNoticePeriodDays != null) return type.defaultNoticePeriodDays;
  return DEFAULT_NOTICE_PERIOD_DAYS;
}

/** The last day notice can be served, or null for an evergreen contract. */
export function noticeDeadline(contract: Contract): string | null {
  if (contract.endDate === null) return null;
  return addDays(contract.endDate, -effectiveNoticeDays(contract));
}

export type UrgencyBucket = "missed" | "0-14" | "15-30" | "31-90" | "90+";

/**
 * `days` is deadline MINUS as-of, so zero means the deadline is TODAY and the
 * contract belongs in `0-14`, not in `missed`. That is the inclusive boundary,
 * and it is the opposite of `finance_demo`'s rule.
 */
export function urgencyBucket(days: number): UrgencyBucket {
  if (days < 0) return "missed";
  if (days <= 14) return "0-14";
  if (days <= 30) return "15-30";
  if (days <= 90) return "31-90";
  return "90+";
}

/**
 * Can a deadline report see this contract at `asOf`?
 *
 * Six conditions, and every one of them is a trap somewhere:
 *   status `active`        -- excludes the draft, the terminated and the expired
 *   endDate not null       -- excludes the evergreen (TRAP 3)
 *   supersededById null    -- excludes the superseded row (TRAP 4)
 *   signedDate not null    -- a draft is not yet a contract
 *   startDate <= asOf      -- not yet in force is not a renewal decision
 *   endDate >= asOf        -- a contract already ended is not a renewal decision
 */
export function isDeadlineEligible(contract: Contract, asOf: string): boolean {
  if (contract.status !== "active") return false;
  if (contract.endDate === null) return false;
  if (contract.supersededById !== null) return false;
  if (contract.signedDate === null) return false;
  if (contract.startDate > asOf) return false;
  if (contract.endDate < asOf) return false;
  return true;
}

/** Is this obligation complete AS OF a date? Read from the evidence, not the status. */
export function isCompleted(obligationId: number, asOf: string): boolean {
  return OBLIGATION_COMPLETIONS.some(
    (c) => c.obligationId === obligationId && c.completedDate <= asOf,
  );
}

/**
 * Has a renewal-type notice gone out for this contract in the CURRENT cycle?
 *
 * DATE-BOUNDED. Without the lower bound, C-2024-011's 2025 notice suppresses
 * this year's reminder and the contract auto-renews in silence.
 */
export function alreadyNoticed(contractId: number, asOf: string, windowDays: number): boolean {
  const from = addDays(asOf, -windowDays);
  return NOTICE_LOG.some(
    (n) =>
      n.contractId === contractId &&
      (n.noticeType === "renewal_reminder" || n.noticeType === "non_renewal") &&
      n.sentDate >= from &&
      n.sentDate <= asOf,
  );
}

// ── The oracle ───────────────────────────────────────────────────────────────

export interface DeadlineRow {
  contractCode: string;
  title: string;
  counterpartyCode: string;
  counterpartyName: string;
  contactEmail: string | null;
  ownerEmail: string;
  typeCode: string;
  effectiveNoticeDays: number;
  noticeDeadline: string;
  daysToDeadline: number;
  urgencyBucket: UrgencyBucket;
  autoRenew: boolean;
  renewalTermMonths: number | null;
  endDate: string;
  valueCents: number;
  alreadyNoticed: boolean;
}

export interface ObligationRow {
  obligationCode: string;
  contractCode: string;
  description: string;
  obligationType: string;
  resolvedOwnerEmail: string;
  dueDate: string;
  daysToDue: number;
  overdue: boolean;
  recurrence: string;
}

export interface ClauseRow {
  contractCode: string;
  counterpartyCode: string;
  ownerEmail: string;
  clauseType: string;
  riskRating: string;
  /** A MULTIPLE. The `X` in the name is the unit, and it travels. */
  liabilityCapMultipleX: number | null;
  summary: string;
}

export interface CounterpartySummaryRow {
  counterpartyCode: string;
  name: string;
  liveContracts: number;
  totalValueCents: number;
  nextNoticeDeadline: string | null;
  contactStatus: "ok" | "no_contact_email" | "bouncing";
}

export interface LegalOracle {
  asOf: string;
  lookaheadDays: number;
  renewalDue: DeadlineRow[];
  renewalByBucket: Record<UrgencyBucket, number>;
  lapseRisk: DeadlineRow[];
  missedDeadlines: DeadlineRow[];
  alreadyNoticed: string[];
  obligationsDue: ObligationRow[];
  obligationsOverdue: ObligationRow[];
  nonStandardClauses: ClauseRow[];
  counterpartySummary: CounterpartySummaryRow[];
  unmailable: string[];
  bouncing: string[];
  evergreenExcluded: string[];
  supersededExcluded: string[];
}

function deadlineRow(contract: Contract, asOf: string, lookaheadDays: number): DeadlineRow {
  const deadline = noticeDeadline(contract)!;
  const days = daysBetween(asOf, deadline);
  const cp = counterpartyById.get(contract.counterpartyId)!;
  return {
    contractCode: contract.code,
    title: contract.title,
    counterpartyCode: cp.code,
    counterpartyName: cp.name,
    contactEmail: cp.contactEmail,
    ownerEmail: contract.ownerEmail,
    typeCode: contract.typeCode,
    effectiveNoticeDays: effectiveNoticeDays(contract),
    noticeDeadline: deadline,
    daysToDeadline: days,
    urgencyBucket: urgencyBucket(days),
    autoRenew: contract.autoRenew,
    renewalTermMonths: contract.renewalTermMonths,
    endDate: contract.endDate!,
    valueCents: contract.valueCents,
    alreadyNoticed: alreadyNoticed(contract.id, asOf, lookaheadDays),
  };
}

const byUrgencyThenCode = (a: DeadlineRow, b: DeadlineRow) =>
  a.daysToDeadline - b.daysToDeadline || a.contractCode.localeCompare(b.contractCode);

/**
 * The correct answer, computed from the definitions above and from nothing else.
 *
 * Never make this read the database, and never let it import Finance's or HR's
 * oracle. Both would turn the second implementation that makes agreement
 * meaningful into a second copy of the same mistake.
 */
export function legalOracle(
  asOf: string = LEGAL_DEFAULT_AS_OF,
  lookaheadDays: number = DEFAULT_LOOKAHEAD_DAYS,
): LegalOracle {
  const horizon = addDays(asOf, lookaheadDays);

  // ── The two deadline populations ──────────────────────────────────────────
  //
  // Split on `autoRenew`, and DISJOINT by construction. That split is the whole
  // mitigation for TRAP 5: the recipient and the consequence differ, so the two
  // never share a result set that a fragment has to branch on correctly.
  const renewalDue: DeadlineRow[] = [];
  const lapseRisk: DeadlineRow[] = [];
  for (const c of CONTRACTS) {
    if (!isDeadlineEligible(c, asOf)) continue;
    const deadline = noticeDeadline(c)!;
    // INCLUSIVE upper bound. `<=`, not `<` -- a deadline on the horizon is in the
    // window, and a deadline on the as-of date is today's last chance.
    if (deadline > horizon) continue;
    (c.autoRenew ? renewalDue : lapseRisk).push(deadlineRow(c, asOf, lookaheadDays));
  }
  renewalDue.sort(byUrgencyThenCode);
  lapseRisk.sort(byUrgencyThenCode);

  const renewalByBucket: Record<UrgencyBucket, number> = {
    missed: 0,
    "0-14": 0,
    "15-30": 0,
    "31-90": 0,
    "90+": 0,
  };
  for (const r of renewalDue) renewalByBucket[r.urgencyBucket]++;

  const missedDeadlines = [...renewalDue, ...lapseRisk]
    .filter((r) => r.urgencyBucket === "missed")
    .sort(byUrgencyThenCode);

  // ── Obligations ───────────────────────────────────────────────────────────
  //
  // Completion is read from `OBLIGATION_COMPLETIONS`, never from `status`
  // (TRAP 7a), and a `waived` obligation is settled however overdue (TRAP 7b).
  const obligationsDue: ObligationRow[] = [];
  for (const o of OBLIGATIONS) {
    if (o.status === "waived") continue;
    if (isCompleted(o.id, asOf)) continue;
    if (o.dueDate > horizon) continue;
    const contract = contractById.get(o.contractId)!;
    obligationsDue.push({
      obligationCode: o.code,
      contractCode: contract.code,
      description: o.description,
      obligationType: o.obligationType,
      // TRAP 6 -- the fallback. Never a null recipient, never the string "None".
      resolvedOwnerEmail: o.ownerEmail ?? contract.ownerEmail,
      dueDate: o.dueDate,
      daysToDue: daysBetween(asOf, o.dueDate),
      overdue: o.dueDate < asOf,
      recurrence: o.recurrence,
    });
  }
  obligationsDue.sort(
    (a, b) => a.daysToDue - b.daysToDue || a.obligationCode.localeCompare(b.obligationCode),
  );
  const obligationsOverdue = obligationsDue.filter((o) => o.overdue);

  // ── Clauses ───────────────────────────────────────────────────────────────
  const nonStandardClauses: ClauseRow[] = CONTRACT_CLAUSES.filter((c) => c.isNonStandard)
    .map((c) => {
      const contract = contractById.get(c.contractId)!;
      return {
        contractCode: contract.code,
        counterpartyCode: counterpartyById.get(contract.counterpartyId)!.code,
        ownerEmail: contract.ownerEmail,
        clauseType: c.clauseType,
        riskRating: c.riskRating,
        liabilityCapMultipleX: c.liabilityCapMultiple,
        summary: c.summary,
      };
    })
    .sort(
      (a, b) =>
        a.contractCode.localeCompare(b.contractCode) || a.clauseType.localeCompare(b.clauseType),
    );

  // ── Counterparty summary ──────────────────────────────────────────────────
  //
  // EVERY counterparty appears, including the one with zero live contracts
  // (TRAP 9c). An inner join drops it, and a counterparty whose contracts have
  // all lapsed is exactly what this report exists to surface.
  const counterpartySummary: CounterpartySummaryRow[] = COUNTERPARTIES.map((cp): CounterpartySummaryRow => {
    const live = CONTRACTS.filter((c) => c.counterpartyId === cp.id && c.status === "active");
    const deadlines = live
      .filter((c) => c.endDate !== null && c.supersededById === null)
      .map((c) => noticeDeadline(c)!)
      .filter((d) => d >= asOf)
      .sort();
    return {
      counterpartyCode: cp.code,
      name: cp.name,
      liveContracts: live.length,
      totalValueCents: live.reduce((sum, c) => sum + c.valueCents, 0),
      nextNoticeDeadline: deadlines[0] ?? null,
      contactStatus:
        cp.contactEmail === null
          ? "no_contact_email"
          : cp.contactEmail.endsWith(`@${BOUNCING_DOMAIN}`)
            ? "bouncing"
            : "ok",
    };
  }).sort((a, b) => a.counterpartyCode.localeCompare(b.counterpartyCode));

  return {
    asOf,
    lookaheadDays,
    renewalDue,
    renewalByBucket,
    lapseRisk,
    missedDeadlines,
    alreadyNoticed: renewalDue
      .filter((r) => r.alreadyNoticed)
      .map((r) => r.contractCode)
      .sort(),
    obligationsDue,
    obligationsOverdue,
    nonStandardClauses,
    counterpartySummary,
    unmailable: COUNTERPARTIES.filter((c) => c.contactEmail === null).map((c) => c.code).sort(),
    bouncing: COUNTERPARTIES.filter((c) => c.contactEmail?.endsWith(`@${BOUNCING_DOMAIN}`))
      .map((c) => c.code)
      .sort(),
    evergreenExcluded: CONTRACTS.filter((c) => c.endDate === null).map((c) => c.code).sort(),
    supersededExcluded: CONTRACTS.filter((c) => c.supersededById !== null).map((c) => c.code).sort(),
  };
}
