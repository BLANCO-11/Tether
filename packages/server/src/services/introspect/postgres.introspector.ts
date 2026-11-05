import { identifyingName, isChoiceSet, OBSERVE_MAX, OBSERVE_SAMPLE } from "./choice-set.js";
import pg from "pg";
import type {
  EntityKind,
  Introspector,
  IntrospectionResult,
  IntrospectedEntity,
  IntrospectOptions,
  DescribedQuery,
  ValueDomain,
} from "./types.js";

/**
 * PostgreSQL schema introspector — reads information_schema + pg_catalog.
 *
 * WS-C (plans/production-substitution-plan.md §6) reworked three things here:
 *
 *  - **C.1 The `table_schema = 'public'` hardcode is gone.** It appeared in four
 *    queries, so a production database exposing a named schema was invisible.
 *    Schemas now come from the datasource's allowlist.
 *  - **C.2 Entity kind is real.** Every entity was labelled `table`, including
 *    views — which matters because the safest production wiring (WS-A.7) grants
 *    SELECT on purpose-built views, so in production most of this is views.
 *  - **C.4 Row estimates are honest.** `reltuples` is `-1` on a never-analysed
 *    table and meaningless for a view; both now report `null` rather than `~-1`.
 *
 * Row counts still come from `pg_class.reltuples` (a planner estimate) — never a
 * `COUNT(*)`, which would scan production data to fill in a manifest field.
 */

/** pg_class.relkind → our entity kind. */
const RELKIND: Record<string, EntityKind> = {
  r: "table",
  p: "table", // partitioned table
  v: "view",
  m: "materialized_view",
  f: "foreign_table",
};

/** Kinds for which a row estimate means anything at all. */
const COUNTABLE = new Set<EntityKind>(["table", "materialized_view"]);

const DEFAULT_MAX_ENTITIES = 300;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * The `type` string a column is recorded under.
 *
 * `data_type` is a placeholder for two families — `ARRAY` for `int[]` and
 * `USER-DEFINED` for an enum, a domain or a composite — so `udt_name` carries
 * the real type and is appended where it does.
 *
 * ⚠ **An enum additionally carries its MEMBERS, in `(a,b,c)`.** That spelling is
 * MySQL's, not an invention: `mysql.introspector.ts` already records
 * `enum('low','high')` from `COLUMN_TYPE` for exactly this reason, and having
 * two shapes for one idea is how one of them stops being parsed. The members are
 * what make an enum reproducible at all — see `sandbox-ddl.service.ts`.
 *
 * ⚠ A member containing a comma or a parenthesis would make this string
 * ambiguous to a reader splitting on them, so such an enum records **no**
 * members and falls back to the bare `user-defined:<name>` form. That is the
 * pre-existing behaviour and the pre-existing refusal, which is the safe
 * direction: a column nobody can reproduce is loud, and a member list that
 * parses into the wrong values is silent.
 */
export function columnType(
  dataType: string,
  udtName: string,
  enumMembers: Map<string, string[]>,
): string {
  if (dataType === "ARRAY") return `array:${udtName}`;
  if (dataType !== "USER-DEFINED") return dataType;
  const members = enumMembers.get(udtName);
  if (!members || members.length === 0) return `user-defined:${udtName}`;
  if (members.some((m) => /[(),]/.test(m))) return `user-defined:${udtName}`;
  return `user-defined:${udtName}(${members.join(",")})`;
}

// The set-of-choices rule is shared by every introspector and the mock builder: choice-set.ts.
export { isChoiceSet, OBSERVE_MAX } from "./choice-set.js";

/**
 * The values a single-column CHECK constraint allows, from `pg_get_constraintdef` (compiled-builder I-301). Postgres normalises
 * `col IN ('a','b')` to `(col = ANY (ARRAY['a'::text, 'b'::text]))`, with casts around the column and the array for varchar.
 * Anything else — a range, an OR of other shapes, a function — is NOT a domain and answers `null`: a constraint misread as a
 * value list would refuse values the column accepts.
 */
