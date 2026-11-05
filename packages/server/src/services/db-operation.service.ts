/**
 * Named DATABASE OPERATIONS — the `query` step kind's callable.
 *
 * A named query (`datasource-query.service.ts`) is hand-written SQL that was
 * reviewed once, in a file. A DB operation is the design-sanctioned companion
 * (07 §7.0): the author builds a `DbOperationSpec` VISUALLY — base table,
 * columns with optional aggregates, joins from the FK graph, parameterized
 * filters, sort, limit — and THIS module compiles it to a read-only `SELECT`.
 * The author never writes SQL, so the file-review argument is replaced by the
 * compiler's own shape rules, and only introspected schema metadata is ever
 * visible to the author or the manifest.
 *
 * The compiler's safety properties:
 *
 *  1. **Identifiers are metadata, never input.** Every table, column, join side
 *     and schema reference is looked up against the introspected `schemas`
 *     rows; the emitted SQL quotes whatever the metadata says. A spec that
 *     names a table or column the datasource does not have is refused with a
 *     STRUCTURED finding (offending identifier + what WAS available), never
 *     interpolated and never a generic 500.
 *
 *  2. **Values are positional parameters.** A filter's `param` binds to `$n`
 *     (first filter → $1, in spec order; a repeated param name reuses its
 *     position, the same "one placeholder referenced twice" rule the named
 *     queries allow). `params_schema` is DERIVED from the filters — the same
 *     flat `{name:{type,required,description}}` vocabulary as
 *     `tools.paramsSchema` — so a param can never become SQL.
 *
 *  3. **The output is a read, and says so.** The compiled SQL is run through
 *     `checkSqlShape` from `datasource-query.service.ts` before it is stored or
 *     previewed, so a write-shaped statement is refused by the same rules the
 *     named queries use. The compiler only ever emits `SELECT`, so a finding
 *     here is a compiler bug — but the check is what makes that a refusal
 *     rather than a shipped statement.
 */

import { z } from "zod";
import { dbOperationRepo, type DbOperation } from "../repositories/db-operation.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { decrypt } from "../utils/encryptor.js";
import { isSqliteType, sqliteFileService } from "./sqlite-file.service.js";
import { schemaRepo, type SchemaRow } from "../repositories/schema.repo.js";
import { checkSqlShape } from "./datasource-query.service.js";
import { operationParamDescriptor, PARAM_FORMATS, toolParamDescriptor } from "./param-descriptor.js";
import { readback } from "./db-operation-readback.js";
import { flowRepo } from "../repositories/flow.repo.js";

function httpError(message: string, statusCode: number, extra?: Record<string, unknown>) {
  return Object.assign(new Error(message), { statusCode, ...extra });
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IDENTIFIER_MSG = "must be a plain identifier";

/**
 * A column reference that MAY name its owner — `column`, `table.column` or
 * `schema.table.column`.
 *
 * ⚠ **Scoped to the fields that resolve against the whole owner chain, and to
 * no others.** A chain is the only place two tables can offer the same column
 * name, so it is the only place a qualifier answers a question — `onRight`, a
 * `latestOne` filter and an aggregate's column all resolve against the single
 * table being joined, where `orders.id` could only ever be a longer spelling of
 * `id` or a mistake. Allowing it everywhere would make the qualifier decorative
 * in most positions and load-bearing in a few, which is how a reader learns to
 * ignore it.
 *
 * ⚠ `table` and `alias` keep `IDENTIFIER` deliberately. A table names its schema
 * in its own `schema` field, and an alias is an OUTPUT name — a dot in one would
 * travel into `.results[0].data`, where a jq path cannot read it back.
 */
const COLUMN_REF = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,2}$/;
const COLUMN_REF_MSG =
  'must be a plain identifier, optionally owner-qualified as "table.column" or "schema.table.column"';

// ⚠ EXPORTED so `db-operation-readback.test.ts` can iterate them and prove the
// readback is exhaustive over every one (SC-007). The readback module itself
// takes NONE of these as a value — it derives the unions with `import type`, so
// it keeps no runtime dependency on this module. Exporting the arrays is what
// lets the TEST enumerate what the TYPE only constrains.
export const AGGREGATES = ["count", "sum", "avg", "min", "max"] as const;
export const FILTER_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "like", "ilike", "is_null", "is_not_null", "month"] as const;
export const HAVING_OPS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;
export const ARITH_OPS = ["add", "subtract", "multiply", "divide"] as const;
/** The comparisons a fixed NUMBER may take (`value`): ordered and equality ones. A month, a list or a pattern is always supplied. */
const CONSTANT_OPS: readonly string[] = ["eq", "neq", "gt", "gte", "lt", "lte"];
/** A fixed number as SQL: a finite number, written by the compiler — never text the model chose. Parenthesised so a sign binds. */
/** A fixed value as SQL: a number, or TRUE/FALSE for a true/false column (SQLite reads both keywords as 1/0). */
const numberSql = (n: FixedValue): string =>
  typeof n === "string" ? `'${n.replace(/'/g, "''")}'` : typeof n === "boolean" ? (n ? "TRUE" : "FALSE") : `(${String(n)})`;
/**
 * A value the rule fixes: a number, true/false, or TEXT (builder-stability P2-I4, 2026-10-02 — "active employees" is
 * `employment_status = 'Active'`, and without text the read could not be written at all). Text is written by the compiler as a
 * single-quoted literal with every quote doubled, and the form refuses a backslash and every control character — so the literal
 * cannot end early on Postgres (with or without `standard_conforming_strings`) or SQLite. Only eq/neq: an ordered comparison of
 * text is collation-dependent and a pattern is always supplied.
 */
export type FixedValue = number | boolean | string;
const FIXED_TEXT = z.string().min(1).max(200).regex(/^[^\\\u0000-\u001f\u007f]+$/, "a fixed text value has no backslash and no control character");
const FIXED_VALUE = z.union([z.number().finite(), z.boolean(), FIXED_TEXT]);
const fixedOpOk = (f: { value?: FixedValue; op: string }) => f.value === undefined || (typeof f.value === "string" ? f.op === "eq" || f.op === "neq" : CONSTANT_OPS.includes(f.op));
const FIXED_OP_MSG = "a fixed number is compared with one of eq, neq, gt, gte, lt, lte, and fixed text with eq or neq — a DATE, a month, a list or a pattern is never fixed: it is supplied as a `param` (the contract's own parameter, when it names one)";
/**
 * A fixed value must have the TYPE of what it is compared with (2026-10-01): `is_working_day = 1` on a true/false column is a type
 * error Postgres refuses at run time, and `= true` on a number is one SQLite would answer silently wrong. True/false only by
 * eq/neq. Null when it fits; else what to write instead.
 */
export function constantMisfit(columnType: string | null | undefined, value: FixedValue, op: string, what: string): string | null {
  const flag = /^boolean?\b/.test((columnType ?? "").toLowerCase());
  if (typeof value === "string") {
    // Text fits any column that is not a number, a true/false or a date — an enum, a varchar, a text, an untyped SQLite column.
    const t = (columnType ?? "").toLowerCase();
    return flag || /int|numeric|decimal|real|double|float|serial|money|date|time|interval/.test(t) ? `${what} is ${t || "not text"}, so it is not compared with the text “${value}”` : null;
  }
  if (typeof value === "boolean") {
    if (!flag) return `${what} is not true/false, so it is compared with a number — not \`${value}\``;
    return op === "eq" || op === "neq" ? null : `${what} is true/false: compare it with eq or neq, not ${op}`;
  }
  return flag ? `${what} is true/false: its fixed value is true or false, not ${value}` : null;
}
/**
 * Two columns may be compared when they are the same KIND of value — numbers, moments (dates and times), true/false, or text — by
 * the same words `constantMisfit` reads a type with. An untyped column (SQLite) is comparable to anything: the database decides.
 */
export function comparableTypes(a: string | null | undefined, b: string | null | undefined): boolean {
  const kind = (t: string | null | undefined) => {
    const x = (t ?? "").toLowerCase();
    if (!x) return null;
    if (/^boolean?\b/.test(x)) return "flag";
    if (/int|numeric|decimal|real|double|float|serial|money/.test(x)) return "number";
    if (/date|time/.test(x)) return "moment";
    return "text";
  };
  const ka = kind(a), kb = kind(b);
  return ka === null || kb === null || ka === kb;
}
/** The comparisons a filter on a COMPUTED value may make — a number or a date against a parameter. */
export const COMPUTED_FILTER_OPS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;
export const JOIN_KINDS = ["inner", "left"] as const;
export const SORT_DIRS = ["asc", "desc"] as const;
/** A composable value: a resolved column, a supplied parameter, or a pure
 * function of values. The date functions exist because the engine's jq has no
 * date vocabulary (`strptime`/`mktime` fail the run — measured on
 * finance-invoice-chase): calendar math that a flow needs must be computed
 * here, where every identifier still resolves against the schema and every
 * value stays positional.
 *
 * ⚠ **Postgres date semantics, stated plainly** (like the `month` op):
 * `addDays` is `date + integer`; diffs cast both sides to dates first, so a
 * timestamp and a date compare as calendar days rather than erroring.
 */
type ComputeNodeInput = z.input<typeof computeNodeSchema>;
const computeNodeSchema: z.ZodTypeAny = z.union([
  z.object({ column: z.string().min(1).max(255).regex(COLUMN_REF, `column ${COLUMN_REF_MSG}`) }),
  z.object({
    param: z.string().min(1).max(64).regex(IDENTIFIER, `param ${IDENTIFIER_MSG}`),
    /** The value's shape, so the derived `paramsSchema` says `date` for a date
     *  endpoint and `number` for a day count rather than guessing from use. */
    type: z.enum(["string", "number", "date", "datetime"]).optional(),
  }),
  z.object({
    addDays: z.object({
      value: z.lazy((): z.ZodTypeAny => computeNodeSchema),
      days: z.lazy((): z.ZodTypeAny => computeNodeSchema),
    }),
  }),
  z.object({
    diffDays: z.object({
      start: z.lazy((): z.ZodTypeAny => computeNodeSchema),
      end: z.lazy((): z.ZodTypeAny => computeNodeSchema),
    }),
  }),
  z.object({
    diffMinutes: z.object({
      start: z.lazy((): z.ZodTypeAny => computeNodeSchema),
      end: z.lazy((): z.ZodTypeAny => computeNodeSchema),
    }),
  }),
  // Overlap bounds for pause clipping: which of two moments is later/earlier.
  // Both sides must be the same kind of value (two timestamps, two numbers) —
  // the database refuses a mixed comparison rather than coercing.
  z.object({
    greatest: z.object({
      first: z.lazy((): z.ZodTypeAny => computeNodeSchema),
      second: z.lazy((): z.ZodTypeAny => computeNodeSchema),
    }),
  }),
  z.object({
    least: z.object({
      first: z.lazy((): z.ZodTypeAny => computeNodeSchema),
      second: z.lazy((): z.ZodTypeAny => computeNodeSchema),
    }),
  }),
  // Business minutes, Mon–Fri 09:00–17:00 UTC, walking whole days — the same
  // walk `businessMinutes` in the itops fixture oracle does, so the two agree
  // by construction rather than by review. A service that runs around the
  // clock reads `diffMinutes` instead; the flow picks per service.
  z.object({
    businessMinutes: z.object({
      start: z.lazy((): z.ZodTypeAny => computeNodeSchema),
      end: z.lazy((): z.ZodTypeAny => computeNodeSchema),
    }),
  }),
  z.object({ coalesce: z.array(z.lazy((): z.ZodTypeAny => computeNodeSchema)).min(1) }),
  // A NUMBER the rule itself needs — the 0 of "treat a missing count as 0", the 100 of a percentage (2026-10-01). Only a finite
  // number, written by the compiler as a numeric literal, so nothing a model writes here is text, a date or a period. Without it
  // the form could spell a 0 only as a parameter, and every such parameter was a question put to the person.
  z.object({ number: z.number().finite() }),
  // ARITHMETIC on numbers (2026-10-01: "attendance below 85% of working days" had no way to be read — the form computed dates and
  // nothing else). Written without casts, so the same SQL runs on Postgres and SQLite: a division multiplies by 1.0 (never integer
  // division) and divides by NULLIF(…, 0) (a zero denominator is NULL, never an error).
  z.object({
    arith: z.object({
      op: z.enum(ARITH_OPS),
      left: z.lazy((): z.ZodTypeAny => computeNodeSchema),
      right: z.lazy((): z.ZodTypeAny => computeNodeSchema),
    }),
  }),
  // A share as a percentage: part × 100 ÷ whole (NULL when whole is 0).
  z.object({
    percent: z.object({
      part: z.lazy((): z.ZodTypeAny => computeNodeSchema),
      whole: z.lazy((): z.ZodTypeAny => computeNodeSchema),
    }),
  }),
  // A banded label: the FIRST arm whose test holds wins, else `else`. Tests are
  // single comparisons (field-vs-value/field/param via the COMPUTED_FILTER_OPS
  // vocabulary), values are compute nodes. Emits CASE WHEN — the absence-band
  // shape (hours >= 4.75 → 0.5, 0–4.74 → 1) the HR goal needs. SQLite takes the
  // same CASE WHEN (no dialect split).
  z.object({
    caseWhen: z.object({
      arms: z.array(z.object({
        op: z.enum(COMPUTED_FILTER_OPS),
        left: z.lazy((): z.ZodTypeAny => computeNodeSchema),
        right: z.lazy((): z.ZodTypeAny => computeNodeSchema),
        then: z.lazy((): z.ZodTypeAny => computeNodeSchema),
      })).min(1),
      else: z.lazy((): z.ZodTypeAny => computeNodeSchema).optional(),
    }),
  }),
]);
/** The visual spec a `query` step's operation is compiled from (plan §Phase 4). */
/**
 * Inside a summary join every column is that table's own, so `v_absence.days` in the `v_absence` summary can mean only `days`
 * (2026-10-01: a proposer wrote it three times and was refused three times by a regex). The redundant qualifier is removed — by
 * the form itself, so every reader of a stored spec sees one spelling. A qualifier naming ANOTHER table is left as written and
 * refused by name: a summary cannot read a column of a table it does not summarise.
 */
/**
 * One read, many spellings: the SAME meaning written differently is made one form before the form is checked (2026-10-03). A model
 * writing a read wrote `main.attendance_day` as a join's table, or a column as both `column` and a `compute` that is just that
 * column — each refused as a shape error, each spending one of the proposer's three attempts, and three such slips refused the whole
 * goal ("employees below the threshold for a month" on a workspace with only tables). A refusal for a spelling teaches nothing the
 * next attempt needs. Only equivalences, never a guess:
 *  - a table named with its schema (`schema.table`) where only a table goes is that table — the schema kept on `base`, which has a
 *    slot for it; resolution against the introspected schema is unchanged, ambiguity reported as it was;
 *  - a column whose `compute` is a bare column reference IS that column; one giving the same column both ways is it once.
 * A column with two DIFFERENT things, or with nothing, is still refused — that is a real ambiguity, and the form says so.
 */
export function canonicalSpec(spec: unknown): unknown {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return spec;
  const sp = { ...(spec as Record<string, unknown>) };
  const split = (t: unknown): { schema?: string; table: unknown } => {
    if (typeof t !== "string" || !t.includes(".")) return { table: t };
    const parts = t.split(".");
    return parts.length === 2 && parts[0] && parts[1] ? { schema: parts[0], table: parts[1] } : { table: t };
  };
  const bareTable = <T,>(x: T): T => {
    if (!x || typeof x !== "object") return x;
    const o = x as Record<string, unknown>;
    const s2 = split(o.table);
    return s2.schema ? ({ ...o, table: s2.table } as T) : x;
  };
  if (sp.base && typeof sp.base === "object") {
    const b = sp.base as Record<string, unknown>;
    const s2 = split(b.table);
    if (s2.schema && (b.schema === undefined || b.schema === s2.schema)) sp.base = { ...b, schema: s2.schema, table: s2.table };
  }
  for (const key of ["joins", "aggregateJoins"] as const) {
    if (Array.isArray(sp[key])) sp[key] = (sp[key] as unknown[]).map((j) => {
      const jj = bareTable(j) as Record<string, unknown> | unknown;
      if (jj && typeof jj === "object" && Array.isArray((jj as { through?: unknown }).through)) return { ...(jj as object), through: ((jj as { through: unknown[] }).through).map(bareTable) };
      return jj;
    });
  }
  if (Array.isArray(sp.columns)) sp.columns = (sp.columns as unknown[]).map((c) => {
    if (!c || typeof c !== "object") return c;
    const col = c as Record<string, unknown>;
    const cmp = col.compute as Record<string, unknown> | undefined;
    const bareRef = cmp && typeof cmp === "object" && !Array.isArray(cmp) && Object.keys(cmp).length === 1 && typeof cmp.column === "string" ? cmp.column : undefined;
    if (bareRef === undefined) return c;
    if (col.column === undefined || col.column === bareRef) { const { compute: _drop, ...rest } = col; return { ...rest, column: bareRef }; }
    return c;
  });
  return sp;
}

