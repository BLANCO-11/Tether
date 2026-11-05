/**
 * Finance dataset self-check — `pnpm finance:verify`.
 *
 * Two halves, and the second is the one that matters.
 *
 *   A. INVARIANTS OF THE DEFINITIONS. Every trap is present, every address is on
 *      a reserved domain, the headline counts are what the documentation claims.
 *      No database involved. This is the shape `demo:verify` has.
 *
 *   B. THE NAMED QUERIES AGAINST THE ORACLE. Each query is executed as
 *      `finance_ro` against the seeded database, at all three periods, and its
 *      answer is compared to `financeOracle()`.
 *
 * Half B exists because half A cannot fail for the reason that actually matters.
 * The oracle and the SQL were written from the schema, independently — so when
 * they agree, the COALESCE to the org default and the division by 100 are both
 * right in both places. When they disagree, one of them is wrong and the harness
 * says which row. A dataset check that only reads TypeScript would have declared
 * the units trap "present" while every query got it backwards.
 *
 * ⚠ It FAILS rather than skipping when the database is unreachable. A verifier
 * that quietly drops its strongest half is the false green this repo keeps
 * finding; run `pnpm finance:seed` first.
 */
import { Client } from "pg";
import {
  BOUNCING_DOMAIN,
  BUDGETS,
  COST_CENTRES,
  EMPLOYEES,
  EXPENSE_CLAIMS,
  EXPENSE_POLICY,
  FINANCE_PERIODS,
  INVOICES,
  PAYMENTS,
  VENDORS,
  asOfDate,
  effectiveDueDate,
  financeOracle,
} from "./finance-dataset.js";
import { FINANCE_GENERATED_QUERIES as FINANCE_QUERIES } from "./finance-generated.js";
import { FINANCE_RO_ROLE, financeDbUrl, financeRoDbUrl, verifyFinanceReadOnlyRole } from "./seed-finance-db.js";

const problems: string[] = [];
const check = (ok: boolean, msg: string) => {
  if (!ok) problems.push(msg);
};
const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

// ═══════════════════════════════════════════════════════════════════════════
// A. Invariants of the definitions
// ═══════════════════════════════════════════════════════════════════════════

console.log(
  `vendors=${VENDORS.length} invoices=${INVOICES.length} payments=${PAYMENTS.length} ` +
    `claims=${EXPENSE_CLAIMS.length} costCentres=${COST_CENTRES.length} budgets=${BUDGETS.length}`,
);

// Referential integrity, before anything reads a join.
const ccIds = new Set(COST_CENTRES.map((x) => x.id));
const vIds = new Set(VENDORS.map((x) => x.id));
const eIds = new Set(EMPLOYEES.map((x) => x.id));
const invIds = new Set(INVOICES.map((x) => x.id));
const categories = new Set(EXPENSE_POLICY.map((p) => p.category));
for (const i of INVOICES) {
  check(vIds.has(i.vendorId), `${i.number} names vendor ${i.vendorId}, which does not exist`);
  check(ccIds.has(i.costCentreId), `${i.number} names cost centre ${i.costCentreId}, which does not exist`);
}
for (const p of PAYMENTS) check(invIds.has(p.invoiceId), `payment ${p.reference} names invoice ${p.invoiceId}, which does not exist`);
for (const e of EMPLOYEES) check(ccIds.has(e.costCentreId), `${e.code} names cost centre ${e.costCentreId}, which does not exist`);
for (const x of EXPENSE_CLAIMS) {
  check(eIds.has(x.employeeId), `${x.code} names employee ${x.employeeId}, which does not exist`);
  check(ccIds.has(x.costCentreId), `${x.code} names cost centre ${x.costCentreId}, which does not exist`);
  check(categories.has(x.category), `${x.code} names category "${x.category}", which has no policy row`);
}
check(new Set(INVOICES.map((i) => i.number)).size === INVOICES.length, "duplicate invoice_number");
check(new Set(VENDORS.map((v) => v.code)).size === VENDORS.length, "duplicate vendor_code");
check(new Set(EXPENSE_CLAIMS.map((x) => x.code)).size === EXPENSE_CLAIMS.length, "duplicate claim_code");

