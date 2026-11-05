/**
 * WS-E.1 — the ALT dataset (plans/production-substitution-plan.md §8.1).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS NOT EMPLOYEE DATA. Every name is invented; every address is on
 * `alt-hr.example` / `alt-hr-bounce.example`, domains reserved by RFC 2606 that
 * can never resolve or receive mail. Same rule as the primary dataset: it is safe
 * to expose because it is fabricated, and it must never be replaced with data
 * that isn't.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY A SECOND DATASET EXISTS. The whole claim of this plan is that swapping a
 * synthetic datasource for a production one is a *registry* change. Nothing tests
 * that claim except pointing the system at a genuinely different database and
 * running the SAME task prompts. `hr_demo` cannot do it: any accidental
 * dependence on its table names, its units, or its scale is invisible while it is
 * the only dataset in existence.
 *
 * So this is the same DOMAIN with a deliberately different SHAPE. Each difference
 * targets one assumption that could have leaked into the platform, the prompt, or
 * the tool descriptions:
 *
 *   | difference                                | assumption it catches                  |
 *   |-------------------------------------------|----------------------------------------|
 *   | named schema `hr`, not `public`            | WS-C.1 — the schema hardcode           |
 *   | tables `staff` / `org_units` / `sites`     | table names baked into a prompt        |
 *   | attendance exposed as a VIEW               | WS-C.2 — views treated as tables       |
 *   | rate as a 0–1 FRACTION, not a percentage   | a unit assumption; the nastiest of all |
 *   | threshold pre-resolved in a view           | WS-F.4 — the COALESCE trap             |
 *   | ~10× the rows                              | a missing LIMIT                        |
 *   | window 2025-09..11, not 2026-04..06        | a hardcoded period                     |
 *   | composite PK on the attendance rollup      | WS-C.3 — composite keys                |
 *
 * DETERMINISM: no Math.random. Attended-day counts are exact, so the oracle below
 * is an arithmetic fact about this file rather than a description of a past run.
 */

export const ALT_EMAIL_DOMAIN = "alt-hr.example";
export const ALT_BOUNCE_DOMAIN = "alt-hr-bounce.example";
/** Deliberately NOT the primary dataset's window, so a hardcoded period fails. */
export const ALT_PERIOD = "2025-11";
export const ALT_MONTHS = ["2025-09", "2025-10", "2025-11"] as const;
/** Weekday public holidays inside the window. */
export const ALT_HOLIDAYS = new Set(["2025-09-01", "2025-11-27"]);

export interface AltSite {
  id: number;
  siteCode: string;
  city: string;
  country: string;
  zone: string;
}

export const ALT_SITES: AltSite[] = [
  { id: 10, siteCode: "TOR", city: "Toronto", country: "Canada", zone: "America/Toronto" },
  { id: 20, siteCode: "MEX", city: "Mexico City", country: "Mexico", zone: "America/Mexico_City" },
  { id: 30, siteCode: "DUB", city: "Dublin", country: "Ireland", zone: "Europe/Dublin" },
  { id: 40, siteCode: "WAW", city: "Warsaw", country: "Poland", zone: "Europe/Warsaw" },
  { id: 50, siteCode: "SYD", city: "Sydney", country: "Australia", zone: "Australia/Sydney" },
  // Single-occupant site, mirroring the primary dataset's Singapore trap.
  { id: 60, siteCode: "OSA", city: "Osaka", country: "Japan", zone: "Asia/Tokyo" },
];

export interface AltOrgUnit {
  id: number;
  unitCode: string;
  unitName: string;
  ledgerCode: string;
}

export const ALT_ORG_UNITS: AltOrgUnit[] = [
  { id: 100, unitCode: "PLT", unitName: "Platform", ledgerCode: "L-900" },
  { id: 200, unitCode: "REV", unitName: "Revenue", ledgerCode: "L-910" },
  { id: 300, unitCode: "PPL", unitName: "People Ops", ledgerCode: "L-920" },
  { id: 400, unitCode: "FIN", unitName: "Finance", ledgerCode: "L-930" },
  { id: 500, unitCode: "SUP", unitName: "Support", ledgerCode: "L-940" },
  // Deliberately empty, like the primary dataset's Legal department.
  { id: 600, unitCode: "AUD", unitName: "Internal Audit", ledgerCode: "L-950" },
];

