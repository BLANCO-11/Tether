/**
 * What the TEST data holds, for Pi — so a test default selects rows that exist (pi-runtime P2-I5, 2026-10-10).
 *
 * Pi saw column names and types only. HR's test `attendance_day` is dated 2024-01-15 … 2024-03-09; Pi set the test
 * defaults to month 6 of 2026, every automatic test read nothing, and the run said nothing about why. Now the
 * catalogue carries, per table of a datasource's READY mock fixture: the row count and, per column, how many values
 * are empty, the range of a date or number, and the values of a column with few of them.
 *
 * ⚠ Built from the MOCK fixture only — synthetic rows — never from production. A datasource with no ready mock gets
 * no profile, and says so: describing production to the model is exactly what the sandbox exists to avoid (D-54).
 *
 * Pure: rows in, profile out.
 */

export type ColumnProfile = {
  /** Values that are null or blank text. */
  empty: number;
  /** For a column whose values are all dates (YYYY-MM-DD…) or all numbers: the smallest and largest. */
  min?: string | number;
  max?: string | number;
  /** Every distinct value, when there are few — or a sample, when there are many (`distinct` says how many). */
  values?: Array<string | number | boolean>;
  distinct?: number;
};

export type TableProfile = { rows: number; columns: Record<string, ColumnProfile> };

const DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/;
const FEW = 10;
const SAMPLE = 3;

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !v.trim());

export function profileTable(rows: Array<Record<string, unknown>>): TableProfile {
  const names: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!names.includes(k)) names.push(k);
  const columns: Record<string, ColumnProfile> = {};
  for (const name of names) {
    const all = rows.map((r) => r[name]);
    const present = all.filter((v) => !isEmpty(v));
    const col: ColumnProfile = { empty: all.length - present.length };
    if (present.length && present.every((v) => typeof v === "number")) {
      const ns = present as number[];
      col.min = Math.min(...ns);
      col.max = Math.max(...ns);
    } else if (present.length && present.every((v) => typeof v === "string" && DATE.test(v))) {
      const ds = [...(present as string[])].sort();
      col.min = ds[0];
      col.max = ds[ds.length - 1];
    } else if (present.length) {
      const distinct = [...new Set(present.map((v) => (typeof v === "object" ? JSON.stringify(v) : v)))] as Array<string | number | boolean>;
      col.distinct = distinct.length;
      col.values = distinct.length <= FEW ? distinct : distinct.slice(0, SAMPLE);
    }
    columns[name] = col;
  }
  return { rows: rows.length, columns };
}

/** `{ "<schema>.<table>": rows }` → a profile per table, keyed the same way. */
export function profileFixture(rowsJson: Record<string, Array<Record<string, unknown>>>): Record<string, TableProfile> {
  return Object.fromEntries(Object.entries(rowsJson).map(([k, rows]) => [k, profileTable(Array.isArray(rows) ? rows : [])]));
}
