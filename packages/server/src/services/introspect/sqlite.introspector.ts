// SQLite introspector — structure + counts only, over an uploaded file opened
// read-only. The DSN is `sqlite:file/<id>` (see `sqlite-file.service.ts`).
//
// A SQLite database has one schema, `main`, so the allowlist is not consulted:
// there is nothing else to include or exclude, and every entity is reported
// under `main` so that compiled SQL (`"main"."table"`) resolves in SQLite
// exactly as `"public"."table"` does in Postgres.
//
// Row counts are EXACT (`count(*)`), not estimates: the file is at most 50 MB,
// so there is no planner statistic worth trusting over the real number.
import { sqliteFileService, SQLITE_SCHEMA } from "../sqlite-file.service.js";
import { toSqlite } from "../sqlite-dialect.js";
import { identifyingName, isChoiceSet, OBSERVE_MAX, OBSERVE_SAMPLE } from "./choice-set.js";
import { flagResults, sqliteFlagColumns } from "./sqlite-flags.js";
import type { DescribedQuery, EntityKind, Introspector, IntrospectionResult, IntrospectedEntity, IntrospectOptions } from "./types.js";

/**
 * A SQLite declared type → the Postgres-style name the rest of Foundry reads
 * (`sandbox-ddl`'s type map, the catalogue, the typechecker).
 *
 * SQLite stores whatever it is given and derives an AFFINITY from the declared
 * type's words; this follows those same rules (sqlite.org/datatype3.html §3.1)
 * plus the date/time/boolean/json names SQLite has no affinity for but schemas
 * use anyway. ⚠ A type it cannot place is kept as written (`blob`, `any`,
 * `geometry`), not widened to text: the mock builder then leaves that column
 * out with a named reason, which is honest, where `text` would invent a shape.
 */
export function normaliseSqliteType(declared: string): { type: string; maxLength: number | null } {
  const d = declared.trim().toUpperCase();
  if (!d) return { type: "any", maxLength: null };
  const len = /\(\s*(\d+)\s*\)/.exec(d);
  if (/\bBOOL(EAN)?\b/.test(d)) return { type: "boolean", maxLength: null };
  if (/\bBIGINT\b|\bINT8\b|UNSIGNED BIG INT/.test(d)) return { type: "bigint", maxLength: null };
  if (/\b(SMALLINT|TINYINT|INT2)\b/.test(d)) return { type: "smallint", maxLength: null };
  if (/\b(INT|INTEGER|MEDIUMINT)\b/.test(d)) return { type: "integer", maxLength: null };
  if (/\b(DATETIME|TIMESTAMP)\b/.test(d)) return { type: "timestamp without time zone", maxLength: null };
  if (/\bDATE\b/.test(d)) return { type: "date", maxLength: null };
  if (/\bTIME\b/.test(d)) return { type: "time without time zone", maxLength: null };
  if (/\bUUID\b/.test(d)) return { type: "uuid", maxLength: null };
  if (/\bJSONB?\b/.test(d)) return { type: "json", maxLength: null };
  if (/CHAR|CLOB|TEXT|STRING/.test(d)) {
    return /VAR|VARYING/.test(d) && len
      ? { type: "character varying", maxLength: Number(len[1]) }
      : { type: "text", maxLength: null };
  }
  if (/REAL|FLOA|DOUB/.test(d)) return { type: "double precision", maxLength: null };
  if (/\b(NUMERIC|DECIMAL|NUMBER|MONEY)\b/.test(d)) return { type: "numeric", maxLength: null };
  return { type: declared.trim().toLowerCase(), maxLength: null };
}

/**
 * A TEXT column every value of which is an ISO date (or date-time) IS a date in SQLite (2026-10-01). SQLite has no date type: its
 * own date functions read and write ISO-8601 text (sqlite.org/lang_datefunc.html), so a schema declares `TEXT` and stores
 * `2026-08-14`. Typed as text, a parameter compared with such a column took any words — `from_date = "1 August"` compiled, ran and
 * matched nothing. Read from the DATA, never from the column's name, by one COUNT that stores no value: at least one value, and
 * none that is not the shape. A column holding one non-date is text, whatever it is called.
 */