/**
 * Attendance policy — expressed as a FRACTION (0–1), not a percentage.
 *
 * This is the single most valuable difference in this file. The primary dataset
 * uses 0–100, so any code, prompt sentence, or tool description that assumes
 * "compare against 80" produces a catastrophically wrong answer here: every
 * employee is below a threshold of 80 when rates run 0.0–1.0. A script that reads
 * the threshold from the data survives; one that carries a number in its head
 * does not.
 *
 * `unitId: null` is the org-wide default. Platform overrides it upward — the same
 * join-not-a-constant structure as the primary dataset, so the trap survives the
 * swap while the numbers do not.
 */
export interface AltPolicy {
  id: number;
  unitId: number | null;
  minRate: number; // FRACTION 0–1
  activeFrom: string;
}

export const ALT_POLICIES: AltPolicy[] = [
  { id: 1, unitId: null, minRate: 0.75, activeFrom: "2025-01-01" },
  { id: 2, unitId: 100, minRate: 0.9, activeFrom: "2025-01-01" }, // Platform, stricter
  { id: 3, unitId: 500, minRate: 0.7, activeFrom: "2025-01-01" }, // Support, looser
];

export function altThresholdFor(unitId: number): number {
  return (
    ALT_POLICIES.find((p) => p.unitId === unitId)?.minRate ??
    ALT_POLICIES.find((p) => p.unitId === null)!.minRate
  );
}

export interface AltStaff {
  id: number;
  badge: string;
  fullName: string;
  unitId: number;
  siteId: number;
  supervisorId: number | null;
  role: string;
  contractType: "permanent" | "part_time" | "agency";
  state: "working" | "sabbatical" | "left";
  joinedOn: string;
  leftOn: string | null;
  /** Exact attended-day count per month; keys are ALT_MONTHS. */
  attended: Record<string, number>;
  /** Overrides the generated address: null = no mailbox, "bounce" = bouncing domain. */
  mailbox?: null | "bounce";
}

// Attendance is given as attended days out of the month's working days (below).
// A rate is computed, never stored as a magic number, so the two cannot disagree.
export const ALT_WORKING_DAYS: Record<string, number> = {
  "2025-09": 21, // 22 weekdays − 1 holiday (2025-09-01)
  "2025-10": 23,
  "2025-11": 20, // 21 weekdays − 1 holiday (2025-11-27)
};

/**
 * 120 staff — roughly double the primary roster, and each carries 3 monthly
 * rollups plus daily rows, giving ~10× the row count. Enough that a script
 * without a LIMIT on a daily-grain query notices.
 *
 * The roster is generated from a deterministic table of exceptions plus a
 * repeating baseline, so the file stays readable while the edge cases stay exact.
 */
const FIRST = [
  "Aurelia", "Bastian", "Camila", "Dashiell", "Eleni", "Fintan", "Giselle", "Hamza",
  "Imogen", "Jasper", "Kenji", "Liesel", "Mateo", "Niamh", "Oskar", "Priya",
  "Quentin", "Rosalie", "Silas", "Tamsin", "Ulric", "Verity", "Wren", "Xiomara",
];
const LAST = [
  "Abernathy", "Bergström", "Castellanos", "Dlamini", "Eriksen", "Fontaine",
  "Grigorescu", "Halvorsen", "Ishikawa", "Jelani", "Kowalczyk", "Lindqvist",
  "Moreau", "Nakamura", "Okonkwo", "Petrov", "Quintero", "Rasmussen", "Sørensen",
  "Thibodeaux",
];

/**
 * Deliberate exceptions. Everything not listed here gets a comfortably-passing
 * baseline, so the oracle's counts come from exactly these rows.
 *
 * `attended` is out of ALT_WORKING_DAYS[ALT_PERIOD] = 20 for the screened month.
 */