export function ownNamesBare(entry: unknown): unknown {
  if (!entry || typeof entry !== "object") return entry;
  const e = entry as { table?: unknown; schema?: unknown; groupBy?: unknown; aggregates?: unknown; filters?: unknown };
  if (typeof e.table !== "string") return entry;
  const own = (c: unknown) => {
    if (typeof c !== "string" || !c.includes(".")) return c;
    const parts = c.split(".");
    const [col, tbl, sch] = [parts.at(-1)!, parts.at(-2), parts.length === 3 ? parts[0] : undefined];
    return tbl === e.table && (sch === undefined || typeof e.schema !== "string" || sch === e.schema) ? col : c;
  };
  const each = (xs: unknown) => (Array.isArray(xs) ? xs.map((x) => (x && typeof x === "object" && "column" in x ? { ...x, column: own((x as { column: unknown }).column) } : x)) : xs);
  // A `through` table's own key, named with its table (`absence_type.absence_type_id` on the join to `absence_type`), is that column.
  const through = Array.isArray((e as { through?: unknown }).through)
    ? ((e as { through: unknown[] }).through).map((t) => {
      if (!t || typeof t !== "object") return t;
      const x = t as { table?: unknown; onRight?: unknown };
      if (typeof x.table !== "string" || typeof x.onRight !== "string" || !x.onRight.includes(".")) return t;
      const parts = x.onRight.split(".");
      return parts.at(-2) === x.table ? { ...x, onRight: parts.at(-1) } : t;
    })
    : (e as { through?: unknown }).through;
  return { ...e, groupBy: own(e.groupBy), aggregates: each(e.aggregates), filters: each(e.filters), ...(through !== undefined ? { through } : {}) };
}

const AGGREGATE_JOIN_OBJECT = z.object({
  table: z.string().min(1).max(255).regex(IDENTIFIER, `join table ${IDENTIFIER_MSG}`),
  /**
   * Tables the summarised rows are joined THROUGH before they are grouped (builder-stability P2-I1/P2-I3, 2026-10-02): "each
   * department and how many sick days its people took" groups absence rows by their EMPLOYEE's department — a column one join
   * away. Each is an INNER join from the summarised table or an earlier one; the group key, a measure and a filter may then name
   * a column of any of them (`employee.department_id`). Inner, so a related row with no match is not counted — the summary
   * counts rows that HAVE the key it groups by.
   */
  through: z
    .array(z.object({
      table: z.string().min(1).max(255).regex(IDENTIFIER, `through table ${IDENTIFIER_MSG}`),
      /** A column of the summarised table or an earlier `through` table. */
      onLeft: z.string().min(1).max(255).regex(COLUMN_REF, `through onLeft ${COLUMN_REF_MSG}`),
      /** A column of this table. */
      onRight: z.string().min(1).max(255).regex(IDENTIFIER, `through onRight ${IDENTIFIER_MSG}`),
    }))
    .max(3, "a summary is joined through at most 3 tables")
    .default([]),
  groupBy: z.string().min(1).max(255).regex(COLUMN_REF, `groupBy ${COLUMN_REF_MSG}`),
  /** A column of the base table or an earlier join, matched to the group key. */
  onLeft: z.string().min(1).max(255).regex(COLUMN_REF, `onLeft ${COLUMN_REF_MSG}`),
  kind: z.enum(JOIN_KINDS),
  aggregates: z
    .array(
      z.object({
        column: z.string().min(1).max(255).regex(COLUMN_REF, `column ${COLUMN_REF_MSG}`).optional(),
        /** P10 (bands, generic): aggregate over a COMPUTED value (e.g. `SUM` of a `caseWhen` band weight) — either `column` or `compute`, never both, never neither (unless `count`). */
        compute: z.lazy((): z.ZodTypeAny => computeNodeSchema).optional(),
        aggregate: z.enum(AGGREGATES),
        distinct: z.boolean().optional(),
        alias: z
          .string()
          .min(1)
          .max(255)
          .regex(IDENTIFIER, `alias ${IDENTIFIER_MSG} — it becomes the result column name`),
      }).refine((a) => a.column !== undefined || (a as { compute?: unknown }).compute !== undefined || a.aggregate === "count", {
        message: "only `count` aggregates without a column (`COUNT(*)`); every other aggregate needs a column or a computed value",
      }).refine((a) => !(a.column !== undefined && (a as { compute?: unknown }).compute !== undefined), {
        message: "an aggregate reads a column or a computed value — never both",
      }),
    )
    .min(1, "a summary join with no aggregates summarises nothing"),
  filters: z
    .array(
      z.object({
        column: z.string().min(1).max(255).regex(COLUMN_REF, `filter column ${COLUMN_REF_MSG}`),
        op: z.enum(FILTER_OPS),
        param: z.string().min(1).max(64).regex(IDENTIFIER, `param ${IDENTIFIER_MSG}`).optional(),
        /** A NUMBER the rule fixes (`hours_worked = 0`) — exactly one of `param` / `value`, as for a top-level filter. */
        value: FIXED_VALUE.optional(),
      }).refine((f) => (f.op === "is_null" || f.op === "is_not_null" ? f.param === undefined && f.value === undefined : (f.param !== undefined) !== (f.value !== undefined)), {
        message: "`is_null`/`is_not_null` bind no value so they take no `param`; every other operator takes exactly one of `param` (a supplied value) or `value` (a number the rule fixes)",
      }).refine(fixedOpOk, { message: FIXED_OP_MSG }),
    )
    .default([]),
});
/** The form of one summary join, with its own table's qualifiers removed first (`ownNamesBare`). */
const AGGREGATE_JOIN = z.preprocess(ownNamesBare, AGGREGATE_JOIN_OBJECT) as unknown as typeof AGGREGATE_JOIN_OBJECT;

export const dbOperationSpecSchema = z.object({
  base: z.object({
    /** Optional schema qualifier; resolved against the introspected schema. */
    schema: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z_][A-Za-z0-9_$]*$/, "schema must be a plain identifier")
      .optional(),
    table: z.string().min(1).max(255).regex(IDENTIFIER, `table ${IDENTIFIER_MSG}`),
  }),
  columns: z
    .array(
      z
        .object({
          /**
           * A column reference — bare, or qualified by its table (`department.name`) as `compute: { column }` always allowed: both
           * resolve through `resolveValue({ column })`, so refusing the qualified spelling here only refused a meaning the form
           * already had (2026-10-01: a read naming nine joined columns this way failed three times). Exactly one of `column` / `compute`.
           */
          column: z.string().min(1).max(255).regex(COLUMN_REF, `column ${COLUMN_REF_MSG}`).optional(),
          /** A computed expression — calendar math, fallbacks, diffs. Exactly one of `column` / `compute`. */
          compute: z.lazy((): z.ZodTypeAny => computeNodeSchema).optional(),
          aggregate: z.enum(AGGREGATES).optional(),
          /** `count(DISTINCT col)` — only with an aggregate; bare distinct rows are the top-level `distinct` flag. */
          aggregateDistinct: z.boolean().optional(),
          /** The result row's key — must be a plain identifier so the executor's
           *  output object is addressable, and unique so two columns cannot
           *  overwrite each other's value in one row. */
          alias: z
            .string()
            .min(1)
            .max(255)
            .regex(IDENTIFIER, `alias ${IDENTIFIER_MSG} — it becomes the result column name`),
        })
        .refine((c) => (c.column === undefined) !== (c.compute === undefined), {
          message: "a column selects exactly one thing: `column` for a bare reference, `compute` for an expression",
        }),
    )
    .min(1, "an operation must select at least one column"),
  joins: z
    .array(
      z.object({
        table: z.string().min(1).max(255).regex(IDENTIFIER, `join table ${IDENTIFIER_MSG}`),
        /** A column of the base table or an earlier join — the FK side. Absent
         *  only for an uncorrelated `latestOne` (a settings row, an org default):
         *  a plain join without one is a cross join, refused below. */
        onLeft: z.string().min(1).max(255).regex(COLUMN_REF, `onLeft ${COLUMN_REF_MSG}`).optional(),
        /** A column of the table being joined. Absent with `onLeft`. */
        onRight: z.string().min(1).max(255).regex(IDENTIFIER, `onRight ${IDENTIFIER_MSG}`).optional(),
        /** Further ANDed equalities for composite keys (`plan` AND `priority`):
         * same resolution as the first pair, emitted in order. */
        andOn: z
          .array(
            z.object({
              left: z.string().min(1).max(255).regex(COLUMN_REF, `left ${COLUMN_REF_MSG}`),
              right: z.string().min(1).max(255).regex(IDENTIFIER, `right ${IDENTIFIER_MSG}`),
            }),
          )
          .optional(),
        kind: z.enum(JOIN_KINDS),
        /** Latest-row lookup: `LEFT JOIN LATERAL (... ORDER BY … LIMIT n)` — the
         *  effective-date pattern (`effective_from <= $as_of` inside, newest
         *  first) without hand SQL. Conditions inside name the JOINED table's
         *  columns; the correlation (`onLeft = onRight`) is added automatically.
         *
         *  `orUnmatched` widens the correlation to `(outer = inner OR inner IS
         *  NULL)` for entity-specific-else-default lookups (a department row
         *  preferred, the org row as fallback): put the correlation column
         *  FIRST in `orderBy` ascending so matched rows sort before the null
         *  fallback. Requires the correlation — an uncorrelated fallback would
         *  match every row to the same default, which is a constant wearing a
         *  join's clothes. */
        latestOne: z
          .object({
            orderBy: z
              .array(
                z.object({
                  column: z.string().min(1).max(255).regex(IDENTIFIER, `orderBy column ${IDENTIFIER_MSG}`),
                  dir: z.enum(SORT_DIRS).optional(),
                }),
              )
              .min(1, "a latest-row lookup must say what newest means"),
            limit: z.number().int().positive().max(1000).optional(),
            orUnmatched: z.boolean().optional(),
            filters: z
              .array(
                z.object({
                  column: z.string().min(1).max(255).regex(IDENTIFIER, `filter column ${IDENTIFIER_MSG}`),
                  op: z.enum(FILTER_OPS),
                  param: z
                    .string()
                    .min(1)
                    .max(64)
                    .regex(IDENTIFIER, `param ${IDENTIFIER_MSG}`)
                    .optional(),
                  /** Bound against an OUTER column instead of a supplied value —
                   *  for lookups keyed by the row itself (`effective_from <=
                   *  claim_date`). Exactly one of `param` / `outerColumn`; the
                   *  outer side resolves against the base and earlier joins. */
                  outerColumn: z.string().min(1).max(255).regex(COLUMN_REF, `outerColumn ${COLUMN_REF_MSG}`).optional(),
                }).refine((f) => (f.op === "is_null" || f.op === "is_not_null" ? f.param === undefined && f.outerColumn === undefined : (f.param === undefined) !== (f.outerColumn === undefined) && (f.op !== "month" || f.outerColumn === undefined)), {
                  message: "`is_null`/`is_not_null` bind nothing; every other operator takes exactly one of `param` (a supplied value) or `outerColumn` (the row's own column); `month` reads a supplied date, so it takes `param` only",
                }),
              )
              .default([]),
          })
          .optional(),
      }),
    )
    .default([]),
  /** Grouped summary joins: `LEFT JOIN (SELECT key, SUM… GROUP BY key)`.
   *
   * The per-entity totals pattern (paid per invoice, spend per cost centre):
   * a plain join would fan the base rows out before aggregating, so the sums
   * are computed inside, grouped by `groupBy`, and the outer query joins the
   * one-summary-row-per-key result like any other table. Inner filters take
   * supplied values only — a correlated aggregate is a lateral, not this.
   * A `count` with no column counts rows (`COUNT(*)`); any other aggregate
   * needs one. Exposed under the group key's own name plus the aliases. */
  aggregateJoins: z
    .array(
      AGGREGATE_JOIN,
    )
    .default([]),
  filters: z
    .array(
      z
        .object({
          /** The column compared — or `compute`, a calculated value (exactly one of the two). */
          column: z.string().min(1).max(255).regex(COLUMN_REF, `filter column ${COLUMN_REF_MSG}`).optional(),
          /** A calculated value compared with the parameter: "attendance %" below a threshold. Comparisons only. */
          compute: z.lazy((): z.ZodTypeAny => computeNodeSchema).optional(),
          op: z.enum(FILTER_OPS),
          /** Names a parameter in `params_schema`, bound positionally in filter order. Absent for `is_null`/`is_not_null` — there is no value to bind. */
          param: z
            .string()
            .min(1)
            .max(64)
            .regex(IDENTIFIER, `param ${IDENTIFIER_MSG}`)
            .optional(),
          /**
           * A NUMBER the rule fixes, compared instead of a supplied parameter (`is_working_day = 1`, `hours_worked = 0`). Exactly one
           * of `param` / `value`. Never for a value the person states — that stays a parameter (the builder refuses it, `readWriter`).
           */
          value: FIXED_VALUE.optional(),
          /**
           * ANOTHER column of the same rows, compared instead of a value (2026-10-02): "the latest reading is above its class's
           * maximum" — both sides are columns the rows already carry, so neither is a parameter nor a constant. Comparisons only.
           */
          against: z.string().min(1).max(255).regex(COLUMN_REF, `filter against ${COLUMN_REF_MSG}`).optional(),
          /** Filters sharing a group are ORed inside one parenthesised term; terms are ANDed. Absent ⇒ its own AND term. */
          orGroup: z
            .string()
            .min(1)
            .max(64)
            .regex(IDENTIFIER, `orGroup ${IDENTIFIER_MSG}`)
            .optional(),
        })
        .refine((f) => (f.op === "is_null" || f.op === "is_not_null" ? f.param === undefined && f.value === undefined && f.against === undefined : [f.param, f.value, f.against].filter((x) => x !== undefined).length === 1), {
          message: "`is_null`/`is_not_null` bind no value so they take no `param`; every other operator takes exactly one of `param` (a supplied value), `value` (a number the rule fixes) or `against` (another column of the same rows)",
        })
        .refine(fixedOpOk, { message: FIXED_OP_MSG })
        .refine((f) => f.against === undefined || (COMPUTED_FILTER_OPS as readonly string[]).includes(f.op), { message: `a column compared with another column takes one of ${COMPUTED_FILTER_OPS.join(", ")}` })
        .refine((f) => (f.column === undefined) !== (f.compute === undefined), { message: "a filter compares exactly one of `column` or `compute`" })
        .refine((f) => f.compute === undefined || (COMPUTED_FILTER_OPS as readonly string[]).includes(f.op), {
          message: `a filter on a computed value compares it: op is one of ${COMPUTED_FILTER_OPS.join(", ")}`,
        }),
    )
    .default([]),
  /** Post-aggregation filters — `HAVING`, for conditions on an aggregate that `WHERE` cannot state. Requires an aggregated column in the select list. */
  having: z
    .array(
      z.object({
        column: z.string().min(1).max(255).regex(COLUMN_REF, `having column ${COLUMN_REF_MSG}`),
        aggregate: z.enum(AGGREGATES),
        op: z.enum(HAVING_OPS),
        param: z
          .string()
          .min(1)
          .max(64)
          .regex(IDENTIFIER, `param ${IDENTIFIER_MSG}`),
      }),
    )
    .default([]),
  /** Deduplicate result rows. Off by default — `DISTINCT` changes row counts, so it must be asked for. */
  distinct: z.boolean().optional(),
  sort: z
    .array(
      z.object({
        column: z.string().min(1).max(255).regex(COLUMN_REF, `sort column ${COLUMN_REF_MSG}`),
        dir: z.enum(SORT_DIRS),
      }),
    )
    .default([]),
  limit: z.number().int().positive().max(1_000_000).optional(),
});

