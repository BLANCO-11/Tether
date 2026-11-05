/**
 * Oracles for Phase 1 scenarios B and C.
 * archive/kestra-migration/progress/phase-1.md · README "Start here"
 *
 * The README's gate is **three** scenarios scored against an oracle, not one.
 * `expectedScreening()` in `hr-dataset.ts` is scenario A's. These are B's and
 * C's.
 *
 * ── Why a separate file ──────────────────────────────────────────────────────
 *
 * Two reasons, and both matter:
 *
 *   1. `CLAUDE.md`: **do not touch the demo dataset.** These read `ROSTER`,
 *      `DEPARTMENTS` and `buildAttendance()` and add nothing to them, so
 *      `demo:verify`'s invariants and the `hr_demo_alt` rehearsal are untouched.
 *   2. The same rule the swap rehearsal follows: an oracle is written
 *      INDEPENDENTLY of the thing it scores. Each function below recomputes from
 *      the dataset definition. `expectedScreening` is reused only where the
 *      scenario's own specification says "the employees screening flagged" —
 *      scenario B escalates exactly that set, so deriving it again would be
 *      copying a definition, not verifying one.
 *
 * ── Why these two scenarios ──────────────────────────────────────────────────
 *
 * Not three filters over one query. Three different SHAPES, each aimed at a
 * different measured failure mode:
 *
 * | | Shape | Failure mode it is aimed at |
 * | :--- | :--- | :--- |
 * | A screening | row-level fan-out, N rows → N emails | fabricated dates, missing COALESCE |
 * | B escalation | **hierarchical fan-IN**, N employees → M managers | invented joins; N→N when the answer is N→M |
 * | C roll-up | **aggregate**, all rows → one summary | divide-by-zero, dropping the empty group |
 *
 * The dataset was built for them — the roster comments name "manager escalation"
 * and the empty department names "division-by-zero / empty-result handling".
 */
import {
  DEMO_PERIOD,
  DEPARTMENTS,
  ROSTER,
  buildAttendance,
  expectedScreening,
  thresholdFor,
  workEmail,
  type RosterEntry,
} from "./hr-dataset.js";

const byId = (id: number): RosterEntry | undefined => ROSTER.find((e) => e.id === id);

// ─────────────────────────────────────────────────────────────────────────────
// Scenario B — escalate each flagged employee to a manager, one ticket each
// ─────────────────────────────────────────────────────────────────────────────

export interface EscalationTarget {
  managerId: number;
  managerName: string;
  /** null for the contractor-with-no-mailbox case — the ticket still gets created, unassigned. */
  managerEmail: string | null;
  reportIds: number[];
  reportNames: string[];
}

export interface EscalationOracle {
  period: string;
  /** One ticket per entry, sorted by manager id. N employees → M tickets, M ≤ N. */
  tickets: EscalationTarget[];
  /** Flagged employees with no active manager anywhere up the tree. Reported, never dropped. */
  unescalatable: Array<{ id: number; name: string; reason: string }>;
  /** Tickets that must be created with NO assignee, because the manager has no mailbox. */
  unassignable: number[];
}

/**
 * Walk up `manager_id` to the nearest **active** manager.
 *
 * The nearest-ACTIVE part is the trap. A direct manager who is `exited` or
 * `on_leave` is not a valid escalation target — mailing an exited manager is the
 * silent-failure shape this whole migration exists to eliminate — so the walk
 * continues upward. A single `JOIN employees m ON m.id = e.manager_id`, which is
 * what generated SQL reaches for, gets this wrong without erroring.
 *
 * Cycle-guarded: the roster is a tree today, and a future edit that makes it not
 * one must fail loudly rather than hang the oracle.
 */
function nearestActiveManager(employee: RosterEntry): RosterEntry | null {
  const seen = new Set<number>([employee.id]);
  let cursor = employee.managerId;
  while (cursor !== null && cursor !== undefined) {
    if (seen.has(cursor)) throw new Error(`manager cycle at employee ${cursor}`);
    seen.add(cursor);
    const manager = byId(cursor);
    if (!manager) throw new Error(`employee ${employee.id} reports to unknown manager ${cursor}`);
    if (manager.status === "active") return manager;
    cursor = manager.managerId;
  }
  return null;
}

