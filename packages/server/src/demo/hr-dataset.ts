/**
 * Deterministic synthetic HR dataset (plans/hr-demo-stub-services-plan.md §5).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS NOT EMPLOYEE DATA. Every name is invented. Every address uses
 * `acme-hr.example` — a domain reserved by RFC 2606 that can never resolve or
 * receive mail. Nothing here is derived from, sampled from, or anonymised from a
 * real HR system. If you are looking at this data wondering whether it is safe
 * to expose: it is, and it must never be replaced with data that isn't.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * DETERMINISM: no Math.random anywhere. Attendance is specified as an exact
 * count of attended days per employee-month, so the edge cases below are
 * GUARANTEED, not probabilistic — a demo whose "9 employees below threshold"
 * drifts between seeds is useless for judging whether a generated script is
 * correct.
 *
 * THE POLICY IS A JOIN, NOT A CONSTANT: Engineering requires 85%, everyone else
 * 80% (the org-wide default row with department_id IS NULL). Employee #14 sits
 * at 80.95% — above the default, below Engineering's bar. A script that
 * hardcodes 80 will silently miss them, and that is the single most valuable
 * thing this dataset detects.
 */

export const DEMO_AS_OF = "2026-06-30";
/** The month automations screen: "previous month" as of the current date (July 2026). */
export const DEMO_PERIOD = "2026-06";
export const DEMO_EMAIL_DOMAIN = "acme-hr.example";
/** A second reserved-domain address the mail stub always hard-bounces. */
export const DEMO_BOUNCE_DOMAIN = "acme-hr-bounce.example";

/** Weekday public holidays — force correct working-day counting. */
export const HOLIDAYS = new Set(["2026-05-25", "2026-06-19"]);

export const MONTHS = ["2026-04", "2026-05", "2026-06"] as const;

export interface Office {
  id: number;
  code: string;
  city: string;
  country: string;
  region: "AMER" | "EMEA" | "APAC";
  timezone: string;
}

export const OFFICES: Office[] = [
  { id: 1, code: "NYC", city: "New York", country: "United States", region: "AMER", timezone: "America/New_York" },
  { id: 2, code: "AUS", city: "Austin", country: "United States", region: "AMER", timezone: "America/Chicago" },
  { id: 3, code: "LON", city: "London", country: "United Kingdom", region: "EMEA", timezone: "Europe/London" },
  { id: 4, code: "BER", city: "Berlin", country: "Germany", region: "EMEA", timezone: "Europe/Berlin" },
  { id: 5, code: "BLR", city: "Bengaluru", country: "India", region: "APAC", timezone: "Asia/Kolkata" },
  // Deliberately a single-employee office — exercises grouping code that assumes
  // every group has several members.
  { id: 6, code: "SIN", city: "Singapore", country: "Singapore", region: "APAC", timezone: "Asia/Singapore" },
];

export interface Department {
  id: number;
  code: string;
  name: string;
  costCentre: string;
}

export const DEPARTMENTS: Department[] = [
  { id: 1, code: "ENG", name: "Engineering", costCentre: "CC-1001" },
  { id: 2, code: "SLS", name: "Sales", costCentre: "CC-2001" },
  { id: 3, code: "SUP", name: "Customer Support", costCentre: "CC-2002" },
  { id: 4, code: "FIN", name: "Finance", costCentre: "CC-3001" },
  { id: 5, code: "HR", name: "People & Culture", costCentre: "CC-3002" },
  { id: 6, code: "MKT", name: "Marketing", costCentre: "CC-2003" },
  // Deliberately EMPTY — exercises division-by-zero / empty-result handling.
  { id: 7, code: "LEG", name: "Legal", costCentre: "CC-3003" },
];

/** department_id NULL = org-wide default; a department row overrides it. */
export const POLICY_THRESHOLDS = [
  { id: 1, departmentId: null as number | null, minAttendanceRate: 80.0, effectiveFrom: "2026-01-01" },
  { id: 2, departmentId: 1, minAttendanceRate: 85.0, effectiveFrom: "2026-01-01" }, // Engineering
];