export type DbOperationSpec = z.infer<typeof dbOperationSpecSchema>;

/**
 * What a caller may hand the compiler WITHOUT going through `.parse()`: the
 * zod `default([])`s only apply on parse, and `compileOperation` normalises
 * the optional arrays itself — so the accepted type is the INPUT shape.
 */
export type DbOperationSpecInput = z.input<typeof dbOperationSpecSchema>;

/** Create — a saved operation needs the name that IS its ref. */
export const dbOperationBodySchema = z.object({
  name: z
    .string()
    .min(1)
    .max(255)
    .regex(IDENTIFIER, `name ${IDENTIFIER_MSG} — a step ref is "<datasource>.<operation>"`),
  description: z.string().max(10_000).optional(),
  spec: dbOperationSpecSchema,
  /**
   * WHAT EACH PARAMETER MEANS, in a person's words — 2026-09-08.
   *
   * ⚠ **The derived description is not enough, and this is I-126 again.** A
   * filter's description is generated as `"lt filter on public.invoices.due_date"`,
   * which is true and tells a drafting model nothing about the VALUE: whether
   * `as_of` is `2026-06` or `2026-06-30` is exactly the choice I-126 was
   * written about, and it is what produced `"{{ inputs.period }}-31"` on a
   * flow that then died on June 31st. A named query has carried real prose for
   * every parameter since I-126; an operation had no field for it.
   *
   * Keyed by param name, overlaid onto the derived map — so the TYPE and the
   * REQUIRED flag stay derived from the spec (a caller must not be able to
   * relabel a date as a string) and only the sentence is authored. A key naming
   * no parameter is ignored rather than refused: a spec edit that drops a
   * filter should not make every later save fail.
   */
  paramDescriptions: z.record(z.string().min(1).max(500)).optional(),
  /**
   * compiled-builder D-323: a value the catalogue STATES for a parameter ("Use 'prod'"), as data. The builder binds it
   * when the person said nothing about that parameter, with provenance `catalogue`. Keyed like `paramDescriptions` and
   * overlaid the same way; a default that does not fit the parameter's derived type is REFUSED (400), never stored.
   */
  paramDefaults: z.record(z.string().min(1).max(200)).optional(),
  /**
   * The SHAPE of string a parameter takes — `month`, `date` — where the column it filters is typed as text (a `period`
   * stored as `YYYY-MM`). Keyed and overlaid like the others; a format on a parameter that is not a string is REFUSED (400).
   */
  paramFormats: z.record(z.enum(PARAM_FORMATS)).optional(),
});

/** Update — rename is a delete plus a create (the name IS the ref). A PATCH
 *  replaces the whole spec as one unit; partial spec merging would be a
 *  half-edited shape nobody reviewed. */
export const dbOperationUpdateSchema = z.object({
  description: z.string().max(10_000).optional(),
  spec: dbOperationSpecSchema.optional(),
  /** See `dbOperationBodySchema.paramDescriptions`. */
  paramDescriptions: z.record(z.string().min(1).max(500)).optional(),
  /** See `dbOperationBodySchema.paramDefaults`. Absent keeps what is stored. */
  paramDefaults: z.record(z.string().min(1).max(200)).optional(),
  /** See `dbOperationBodySchema.paramFormats`. Absent keeps what is stored. */
  paramFormats: z.record(z.enum(PARAM_FORMATS)).optional(),
});

// ── compile ──────────────────────────────────────────────────────────────────

export type OperationFindingCode =
  | "schema_not_introspected"
  | "against_type"
  | "unknown_table"
  | "unknown_column"
  | "invalid_alias"
  | "duplicate_alias"
  | "invalid_join"
  | "invalid_compute"
  | "having_without_aggregate"
  | "distinct_without_aggregate"
  | "shape"
  | "sqlite_dialect"
  | "constant_type"
  /** Aggregate / synthetic result with no type — would become Opaque and `add_reader` refuses (P7). */
  | "untyped_aggregate"
  | "untyped_output";

export interface OperationCompileFinding {
  code: OperationFindingCode;
  message: string;
  /** The offending identifier, when there is one. */
  identifier?: string;
  /** What the author COULD have used — the available tables or columns. */
  available?: string[];
}

export interface CompiledOperation {
  /** Read-only SELECT, positional $1..$n. */
  sql: string;
  /** Flat `{param: {type, required, description}}` map, tool-params vocabulary. */
  paramsSchema: Record<string, unknown>;
  /** Unique param names in first-occurrence filter order — index i → $\{i+1\}. */
  paramOrder: string[];
  /**
   * Every result column with **where it came from** — FR-011's `customer_name ←
   * customers.name (text)`. Additive, and derived from data this function has
   * already resolved: nothing here re-reads the schema or re-parses the SQL.
   *
   * ⚠ `source` is the **qualified table name**, never the `t0`/`t1` SQL alias.
   * `t1.name` is meaningless to the person approving this; `customers.name` is
   * the entire point, because it is the half of the provenance they can check
   * against their own database.
   *
   * ⚠ `type` is the **source column's** introspected type, and where a column is
   * aggregated `source` says so — `count(invoices.id)`. The result type of an
   * aggregate is dialect-specific (`count` → `bigint`, `sum(integer)` →
   * `bigint`, `avg` → `numeric`) and inferring it would put a second dialect
   * model into a module that has none. So the reviewer is told which column was
   * summarised and what THAT column is, which is the checkable fact; a surface
   * rendering this must not present the type as the output's type.
   */
  outputColumns: Array<{ alias: string; source: string; type: string | null; nullable?: boolean; unit?: "minutes" | "business_minutes" | "days" }>;
  /**
   * compiled-builder I-301: the column an EQUALITY filter's parameter is compared with (`eq`, `neq`, `in`) — so the parameter
   * can be typed by that column's value domain. Additive; not part of `paramsSchema`, which is hashed into fingerprints.
   */
  paramColumns?: Record<string, { schema: string | null; table: string; column: string }>;
  /** The comparison each of those parameters' filters makes (`eq`, `neq`, `in`) — only an `eq` SELECTS the rows equal to it. Additive. */
  paramOps?: Record<string, "eq" | "neq" | "in">;
  /** Which end of a range each parameter a range operator reads is (`ParamEdge`). */
  paramEdges?: Record<string, ParamEdge>;
  /**
   * Bare column names that more than one joined table could have meant, with
   * the table that won. Empty on the overwhelming majority of operations.
   *
   * ⚠ **A review surface must render this.** It is not a warning about the SQL,
   * which is correct and deterministic; it is the record of a CHOICE the
   * compiler made on the author's behalf, and the only place a person can
   * disagree with it. The fix it points at is the qualified spelling
   * (`COLUMN_REF`), so the finding and its remedy are the same feature.
   *
   * ⚠ It is deliberately NOT a finding: findings are thrown, and joining on
   * `id` or `status` is the ordinary case rather than the pathological one — a
   * refusal here would reject most correct operations in the product on the day
   * it shipped, which is the control everybody routes around (D-52).
   */
  ambiguousColumns: ColumnAmbiguity[];
}

/**
 * One entity from the introspected `schemas` rows, with its columns.
 */
interface ResolvedEntity {
  schema: string | null;
  name: string;
  entityType: string;
  /** columnName → introspected type (information_schema data_type). */
  columns: Map<string, string | null>;
  /**
   * Columns that may be NULL on their own (introspected `nullable`, or an aggregate other than `count` on a synthetic
   * totals owner). Absent ⇒ every column is taken as nullable, which is the safe direction. Read by `outputColumns`.
   */
  nullable?: Set<string>;
}

function indexSchema(schemaRows: SchemaRow[]): ResolvedEntity[] {
  const byKey = new Map<string, ResolvedEntity>();
  for (const r of schemaRows) {
    const key = `${r.entitySchema ?? ""}:${r.entityName}`;
    let e = byKey.get(key);
    if (!e) {
      e = {
        schema: r.entitySchema ?? null,
        name: r.entityName,
        entityType: r.entityType,
        columns: new Map(),
        nullable: new Set(),
      };
      byKey.set(key, e);
    }
    if (r.columnName != null) {
      e.columns.set(r.columnName, r.columnType ?? null);
      // ⚠ Nullable unless the schema says NOT NULL: an unknown is treated as nullable (compiled-builder E0.7 G5).
      if (r.nullable !== false) e.nullable!.add(r.columnName);
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const as = a.schema ?? "";
    const bs = b.schema ?? "";
    if (as !== bs) return as < bs ? -1 : 1;
    return a.name < b.name ? -1 : 1;
  });
}

/** SQL-quote an identifier — never interpolated unquoted. */
const q = (ident: string) => `"${ident}"`;

/** `"schema"."table"` when the entity is schema-qualified, else `"table"`. */
function qEntity(e: Pick<ResolvedEntity, "schema" | "name">): string {
  return e.schema ? `${q(e.schema)}.${q(e.name)}` : q(e.name);
}

function qualifiedTableList(entities: ResolvedEntity[]): string[] {
  return entities.map((e) => (e.schema ? `${e.schema}.${e.name}` : e.name));
}

const AVAILABLE_CAP = 50;

/**
 * Resolve a table reference against the introspected schema.
 *
 * `schemaHint` absent → prefer the default schema (NULL, then `public`), so a
 * spec written against a single-schema datasource never has to name the schema.
 * `schemaHint` present → exact match on the schema name.
 *
 * Findings are PUSHED (not thrown) so a compile can report every problem at
 * once — the same "one 400 per rule" reasoning as `checkSqlShape`.
 */
function resolveTable(
  schemaHint: string | undefined,
  table: string,
  entities: ResolvedEntity[],
  findings: OperationCompileFinding[],
): ResolvedEntity | undefined {
  if (entities.length === 0) {
    findings.push({
      code: "schema_not_introspected",
      message:
        "this datasource has no introspected schema, so no table or column can be resolved. " +
        "Run the schema refresh first, then compile again",
      identifier: schemaHint ? `${schemaHint}.${table}` : table,
      available: [],
    });
    return undefined;
  }
  const candidates = entities.filter((e) => e.name === table);
  if (schemaHint !== undefined) {
    const exact = candidates.find((e) => e.schema === schemaHint);
    if (!exact) {
      findings.push({
        code: "unknown_table",
        message: `no table "${table}" in schema "${schemaHint}" — every identifier must resolve against the introspected schema`,
        identifier: `${schemaHint}.${table}`,
        available: qualifiedTableList(entities).slice(0, AVAILABLE_CAP),
      });
      return undefined;
    }
    return exact;
  }
  if (candidates.length === 0) {
    findings.push({
      code: "unknown_table",
      message: `no table "${table}" in the introspected schema — every identifier must resolve against the introspected schema`,
      identifier: table,
      available: qualifiedTableList(entities).slice(0, AVAILABLE_CAP),
    });
    return undefined;
  }
  // Multiple schemas have a table with this name; the DEFAULT schema wins,
  // deterministically. A spec that means another one must name it.
  const ranked = [...candidates].sort((a, b) => {
    const rank = (e: ResolvedEntity) => (e.schema === null ? 0 : e.schema === "public" ? 1 : 2);
    return rank(a) - rank(b);
  });
  return ranked[0];
}

/** `schema.table` when the entity is schema-qualified, else `table` — unquoted,
 *  for messages and for matching an authored qualifier. */
function plainEntityName(e: Pick<ResolvedEntity, "schema" | "name">): string {
  return e.schema ? `${e.schema}.${e.name}` : e.name;
}

/**
 * A bare column name that more than one table in the chain could have meant.
 *
 * ⚠ **This is RECORDED, never refused, and the asymmetry is the decision.**
 * `resolveColumn` has always let the first owner win, and joining on `id`,
 * `status` or `created_at` is the ordinary case rather than the pathological
 * one — so a refusal would reject most correct specs in the product on the day
 * it shipped, which is the shape D-52 refuses ("a day-one refusal is a control
 * everybody routes around"). It is also not a finding for a second reason:
 * findings are thrown (`throw compileError(findings)`), so there is no
 * "finding that does not refuse" channel in this module.
 *
 * What was actually wrong was that the choice was **invisible**. Two tables
 * sharing a column name gives the wrong one silently, and nothing anywhere
 * said a choice had been made. This carries that choice out to the review
 * surface, where a person can disagree with it.
 */
export interface ColumnAmbiguity {
  /** The bare name as the spec wrote it. */
  column: string;
  /** The owner that won — `schema.table` or `table`. */
  resolvedTo: string;
  /** Every other table in the chain that also has this column, in chain order. */
  alsoOn: string[];
}

/**
 * One entry per ambiguous column, not per place it was read.
 *
 * ⚠ **Found by MEASURING, not by reading.** `resolveColumn` pushes once per
 * call, so a column used in a filter AND a sort was recorded twice — and
 * `ambiguity:measure` printed `status`, `cve` and `id` twice each on real saved
 * operations before this existed. On the review surface that is noise in the one
 * place a person is being asked to concentrate, and noise is how a reader learns
 * to skim past the entry that mattered.
 *
 * Keyed on **column AND winner**, never the column alone: the same name can
 * legitimately resolve to different owners in different clauses once qualifiers
 * are in play, and collapsing those would hide a real disagreement. `alsoOn` is
 * unioned so nothing is lost by merging.
 */
function dedupeAmbiguities(raw: ColumnAmbiguity[]): ColumnAmbiguity[] {
  const byKey = new Map<string, ColumnAmbiguity>();
  for (const a of raw) {
    const key = `${a.column}\u0000${a.resolvedTo}`;
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { ...a, alsoOn: [...a.alsoOn] });
      continue;
    }
    for (const t of a.alsoOn) if (!seen.alsoOn.includes(t)) seen.alsoOn.push(t);
  }
  return [...byKey.values()];
}

/**
 * Resolve a column against a chain of tables (base first, then joins in order).
 *
 * **Bare name** — the FIRST table that has the column owns it, base before a
 * join that happens to share a column name, deterministically. ⚠ Deterministic
 * is not the same as correct: where more than one owner has the name, the
 * choice is pushed to `ambiguities` so the review surface can show it. See
 * `ColumnAmbiguity`.
 *
 * **Qualified name** — `table.column` or `schema.table.column` names the owner
 * outright, which is what makes the ambiguity above ACTIONABLE. A gap that can
 * be seen and not fixed is half a feature, so the two halves ship together.
 *
 * ⚠ **The whole string is tried as a bare name FIRST**, and that order is
 * load-bearing rather than tidy: a Postgres column may legally contain a dot
 * (`"a.b"`), and every spec written before qualifiers existed used bare names
 * only. Splitting first would reinterpret an existing, working identifier.
 * So this cannot change the meaning of any spec that compiles today — the
 * qualified branch is reached only where the bare branch found nothing.
 *
 * ⚠ A qualifier naming a table that is NOT in the chain is a **finding**, not a
 * fallback to bare resolution. That is a typo or a missing join, and both are
 * things a person can fix; silently resolving it somewhere else would be the
 * defect this function exists to stop, arriving through the fix for it.
 */