interface Exception {
  id: number;
  unitId: number;
  attendedNov: number;
  state?: AltStaff["state"];
  contractType?: AltStaff["contractType"];
  mailbox?: null | "bounce";
  note: string;
}

const EXCEPTIONS: Exception[] = [
  // ── below threshold, ordinary and mailable ────────────────────────────────
  { id: 1001, unitId: 200, attendedNov: 12, note: "0.60 vs default 0.75" },
  { id: 1002, unitId: 200, attendedNov: 13, note: "0.65 vs default 0.75" },
  { id: 1003, unitId: 300, attendedNov: 14, note: "0.70 vs default 0.75" },
  { id: 1004, unitId: 400, attendedNov: 11, note: "0.55 vs default 0.75" },
  { id: 1005, unitId: 500, attendedNov: 13, note: "0.65 vs Support 0.70" },
  // ── THE UNIT-OVERRIDE TRAP, the counterpart of employee #14 ───────────────
  // 0.80 is ABOVE the org default of 0.75 but BELOW Platform's 0.90. A script
  // that hardcodes the default — or that reads 0.75 once and reuses it — misses
  // this person. Two of them, so an off-by-one is visible.
  { id: 1006, unitId: 100, attendedNov: 16, note: "0.80: above default 0.75, below Platform 0.90" },
  { id: 1007, unitId: 100, attendedNov: 17, note: "0.85: above default 0.75, below Platform 0.90" },
  // ── below threshold but UNREACHABLE ───────────────────────────────────────
  { id: 1008, unitId: 500, attendedNov: 10, contractType: "agency", mailbox: null, note: "no mailbox" },
  { id: 1009, unitId: 200, attendedNov: 12, mailbox: "bounce", note: "bouncing domain" },
  // ── must be EXCLUDED, not flagged, despite a low rate ─────────────────────
  { id: 1010, unitId: 300, attendedNov: 4, state: "sabbatical", note: "on sabbatical" },
  { id: 1011, unitId: 400, attendedNov: 6, state: "left", note: "left mid-window" },
  // ── boundary: EXACTLY at the threshold must NOT be flagged ────────────────
  // 15/20 = 0.75 exactly. `< threshold` excludes them; `<=` would wrongly flag.
  { id: 1012, unitId: 200, attendedNov: 15, note: "exactly 0.75 — boundary, NOT flagged" },
  // 18/20 = 0.90 exactly, on Platform's stricter bar.
  { id: 1013, unitId: 100, attendedNov: 18, note: "exactly 0.90 — boundary, NOT flagged" },
];

const EXCEPTION_IDS = new Set(EXCEPTIONS.map((e) => e.id));

/** Baseline unit assignment: round-robin over the five populated units. */
const POPULATED_UNITS = [100, 200, 300, 400, 500];

export const ALT_ROSTER: AltStaff[] = (() => {
  const out: AltStaff[] = [];
  const exById = new Map(EXCEPTIONS.map((e) => [e.id, e]));

  for (let i = 0; i < 120; i++) {
    const id = 1001 + i;
    const ex = exById.get(id);
    const unitId = ex?.unitId ?? POPULATED_UNITS[i % POPULATED_UNITS.length];
    // Site 60 gets exactly one occupant (the last id).
    const siteId = i === 119 ? 60 : [10, 20, 30, 40, 50][i % 5];
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7) % LAST.length];
    // A comfortable baseline: 19/20 = 0.95, above every threshold including
    // Platform's 0.90, so no unlisted row can accidentally join the flagged set.
    const attendedNov = ex?.attendedNov ?? 19;

    out.push({
      id,
      badge: `S-${id}`,
      fullName: `${first} ${last}`,
      unitId,
      siteId,
      // First staff member is the root of the tree (no supervisor); everyone else
      // reports to the first person in their unit.
      supervisorId: i === 0 ? null : 1001 + (i % 5),
      role: ["Engineer", "Analyst", "Coordinator", "Specialist", "Lead"][i % 5],
      contractType: ex?.contractType ?? (i % 11 === 0 ? "part_time" : "permanent"),
      state: ex?.state ?? "working",
      joinedOn: `202${1 + (i % 4)}-0${1 + (i % 9)}-1${i % 10}`,
      leftOn: ex?.state === "left" ? "2025-11-14" : null,
      attended: {
        "2025-09": Math.min(ALT_WORKING_DAYS["2025-09"], attendedNov + 2),
        "2025-10": Math.min(ALT_WORKING_DAYS["2025-10"], attendedNov + 3),
        "2025-11": attendedNov,
      },
      mailbox: ex?.mailbox,
    });
  }
  // Guard: a supervisor cycle would make any escalation task unsolvable.
  for (const s of out) {
    if (s.supervisorId === s.id) s.supervisorId = null;
  }
  return out;
})();

