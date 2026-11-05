/**
 * Value hints for a draft-run mock — I-230, D-268.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 * The mock generator fills a free-text column with `mock_<column>_<n>`, so a
 * draft run filtering `status = 'active'` or `period = '2026-06'` reads ZERO
 * rows, and a correct flow looks exactly like one with a wrong filter. Measured:
 * 8 of 16–18 green `build:measure` runs per round read nothing. The values a
 * filter needs exist only in the data (hr_demo declares no CHECK on `status`),
 * so no schema-only rule can recover them.
 *
 * ── Two sources, both deliberate ─────────────────────────────────────────────
 * 1. **Categories** — the distinct values of a SET-OF-CHOICES text column, as
 *    the schema recorded them when it was read (`introspect/choice-set.ts`: few
 *    values, each recurring, no identifying name or value — never a row). ONE
 *    rule for every engine, always on (2026-10-10). Until then this module had a
 *    second, Postgres-only reader that picked columns by NAME (`CATEGORY_WORDS`),
 *    so `dept`, `division` and every SQLite column stayed `mock_<column>_<n>`.
 * 2. **Authored** — values somebody already WROTE against this datasource:
 *    literals in its named queries' SQL (`status IS DISTINCT FROM 'void'`), and
 *    literals stored flows bind to a DB operation parameter (the operation's
 *    filter names the column). Nothing is read from the tenant's data.
 *
 * ── Failure is never a failed mock ───────────────────────────────────────────
 * Hints make a mock more useful; their absence leaves it exactly as it was. So
 * every failure here (unreachable database, a timeout, a column that errors)
 * degrades to "no hint" and is RECORDED in `notes`, which the build stores on
 * the fixture row — silence would read as "there were no categories".
 */
import pg from "pg";
import { IDENTIFYING_VALUE, IDENTIFYING_WORDS, nameWords, OBSERVE_MAX } from "./introspect/choice-set.js";
import { sqliteFileService } from "./sqlite-file.service.js";
import { readSqliteInWorker } from "./sqlite-read-worker.js";
import { config } from "../config/index.js";
import type { InferredLink } from "./mock-links.js";
import type { SandboxShape, SandboxTable, SandboxColumn } from "./sandbox-ddl.service.js";

/** At most this many values per column — the same bound the schema reader applies. */
export const MAX_CATEGORIES = OBSERVE_MAX;
/** Rows sampled per column for a span — a bound on cost, not a claim about coverage. */
export const SAMPLE_ROWS = 5000;
/** A hint longer than this is prose, not a category. */
const MAX_VALUE_LENGTH = 64;

export { IDENTIFYING_WORDS, nameWords };

export type HintSource = "categories" | "authored" | "range";

/**
 * A number column's TYPICAL span (2026-10-10): the 5th to 95th percentile of a sample, each end rounded OUTWARD to two
 * significant figures — so no single real value is carried, only where the bulk of them lie. Before, a number was
 * random in 1,000–91,000 whatever the column held (HR's `hours_worked` came out 1,471–6,116 a day).
 */
export interface NumberRange {
  min: number;
  max: number;
  /** Every sampled value was whole — the mock writes whole numbers too. */
  integer: boolean;
}

/** A range is summarised from at least this many values: fewer is a handful of real values, not a spread. */
export const MIN_RANGE_VALUES = 20;

/** A date column's span, DAY precision — never an exact timestamp. */
export interface DateRange {
  min: string;
  max: string;
}

export interface ValueHints {
  /**
   * `"<table>.<column>"` → the real column's earliest/latest DAY (D-268 option A,
   * 2026-09-24). Mock dates spread across it, so a flow asking about June 2026
   * finds June 2026 rows — before, every mock date sat in Jan–Mar 2024.
   */
  dateRanges?: Record<string, DateRange>;
  /** Used for a date column with no range of its own (option B, the fallback). */
  fallbackRange?: DateRange;
  /** `"<table>.<column>"` → the real column's typical number span (see NumberRange). */
  numberRanges?: Record<string, NumberRange>;
  /** `"<table>.<column>"` or `"*.<column>"` (any table) → values, in the order to cycle. */
  byColumn: Record<string, string[]>;
  /** Per key: how many values came from each source. Stored on the fixture row. */
  provenance: Record<string, Partial<Record<HintSource, number>>>;
  /** Why a source contributed nothing — never silence. */
  notes: string[];
  /** Columns the real data shows hold the same values across tables (`mock-links.ts`) — joined in the test data. */
  links?: InferredLink[];
}