function resolveColumn(
  column: string,
  owners: ResolvedEntity[],
  findings: OperationCompileFinding[],
  ambiguities: ColumnAmbiguity[],
): { owner: ResolvedEntity; column: string; columnType: string | null } | undefined {
  const holders = owners.filter((o) => o.columns.has(column));
  if (holders.length > 0) {
    const owner = holders[0]!;
    if (holders.length > 1) {
      ambiguities.push({
        column,
        resolvedTo: plainEntityName(owner),
        alsoOn: holders.slice(1).map(plainEntityName),
      });
    }
    return { owner, column, columnType: owner.columns.get(column) ?? null };
  }

  // No owner has the literal string. Only now read it as a qualified name.
  const dot = column.lastIndexOf(".");
  if (dot > 0 && dot < column.length - 1) {
    const qualifier = column.slice(0, dot);
    const bare = column.slice(dot + 1);
    const named = owners.filter((o) => o.name === qualifier || plainEntityName(o) === qualifier);
    if (named.length === 0) {
      findings.push({
        code: "unknown_column",
        message: `"${column}" names table "${qualifier}", which this operation does not read — it reads ${owners
          .map(plainEntityName)
          .join(", ")}`,
        identifier: column,
        available: owners.map(plainEntityName).slice(0, AVAILABLE_CAP),
      });
      return undefined;
    }
    const holder = named.find((o) => o.columns.has(bare));
    if (!holder) {
      findings.push({
        code: "unknown_column",
        message: `no column "${bare}" on ${named.map(plainEntityName).join(", ")} — every identifier must resolve against the introspected schema`,
        identifier: column,
        available: [...new Set(named.flatMap((o) => [...o.columns.keys()]))].slice(0, AVAILABLE_CAP),
      });
      return undefined;
    }
    // ⚠ The BARE name is returned, never the authored `table.column`. Every
    // caller stores what it gets back, so no emission site can quote
    // `"t0"."invoices.status"` — which is not a column and would fail at the
    // database rather than here. Normalising once beats correcting ten sites.
    return { owner: holder, column: bare, columnType: holder.columns.get(bare) ?? null };
  }

  findings.push({
    code: "unknown_column",
    message: `no column "${column}" on ${owners
      .map(plainEntityName)
      .join(", ")} — every identifier must resolve against the introspected schema`,
    identifier: column,
    available: [
      ...new Set(owners.flatMap((o) => [...o.columns.keys()])),
    ].slice(0, AVAILABLE_CAP),
  });
  return undefined;
}

/** The SQL operator a filter op compiles to. `in` is `= ANY($n)` so an empty
 *  array is a legal (empty) match and the value stays a single parameter. */
function opSql(op: (typeof FILTER_OPS)[number] | (typeof HAVING_OPS)[number]): string {
  switch (op) {
    case "eq":
      return "=";
    case "neq":
      return "<>";
    case "gt":
      return ">";
    case "gte":
      return ">=";
    case "lt":
      return "<";
    case "lte":
      return "<=";
    case "in":
      return "= ANY";
    case "like":
      return "LIKE";
    case "ilike":
      return "ILIKE";
    case "is_null":
    case "is_not_null":
      throw new Error(`opSql called for parameterless operator "${op}" — null ops emit IS [NOT] NULL, never a placeholder`);
    case "month":
      throw new Error(`opSql called for "month" — it emits date_trunc/to_date with its own placeholder, never a bare operator`);
  }
}

/**
 * Month matching — "the row's date falls in the month of the supplied DATE" (2026-10-01).
 *
 * The parameter is a DATE (any day of the month means that month), and the SQL reads only its first seven characters, so a full
 * date (`2026-08-15`) and a month written as `2026-08` — which flows saved before this pass still pass — both mean August. One
 * kind of time input, compared at the granularity the FILTER declares; never a second string format a person must match.
 *
 * The COLUMN side follows the column's declared type: a date or a timestamp is truncated to its month (where an index can serve
 * it), and anything else — a text column holding `YYYY-MM` or `YYYY-MM-DD` — compares its first seven characters. Both forms are
 * rewritten for SQLite by `toSqlite`, by exactly these shapes.
 */
function monthCond(qual: string, position: number | undefined, columnType: string | null | undefined): string {
  const param = `left($${position}::text, 7)`;
  return /^(date|timestamp)/i.test(columnType ?? "")
    ? `date_trunc('month', ${qual}::date) = to_date(${param}, 'YYYY-MM')`
    : `left(${qual}::text, 7) = ${param}`;
}

/**
 * What the `month` operator's parameter IS, declared by the operator itself: a DATE compared by its month (`per: "month"`) — so it
 * is typed a date the person may name as a month ("August 2026", "the month it runs"), never free text, and never a `YYYY-MM`
 * string with a format to get wrong.
 */
const formatFor = (op: string): { format?: "date"; per?: "month" } => (op === "month" ? { format: "date", per: "month" } : {});

/** Derive the manifest-facing parameter type from the introspected column type.
 *  Best effort — anything unrecognised is a string. An `in` filter takes an
 *  array, which the tool params vocabulary explicitly supports. */
function paramTypeFor(columnType: string | null, op: (typeof FILTER_OPS)[number] | (typeof HAVING_OPS)[number]): string {
  if (op === "in") return "array";
  if (op === "month") return "string";
  const t = (columnType ?? "").toLowerCase();
  // ⚠ The integer family is `integer`, not `number` (phased-typed-build phase 4,
  // found on O2): a `number` param derives a FLOAT flow input, Kestra renders a
  // FLOAT 80 as `80.0`, and Postgres refuses `"80.0"` for an integer column — a
  // green check and a failed run. Only a column that can hold a fraction is `number`.
  if (/^(smallint|integer|bigint|serial|bigserial|int2|int4|int8)\b/.test(t)) return "integer";
  if (/^(numeric|decimal|real|double precision|float4|float8)\b/.test(t)) return "number";
  if (/^boolean?\b/.test(t)) return "boolean";
  if (/^(date|time|timestamp)\b/.test(t)) return "date";
  return "string";
}

/**
 * The parameter names in BINDING order — `latestOne` inner conditions first,
 * then summary joins, then `filters[]`, then `having` — because
 * `compileOperation` numbers `$n` positions in exactly that encounter order.
 *
 * ⚠ **One implementation, three readers** (the executor, the manifest's
 * `refInterfaces`, and the catalogue renderer): positional order lives in the
 * compiled SQL's `$1..$n`, and every other record of it — the spec arrays
 * here, the jsonb `params_schema` nowhere — must agree with that. Reading
 * `spec.filters` alone silently drops lateral, summary-join and
 * post-aggregation params, which binds short and fails at the database with
 * a count mismatch.
 */
/** Which END of a range a parameter is — the operator that reads it, and whether that end is inclusive. */
export type ParamEdge = "ge" | "gt" | "le" | "lt";

export function specParamOrder(specJson: unknown): string[] {
  // The walk below replays `compileOperation`'s encounter order — laterals,
  // summary joins, select-list expressions, filters, having — because positions
  // are numbered in that order and every reader of this list binds by position.
  type LooseFilter = { param?: string; compute?: LooseNode };
  type LooseNode = unknown;
  // Every parameter inside a computed value, in the order the compiler meets them: depth first, in each node's own key order
  // ({arith: {op, left, right}} → left, then right). Generic, so a new kind of computed value cannot drop its parameters from the
  // order (greatest/least/businessMinutes were walked by nobody until 2026-10-01).
  const paramsIn = (node: LooseNode, out: string[]): void => {
    if (node === undefined || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const x of node) paramsIn(x, out); return; }
    if (typeof (node as { param?: unknown }).param === "string") { out.push((node as { param: string }).param); return; }
    for (const v of Object.values(node as Record<string, unknown>)) paramsIn(v, out);
  };
  const spec = (specJson ?? {}) as {
    filters?: LooseFilter[];
    having?: LooseFilter[];
    joins?: Array<{ latestOne?: { filters?: LooseFilter[] } }>;
    aggregateJoins?: Array<{ filters?: LooseFilter[] }>;
    columns?: Array<{ compute?: LooseNode }>;
  };
  const inOrder: string[] = [];
  for (const j of Array.isArray(spec.joins) ? spec.joins : []) {
    for (const f of j.latestOne?.filters ?? []) if (f.param !== undefined) inOrder.push(f.param);
  }
  for (const j of Array.isArray(spec.aggregateJoins) ? spec.aggregateJoins : []) {
    for (const f of j.filters ?? []) if (f.param !== undefined) inOrder.push(f.param);
  }
  for (const c of Array.isArray(spec.columns) ? spec.columns : []) paramsIn(c.compute, inOrder);
  for (const f of [...(spec.filters ?? []), ...(spec.having ?? [])]) {
    paramsIn(f.compute, inOrder); // a computed filter's own parameters come first, as the compiler resolves them first
    if (f.param !== undefined) inOrder.push(f.param);
  }
  // P10: computed aggregates resolve at emission (after all resolution-time positions) — walked last to match.
  for (const j of Array.isArray((spec as { aggregateJoins?: Array<{ aggregates?: Array<{ compute?: LooseNode }> }> }).aggregateJoins) ? (spec as { aggregateJoins?: Array<{ aggregates?: Array<{ compute?: LooseNode }> }> }).aggregateJoins! : []) {
    for (const a of j.aggregates ?? []) paramsIn(a.compute, inOrder);
  }
  return [...new Set(inOrder)];
}

/**
 * Compile a `DbOperationSpec` against the introspected `schemas` rows.
 *
 * Pure — no database access — so the authoring UI can preview from a check
 * route and tests can pin the emitted SQL. Throws an error carrying
 * `{ statusCode: 400, findings }` on the first unresolvable identifier or
 * shape problem; `findings` is an array of `OperationCompileFinding` with the
 * offending identifier and what was available instead.
 */

/**
 * The SQL dialect the compiled statement runs on. `postgres` (the default) is what every stored statement was written in; `sqlite`
 * spells each COMPUTED value natively (2026-10-04: a read for a SQLite datasource used "days between" — `(b::date - a::date)` — and
 * `toSqlite` rightly refused it, so a valid read could never be written there). Filters keep their Postgres spellings: `toSqlite`
 * rewrites those exactly. A construct with no faithful SQLite spelling is a FINDING here, named, never an approximation.
 */
export type SqlDialect = "postgres" | "sqlite";
/**
 * The parameter a read written for a goal names for "the moment it runs" (`read-contract.ts` RUN_PARAMS) — an INSTANT wherever it is
 * used: inside a computed value, or a filter's parameter on a timestamp column ("ends after now"). Typed an instant here, never cut to
 * its day (2026-10-04: "open for more than 30 minutes" could not be written — a filter's parameter on a timestamp typed a date).
 */
export const RUN_TIME_PARAM = "run_time";
/** The dialect of a datasource type — `sqlite` for a SQLite file, else Postgres (MySQL's own path is unchanged). */
export const dialectOf = (datasourceType: string | null | undefined): SqlDialect => (/^sqlite/i.test(datasourceType ?? "") ? "sqlite" : "postgres");