export interface RosterEntry {
  id: number;
  code: string;
  name: string;
  deptId: number;
  officeId: number;
  managerId: number | null;
  title: string;
  employmentType: "full_time" | "part_time" | "contractor";
  status: "active" | "on_leave" | "exited";
  hireDate: string;
  exitDate?: string;
  /** Local-part override; omit to derive from the name. */
  emailLocal?: string;
  /** true → work_email IS NULL (contractor with no corporate mailbox). */
  noEmail?: boolean;
  /** true → address on the always-bouncing reserved domain. */
  bounces?: boolean;
  /** Attended working days per month, keyed by YYYY-MM. Clamped to availability. */
  attended: Record<string, number>;
}

// Working days per month after holidays: 2026-04 → 22, 2026-05 → 20, 2026-06 → 21.
// "Safe" means at/above the department bar: ENG needs ≥18/21 (85.71%) in June,
// everyone else ≥17/21 (80.95%).
const A = (apr: number, may: number, jun: number) => ({ "2026-04": apr, "2026-05": may, "2026-06": jun });

export const ROSTER: RosterEntry[] = [
  // ── Executive ──────────────────────────────────────────────────────────────
  // The only employee with manager_id NULL. Manager-escalation logic must not
  // crash or invent a recipient at the root of the tree.
  { id: 1, code: "E0001", name: "Priya Raghunathan", deptId: 5, officeId: 1, managerId: null, title: "Chief Executive Officer", employmentType: "full_time", status: "active", hireDate: "2019-02-04", attended: A(22, 20, 21) },

  // ── Department heads (report to the CEO) ───────────────────────────────────
  { id: 2, code: "E0002", name: "Daniel Okonkwo", deptId: 1, officeId: 3, managerId: 1, title: "VP Engineering", employmentType: "full_time", status: "active", hireDate: "2019-08-12", attended: A(21, 19, 20) },
  // BELOW THRESHOLD (66.67%) and reports to the CEO — the escalation email for
  // this one has to go to a manager whose own manager is NULL.
  { id: 3, code: "E0003", name: "Marta Villalobos", deptId: 2, officeId: 1, managerId: 1, title: "VP Sales", employmentType: "full_time", status: "active", hireDate: "2020-01-06", attended: A(20, 18, 14) },
  { id: 4, code: "E0004", name: "Tobias Lindqvist", deptId: 3, officeId: 4, managerId: 1, title: "Head of Customer Support", employmentType: "full_time", status: "active", hireDate: "2020-05-18", attended: A(22, 20, 20) },
  { id: 5, code: "E0005", name: "Aisha Nabatanzi", deptId: 4, officeId: 1, managerId: 1, title: "Head of Finance", employmentType: "full_time", status: "active", hireDate: "2020-09-01", attended: A(21, 20, 21) },
  { id: 6, code: "E0006", name: "Gregor Halvorsen", deptId: 5, officeId: 3, managerId: 1, title: "Head of People & Culture", employmentType: "full_time", status: "active", hireDate: "2021-03-15", attended: A(22, 19, 20) },
  { id: 7, code: "E0007", name: "Lucia Ferrante", deptId: 6, officeId: 4, managerId: 1, title: "Head of Marketing", employmentType: "full_time", status: "active", hireDate: "2021-06-07", attended: A(20, 20, 19) },

  // ── Engineering (dept 1, threshold 85%) ───────────────────────────────────
  { id: 8, code: "E0008", name: "Kwame Boateng", deptId: 1, officeId: 3, managerId: 2, title: "Staff Engineer", employmentType: "full_time", status: "active", hireDate: "2020-02-17", attended: A(22, 20, 21) },
  // BELOW THRESHOLD 76.19%
  { id: 9, code: "E0009", name: "Ingrid Solberg", deptId: 1, officeId: 4, managerId: 2, title: "Senior Engineer", employmentType: "full_time", status: "active", hireDate: "2021-04-05", attended: A(20, 17, 16) },
  { id: 10, code: "E0010", name: "Rahul Deshmukh", deptId: 1, officeId: 5, managerId: 2, title: "Senior Engineer", employmentType: "full_time", status: "active", hireDate: "2021-07-19", attended: A(21, 20, 20) },
  { id: 11, code: "E0011", name: "Noor Al-Sabah", deptId: 1, officeId: 3, managerId: 2, title: "Engineering Manager", employmentType: "full_time", status: "active", hireDate: "2020-11-02", attended: A(22, 19, 21) },
  { id: 12, code: "E0012", name: "Felix Brandtner", deptId: 1, officeId: 4, managerId: 11, title: "Engineer II", employmentType: "full_time", status: "active", hireDate: "2022-01-10", attended: A(21, 20, 19) },
  { id: 13, code: "E0013", name: "Yuki Tanabe", deptId: 1, officeId: 5, managerId: 11, title: "Engineer II", employmentType: "full_time", status: "active", hireDate: "2022-03-28", attended: A(22, 20, 20) },
  // ⚠ THE HARDCODED-80 TRAP: 17/21 = 80.95%. Above the org default (80), below
  // Engineering's 85. Only a script that JOINS policy_thresholds finds them.
  { id: 14, code: "E0014", name: "Beatriz Cardoso", deptId: 1, officeId: 3, managerId: 11, title: "Engineer II", employmentType: "full_time", status: "active", hireDate: "2022-05-16", attended: A(20, 18, 17) },
  { id: 15, code: "E0015", name: "Otto Weinbrenner", deptId: 1, officeId: 4, managerId: 11, title: "Engineer I", employmentType: "full_time", status: "active", hireDate: "2023-02-06", attended: A(21, 19, 20) },
  { id: 16, code: "E0016", name: "Chidinma Eze", deptId: 1, officeId: 3, managerId: 11, title: "Engineer I", employmentType: "full_time", status: "active", hireDate: "2023-04-24", attended: A(22, 20, 21) },
  { id: 17, code: "E0017", name: "Sander Vermeulen", deptId: 1, officeId: 4, managerId: 2, title: "Engineering Manager", employmentType: "full_time", status: "active", hireDate: "2021-09-13", attended: A(20, 19, 19) },
  { id: 18, code: "E0018", name: "Meera Krishnan", deptId: 1, officeId: 5, managerId: 17, title: "Engineer II", employmentType: "full_time", status: "active", hireDate: "2022-08-22", attended: A(22, 20, 20) },
  { id: 19, code: "E0019", name: "Emeka Nwachukwu", deptId: 1, officeId: 5, managerId: 17, title: "Engineer II", employmentType: "full_time", status: "active", hireDate: "2022-10-03", attended: A(21, 18, 21) },
  // BELOW THRESHOLD 71.43%
  { id: 20, code: "E0020", name: "Saoirse Mulligan", deptId: 1, officeId: 3, managerId: 17, title: "Engineer I", employmentType: "full_time", status: "active", hireDate: "2023-06-12", attended: A(19, 17, 15) },
  { id: 21, code: "E0021", name: "Tomas Havlicek", deptId: 1, officeId: 4, managerId: 17, title: "Engineer I", employmentType: "full_time", status: "active", hireDate: "2023-09-04", attended: A(22, 20, 20) },
  // EXCLUDED: on approved medical leave from 2026-06-15. 47.62% attendance is
  // fully explained by the leave record — screening must NOT email this person.
  { id: 22, code: "E0022", name: "Anja Petrovic", deptId: 1, officeId: 4, managerId: 17, title: "Senior Engineer", employmentType: "full_time", status: "on_leave", hireDate: "2021-11-08", attended: A(21, 19, 10) },
  { id: 23, code: "E0023", name: "Bilal Chaudhry", deptId: 1, officeId: 5, managerId: 2, title: "SRE", employmentType: "full_time", status: "active", hireDate: "2022-02-14", attended: A(21, 20, 21) },
  { id: 24, code: "E0024", name: "Hanne Bakker", deptId: 1, officeId: 3, managerId: 2, title: "SRE", employmentType: "full_time", status: "active", hireDate: "2022-06-27", attended: A(22, 19, 20) },
  { id: 25, code: "E0025", name: "Dmitri Kovalenko", deptId: 1, officeId: 4, managerId: 2, title: "QA Engineer", employmentType: "part_time", status: "active", hireDate: "2023-01-16", attended: A(20, 18, 18) },
  // EXCEPTION: contractor with NO work_email, and below threshold (71.43%).
  // A script must report this as an exception, not send mail to "None".
  { id: 26, code: "E0026", name: "Joaquín Serrano", deptId: 1, officeId: 5, managerId: 2, title: "Contract Engineer", employmentType: "contractor", status: "active", hireDate: "2025-10-06", noEmail: true, attended: A(19, 17, 15) },

  // ── Sales (dept 2, threshold 80%) ─────────────────────────────────────────
  { id: 27, code: "E0027", name: "Leonie Fischbach", deptId: 2, officeId: 1, managerId: 3, title: "Sales Manager", employmentType: "full_time", status: "active", hireDate: "2020-07-13", attended: A(21, 20, 20) },
  { id: 28, code: "E0028", name: "Oluwaseun Adeyemi", deptId: 2, officeId: 2, managerId: 27, title: "Account Executive", employmentType: "full_time", status: "active", hireDate: "2021-05-24", attended: A(22, 19, 21) },
  { id: 29, code: "E0029", name: "Camille Beauchêne", deptId: 2, officeId: 3, managerId: 27, title: "Account Executive", employmentType: "full_time", status: "active", hireDate: "2021-10-11", attended: A(20, 20, 19) },
  // BELOW THRESHOLD 76.19%
  { id: 30, code: "E0030", name: "Viktor Ahlström", deptId: 2, officeId: 4, managerId: 27, title: "Account Executive", employmentType: "full_time", status: "active", hireDate: "2022-04-04", attended: A(21, 18, 16) },
  { id: 31, code: "E0031", name: "Nadia Benkirane", deptId: 2, officeId: 1, managerId: 27, title: "SDR", employmentType: "full_time", status: "active", hireDate: "2023-03-20", attended: A(22, 20, 21) },
  { id: 32, code: "E0032", name: "Gustavo Peñaloza", deptId: 2, officeId: 2, managerId: 3, title: "Sales Manager", employmentType: "full_time", status: "active", hireDate: "2020-10-19", attended: A(21, 19, 20) },
  { id: 33, code: "E0033", name: "Fatima Zahra Idrissi", deptId: 2, officeId: 2, managerId: 32, title: "Account Executive", employmentType: "full_time", status: "active", hireDate: "2022-07-11", attended: A(20, 20, 20) },
  // EXCLUDED: exited mid-June. Attendance data stops at exit_date, so their
  // partial-month rate looks terrible — screening must filter on status/exit_date.
  { id: 34, code: "E0034", name: "Callum Fitzgerald", deptId: 2, officeId: 1, managerId: 32, title: "Account Executive", employmentType: "full_time", status: "exited", hireDate: "2022-09-05", exitDate: "2026-06-15", attended: A(21, 19, 5) },
  { id: 35, code: "E0035", name: "Ana Lucia Moreira", deptId: 2, officeId: 2, managerId: 32, title: "SDR", employmentType: "full_time", status: "active", hireDate: "2023-08-14", attended: A(22, 20, 21) },
  { id: 36, code: "E0036", name: "Henrik Døssing", deptId: 2, officeId: 3, managerId: 32, title: "Solutions Consultant", employmentType: "full_time", status: "active", hireDate: "2021-12-06", attended: A(21, 20, 19) },
  { id: 37, code: "E0037", name: "Zeynep Kaplan", deptId: 2, officeId: 4, managerId: 27, title: "Solutions Consultant", employmentType: "full_time", status: "active", hireDate: "2023-05-08", attended: A(20, 19, 20) },

  // ── Customer Support (dept 3, threshold 80%) ──────────────────────────────
  // BOUNCE CASE: below threshold (61.90%) AND the mail stub always hard-bounces
  // this address. Tests whether a script notices a failed send.
  { id: 38, code: "E0038", name: "Rosalind Achebe", deptId: 3, officeId: 4, managerId: 4, title: "Support Engineer", employmentType: "full_time", status: "active", hireDate: "2022-01-24", bounces: true, attended: A(20, 17, 13) },
  { id: 39, code: "E0039", name: "Mateusz Wojciechowski", deptId: 3, officeId: 4, managerId: 4, title: "Support Team Lead", employmentType: "full_time", status: "active", hireDate: "2021-02-15", attended: A(22, 20, 21) },
  { id: 40, code: "E0040", name: "Divya Ramaswamy", deptId: 3, officeId: 5, managerId: 39, title: "Support Engineer", employmentType: "full_time", status: "active", hireDate: "2022-11-14", attended: A(21, 20, 20) },
  // BELOW THRESHOLD 61.90%
  { id: 41, code: "E0041", name: "Bartholomew Ngata", deptId: 3, officeId: 5, managerId: 39, title: "Support Engineer", employmentType: "full_time", status: "active", hireDate: "2023-01-09", attended: A(19, 16, 13) },
  { id: 42, code: "E0042", name: "Sofia Kalliomäki", deptId: 3, officeId: 4, managerId: 39, title: "Support Engineer", employmentType: "full_time", status: "active", hireDate: "2023-04-17", attended: A(22, 19, 21) },
  { id: 43, code: "E0043", name: "Adebayo Ogundipe", deptId: 3, officeId: 2, managerId: 4, title: "Support Team Lead", employmentType: "full_time", status: "active", hireDate: "2021-08-02", attended: A(21, 20, 20) },
  { id: 44, code: "E0044", name: "Larissa Vondráčková", deptId: 3, officeId: 2, managerId: 43, title: "Support Engineer", employmentType: "full_time", status: "active", hireDate: "2022-12-05", attended: A(20, 20, 19) },
  // BELOW THRESHOLD 76.19% — just under the 80% bar.
  { id: 45, code: "E0045", name: "Kofi Mensah", deptId: 3, officeId: 2, managerId: 43, title: "Support Engineer", employmentType: "full_time", status: "active", hireDate: "2023-02-27", attended: A(21, 18, 16) },
  { id: 46, code: "E0046", name: "Isabella Rovigatti", deptId: 3, officeId: 1, managerId: 43, title: "Support Engineer", employmentType: "part_time", status: "active", hireDate: "2023-07-24", attended: A(22, 19, 20) },
  { id: 47, code: "E0047", name: "Thabo Molefe", deptId: 3, officeId: 5, managerId: 39, title: "Support Engineer", employmentType: "full_time", status: "active", hireDate: "2024-01-15", attended: A(21, 20, 21) },
  { id: 48, code: "E0048", name: "Wei-Lin Chang", deptId: 3, officeId: 5, managerId: 39, title: "Escalations Specialist", employmentType: "full_time", status: "active", hireDate: "2022-05-30", attended: A(22, 20, 20) },
  // Contractor with no work_email but COMPLIANT attendance — a NULL email that
  // must not be treated as a violation.
  { id: 49, code: "E0049", name: "Ravindra Pillai", deptId: 3, officeId: 5, managerId: 48, title: "Contract Support Agent", employmentType: "contractor", status: "active", hireDate: "2025-11-17", noEmail: true, attended: A(21, 20, 20) },
  { id: 50, code: "E0050", name: "Amara Nwosu", deptId: 3, officeId: 2, managerId: 43, title: "Support Engineer", employmentType: "full_time", status: "active", hireDate: "2024-03-04", attended: A(20, 19, 19) },

  // ── Finance (dept 4, threshold 80%) ──────────────────────────────────────
  { id: 51, code: "E0051", name: "Johan Kleinhans", deptId: 4, officeId: 1, managerId: 5, title: "Financial Controller", employmentType: "full_time", status: "active", hireDate: "2021-01-11", attended: A(22, 20, 21) },
  // BELOW THRESHOLD 71.43%
  { id: 52, code: "E0052", name: "Priyanka Chatterjee", deptId: 4, officeId: 5, managerId: 5, title: "Financial Analyst", employmentType: "full_time", status: "active", hireDate: "2022-03-07", attended: A(20, 17, 15) },
  { id: 53, code: "E0053", name: "Lorenzo Bertolucci", deptId: 4, officeId: 3, managerId: 51, title: "Accountant", employmentType: "full_time", status: "active", hireDate: "2022-08-08", attended: A(21, 20, 20) },
  { id: 54, code: "E0054", name: "Grace Mwangi", deptId: 4, officeId: 1, managerId: 51, title: "Accounts Payable Clerk", employmentType: "full_time", status: "active", hireDate: "2023-10-23", attended: A(22, 19, 21) },
  { id: 55, code: "E0055", name: "Sebastián Iriarte", deptId: 4, officeId: 2, managerId: 51, title: "Payroll Specialist", employmentType: "full_time", status: "active", hireDate: "2023-12-11", attended: A(21, 20, 19) },

  // ── People & Culture (dept 5, threshold 80%) ─────────────────────────────
  { id: 56, code: "E0056", name: "Mariam Toure", deptId: 5, officeId: 3, managerId: 6, title: "HR Business Partner", employmentType: "full_time", status: "active", hireDate: "2021-09-27", attended: A(22, 20, 21) },
  { id: 57, code: "E0057", name: "Aleksander Nowicki", deptId: 5, officeId: 1, managerId: 6, title: "Recruiter", employmentType: "full_time", status: "active", hireDate: "2022-06-13", attended: A(21, 19, 20) },
  { id: 58, code: "E0058", name: "Chandni Bhatt", deptId: 5, officeId: 5, managerId: 6, title: "People Operations Analyst", employmentType: "full_time", status: "active", hireDate: "2023-11-06", attended: A(20, 20, 20) },

  // ── Marketing (dept 6, threshold 80%) ────────────────────────────────────
  { id: 59, code: "E0059", name: "Espen Kirkeby", deptId: 6, officeId: 4, managerId: 7, title: "Content Lead", employmentType: "full_time", status: "active", hireDate: "2021-12-13", attended: A(22, 19, 21) },
  // BELOW THRESHOLD 66.67%
  { id: 60, code: "E0060", name: "Chiara Lombardi", deptId: 6, officeId: 3, managerId: 7, title: "Demand Generation Manager", employmentType: "full_time", status: "active", hireDate: "2022-09-19", attended: A(20, 17, 14) },
  { id: 61, code: "E0061", name: "Tunde Balogun", deptId: 6, officeId: 1, managerId: 7, title: "Product Marketing Manager", employmentType: "full_time", status: "active", hireDate: "2023-05-22", attended: A(21, 20, 20) },
  // The single occupant of the Singapore office.
  { id: 62, code: "E0062", name: "Siti Nurhaliza Rahman", deptId: 6, officeId: 6, managerId: 7, title: "Regional Marketing Manager", employmentType: "full_time", status: "active", hireDate: "2023-02-13", attended: A(22, 20, 21) },
];

