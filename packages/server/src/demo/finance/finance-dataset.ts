/**
 * The Finance demo dataset, and the independently-computed correct answer for
 * every claim a Finance flow makes.
 *
 * ── ALL DATA IS SYNTHETIC ────────────────────────────────────────────────────
 *
 * Invented vendors, invented people, every address on an RFC 2606 reserved
 * domain that can never resolve or receive mail. Nothing here is derived from a
 * real company or a real ledger. Never replace it with real data.
 *
 * ── WHY THE ORACLE IS A SEPARATE FUNCTION FROM HR'S ──────────────────────────
 *
 * `financeOracle()` is not a parameterisation of `expectedScreening()` and must
 * never become one. The swap rehearsal established the reason: a shared oracle
 * lets a shared bug produce a wrong answer that agrees with itself. Two domains
 * with two independently written oracles is the only arrangement where "the
 * flow agreed with the oracle" is evidence.
 *
 * It is also computed from the DEFINITIONS BELOW, never from a query result and
 * never from a flow run. If it read the database it would be a second
 * implementation of the same SQL, and the two would be wrong together the first
 * time somebody fixed a bug in one.
 *
 * ── THE TRAPS, AND WHAT EACH ONE COSTS SOMEBODY WHO MISSES IT ────────────────
 *
 *  1. Due exactly on the reporting date (INV-2026-0025 at 2026-04-30,
 *     INV-2026-0008 at 2026-05-31, INV-2026-0017 at 2026-06-30). Zero days past
 *     due is not overdue. A `>=` chases a vendor on the day payment is due.
 *  2. A duplicate invoice (INV-2026-0003 / INV-2026-0023): same vendor, same
 *     amount, same issue date, different number. Paying both is the loss.
 *     ⚠ The negative control is INV-2026-0002 / INV-2026-0013 — same vendor,
 *     same amount, DIFFERENT issue dates. A rule keyed on (vendor, amount)
 *     alone flags them and is wrong.
 *  3. A credit note (INV-2026-0024, negative amount, status `credit`). Chasing
 *     it demands money the supplier is owed.
 *  4. A vendor with no payment terms (Harbour Legal, INV-2026-0007 with a NULL
 *     due date). The due date only exists after a COALESCE to the org default —
 *     the same missing-COALESCE failure measured on the HR dataset.
 *  5. A claim exactly at the policy limit (EXP-0003, EXP-0007). The limit is
 *     inclusive; a `>=` sends a compliant claim to an approver.
 *  6. A cost centre with zero spend (CC-RND). The empty-group case: a report
 *     built on an inner join drops it, and a dormant cost centre with budget
 *     left on it is exactly what a variance report exists to surface.
 *  7. A stale status (INV-2026-0011: fully paid, still reads `open`) and a
 *     partial payment (INV-2026-0005: $432.00 invoiced, $400.00 paid).
 *     Outstanding comes from `payments`, never from `status`.
 *  8. A rejected claim that is over policy (EXP-0017). Settled is settled; it
 *     must not be routed for approval again.
 *  9. ⚠ THE UNITS TRAP. `invoices.amount_cents` and `expense_claims
 *     .amount_cents` are minor units; `budgets.amount` is major units.
 */

// ── Periods ──────────────────────────────────────────────────────────────────

/**
 * The reporting periods this dataset is tuned for.
 *
 * Like the HR dataset, the traps are tuned to the reporting month and a single
 * period does not exercise them all. Run every harness at more than one:
 *
 *   2026-04   ZERO overdue invoices and ZERO claims over policy — the empty
 *             case, and the only period that exercises it.
 *   2026-05   6 overdue (5 in 1-30, 1 in 31-60), 3 over policy.
 *   2026-06   15 overdue across three buckets (9 / 5 / 1), 4 over policy, and
 *             the only period where the unmailable and bouncing vendors both
 *             have something outstanding.
 *
 * Three things hold at EVERY period, which is what makes them assertable rather
 * than tuned: exactly one duplicate pair, exactly one invoice whose status is
 * stale, and exactly one cost centre with zero spend.
 */
export const FINANCE_PERIODS = ["2026-04", "2026-05", "2026-06"] as const;
export type FinancePeriod = (typeof FINANCE_PERIODS)[number];

/** The default reporting period, matching the HR dataset's. */
export const FINANCE_DEFAULT_PERIOD: FinancePeriod = "2026-06";

/** Org-wide payment terms, used when a vendor states none. Mirrors org_settings. */
export const DEFAULT_PAYMENT_TERMS_DAYS = 30;

