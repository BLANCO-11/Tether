/**
 * The sandbox's SHAPE — DDL derived from introspection, and the fingerprint that
 * says whether it is still the right shape.
 * DECISIONS.md D-52, D-53 · ISSUES.md I-54…I-56
 *
 * ── Why the sandbox copies the shape instead of inventing one ────────────────
 *
 * The whole value of the sandbox is that **not one line of named-query SQL
 * changes** between a draft run and a live one. A query says
 * `SELECT … FROM employees e JOIN attendance a ON …`, and if the sandbox's
 * tables were named or typed differently the draft run would fail for reasons
 * that have nothing to do with the flow — which is a test that teaches the wrong
 * lesson and gets switched off.
 *
 * So the sandbox is the source's shape, same schemas, same table names, same
 * column names, same types, in a database Foundry owns. That is `hr_demo`
 * generalised, and it is forced: **D-40 refuses to register a datasource Foundry
 * can write to**, so Foundry structurally cannot create these tables inside the
 * tenant's own database even if it wanted to.
 *
 * ── This module is PURE ──────────────────────────────────────────────────────
 *
 * It takes introspected entities and returns text. No database, no network, no
 * clock. Everything about "is the sandbox the right shape" is therefore decided
 * by a function a test can call with a hand-written schema, which is the half of
 * this stage most likely to be wrong in a way nothing notices.
 */
import crypto from "node:crypto";
import type { IntrospectedColumn, IntrospectedEntity } from "./introspect/types.js";

/** The value families the fixture generator knows how to write and the taxonomy can check. */
export type ValueKind =
  | "int"
  | "decimal"
  | "bool"
  | "text"
  | "date"
  | "timestamp"
  | "time"
  | "uuid"
  | "json"
  | "array"
  /**
   * A Postgres enum whose MEMBERS are known — the column's `enumValues`.
   *
   * ⚠ Separate from `text` on purpose. The generator must draw only from the
   * members, or the fixture holds values production rejects; and the taxonomy
   * has a real question to ask of this column that it cannot ask of free text.
   */
  | "enum"
  /**
   * A column whose type is NOT DECLARED — SQLite's "any" (a view's computed column, an untyped table column). Reproduced so a read
   * that uses it runs (2026-10-02, H02: `sum(days)` over `v_absence` died against a mock that had dropped it), and holding NO values:
   * nothing says what it holds, so any invented value would be a guess. An empty column refuses nothing the real one accepts and
   * accepts nothing it refuses — it is not a widening.
   */
  | "unknown";

export interface SandboxColumn {
  name: string;
  /** The DDL type emitted into the sandbox. */
  sqlType: string;
  kind: ValueKind;
  nullable: boolean;
  isPrimaryKey: boolean;
  /** `"table.column"` as introspection reported it, un-schema-qualified. */
  references: string | null;
  maxLength: number | null;
  /**
   * The legal values, for `kind: "enum"` only — in the source's own declaration
   * order, which is the order Postgres sorts the type by.
   *
   * ⚠ Present ONLY when non-empty. An empty array would read as "an enum that
   * permits nothing", and the generator would have nothing to write.
   */
  enumValues?: string[];
}

export interface SandboxTable {
  /** The schema the entity lives in. `null` → the connection's default. */
  schema: string | null;
  name: string;
  /** `"<schema>.<name>"`, or just `<name>` when the schema is the default. The fixture key. */
  key: string;
  /** What it was in the SOURCE — a view becomes a table here, and that is a stated bound. */
  sourceKind: string;
  columns: SandboxColumn[];
}

export interface SandboxShape {
  tables: SandboxTable[];
  schemas: string[];
  /** Stable over the shape and nothing else — see `fingerprint`. */
  fingerprint: string;
  /**
   * Why a column, entity or constraint could not be reproduced.
   *
   * ⚠ A refusal, not a warning. `deriveShape` throws when this is non-empty and
   * the caller asked for DDL, because the alternative — quietly widening an
   * `enum` to `text` or a `numeric` to `text` — produces a sandbox that runs the
   * query and returns a different answer. A sandbox that is subtly the wrong
   * shape is worse than no sandbox: it reports green.
   */
  unsupported: string[];
  /**
   * Reproduced, but with something dropped that a reader should know about
   * (a view materialised as a table, a foreign key not enforced).
   */
  notes: string[];
}