export function expectedEscalation(period = DEMO_PERIOD): EscalationOracle {
  const flagged = expectedScreening(period).flagged;

  const grouped = new Map<number, EscalationTarget>();
  const unescalatable: EscalationOracle["unescalatable"] = [];

  for (const f of flagged) {
    const employee = byId(f.id)!;
    const manager = nearestActiveManager(employee);
    if (!manager) {
      // The CEO is the only employee with manager_id NULL. If the CEO is ever
      // flagged there is nobody above them, and the answer is a reported gap,
      // not a crash and not an invented recipient.
      unescalatable.push({ id: f.id, name: f.name, reason: "no active manager above this employee" });
      continue;
    }
    const existing = grouped.get(manager.id);
    if (existing) {
      existing.reportIds.push(f.id);
      existing.reportNames.push(f.name);
    } else {
      grouped.set(manager.id, {
        managerId: manager.id,
        managerName: manager.name,
        managerEmail: workEmail(manager),
        reportIds: [f.id],
        reportNames: [f.name],
      });
    }
  }

  const tickets = [...grouped.values()]
    .map((t) => ({
      ...t,
      reportIds: [...t.reportIds].sort((a, b) => a - b),
      reportNames: [...t.reportNames].sort(),
    }))
    .sort((a, b) => a.managerId - b.managerId);

  return {
    period,
    tickets,
    unescalatable: unescalatable.sort((a, b) => a.id - b.id),
    unassignable: tickets.filter((t) => t.managerEmail === null).map((t) => t.managerId),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario C — a per-department roll-up, including the department with nobody in it
// ─────────────────────────────────────────────────────────────────────────────

export interface DepartmentRollup {
  departmentId: number;
  departmentCode: string;
  departmentName: string;
  /** Active employees with attendance data for the period. */
  headcount: number;
  /** Mean attendance rate to 2dp, or **null** when headcount is 0 — never 0, never omitted. */
  avgAttendanceRate: number | null;
  belowThreshold: number;
  /** The department's own bar, or the org-wide default via COALESCE. */
  threshold: number;
}

export interface RollupOracle {
  period: string;
  /** EVERY department, sorted by code. An empty one is a row, not an absence. */
  departments: DepartmentRollup[];
  orgHeadcount: number;
  orgBelowThreshold: number;
  /** Departments with nobody in them — the divide-by-zero trap, named. */
  emptyDepartments: string[];
}

/**
 * Computed from the dataset definition, independently of `expectedScreening`.
 *
 * `belowThreshold` deliberately re-derives the comparison rather than counting
 * scenario A's `flagged`. If the threshold logic is wrong, two oracles sharing
 * it would agree with each other and both be wrong — the exact failure the
 * separate `hr_demo_alt` oracle exists to prevent.
 */
export function expectedRollup(period = DEMO_PERIOD): RollupOracle {
  const { monthly } = buildAttendance();
  const rateOf = (id: number) => monthly.find((m) => m.employeeId === id && m.period === period);

  const departments: DepartmentRollup[] = DEPARTMENTS.map((dept) => {
    const threshold = thresholdFor(dept.id);
    // Same inclusion rule as screening: active, and has data for the period.
    // The mid-month leaver is `exited`, so they fall out here — a roll-up that
    // counts them drags the department average down by a person who left.
    const members = ROSTER.filter((e) => e.deptId === dept.id && e.status === "active").filter((e) =>
      Boolean(rateOf(e.id)),
    );
    const rates = members.map((e) => rateOf(e.id)!.attendanceRate);
    return {
      departmentId: dept.id,
      departmentCode: dept.code,
      departmentName: dept.name,
      headcount: members.length,
      avgAttendanceRate: rates.length
        ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 100) / 100
        : null,
      belowThreshold: rates.filter((r) => r < threshold).length,
      threshold,
    };
  }).sort((a, b) => a.departmentCode.localeCompare(b.departmentCode));

  return {
    period,
    departments,
    orgHeadcount: departments.reduce((n, d) => n + d.headcount, 0),
    orgBelowThreshold: departments.reduce((n, d) => n + d.belowThreshold, 0),
    emptyDepartments: departments.filter((d) => d.headcount === 0).map((d) => d.departmentCode),
  };
}
