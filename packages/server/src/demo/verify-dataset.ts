/**
 * Dataset self-check (run: pnpm demo:verify). Asserts the invariants the demo's
 * value depends on — if these drift, "the script got the right answer" stops
 * being a meaningful statement.
 */
import {
  ROSTER, MONTHS, workingDaysIn, buildAttendance, expectedScreening,
  workEmail, DEMO_EMAIL_DOMAIN, DEMO_BOUNCE_DOMAIN, thresholdFor,
} from "./hr-dataset.js";

const problems: string[] = [];
const check = (ok: boolean, msg: string) => { if (!ok) problems.push(msg); };

const { daily, monthly } = buildAttendance();
const s = expectedScreening();

console.log(`employees=${ROSTER.length} daily=${daily.length} monthly=${monthly.length}`);
console.log(`working days: ${MONTHS.map((m) => `${m}=${workingDaysIn(m).length}`).join(" ")}`);

console.log(`\nFLAGGED (${s.flagged.length}):`);
for (const f of s.flagged)
  console.log(`  #${String(f.id).padStart(2)} ${f.name.padEnd(24)} ${String(f.rate).padStart(6)}% < ${f.threshold}%  ${f.email ?? "<NULL EMAIL>"}`);
console.log(`\nEXCLUDED (${s.excluded.length}):`);
for (const e of s.excluded) console.log(`  #${String(e.id).padStart(2)} ${e.name.padEnd(24)} ${e.reason}`);

// --- invariants ---
check(ROSTER.length === 62, `expected 62 employees, got ${ROSTER.length}`);
check(new Set(ROSTER.map((e) => e.id)).size === ROSTER.length, "duplicate employee ids");
check(ROSTER.filter((e) => e.managerId === null).length === 1, "exactly one employee must have a NULL manager (the CEO)");
check(ROSTER.filter((e) => workEmail(e) === null).length === 2, "expected 2 employees with NULL work_email");
check(ROSTER.filter((e) => e.status === "on_leave").length === 1, "expected 1 on_leave employee");
check(ROSTER.filter((e) => e.status === "exited").length === 1, "expected 1 exited employee");

// Every manager reference resolves, and nobody manages themselves.
const ids = new Set(ROSTER.map((e) => e.id));
for (const e of ROSTER) {
  check(e.managerId === null || ids.has(e.managerId), `#${e.id} manager ${e.managerId} does not exist`);
  check(e.managerId !== e.id, `#${e.id} is its own manager`);
}
// No cycles in the reporting chain.
for (const e of ROSTER) {
  const seen = new Set<number>();
  let cur: number | null = e.id;
  while (cur !== null) {
    if (seen.has(cur)) { problems.push(`reporting cycle at #${e.id}`); break; }
    seen.add(cur);
    cur = ROSTER.find((x) => x.id === cur)!.managerId;
  }
}

// Emails only ever on reserved, unroutable domains.
for (const e of ROSTER) {
  const m = workEmail(e);
  if (m === null) continue;
  check(
    m.endsWith(`@${DEMO_EMAIL_DOMAIN}`) || m.endsWith(`@${DEMO_BOUNCE_DOMAIN}`),
    `#${e.id} email ${m} is not on a reserved .example domain`,
  );
}
check(new Set(ROSTER.map((e) => workEmail(e)).filter(Boolean)).size === ROSTER.filter((e) => workEmail(e)).length, "duplicate work_email");

// The headline claims.
check(s.flagged.length === 11, `expected 11 employees below threshold, got ${s.flagged.length}`);
check(s.flagged.filter((f) => f.email && !f.email.endsWith(DEMO_BOUNCE_DOMAIN)).length === 9, "expected 9 normally-emailable violations");
check(s.unmailable.length === 1, `expected 1 below-threshold employee with no email, got ${s.unmailable.length}`);
check(s.bouncing.length === 1, `expected 1 below-threshold employee on the bouncing domain, got ${s.bouncing.length}`);
check(s.excluded.length === 2, `expected 2 excluded (on_leave + exited), got ${s.excluded.length}`);