export const LEAVE_REQUESTS = [
  // The exclusion that matters: approved medical leave covering the tail of the
  // screening month. Employee 22's 47.62% is explained by this row.
  { id: 1, employeeId: 22, leaveType: "medical", startDate: "2026-06-15", endDate: "2026-07-31", status: "approved", reason: "Approved medical leave — surgery and recovery" },
  { id: 2, employeeId: 9, leaveType: "annual", startDate: "2026-06-22", endDate: "2026-06-24", status: "approved", reason: "Annual leave" },
  { id: 3, employeeId: 41, leaveType: "unpaid", startDate: "2026-06-08", endDate: "2026-06-10", status: "approved", reason: "Unpaid personal leave" },
  { id: 4, employeeId: 30, leaveType: "annual", startDate: "2026-06-29", endDate: "2026-06-30", status: "approved", reason: "Annual leave" },
  // Pending, therefore NOT an exclusion — a script that ignores `status` will
  // wrongly excuse employee 60.
  { id: 5, employeeId: 60, leaveType: "medical", startDate: "2026-06-10", endDate: "2026-06-30", status: "pending", reason: "Medical leave request awaiting approval" },
  // Rejected, likewise not an exclusion.
  { id: 6, employeeId: 52, leaveType: "unpaid", startDate: "2026-06-15", endDate: "2026-06-19", status: "rejected", reason: "Unpaid leave — declined, insufficient notice" },
  { id: 7, employeeId: 3, leaveType: "annual", startDate: "2026-06-01", endDate: "2026-06-03", status: "approved", reason: "Annual leave" },
  { id: 8, employeeId: 45, leaveType: "parental", startDate: "2026-05-04", endDate: "2026-05-15", status: "approved", reason: "Parental leave" },
];