export const EMPTY_HINTS: ValueHints = { byColumn: {}, provenance: {}, notes: [] };

/**
 * A date/timestamp column whose SPAN may be read: not a key or reference, and
 * no identifying word — `birth`/`dob` are in `IDENTIFYING_WORDS`, and a date
 * named for a person (`employee_start`) is refused with them. Two values per
 * column, rounded to the day; still no row is read.
 */
export function isDateRangeCandidate(col: SandboxColumn): boolean {
  // A date in a KEY is read too (2026-10-10): an attendance day keyed (employee, day) is the date every period filter
  // tests, and left out it stayed at the 2024 anchor while the rest of the row moved to the real span. A day-precision
  // span says nothing about a person; the generator keeps the key distinct (distinctDayIn).
  if ((col.kind !== "date" && col.kind !== "timestamp") || col.references) return false;
  return !nameWords(col.name).some((w) => IDENTIFYING_WORDS.has(w));
}

/**
 * The categories the SCHEMA already knows (builder-stability 2026-10-02, H02): introspection records a column's observed or declared
 * values (`valueDomain`), for every engine — SQLite included, where `readCategoryHints` cannot connect at all, so a mock's
 * `absence_type` held only `mock_absence_type_86937` and every filter on it matched nothing: a draft run "succeeded" without ever
 * exercising the filter. A text column of the shape takes its known values, within the same bounds a sampled one meets (not a key,
 * not an identifying name, at most MAX_CATEGORIES, each within the column's length). Keyed `<table>.<column>`, as categories are.
 */
export function domainCategories(
  shape: SandboxShape,
  known: ReadonlyArray<{ entityName: string; entitySchema?: string | null; columnName: string | null; valueDomain?: { values?: string[] } | null }>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const table of shape.tables) {
    for (const col of table.columns) {
      if (col.kind !== "text" || col.isPrimaryKey || col.references || nameWords(col.name).some((w) => IDENTIFYING_WORDS.has(w))) continue;
      const row = known.find((r) => r.columnName === col.name && r.entityName === table.name && (table.schema == null || r.entitySchema == null || r.entitySchema === table.schema));
      const values = (row?.valueDomain?.values ?? []).filter((v) => typeof v === "string" && v.trim() !== "" && (col.maxLength == null || v.length <= col.maxLength));
      if (values.length && values.length <= MAX_CATEGORIES) out[`${table.name}.${col.name}`] = [...values];
    }
  }
  return out;
}

/**
 * Literal comparisons in SQL somebody wrote — `col = 'x'`, `col <> 'x'`,
 * `col IS [NOT] DISTINCT FROM 'x'`, `col [NOT] IN ('a', 'b')`. Keyed by the bare
 * column name: resolving aliases is a SQL parser, and a hint on the wrong
 * `status` costs only a mock value that matches nothing, which is today's state.
 */
export function authoredLiteralsFromSql(sql: string): Array<{ column: string; value: string }> {
  const out: Array<{ column: string; value: string }> = [];
  const unq = (s: string) => s.replace(/''/g, "'");
  const cmp = /(?:\b\w+\.)?"?(\w+)"?\s*(?:=|<>|!=|IS\s+(?:NOT\s+)?DISTINCT\s+FROM)\s*'((?:[^']|'')*)'/gi;
  for (const m of sql.matchAll(cmp)) out.push({ column: m[1]!, value: unq(m[2]!) });
  // `(?!NOT\b)`: in `status NOT IN (…)` the column is `status`, never `NOT`.
  const inList = /(?:\b\w+\.)?"?\b(?!NOT\b)(\w+)"?\s+(?:NOT\s+)?IN\s*\(([^)]*)\)/gi;
  for (const m of sql.matchAll(inList)) {
    for (const lit of m[2]!.matchAll(/'((?:[^']|'')*)'/g)) out.push({ column: m[1]!, value: unq(lit[1]!) });
  }
  return out;
}