// ALL DATA SYNTHETIC — every address on a reserved `.example` domain.
const addresses = [
  ...VENDORS.map((v) => v.contactEmail),
  ...EMPLOYEES.map((e) => e.workEmail),
  ...COST_CENTRES.map((cc) => cc.ownerEmail),
].filter((a): a is string => a !== null);
for (const a of addresses) {
  check(
    /@[a-z0-9-]+(\.[a-z0-9-]+)*\.example$/.test(a),
    `${a} is not on a reserved .example domain — ALL DEMO DATA MUST BE SYNTHETIC`,
  );
}

// ── The traps, each asserted by the property that makes it a trap ────────────

// 1. Due exactly on the reporting date, in EVERY period. One per period, or the
//    boundary is only tested where somebody happened to look.
for (const period of FINANCE_PERIODS) {
  const asOf = asOfDate(period);
  const onTheDay = INVOICES.filter(
    (i) => i.status !== "void" && i.status !== "credit" && effectiveDueDate(i).date === asOf,
  );
  check(
    onTheDay.length >= 1,
    `no invoice is due exactly on ${asOf} — the ">= vs >" boundary is untested at ${period}`,
  );
  for (const i of onTheDay) {
    check(
      !financeOracle(period).overdue.some((o) => o.invoiceNumber === i.number),
      `${i.number} is due exactly on ${asOf} and the oracle calls it overdue — zero days past due is not overdue`,
    );
  }
}

// 2. Exactly one duplicate pair, plus the negative control that must NOT match.
const dup = financeOracle().duplicates;
check(dup.length === 1, `expected exactly 1 duplicate pair, got ${dup.length}`);
check(
  dup[0]?.invoiceNumbers.length === 2,
  `the duplicate group should hold 2 invoices, got ${dup[0]?.invoiceNumbers.length}`,
);
const sameVendorAndAmount = new Map<string, string[]>();
for (const i of INVOICES) {
  if (i.status === "void" || i.status === "credit") continue;
  const k = `${i.vendorId}|${i.amountCents}`;
  sameVendorAndAmount.set(k, [...(sameVendorAndAmount.get(k) ?? []), i.number]);
}
const looseMatches = [...sameVendorAndAmount.values()].filter((g) => g.length > 1);
check(
  looseMatches.length > dup.length,
  "the duplicate rule has no negative control — there must be a (vendor, amount) pair on " +
    "DIFFERENT dates, so a rule that ignores the date is visibly wrong",
);

// 3. A credit note, negative and never chased.
const credits = INVOICES.filter((i) => i.status === "credit");
check(credits.length === 1, `expected exactly 1 credit note, got ${credits.length}`);
check(credits.every((i) => i.amountCents < 0), "a credit note must have a negative amount");
for (const period of FINANCE_PERIODS) {
  const o = financeOracle(period);
  for (const cr of credits) {
    check(
      !o.overdue.some((x) => x.invoiceNumber === cr.number),
      `${cr.number} is a credit note and the oracle chases it at ${period}`,
    );
  }
}

// 4. A vendor with no terms, and an invoice from it with no stated due date, in
//    more than one period — a query that hardcodes one month cannot pass both.
const noTerms = VENDORS.filter((v) => v.paymentTermsDays === null);
check(noTerms.length >= 1, "no vendor falls back to the org default payment terms");
const derived = INVOICES.filter((i) => i.dueDate === null);
check(derived.length >= 2, `expected at least 2 invoices with no stated due date, got ${derived.length}`);
check(
  new Set(derived.map((i) => i.issueDate.slice(0, 7))).size >= 2,
  "every derived-due-date invoice is in the same month — the COALESCE trap is only live in one period",
);

// 5. A claim exactly at its limit, which must be WITHIN policy.
const limitByCategory = new Map(EXPENSE_POLICY.map((p) => [p.category, p.limitCents]));
const atLimit = EXPENSE_CLAIMS.filter((x) => x.amountCents === limitByCategory.get(x.category));
check(atLimit.length >= 1, "no expense claim sits exactly at its policy limit");
for (const x of atLimit) {
  const o = financeOracle(x.claimDate.slice(0, 7));
  check(
    !o.claimsOverPolicy.some((y) => y.claimCode === x.code),
    `${x.code} is exactly at the ${x.category} limit and the oracle flags it — the limit is inclusive`,
  );
}