const ISO_DATE = "[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]";
export function dateShapeSql(table: string, column: string): string {
  const c = quoteIdent(column);
  return `SELECT count(${c}) AS n, ` +
    `sum(CASE WHEN length(${c}) = 10 AND ${c} GLOB '${ISO_DATE}' THEN 1 ELSE 0 END) AS d, ` +
    `sum(CASE WHEN length(${c}) > 10 AND ${c} GLOB '${ISO_DATE}[T ][0-2][0-9]:[0-5][0-9]*' THEN 1 ELSE 0 END) AS ts ` +
    `FROM ${quoteIdent(table)} WHERE typeof(${c}) = 'text'`;
}
/** What a count of shapes says: `date`, `timestamp without time zone`, or nothing (the declared type stands). */
export function dateShapeOf(r: { n: number; d: number | null; ts: number | null }, textValues: number): string | null {
  if (!r.n || r.n !== textValues) return null;
  if (Number(r.d) === r.n) return "date";
  if (Number(r.ts) === r.n) return "timestamp without time zone";
  return null;
}

/**
 * A VIEW's column that IS a table's column carries that column's foreign key (2026-10-01: a read over `v_time_account` asked a person
 * for a `time_account_code`, because the view declared no key and the table did). SQLite names each result column's origin table and
 * column (`columns()`); a computed column has none and declares nothing.
 */
export function viewKeys(db: { prepare(sql: string): { columns(): unknown[] } }, entities: IntrospectedEntity[]): void {
  for (const v of entities.filter((e) => e.entityType === "view")) {
    try {
      const origins = db.prepare(`SELECT * FROM ${quoteIdent(v.name)}`).columns() as Array<{ name: string; table: string | null; column: string | null }>;
      for (const o of origins) {
        const from = o.table && o.column ? entities.find((e) => e.entityType === "table" && e.name === o.table)?.columns.find((c) => c.name === o.column) : undefined;
        const col = v.columns.find((c) => c.name === o.name);
        if (col && o.table && o.column) col.origin = { table: o.table, column: o.column };
        if (from?.isForeignKey && col && !col.isForeignKey) { col.isForeignKey = true; col.foreignKeyReference = from.foreignKeyReference; }
      }
    } catch (e) {
      console.warn(`[introspect] could not read the origins of view ${v.name}: ${(e as Error).message}`);
    }
  }
}