interface OperationFilters {
  /** `<datasource name>.<operation name>` — the ref a flow step names. */
  ref: string;
  /** Base table of the operation — hints key on `<table>.<column>` when known. */
  table: string | null;
  filters: Array<{ column: string; param?: string }>;
}

/**
 * Literals stored flows bind to a DB operation's parameters, mapped to the
 * column that parameter filters. Both binding forms: typed `inputs` literals
 * and a legacy `paramsExpr` JSON object/array of plain strings.
 */
export function authoredLiteralsFromFlows(
  models: unknown[],
  operations: OperationFilters[],
): Array<{ table: string | null; column: string; value: string }> {
  const byRef = new Map(operations.map((o) => [o.ref, o]));
  const out: Array<{ table: string | null; column: string; value: string }> = [];
  for (const model of models) {
    const steps = (model as { steps?: unknown[] } | null)?.steps;
    if (!Array.isArray(steps)) continue;
    for (const raw of steps) {
      const step = raw as { ref?: unknown; inputs?: unknown; paramsExpr?: unknown };
      const op = typeof step.ref === "string" ? byRef.get(step.ref) : undefined;
      if (!op) continue;
      const literals = new Map<string, string[]>();
      const add = (param: string, v: unknown) => {
        if (typeof v !== "string" || !v || v.includes("{{")) return;
        literals.set(param, [...(literals.get(param) ?? []), v]);
      };
      if (Array.isArray(step.inputs)) {
        for (const b of step.inputs as Array<{ name?: unknown; source?: { from?: unknown; value?: unknown } | null }>) {
          if (typeof b.name === "string" && b.source?.from === "literal") add(b.name, b.source.value);
        }
      }
      if (typeof step.paramsExpr === "string" && step.paramsExpr.trim() && !step.paramsExpr.includes("{{")) {
        try {
          const parsed: unknown = JSON.parse(step.paramsExpr);
          for (const call of Array.isArray(parsed) ? parsed : [parsed]) {
            if (call && typeof call === "object") for (const [k, v] of Object.entries(call)) add(k, v);
          }
        } catch {
          // Not JSON: nothing authored can be read from it, and that is fine.
        }
      }
      for (const f of op.filters) {
        for (const v of (f.param && literals.get(f.param)) || []) out.push({ table: op.table, column: f.column, value: v });
      }
    }
  }
  return out;
}