export function compileOperation(
  spec: DbOperationSpecInput,
  schemaRows: SchemaRow[],
  opts: { dialect?: SqlDialect } = {},
): CompiledOperation {
  const lite = opts.dialect === "sqlite";
  // A column compared with the run's instant: on SQLite both as julian days — its timestamps are text ("2026-10-04 09:00:00") and the
  // instant is ISO ("2026-10-04T09:00:00Z"), which compare wrongly as text. Elsewhere the plain comparison.
  const vsParam = (qual: string, op: (typeof FILTER_OPS)[number], position: number | undefined, param: string | undefined) =>
    lite && param === RUN_TIME_PARAM ? `julianday(${qual}) ${opSql(op)} julianday($${position})` : `${qual} ${opSql(op)} $${position}`;
  const findings: OperationCompileFinding[] = [];
  // ⚠ Collected, never thrown. `findings` refuses the compile; this reports a
  // choice the compile MADE. See `ColumnAmbiguity` for why the two are
  // different channels rather than one severity field.
  const ambiguities: ColumnAmbiguity[] = [];
  const entities = indexSchema(schemaRows);

  // Zod's `.default([])` only applies on `.parse()`, and this pure function is
  // called directly (check route parses, but tests and the executor's tooling
  // may not) — tolerate the optional arrays being absent rather than crashing
  // on an author's partial spec.
  const joins = spec.joins ?? [];
  const filters = spec.filters ?? [];
  const having = spec.having ?? [];
  const sort = spec.sort ?? [];
  const base = resolveTable(spec.base.schema, spec.base.table, entities, findings);
  if (!base) throw compileError(findings);

  // Resolve every join FIRST: a column of a joined table is referenceable from
  // `columns`/`filters`/`sort` regardless of declaration order, and a later
  // join may chain onto an earlier one.
  //
  // Positions are numbered in encounter order — a `latestOne` lookup's inner
  // conditions come before the outer filters, then having — so the numbering
  // state lives above all three loops.
  const paramOrder: string[] = [];
  const positionOf = new Map<string, number>();
  /** The type of every parameter a COMPUTATION holds, noted where it is allocated — so one that no list below describes still is. */
  const computeParamType = new Map<string, string>();
  const takePosition = (param: string): number => {
    const known = positionOf.get(param);
    if (known !== undefined) return known;
    const position = paramOrder.length + 1;
    positionOf.set(param, position);
    paramOrder.push(param);
    return position;
  };
  const resolvedJoins: Array<{
    table: ResolvedEntity;
    kind: (typeof JOIN_KINDS)[number];
    onLeftOwner?: ResolvedEntity;
    onRight?: string;
    onLeft?: string;
    andOn: Array<{ leftOwner: ResolvedEntity; left: string; right: string }>;
    latestOne?: {
      orderBy: Array<{ column: string; dir: (typeof SORT_DIRS)[number] }>;
      limit: number;
      orUnmatched: boolean;
      inner: Array<{ owner: ResolvedEntity; column: string; op: (typeof FILTER_OPS)[number]; param?: string; outerOwner?: ResolvedEntity; outerColumn?: string; position?: number }>;
    };
  }> = [];
  const owners = [base];
  /**
   * Owners on the NULLABLE side of a LEFT JOIN (plain, `latestOne` lateral, or grouped summary): an unmatched row reads
   * every one of their columns as NULL, whatever the column's own NOT NULL says (compiled-builder E0.7 G5).
   */
  const outerOwners = new Set<ResolvedEntity>();
  for (const j of joins) {
    const joined = resolveTable(undefined, j.table, entities, findings);
    if (!joined) continue; // finding already pushed; keep reporting the rest
    // ⚠ A table already in the chain (a self-join: employees → their manager, also
    // an employee). Every occurrence of one table resolves to ONE entity, and SQL
    // aliases are keyed by entity, so both occurrences got the same alias and the
    // statement was invalid SQL (`table name "t2" specified more than once`, phase 7
    // R03). Nor could a column name either occurrence: the spec has no per-join
    // alias. Refused by name until the spec can say which occurrence it means.
    if (owners.includes(joined)) {
      findings.push({
        code: "invalid_join",
        message:
          `join "${j.table}" joins a table that is already in this operation — a self-join (for example ` +
          `a row and its parent row in the same table) cannot be expressed: the spec has no way to say ` +
          `which occurrence a column comes from. Read the table in two steps and join them in a transform`,
        identifier: j.table,
      });
      continue;
    }
    // A plain join without a correlation is a cross join — refused. A
    // `latestOne` without one is a deliberate cross-apply (a settings row, an
    // org default); half a correlation is a typo either way.
    const correlated = j.onLeft !== undefined || j.onRight !== undefined;
    if (correlated && (j.onLeft === undefined || j.onRight === undefined)) {
      findings.push({
        code: "invalid_join",
        message: `join "${j.table}" names only half a correlation — supply both \`onLeft\` and \`onRight\`, or neither for an uncorrelated \`latestOne\``,
        identifier: j.table,
      });
      continue;
    }
    if (!correlated && !j.latestOne) {
      findings.push({
        code: "invalid_join",
        message: `join "${j.table}" has no correlation and is not a \`latestOne\` lookup — a plain join without one reads every combination of both tables`,
        identifier: j.table,
      });
      continue;
    }
    const onLeft = j.onLeft === undefined ? undefined : resolveColumn(j.onLeft, owners, findings, ambiguities);
    const onRight = j.onRight === undefined ? undefined : resolveColumn(j.onRight, [joined], findings, ambiguities);
    if ((j.onLeft !== undefined && !onLeft) || (j.onRight !== undefined && !onRight)) continue;
    // A latest-row lookup resolves its inner conditions against the JOINED
    // table only — the correlation pins the outer side, so anything else
    // inside would be a second opinion about which rows are "latest". An
    // `outerColumn` bound names an OUTER column instead of a supplied value,
    // for lookups keyed by the row itself.
    let latestOne: (typeof resolvedJoins)[number]["latestOne"];
    if (j.latestOne) {
      if ((j.andOn ?? []).length > 0) {
        findings.push({
          code: "invalid_join",
          message: `join "${j.table}" pairs a composite key with a latest-row lookup — put the extra equalities in the lookup's own filters instead`,
          identifier: j.table,
        });
        continue;
      }
      if (j.latestOne.orUnmatched && !correlated) {
        findings.push({
          code: "invalid_join",
          message: `join "${j.table}" asks for an unmatched fallback with no correlation — the fallback only means something beside a match`,
          identifier: j.table,
        });
        continue;
      }
      const orderBy: NonNullable<typeof latestOne>["orderBy"] = [];
      let orderOk = true;
      for (const ob of j.latestOne.orderBy) {
        const ocol = resolveColumn(ob.column, [joined], findings, ambiguities);
        if (!ocol) {
          orderOk = false;
          continue;
        }
        orderBy.push({ column: ocol.column, dir: ob.dir ?? "desc" });
      }
      if (!orderOk) continue;
      const inner: NonNullable<typeof latestOne>["inner"] = [];
      for (const lf of j.latestOne.filters ?? []) {
        const lcol = resolveColumn(lf.column, [joined], findings, ambiguities);
        if (!lcol) continue;
        const outer = lf.outerColumn === undefined ? undefined : resolveColumn(lf.outerColumn, owners, findings, ambiguities);
        if (lf.outerColumn !== undefined && !outer) continue;
        inner.push({
          owner: lcol.owner,
          column: lcol.column,
          op: lf.op,
          param: lf.param,
          outerOwner: outer?.owner,
          outerColumn: outer?.column,
          position: lf.param === undefined ? undefined : takePosition(lf.param),
        });
      }
      latestOne = {
        orderBy,
        limit: j.latestOne.limit ?? 1,
        orUnmatched: j.latestOne.orUnmatched ?? false,
        inner,
      };
    }
    const andOn: (typeof resolvedJoins)[number]["andOn"] = [];
    let andOk = true;
    for (const extra of j.andOn ?? []) {
      const eLeft = resolveColumn(extra.left, owners, findings, ambiguities);
      const eRight = resolveColumn(extra.right, [joined], findings, ambiguities);
      if (!eLeft || !eRight) {
        andOk = false;
        continue;
      }
      andOn.push({ leftOwner: eLeft.owner, left: eLeft.column, right: eRight.column });
    }
    if (!andOk) continue;
    resolvedJoins.push({ table: joined, kind: j.kind, onLeftOwner: onLeft?.owner, onRight: j.onRight, onLeft: onLeft?.column, andOn, latestOne });
    owners.push(joined);
    if (j.kind === "left") outerOwners.add(joined);
  }
  // ── grouped summary joins ─────────────────────────────────────────────────
  // Resolved after the plain joins (positions follow array order: joins, then
  // these, then filters, then having). The exposed owner is SYNTHETIC — the
  // subquery's projection, not a table — so outer references resolve against
  // the group key and the aliases only, never the underlying columns.
  const aggregateJoins = (spec.aggregateJoins ?? []).map((j) => ownNamesBare(j) as typeof j);
  const resolvedAggJoins: Array<{
    source: ResolvedEntity;
    table: ResolvedEntity;
    kind: (typeof JOIN_KINDS)[number];
    onLeftOwner: ResolvedEntity;
    onLeft: string;
    groupBy: string;
    groupOwner: ResolvedEntity;
    /** The INNER joins inside the summary, in order (`through`). */
    through: Array<{ table: ResolvedEntity; leftOwner: ResolvedEntity; left: string; right: string }>;
    aggs: Array<{ owner?: ResolvedEntity; column?: string; compute?: ComputeNodeInput; aggregate: (typeof AGGREGATES)[number]; distinct: boolean; alias: string; columnType: string | null }>;
    inner: Array<{ owner: ResolvedEntity; column: string; op: (typeof FILTER_OPS)[number]; param?: string; value?: FixedValue; position?: number }>;
  }> = [];
  for (const j of aggregateJoins) {
    const joined = resolveTable(undefined, j.table, entities, findings);
    if (!joined) continue;
    // The tables inside the summary: the summarised one, then each it is joined through.
    const inside: ResolvedEntity[] = [joined];
    const through: (typeof resolvedAggJoins)[number]["through"] = [];
    let throughOk = true;
    for (const t of j.through ?? []) {
      const te = resolveTable(undefined, t.table, entities, findings);
      if (!te) { throughOk = false; continue; }
      if (inside.includes(te)) {
        findings.push({ code: "invalid_join", message: `the summary of "${j.table}" is joined through "${t.table}", which is already inside it — a table joins a summary once`, identifier: t.table });
        throughOk = false;
        continue;
      }
      const l = resolveColumn(t.onLeft, inside, findings, ambiguities);
      const r = resolveColumn(t.onRight, [te], findings, ambiguities);
      if (!l || !r) { throughOk = false; continue; }
      through.push({ table: te, leftOwner: l.owner, left: l.column, right: r.column });
      inside.push(te);
    }
    if (!throughOk) continue;
    const onLeft = resolveColumn(j.onLeft, owners, findings, ambiguities);
    const groupCol = resolveColumn(j.groupBy, inside, findings, ambiguities);
    if (!onLeft || !groupCol) continue;
    const exposed = new Map<string, string | null>();
    exposed.set(groupCol.column, groupCol.columnType);
    const aggs: (typeof resolvedAggJoins)[number]["aggs"] = [];
    for (const a of j.aggregates) {
      const acol = a.column === undefined ? undefined : resolveColumn(a.column, inside, findings, ambiguities);
      if (a.column !== undefined && !acol) continue;
      // P7 / P10: a result the outer select reads by alias must carry a type. Outer columns
      // from `__totals` are bare refs (not `sum(...)`), so `operationFields` uses `tyOfColumn`
      // — null ⇒ Opaque ⇒ `add_reader` refuses the whole reader. Assign here, or refuse.
      if ((a as { compute?: ComputeNodeInput }).compute !== undefined) {
        const ctype = a.aggregate === "count" ? "bigint" : "numeric";
        aggs.push({ compute: (a as { compute?: ComputeNodeInput }).compute, aggregate: a.aggregate, distinct: a.distinct ?? false, alias: a.alias, columnType: ctype });
        exposed.set(a.alias, ctype);
        continue;
      }
      // `count` → bigint. sum/avg: keep the input column's type when known (prior
      // behaviour); only default to numeric when the input is untyped — never null
      // (null → Opaque → add_reader refuse). min/max inherit or refuse.
      let atype: string | null =
        a.aggregate === "count" ? "bigint"
        : a.aggregate === "sum" || a.aggregate === "avg" ? (acol?.columnType ?? "numeric")
        : (acol?.columnType ?? null);
      if (atype === null) {
        findings.push({
          code: "untyped_aggregate",
          message: `aggregate \`${a.alias}\` (${a.aggregate}) has no result type — the column it summarises is untyped; the builder cannot place an Opaque reader`,
          identifier: a.alias,
        });
        continue;
      }
      aggs.push({ owner: acol?.owner, column: acol?.column, aggregate: a.aggregate, distinct: a.distinct ?? false, alias: a.alias, columnType: atype });
      exposed.set(a.alias, atype);
    }
    const inner: (typeof resolvedAggJoins)[number]["inner"] = [];
    for (const af of j.filters ?? []) {
      const acol = resolveColumn(af.column, inside, findings, ambiguities);
      if (!acol) continue;
      const amis = af.value === undefined ? null : constantMisfit(acol.columnType, af.value, af.op, `\`${af.column}\``);
      if (amis) { findings.push({ code: "constant_type", message: amis, identifier: af.column }); continue; }
      inner.push({
        owner: acol.owner,
        column: acol.column,
        op: af.op,
        param: af.param,
        ...(af.value !== undefined ? { value: af.value } : {}),
        position: af.param === undefined ? undefined : takePosition(af.param),
      });
    }
    const synthetic: ResolvedEntity = {
      schema: joined.schema,
      name: `${joined.name}__totals`,
      entityType: joined.entityType,
      columns: exposed,
      // Inside the summary: `count` is never NULL; any other aggregate can be (all inputs NULL); the key keeps its own.
      nullable: new Set([
        ...aggs.filter((a) => a.aggregate !== "count").map((a) => a.alias),
        ...(groupCol.owner.nullable?.has(groupCol.column) ?? true ? [groupCol.column] : []),
      ]),
    };
    if (j.kind === "left") outerOwners.add(synthetic);
    resolvedAggJoins.push({ source: joined, table: synthetic, kind: j.kind, onLeftOwner: onLeft.owner, onLeft: onLeft.column, groupBy: groupCol.column, groupOwner: groupCol.owner, through, aggs, inner });
    owners.push(synthetic);
  }

  // ── composable values ─────────────────────────────────────────────────────
  // Resolved here, in select order, so compute params take positions after
  // the joins and before the filters — the order `specParamOrder` replays.
  const aliasOf = new Map<ResolvedEntity, string>();
  owners.forEach((o, i) => aliasOf.set(o, `t${i}`));
  type ResolvedValue = {
    sql: string;
    columnType: string | null;
    params: Array<{ name: string; ptype: string }>;
    /** Set for a bare `{column}` reference: where the value was read from. */
    origin?: { owner: ResolvedEntity; column: string };
  };
  const resolveValue = (
    node: ComputeNodeInput,
    hint: "date" | "number" | null,
    scope?: Map<ResolvedEntity, string>,
  ): ResolvedValue | undefined => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      findings.push({ code: "invalid_compute", message: "a computed value must be an object — {column}, {param}, {addDays}, {diffDays}, {diffMinutes}, {greatest}, {least}, {businessMinutes}, {coalesce}, {arith}, {percent} or {caseWhen}" });
      return undefined;
    }
    if ("column" in node && typeof (node as { column?: unknown }).column === "string") {
      // P10: inside a summary subquery resolve against the INNER tables (scope keys),
      // not outer owners — a dimension base leaves the fact table out of outer owners.
      const search = scope ? [...scope.keys()] : owners;
      const col = resolveColumn((node as { column: string }).column, search, findings, ambiguities);
      if (!col) return undefined;
      // Inner alias from scope when present; otherwise the outer join alias.
      const qualifier = scope?.get(col.owner) ?? aliasOf.get(col.owner)!;
      return { sql: `${q(qualifier)}.${q(col.column)}`, columnType: col.columnType, params: [], origin: { owner: col.owner, column: col.column } };
    }
    if ("number" in node && typeof (node as { number?: unknown }).number === "number") {
      const n = (node as { number: number }).number;
      if (!Number.isFinite(n)) { findings.push({ code: "invalid_compute", message: "a fixed number must be finite" }); return undefined; }
      return { sql: numberSql(n), columnType: Number.isInteger(n) ? "integer" : "numeric", params: [] };
    }
    if ("param" in node && typeof (node as { param?: unknown }).param === "string") {
      const p = node as { param: string; type?: string };
      const position = takePosition(p.param);
      const ptype = p.type ?? hint ?? "string";
      if (!computeParamType.has(p.param)) computeParamType.set(p.param, ptype);
      // `datetime`: an instant (the moment the automation runs, 2026-10-04) — compared to the minute, never cut to its day.
      return { sql: `$${position}`, columnType: ptype === "number" ? "integer" : ptype === "date" ? "date" : ptype === "datetime" ? "timestamp with time zone" : "character varying", params: [{ name: p.param, ptype }] };
    }
    if ("addDays" in node) {
      const spec = (node as { addDays: { value: ComputeNodeInput; days: ComputeNodeInput } }).addDays;
      const value = resolveValue(spec.value, "date", scope);
      const days = resolveValue(spec.days, "number", scope);
      if (!value || !days) return undefined;
      // SQLite: `date(d, '+N days')` — the modifier built from the (whole) number of days; `printf('%+d …')` signs it either way.
      if (lite) return { sql: `date(${value.sql}, printf('%+d days', CAST(${days.sql} AS INTEGER)))`, columnType: "date", params: [...value.params, ...days.params] };
      return { sql: `(${value.sql}::date + (${days.sql})::int)`, columnType: "date", params: [...value.params, ...days.params] };
    }
    if ("diffDays" in node) {
      const spec = (node as { diffDays: { start: ComputeNodeInput; end: ComputeNodeInput } }).diffDays;
      const start = resolveValue(spec.start, "date", scope);
      const end = resolveValue(spec.end, "date", scope);
      if (!start || !end) return undefined;
      // SQLite: whole days between the two DATES (each read as its date first, as `::date` does) — julian day numbers of two dates
      // differ by an exact whole number.
      if (lite) return { sql: `CAST(julianday(date(${end.sql})) - julianday(date(${start.sql})) AS INTEGER)`, columnType: "integer", params: [...start.params, ...end.params] };
      return { sql: `(${end.sql}::date - ${start.sql}::date)`, columnType: "integer", params: [...start.params, ...end.params] };
    }
    if ("diffMinutes" in node) {
      const spec = (node as { diffMinutes: { start: ComputeNodeInput; end: ComputeNodeInput } }).diffMinutes;
      const start = resolveValue(spec.start, "date", scope);
      const end = resolveValue(spec.end, "date", scope);
      if (!start || !end) return undefined;
      // SQLite: minutes between two instants, rounded to the whole minute as the Postgres cast to bigint rounds.
      if (lite) return { sql: `CAST(ROUND((julianday(${end.sql}) - julianday(${start.sql})) * 1440) AS INTEGER)`, columnType: "bigint", params: [...start.params, ...end.params] };
      return {
        sql: `(EXTRACT(EPOCH FROM ((${end.sql})::timestamptz - (${start.sql})::timestamptz)) / 60)::bigint`,
        columnType: "bigint",
        params: [...start.params, ...end.params],
      };
    }
    if ("greatest" in node) {
      const spec = (node as { greatest: { first: ComputeNodeInput; second: ComputeNodeInput } }).greatest;
      const first = resolveValue(spec.first, hint, scope);
      const second = resolveValue(spec.second, hint, scope);
      if (!first || !second) return undefined;
      // SQLite's two-argument max() is NULL when either is; GREATEST ignores a NULL — each side falls back to the other.
      if (lite) return { sql: `max(COALESCE(${first.sql}, ${second.sql}), COALESCE(${second.sql}, ${first.sql}))`, columnType: first.columnType ?? second.columnType, params: [...first.params, ...second.params] };
      return { sql: `GREATEST(${first.sql}, ${second.sql})`, columnType: first.columnType ?? second.columnType, params: [...first.params, ...second.params] };
    }
    if ("least" in node) {
      const spec = (node as { least: { first: ComputeNodeInput; second: ComputeNodeInput } }).least;
      const first = resolveValue(spec.first, hint, scope);
      const second = resolveValue(spec.second, hint, scope);
      if (!first || !second) return undefined;
      if (lite) return { sql: `min(COALESCE(${first.sql}, ${second.sql}), COALESCE(${second.sql}, ${first.sql}))`, columnType: first.columnType ?? second.columnType, params: [...first.params, ...second.params] };
      return { sql: `LEAST(${first.sql}, ${second.sql})`, columnType: first.columnType ?? second.columnType, params: [...first.params, ...second.params] };
    }
    if ("businessMinutes" in node) {
      const spec = (node as { businessMinutes: { start: ComputeNodeInput; end: ComputeNodeInput } }).businessMinutes;
      const start = resolveValue(spec.start, "date", scope);
      const end = resolveValue(spec.end, "date", scope);
      if (!start || !end) return undefined;
      if (lite) { findings.push({ code: "invalid_compute", message: "{businessMinutes} is not available on a SQLite datasource — it needs a calendar walk SQLite does not have; leave it out" }); return undefined; }
      // One day-row per UTC day in the window, weekdays only, clipped to
      // 09:00–17:00 — the SQL spelling of the oracle's day-walk. `AT TIME
      // ZONE 'UTC'` pins the comparison to UTC rather than the session zone.
      const s = `(${start.sql})::timestamptz`;
      const e = `(${end.sql})::timestamptz`;
      return {
        sql:
          `COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (` +
          `LEAST(${e} AT TIME ZONE 'UTC', d.day + time '17:00') - ` +
          `GREATEST(${s} AT TIME ZONE 'UTC', d.day + time '09:00'))) / 60) ` +
          `FROM generate_series(date_trunc('day', ${s} AT TIME ZONE 'UTC'), date_trunc('day', ${e} AT TIME ZONE 'UTC'), interval '1 day') AS d(day) ` +
          `WHERE EXTRACT(ISODOW FROM d.day) < 6 AND ` +
          `LEAST(${e} AT TIME ZONE 'UTC', d.day + time '17:00') > GREATEST(${s} AT TIME ZONE 'UTC', d.day + time '09:00')), 0)::bigint`,
        columnType: "bigint",
        params: [...start.params, ...end.params],
      };
    }
    if ("arith" in node) {
      const spec = (node as { arith: { op: (typeof ARITH_OPS)[number]; left: ComputeNodeInput; right: ComputeNodeInput } }).arith;
      const left = resolveValue(spec.left, "number", scope);
      const right = resolveValue(spec.right, "number", scope);
      if (!left || !right) return undefined;
      const whole = (t: string | null) => !!t && /^(smallint|integer|bigint|int)/.test(t);
      // builder-behaviour (R16, B19): whole numbers are widened before they are combined — `integer × integer` is an `integer` in
      // Postgres and overflowed ("integer out of range") on ordinary data (a quantity × a price in cents). Standard SQL, so the
      // SQLite dialect takes it as it is.
      const l = spec.op !== "divide" && whole(left.columnType) && whole(right.columnType) ? `CAST(${left.sql} AS BIGINT)` : left.sql;
      const sql = spec.op === "divide" ? `((${left.sql}) * 1.0 / NULLIF(${right.sql}, 0))` : `((${l}) ${spec.op === "add" ? "+" : spec.op === "subtract" ? "-" : "*"} (${right.sql}))`;
      return { sql, columnType: spec.op !== "divide" && whole(left.columnType) && whole(right.columnType) ? "bigint" : "numeric", params: [...left.params, ...right.params] };
    }
    if ("percent" in node) {
      const spec = (node as { percent: { part: ComputeNodeInput; whole: ComputeNodeInput } }).percent;
      const part = resolveValue(spec.part, "number", scope);
      const whole = resolveValue(spec.whole, "number", scope);
      if (!part || !whole) return undefined;
      return { sql: `((${part.sql}) * 100.0 / NULLIF(${whole.sql}, 0))`, columnType: "numeric", params: [...part.params, ...whole.params] };
    }
    if ("caseWhen" in node) {
      const spec = (node as { caseWhen: { arms: Array<{ op: (typeof COMPUTED_FILTER_OPS)[number]; left: ComputeNodeInput; right: ComputeNodeInput; then: ComputeNodeInput }>; else?: ComputeNodeInput } }).caseWhen;
      const opSql = (op: string): string => op === "eq" ? "=" : op === "neq" ? "<>" : op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : "<=";
      const parts: string[] = [];
      const params: Array<{ name: string; ptype: string }> = [];
      let outType: string | null = null;
      for (const arm of spec.arms) {
        const left = resolveValue(arm.left, hint, scope);
        const right = resolveValue(arm.right, hint, scope);
        const then = resolveValue(arm.then, hint, scope);
        if (!left || !right || !then) return undefined;
        parts.push(`WHEN ${left.sql} ${opSql(arm.op)} ${right.sql} THEN ${then.sql}`);
        params.push(...left.params, ...right.params, ...then.params);
        outType = outType ?? then.columnType;
      }
      let elseSql = "NULL";
      if (spec.else !== undefined) {
        const e = resolveValue(spec.else, hint, scope);
        if (!e) return undefined;
        elseSql = e.sql;
        params.push(...e.params);
        outType = outType ?? e.columnType;
      }
      return { sql: `(CASE ${parts.join(" ")} ELSE ${elseSql} END)`, columnType: outType, params };
    }
    if ("coalesce" in node) {
      const parts = (node as { coalesce: ComputeNodeInput[] }).coalesce;
      const resolved: ResolvedValue[] = [];
      for (const part of parts) {
        const r = resolveValue(part, hint, scope);
        if (!r) return undefined;
        resolved.push(r);
      }
      // Arms of different types do not unify — `COALESCE(int_col, text_col)`
      // fails at the database rather than coercing. The first arm with a known
      // type wins and the rest cast to it, so the author's order decides the
      // result type and an uncastable value fails loudly at run time rather
      // than silently picking a supertype that changes every comparison.
      // ⚠ An UNKNOWN type is not a type (2026-10-01): a SQLite column that declares none is `any`, and read as `text` it cast the
      // other arms to text — `COALESCE(total, ((0))::text)`, wrong on Postgres and refused on SQLite. It neither picks the target
      // nor is cast; the first KNOWN type wins.
      const known = (t: string | null): t is string => t !== null && !/^(any|unknown)$/i.test(t.trim());
      const target = resolved.map((r) => r.columnType).find(known) ?? null;
      const pgType = (t: string | null): string | null => {
        if (!known(t)) return null;
        const l = t.toLowerCase();
        if (/^(smallint|integer|bigint|serial|bigserial|int2|int4|int8)\b/.test(l)) return "int";
        if (/^(numeric|decimal|real|double precision|float4|float8)\b/.test(l)) return "numeric";
        if (/^(date|time|timestamp)\b/.test(l)) return "date";
        if (/^boolean?\b/.test(l)) return "boolean";
        return "text";
      };
      const want = pgType(target);
      const arms = resolved.map((r) => {
        const have = pgType(r.columnType);
        if (want === null || have === null || have === want) return r.sql;
        // SQLite: the same conversion by CAST (a date is its text `YYYY-MM-DD`, read back by `date()`).
        if (lite) return want === "date" ? `date(${r.sql})` : `CAST(${r.sql} AS ${want === "int" || want === "boolean" ? "INTEGER" : want === "numeric" ? "REAL" : "TEXT"})`;
        return `(${r.sql})::${want}`;
      });
      return {
        sql: `COALESCE(${arms.join(", ")})`,
        columnType: target,
        params: resolved.flatMap((r) => r.params),
      };
    }
    findings.push({ code: "invalid_compute", message: "a computed value must be one of {column}, {param}, {addDays}, {diffDays}, {diffMinutes}, {greatest}, {least}, {businessMinutes}, {caseWhen} or {coalesce}" });
    return undefined;
  };

  const aliases = new Set<string>();
  // `columnType` is threaded through for `outputColumns` — `resolveColumn`
  const selected: Array<{
    exprSql: string;
    source: string;
    aggregate?: string;
    aggregateDistinct: boolean;
    alias: string;
    columnType: string | null;
    computeParams: Array<{ name: string; ptype: string }>;
    /** Whether the value BEFORE any aggregate may be NULL. A computed value is taken as nullable (safe direction). */
    sourceNullable: boolean;
    /** builder-behaviour P7 (R23): the length of time a computed difference counts in — exact from the computation itself. */
    unit?: "minutes" | "business_minutes" | "days";
  }> = [];
  for (const c of spec.columns) {
    if (!IDENTIFIER.test(c.alias)) {
      findings.push({
        code: "invalid_alias",
        message: `alias "${c.alias}" is not a plain identifier — the alias becomes the result column name, and a step addresses it by that name`,
        identifier: c.alias,
      });
      continue;
    }
    if (aliases.has(c.alias)) {
      findings.push({
        code: "duplicate_alias",
        message: `alias "${c.alias}" is used by more than one column — two result columns with one name would overwrite each other's value in every row`,
        identifier: c.alias,
      });
      continue;
    }
    aliases.add(c.alias);
    // DISTINCT inside an aggregate without one is meaningless; without the
    // aggregate it is a second spelling of the top-level flag.
    if (c.aggregateDistinct && c.aggregate === undefined) {
      findings.push({
        code: "distinct_without_aggregate",
        message: `column "${c.alias}" asks for DISTINCT inside an aggregate it does not have — use the top-level \`distinct\` flag for deduplicated rows`,
        identifier: c.alias,
      });
      continue;
    }
    // Exactly one of `column` / `compute` — the schema refines it on parse,
    // but direct calls tolerate partial specs, so the neither-case refuses
    // here rather than crashing on `undefined` below.
    const value =
      c.compute !== undefined
        ? resolveValue(c.compute, null)
        : c.column !== undefined
          ? resolveValue({ column: c.column }, null)
          : undefined;
    if (!value) {
      if (c.compute === undefined && c.column === undefined) {
        findings.push({
          code: "invalid_compute",
          message: `column "${c.alias}" names neither \`column\` nor \`compute` + "` — one of them must say what the row carries",
          identifier: c.alias,
        });
      }
      continue;
    }
    selected.push({
      exprSql: value.sql,
      source:
        value.origin !== undefined
          ? `${value.origin.owner.schema ? `${value.origin.owner.schema}.` : ""}${value.origin.owner.name}.${value.origin.column}`
          : c.alias,
      aggregate: c.aggregate,
      aggregateDistinct: c.aggregateDistinct ?? false,
      alias: c.alias,
      columnType: value.columnType,
      computeParams: value.params,
      ...(timeUnitOfCompute(c.compute) ? { unit: timeUnitOfCompute(c.compute)! } : {}),
      sourceNullable:
        value.origin === undefined
          ? true
          : outerOwners.has(value.origin.owner) || (value.origin.owner.nullable?.has(value.origin.column) ?? true),
    });
  }
  // ── filters → positional parameters ───────────────────────────────────────
  // `is_null`/`is_not_null` bind nothing, so they take no position; every
  // other operator consumes one in first-seen order (after any `latestOne`
  // inner conditions, before having).
  // A filter compares a COLUMN, or a computed value (`expr`, its SQL; `exprType`, the type its parameter takes). The computed value's
  // own parameters are numbered first — `resolveValue` takes their positions as it meets them — then the compared parameter.
  type FilterCol = { owner?: ResolvedEntity; column?: string; expr?: string; exprType?: string | null; op: (typeof FILTER_OPS)[number]; param?: string; value?: FixedValue; against?: { owner: ResolvedEntity; column: string }; orGroup?: string; position?: number };
  const filterCols: FilterCol[] = [];
  for (const f of filters) {
    if (f.compute !== undefined) {
      const v = resolveValue(f.compute as ComputeNodeInput, null);
      if (!v) continue;
      const vmis = f.value === undefined ? null : constantMisfit(v.columnType, f.value, f.op, "the computed value");
      if (vmis) { findings.push({ code: "constant_type", message: vmis }); continue; }
      filterCols.push({ expr: v.sql, exprType: v.columnType, op: f.op, param: f.param, ...(f.value !== undefined ? { value: f.value } : {}), orGroup: f.orGroup, position: f.param === undefined ? undefined : takePosition(f.param) });
      continue;
    }
    const col = resolveColumn(f.column!, owners, findings, ambiguities);
    if (!col) continue;
    const mis = f.value === undefined ? null : constantMisfit(col.columnType, f.value, f.op, `\`${f.column}\``);
    if (mis) { findings.push({ code: "constant_type", message: mis, identifier: f.column }); continue; }
    // A column against another column: both resolve against the same rows, and must be the same kind of value (`comparable`).
    let against: { owner: ResolvedEntity; column: string } | undefined;
    if (f.against !== undefined) {
      const other = resolveColumn(f.against, owners, findings, ambiguities);
      if (!other) continue;
      if (!comparableTypes(col.columnType, other.columnType)) { findings.push({ code: "against_type", message: `\`${f.column}\` (${col.columnType ?? "unknown"}) cannot be compared with \`${f.against}\` (${other.columnType ?? "unknown"}): both sides must be the same kind of value`, identifier: f.against }); continue; }
      against = { owner: other.owner, column: other.column };
    }
    filterCols.push({ owner: col.owner, column: col.column, op: f.op, param: f.param, ...(f.value !== undefined ? { value: f.value } : {}), ...(against ? { against } : {}), orGroup: f.orGroup, position: f.param === undefined ? undefined : takePosition(f.param) });
  }
  // ── having → positional parameters, continuing the same numbering ─────────
  const havingCols: Array<{ owner: ResolvedEntity; column: string; aggregate: (typeof AGGREGATES)[number]; op: (typeof HAVING_OPS)[number]; param: string; position: number }> = [];
  for (const h of having) {
    const col = resolveColumn(h.column, owners, findings, ambiguities);
    if (!col) continue;
    havingCols.push({ owner: col.owner, column: col.column, aggregate: h.aggregate, op: h.op, param: h.param, position: takePosition(h.param) });
  }
  if (havingCols.length > 0 && !selected.some((c) => c.aggregate !== undefined)) {
    findings.push({
      code: "having_without_aggregate",
      message: "`having` filters an aggregated value, but the select list aggregates nothing — put the condition in `filters` instead",
    });
  }
  // ── sort ──────────────────────────────────────────────────────────────────
  // An OUTPUT alias is a legal sort key (PostgreSQL resolves a bare ORDER BY name to an
  // output column; SQLite likewise). The proposer is told to set a sort whenever it sets
  // a limit, and a single-row summary's own result name is its only meaningful order
  // key — `count(id) AS invoice_count` sorted by `invoice_count` spent all three proposal
  // attempts on `no column "invoice_count"` before this (R5/R6/G2, 2026-10-05). An input
  // column of the same name keeps precedence, so every spec that compiled before compiles
  // to the same SQL.
  const sortCols: Array<{ owner: ResolvedEntity; column: string; dir: (typeof SORT_DIRS)[number] } | { alias: string; dir: (typeof SORT_DIRS)[number] }> = [];
  for (const s of sort) {
    if (!owners.some((o) => o.columns.has(s.column)) && aliases.has(s.column)) {
      sortCols.push({ alias: s.column, dir: s.dir });
      continue;
    }
    const col = resolveColumn(s.column, owners, findings, ambiguities);
    if (!col) continue;
    sortCols.push({ owner: col.owner, column: col.column, dir: s.dir });
  }

  if (findings.length > 0) throw compileError(findings);

  // ── emit ──────────────────────────────────────────────────────────────────

  // Terms are ANDed; filters sharing an `orGroup` form one parenthesised OR
  // term, ordered by first appearance. A null-op binds no value, so it emits
  // no placeholder — the position stays `undefined` by construction.
  const termOf = (f: (typeof filterCols)[number]): string => {
    const qual = f.expr ?? `${q(aliasOf.get(f.owner!)!)}.${q(f.column!)}`;
    if (f.op === "is_null") return `${qual} IS NULL`;
    if (f.op === "is_not_null") return `${qual} IS NOT NULL`;
    if (f.op === "in") return `${qual} = ANY($${f.position})`;
    if (f.op === "month") return monthCond(qual, f.position, f.expr !== undefined ? f.exprType : f.owner!.columns.get(f.column!));
    if (f.value !== undefined) return `${qual} ${opSql(f.op)} ${numberSql(f.value)}`;
    if (f.against) return `${qual} ${opSql(f.op)} ${q(aliasOf.get(f.against.owner)!)}.${q(f.against.column)}`;
    return vsParam(qual, f.op, f.position, f.param);
  };
  const terms: string[] = [];
  const seenGroups = new Set<string>();
  for (const f of filterCols) {
    if (f.orGroup === undefined) {
      terms.push(termOf(f));
      continue;
    }
    if (seenGroups.has(f.orGroup)) continue;
    seenGroups.add(f.orGroup);
    terms.push(`(${filterCols.filter((g) => g.orGroup === f.orGroup).map(termOf).join(" OR ")})`);
  }
  const whereSql = terms.length === 0 ? "" : " WHERE " + terms.join(" AND ");

  // One construction for the select expression AND the grouping key: a
  // computed expression selects a value `GROUP BY <bare column>` does not
  // determine, and Postgres refuses it rather than guessing — so the two
  // clauses share the resolved expression verbatim.
  const groupKey = (c: (typeof selected)[number]): string => c.exprSql;
  const selectSql =
    (spec.distinct ? "DISTINCT " : "") +
    selected
      .map((c) => {
        const inner = groupKey(c);
        const expr = c.aggregate
          ? `${c.aggregate}(${c.aggregateDistinct ? "DISTINCT " : ""}${inner})`
          : inner;
        return `${expr} AS ${q(c.alias)}`;
      })
      .join(", ");
  const fromSql =
    `${qEntity(base)} AS ${q(aliasOf.get(base)!)}` +
    resolvedJoins
      .map((j) => {
        const jAlias = aliasOf.get(j.table)!;
        if (!j.latestOne) {
          // Plain joins are always correlated — the resolver refuses the
          // cross-join shape — so the assertions below are unreachable, not
          // optimistic. They read as `!` precisely so a future loosening fails
          // loudly here instead of emitting `ON undefined = undefined`.
          // Composite keys append ANDed equalities in spec order — the first
          // pair stays first, so the emitted condition reads like the schema.
          const extraOn = j.andOn.map(
            (e) => ` AND ${q(aliasOf.get(e.leftOwner)!)}.${q(e.left)} = ${q(jAlias)}.${q(e.right)}`,
          );
          return (
            ` ${j.kind.toUpperCase()} JOIN ${qEntity(j.table)} AS ${q(jAlias)} ON ` +
            `${q(aliasOf.get(j.onLeftOwner!)!)}.${q(j.onLeft!)} = ${q(jAlias)}.${q(j.onRight!)}${extraOn.join("")}`
          );
        }
        // A latest-row lookup: the correlation plus the inner conditions pick
        // the rows, ORDER BY + LIMIT pick the winner. Every identifier resolved
        // above; every value a positional parameter — the same properties as
        // the outer query, one level down. With `orUnmatched` the correlation
        // also matches fallback rows (the joined column null), so the FIRST
        // order key must sort matched rows before the fallback — ascending
        // with NULLS LAST, stated explicitly rather than relying on the default.
        // Without a correlation the lookup is a cross-apply: every outer row
        // reads the same inner winner (a settings row, an org default).
        const lo = j.latestOne;
        const corr =
          j.onLeft === undefined || j.onRight === undefined
            ? null
            : `${q(aliasOf.get(j.onLeftOwner!)!)}.${q(j.onLeft)} = "${jAlias}_in"."${j.onRight}"`;
        const conds = [
          ...(corr === null ? [] : [lo.orUnmatched ? `(${corr} OR "${jAlias}_in"."${j.onRight}" IS NULL)` : corr]),
          ...lo.inner.map((lf) => {
            const lqual = `"${jAlias}_in"."${lf.column}"`;
            if (lf.op === "is_null") return `${lqual} IS NULL`;
            if (lf.op === "is_not_null") return `${lqual} IS NOT NULL`;
            // An outer-column bound compares against the row's own value, not
            // a supplied one — no placeholder, no position consumed.
            if (lf.outerColumn !== undefined) {
              const oqual = `${q(aliasOf.get(lf.outerOwner!)!)}.${q(lf.outerColumn)}`;
              if (lf.op === "in") return `${lqual} = ANY(${oqual})`;
              return `${lqual} ${opSql(lf.op)} ${oqual}`;
            }
            if (lf.op === "month") return monthCond(lqual, lf.position, lf.owner.columns.get(lf.column));
            if (lf.op === "in") return `${lqual} = ANY($${lf.position})`;
            return vsParam(lqual, lf.op, lf.position, lf.param);
          }),
        ];
        const orderSql = lo.orderBy
          .map((ob, i) => `"${jAlias}_in"."${ob.column}" ${ob.dir.toUpperCase()}${lo.orUnmatched && i === 0 ? " NULLS LAST" : ""}`)
          .join(", ");
        // A lookup with no conditions at all is a bare "newest row" cross-apply —
        // legal, and the WHERE clause is omitted rather than left dangling.
        const whereInner = conds.length > 0 ? `WHERE ${conds.join(" AND ")} ` : "";
        return (
          ` ${j.kind.toUpperCase()} JOIN LATERAL (SELECT * FROM ${qEntity(j.table)} AS "${jAlias}_in" ` +
          `${whereInner}ORDER BY ${orderSql} LIMIT ${lo.limit}) AS ${q(jAlias)} ON true`
        );
      })
      .join("") +
    resolvedAggJoins
      .map((j) => {
        const jAlias = aliasOf.get(j.table)!;
        const inAlias = `${jAlias}_agg`;
        // Each table inside the summary has its own alias: the summarised one `<t>_agg`, the k-th it is joined through `<t>_agg<k>`.
        const inner = new Map<ResolvedEntity, string>([[j.source, inAlias], ...j.through.map((t, k) => [t.table, `${inAlias}${k + 1}`] as [ResolvedEntity, string])]);
        const at = (o: ResolvedEntity | undefined) => inner.get(o ?? j.source)!;
        const throughSql = j.through.map((t) => ` INNER JOIN ${qEntity(t.table)} AS "${at(t.table)}" ON "${at(t.leftOwner)}"."${t.left}" = "${at(t.table)}"."${t.right}"`).join("");
        // The inner select projects the group key under its own name plus one
        // expression per aggregate — the same names the synthetic owner
        // exposes, so outer references cannot disagree with what is selected.
        const innerSelect = [
          `"${at(j.groupOwner)}"."${j.groupBy}" AS "${j.groupBy}"`,
          ...j.aggs.map((a) => {
            // P10: a computed aggregate resolves here, in the subquery's scope — the inner aliases, not the outer ones.
            if (a.compute !== undefined) {
              const scope = new Map<ResolvedEntity, string>([[j.source, at(j.source)], ...j.through.map((t) => [t.table, at(t.table)] as [ResolvedEntity, string])]);
              const r = resolveValue(a.compute, "number", scope);
              if (!r) return `${a.aggregate}(${a.distinct ? "DISTINCT " : ""}NULL) AS "${a.alias}"`;
              return `${a.aggregate}(${a.distinct ? "DISTINCT " : ""}${r.sql}) AS "${a.alias}"`;
            }
            const what = a.column === undefined ? "*" : `"${at(a.owner)}"."${a.column}"`;
            return `${a.aggregate}(${a.distinct ? "DISTINCT " : ""}${what}) AS "${a.alias}"`;
          }),
        ].join(", ");
        const innerWhere =
          j.inner.length === 0
            ? ""
            : "WHERE " +
              j.inner
                .map((f) => {
                  const fqual = `"${at(f.owner)}"."${f.column}"`;
                  if (f.op === "is_null") return `${fqual} IS NULL`;
                  if (f.op === "is_not_null") return `${fqual} IS NOT NULL`;
                  if (f.op === "month") return monthCond(fqual, f.position, f.owner.columns.get(f.column));
                  if (f.op === "in") return `${fqual} = ANY($${f.position})`;
                  if (f.value !== undefined) return `${fqual} ${opSql(f.op)} ${numberSql(f.value)}`;
                  return vsParam(fqual, f.op, f.position, f.param);
                })
                .join(" AND ");
        return (
          ` ${j.kind.toUpperCase()} JOIN (SELECT ${innerSelect} FROM ${qEntity(j.source)} AS "${inAlias}"${throughSql} ` +
          `${innerWhere ? innerWhere + " " : ""}GROUP BY "${at(j.groupOwner)}"."${j.groupBy}") AS ${q(jAlias)} ON ` +
          `${q(aliasOf.get(j.onLeftOwner)!)}.${q(j.onLeft)} = ${q(jAlias)}."${j.groupBy}"`
        );
      })
      .join("");
  // Aggregate + plain columns in one select list requires GROUP BY on the plain
  // ones; filters stay in WHERE (they run before grouping, so no GROUP BY duty).
  const hasAggregate = selected.some((c) => c.aggregate !== undefined);
  const groupBySql =
    hasAggregate && selected.some((c) => c.aggregate === undefined)
      ? " GROUP BY " + selected.filter((c) => c.aggregate === undefined).map(groupKey).join(", ")
      : "";
  const orderBySql =
    sortCols.length === 0
      ? ""
      : " ORDER BY " +
        sortCols
          .map((s) => ("alias" in s ? q(s.alias) : `${q(aliasOf.get(s.owner)!)}.${q(s.column)}`) + ` ${s.dir.toUpperCase()}`)
          .join(", ");

  const limitSql = spec.limit === undefined ? "" : ` LIMIT ${spec.limit}`;
  const havingSql =
    havingCols.length === 0
      ? ""
      : " HAVING " +
        havingCols
          .map((h) => `${h.aggregate}(${q(aliasOf.get(h.owner)!)}.${q(h.column)}) ${opSql(h.op)} $${h.position}`)
          .join(" AND ");
  const sql = `SELECT ${selectSql} FROM ${fromSql}${whereSql}${groupBySql}${havingSql}${orderBySql}${limitSql}`;
  // ── derived params_schema ─────────────────────────────────────────────────
  const paramsSchema: Record<string, unknown> = {};
  // Compute params first: select-list resolution runs before the filters, so
  // their positions (and these descriptors) come first too.
  for (const c of selected) {
    for (const p of c.computeParams) {
      if (paramsSchema[p.name] !== undefined) continue;
      paramsSchema[p.name] = toolParamDescriptor.parse({
        ...(p.ptype === "datetime" ? { type: "string", format: "datetime" } : { type: p.ptype }),
        required: true,
        description: `value inside the "${c.alias}" expression`,
      });
    }
  }
  for (const f of filterCols) {
    // Null-ops bind nothing — there is no parameter to describe.
    if (f.param === undefined) continue;
    if (paramsSchema[f.param] !== undefined) continue;
    paramsSchema[f.param] = toolParamDescriptor.parse(f.expr !== undefined
      ? { type: paramTypeFor(f.exprType ?? "numeric", f.op), required: true, description: `${f.op} filter on a computed value` }
      : {
          type: paramTypeFor(f.owner!.columns.get(f.column!) ?? null, f.op),
          ...formatFor(f.op),
          required: true,
          description: `${f.op} filter on ${f.owner!.schema ? `${f.owner!.schema}.` : ""}${f.owner!.name}.${f.column}`,
        });
  }
  for (const j of resolvedJoins) {
    for (const lf of j.latestOne?.inner ?? []) {
      if (lf.param === undefined || paramsSchema[lf.param] !== undefined) continue;
      paramsSchema[lf.param] = toolParamDescriptor.parse({
        type: paramTypeFor(lf.owner.columns.get(lf.column) ?? null, lf.op),
        ...formatFor(lf.op),
        required: true,
        description: `${lf.op} filter on ${lf.owner.schema ? `${lf.owner.schema}.` : ""}${lf.owner.name}.${lf.column} (inside a latest-row lookup)`,
      });
    }
  }
  for (const j of resolvedAggJoins) {
    for (const af of j.inner) {
      if (af.param === undefined || paramsSchema[af.param] !== undefined) continue;
      paramsSchema[af.param] = toolParamDescriptor.parse({
        type: paramTypeFor(af.owner.columns.get(af.column) ?? null, af.op),
        ...formatFor(af.op),
        required: true,
        description: `${af.op} filter on ${af.owner.schema ? `${af.owner.schema}.` : ""}${af.owner.name}.${af.column} (inside a summary join)`,
      });
    }
  }
  for (const h of havingCols) {
    if (paramsSchema[h.param] !== undefined) continue;
    paramsSchema[h.param] = toolParamDescriptor.parse({
      type: paramTypeFor(h.owner.columns.get(h.column) ?? null, h.op),
      required: true,
      description: `${h.op} filter on ${h.aggregate}(${h.owner.schema ? `${h.owner.schema}.` : ""}${h.owner.name}.${h.column})`,
    });
  }

  // A parameter allocated anywhere is described, from where it was allocated: a computation inside a FILTER holds parameters the
  // select list's loop never sees (the run day of "placed more than 5 days ago"), and its statement then failed its own shape check.
  for (const name of paramOrder) {
    if (paramsSchema[name] !== undefined) continue;
    const t = computeParamType.get(name);
    if (t === undefined) continue; // not a computation's: the shape check below refuses it by name
    paramsSchema[name] = toolParamDescriptor.parse({ ...(t === "datetime" ? { type: "string", format: "datetime" } : { type: t }), required: true, description: "value inside a computed expression" });
  }

  // ── the shape backstop (07 §7.0) ──────────────────────────────────────────
  // The compiler only emits SELECT, so a problem here is a compiler bug — but
  // the refusal is what keeps a write-shaped statement from being stored or
  // previewed. Same rules as the named queries, deliberately.
  const shapeProblems = checkSqlShape(sql, paramOrder, paramsSchema);
  if (shapeProblems.length > 0) {
    findings.push({
      code: "shape",
      message: `the compiled statement failed the read-only shape check: ${shapeProblems
        .map((p) => p.message)
        .join("; ")}`,
    });
    throw compileError(findings);
  }

  // ── output columns ────────────────────────────────────────────────────────
  //
  // Projected from `selected`, which is the SAME list the select clause above
  // was emitted from — so a column that appears here appears in the SQL, in this
  // order, by construction rather than by agreement.
  //
  // ⚠ `nullable` is decided HERE, the one place that knows the join kinds, the schema's NOT NULLs and the grouping
  // (compiled-builder E0.7 G4, G5, I-270): `count` is never NULL; any other aggregate is NULL when its input can be, or
  // when there is NO GROUP BY — an aggregate over zero rows returns one row of NULLs. A bare column is NULL when its
  // table is on the outer side of a LEFT JOIN or the schema allows it.
  const grouped = selected.some((c) => c.aggregate !== undefined) && selected.some((c) => c.aggregate === undefined);
  const outputColumns = selected.map((c) => {
    const nullable = c.aggregate === undefined ? c.sourceNullable : c.aggregate === "count" ? false : c.sourceNullable || !grouped;
    return {
      alias: c.alias,
      source: c.aggregate ? `${c.aggregate}(${c.source})` : c.source,
      type: c.columnType,
      nullable,
      // A total, an average, the smallest or largest of a length of time is that length in the same unit; a count is not.
      ...(c.unit && c.aggregate !== "count" ? { unit: c.unit } : {}),
    };
  });

  // P7: placeable aggregate / __totals results must be typed — null → Opaque → add_reader refuse.
  // Raw schema columns may still be untyped (SQLite); those stay nullable for dialect honesty.
  for (const c of outputColumns) {
    if (c.type != null) continue;
    if (/^(sum|avg|count|min|max)\(/i.test(c.source) || /__totals\./.test(c.source)) {
      findings.push({
        code: "untyped_output",
        message: `result column \`${c.alias}\` has no type (${c.source}) — the builder cannot place an Opaque reader`,
        identifier: c.alias,
      });
    }
  }
  if (findings.length > 0) throw compileError(findings);

  const paramColumns: Record<string, { schema: string | null; table: string; column: string }> = {};
  const paramOps: Record<string, "eq" | "neq" | "in"> = {};
  for (const f of filterCols) {
    if (f.param === undefined || !f.owner || paramColumns[f.param] || !(f.op === "eq" || f.op === "neq" || f.op === "in")) continue;
    paramColumns[f.param] = { schema: f.owner.schema, table: f.owner.name, column: f.column! };
    paramOps[f.param] = f.op;
  }
  // Which END of a range each parameter is (2026-10-01): "1 to 15 august 2026" gives both ends, and only the operator reading a
  // parameter says which end it takes — `gte` the first day, `lt` the day after the last. Every filter that binds one, at any level;
  // a parameter two different operators read is no edge.
  const EDGE: Record<string, ParamEdge> = { gte: "ge", gt: "gt", lte: "le", lt: "lt" };
  const paramEdges: Record<string, ParamEdge> = {};
  const mixedEdge = new Set<string>();
  for (const f of [...filterCols, ...resolvedJoins.flatMap((j) => j.latestOne?.inner ?? []), ...resolvedAggJoins.flatMap((j) => j.inner)]) {
    if (f.param === undefined) continue;
    const e = EDGE[f.op];
    if (!e || (paramEdges[f.param] && paramEdges[f.param] !== e)) mixedEdge.add(f.param); else paramEdges[f.param] = e;
  }
  for (const m of mixedEdge) delete paramEdges[m];
  // A filter INSIDE a summary join or a latest-row lookup compares its parameter with a column too (2026-10-01: "annual leave"
  // bound raw against `absence_type`, whose values are `Annual Leave`…, and SQLite's `=` matched nothing). Its column is recorded
  // so the parameter takes the column's known values; NOT its op — the row's own output never holds that column, so the parameter
  // selects no output field.
  for (const inner of [...resolvedJoins.flatMap((j) => j.latestOne?.inner ?? []), ...resolvedAggJoins.flatMap((j) => j.inner)]) {
    if (inner.param === undefined || paramColumns[inner.param] || !(inner.op === "eq" || inner.op === "neq" || inner.op === "in")) continue;
    paramColumns[inner.param] = { schema: inner.owner.schema, table: inner.owner.name, column: inner.column };
  }

  // The run's instant is an instant wherever it was used (`RUN_TIME_PARAM`) — a filter on a timestamp would otherwise type it a date.
  if (paramsSchema[RUN_TIME_PARAM] !== undefined) paramsSchema[RUN_TIME_PARAM] = toolParamDescriptor.parse({ type: "string", format: "datetime", required: true, description: "the moment it runs" });
  return { sql, paramsSchema, paramOrder, outputColumns, paramColumns, paramOps, paramEdges, ambiguousColumns: dedupeAmbiguities(ambiguities) };
}