/**
 * `information_schema.data_type` → the type the sandbox emits, and the value
 * family the generator writes.
 *
 * Deliberately an ALLOWLIST. The unmapped case is a refusal that names the
 * column, not a fallback to `text`: `SUM(amount_cents)` over a `text` column is
 * an error at query time in the best case and a lexicographic sum in the worst.
 */
const TYPE_MAP: Record<string, { sqlType: string; kind: ValueKind }> = {
  // No declared type (SQLite). `text` is a type name both mock engines accept; the column only ever holds NULL (`unknown`).
  any: { sqlType: "text", kind: "unknown" },
  smallint: { sqlType: "smallint", kind: "int" },
  integer: { sqlType: "integer", kind: "int" },
  bigint: { sqlType: "bigint", kind: "int" },
  numeric: { sqlType: "numeric", kind: "decimal" },
  decimal: { sqlType: "numeric", kind: "decimal" },
  "double precision": { sqlType: "double precision", kind: "decimal" },
  real: { sqlType: "real", kind: "decimal" },
  boolean: { sqlType: "boolean", kind: "bool" },
  text: { sqlType: "text", kind: "text" },
  "character varying": { sqlType: "varchar", kind: "text" },
  character: { sqlType: "char", kind: "text" },
  date: { sqlType: "date", kind: "date" },
  "timestamp without time zone": { sqlType: "timestamp", kind: "timestamp" },
  "timestamp with time zone": { sqlType: "timestamptz", kind: "timestamp" },
  "time without time zone": { sqlType: "time", kind: "time" },
  uuid: { sqlType: "uuid", kind: "uuid" },
  json: { sqlType: "jsonb", kind: "json" },
  jsonb: { sqlType: "jsonb", kind: "json" },
};

/** `array:_int4` → `integer[]`. Only the families the generator can actually write. */
const ARRAY_MAP: Record<string, string> = {
  _int2: "smallint[]",
  _int4: "integer[]",
  _int8: "bigint[]",
  _text: "text[]",
  _varchar: "varchar[]",
  _numeric: "numeric[]",
  _bool: "boolean[]",
};

/**
 * An identifier safe to interpolate into SQL **without quotes**.
 *
 * ⚠ **DO NOT WIDEN THIS.** It reads like a style rule and it is a security
 * control: `sandbox.service.ts` interpolates sandbox role, database and schema
 * names bare — `CREATE ROLE ${role}`, `GRANT USAGE ON SCHEMA ${schema}`,
 * `REVOKE ALL ON DATABASE ${database} FROM PUBLIC` — and this predicate is the
 * only thing between those statements and whatever the name contains.
 *
 * ⚠ It is NOT the rule for a tenant's own table and column names. Those are
 * quoted at every emission site, so they use `isQuotableIdentifier` below. The
 * two were one predicate until 2026-09-17, and the cost of that is written up
 * there.
 */
export function isSafeIdentifier(name: string): boolean {
  return /^[a-z_][a-z0-9_]{0,62}$/.test(name);
}

/**
 * An identifier safe to emit **quoted** — the rule for a TENANT's tables and
 * columns.
 *
 * ── ⚠ Why this exists (2026-09-17) ──────────────────────────────────────────
 *
 * `isSafeIdentifier` was used for both jobs, so a Prisma-shaped schema — 46
 * PascalCase tables, camelCase columns — could not have mock data at all. The
 * refusal a tenant actually saw was:
 *
 *     unsupported shape: ActivityFeedAction: entity name is not a plain
 *     lower_snake_case identifier; ... public.approver_mappings.createdBy:
 *     column name is not a plain lower_snake_case identifier, so it cannot be
 *     reproduced without quoting rules this module deliberately does not have
 *
 * ⚠ **That last clause was FALSE.** This module has always had quoting rules:
 * every one of the five identifier emission sites goes through `quoteIdent` or
 * `qualify`, both insert paths quote (`sandbox-fixture.service.ts` and
 * `mock-engine/pglite.driver.ts`), and the mock engine's own `IDENT` already
 * accepted mixed case — so the deriver was stricter than the engine consuming
 * its output. It was refusing names it would have reproduced correctly.
 *
 * ── What is still refused, and why ──────────────────────────────────────────
 *
 * A double quote, because `quoteIdent` and `qualify` wrap rather than escape,
 * and a name that could close its own quoting is the one shape that turns a
 * quoted identifier back into SQL. Also anything over 63 bytes (Postgres
 * truncates, so two distinct columns could collide into one) and control
 * characters.
 */