export function checkInValues(def: string, column: string): string[] | null {
  const col = `(?:\\(*"?${column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\)?(?:::[a-z ]+)?)`;
  const m = new RegExp(`^CHECK \\(+${col} = ANY \\(+ARRAY\\[([^\\]]*)\\]\\)?(?:::[a-z ]+\\[\\])?\\)+$`, "i").exec(def.trim());
  if (!m) return null;
  const items = m[1]!.split(/,\s*(?=')/);
  const out: string[] = [];
  for (const it of items) {
    const v = /^'((?:[^']|'')*)'(?:::[a-z ]+)?$/i.exec(it.trim());
    if (!v) return null;
    out.push(v[1]!.replace(/''/g, "'"));
  }
  return out.length ? out : null;
}

/** Text-like columns — the only ones an observed domain is read for. */
const TEXTISH = /^(text|character varying|character|citext|name)$/;

/**
 * Describe a saved query's parameters and result columns WITHOUT reading a row (compiled-builder I-271, G13).
 *
 * In one READ ONLY transaction that is always rolled back:
 *  - `PREPARE` + `pg_prepared_statements.parameter_types` → each positional parameter's real SQL type;
 *  - `SELECT * FROM (<sql>) q LIMIT 0` with every parameter NULL → the result fields (name, type OID, and the
 *    source table/column where there is one), from which nullability and a declared tag are read.
 * ⚠ `LIMIT 0` plans and returns no rows; nothing a tenant stores is read. Returns `null` when the database cannot
 * describe it (a type it cannot infer, a syntax error), so the caller keeps the untyped fallback and says so.
 */
export async function describePostgresQuery(connectionString: string, sql: string, paramOrder: string[]): Promise<DescribedQuery | null> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = 5000");
    await client.query(`PREPARE foundry_describe AS ${sql}`);
    const p = await client.query<{ types: string[] }>(
      "SELECT parameter_types::text[] AS types FROM pg_prepared_statements WHERE name = 'foundry_describe'",
    );
    const paramTypes = p.rows[0]?.types ?? [];
    const res = await client.query({ text: `SELECT * FROM (${sql}) AS foundry_q LIMIT 0`, values: paramOrder.map(() => null) });
    const oids = [...new Set(res.fields.map((f) => f.dataTypeID))];
    const types = await client.query<{ oid: number; name: string }>("SELECT oid::int, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1::oid[])", [oids]);
    const typeName = new Map(types.rows.map((t) => [t.oid, t.name]));
    const sources = res.fields.filter((f) => f.tableID && f.columnID);
    const src = sources.length
      ? await client.query<{ rel: number; att: number; notnull: boolean; tag: string | null }>(
          `SELECT a.attrelid::int AS rel, a.attnum::int AS att, a.attnotnull AS notnull,
                  (SELECT substr(d.description, length('foundry:tag=') + 1) FROM pg_description d
                    WHERE d.objoid = a.attrelid AND d.objsubid = a.attnum AND d.description LIKE 'foundry:tag=%') AS tag
             FROM pg_attribute a WHERE (a.attrelid, a.attnum) IN (SELECT * FROM unnest($1::oid[], $2::int2[]))`,
          [sources.map((f) => f.tableID), sources.map((f) => f.columnID)],
        )
      : { rows: [] as Array<{ rel: number; att: number; notnull: boolean; tag: string | null }> };
    const srcOf = new Map(src.rows.map((r) => [`${r.rel}:${r.att}`, r]));
    const outer = /\b(LEFT|RIGHT|FULL)\s+(OUTER\s+)?JOIN\b/i.test(sql.replace(/--[^\n]*/g, ""));
    return {
      params: paramOrder.map((name, i) => ({ name, type: paramTypes[i] ?? "unknown" })),
      columns: res.fields.map((f) => {
        const s = f.tableID ? srcOf.get(`${f.tableID}:${f.columnID}`) : undefined;
        // ⚠ Postgres reports a result column's SOURCE, not whether the query outer-joined it (E0.7 G5's hole in another
        // place). So: computed or aggregated (no source) ⇒ nullable; any LEFT/RIGHT/FULL join in the statement ⇒ every
        // column nullable; otherwise the source column's own NOT NULL. Sound, and over-cautious by design.
        return { name: f.name, type: typeName.get(f.dataTypeID) ?? "unknown", nullable: outer || !s || !s.notnull, tag: s?.tag ?? null };
      }),
    };
  } catch (e) {
    console.warn(`[describe] could not describe a query: ${(e as Error).message}`);
    return null;
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
  }
}

