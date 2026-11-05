/**
 * A number column arrives as a NUMBER (phase 7, R05).
 *
 * node-postgres (and PGlite, and mysql2) return `numeric`/`decimal` and 64-bit
 * integers as STRINGS by default, to protect precision. The type checker types
 * those columns as Number / Int (`tyOfColumn`), so everything downstream was told
 * a thing the wire did not deliver: a transform that averaged `attendance_rate`
 * concatenated the strings and died dividing a string by a number, and the same
 * flow's `.attendance_rate < .min_attendance_rate` compared TEXT — silently
 * wrong, and jq orders every string above every number, so a guard on it is
 * quietly always true (`render.ts`).
 *
 * Nothing is lost by converting: every consumer of a step's rows is jq, whose
 * numbers are doubles. One exception is kept: an INTEGER beyond 2^53 stays a
 * string, because an id that silently changes value is worse than an id that
 * is text. A value that does not parse as a finite number is left as it came.
 *
 * ONE normaliser for every executor — Postgres, MySQL and the mock engine —
 * keyed by the type each driver reports for the column, never by the value's
 * look (a text column holding "007" must stay "007").
 */

/** Postgres type OIDs pg returns as text: int8 (20), numeric (1700). int2/int4/float4/float8 already arrive as numbers. */
const PG_TEXT_NUMBER_OIDS = new Set([20, 1700]);
/** mysql2 column types it returns as text: DECIMAL (0), LONGLONG (8), NEWDECIMAL (246). */
const MYSQL_TEXT_NUMBER_TYPES = new Set([0, 8, 246]);

export type ColumnField = { name: string; dataTypeID?: number; columnType?: number; type?: number };

/** The columns a driver reports as number-typed but hands back as text. */
export function numberColumns(fields: readonly ColumnField[] | undefined, driver: "pg" | "mysql"): Set<string> {
  const out = new Set<string>();
  for (const f of fields ?? []) {
    if (!f || typeof f.name !== "string") continue;
    const code = driver === "pg" ? f.dataTypeID : (f.columnType ?? f.type);
    if (typeof code === "number" && (driver === "pg" ? PG_TEXT_NUMBER_OIDS : MYSQL_TEXT_NUMBER_TYPES).has(code)) out.add(f.name);
  }
  return out;
}

function asNumber(v: unknown): unknown {
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (!/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return v;
  const n = Number(s);
  if (!Number.isFinite(n)) return v;
  if (/^-?\d+$/.test(s) && !Number.isSafeInteger(n)) return v;
  return n;
}

/** The rows with every value in `cols` turned into a number where it is one. */
export function coerceNumberColumns<R extends Record<string, unknown>>(rows: R[], cols: ReadonlySet<string>): R[] {
  if (cols.size === 0) return rows;
  return rows.map((r) => {
    const out: Record<string, unknown> = { ...r };
    for (const c of cols) if (c in out) out[c] = asNumber(out[c]);
    return out as R;
  });
}

/**
 * A parameter DECLARED as a number is sent as one (phase 7, L1).
 *
 * The mirror of the row half. A flow input typed FLOAT (derived from a consumer
 * declaring `number`, D-272) renders as `80.0`, and the params template carries it
 * as a JSON STRING — so a `LIMIT $3` got `"80.0"` and Postgres refused it
 * ("invalid input syntax for type integer"). The declaration said number; the
 * value on the wire was text.
 *
 * Only a string that IS a number is converted, and only for a param whose
 * declared `type` is a number type. An `integer` param must be integral: `80.0`
 * becomes 80, `80.5` is left as it came, so the database refuses it by name
 * rather than this rounding somebody's value. Anything undeclared is untouched.
 */
const INTEGER_TYPES = new Set(["integer", "int", "bigint", "smallint"]);
const NUMBER_TYPES = new Set(["number", "float", "double", "numeric", "decimal", "real"]);

export function coerceDeclaredNumbers(
  params: Record<string, unknown>,
  schema: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return params;
  let out: Record<string, unknown> | null = null;
  for (const [name, decl] of Object.entries(schema)) {
    const type = String((decl as { type?: unknown } | null)?.type ?? "").toLowerCase();
    const isInt = INTEGER_TYPES.has(type);
    if (!isInt && !NUMBER_TYPES.has(type)) continue;
    const v = params[name];
    if (typeof v !== "string") continue;
    const n = asNumber(v);
    if (typeof n !== "number" || (isInt && !Number.isInteger(n))) continue;
    (out ??= { ...params })[name] = n;
  }
  return out ?? params;
}

/**
 * A parameter DECLARED as an array reaches SQL as a Postgres array (phase 7, R03).
 *
 * A DB operation's `in` filter compiles to `= ANY($n)` with an `array` param.
 * `toSqlValue` JSON-stringifies any structure — deliberately, one rule for both
 * drivers — so `["active","on_leave"]` arrived as the text `["active","on_leave"]`
 * and Postgres refused it ("malformed array literal"). The same when a binding
 * carried the list as JSON text. So an `in` filter has never worked from a flow.
 *
 * The declaration decides, never the value: a param declared `array` whose value
 * is a list — or JSON text of one — becomes a Postgres array literal, still a
 * plain STRING, so `toSqlValue`'s rule is kept. Elements are scalars; a string is
 * quoted with `\` and `"` escaped, a null is NULL. A nested structure is left as
 * it came, for the database to refuse by name.
 */
export function pgArrayLiteral(xs: readonly unknown[]): string | null {
  const parts: string[] = [];
  for (const x of xs) {
    if (x === null || x === undefined) parts.push("NULL");
    else if (typeof x === "number" || typeof x === "boolean") parts.push(String(x));
    else if (typeof x === "string") parts.push(`"${x.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
    else return null;
  }
  return `{${parts.join(",")}}`;
}

/** A SQL batch's params: numbers as numbers, declared arrays as Postgres arrays. */
export function coerceSqlParams(
  params: Record<string, unknown>,
  schema: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out = { ...coerceDeclaredNumbers(params, schema) };
  if (!schema || typeof schema !== "object") return out;
  for (const [name, decl] of Object.entries(schema)) {
    if (String((decl as { type?: unknown } | null)?.type ?? "").toLowerCase() !== "array") continue;
    let v = out[name];
    if (typeof v === "string" && v.trim().startsWith("[")) {
      try {
        v = JSON.parse(v);
      } catch {
        continue;
      }
    }
    if (!Array.isArray(v)) continue;
    const lit = pgArrayLiteral(v);
    if (lit !== null) out[name] = lit;
  }
  return out;
}