export function isQuotableIdentifier(name: string): boolean {
  if (name.length === 0) return false;
  // Postgres's NAMEDATALEN limit is 63 BYTES, not characters — a multi-byte
  // name that passes a `.length` check can still be truncated into a collision.
  if (Buffer.byteLength(name, "utf8") > 63) return false;
  if (name.includes('"')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return false;
  return true;
}

function quoteIdent(name: string): string {
  // ⚠ Escapes as well as wraps. `isQuotableIdentifier` already refuses a name
  // containing a double quote, so this is belt-and-braces — but it is the
  // cheaper half of the pair to get right, and a future caller that skips the
  // predicate should not be able to produce broken DDL.
  return `"${name.replace(/"/g, '""')}"`;
}

function mapColumn(
  table: string,
  c: IntrospectedColumn,
  unsupported: string[],
): SandboxColumn | null {
  if (!isQuotableIdentifier(c.name)) {
    unsupported.push(
      `${table}.${c.name}: column name cannot be reproduced as a quoted identifier ` +
        `(it is empty, over 63 bytes, or contains a double quote or a control character)`,
    );
    return null;
  }
  const raw = (c.type ?? "").trim();
  let sqlType: string | null = null;
  let kind: ValueKind | null = null;
  let enumValues: string[] | undefined;

  if (raw.startsWith("array:")) {
    const udt = raw.slice("array:".length);
    const mapped = ARRAY_MAP[udt];
    if (!mapped) {
      unsupported.push(`${table}.${c.name}: array of "${udt}" has no sandbox equivalent`);
      return null;
    }
    sqlType = mapped;
    kind = "array";
  } else if (raw.startsWith("user-defined:")) {
    /**
     * ⚠ **An enum is REPRODUCED now, and this used to refuse — 2026-09-17.**
     *
     * The refusal's reasoning was right and its premise stopped being true. It
     * read: *"introspection does not capture an enum's members, and a column
     * widened to text would accept values the real column rejects."* The first
     * clause is what changed — `postgres.introspector.ts` now reads `pg_enum`
     * and records the members, so there is nothing left to widen.
     *
     * ⚠ **The second clause is honoured rather than dropped.** The column is
     * emitted as `text` with a `CHECK (col IN (…))`, so the reproduced column
     * refuses exactly the values the real one refuses. A bare `text` column
     * would have been the easy version and would have made the original
     * objection true.
     *
     * What this fixed: 14 columns across 10 tables of a real tenant were absent
     * from the mock entirely, so a correct query touching one died against the
     * fixture with `column "partnerType" does not exist`.
     *
     * ⚠ A domain or a composite is `USER-DEFINED` too, has no members, and
     * still lands in `unsupported` below — it is genuinely unreproducible, and
     * an empty member list must never read as an enum permitting nothing.
     */
    const spec = raw.slice("user-defined:".length);
    const open = spec.indexOf("(");
    if (open > 0 && spec.endsWith(")")) {
      const members = spec
        .slice(open + 1, -1)
        .split(",")
        .map((m) => m.trim())
        .filter((m) => m.length > 0);
      if (members.length > 0) {
        // Falls through to the ONE construction below rather than returning its
        // own object: two places building a `SandboxColumn` is two places for a
        // field added later to be forgotten in one of them.
        sqlType = "text";
        kind = "enum";
        enumValues = members;
      }
    }
    if (sqlType === null || kind === null) {
      unsupported.push(
        `${table}.${c.name}: "${spec}" is a user-defined type with no members recorded — ` +
          `a domain or composite has none to record, and a column widened to text would ` +
          `accept values the real column rejects`,
      );
      return null;
    }
  } else {
    const mapped = TYPE_MAP[raw.toLowerCase()];
    if (!mapped) {
      unsupported.push(`${table}.${c.name}: type "${raw}" has no sandbox equivalent`);
      return null;
    }
    sqlType = mapped.sqlType;
    kind = mapped.kind;
    if ((sqlType === "varchar" || sqlType === "char") && c.characterMaximumLength) {
      sqlType = `${sqlType}(${c.characterMaximumLength})`;
    } else if (sqlType === "varchar") {
      sqlType = "text"; // unbounded varchar; `varchar` with no length is legal but odd
    } else if (sqlType === "char") {
      sqlType = "char(1)";
    }
  }

  return {
    name: c.name,
    sqlType,
    kind,
    nullable: c.nullable !== false,
    isPrimaryKey: c.isPrimaryKey === true,
    references: c.foreignKeyReference ?? null,
    maxLength: c.characterMaximumLength ?? null,
    ...(enumValues ? { enumValues } : {}),
  };
}

/**
 * A fingerprint over the SHAPE and nothing else.
 *
 * ⚠ Not `refFingerprints()` and not the manifest hash, for the same reason D-25
 * keeps `refInterfaces()` separate from `refFingerprints()`: the manifest hash
 * moves when a tool's description is edited, and suspending a sandbox because
 * somebody improved a sentence is a check that fires for the wrong reason and
 * therefore gets ignored. This moves when a table, a column, a type or a
 * nullability changes — which is exactly when the sandbox stops being a copy of
 * the thing under test.
 *
 * Row estimates are excluded on purpose: production growing does not make a
 * fixture stale.
 */
export function fingerprintShape(tables: SandboxTable[]): string {
  const canonical = tables
    .map((t) => {
      const cols = t.columns
        .map(
          (c) =>
            `${c.name}:${c.sqlType}:${c.nullable ? "null" : "notnull"}:${c.isPrimaryKey ? "pk" : "-"}`,
        )
        .sort()
        .join(",");
      return `${t.key}(${cols})`;
    })
    .sort()
    .join(";");
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 40);
}