// The hardcoded-80 trap must exist: an Engineering employee between 80 and 85.
const trap = s.flagged.filter((f) => f.threshold === 85 && f.rate >= 80 && f.rate < 85);
check(trap.length >= 1, "no Engineering employee sits between 80% and 85% — the hardcoded-80 trap is gone");
if (trap.length) console.log(`\nhardcoded-80 trap: #${trap[0].id} ${trap[0].name} at ${trap[0].rate}% (ENG bar ${trap[0].threshold}%)`);

// A department-level threshold really differs from the default.
check(thresholdFor(1) !== thresholdFor(2), "Engineering threshold must differ from the default");

// Empty department and single-occupant office.
check(ROSTER.filter((e) => e.deptId === 7).length === 0, "department 7 (Legal) must stay empty");
check(ROSTER.filter((e) => e.officeId === 6).length === 1, "office 6 (Singapore) must have exactly one occupant");

// Monthly rollups must agree with the daily rows they came from.
for (const m of monthly) {
  const rows = daily.filter((d) => d.employeeId === m.employeeId && d.workDate.startsWith(m.period) && d.status !== "holiday");
  const attended = rows.filter((d) => d.status === "present" || d.status === "wfh").length;
  check(rows.length === m.workingDays, `#${m.employeeId} ${m.period}: working_days ${m.workingDays} != ${rows.length} daily rows`);
  check(attended === m.daysAttended, `#${m.employeeId} ${m.period}: days_attended ${m.daysAttended} != ${attended} attended rows`);
  const rate = Math.round((attended / rows.length) * 10000) / 100;
  check(Math.abs(rate - m.attendanceRate) < 0.01, `#${m.employeeId} ${m.period}: rate ${m.attendanceRate} != ${rate}`);
}

// --- WS-A: least privilege, asked of the live database ---------------------
// Everything above is a check on the dataset DEFINITION and needs no database.
// This block checks the running one, because a reseed drops and recreates every
// table — and table privileges die with the table. Without this assertion here,
// a reseed could quietly restore write access to generated scripts and nothing
// would notice until something wrote to `employees`.
{
  const { Client } = await import("pg");
  const { hrDbUrl } = await import("./seed-hr-db.js");
  const { verifyReadOnlyRole } = await import("./hr-roles.js");
  const { config } = await import("../config/index.js");

  const c = new Client({ connectionString: hrDbUrl(), connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
    const { problems: privProblems, selectableTables } = await verifyReadOnlyRole(c);
    console.log(
      `\nread-only role: ${config.demo.roRole} — SELECT on ${selectableTables.length} table(s), ` +
        `${privProblems.length} privilege problem(s)`,
    );
    for (const p of privProblems) problems.push(`privilege: ${p}`);
    await c.end();
  } catch (e) {
    // Not seeded is not a regression — but say so plainly rather than passing
    // silently, or "verified" starts to mean less than it looks.
    await c.end().catch(() => {});
    console.log(
      `\nread-only role: NOT CHECKED — ${config.demo.dbName} unreachable ` +
        `(${(e as Error).message}). Run \`pnpm demo:seed\`, then re-run to verify privileges.`,
    );
  }
}

if (problems.length) {
  console.error(`\n✗ ${problems.length} invariant(s) violated:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`\n✓ all dataset invariants hold (${monthly.length} monthly rollups agree with ${daily.length} daily rows)`);
// There are TWO domains now, and this command only checks one of them. Said out
// loud rather than left to the docs: a second verifier that nobody remembers to
// run is a dataset nobody is verifying, and the failure would present as a
// Finance flow that agrees with itself.
console.log(
  `  ⚠ this covers the HR dataset only — run \`pnpm --filter @foundry/server finance:verify\` ` +
    `and \`legal:verify\` for the other two domains (both also check their named queries ` +
    `against their own oracles, which this harness does not do for HR).`,
);