function compileError(findings: OperationCompileFinding[]) {
  return Object.assign(
    new Error(
      "this operation cannot be compiled:\n" +
        findings.map((f) => `  • [${f.code}] ${f.message}`).join("\n"),
    ),
    { statusCode: 400, findings },
  );
}

// ── public shape ─────────────────────────────────────────────────────────────

function toPublic(op: DbOperation, datasourceName: string) {
  return {
    id: op.id,
    datasourceId: op.datasourceId,
    name: op.name,
    /** What a `query` step's `ref` must say. Returned so a client never has to
     *  build it by string concatenation and get the boundary wrong. */
    ref: `${datasourceName}.${op.name}`,
    description: op.description,
    spec: op.specJson,
    compiledSql: op.compiledSql,
    paramsSchema: op.paramsSchema,
    createdAt: op.createdAt,
    updatedAt: op.updatedAt,
  };
}

/**
 * An operation compiles to Postgres-dialect SQL. On a SQLite datasource some of
 * it has no faithful translation (date arithmetic, business minutes), so the
 * compiled statement is asked whether it RUNS before it is stored — the finding
 * lands at save, not at the first run after somebody approved the flow.
 */
async function sqliteDialectFindings(
  ds: { type: string; connectionStringEnc: string | null },
  compiledSql: string,
): Promise<OperationCompileFinding[]> {
  if (!isSqliteType(ds.type) || !ds.connectionStringEnc) return [];
  const problem = await sqliteFileService.statementProblem(decrypt(ds.connectionStringEnc), compiledSql);
  return problem ? [{ code: "sqlite_dialect", message: problem }] : [];
}