/** A column's DECLARED domain: an enum's members, else a CHECK-IN list. */
function declaredDomain(dataType: string, udtName: string, enumMembers: Map<string, string[]>, check: string[] | undefined): ValueDomain | null {
  const members = dataType === "USER-DEFINED" ? enumMembers.get(udtName) : undefined;
  if (members?.length) return { values: [...members], source: "declared" };
  return check?.length ? { values: check, source: "declared" } : null;
}

export const postgresIntrospector: Introspector = {
  async testConnection(connectionString) {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 8000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    } finally {
      await client.end().catch(() => {});
    }
  },

  async introspect(connectionString, opts: IntrospectOptions = {}): Promise<IntrospectionResult> {
    const schemaList = opts.schemas?.length ? opts.schemas : ["public"];
    const maxEntities = opts.maxEntities ?? DEFAULT_MAX_ENTITIES;
    const singleSchema = schemaList.length === 1 ? schemaList[0] : null;

    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 8000 });
    await client.connect();
    try {
      // C.3: a 400-table schema must not hang provisioning. Bound every statement.
      await client.query(
        `SET statement_timeout = ${Number(opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS)}`,
      );

      // ── entities and their real kinds (C.2) ───────────────────────────────
      // Read from pg_class rather than information_schema.tables: relkind
      // distinguishes materialized views and partitioned tables, which
      // table_type does not.
      const rels = await client.query<{
        schema: string;
        name: string;
        relkind: string;
        reltuples: string;
      }>(
        `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind, c.reltuples
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY($1::text[])
            AND c.relkind = ANY(ARRAY['r','p','v','m','f'])
          ORDER BY n.nspname, c.relname`,
        [schemaList],
      );

      const total = rels.rows.length;
      const kept = rels.rows.slice(0, maxEntities);

      const cols = await client.query<{
        table_schema: string;
        table_name: string;
        column_name: string;
        data_type: string;
        udt_name: string;
        is_nullable: string;
        character_maximum_length: number | null;
      }>(
        `SELECT table_schema, table_name, column_name, data_type, udt_name,
                is_nullable, character_maximum_length
           FROM information_schema.columns
          WHERE table_schema = ANY($1::text[])
          ORDER BY table_schema, table_name, ordinal_position`,
        [schemaList],
      );

      /**
       * ── enum MEMBERS, and why this query exists ──────────────────────────
       *
       * `information_schema.columns` reports an enum as `USER-DEFINED` with the
       * type NAME in `udt_name` and says nothing about its values. That gap is
       * not cosmetic — it made every enum column **unreproducible**:
       * `sandbox-ddl.service.ts` refused one outright, because a column widened
       * to `text` would accept values the real column rejects. Measured on a
       * tenant's Prisma schema: 14 columns across 10 tables absent from the
       * mock, so a correct query touching one died against the fixture with
       * `column "partnerType" does not exist`.
       *
       * ⚠ It also fixes a GENERATION failure of the same age. The manifest
       * rendered `user-defined:partner_type`, so a model writing SQL against
       * this datasource was told a column is an enum and never told which
       * values are legal — which is exactly the measured "invented enum value"
       * failure mode in the recorded generation results.
       *
       * ⚠ **Scoped to enums specifically** (`typtype = 'e'`). A domain and a
       * composite are also `USER-DEFINED`, have no members, and must keep
       * falling through to the existing refusal rather than arriving as an enum
       * with an empty list — which would read as "an enum that permits nothing".
       */
      const enums = await client.query<{ udt_name: string; label: string }>(
        `SELECT t.typname AS udt_name, e.enumlabel AS label
           FROM pg_type t
           JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE t.typtype = 'e'
          ORDER BY t.typname, e.enumsortorder`,
      );
      const enumMembers = new Map<string, string[]>();
      for (const r of enums.rows) {
        const list = enumMembers.get(r.udt_name);
        if (list) list.push(r.label);
        else enumMembers.set(r.udt_name, [r.label]);
      }

      // ── keys, from pg_catalog rather than information_schema ──────────────
      // C.3: information_schema.constraint_column_usage returns the CARTESIAN
      // PRODUCT of a multi-column foreign key's columns, so a 2-column FK yields
      // 4 rows and each column gets paired with the wrong referenced column half
      // the time. conkey/confkey are positional arrays, so pairing by ordinal is
      // exact — the only way to get composite keys right.
      const keys = await client.query<{
        contype: string;
        schema: string;
        table_name: string;
        column_name: string;
        ref_schema: string | null;
        ref_table: string | null;
        ref_column: string | null;
      }>(
        `SELECT con.contype::text        AS contype,
                n.nspname                AS schema,
                cl.relname               AS table_name,
                att.attname              AS column_name,
                fn.nspname               AS ref_schema,
                fcl.relname              AS ref_table,
                fatt.attname             AS ref_column
           FROM pg_constraint con
           JOIN pg_class cl        ON cl.oid = con.conrelid
           JOIN pg_namespace n     ON n.oid = cl.relnamespace
           -- Pair each constrained column with the referenced column at the SAME
           -- ordinal position; WITH ORDINALITY is what makes that possible.
           JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS ck(attnum, ord) ON true
           JOIN pg_attribute att   ON att.attrelid = con.conrelid AND att.attnum = ck.attnum
           LEFT JOIN pg_class fcl      ON fcl.oid = con.confrelid
           LEFT JOIN pg_namespace fn   ON fn.oid = fcl.relnamespace
           LEFT JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord)
                  ON fk.ord = ck.ord
           LEFT JOIN pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = fk.attnum
          WHERE n.nspname = ANY($1::text[])
            AND con.contype IN ('p', 'f')`,
        [schemaList],
      );

      const pkSet = new Set<string>();
      const fkMap = new Map<string, string>();
      for (const r of keys.rows) {
        const key = `${r.schema}.${r.table_name}.${r.column_name}`;
        if (r.contype === "p") {
          pkSet.add(key);
        } else if (r.ref_table && r.ref_column) {
          // Qualify the reference only when it leaves the single expected schema —
          // an unqualified name is what the agent should write in its SQL.
          const ref =
            r.ref_schema && r.ref_schema !== singleSchema
              ? `${r.ref_schema}.${r.ref_table}.${r.ref_column}`
              : `${r.ref_table}.${r.ref_column}`;
          fkMap.set(key, ref);
        }
      }

      // ── declared semantic tags (compiled-builder I-278) ───────────────────
      // A column comment `foundry:tag=<spec>` is metadata the schema OWNER states; it is read, never guessed from a name.
      const comments = await client.query<{ schema: string; table_name: string; column_name: string; description: string }>(
        `SELECT n.nspname AS schema, c.relname AS table_name, a.attname AS column_name, d.description
           FROM pg_description d
           JOIN pg_class c      ON c.oid = d.objoid
           JOIN pg_namespace n  ON n.oid = c.relnamespace
           JOIN pg_attribute a  ON a.attrelid = c.oid AND a.attnum = d.objsubid
          WHERE d.objsubid > 0 AND n.nspname = ANY($1::text[]) AND d.description LIKE 'foundry:tag=%'`,
        [schemaList],
      );
      const tagOf = new Map(comments.rows.map((r) => [`${r.schema}.${r.table_name}.${r.column_name}`, r.description.slice("foundry:tag=".length)]));

      // ── declared value domains: single-column CHECK (col IN (…)) (compiled-builder I-301) ──
      const checks = await client.query<{ schema: string; table_name: string; column_name: string; def: string }>(
        `SELECT n.nspname AS schema, cl.relname AS table_name, att.attname AS column_name, pg_get_constraintdef(con.oid) AS def
           FROM pg_constraint con
           JOIN pg_class cl      ON cl.oid = con.conrelid
           JOIN pg_namespace n   ON n.oid = cl.relnamespace
           JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
          WHERE con.contype = 'c' AND array_length(con.conkey, 1) = 1 AND n.nspname = ANY($1::text[])`,
        [schemaList],
      );
      const checkOf = new Map<string, string[]>();
      for (const r of checks.rows) {
        const vals = checkInValues(r.def, r.column_name);
        if (vals) checkOf.set(`${r.schema}.${r.table_name}.${r.column_name}`, vals);
      }

      // ── assemble ──────────────────────────────────────────────────────────
      const byEntity = new Map<string, IntrospectedEntity>();
      for (const r of kept) {
        const kind = RELKIND[r.relkind] ?? "table";
        // C.4: reltuples is -1 on a never-analysed relation and meaningless for a
        // view. Both must be null — `rowsEstimate="~-1"` is a false statement.
        const raw = Number(r.reltuples);
        const rowCountEstimate =
          COUNTABLE.has(kind) && Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;
        byEntity.set(`${r.schema}.${r.name}`, {
          entityType: kind,
          name: r.name,
          // ALWAYS the real schema.
          //
          // This used to be nulled when it equalled the single requested schema,
          // reasoning that "a single-schema datasource renders exactly as before".
          // That is only true for `public`, which is on the default search_path.
          // With `schemas: ["hr"]` the manifest then carried no schema at all, the
          // agent wrote `FROM presence_rollup`, and the run died on
          // `relation "presence_rollup" does not exist` — caught by the WS-E
          // rehearsal, 2026-07-26. Faithfulness belongs here; deciding what is
          // worth RENDERING belongs to the manifest builder.
          schema: r.schema,
          rowCountEstimate,
          columns: [],
        });
      }

      for (const c of cols.rows) {
        const entity = byEntity.get(`${c.table_schema}.${c.table_name}`);
        if (!entity) continue; // truncated away, or a relkind we skip
        const key = `${c.table_schema}.${c.table_name}.${c.column_name}`;
        entity.columns.push({
          name: c.column_name,
          // C.3: data_type is "ARRAY" for int[] and "USER-DEFINED" for an enum or
          // domain — both useless to someone writing SQL. udt_name carries the
          // real type ("_int4", "mood"), so append it where data_type is only a
          // placeholder.
          type: columnType(c.data_type, c.udt_name, enumMembers),
          nullable: c.is_nullable === "YES",
          isPrimaryKey: pkSet.has(key),
          isForeignKey: fkMap.has(key),
          foreignKeyReference: fkMap.get(key) ?? null,
          characterMaximumLength: c.character_maximum_length,
          tag: tagOf.get(key) ?? null,
          domain: declaredDomain(c.data_type, c.udt_name, enumMembers, checkOf.get(key)),
        });
      }

      // ── observed value domains — always (2026-10-10; was opt-in, I-301 B). One bounded GROUP BY per text column, never a
      // row read. A domain is a SET OF CHOICES (choice-set.ts): few values that RECUR, none identifying, in a column not named
      // for a person or an identifier. Measured on orders_demo: 21 of 48 columns passed "≤ 20 distinct" alone — names and
      // emails among them — and 6 pass the full rule. Not a key, not a reference, not a column whose owner declared a tag.
      for (const e of byEntity.values()) {
        for (const col of e.columns) {
          if (col.domain || col.isPrimaryKey || col.isForeignKey || col.tag || !TEXTISH.test(col.type) || identifyingName(col.name)) continue;
          const tbl = `${client.escapeIdentifier(e.schema ?? "public")}.${client.escapeIdentifier(e.name)}`;
          const q = client.escapeIdentifier(col.name);
          try {
            const r = await client.query<{ v: string; n: number }>(
              `SELECT v, count(*)::int AS n FROM (SELECT ${q}::text AS v FROM ${tbl} WHERE ${q} IS NOT NULL LIMIT ${OBSERVE_SAMPLE}) s ` +
                `GROUP BY 1 LIMIT ${OBSERVE_MAX + 1}`,
            );
            const rows = r.rows.reduce((a, x) => a + x.n, 0);
            if (isChoiceSet(r.rows.map((x) => x.v), rows)) col.domain = { values: r.rows.map((x) => x.v).sort(), source: "observed" };
          } catch (err) {
            console.warn(`[introspect] could not observe values of ${e.name}.${col.name}: ${(err as Error).message}`);
          }
        }
      }

      return {
        entities: [...byEntity.values()],
        // C.3: never truncate silently — a capped manifest that presents itself as
        // complete is worse than one that says what is missing.
        ...(total > kept.length ? { truncated: { limit: maxEntities, total } } : {}),
      };
    } finally {
      await client.end().catch(() => {});
    }
  },
};