// 6. Exactly one cost centre spends nothing, in every period.
for (const period of FINANCE_PERIODS) {
  const zero = financeOracle(period).spendByCostCentre.filter((s) => s.actualCents === 0);
  check(
    zero.length === 1,
    `at ${period} expected exactly 1 zero-spend cost centre, got ${zero.length} (${zero.map((z) => z.costCentreCode).join(",")})`,
  );
  check(
    BUDGETS.some((b) => b.period === period && b.costCentreId === COST_CENTRES.find((cc) => cc.code === zero[0]?.costCentreCode)?.id),
    `the zero-spend cost centre has no budget row at ${period} — an unbudgeted dormant centre is not the empty-group case`,
  );
}

// 7. Status is stale on exactly one invoice, and one payment is partial.
const stale = financeOracle().staleStatus;
check(stale.length === 1, `expected exactly 1 invoice whose status is stale, got ${stale.length}`);
const partial = PAYMENTS.filter((p) => {
  const inv = INVOICES.find((i) => i.id === p.invoiceId)!;
  const total = PAYMENTS.filter((q) => q.invoiceId === p.invoiceId).reduce((n, q) => n + q.amountCents, 0);
  return total > 0 && total < inv.amountCents;
});
check(partial.length >= 1, "no invoice is partially paid — nothing distinguishes outstanding from invoiced");

// 8. A rejected claim that is over policy, and is never routed.
const rejectedOver = EXPENSE_CLAIMS.filter(
  (x) => x.status === "rejected" && x.amountCents > limitByCategory.get(x.category)!,
);
check(rejectedOver.length >= 1, "no rejected claim is over policy — 'settled is settled' is untested");
for (const x of rejectedOver) {
  const o = financeOracle(x.claimDate.slice(0, 7));
  check(
    !o.claimsOverPolicy.some((y) => y.claimCode === x.code),
    `${x.code} is rejected and the oracle routes it for approval again`,
  );
}

// 9. THE UNITS TRAP. Both unit systems must be in play, and getting the
//    conversion wrong must produce a visibly different answer — otherwise the
//    trap is decorative.
check(
  BUDGETS.every((b) => /^\d+\.\d{2}$/.test(b.amount)),
  "budgets.amount must be written in major units with two decimals",
);
{
  const o = financeOracle("2026-04");
  const wrong = o.spendByCostCentre.filter((s) => s.actualCents > Number(s.budgetAmount)).length;
  const right = o.spendByCostCentre.filter((s) => s.overBudget).length;
  check(
    wrong !== right,
    "comparing cents against major units gives the same over-budget count as the correct " +
      "comparison — the units trap cannot be detected by any test",
  );
  check(right >= 1 && right < o.spendByCostCentre.length, "every or no cost centre is over budget at 2026-04");
}

// ── The headline claims, per period ──────────────────────────────────────────
const EXPECTED: Record<string, { overdue: number; overPolicy: number }> = {
  "2026-04": { overdue: 0, overPolicy: 0 },
  "2026-05": { overdue: 6, overPolicy: 3 },
  "2026-06": { overdue: 15, overPolicy: 4 },
};
console.log("");
for (const period of FINANCE_PERIODS) {
  const o = financeOracle(period);
  const e = EXPECTED[period];
  check(o.overdue.length === e.overdue, `${period}: expected ${e.overdue} overdue, got ${o.overdue.length}`);
  check(
    o.claimsOverPolicy.length === e.overPolicy,
    `${period}: expected ${e.overPolicy} claims over policy, got ${o.claimsOverPolicy.length}`,
  );
  console.log(
    `${period}  overdue=${String(o.overdue.length).padStart(2)} ` +
      `${Object.entries(o.overdueByBucket).map(([b, n]) => `${b}:${n}`).join(" ")}  ` +
      `overPolicy=${o.claimsOverPolicy.length}  ` +
      `overBudget=${o.spendByCostCentre.filter((s) => s.overBudget).length}/${o.spendByCostCentre.length}  ` +
      `unmailable=${o.unmailableVendors.length} bouncing=${o.bouncingVendors.length}`,
  );
}

// The empty case must exist, and it must be exactly one period. Two periods with
// nothing to report and a harness "at two periods" can miss every trap.
const empty = FINANCE_PERIODS.filter((p) => financeOracle(p).overdue.length === 0);
check(empty.length === 1, `expected exactly 1 period with no overdue invoices, got ${empty.length}`);

