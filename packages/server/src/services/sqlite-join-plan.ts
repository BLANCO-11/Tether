/**
 * A read whose join cannot use an index, found from SQLite's own plan before it runs (2026-10-13).
 *
 * The failure this closes (chat 8d7e37dc): a monthly report joined `muster` to `headcount` with
 * `ON CAST(m.employee_id AS TEXT) = CAST(h.employee_id AS TEXT)`. Both columns were already TEXT; the CAST only stopped
 * SQLite from using `ix_headcount_employee`, so every muster row scanned the whole headcount table — 107,755 × 4,130
 * comparisons, about three minutes. The automatic test passed (its test data is a handful of rows), and the first run
 * on real data was stopped at the two-minute read limit. The plain join returns the same rows in 0.2 s.
 *
 * So, when a read is accepted, its plan is asked of the real file — `EXPLAIN QUERY PLAN` reads no rows — and a join
 * whose inner side is a full SCAN of a large table, under an outer side that is large too, is refused with the size of
 * the work and the usual cause. Catalogue-agnostic: no table or column is named here.
 *
 * Bound, stated: SQLite only (Postgres plans another way), and only nested full scans — a slow sort or a huge result
 * is the read limit's job. Row counts are the tables' real sizes, so a filter that would cut the outer side is not
 * credited; the threshold leaves room for that.
 *
 * Pure: the plan rows and table sizes in, a problem out.
 */

/** A row of `EXPLAIN QUERY PLAN`: `detail` like "SCAN m", "SCAN TABLE muster AS m", "SEARCH h USING INDEX ix (…)". */
export type PlanRow = { id: number; parent: number; detail: string };

/** Above this many row comparisons a nested full scan is refused (≈ a few seconds of SQLite work per 10 million). */
export const MAX_NESTED_SCAN_COMPARISONS = 50_000_000;

const NOT_ALIAS = new Set(["on", "where", "left", "right", "inner", "outer", "cross", "full", "join", "using", "group", "order", "limit", "natural", "union", "having", "window"]);

/** alias → table, from the FROM/JOIN clauses (`main.muster AS m`, `"headcount" h`, `muster`). */
export function tableAliases(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\b(?:FROM|JOIN)\s+((?:"?\w+"?\.)?"?(\w+)"?)(?:\s+(?:AS\s+)?"?(\w+)"?)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const table = m[2]!;
    const alias = m[3] && !NOT_ALIAS.has(m[3].toLowerCase()) ? m[3] : table;
    out.set(alias.toLowerCase(), table);
    out.set(table.toLowerCase(), table);
  }
  return out;
}

/** The table a full SCAN reads, or null for an index search, a subquery or a constant row. */
function scannedTable(detail: string, aliases: Map<string, string>): string | null {
  const m = /^SCAN\s+(?:TABLE\s+)?"?(\w+)"?(?:\s+AS\s+"?(\w+)"?)?/i.exec(detail.trim());
  if (!m || /^CONSTANT$/i.test(m[1]!)) return null;
  const key = (m[2] ?? m[1]!).toLowerCase();
  return aliases.get(key) ?? aliases.get(m[1]!.toLowerCase()) ?? null;
}

/**
 * Why this plan will not finish, in words — or null. Loops at one level of the plan run outer to inner, so two full
 * scans at the same level are a nested loop: the inner table is read once per outer row.
 */
export function nestedScanProblem(plan: PlanRow[], sql: string, rowsOf: (table: string) => number | null): string | null {
  const aliases = tableAliases(sql);
  const byParent = new Map<number, string[]>();
  for (const r of plan) {
    const t = scannedTable(r.detail, aliases);
    if (!t) continue;
    byParent.set(r.parent, [...(byParent.get(r.parent) ?? []), t]);
  }
  for (const scans of byParent.values()) {
    if (scans.length < 2) continue;
    const sizes = scans.map((t) => rowsOf(t));
    if (sizes.some((n) => n == null)) continue;
    const work = (sizes as number[]).reduce((a, b) => a * b, 1);
    if (work <= MAX_NESTED_SCAN_COMPARISONS) continue;
    const parts = scans.map((t, i) => `${t} (${(sizes[i] as number).toLocaleString("en-US")} rows)`);
    return (
      `this join cannot use an index: SQLite would read every row of ${parts.slice(1).join(" and ")} once for every row ` +
      `of ${parts[0]} — about ${Math.round(work / 1e6).toLocaleString("en-US")} million comparisons, which will not ` +
      `finish within the read time limit. Join on the columns as they are: a CAST, a function or an expression around ` +
      `a join column stops SQLite using the index (compare the columns' own types first — they may already match).`
    );
  }
  return null;
}
