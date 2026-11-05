/**
 * Postgres-dialect SQL → SQLite, for the statements Foundry itself emits.
 *
 * Named queries and DB operations are stored with Postgres's positional
 * placeholders (`$1..$n`, a repeated name reusing its number) and
 * `compileOperation` emits a handful of Postgres spellings. This rewrites the
 * ones with an EXACT SQLite equivalent and refuses the rest by name.
 *
 * ⚠ **Refuse, never approximate.** `(a::date - b::date)` with the cast merely
 * stripped runs in SQLite and subtracts two strings' leading numbers — `0` for
 * any two dates in the same year — and the step goes green with a wrong
 * answer. A refusal naming the construct is the only safe output for a
 * spelling this does not translate faithfully.
 *
 * What is translated:
 *   - `$n`                         → `?`, with the bind list expanded per occurrence
 *                                    (node:sqlite does not bind `?NNN` positionally)
 *   - `ILIKE`                      → `LIKE` (ASCII case-insensitive in SQLite, which is
 *                                    what ILIKE means for the data this reads)
 *   - `x = ANY($n)`                → `x IN (SELECT value FROM json_each(?))` — the array
 *                                    param already arrives JSON-encoded (`toSqlValue`)
 *   - the month-match `date_trunc('month', x::date) = to_date($n, 'YYYY-MM')`
 *                                  → `strftime('%Y-%m', x) = $n`
 *   - the month-match by a DATE    `date_trunc('month', x::date) = to_date(left($n::text, 7), 'YYYY-MM')`
 *                                  → `strftime('%Y-%m', x) = substr($n, 1, 7)`; and on a text column
 *                                  `left(x::text, 7) = left($n::text, 7)` → `substr(x, 1, 7) = substr($n, 1, 7)`
 */

export class SqliteDialectError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "SqliteDialectError";
  }
}

/** Constructs with no faithful rewrite here. Matched OUTSIDE string literals. */
const UNSUPPORTED: Array<[RegExp, string]> = [
  [/::/, "a Postgres cast (::type)"],
  [/\bdate_trunc\s*\(/i, "date_trunc()"],
  [/\bto_date\s*\(/i, "to_date()"],
  [/\bextract\s*\(/i, "EXTRACT()"],
  [/\bgenerate_series\s*\(/i, "generate_series()"],
  [/\bat\s+time\s+zone\b/i, "AT TIME ZONE"],
  [/\binterval\s+'/i, "an interval literal"],
  [/\bany\s*\(/i, "ANY()"],
];

/** Replace every single-quoted literal with a same-length blank, so scans skip them. */
function maskLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, (m) => "'" + " ".repeat(Math.max(0, m.length - 2)) + "'");
}

export interface SqliteStatement {
  sql: string;
  /** For each `?` in `sql`, the 0-based index into the original positional values. */
  bindOrder: number[];
}

export function toSqlite(pgSql: string): SqliteStatement {
  // The month match by a DATE parameter (2026-10-01, `monthCond`): the parameter's first seven characters are its month, whether it
  // is a date or a `YYYY-MM`; a date column is read by `strftime`, any other column by its own first seven characters.
  let sql = pgSql.replace(
    /date_trunc\('month',\s*(.+?)::date\)\s*=\s*to_date\(left\(\$(\d+)::text,\s*7\),\s*'YYYY-MM'\)/g,
    (_m, qual: string, n: string) => `strftime('%Y-%m', ${qual}) = substr($${n}, 1, 7)`,
  );
  sql = sql.replace(
    /left\((.+?)::text,\s*7\)\s*=\s*left\(\$(\d+)::text,\s*7\)/g,
    (_m, qual: string, n: string) => `substr(${qual}, 1, 7) = substr($${n}, 1, 7)`,
  );
  // The month match as compiled before (a `YYYY-MM` parameter) — still the stored SQL of operations saved then.
  sql = sql.replace(
    /date_trunc\('month',\s*(.+?)::date\)\s*=\s*to_date\(\$(\d+),\s*'YYYY-MM'\)/g,
    (_m, qual: string, n: string) => `strftime('%Y-%m', ${qual}) = $${n}`,
  );
  sql = sql.replace(/=\s*ANY\s*\(\s*\$(\d+)\s*\)/gi, (_m, n: string) => `IN (SELECT value FROM json_each($${n}))`);
  sql = sql.replace(/\bILIKE\b/gi, "LIKE");

  const masked = maskLiterals(sql);
  for (const [re, label] of UNSUPPORTED) {
    if (re.test(masked)) {
      throw new SqliteDialectError(
        `this statement uses ${label}, which has no exact SQLite equivalent here — ` +
          `rewrite it for SQLite (a named query) or drop that part of the operation`,
      );
    }
  }

  // `$n` → `?`, only where the masked copy has it too (i.e. not inside a literal).
  const bindOrder: number[] = [];
  let out = "";
  let i = 0;
  const re = /\$(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    out += sql.slice(i, m.index) + "?";
    bindOrder.push(Number(m[1]) - 1);
    i = m.index + m[0].length;
  }
  out += sql.slice(i);
  return { sql: out, bindOrder };
}

/** node:sqlite binds only null / number / bigint / string / Buffer. */
export function toSqliteValue(v: unknown): null | number | bigint | string | Uint8Array {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  // ⚠ node:sqlite binds every JS number as REAL, so a whole number arrives as 2026.0: `CAST($1 AS TEXT)` is then
  // '2026.0' and a comparison with a TEXT column ('2026') matches nothing — a read that returns rows with every
  // joined value NULL and settles green (pi-runtime, prod run fr-47864ba9). A whole number is an INTEGER, as on Postgres.
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

export function bindValues(stmt: SqliteStatement, values: unknown[]) {
  return stmt.bindOrder.map((idx) => toSqliteValue(values[idx]));
}