/** Last calendar day of a `YYYY-MM` period — the "as of" date for that report. */
export function asOfDate(period: string): string {
  const [y, m] = period.split("-").map(Number);
  // Day 0 of the next month is the last day of this one, in UTC.
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** `YYYY-MM` of a date, for grouping into periods. */
export function periodOf(iso: string): string {
  return iso.slice(0, 7);
}

// ── Reference data ───────────────────────────────────────────────────────────

export interface CostCentre {
  id: number;
  code: string;
  name: string;
  ownerEmail: string;
  active: boolean;
}

export const COST_CENTRES: CostCentre[] = [
  { id: 1, code: "CC-ENG", name: "Engineering", ownerEmail: "eng.lead@acme-fin.example", active: true },
  { id: 2, code: "CC-MKT", name: "Marketing", ownerEmail: "mkt.lead@acme-fin.example", active: true },
  { id: 3, code: "CC-OPS", name: "Operations", ownerEmail: "ops.lead@acme-fin.example", active: true },
  { id: 4, code: "CC-FIN", name: "Finance", ownerEmail: "fin.lead@acme-fin.example", active: true },
  { id: 5, code: "CC-FAC", name: "Facilities", ownerEmail: "fac.lead@acme-fin.example", active: true },
  // TRAP 6 — budgeted, owned, and spends nothing in any period.
  { id: 6, code: "CC-RND", name: "Research (dormant)", ownerEmail: "rnd.lead@acme-fin.example", active: true },
];

/** The domain whose mail always hard-bounces — a 202 from the mail tool, nothing delivered. */
export const BOUNCING_DOMAIN = "acme-supply-bounce.example";

export interface Vendor {
  id: number;
  code: string;
  name: string;
  /** NULL for a vendor with no AP contact on record. */
  contactEmail: string | null;
  /** NULL means the org default applies — TRAP 4. */
  paymentTermsDays: number | null;
  country: string;
  status: "active" | "inactive";
}

export const VENDORS: Vendor[] = [
  { id: 1, code: "V-001", name: "Northwind Supplies", contactEmail: "ap@northwind-supplies.example", paymentTermsDays: 30, country: "United States", status: "active" },
  { id: 2, code: "V-002", name: "Cobalt Cloud Services", contactEmail: "billing@cobalt-cloud.example", paymentTermsDays: 45, country: "Ireland", status: "active" },
  { id: 3, code: "V-003", name: "Pinewood Facilities", contactEmail: "accounts@pinewood-fac.example", paymentTermsDays: 15, country: "United States", status: "active" },
  // TRAP 4 — no terms of its own.
  { id: 4, code: "V-004", name: "Harbour Legal Partners", contactEmail: "invoices@harbour-legal.example", paymentTermsDays: null, country: "United Kingdom", status: "active" },
  { id: 5, code: "V-005", name: "Meridian Print", contactEmail: "ar@meridian-print.example", paymentTermsDays: 30, country: "United States", status: "active" },
  // Unmailable: no AP contact at all.
  { id: 6, code: "V-006", name: "Quill Stationery", contactEmail: null, paymentTermsDays: 30, country: "United States", status: "active" },
  // Mailable and undeliverable — the harder of the two to notice.
  { id: 7, code: "V-007", name: "Basalt Logistics", contactEmail: `ar@${BOUNCING_DOMAIN}`, paymentTermsDays: 30, country: "Germany", status: "active" },
  { id: 8, code: "V-008", name: "Lumen Analytics", contactEmail: "billing@lumen-analytics.example", paymentTermsDays: 60, country: "United States", status: "active" },
  { id: 9, code: "V-009", name: "Tessera Design", contactEmail: "hello@tessera-design.example", paymentTermsDays: 30, country: "Portugal", status: "active" },
  { id: 10, code: "V-010", name: "Ironvale Hardware", contactEmail: "ap@ironvale-hw.example", paymentTermsDays: 30, country: "United States", status: "active" },
  { id: 11, code: "V-011", name: "Solstice Catering", contactEmail: "accounts@solstice-catering.example", paymentTermsDays: 14, country: "United States", status: "active" },
  { id: 12, code: "V-012", name: "Verity Audit Co", contactEmail: "ar@verity-audit.example", paymentTermsDays: 30, country: "United States", status: "inactive" },
];

export interface Employee {
  id: number;
  code: string;
  name: string;
  /** NULL for the contractor — mirrors hr_demo's NULL-email contractor. */
  workEmail: string | null;
  costCentreId: number;
}

export const EMPLOYEES: Employee[] = [
  { id: 1, code: "F-001", name: "Amara Okonkwo", workEmail: "amara.okonkwo@acme-fin.example", costCentreId: 1 },
  { id: 2, code: "F-002", name: "Ben Kestrel", workEmail: "ben.kestrel@acme-fin.example", costCentreId: 2 },
  { id: 3, code: "F-003", name: "Chandra Rao", workEmail: "chandra.rao@acme-fin.example", costCentreId: 3 },
  { id: 4, code: "F-004", name: "Dina Alvarez", workEmail: "dina.alvarez@acme-fin.example", costCentreId: 4 },
  { id: 5, code: "F-005", name: "Erik Lindqvist", workEmail: "erik.lindqvist@acme-fin.example", costCentreId: 5 },
  { id: 6, code: "F-006", name: "Farida Haddad", workEmail: "farida.haddad@acme-fin.example", costCentreId: 3 },
  { id: 7, code: "F-007", name: "Gus Meiring", workEmail: "gus.meiring@acme-fin.example", costCentreId: 1 },
  { id: 8, code: "F-008", name: "Hana Ito", workEmail: "hana.ito@acme-fin.example", costCentreId: 2 },
  // No corporate mailbox — a rejection notice cannot be emailed to them.
  { id: 9, code: "F-009", name: "Ivan Petrov", workEmail: null, costCentreId: 4 },
  { id: 10, code: "F-010", name: "Julia Brandt", workEmail: "julia.brandt@acme-fin.example", costCentreId: 5 },
];

// ── Invoices, payments ───────────────────────────────────────────────────────

export type InvoiceStatus = "open" | "paid" | "void" | "credit";

export interface Invoice {
  id: number;
  number: string;
  vendorId: number;
  costCentreId: number;
  issueDate: string;
  /** NULL where the document states none — derived from vendor terms. TRAP 4. */
  dueDate: string | null;
  /** MINOR units. Negative on a credit note. */
  amountCents: number;
  status: InvoiceStatus;
  receivedDate: string;
}

export const INVOICES: Invoice[] = [
  { id: 1, number: "INV-2026-0001", vendorId: 1, costCentreId: 3, issueDate: "2026-04-02", dueDate: "2026-05-02", amountCents: 248_500, status: "paid", receivedDate: "2026-04-03" },
  { id: 2, number: "INV-2026-0002", vendorId: 2, costCentreId: 1, issueDate: "2026-04-03", dueDate: "2026-05-18", amountCents: 1_240_000, status: "paid", receivedDate: "2026-04-04" },
  { id: 3, number: "INV-2026-0003", vendorId: 5, costCentreId: 2, issueDate: "2026-04-08", dueDate: "2026-05-08", amountCents: 96_500, status: "open", receivedDate: "2026-04-09" },
  { id: 4, number: "INV-2026-0004", vendorId: 8, costCentreId: 1, issueDate: "2026-04-10", dueDate: "2026-06-09", amountCents: 780_000, status: "paid", receivedDate: "2026-04-11" },
  // Partially paid — outstanding is $32.00, not the $432.00 on the document.
  { id: 5, number: "INV-2026-0005", vendorId: 3, costCentreId: 5, issueDate: "2026-04-20", dueDate: "2026-05-05", amountCents: 43_200, status: "open", receivedDate: "2026-04-21" },
  { id: 6, number: "INV-2026-0006", vendorId: 11, costCentreId: 5, issueDate: "2026-04-22", dueDate: "2026-05-06", amountCents: 31_800, status: "open", receivedDate: "2026-04-23" },
  // TRAP 4 — no due date on the document, no terms on the vendor.
  { id: 7, number: "INV-2026-0007", vendorId: 4, costCentreId: 4, issueDate: "2026-04-25", dueDate: null, amountCents: 550_000, status: "open", receivedDate: "2026-04-27" },
  { id: 8, number: "INV-2026-0008", vendorId: 6, costCentreId: 3, issueDate: "2026-05-01", dueDate: "2026-05-31", amountCents: 128_000, status: "open", receivedDate: "2026-05-02" },
  { id: 9, number: "INV-2026-0009", vendorId: 7, costCentreId: 3, issueDate: "2026-05-02", dueDate: "2026-06-01", amountCents: 214_000, status: "open", receivedDate: "2026-05-03" },
  { id: 10, number: "INV-2026-0010", vendorId: 1, costCentreId: 3, issueDate: "2026-05-05", dueDate: "2026-06-04", amountCents: 187_500, status: "open", receivedDate: "2026-05-06" },
  // TRAP 7b — fully paid on 2026-06-15 and the row still says `open`.
  { id: 11, number: "INV-2026-0011", vendorId: 9, costCentreId: 2, issueDate: "2026-05-11", dueDate: "2026-06-10", amountCents: 62_000, status: "open", receivedDate: "2026-05-12" },
  { id: 12, number: "INV-2026-0012", vendorId: 10, costCentreId: 1, issueDate: "2026-05-12", dueDate: "2026-06-11", amountCents: 305_000, status: "open", receivedDate: "2026-05-13" },
  // Same vendor and amount as INV-2026-0002 — the duplicate rule's NEGATIVE control.
  { id: 13, number: "INV-2026-0013", vendorId: 2, costCentreId: 1, issueDate: "2026-05-15", dueDate: "2026-06-29", amountCents: 1_240_000, status: "paid", receivedDate: "2026-05-16" },
  { id: 14, number: "INV-2026-0014", vendorId: 5, costCentreId: 2, issueDate: "2026-05-18", dueDate: "2026-06-17", amountCents: 44_900, status: "open", receivedDate: "2026-05-19" },
  { id: 15, number: "INV-2026-0015", vendorId: 3, costCentreId: 5, issueDate: "2026-05-20", dueDate: "2026-06-04", amountCents: 51_000, status: "open", receivedDate: "2026-05-21" },
  { id: 16, number: "INV-2026-0016", vendorId: 12, costCentreId: 4, issueDate: "2026-05-21", dueDate: "2026-06-20", amountCents: 900_000, status: "void", receivedDate: "2026-05-22" },
  // TRAP 1c — due exactly on 2026-06-30. Zero days past due is not overdue.
  { id: 17, number: "INV-2026-0017", vendorId: 1, costCentreId: 3, issueDate: "2026-05-31", dueDate: "2026-06-30", amountCents: 76_000, status: "open", receivedDate: "2026-06-01" },
  { id: 18, number: "INV-2026-0018", vendorId: 8, costCentreId: 1, issueDate: "2026-06-01", dueDate: "2026-07-31", amountCents: 415_000, status: "open", receivedDate: "2026-06-02" },
  { id: 19, number: "INV-2026-0019", vendorId: 9, costCentreId: 2, issueDate: "2026-06-02", dueDate: "2026-07-02", amountCents: 88_000, status: "open", receivedDate: "2026-06-03" },
  { id: 20, number: "INV-2026-0020", vendorId: 10, costCentreId: 1, issueDate: "2026-06-05", dueDate: "2026-07-05", amountCents: 133_000, status: "open", receivedDate: "2026-06-06" },
  { id: 21, number: "INV-2026-0021", vendorId: 11, costCentreId: 5, issueDate: "2026-06-10", dueDate: "2026-06-24", amountCents: 29_400, status: "open", receivedDate: "2026-06-11" },
  { id: 22, number: "INV-2026-0022", vendorId: 3, costCentreId: 5, issueDate: "2026-06-12", dueDate: "2026-06-27", amountCents: 47_300, status: "open", receivedDate: "2026-06-13" },
  // TRAP 2 — same vendor, same amount, same issue date as INV-2026-0003.
  { id: 23, number: "INV-2026-0023", vendorId: 5, costCentreId: 2, issueDate: "2026-04-08", dueDate: "2026-05-08", amountCents: 96_500, status: "open", receivedDate: "2026-04-15" },
  // TRAP 3 — a credit note. Negative, and never chased.
  { id: 24, number: "INV-2026-0024", vendorId: 1, costCentreId: 3, issueDate: "2026-05-14", dueDate: "2026-06-13", amountCents: -45_000, status: "credit", receivedDate: "2026-05-15" },
  // TRAP 1a/1b — due exactly on 2026-04-30 (not overdue there), 61 days past due
  // at 2026-06-30 and the only invoice in that bucket.
  { id: 25, number: "INV-2026-0025", vendorId: 2, costCentreId: 1, issueDate: "2026-03-16", dueDate: "2026-04-30", amountCents: 660_000, status: "open", receivedDate: "2026-03-18" },
  // Operations' only June cost. Without it CC-OPS is a second zero-spend centre
  // in that period, and "exactly one cost centre spends nothing" — the assertion
  // that makes TRAP 6 checkable — stops being true for an unrelated reason.
  { id: 26, number: "INV-2026-0026", vendorId: 6, costCentreId: 3, issueDate: "2026-06-08", dueDate: "2026-07-08", amountCents: 96_000, status: "open", receivedDate: "2026-06-09" },
  // Finance's only May cost — its other invoice that month is void. Second
  // instance of TRAP 4 (no stated due date, vendor on the org default), and it
  // lands in a different period from the first, so a query that hardcodes one
  // month's answer cannot pass both.
  { id: 27, number: "INV-2026-0027", vendorId: 4, costCentreId: 4, issueDate: "2026-05-26", dueDate: null, amountCents: 180_000, status: "open", receivedDate: "2026-05-27" },
];

export interface Payment {
  id: number;
  invoiceId: number;
  paidDate: string;
  amountCents: number;
  method: "bank_transfer" | "card" | "cheque";
  reference: string;
}

export const PAYMENTS: Payment[] = [
  { id: 1, invoiceId: 1, paidDate: "2026-04-28", amountCents: 248_500, method: "bank_transfer", reference: "PMT-4001" },
  { id: 2, invoiceId: 2, paidDate: "2026-05-15", amountCents: 1_240_000, method: "bank_transfer", reference: "PMT-4002" },
  { id: 3, invoiceId: 4, paidDate: "2026-06-05", amountCents: 780_000, method: "bank_transfer", reference: "PMT-4003" },
  // TRAP 7a — partial. $400.00 of a $432.00 invoice.
  { id: 4, invoiceId: 5, paidDate: "2026-05-04", amountCents: 40_000, method: "card", reference: "PMT-4004" },
  { id: 5, invoiceId: 13, paidDate: "2026-06-20", amountCents: 1_240_000, method: "bank_transfer", reference: "PMT-4005" },
  // TRAP 7b — settles INV-2026-0011 in full while its status still reads `open`.
  { id: 6, invoiceId: 11, paidDate: "2026-06-15", amountCents: 62_000, method: "bank_transfer", reference: "PMT-4006" },
];

// ── Expenses ─────────────────────────────────────────────────────────────────

export interface ExpensePolicy {
  id: number;
  category: string;
  /** MINOR units. INCLUSIVE — at the limit is within policy. */
  limitCents: number;
  effectiveFrom: string;
}

export const EXPENSE_POLICY: ExpensePolicy[] = [
  { id: 1, category: "travel", limitCents: 150_000, effectiveFrom: "2026-01-01" },
  { id: 2, category: "meals", limitCents: 7_500, effectiveFrom: "2026-01-01" },
  { id: 3, category: "equipment", limitCents: 250_000, effectiveFrom: "2026-01-01" },
  { id: 4, category: "training", limitCents: 200_000, effectiveFrom: "2026-01-01" },
  { id: 5, category: "software", limitCents: 50_000, effectiveFrom: "2026-01-01" },
];

export interface ExpenseClaim {
  id: number;
  code: string;
  employeeId: number;
  costCentreId: number;
  category: string;
  claimDate: string;
  amountCents: number;
  status: "submitted" | "approved" | "rejected";
  receiptRef: string | null;
}

export const EXPENSE_CLAIMS: ExpenseClaim[] = [
  { id: 1, code: "EXP-0001", employeeId: 1, costCentreId: 1, category: "equipment", claimDate: "2026-04-06", amountCents: 189_000, status: "submitted", receiptRef: "RCP-0001" },
  { id: 2, code: "EXP-0002", employeeId: 2, costCentreId: 2, category: "travel", claimDate: "2026-04-14", amountCents: 132_500, status: "approved", receiptRef: "RCP-0002" },
  // TRAP 5 — exactly at the meals limit. Within policy.
  { id: 3, code: "EXP-0003", employeeId: 3, costCentreId: 3, category: "meals", claimDate: "2026-04-21", amountCents: 7_500, status: "submitted", receiptRef: "RCP-0003" },
  { id: 4, code: "EXP-0004", employeeId: 4, costCentreId: 4, category: "software", claimDate: "2026-04-28", amountCents: 48_000, status: "approved", receiptRef: "RCP-0004" },
  { id: 5, code: "EXP-0005", employeeId: 1, costCentreId: 1, category: "travel", claimDate: "2026-05-04", amountCents: 165_000, status: "submitted", receiptRef: "RCP-0005" },
  { id: 6, code: "EXP-0006", employeeId: 5, costCentreId: 5, category: "meals", claimDate: "2026-05-09", amountCents: 9_200, status: "submitted", receiptRef: "RCP-0006" },
  // TRAP 5 again — exactly at the software limit.
  { id: 7, code: "EXP-0007", employeeId: 2, costCentreId: 2, category: "software", claimDate: "2026-05-15", amountCents: 50_000, status: "submitted", receiptRef: "RCP-0007" },
  { id: 8, code: "EXP-0008", employeeId: 6, costCentreId: 3, category: "equipment", claimDate: "2026-05-22", amountCents: 310_000, status: "submitted", receiptRef: "RCP-0008" },
  { id: 9, code: "EXP-0009", employeeId: 3, costCentreId: 3, category: "training", claimDate: "2026-05-27", amountCents: 175_000, status: "approved", receiptRef: "RCP-0009" },
  // Over by $10.00 — a rounding-tolerant comparison misses it.
  { id: 10, code: "EXP-0010", employeeId: 4, costCentreId: 4, category: "travel", claimDate: "2026-06-03", amountCents: 151_000, status: "submitted", receiptRef: "RCP-0010" },
  { id: 11, code: "EXP-0011", employeeId: 7, costCentreId: 1, category: "software", claimDate: "2026-06-08", amountCents: 62_000, status: "submitted", receiptRef: "RCP-0011" },
  { id: 12, code: "EXP-0012", employeeId: 5, costCentreId: 5, category: "meals", claimDate: "2026-06-12", amountCents: 6_800, status: "approved", receiptRef: "RCP-0012" },
  // Under by $1.00.
  { id: 13, code: "EXP-0013", employeeId: 1, costCentreId: 1, category: "equipment", claimDate: "2026-06-15", amountCents: 249_900, status: "submitted", receiptRef: "RCP-0013" },
  { id: 14, code: "EXP-0014", employeeId: 6, costCentreId: 3, category: "travel", claimDate: "2026-06-19", amountCents: 143_000, status: "rejected", receiptRef: null },
  { id: 15, code: "EXP-0015", employeeId: 8, costCentreId: 2, category: "training", claimDate: "2026-06-24", amountCents: 214_000, status: "submitted", receiptRef: "RCP-0015" },
  // Over by $1.00.
  { id: 16, code: "EXP-0016", employeeId: 2, costCentreId: 2, category: "meals", claimDate: "2026-06-26", amountCents: 7_600, status: "submitted", receiptRef: "RCP-0016" },
  // TRAP 8 — over policy AND already rejected. Settled; never route it again.
  // Raised by the contractor with no work email, so a naive "notify the
  // claimant" branch has nowhere to send to as well.
  { id: 17, code: "EXP-0017", employeeId: 9, costCentreId: 4, category: "software", claimDate: "2026-06-29", amountCents: 51_000, status: "rejected", receiptRef: "RCP-0017" },
  { id: 18, code: "EXP-0018", employeeId: 10, costCentreId: 5, category: "equipment", claimDate: "2026-04-30", amountCents: 240_000, status: "approved", receiptRef: "RCP-0018" },
];

// ── Budgets ⚠ MAJOR UNITS ────────────────────────────────────────────────────

export interface Budget {
  id: number;
  costCentreId: number;
  period: string;
  /** ⚠ DOLLARS, not cents. The units trap lives here. */
  amount: string;
}

export const BUDGETS: Budget[] = [
  { id: 1, costCentreId: 1, period: "2026-04", amount: "20000.00" },
  { id: 2, costCentreId: 1, period: "2026-05", amount: "20000.00" },
  { id: 3, costCentreId: 1, period: "2026-06", amount: "18000.00" },
  { id: 4, costCentreId: 2, period: "2026-04", amount: "3000.00" },
  { id: 5, costCentreId: 2, period: "2026-05", amount: "2500.00" },
  { id: 6, costCentreId: 2, period: "2026-06", amount: "2500.00" },
  { id: 7, costCentreId: 3, period: "2026-04", amount: "5000.00" },
  { id: 8, costCentreId: 3, period: "2026-05", amount: "6000.00" },
  { id: 9, costCentreId: 3, period: "2026-06", amount: "6000.00" },
  { id: 10, costCentreId: 4, period: "2026-04", amount: "8000.00" },
  { id: 11, costCentreId: 4, period: "2026-05", amount: "12000.00" },
  { id: 12, costCentreId: 4, period: "2026-06", amount: "9000.00" },
  { id: 13, costCentreId: 5, period: "2026-04", amount: "1500.00" },
  { id: 14, costCentreId: 5, period: "2026-05", amount: "1500.00" },
  { id: 15, costCentreId: 5, period: "2026-06", amount: "1200.00" },
  // Budgeted and dormant — TRAP 6 only bites if the row exists.
  { id: 16, costCentreId: 6, period: "2026-04", amount: "500.00" },
  { id: 17, costCentreId: 6, period: "2026-05", amount: "500.00" },
  { id: 18, costCentreId: 6, period: "2026-06", amount: "500.00" },
];

export const ORG_SETTINGS: Array<{ key: string; value: string; description: string }> = [
  {
    key: "default_payment_terms_days",
    value: String(DEFAULT_PAYMENT_TERMS_DAYS),
    description:
      "Payment terms applied when a vendor states none. An overdue query without a COALESCE " +
      "to this value silently drops every invoice from such a vendor.",
  },
  {
    key: "reporting_currency",
    value: "USD",
    description: "Every amount in this database is USD. amount_cents is minor units; budgets.amount is major units.",
  },
  {
    key: "duplicate_rule",
    value: "vendor_id+amount_cents+issue_date",
    description:
      "What counts as a duplicate invoice. Vendor and amount alone is not enough — the same " +
      "vendor legitimately bills the same monthly amount in different months.",
  },
];

// ── The oracle ───────────────────────────────────────────────────────────────

export interface OverdueInvoice {
  invoiceNumber: string;
  vendorCode: string;
  vendorName: string;
  contactEmail: string | null;
  costCentreCode: string;
  effectiveDueDate: string;
  daysPastDue: number;
  outstandingCents: number;
  /** `1-30` | `31-60` | `61-90` | `90+` */
  bucket: string;
  /** True where the due date had to be derived from payment terms (TRAP 4). */
  dueDateDerived: boolean;
}

export interface DuplicatePair {
  vendorCode: string;
  amountCents: number;
  issueDate: string;
  invoiceNumbers: string[];
}

export interface ClaimOverPolicy {
  claimCode: string;
  employeeName: string;
  employeeEmail: string | null;
  costCentreCode: string;
  category: string;
  amountCents: number;
  limitCents: number;
  overByCents: number;
}

export interface CostCentreSpend {
  costCentreCode: string;
  costCentreName: string;
  ownerEmail: string;
  /** MINOR units — invoices (excluding void) plus non-rejected claims, this period. */
  actualCents: number;
  /** MAJOR units, verbatim from `budgets.amount`. */
  budgetAmount: string;
  /** MINOR units, the budget converted. This conversion is the units trap. */
  budgetCents: number;
  /** actual − budget, MINOR units. Positive is an overspend. */
  varianceCents: number;
  overBudget: boolean;
}

export interface FinanceOracle {
  period: string;
  asOf: string;
  overdue: OverdueInvoice[];
  overdueByBucket: Record<string, number>;
  duplicates: DuplicatePair[];
  claimsOverPolicy: ClaimOverPolicy[];
  spendByCostCentre: CostCentreSpend[];
  /** Vendors with an overdue invoice and no address at all. */
  unmailableVendors: string[];
  /** Vendors with an overdue invoice on the always-bouncing domain. */
  bouncingVendors: string[];
  /** Invoices whose `status` disagrees with what `payments` says — TRAP 7. */
  staleStatus: Array<{ invoiceNumber: string; status: InvoiceStatus; outstandingCents: number }>;
}

const vendorById = new Map(VENDORS.map((v) => [v.id, v]));
const costCentreById = new Map(COST_CENTRES.map((c) => [c.id, c]));
const employeeById = new Map(EMPLOYEES.map((e) => [e.id, e]));
const policyByCategory = new Map(EXPENSE_POLICY.map((p) => [p.category, p]));

/** Total paid against an invoice on or before `asOf`. */
function paidCents(invoiceId: number, asOf: string): number {
  return PAYMENTS.filter((p) => p.invoiceId === invoiceId && p.paidDate <= asOf).reduce(
    (n, p) => n + p.amountCents,
    0,
  );
}

/**
 * The due date, derived where the document does not state one.
 *
 * This is the COALESCE chain in one place: the invoice's own date, else the
 * vendor's terms, else the org default. It is written once here and once in
 * SQL in `finance-queries.ts`; those two agreeing is a real check, because they
 * were written from the schema rather than from each other.
 */
export function effectiveDueDate(inv: Invoice): { date: string; derived: boolean } {
  if (inv.dueDate) return { date: inv.dueDate, derived: false };
  const terms = vendorById.get(inv.vendorId)?.paymentTermsDays ?? DEFAULT_PAYMENT_TERMS_DAYS;
  return { date: addDays(inv.issueDate, terms), derived: true };
}

function bucketFor(days: number): string {
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

/**
 * The correct answer for `period`, computed from the definitions above.
 *
 * ⚠ Read the docblock at the top of this file before changing anything here.
 * This must stay independent of `expectedScreening()` and of every named query.
 */
export function financeOracle(period: string = FINANCE_DEFAULT_PERIOD): FinanceOracle {
  const asOf = asOfDate(period);

  // ── Overdue ────────────────────────────────────────────────────────────────
  //
  // Strictly greater than zero days past due. Due today is not overdue, and the
  // dataset has an invoice sitting exactly there in each of the three periods.
  const overdue: OverdueInvoice[] = [];
  for (const inv of INVOICES) {
    if (inv.status === "void" || inv.status === "credit") continue;
    if (inv.issueDate > asOf) continue;
    const outstanding = inv.amountCents - paidCents(inv.id, asOf);
    if (outstanding <= 0) continue;
    const { date: due, derived } = effectiveDueDate(inv);
    const days = daysBetween(due, asOf);
    if (days <= 0) continue;
    const v = vendorById.get(inv.vendorId)!;
    overdue.push({
      invoiceNumber: inv.number,
      vendorCode: v.code,
      vendorName: v.name,
      contactEmail: v.contactEmail,
      costCentreCode: costCentreById.get(inv.costCentreId)!.code,
      effectiveDueDate: due,
      daysPastDue: days,
      outstandingCents: outstanding,
      bucket: bucketFor(days),
      dueDateDerived: derived,
    });
  }
  overdue.sort((a, b) => b.daysPastDue - a.daysPastDue || a.invoiceNumber.localeCompare(b.invoiceNumber));

  const overdueByBucket: Record<string, number> = { "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  for (const o of overdue) overdueByBucket[o.bucket]++;

  // ── Duplicates ─────────────────────────────────────────────────────────────
  //
  // Keyed on (vendor, amount, issue date) — the rule org_settings states. Void
  // and credit rows are excluded: a credit note deliberately mirrors an invoice.
  const groups = new Map<string, Invoice[]>();
  for (const inv of INVOICES) {
    if (inv.status === "void" || inv.status === "credit") continue;
    if (inv.issueDate > asOf) continue;
    const key = `${inv.vendorId}|${inv.amountCents}|${inv.issueDate}`;
    groups.set(key, [...(groups.get(key) ?? []), inv]);
  }
  const duplicates: DuplicatePair[] = [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({
      vendorCode: vendorById.get(g[0].vendorId)!.code,
      amountCents: g[0].amountCents,
      issueDate: g[0].issueDate,
      invoiceNumbers: g.map((i) => i.number).sort(),
    }))
    .sort((a, b) => a.invoiceNumbers[0].localeCompare(b.invoiceNumbers[0]));

  // ── Claims over policy ─────────────────────────────────────────────────────
  //
  // In the period, strictly over an INCLUSIVE limit, and not already rejected.
  const claimsOverPolicy: ClaimOverPolicy[] = EXPENSE_CLAIMS.filter(
    (c) => periodOf(c.claimDate) === period && c.status !== "rejected",
  )
    .filter((c) => c.amountCents > policyByCategory.get(c.category)!.limitCents)
    .map((c) => {
      const emp = employeeById.get(c.employeeId)!;
      const lim = policyByCategory.get(c.category)!.limitCents;
      return {
        claimCode: c.code,
        employeeName: emp.name,
        employeeEmail: emp.workEmail,
        costCentreCode: costCentreById.get(c.costCentreId)!.code,
        category: c.category,
        amountCents: c.amountCents,
        limitCents: lim,
        overByCents: c.amountCents - lim,
      };
    })
    .sort((a, b) => a.claimCode.localeCompare(b.claimCode));

  // ── Budget versus actual ───────────────────────────────────────────────────
  //
  // Actual = invoices issued in the period (excluding void, including credit
  // notes, which reduce it) + claims dated in the period that were not
  // rejected. Every cost centre with a budget row appears, spend or no spend —
  // that is what makes CC-RND visible.
  const spendByCostCentre: CostCentreSpend[] = COST_CENTRES.map((cc) => {
    const invoiceCents = INVOICES.filter(
      (i) => i.costCentreId === cc.id && periodOf(i.issueDate) === period && i.status !== "void",
    ).reduce((n, i) => n + i.amountCents, 0);
    const claimCents = EXPENSE_CLAIMS.filter(
      (c) => c.costCentreId === cc.id && periodOf(c.claimDate) === period && c.status !== "rejected",
    ).reduce((n, c) => n + c.amountCents, 0);
    const actualCents = invoiceCents + claimCents;
    const budget = BUDGETS.find((b) => b.costCentreId === cc.id && b.period === period);
    const budgetAmount = budget?.amount ?? "0.00";
    // The one conversion the units trap is about, written where it can be read.
    const budgetCents = Math.round(Number(budgetAmount) * 100);
    return {
      costCentreCode: cc.code,
      costCentreName: cc.name,
      ownerEmail: cc.ownerEmail,
      actualCents,
      budgetAmount,
      budgetCents,
      varianceCents: actualCents - budgetCents,
      overBudget: actualCents > budgetCents,
    };
  }).sort((a, b) => a.costCentreCode.localeCompare(b.costCentreCode));

  const unmailableVendors = [
    ...new Set(overdue.filter((o) => o.contactEmail === null).map((o) => o.vendorCode)),
  ].sort();
  const bouncingVendors = [
    ...new Set(
      overdue.filter((o) => o.contactEmail?.endsWith(`@${BOUNCING_DOMAIN}`)).map((o) => o.vendorCode),
    ),
  ].sort();

  // ⚠ Against the WHOLE payment history, not against `asOf`.
  //
  // `status` is a present-tense field on the row; there is no as-of version of
  // it. Comparing it to an as-of balance reported three invoices as stale at
  // 2026-04 purely because they were paid in May and June — noise that buried
  // the one genuine case. The stale set is a property of the dataset, so it is
  // the same at every period, which is also what makes it assertable.
  const staleStatus = INVOICES.filter((i) => i.status === "open" || i.status === "paid")
    .map((i) => ({
      invoiceNumber: i.number,
      status: i.status,
      outstandingCents: i.amountCents - paidCents(i.id, "9999-12-31"),
    }))
    .filter(
      (r) =>
        (r.status === "open" && r.outstandingCents <= 0) ||
        (r.status === "paid" && r.outstandingCents > 0),
    );

  return {
    period,
    asOf,
    overdue,
    overdueByBucket,
    duplicates,
    claimsOverPolicy,
    spendByCostCentre,
    unmailableVendors,
    bouncingVendors,
    staleStatus,
  };
}
