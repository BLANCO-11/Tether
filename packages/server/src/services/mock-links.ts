/**
 * Links between tables that the schema does not DECLARE, measured from the real data (2026-10-12).
 *
 * The failure: an uploaded SQLite file declares no foreign keys, so the test data gave `muster."User ID"` values like
 * `mock_User ID_24094` and `headcount."Employee ID"` values like `mock_Employee ID_17114`. A workflow joining them
 * found nothing on every test run; Forge "fixed" it four times and finally declared the report allowed to be empty.
 *
 * The rule, catalogue-agnostic (no table or column is named here): two columns in different tables are LINKED when
 * the real data shows they hold the same values — at least MIN_SHARED distinct values in common, covering at least
 * half of the smaller column. The test data then gives both columns one shared set of made-up values, so a join on
 * them finds rows. Only the FACT of the link leaves this module; no real value is kept or written anywhere.
 *
 * Bounds, stated: text and whole-number columns only (a decimal or a date overlapping another is coincidence, not a
 * link); a whole-number pair needs one side to be nearly unique (an ID), because two ranges of counts overlap by
 * accident; at most SAMPLE distinct values per column are compared.
 */
import type { SandboxColumn, SandboxShape, SandboxTable } from "./sandbox-ddl.service.js";

export const MIN_SHARED = 20;
const SAMPLE = 5000;
const KEY_LIKE = 0.9;

export type ColumnProfile = {
  /** `"<table>.<column>"`, the form `references` uses. */
  ref: string;
  integer: boolean;
  /** Non-null rows. */
  rows: number;
  distinct: number;
  /** Up to SAMPLE distinct values, as text. */
  values: Set<string>;
};

export type InferredLink = { child: string; parent: string; shared: number };

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
const fromOf = (t: SandboxTable) => (t.schema ? `${quote(t.schema)}.${quote(t.name)}` : quote(t.name));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** Whether a column may be profiled at all: text or whole numbers, not a key already declared either way. */
export function linkCandidate(col: SandboxColumn): "text" | "integer" | null {
  if (col.references) return null;
  const t = col.sqlType.toLowerCase();
  if (/bool|date|time|numeric|decimal|real|double|float|json|bytea|blob|uuid\[\]|\[\]/.test(t)) return null;
  if (/int/.test(t)) return "integer";
  if (/char|text|uuid|clob|string|^$/.test(t) || t === "") return "text";
  return null;
}

/** The two statements that profile one column: its counts, and a sample of its distinct values as text. */
export function profileSql(table: SandboxTable, col: SandboxColumn): { counts: string; values: string } {
  const c = quote(col.name);
  return {
    counts: `SELECT COUNT(*) AS n, COUNT(DISTINCT ${c}) AS d FROM ${fromOf(table)} WHERE ${c} IS NOT NULL`,
    values: `SELECT DISTINCT CAST(${c} AS TEXT) AS v FROM ${fromOf(table)} WHERE ${c} IS NOT NULL LIMIT ${SAMPLE}`,
  };
}

/** How often each value of a category column occurs — counts only, never a row. */
export function countsSql(table: SandboxTable, col: SandboxColumn): string {
  const c = quote(col.name);
  return `SELECT CAST(${c} AS TEXT) AS v, COUNT(*) AS n FROM ${fromOf(table)} WHERE ${c} IS NOT NULL GROUP BY CAST(${c} AS TEXT) ORDER BY n DESC LIMIT 200`;
}

/**
 * A category's values laid out over `slots` test rows in the real data's proportions (largest remainder), most
 * common first; values that earn no slot follow, so the list still names them. If 90% of real employees are in one
 * country, 9 of 10 test rows are — so an ordinary condition on it matches most test rows instead of one or none.
 */
export function weightByFrequency(values: readonly string[], counts: ReadonlyMap<string, number>, slots: number): string[] {
  const known = values.filter((v) => (counts.get(v) ?? 0) > 0);
  const total = known.reduce((n, v) => n + counts.get(v)!, 0);
  if (!known.length || total === 0) return [...values];
  const byCount = [...known].sort((a, b) => counts.get(b)! - counts.get(a)! || a.localeCompare(b));
  const exact = byCount.map((v) => (counts.get(v)! / total) * slots);
  const given = exact.map(Math.floor);
  let left = slots - given.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    given[i]!++;
    left--;
  }
  const laid = byCount.flatMap((v, i) => Array<string>(given[i]!).fill(v));
  const rest = values.filter((v) => !laid.includes(v));
  return [...laid, ...rest];
}