export interface DeriveOptions {
  /** Schemas the datasource declares. Used to validate, never to widen. */
  allowlist: string[];
}

/**
 * Turn stored introspection into a sandbox shape.
 *
 * Views and materialized views become ordinary TABLES. That is the one place the
 * copy is not faithful, and it is unavoidable: introspection records a view's
 * columns and not its definition, so the join it pre-resolves cannot be
 * reproduced. The consequence is stated rather than hidden — a fixture fills a
 * view's rows directly, so a view and its base tables are only as consistent as
 * the generator made them, and a flow reading both is not testing that
 * relationship. It goes in `notes`, and the harness prints them.
 */
export function deriveShape(
  entities: IntrospectedEntity[],
  opts: DeriveOptions,
): SandboxShape {
  const unsupported: string[] = [];
  const notes: string[] = [];
  const tables: SandboxTable[] = [];
  const schemaSet = new Set<string>();

  for (const e of entities) {
    if (!isQuotableIdentifier(e.name)) {
      unsupported.push(
        `${e.name}: table name cannot be reproduced as a quoted identifier ` +
          `(it is empty, over 63 bytes, or contains a double quote or a control character)`,
      );
      continue;
    }
    const schema = e.schema ?? null;
    // ⚠ The SCHEMA name keeps the STRICTER rule, and the asymmetry is the point.
    // A table or column name is only ever emitted quoted, so mixed case is safe.
    // A schema name is not: `sandbox.service.ts` puts it bare into
    // `GRANT USAGE ON SCHEMA ${schema}` when provisioning the real sandbox that
    // shares this shape. Widening it here would move that refusal from a clear
    // "unsupported shape" at derivation to a SandboxError mid-provision.
    if (schema !== null && !isSafeIdentifier(schema)) {
      unsupported.push(`${schema}.${e.name}: schema name is not a plain lower_snake_case identifier`);
      continue;
    }
    if (schema !== null) schemaSet.add(schema);

    const key = schema ? `${schema}.${e.name}` : e.name;
    const columns: SandboxColumn[] = [];
    for (const c of e.columns) {
      const mapped = mapColumn(key, c, unsupported);
      if (mapped) columns.push(mapped);
    }
    if (columns.length === 0) {
      unsupported.push(`${key}: no reproducible columns`);
      continue;
    }
    if (e.entityType !== "table") {
      notes.push(
        `${key} is a ${e.entityType} in the source and is a plain TABLE in the sandbox — ` +
          `introspection records a view's columns, not its definition, so the relationship ` +
          `between it and its base tables is not reproduced`,
      );
    }
    tables.push({ schema, name: e.name, key, sourceKind: e.entityType, columns });
  }

  for (const s of opts.allowlist) {
    if (isSafeIdentifier(s)) schemaSet.add(s);
  }

  // ⚠ Stated once, always, because its absence is invisible. Introspection
  // records `isPrimaryKey` and nothing else about constraints, so a UNIQUE index
  // (`employees.employee_code`, `departments.code`) is NOT reproduced. The
  // sandbox is therefore slightly more permissive than production: a fixture can
  // hold two rows a real database would refuse, and a flow that depends on
  // uniqueness is not tested for it here. Not guessed at from column names —
  // that would produce constraints production does not have, which is the same
  // error in the other direction.
  if (tables.length > 0) {
    notes.push(
      "UNIQUE constraints are not reproduced — introspection records primary keys only, so the " +
        "sandbox accepts duplicate values the source database would refuse",
    );
  }

  // A foreign key whose target is not in the fixture set cannot be checked at
  // all; say so rather than letting the integrity pass look complete.
  for (const t of tables) {
    for (const c of t.columns) {
      if (!c.references) continue;
      const targetTable = c.references.split(".")[0];
      if (!tables.some((x) => x.name === targetTable)) {
        notes.push(
          `${t.key}.${c.name} references "${c.references}", which is outside this datasource's ` +
            `allowlist — referential integrity for it is NOT checked`,
        );
      }
    }
  }

  return {
    tables,
    schemas: [...schemaSet].sort(),
    fingerprint: fingerprintShape(tables),
    unsupported,
    notes,
  };
}

