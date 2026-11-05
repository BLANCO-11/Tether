/**
 * Which column values Foundry may KNOW without reading rows (2026-10-10) — ONE rule, always on, for every engine.
 *
 * A text column whose values are a SET OF CHOICES (a status, a department, a leave type) has its distinct values recorded
 * when the schema is read. The builder sees them, so a filter is written with values the data really holds; and a draft
 * run's mock data uses them, so that filter finds rows in a test. Before, this was an opt-in switch (`observe_values`,
 * off everywhere) beside a second, Postgres-only, name-keyed reader in the mock builder — a column named `dept` or
 * `division` was never read, and SQLite was never read at all, so every test filter on such a column matched nothing.
 *
 * What is read is a bounded GROUP BY — the distinct values and how often each occurs — never a row. A column qualifies
 * only when the DATA says it is a set of choices (few distinct values, each recurring) AND nothing marks it as
 * identifying: not a key or a reference, not named for a person or an identifier, and no value shaped like an email
 * address or a long number. The name rule is an exclusion only; what a column is called never makes it a category.
 */

/** At most this many distinct values make a set of choices; more, and the column has none. */
export const OBSERVE_MAX = 20;

/** Values sampled per column — a bound on cost on a large table, not a claim about coverage. */
export const OBSERVE_SAMPLE = 5000;

/** A value longer than this is prose, not a choice. */
const MAX_VALUE_LENGTH = 64;

/** A value that looks identifying — an email address, or a run of six or more digits (a phone, an account, an id). */
export const IDENTIFYING_VALUE = /\S@\S+\.\S|\d{6,}/;

/**
 * Words that mark a column as identifying a person, a record or free text. A column whose name contains one is never
 * read, however few values it has (a three-person team's `manager` column repeats). Split on snake_case AND camelCase
 * (`nameWords`), because the first version split on `_` only and read `referrerEmployeeId` on a camelCase schema.
 * Places (`city`, `location`) are NOT here: they are choices like `region`, and an exact address is `address`/`street`.
 */
export const IDENTIFYING_WORDS = new Set([
  "email", "mail", "name", "first", "last", "surname", "full", "phone", "mobile", "tel", "fax", "address",
  "street", "zip", "postcode", "postal", "ssn", "dob", "birth", "iban", "account", "card",
  "token", "secret", "password", "hash", "key", "url", "uri", "ip", "note", "notes", "comment", "description",
  "body", "message", "reason", "title", "subject", "code", "number", "ref", "reference", "id", "uuid", "login",
  "user", "username", "by", "owner", "author", "creator", "approver", "reviewer", "assignee", "manager",
  "employee", "candidate", "referrer", "recruiter", "agency", "company", "vendor", "customer", "partner",
  "person", "contact", "error", "log", "text", "detail", "details", "badge", "mailbox", "hostname", "tracking",
  "summary", "evidence",
]);

/** A column name's words — `jobStatus` and `job_status` both give ["job", "status"]. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** A column named for a person, an identifier or free text — never read. */
export const identifyingName = (column: string): boolean => nameWords(column).some((w) => IDENTIFYING_WORDS.has(w));

/**
 * Do these distinct values (from `rows` non-null rows) make a set of choices? Few, each recurring at least twice on
 * average, none longer than a label, and none identifying — one identifying value taints the column (a status set does
 * not contain an address, so its presence says this is not one).
 */
export const isChoiceSet = (values: readonly string[], rows: number): boolean =>
  values.length > 0 &&
  values.length <= OBSERVE_MAX &&
  values.length * 2 <= rows &&
  values.every((v) => v.trim() !== "" && v.length <= MAX_VALUE_LENGTH && !IDENTIFYING_VALUE.test(v));