function dialectRefusal(findings: OperationCompileFinding[]) {
  return Object.assign(
    httpError(`this operation cannot run on a SQLite data source: ${findings.map((f) => f.message).join("; ")}`, 400),
    { findings },
  );
}

async function assertDatasource(workspaceId: string, dsId: string) {
  const ds = await datasourceRepo.get(workspaceId, dsId);
  if (!ds) throw httpError("datasource not found", 404);
  // Same rule as named queries: a step ref is split at the FIRST dot, so a
  // datasource whose name is not an identifier cannot host a resolvable
  // operation. Creation now rejects such a name; this catches rows that
  // predate that.
  if (!IDENTIFIER.test(ds.name)) {
    throw httpError(
      `datasource "${ds.name}" has a name that is not a plain identifier, so an operation ref ` +
        "built from it cannot be resolved: a step ref is split at the FIRST dot, and every " +
        "operation on this datasource would 404 at execution time. Rename the datasource first",
      409,
    );
  }
  return ds;
}

/**
 * Overlay authored parameter prose onto the derived map.
 *
 * ⚠ Only `description` is taken. `type` and `required` stay derived from the
 * spec, because a caller able to relabel a `date` param as a `string` could
 * make the compiler's own type reasoning wrong from outside it.
 */
function withParamProse(
  derived: Record<string, unknown>,
  prose: Record<string, string> | undefined,
  defaults?: Record<string, string>,
  formats?: Record<string, string>,
): Record<string, unknown> {
  if (!prose && !defaults && !formats) return derived;
  const out: Record<string, unknown> = { ...derived };
  for (const name of new Set([...Object.keys(prose ?? {}), ...Object.keys(defaults ?? {}), ...Object.keys(formats ?? {})])) {
    const existing = out[name] as { type?: string; required?: boolean; description?: string; format?: string } | undefined;
    // A key naming no parameter is IGNORED, not refused — see the schema.
    if (!existing) continue;
    const dflt = defaults?.[name];
    if (dflt !== undefined) {
      const bad = defaultMisfit(dflt, existing.type);
      if (bad) throw httpError(`the default for parameter "${name}" is ${bad}`, 400);
    }
    const fmt = formats?.[name] ?? existing.format;
    if (formats?.[name] && existing.type !== "string") throw httpError(`parameter "${name}" is a ${existing.type ?? "value"}, not text — a format names a shape of text`, 400);
    out[name] = operationParamDescriptor.parse({
      type: existing.type,
      required: existing.required,
      description: prose?.[name] ?? existing.description,
      ...(fmt ? { format: fmt } : {}),
      ...(dflt !== undefined ? { default: dflt } : {}),
    });
  }
  return out;
}