// The unmailable and bouncing vendors must both be reachable through the
// overdue list in at least one period, or those two rows are unreferenced data.
check(
  FINANCE_PERIODS.some((p) => financeOracle(p).unmailableVendors.length === 1),
  "no period surfaces the vendor with no accounts-payable address",
);
check(
  FINANCE_PERIODS.some((p) => financeOracle(p).bouncingVendors.length === 1),
  "no period surfaces the vendor on the hard-bouncing domain",
);
check(
  VENDORS.filter((v) => v.contactEmail?.endsWith(`@${BOUNCING_DOMAIN}`)).length === 1,
  "expected exactly one vendor on the bouncing domain",
);

// ═══════════════════════════════════════════════════════════════════════════
// B. The named queries, against the oracle
// ═══════════════════════════════════════════════════════════════════════════

const sqlOf = new Map(FINANCE_QUERIES.map((q) => [q.name, q.sqlText]));

async function runQueries() {
  console.log(`\n${"─".repeat(72)}\nnamed queries vs the oracle ${c.dim(`(as ${FINANCE_RO_ROLE})`)}\n`);

  const client = new Client({ connectionString: financeRoDbUrl(), connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    for (const period of FINANCE_PERIODS) {
      const o = financeOracle(period);
      const asOf = o.asOf;

      // 1. invoices_overdue — the row set, the outstanding amounts, the buckets
      //    and the derived due dates, all of it.
      const overdue = await client.query(sqlOf.get("invoices_overdue")!, [asOf]);
      const sqlNums = overdue.rows.map((r) => r.invoice_number as string).sort();
      const oracleNums = o.overdue.map((x) => x.invoiceNumber).sort();
      check(
        JSON.stringify(sqlNums) === JSON.stringify(oracleNums),
        `${period} invoices_overdue: SQL returned [${sqlNums}] and the oracle says [${oracleNums}]`,
      );
      for (const row of overdue.rows) {
        const expect = o.overdue.find((x) => x.invoiceNumber === row.invoice_number);
        if (!expect) continue;
        check(
          Number(row.outstanding_cents) === expect.outstandingCents,
          `${period} ${row.invoice_number}: SQL outstanding ${row.outstanding_cents}, oracle ${expect.outstandingCents}`,
        );
        check(
          Number(row.days_past_due) === expect.daysPastDue,
          `${period} ${row.invoice_number}: SQL ${row.days_past_due} days past due, oracle ${expect.daysPastDue}`,
        );
        check(
          row.bucket === expect.bucket,
          `${period} ${row.invoice_number}: SQL bucket ${row.bucket}, oracle ${expect.bucket}`,
        );
        check(
          row.due_date_derived === expect.dueDateDerived,
          `${period} ${row.invoice_number}: SQL derived=${row.due_date_derived}, oracle ${expect.dueDateDerived}`,
        );
      }

      // 2. duplicate_candidates
      const dups = await client.query(sqlOf.get("duplicate_candidates")!, [asOf]);
      check(
        dups.rows.length === o.duplicates.length,
        `${period} duplicate_candidates: SQL found ${dups.rows.length}, oracle ${o.duplicates.length}`,
      );
      for (const row of dups.rows) {
        const nums = String(row.invoice_numbers).split(", ").sort();
        check(
          o.duplicates.some((d) => JSON.stringify(d.invoiceNumbers) === JSON.stringify(nums)),
          `${period} duplicate_candidates: SQL group [${nums}] is not in the oracle`,
        );
      }

      // 3. claims_over_policy
      const claims = await client.query(sqlOf.get("claims_over_policy")!, [period]);
      const sqlClaims = claims.rows.map((r) => r.claim_code as string).sort();
      const oracleClaims = o.claimsOverPolicy.map((x) => x.claimCode).sort();
      check(
        JSON.stringify(sqlClaims) === JSON.stringify(oracleClaims),
        `${period} claims_over_policy: SQL [${sqlClaims}], oracle [${oracleClaims}]`,
      );
      for (const row of claims.rows) {
        const expect = o.claimsOverPolicy.find((x) => x.claimCode === row.claim_code)!;
        check(
          Number(row.over_by_cents) === expect.overByCents,
          `${period} ${row.claim_code}: SQL over by ${row.over_by_cents}, oracle ${expect.overByCents}`,
        );
      }

      // 4. spend_by_cost_centre — where the units trap either holds or does not.
      const spend = await client.query(sqlOf.get("spend_by_cost_centre")!, [period]);
      check(
        spend.rows.length === o.spendByCostCentre.length,
        `${period} spend_by_cost_centre: SQL ${spend.rows.length} rows, oracle ${o.spendByCostCentre.length} — ` +
          "a cost centre with no spend must still appear",
      );
      for (const row of spend.rows) {
        const expect = o.spendByCostCentre.find((x) => x.costCentreCode === row.cost_centre_code);
        if (!expect) {
          problems.push(`${period} spend_by_cost_centre: SQL returned unknown cost centre ${row.cost_centre_code}`);
          continue;
        }
        check(
          Number(row.actual_cents) === expect.actualCents,
          `${period} ${row.cost_centre_code}: SQL actual ${row.actual_cents}c, oracle ${expect.actualCents}c`,
        );
        check(
          Number(row.budget_cents) === expect.budgetCents,
          `${period} ${row.cost_centre_code}: SQL budget ${row.budget_cents}c, oracle ${expect.budgetCents}c ` +
            "— this is the units trap",
        );
        check(
          row.over_budget === expect.overBudget,
          `${period} ${row.cost_centre_code}: SQL over_budget=${row.over_budget}, oracle ${expect.overBudget}`,
        );
      }

      console.log(
        `  ${c.ok("✓")} ${period}  ${overdue.rows.length} overdue · ${dups.rows.length} duplicate group · ` +
          `${claims.rows.length} over policy · ${spend.rows.length} cost centres`,
      );
    }

    // 5. vendor_terms — no parameters, period-independent. The COALESCE here is
    //    what explains a derived due date to a person, so it must agree with the
    //    one in `invoices_overdue`.
    const terms = await client.query(sqlOf.get("vendor_terms")!);
    check(terms.rows.length === VENDORS.length, `vendor_terms: ${terms.rows.length} rows, expected ${VENDORS.length}`);
    for (const row of terms.rows) {
      const v = VENDORS.find((x) => x.code === row.vendor_code)!;
      const expected = v.paymentTermsDays ?? 30;
      check(
        Number(row.effective_terms_days) === expected,
        `vendor_terms ${row.vendor_code}: effective terms ${row.effective_terms_days}, expected ${expected}`,
      );
      check(
        row.uses_org_default === (v.paymentTermsDays === null),
        `vendor_terms ${row.vendor_code}: uses_org_default=${row.uses_org_default}, expected ${v.paymentTermsDays === null}`,
      );
    }
    console.log(`  ${c.ok("✓")} vendor_terms  ${terms.rows.length} vendors, org-default fallback resolved`);
  } finally {
    await client.end();
  }
}

// ── Privileges, from the catalogue rather than from what we granted ─────────
async function checkPrivileges() {
  const owner = new Client({ connectionString: financeDbUrl(), connectionTimeoutMillis: 5000 });
  await owner.connect();
  try {
    const v = await verifyFinanceReadOnlyRole(owner);
    for (const p of v.problems) problems.push(`privilege: ${p}`);
    console.log(
      `\n${v.problems.length ? c.bad("✗") : c.ok("✓")} ${FINANCE_RO_ROLE}: SELECT on ` +
        `${v.selectableTables.length} table(s), no write privileges, no CONNECT to the HR database`,
    );
  } finally {
    await owner.end();
  }
}

async function main() {
  try {
    await checkPrivileges();
    await runQueries();
  } catch (e) {
    // Deliberately fatal. Half B is the half that can catch a wrong query, and
    // a run that skipped it must not print a green summary.
    console.error(
      c.bad(
        `\n✗ could not reach ${FINANCE_RO_ROLE}@finance_demo: ${(e as Error).message}\n` +
          "  Run `pnpm finance:seed` first. This check does not skip — a dataset verifier that " +
          "silently drops its query half reports green on a broken query.",
      ),
    );
    process.exit(1);
  }

  console.log("");
  if (problems.length) {
    console.error(c.bad(`✗ ${problems.length} problem(s):`));
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(c.ok("✓ finance dataset OK — every trap present, and every named query agrees with the oracle"));
}

void main();