/** Pairs of columns, in different tables, that hold the same values — each child linked to its best parent. */
export function inferLinks(profiles: readonly ColumnProfile[]): InferredLink[] {
  const usable = profiles.filter((p) => {
    if (p.distinct < MIN_SHARED) return false;
    // A column of dates stored as text (SQLite has no date type) overlaps any other date column by coincidence.
    let dates = 0;
    for (const v of p.values) if (ISO_DATE.test(v)) dates++;
    return dates < p.values.size * 0.9;
  });
  const tableOf = (ref: string) => ref.slice(0, ref.lastIndexOf("."));
  const keyLike = (p: ColumnProfile) => p.rows > 0 && p.distinct >= p.rows * KEY_LIKE;
  const best = new Map<string, InferredLink>();
  for (const a of usable) {
    for (const b of usable) {
      if (a === b || tableOf(a.ref) === tableOf(b.ref) || a.integer !== b.integer) continue;
      // `b` is the parent: the one more like a key (unique per row), ties broken by more distinct values.
      const aKey = keyLike(a);
      const bKey = keyLike(b);
      const parentIsB = bKey !== aKey ? bKey : b.distinct > a.distinct || (b.distinct === a.distinct && b.ref < a.ref);
      if (!parentIsB) continue;
      if (a.integer && !bKey) continue;
      let shared = 0;
      const [small, large] = a.values.size <= b.values.size ? [a.values, b.values] : [b.values, a.values];
      for (const v of small) if (large.has(v)) shared++;
      if (shared < MIN_SHARED || shared < small.size * 0.5) continue;
      const prior = best.get(a.ref);
      if (!prior || shared > prior.shared) best.set(a.ref, { child: a.ref, parent: b.ref, shared });
    }
  }
  // A parent never becomes someone else's child here: chains are resolved to one shared set by the generator.
  return [...best.values()].sort((x, y) => x.child.localeCompare(y.child));
}

/** Run the profile statements through `query` (any engine) for every candidate column of the shape. */
export async function profileShape(
  shape: SandboxShape,
  query: (sql: string) => Promise<Array<Record<string, unknown>>>,
): Promise<ColumnProfile[]> {
  const out: ColumnProfile[] = [];
  for (const table of shape.tables) {
    for (const col of table.columns) {
      const kind = linkCandidate(col);
      if (!kind) continue;
      const sql = profileSql(table, col);
      const [counts] = await query(sql.counts);
      const distinct = Number(counts?.d ?? 0);
      if (distinct < MIN_SHARED) continue;
      const values = new Set((await query(sql.values)).map((r) => String(r.v)));
      out.push({ ref: `${table.name}.${col.name}`, integer: kind === "integer", rows: Number(counts?.n ?? 0), distinct, values });
    }
  }
  return out;
}

/**
 * Give each linked child column its parent's generated values, cycling, so a join on them finds rows. Applied after
 * every table is generated, so the order tables are built in does not matter. Mutates and returns `rows`.
 */
export function applyLinks(
  shape: SandboxShape,
  rows: Record<string, Array<Record<string, unknown>>>,
  links: readonly InferredLink[],
): Record<string, Array<Record<string, unknown>>> {
  const keyOfTable = new Map(shape.tables.map((t) => [t.name, t.key]));
  const split = (ref: string) => {
    const i = ref.lastIndexOf(".");
    return { table: ref.slice(0, i), column: ref.slice(i + 1) };
  };
  // A chain (manager ID → person ID → employee ID) shares ONE set: every child takes its chain's root's values, so
  // the order links are applied in cannot leave one pointing at values another link has since replaced.
  const parentOf = new Map(links.map((l) => [l.child, l.parent]));
  const rootOf = (ref: string): string => {
    const seen = new Set<string>([ref]);
    let at = ref;
    while (parentOf.has(at) && !seen.has(parentOf.get(at)!)) {
      at = parentOf.get(at)!;
      seen.add(at);
    }
    return at;
  };
  for (const link of links) {
    const root = rootOf(link.child);
    if (root === link.child) continue;
    const p = split(root);
    const c = split(link.child);
    const parentRows = rows[keyOfTable.get(p.table) ?? ""];
    const childRows = rows[keyOfTable.get(c.table) ?? ""];
    if (!parentRows || !childRows) continue;
    const pool = parentRows.map((r) => r[p.column]).filter((v) => v !== null && v !== undefined);
    if (!pool.length) continue;
    // A child that is its own table's primary key keeps its own values: cycling a short pool would repeat a key.
    const childCol = shape.tables.find((t) => t.name === c.table)?.columns.find((x) => x.name === c.column);
    if (!childCol || childCol.isPrimaryKey) continue;
    childRows.forEach((r, i) => {
      if (c.column in r) r[c.column] = pool[i % pool.length];
    });
  }
  return rows;
}