/** Merge the two sources into keyed hints — categories first, authored appended, deduped, capped. */
export function mergeHints(
  categories: Record<string, string[]>,
  authored: Array<{ table: string | null; column: string; value: string }>,
  notes: string[] = [],
): ValueHints {
  const byColumn: Record<string, string[]> = {};
  const provenance: ValueHints["provenance"] = {};
  for (const [key, values] of Object.entries(categories)) {
    byColumn[key] = [...values];
    provenance[key] = { categories: values.length };
  }
  const extra = new Map<string, Set<string>>();
  for (const a of authored) {
    // An empty literal is `col <> ''` — a guard against blanks, never a category.
    if (!a.value.trim() || a.value.length > MAX_VALUE_LENGTH || IDENTIFYING_VALUE.test(a.value)) continue;
    const key = `${a.table ?? "*"}.${a.column}`;
    if (!extra.has(key)) extra.set(key, new Set());
    extra.get(key)!.add(a.value);
  }
  for (const [key, set] of [...extra.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const have = new Set(byColumn[key] ?? []);
    const added = [...set].filter((v) => !have.has(v)).sort();
    if (!added.length) continue;
    byColumn[key] = [...(byColumn[key] ?? []), ...added].slice(0, MAX_CATEGORIES);
    provenance[key] = { ...(provenance[key] ?? {}), authored: added.length };
  }
  return { byColumn, provenance, notes };
}

/**
 * The fallback span: the union of every range read from this datasource (keeps
 * related dates coherent), or, when none could be read, the 90 days to `today`.
 */
export function withFallbackRange(hints: ValueHints, today: Date): ValueHints {
  const ranges = Object.values(hints.dateRanges ?? {});
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const fallbackRange = ranges.length
    ? { min: ranges.map((r) => r.min).sort()[0]!, max: ranges.map((r) => r.max).sort().at(-1)! }
    : { min: day(new Date(today.getTime() - 90 * 86_400_000)), max: day(today) };
  return { ...hints, fallbackRange };
}

/** The span to spread one date column across — its own, else the fallback. */
export function dateRangeFor(hints: ValueHints | undefined, table: SandboxTable, col: SandboxColumn): DateRange | undefined {
  if (!hints || (col.kind !== "date" && col.kind !== "timestamp")) return undefined;
  return hints.dateRanges?.[`${table.name}.${col.name}`] ?? hints.fallbackRange;
}

/** The number span to draw one column from, if the real column was summarised. */
export function numberRangeFor(hints: ValueHints | undefined, table: SandboxTable, col: SandboxColumn): NumberRange | undefined {
  if (!hints || (col.kind !== "int" && col.kind !== "decimal")) return undefined;
  return hints.numberRanges?.[`${table.name}.${col.name}`];
}

/** A number column that may be summarised: not a key, not a reference, not named for a person or an identifier. */
export function isNumberRangeCandidate(col: SandboxColumn): boolean {
  if ((col.kind !== "int" && col.kind !== "decimal") || col.isPrimaryKey || col.references) return false;
  return !nameWords(col.name).some((w) => IDENTIFYING_WORDS.has(w));
}

/** Round to two significant figures, DOWN (for a lower bound) or UP (for an upper one). */
function roundSig(x: number, up: boolean): number {
  if (x === 0 || !Number.isFinite(x)) return 0;
  const scale = 10 ** (Math.floor(Math.log10(Math.abs(x))) - 1);
  const r = (up ? Math.ceil(x / scale) : Math.floor(x / scale)) * scale;
  return Number(r.toPrecision(12));
}

/** The 5th–95th percentile of a sample, rounded outward; null under MIN_RANGE_VALUES values. */
export function numberRangeOf(values: unknown[]): NumberRange | null {
  const ns = values.map((v) => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN)).filter(Number.isFinite).sort((a, b) => a - b);
  if (ns.length < MIN_RANGE_VALUES) return null;
  const lo = ns[Math.floor(0.05 * (ns.length - 1))]!;
  const hi = ns[Math.ceil(0.95 * (ns.length - 1))]!;
  return { min: roundSig(lo, false), max: roundSig(hi, true), integer: ns.every(Number.isInteger) };
}

/** The earliest and latest DAY in a sample of dates (Date objects or ISO text); null when none reads as a date. */
export function dateRangeOf(values: unknown[]): DateRange | null {
  const days = values
    .map((v) => (v instanceof Date ? (Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10)) : typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null))
    .filter((d): d is string => d !== null)
    .sort();
  return days.length ? { min: days[0]!, max: days[days.length - 1]! } : null;
}

/** Reads up to SAMPLE_ROWS non-null values of one column. Engine-specific; everything after it is not. */
export type ColumnSampler = (table: SandboxTable, col: SandboxColumn) => Promise<unknown[]>;

/**
 * The typical spans of every date and number column a mock may take one for, from ONE sampling path for every engine —
 * only the summaries leave this function. Never throws: a column that cannot be read becomes a note.
 */
export async function readRangeHints(
  shape: SandboxShape,
  sample: ColumnSampler,
): Promise<{ dateRanges: Record<string, DateRange>; numberRanges: Record<string, NumberRange>; notes: string[] }> {
  const dateRanges: Record<string, DateRange> = {};
  const numberRanges: Record<string, NumberRange> = {};
  const notes: string[] = [];
  for (const table of shape.tables) {
    for (const col of table.columns) {
      const isDate = isDateRangeCandidate(col);
      const isNumber = !isDate && isNumberRangeCandidate(col);
      if (!isDate && !isNumber) continue;
      try {
        const values = await sample(table, col);
        if (isDate) {
          const r = dateRangeOf(values);
          if (r) dateRanges[`${table.name}.${col.name}`] = r;
        } else {
          const r = numberRangeOf(values);
          if (r) numberRanges[`${table.name}.${col.name}`] = r;
          else if (values.length) notes.push(`number range not taken for ${table.key}.${col.name}: ${values.length} value(s), fewer than ${MIN_RANGE_VALUES}`);
        }
      } catch (e) {
        notes.push(`range not read for ${table.key}.${col.name}: ${(e as Error).message}`);
      }
    }
  }
  return { dateRanges, numberRanges, notes };
}