// ── derivation helpers ──────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Slugify a name into an email local-part; strips diacritics. */
export function emailLocal(name: string): string {
  const [first, ...rest] = name.trim().split(/\s+/);
  const last = rest.length ? rest[rest.length - 1] : "";
  const norm = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z]/g, "")
      .toLowerCase();
  return last ? `${norm(first)}.${norm(last)}` : norm(first);
}

export function workEmail(e: RosterEntry): string | null {
  if (e.noEmail) return null;
  const local = e.emailLocal ?? emailLocal(e.name);
  return `${local}@${e.bounces ? DEMO_BOUNCE_DOMAIN : DEMO_EMAIL_DOMAIN}`;
}

/** Working days (Mon-Fri, excluding HOLIDAYS) in a YYYY-MM period. */
export function workingDaysIn(period: string): string[] {
  const [y, m] = period.split("-").map(Number);
  const out: string[] = [];
  const d = new Date(Date.UTC(y, m - 1, 1));
  while (d.getUTCMonth() === m - 1) {
    const dow = d.getUTCDay();
    const s = iso(d);
    if (dow !== 0 && dow !== 6 && !HOLIDAYS.has(s)) out.push(s);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Holiday dates (weekdays only) inside a period — emitted as status='holiday'. */
export function holidaysIn(period: string): string[] {
  return [...HOLIDAYS].filter((h) => h.startsWith(period)).sort();
}

const approvedLeaveDays = (employeeId: number) =>
  LEAVE_REQUESTS.filter((l) => l.employeeId === employeeId && l.status === "approved");

const inLeave = (employeeId: number, day: string) =>
  approvedLeaveDays(employeeId).some((l) => day >= l.startDate && day <= l.endDate);

export interface DailyRow {
  employeeId: number;
  workDate: string;
  status: "present" | "absent" | "leave" | "wfh" | "holiday";
  hoursWorked: number;
}

export interface MonthlyRow {
  employeeId: number;
  period: string;
  workingDays: number;
  daysAttended: number;
  attendanceRate: number;
}

/**
 * Expand the roster into daily attendance rows and the monthly rollup derived
 * from them, so the two can never disagree.
 *
 * Non-attended days are assigned to APPROVED LEAVE days first (status 'leave'),
 * then to remaining days (status 'absent') taken from the end of the month.
 * That makes each low rate traceable to a reason rather than arbitrary.
 * `wfh` is sprinkled deterministically (every 7th attended day) and counts as
 * attended — a script that filters `status = 'present'` instead of
 * `status IN ('present','wfh')` will under-count, which we want to be able to see.
 */
export function buildAttendance(): { daily: DailyRow[]; monthly: MonthlyRow[] } {
  const daily: DailyRow[] = [];
  const monthly: MonthlyRow[] = [];

  for (const e of ROSTER) {
    for (const period of MONTHS) {
      const all = workingDaysIn(period);
      // Employment window: no rows before hire or after exit.
      const days = all.filter((d) => d >= e.hireDate && (!e.exitDate || d <= e.exitDate));
      if (days.length === 0) continue;

      const target = Math.min(e.attended[period] ?? days.length, days.length);
      const nonAttendedCount = days.length - target;

      const leaveDays = days.filter((d) => inLeave(e.id, d));
      const chosen = new Set<string>();
      // Prefer leave days as the non-attended ones — the low rate then has a
      // documented cause.
      for (const d of leaveDays) {
        if (chosen.size >= nonAttendedCount) break;
        chosen.add(d);
      }
      // Top up from the end of the month, skipping already-chosen days.
      for (let i = days.length - 1; i >= 0 && chosen.size < nonAttendedCount; i--) {
        chosen.add(days[i]);
      }

      let attendedSeen = 0;
      for (const d of days) {
        if (chosen.has(d)) {
          daily.push({
            employeeId: e.id,
            workDate: d,
            status: inLeave(e.id, d) ? "leave" : "absent",
            hoursWorked: 0,
          });
        } else {
          attendedSeen++;
          const wfh = attendedSeen % 7 === 0;
          daily.push({
            employeeId: e.id,
            workDate: d,
            status: wfh ? "wfh" : "present",
            hoursWorked: wfh ? 7.5 : 8,
          });
        }
      }

      // Holidays are recorded but excluded from working_days.
      for (const h of holidaysIn(period)) {
        if (h >= e.hireDate && (!e.exitDate || h <= e.exitDate)) {
          daily.push({ employeeId: e.id, workDate: h, status: "holiday", hoursWorked: 0 });
        }
      }

      const attended = days.length - chosen.size;
      monthly.push({
        employeeId: e.id,
        period,
        workingDays: days.length,
        daysAttended: attended,
        attendanceRate: Math.round((attended / days.length) * 10000) / 100,
      });
    }
  }
  return { daily, monthly };
}

/** Threshold applicable to a department: its own row, else the org default. */
export function thresholdFor(deptId: number): number {
  const own = POLICY_THRESHOLDS.find((p) => p.departmentId === deptId);
  return own ? own.minAttendanceRate : POLICY_THRESHOLDS.find((p) => p.departmentId === null)!.minAttendanceRate;
}

/**
 * The expected answer to the flagship screening task, computed independently of
 * any generated script. This is the ORACLE the eval set (§6) scores against —
 * without it, "did the script get it right?" is a judgement call.
 */
export function expectedScreening(period = DEMO_PERIOD) {
  const { monthly } = buildAttendance();
  const rateOf = (id: number) => monthly.find((m) => m.employeeId === id && m.period === period);

  const flagged: Array<{ id: number; name: string; rate: number; threshold: number; email: string | null }> = [];
  const excluded: Array<{ id: number; name: string; reason: string }> = [];

  for (const e of ROSTER) {
    const m = rateOf(e.id);
    if (!m) {
      excluded.push({ id: e.id, name: e.name, reason: "no attendance data for period" });
      continue;
    }
    if (e.status === "exited") {
      excluded.push({ id: e.id, name: e.name, reason: `exited ${e.exitDate}` });
      continue;
    }
    if (e.status === "on_leave") {
      excluded.push({ id: e.id, name: e.name, reason: "on approved leave" });
      continue;
    }
    const threshold = thresholdFor(e.deptId);
    if (m.attendanceRate < threshold) {
      flagged.push({ id: e.id, name: e.name, rate: m.attendanceRate, threshold, email: workEmail(e) });
    }
  }

  return {
    period,
    flagged: flagged.sort((a, b) => a.id - b.id),
    excluded: excluded.sort((a, b) => a.id - b.id),
    /** Below threshold but unreachable — must be reported, never silently dropped. */
    unmailable: flagged.filter((f) => f.email === null),
    bouncing: flagged.filter((f) => f.email?.endsWith(DEMO_BOUNCE_DOMAIN)),
  };
}
