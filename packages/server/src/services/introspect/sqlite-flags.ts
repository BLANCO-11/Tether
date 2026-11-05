/**
 * Which SQLite columns hold TRUE/FALSE, read from their DECLARATION (2026-10-01).
 *
 * SQLite has no boolean storage: a schema declares a flag as `BOOLEAN` (stored 1/0), or as an `INTEGER` with
 * `CHECK (col IN (0,1))`. Typed as an integer, a flag could not be tested ("is a working day" → `is_working_day is not
 * true/false — not built"). ⚠ Never from the VALUES and never from the name: a column holding only 0.5 and 1 (half and whole
 * days) has two values in [0,1] and is a quantity; `is_` names nothing. Only what the schema declares makes a flag.
 *
 * One definition, two readers: introspection types the column `boolean`, and execution turns its 1/0 into true/false — or a
 * column the catalogue calls a truth value would never equal `true` inside a flow.
 */

/** `CHECK (<col> IN (0,1))` (either order, any identifier quoting), in a column definition or as a table constraint. */
export function checksZeroOne(createSql: string, column: string): boolean {
  const name = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const id = `(?:"${name}"|\`${name}\`|\\[${name}\\]|${name})`;
  const re = new RegExp(`CHECK\\s*\\(\\s*${id}\\s+IN\\s*\\(\\s*([01])\\s*,\\s*([01])\\s*\\)\\s*\\)`, "gi");
  for (const m of createSql.matchAll(re)) if (m[1] !== m[2]) return true;
  return false;
}

type Db = { prepare(sql: string): { all(...a: unknown[]): unknown[] } };

/** A table as the flag rule reads it: its CREATE statement and each column's declared type. */
export type FlagSchemaTable = { name: string; sql: string | null; cols: Array<{ name: string; type: string | null }> };

/** The schema the flag rule needs — read wherever the database is open (the read worker sends it back as data). */
export function readFlagSchema(db: Db): FlagSchemaTable[] {
  const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string; sql: string | null }>;
  return tables.map((t) => ({ ...t, cols: db.prepare("SELECT name, type FROM pragma_table_info(?)").all(t.name) as Array<{ name: string; type: string | null }> }));
}

/** Every TABLE column declared a flag, as `table.column`: a declared BOOL/BOOLEAN, or an integer checked to 0/1. */
export function flagColumnsOf(schema: FlagSchemaTable[]): Set<string> {
  const out = new Set<string>();
  for (const t of schema) {
    for (const c of t.cols) if (/\bBOOL(EAN)?\b/i.test(c.type ?? "") || (t.sql && checksZeroOne(t.sql, c.name))) out.add(`${t.name}.${c.name}`);
  }
  return out;
}

export function sqliteFlagColumns(db: Db): Set<string> {
  return flagColumnsOf(readFlagSchema(db));
}

/** A result column's origin, as `columns()` reports it: a computed column has none, and is never a flag. */
type Origin = { name: string; table?: string | null; column?: string | null };
/** The result columns that ARE a declared flag, by the column they come from (through any view). */
export function flagResults(origins: Origin[], flags: Set<string>): string[] {
  return origins.filter((o) => o.table && o.column && flags.has(`${o.table}.${o.column}`)).map((o) => o.name);
}

/** 1/0 → true/false in the named fields; any other value (NULL, a stray 2) is left as it is, never guessed. */
export function asFlags<R extends Record<string, unknown>>(row: R, fields: string[]): R {
  if (!fields.length) return row;
  const r: Record<string, unknown> = { ...row };
  for (const f of fields) if (r[f] === 1 || r[f] === 0) r[f] = r[f] === 1;
  return r as R;
}