/** The hint list for one column of one table, if any — table-specific first, then any-table. */
export function hintFor(hints: ValueHints | undefined, table: SandboxTable, col: SandboxColumn): string[] | undefined {
  if (!hints) return undefined;
  const values = hints.byColumn[`${table.name}.${col.name}`] ?? hints.byColumn[`*.${col.name}`];
  if (!values?.length) return undefined;
  const fit = values.filter((v) => col.maxLength === null || v.length <= col.maxLength);
  return fit.length ? fit : undefined;
}

// ── IO: the category read ────────────────────────────────────────────────────

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Dial the datasource with its stored credential. A HOST process (every
 * provisioner) cannot resolve the container-facing `host.docker.internal`, so
 * on ENOTFOUND for that host alone it retries on 127.0.0.1 — the same
 * credential, only the host differs (the rule `verifyVia` states, D-44).
 */
async function connect(dsn: string): Promise<pg.Client> {
  const attempt = async (cs: string) => {
    const c = new pg.Client({ connectionString: cs, connectionTimeoutMillis: 5000, statement_timeout: 3000 });
    await c.connect();
    return c;
  };
  try {
    return await attempt(dsn);
  } catch (e) {
    const url = new URL(dsn);
    if ((e as { code?: string }).code !== "ENOTFOUND" || url.hostname !== "host.docker.internal") throw e;
    url.hostname = "127.0.0.1";
    return attempt(url.toString());
  }
}

const fromOf = (table: SandboxTable) => (table.schema ? `${quoteIdent(table.schema)}.${quoteIdent(table.name)}` : quoteIdent(table.name));
const sampleSql = (table: SandboxTable, col: SandboxColumn) =>
  `SELECT ${quoteIdent(col.name)} AS v FROM ${fromOf(table)} WHERE ${quoteIdent(col.name)} IS NOT NULL LIMIT ${SAMPLE_ROWS}`;

/** A sampler over a Postgres datasource, in a read-only session. `close` must be called. */
export type Sampler = {
  sample: ColumnSampler;
  /** One read-only statement's rows — for the link profile (`mock-links.ts`), which needs counts and distinct values. */
  query: (sql: string) => Promise<Array<Record<string, unknown>>>;
  close: () => Promise<void>;
};

export async function postgresSampler(dsn: string): Promise<Sampler> {
  const client = await connect(dsn);
  await client.query("SET default_transaction_read_only = on");
  return {
    sample: async (table, col) => (await client.query<{ v: unknown }>(sampleSql(table, col))).rows.map((r) => r.v),
    query: async (sql) => (await client.query(sql)).rows as Array<Record<string, unknown>>,
    close: () => client.end().catch(() => {}),
  };
}

/** A sampler over a SQLite datasource — the uploaded file, opened read-only. `close` must be called. */
export async function sqliteSampler(dsn: string): Promise<Sampler> {
  const db = await sqliteFileService.open(dsn);
  const path = await sqliteFileService.pathFor(dsn);
  return {
    sample: async (table, col) => (db.prepare(sampleSql(table, col)).all() as Array<{ v: unknown }>).map((r) => r.v),
    // In the worker: a profile scans whole columns, and a large file must not hold the server's thread meanwhile.
    query: async (sql) => {
      const r = await readSqliteInWorker({ path, sql, bindings: [[]], timeoutMs: config.sqliteReadTimeoutMs });
      const first = r.results[0];
      if (!first?.ok) throw new Error(first && !first.ok ? first.error : "no result");
      return first.rows;
    },
    close: async () => db.close(),
  };
}