/**
 * The DDL, as one script.
 *
 * ── Primary keys are enforced; foreign keys deliberately are NOT ─────────────
 *
 * A PK is a property of the row the generator has to get right, and a violation
 * is a clean insert error naming the table. A foreign key is different: the
 * generator writes every table's rows in one pass, so an enforced FK turns any
 * single invented id into an insert failure that aborts the whole fixture, and
 * the message names a constraint rather than the row. Loading without FKs and
 * then CHECKING referential integrity in SQL turns the same mistake into a
 * finding that names the orphan — and integrity still has to pass, so nothing is
 * given up. See `verifyIntegrity`.
 */
export function renderDdl(shape: SandboxShape): string {
  if (shape.unsupported.length > 0) {
    throw new Error(
      `this datasource's shape cannot be reproduced in a sandbox:\n  - ` +
        shape.unsupported.join("\n  - "),
    );
  }
  const out: string[] = [];
  for (const s of shape.schemas) {
    if (s === "public") continue; // always present
    out.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(s)};`);
  }
  for (const t of shape.tables) {
    const qualified = t.schema
      ? `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`
      : quoteIdent(t.name);
    const cols = t.columns.map((c) => {
      const nullability = c.nullable ? "" : " NOT NULL";
      /**
       * ⚠ **An enum is `text` PLUS a CHECK, and the CHECK is the whole point.**
       * Reproducing the members as a bare `text` column would be the easy
       * version and would make true the objection this branch used to refuse
       * on: a column that accepts values the real one rejects. With the
       * constraint, the copy refuses exactly what the source refuses.
       *
       * Inline rather than a table constraint so it travels with the column —
       * a column dropped from a shape cannot leave a dangling constraint
       * behind. Values are single-quoted with `''` escaping, the same rule
       * `quoteIdent` applies to identifiers.
       */
      const check =
        c.kind === "enum" && c.enumValues && c.enumValues.length > 0
          ? ` CHECK (${quoteIdent(c.name)} IN (${c.enumValues
              .map((v) => `'${v.replace(/'/g, "''")}'`)
              .join(", ")}))`
          : "";
      return `  ${quoteIdent(c.name)} ${c.sqlType}${nullability}${check}`;
    });
    const pk = t.columns.filter((c) => c.isPrimaryKey).map((c) => quoteIdent(c.name));
    if (pk.length > 0) cols.push(`  PRIMARY KEY (${pk.join(", ")})`);
    out.push(`CREATE TABLE ${qualified} (\n${cols.join(",\n")}\n);`);
  }
  return out.join("\n\n") + "\n";
}

/** `"<schema>.<name>"` rendered for SQL. Shared so the fixture key and the DDL cannot disagree. */
export function qualify(t: Pick<SandboxTable, "schema" | "name">): string {
  return t.schema ? `"${t.schema}"."${t.name}"` : `"${t.name}"`;
}