/** Does a stated default fit the parameter's DERIVED type? The engine checks again when it binds; this refuses it at the door. */
function defaultMisfit(v: string, type: string | undefined): string | null {
  if (type === "boolean") return v === "true" || v === "false" ? null : "not true or false";
  if (type === "integer") return /^-?\d+$/.test(v) ? null : "not a whole number";
  if (type === "number") return Number.isFinite(Number(v)) ? null : "not a number";
  if (/\{\{|\}\}/.test(v)) return "a template, which is not a value";
  return null;
}

/** The stated defaults out of a stored `params_schema`, so a PATCH that carries none keeps them. */
/** The formats an operation's author declared, read back from what is stored (see `defaultsOf`). */
function formatsOf(stored: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(stored ?? {})) {
    const f = (v as { format?: unknown } | null)?.format;
    if (typeof f === "string" && f) out[name] = f;
  }
  return out;
}

function defaultsOf(stored: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(stored ?? {})) {
    const d = (v as { default?: unknown } | null)?.default;
    if (typeof d === "string" && d) out[name] = d;
  }
  return out;
}

/**
 * The AUTHORED sentences out of a stored `params_schema`, so a PATCH that
 * carries none does not wipe them.
 *
 * ⚠ A derived description is recognised by SHAPE and dropped — it would
 * otherwise be re-applied as if a person had written it, which is harmless but
 * makes the two indistinguishable the next time somebody looks.
 */
function descriptionsOf(stored: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(stored ?? {})) {
    const d = (v as { description?: unknown } | null)?.description;
    if (typeof d !== "string" || !d) continue;
    if (/^(eq|neq|gt|gte|lt|lte|in|like) filter on /.test(d)) continue;
    out[name] = d;
  }
  return out;
}

/**
 * Which flows in this workspace still name `ref` — by flow NAME, for a person.
 *
 * ⚠ **`getRevision`, NOT `listRevisions`.** `listRevisions` is the one place
 * `hidden_at` is honoured, and a chat turn writes its revision ALREADY HIDDEN —
 * so a scan built on it reports "unreferenced" for a reader that every
 * chat-built flow in the workspace reads. Harmless in a listing; here it is the
 * difference between refusing a destructive delete and permitting it.
 *
 * ⚠ **Its BOUND, stated rather than left to be discovered: only the DRAFT and
 * the ARMED revision are checked.** An intermediate revision that named the
 * reader and has since been edited past is not — it can neither be run nor
 * armed, but a REPLAY of an old execution would still resolve against it. So
 * this answers "would deleting this break something somebody can run today",
 * which is the question the delete button is asking, and not "has this reader
 * ever been used".
 *
 * ⚠ **One definition, two callers.** `scenarios/catalogue-seed.ts` had this
 * algorithm inline, comments and all, and `--prune` deletes on the strength of
 * it. Two copies of "is this reader still referenced" drift in the direction
 * where the untested one says no — and the answer "no" is the destructive one
 * (D-197).
 */
async function referencingFlows(workspaceId: string, ref: string): Promise<string[]> {
  const names = new Set<string>();
  for (const f of await flowRepo.listByWorkspace(workspaceId)) {
    for (const n of [f.draftRevision, f.armedRevision]) {
      if (n == null) continue;
      const rev = await flowRepo.getRevision(f.id, n);
      const model = (rev?.modelJson ?? {}) as { steps?: Array<{ ref?: string }> };
      if ((model.steps ?? []).some((st) => st.ref === ref)) {
        names.add(f.name);
        break;
      }
    }
  }
  return [...names];
}

export const dbOperationService = {
  async list(workspaceId: string, dsId: string) {
    const ds = await assertDatasource(workspaceId, dsId);
    const rows = await dbOperationRepo.listByDatasource(dsId);
    return rows.map((op) => toPublic(op, ds.name));
  },

  async get(workspaceId: string, dsId: string, name: string) {
    const ds = await assertDatasource(workspaceId, dsId);
    const found = (await dbOperationRepo.listByDatasource(dsId)).find((op) => op.name === name);
    return found ? toPublic(found, ds.name) : undefined;
  },

  async create(
    workspaceId: string,
    dsId: string,
    input: z.infer<typeof dbOperationBodySchema>,
  ) {
    const ds = await assertDatasource(workspaceId, dsId);

    // A create is not an upsert: over HTTP a silent overwrite would replace the
    // spec a `query` step was approved against without the caller seeing they
    // had hit an existing name (same reasoning as D-27's 409 on a duplicate
    // template name, and the named queries' create).
    const existing = (await dbOperationRepo.listByDatasource(dsId)).find(
      (op) => op.name === input.name,
    );
    if (existing) {
      throw httpError(
        `datasource "${ds.name}" already has an operation named "${input.name}" — PATCH it to ` +
          "change its spec, and check which approved flows reference it first",
        409,
      );
    }

    const compiled = compileOperation(input.spec, await schemaRepo.listByDatasource(dsId), { dialect: dialectOf(ds.type) });
    const dialect = await sqliteDialectFindings(ds, compiled.sql);
    if (dialect.length > 0) throw dialectRefusal(dialect);
    const created = await dbOperationRepo.create({
      workspaceId,
      datasourceId: dsId,
      name: input.name,
      description: input.description ?? null,
      specJson: input.spec,
      compiledSql: compiled.sql,
      paramsSchema: withParamProse(compiled.paramsSchema, input.paramDescriptions, input.paramDefaults, input.paramFormats),
    });
    return { operation: toPublic(created, ds.name) };
  },

  async update(
    workspaceId: string,
    dsId: string,
    name: string,
    input: z.infer<typeof dbOperationUpdateSchema>,
  ) {
    const ds = await assertDatasource(workspaceId, dsId);
    const existing = (await dbOperationRepo.listByDatasource(dsId)).find((op) => op.name === name);
    if (!existing) return undefined;

    // The MERGED spec is compiled, not the patch — a PATCH that changes only
    // the filters recompiles against the unchanged base/columns/joins, and the
    // stored `compiled_sql` always matches the stored `spec_json`.
    const spec = input.spec ?? (existing.specJson as DbOperationSpec);
    const compiled = compileOperation(spec, await schemaRepo.listByDatasource(dsId), { dialect: dialectOf(ds.type) });
    const dialect = await sqliteDialectFindings(ds, compiled.sql);
    if (dialect.length > 0) throw dialectRefusal(dialect);

    // ⚠ The authored prose is re-applied on every PATCH, and it has to be:
    // `compileOperation` re-derives `paramsSchema` from scratch, so a PATCH
    // that carried none would silently replace every sentence with
    // "lt filter on public.invoices.due_date". Absent means "keep what is
    // there", which is why the existing map is the fallback source.
    const prose =
      input.paramDescriptions ?? descriptionsOf(existing.paramsSchema as Record<string, unknown>);
    const saved = await dbOperationRepo.update(dsId, name, {
      description: input.description ?? existing.description,
      specJson: spec,
      compiledSql: compiled.sql,
      paramsSchema: withParamProse(
        compiled.paramsSchema,
        prose,
        input.paramDefaults ?? defaultsOf(existing.paramsSchema as Record<string, unknown>),
        input.paramFormats ?? formatsOf(existing.paramsSchema as Record<string, unknown>),
      ),
    });
    return saved ? { operation: toPublic(saved, ds.name) } : undefined;
  },

  referencingFlows,

  /**
   * Delete a saved reader — **refusing while a flow still names it**.
   *
   * ── ⚠ Why the refusal, and why it is not merely a warning ───────────────────
   *
   * A flow resolves a reader by REF at execution. Deleting one a flow names
   * does not fail the edit, the compile or the deploy — it fails the run, later,
   * with a resolution error naming a ref nobody can find, on a flow that may
   * well be armed and firing on a schedule at 03:00. The person who deleted it
   * is not the person who finds out. So the check belongs here, at the one
   * moment somebody is looking at the consequence.
   *
   * ⚠ **`force` is a parameter and NOT a field on any schema.** A caller may
   * decide to break a flow deliberately — that is a real situation, and a
   * refusal with no way past it is a control people route around. What it must
   * never be is a default, or something a request body can assert on its own
   * without the refusal having been shown first. Same shape as D-44's
   * `verifyVia`: the way past a gate is an argument the call site passes, never
   * a key the caller sends.
   *
   * ⚠ Returns `{ ok: false, referencedBy }` rather than throwing, because the
   * flow names ARE the answer — the route renders them and the person decides.
   * A bare 409 would say "no" and leave them to find out which flow themselves,
   * which on this deployment means reading `flow_steps` by hand.
   */
  async remove(
    workspaceId: string,
    dsId: string,
    name: string,
    opts: { force?: boolean } = {},
  ): Promise<{ ok: true; removed: boolean } | { ok: false; referencedBy: string[] }> {
    const ds = await assertDatasource(workspaceId, dsId);
    if (!opts.force) {
      const referencedBy = await referencingFlows(workspaceId, `${ds.name}.${name}`);
      if (referencedBy.length) return { ok: false as const, referencedBy };
    }
    return { ok: true as const, removed: await dbOperationRepo.remove(dsId, name) };
  },

  /**
   * Compile without saving — the authoring UI's preview and validation surface.
   * Always resolves (200); `ok: false` carries the structured findings.
   */
  async check(workspaceId: string, dsId: string, spec: DbOperationSpecInput) {
    const ds = await assertDatasource(workspaceId, dsId);
    try {
      const compiled = compileOperation(spec, await schemaRepo.listByDatasource(dsId), { dialect: dialectOf(ds.type) });
      const dialect = await sqliteDialectFindings(ds, compiled.sql);
      if (dialect.length > 0) return { ok: false as const, problems: dialect };
      return {
        ok: true as const,
        compiledSql: compiled.sql,
        paramsSchema: compiled.paramsSchema,
        // ── ⚠ FR-026. The HUMAN-DRIVEN builder is a beneficiary, not a bystander ──
        //
        // `check()` is what the existing `DbOperationsPanel` already calls, so
        // adding these here gives the readback to the person building an
        // operation by hand as well as to the one reviewing a proposal. A
        // readback that only PROPOSALS carried would be two review standards for
        // one artefact, picked by who happened to author it — and the weaker
        // standard would be the one applied to the specs nobody proposed.
        //
        // ⚠ The `ok: false` branch below is deliberately UNCHANGED. A spec that
        // will not compile has no readback: rendering one from an invalid spec is
        // a confident English sentence describing something that cannot run.
        readback: readback(spec),
        outputColumns: compiled.outputColumns,
        // ⚠ Travels with the readback because the readback is where a person
        // decides. `db-operation-readback.ts` is PURE — it sees the spec and
        // never the schema — so it cannot know two tables share a column name;
        // this is the half of the review that needs the introspection, carried
        // beside it rather than computed twice.
        ambiguousColumns: compiled.ambiguousColumns,
      };
    } catch (e) {
      const findings = (e as { findings?: OperationCompileFinding[] }).findings;
      if (!findings) throw e;
      return { ok: false as const, problems: findings };
    }
  },
};

/**
 * builder-behaviour P7 (R23): the unit a computed column counts in, read from its OWN computation — a difference in minutes is minutes,
 * in working minutes is working minutes, in days is days. Exact, never from the column's name; anything else declares none.
 */
export function timeUnitOfCompute(compute: unknown): "minutes" | "business_minutes" | "days" | undefined {
  if (!compute || typeof compute !== "object") return undefined;
  if ("diffMinutes" in compute) return "minutes";
  if ("businessMinutes" in compute) return "business_minutes";
  if ("diffDays" in compute) return "days";
  return undefined;
}