/** A VIEW's column that IS a declared flag is one too — the view states no type of its own (`v_employee.is_full_time`). */
export function viewFlags(db: { prepare(sql: string): { columns(): unknown[] } }, entities: IntrospectedEntity[], flags: Set<string>): void {
  for (const v of entities.filter((e) => e.entityType === "view")) {
    try {
      const named = new Set(flagResults(db.prepare(`SELECT * FROM ${quoteIdent(v.name)}`).columns() as Array<{ name: string; table: string | null; column: string | null }>, flags));
      for (const col of v.columns) if (named.has(col.name)) col.type = "boolean";
    } catch (e) {
      console.warn(`[introspect] could not read the origins of view ${v.name}: ${(e as Error).message}`);
    }
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export const sqliteIntrospector: Introspector = {
  async testConnection(connectionString) {
    try {
      const db = await sqliteFileService.open(connectionString);
      try {
        db.prepare("SELECT 1").get();
      } finally {
        db.close();
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  },

  async introspect(connectionString, opts: IntrospectOptions = {}): Promise<IntrospectionResult> {
    const db = await sqliteFileService.open(connectionString);
    try {
      const maxEntities = opts.maxEntities ?? 300;
      const all = db
        .prepare(
          "SELECT name, type FROM sqlite_schema WHERE type IN ('table','view') " +
            "AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string; type: string }>;
      const kept = all.slice(0, maxEntities);

      const entities: IntrospectedEntity[] = [];
      // Columns the schema DECLARES true/false (`sqlite-flags.ts`) — typed boolean, never an integer that cannot be tested.
      const flags = sqliteFlagColumns(db);
      for (const t of kept) {
        const kind: EntityKind = t.type === "view" ? "view" : "table";
        const cols = db.prepare("SELECT * FROM pragma_table_info(?)").all(t.name) as Array<{
          name: string;
          type: string;
          notnull: number;
          pk: number;
        }>;
        const fks = db.prepare("SELECT * FROM pragma_foreign_key_list(?)").all(t.name) as Array<{
          table: string;
          from: string;
          to: string | null;
        }>;
        const fkMap = new Map<string, string>();
        for (const fk of fks) {
          // `to` is null when the FK names the parent's primary key implicitly.
          fkMap.set(fk.from, `${fk.table}.${fk.to ?? "rowid"}`);
        }
        let rowCount: number | null = null;
        if (kind === "table") {
          try {
            const r = db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(t.name)}`).get() as { n: number };
            rowCount = Number(r.n);
          } catch {
            rowCount = null; // a virtual table whose module is not loaded
          }
        }
        const table = t.name;
        entities.push({
          entityType: kind,
          name: table,
          schema: SQLITE_SCHEMA,
          rowCountEstimate: rowCount,
          columns: cols.map((c) => {
            // SQLite columns may declare no type at all; that stays "any" rather than a guess.
            const t = flags.has(`${table}.${c.name}`) ? { type: "boolean", maxLength: null } : normaliseSqliteType(c.type ?? "");
            const fk = fkMap.has(c.name);
            const col = {
              name: c.name,
              type: t.type,
              nullable: c.notnull === 0 && c.pk === 0,
              isPrimaryKey: c.pk > 0,
              isForeignKey: fk,
              foreignKeyReference: fkMap.get(c.name) ?? null,
              characterMaximumLength: t.maxLength,
            } as IntrospectedEntity["columns"][number];
            if (t.type !== "text" && t.type !== "character varying") return col;
            try {
              // Every non-null value must be TEXT of the shape (a number stored in the column makes it not a date).
              const all = db.prepare(`SELECT count(${quoteIdent(c.name)}) AS n FROM ${quoteIdent(table)}`).get() as { n: number };
              const shape = db.prepare(dateShapeSql(table, c.name)).get() as { n: number; d: number | null; ts: number | null };
              const as = dateShapeOf(shape, Number(all.n));
              if (as) col.type = as;
            } catch (e) {
              console.warn(`[introspect] could not read the shape of ${table}.${c.name}: ${(e as Error).message}`);
            }
            // Observed values, always, as the Postgres introspector does it (choice-set.ts): a SET OF CHOICES, never a row.
            // Never a key, a reference, a date, or a column named for a person or an identifier.
            if (col.type === "text" && !col.isPrimaryKey && !fk && !identifyingName(c.name)) {
              try {
                const q = quoteIdent(c.name);
                const r = db.prepare(`SELECT v, count(*) AS n FROM (SELECT ${q} AS v FROM ${quoteIdent(table)} WHERE ${q} IS NOT NULL AND typeof(${q}) = 'text' LIMIT ${OBSERVE_SAMPLE}) GROUP BY 1 LIMIT ${OBSERVE_MAX + 1}`).all() as Array<{ v: string; n: number }>;
                const rows = r.reduce((a, x) => a + Number(x.n), 0);
                if (isChoiceSet(r.map((x) => String(x.v)), rows)) col.domain = { values: r.map((x) => String(x.v)).sort(), source: "observed" };
              } catch (e) {
                console.warn(`[introspect] could not observe values of ${table}.${c.name}: ${(e as Error).message}`);
              }
            }
            return col;
          }),
        });
      }
      viewKeys(db, entities);
      viewFlags(db, entities, flags);
      return {
        entities,
        ...(all.length > kept.length ? { truncated: { limit: maxEntities, total: all.length } } : {}),
      };
    } finally {
      db.close();
    }
  },
};

/**
 * Describe a saved query's result columns WITHOUT reading a row — the SQLite
 * half of `describePostgresQuery`. `prepare` compiles the statement and
 * `columns()` reports each result column's name and declared type; nothing is
 * stepped. Every column is reported nullable: SQLite does not say whether a
 * join or an expression can produce a NULL, and over-cautious is the sound
 * direction. Returns null when the statement does not compile here.
 */
export async function describeSqliteQuery(
  connectionString: string,
  sql: string,
  paramOrder: string[],
): Promise<DescribedQuery | null> {
  try {
    const stmt = toSqlite(sql);
    const db = await sqliteFileService.open(connectionString);
    try {
      const cols = db.prepare(stmt.sql).columns();
      const flags = new Set(flagResults(cols as Array<{ name: string; table: string | null; column: string | null }>, sqliteFlagColumns(db)));
      return {
        params: paramOrder.map((name) => ({ name, type: "unknown" })),
        columns: cols.map((c) => ({
          name: c.name,
          type: flags.has(c.name) ? "boolean" : c.type ? normaliseSqliteType(c.type).type : "unknown",
          nullable: true,
          tag: null,
        })),
      };
    } finally {
      db.close();
    }
  } catch (e) {
    console.warn(`[describe] could not describe a sqlite query: ${(e as Error).message}`);
    return null;
  }
}