/** Work address, or null for staff with no mailbox. */
export function altEmail(s: AltStaff): string | null {
  if (s.mailbox === null) return null;
  const local = s.fullName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]+/g, ".");
  const domain = s.mailbox === "bounce" ? ALT_BOUNCE_DOMAIN : ALT_EMAIL_DOMAIN;
  return `${local}.${s.id}@${domain}`;
}

/** Attendance rate as a FRACTION, rounded to 4dp — the units the DB stores. */
export function altRate(s: AltStaff, period: string): number {
  const days = ALT_WORKING_DAYS[period];
  return Math.round((s.attended[period] / days) * 10_000) / 10_000;
}

export interface AltMonthlyRow {
  staffId: number;
  period: string;
  workingDays: number;
  daysPresent: number;
  presenceRate: number;
}

export function buildAltAttendance(): { monthly: AltMonthlyRow[]; dailyCount: number } {
  const monthly: AltMonthlyRow[] = [];
  let dailyCount = 0;
  for (const s of ALT_ROSTER) {
    for (const period of ALT_MONTHS) {
      monthly.push({
        staffId: s.id,
        period,
        workingDays: ALT_WORKING_DAYS[period],
        daysPresent: s.attended[period],
        presenceRate: altRate(s, period),
      });
      dailyCount += ALT_WORKING_DAYS[period];
    }
  }
  return { monthly, dailyCount };
}

/**
 * WS-E.5 — the ALT oracle: the correct answer computed from THIS file's
 * definition, never from a script's output.
 *
 * Deliberately a separate function from `expectedScreening`, not a
 * parameterisation of it. Sharing one oracle across both datasets would let a
 * shared bug produce a shared wrong answer that agrees with itself — and the
 * rehearsal's whole job is to find things that only look right because one
 * implementation is used twice.
 */
export function altExpectedScreening(period = ALT_PERIOD) {
  const flagged: Array<{
    id: number;
    name: string;
    rate: number;
    threshold: number;
    email: string | null;
    unitId: number;
  }> = [];
  const excluded: Array<{ id: number; name: string; reason: string }> = [];

  for (const s of ALT_ROSTER) {
    if (s.state === "left") {
      excluded.push({ id: s.id, name: s.fullName, reason: `left ${s.leftOn}` });
      continue;
    }
    if (s.state === "sabbatical") {
      excluded.push({ id: s.id, name: s.fullName, reason: "on sabbatical" });
      continue;
    }
    const threshold = altThresholdFor(s.unitId);
    const rate = altRate(s, period);
    // STRICTLY less than: exactly-at-threshold passes (ids 1012, 1013).
    if (rate < threshold) {
      flagged.push({
        id: s.id,
        name: s.fullName,
        rate,
        threshold,
        email: altEmail(s),
        unitId: s.unitId,
      });
    }
  }

  return {
    period,
    flagged: flagged.sort((a, b) => a.id - b.id),
    excluded: excluded.sort((a, b) => a.id - b.id),
    unmailable: flagged.filter((f) => f.email === null),
    bouncing: flagged.filter((f) => f.email?.endsWith(ALT_BOUNCE_DOMAIN)),
    /** Flagged only because of a unit override — the hardcoded-default trap. */
    overrideOnly: flagged.filter(
      (f) => f.rate >= altThresholdFor(-1) && f.rate < altThresholdFor(f.unitId),
    ),
  };
}
