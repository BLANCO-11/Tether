/**
 * The PLAIN-ENGLISH READBACK of a `DbOperationSpec` — FR-022, FR-023.
 *
 * ── Why this module exists ───────────────────────────────────────────────────
 *
 * The approval that makes a proposed operation safe is a **person** saying yes.
 * The first version of that surface led with the compiled SQL, which is a review
 * screen written for a reviewer this feature does not have: the whole premise is
 * that the author never writes SQL, so leading with SQL makes the approval
 * unfalsifiable — a person who cannot read it cannot refuse a bad proposal, and
 * a "yes" that cannot be a "no" is not an approval (plan Decision 10).
 *
 * Sample rows were considered as the alternative and REJECTED, with evidence:
 * they were built here once (`lib/mock-rows.ts`, `lib/mockdb.ts`) and deleted.
 * Synthetic rows cannot discriminate a right query from a wrong one on join
 * kind, filter operator, a missing COALESCE or units — and they are WORSE than
 * opaque SQL, because they manufacture confidence. FR-024 forbids them.
 *
 * So the readback states, in words, the decisions that ARE decidable from the
 * spec alone. It is deliberately not a summary and not a paraphrase: every
 * clause corresponds to a part of the spec, and a reader comparing them can find
 * the disagreement.
 *
 * ── Three rules this module obeys ────────────────────────────────────────────
 *
 *  1. **A model never writes any of this.** A model describing its own work is
 *     `generation-audit.service.ts` with a new name, and `flow-refine.service.ts`
 *     already states the rule: *"The model returns an edited flow and says
 *     nothing about what it changed."* Every sentence here is a constant in this
 *     file or an identifier out of the spec.
 *
 *  2. **PURE, and a leaf.** No zod, no repository, no `inference`, no I/O — the
 *     same shape `flow-model-findings.ts` and `flow-expression-rules.ts` take.
 *     The ONLY import is `import type`, which is erased at compile time, so this
 *     module has no runtime dependency on anything at all. That is what makes
 *     the purity assertion in its test a statement about the module rather than
 *     about the test.
 *
 *  3. **ONE implementation.** A second, client-side renderer would be a second
 *     definition of what a spec means, and the two would drift in the direction
 *     where the screen and the SQL disagree (FR-022). `check()` returns this;
 *     nothing re-derives it.
 *
 * ⚠ **What this CANNOT check, and must not be read as checking**: units and
 * business meaning. *"amount"* in cents where the report says dollars renders
 * identically either way. FR-025 puts that on the test run and its expectations,
 * and the review surface has to say so — a readback a person has approved is not
 * a verified query.
 */

// ⚠ `import type` ONLY — see rule 2 above. Making this a value import would give
// this module `db-operation.service.ts`'s repositories, transitively, and the
// purity control in the test would then be asserting nothing.
import type { DbOperationSpecInput } from "./db-operation.service.js";

// ── The spec's own vocabulary, derived rather than restated ──────────────────
//
// ⚠ These are read OFF the spec type, not re-declared. `FILTER_OPS`,
// `JOIN_KINDS`, `SORT_DIRS` and `AGGREGATES` live in `db-operation.service.ts`
// as the zod enums, and a second literal list here would be a second answer to
// "which operators exist" — the drift would surface as an operator that
// compiles to SQL and renders as `undefined` on the approval screen.
type ColumnSpec = DbOperationSpecInput["columns"][number];
type Aggregate = NonNullable<ColumnSpec["aggregate"]>;
type JoinKind = NonNullable<DbOperationSpecInput["joins"]>[number]["kind"];
type FilterOp = NonNullable<DbOperationSpecInput["filters"]>[number]["op"];
type SortDir = NonNullable<DbOperationSpecInput["sort"]>[number]["dir"];

export interface ReadbackClause {
  label: "From" | "Kept when" | "You get" | "Ordered by" | "At most";
  text: string;
  /**
   * Where a decision's CONSEQUENCE is stated, as opposed to the decision. This
   * is the field FR-023 exists for: `kind: "inner"` and `kind: "left"` produce
   * the same `text` and DIFFERENT notes, and that difference is the single most
   * valuable thing on the screen.
   */
  note?: string;
}

/**
 * ⚠ Exhaustive BY CONSTRUCTION. `Record<FilterOp, string>` fails to compile the
 * moment an operator is added to `FILTER_OPS` without words here — which is the
 * point. A `switch` with a `default:` is how a new operator ships with no
 * sentence describing it, renders as something generic, and gets approved.
 *
 * ⚠ **No two phrases may collapse.** FR-023 names `lt`/`lte` because that pair
 * is the one a person is most likely to get wrong and least likely to notice:
 * an off-by-one-day boundary looks right in every sample of rows. `like` says
 * what `%` does because a pattern with no wildcard matches nothing and reads as
 * though it should match everything.
 */
const FILTER_PHRASE: Record<FilterOp, string> = {
  eq: "is EXACTLY the value you supply",
  neq: "is ANYTHING EXCEPT the value you supply",
  gt: "is AFTER the value you supply — for a number, GREATER THAN it",
  gte: "is ON OR AFTER the value you supply — for a number, GREATER THAN OR EQUAL TO it",
  lt: "is BEFORE the value you supply — for a number, LESS THAN it",
  lte: "is ON OR BEFORE the value you supply — for a number, LESS THAN OR EQUAL TO it",
  in: "is ONE OF the values you supply",
  like: "MATCHES the text pattern you supply — % stands for any run of characters",
  ilike: "MATCHES the text pattern you supply however it is capitalised — % stands for any run of characters",
  is_null: "is EMPTY — no value is supplied for this one",
  is_not_null: "is FILLED IN — no value is supplied for this one",
  month: "falls in the calendar month of the date you supply — any day of that month",
};

/** A filter compared with a NUMBER the rule fixes (`value`), in words — the number itself, never "the value you supply". */
const CONSTANT_PHRASE: Partial<Record<FilterOp, (n: number | boolean | string) => string>> = {
  eq: (n) => `is EXACTLY ${n}`,
  neq: (n) => `is ANYTHING EXCEPT ${n}`,
  gt: (n) => `is GREATER THAN ${n}`,
  gte: (n) => `is ${n} OR MORE`,
  lt: (n) => `is LESS THAN ${n}`,
  lte: (n) => `is ${n} OR LESS`,
};
/** One filter's comparison in words: a fixed number as itself, a supplied value with the parameter that carries it. */
const phraseOf = (f: { op: FilterOp; param?: string; value?: number | boolean | string; against?: string }): string =>
  f.against !== undefined && CONSTANT_PHRASE[f.op] ? CONSTANT_PHRASE[f.op]!(`its own \`${f.against}\``) : f.value !== undefined && CONSTANT_PHRASE[f.op] ? CONSTANT_PHRASE[f.op]!(typeof f.value === "string" ? `“${f.value}”` : f.value) : `${FILTER_PHRASE[f.op]}${f.param === undefined ? "" : ` (${f.param})`}`;

/**
 * ⚠ The join note is the other half of FR-023, and it is the trap with the
 * highest cost: an `inner` join where `left` was meant silently drops every row
 * whose match is missing. A monthly report over 300 invoices quietly becomes a
 * report over 280, every number in it is internally consistent, and nothing
 * anywhere reports a problem.
 *
 * Both notes name BOTH tables. "rows are left out" is true of every inner join
 * ever written and tells the reader nothing they can check; *"invoices with no
 * matching row in customers are left out"* is a sentence a person who knows
 * their own data can agree or disagree with.
 */
const JOIN_NOTE: Record<JoinKind, (base: string, joined: string) => string> = {
  inner: (base, joined) => `${base} with no matching row in ${joined} are LEFT OUT of the result`,
  left: (base, joined) =>
    `${base} with no matching row in ${joined} are KEPT, with the ${joined} columns blank`,
};

/** Both readings, because the spec does not carry the column's type. */
const SORT_PHRASE: Record<SortDir, string> = {
  asc: "smallest first — for dates, earliest first",
  desc: "largest first — for dates, most recent first",
};

const AGGREGATE_PHRASE: Record<Aggregate, string> = {
  count: "how MANY",
  sum: "the TOTAL of",
  avg: "the AVERAGE of",
  min: "the SMALLEST",
  max: "the LARGEST",
};

function qualified(schema: string | undefined, table: string): string {
  return schema ? `${schema}.${table}` : table;
}

/**
 * Render a spec as clauses a person can check against what they asked for.
 *
 * ⚠ Takes the INPUT shape, not the parsed one: `joins`/`filters`/`sort` carry
 * zod `.default([])`, which only applies on `.parse()`, and `compileOperation`
 * normalises them itself for exactly the same reason. A readback that crashed on
 * a partial spec would be a readback the proposal loop could not show while it
 * was still deciding.
 */
export function readback(spec: DbOperationSpecInput): ReadbackClause[] {
  const joins = spec.joins ?? [];
  const filters = spec.filters ?? [];
  const having = spec.having ?? [];
  const sort = spec.sort ?? [];
  const base = qualified(spec.base.schema, spec.base.table);
  const out: ReadbackClause[] = [];
  // What a computed value MEANS, in words — the compiler remains the only place that says how it is spelled. Declared before
  // every clause that reads one (a computed column, and since 2026-10-01 a filter on a computed value).
  type ValueWords = { column?: string; param?: string; addDays?: unknown; diffDays?: unknown; diffMinutes?: unknown; greatest?: unknown; least?: unknown; businessMinutes?: unknown; coalesce?: unknown; arith?: unknown; percent?: unknown };
  const wordsFor = (node: ValueWords): string => {
    if (typeof node?.column === "string") return node.column;
    if (typeof node?.param === "string") return `the ${node.param} you supply`;
    if (typeof (node as { number?: unknown })?.number === "number") return String((node as { number: number }).number);
    const n = node as {
      addDays?: { value: ValueWords; days: ValueWords };
      diffDays?: { start: ValueWords; end: ValueWords };
      diffMinutes?: { start: ValueWords; end: ValueWords };
      greatest?: { first: ValueWords; second: ValueWords };
      least?: { first: ValueWords; second: ValueWords };
      businessMinutes?: { start: ValueWords; end: ValueWords };
      coalesce?: ValueWords[];
      arith?: { op: "add" | "subtract" | "multiply" | "divide"; left: ValueWords; right: ValueWords };
      percent?: { part: ValueWords; whole: ValueWords };
    };
    if (n.addDays) return `${wordsFor(n.addDays.value)} plus ${wordsFor(n.addDays.days)} days`;
    if (n.diffDays) return `the days from ${wordsFor(n.diffDays.start)} to ${wordsFor(n.diffDays.end)}`;
    if (n.diffMinutes) return `the minutes from ${wordsFor(n.diffMinutes.start)} to ${wordsFor(n.diffMinutes.end)}`;
    if (n.greatest) return `the later of ${wordsFor(n.greatest.first)} and ${wordsFor(n.greatest.second)}`;
    if (n.least) return `the earlier of ${wordsFor(n.least.first)} and ${wordsFor(n.least.second)}`;
    if (n.businessMinutes) return `the business minutes (Mon–Fri 09–17 UTC) from ${wordsFor(n.businessMinutes.start)} to ${wordsFor(n.businessMinutes.end)}`;
    if (Array.isArray(n.coalesce)) return n.coalesce.map(wordsFor).join(", else ");
    if (n.arith) return `(${wordsFor(n.arith.left)} ${({ add: "plus", subtract: "minus", multiply: "times", divide: "divided by" } as const)[n.arith.op]} ${wordsFor(n.arith.right)})`;
    if (n.percent) return `${wordsFor(n.percent.part)} as a percentage of ${wordsFor(n.percent.whole)}`;
    return "a computed value";
  };
  // ── From ──────────────────────────────────────────────────────────────────
  out.push({ label: "From", text: base });
  for (const j of joins) {
    if (!j.latestOne) {
      const extra = (j.andOn ?? []).map((e) => `${e.left} = ${j.table}.${e.right}`).join(" and ");
      out.push({
        // The join condition is in, technical-looking as it is: `customer_id =
        // customers.id` is the part most likely to be wrong, and a person who
        // knows their data recognises their own key names.
        text: `each row matched to ${j.table}, by ${j.onLeft} = ${j.table}.${j.onRight}${extra ? ` and ${extra}` : ""}`,
        label: "From",
        note: JOIN_NOTE[j.kind](base, j.table),
      });
      continue;
    }
    // A latest-row lookup reads differently: at most `limit` rows per outer
    // row, newest first, and the inner conditions are part of the lookup —
    // they take supplied values, so they read here rather than under
    const lo = j.latestOne;
    const loFilters = lo.filters ?? [];
    const loOrder = lo.orderBy.map((o) => `${o.column} ${o.dir ?? "desc"}`).join(", ");
    out.push({
      label: "From",
      text:
        `each row matched to the LATEST ${lo.limit ?? 1} ${j.table} row(s) where ${j.onLeft} = ${j.table}.${j.onRight}` +
        `${lo.orUnmatched ? " (or the fallback row where it is empty)" : ""}` +
        `${loFilters.length > 0 ? ` and ${loFilters.map((f) => `${f.column} ${phraseOf(f as never)}`).join(" and ")}` : ""}` +
        `, newest by ${loOrder} first`,
      note: JOIN_NOTE[j.kind](base, j.table),
    });
  }
  const aggregateJoins = spec.aggregateJoins ?? [];
  for (const j of aggregateJoins) {
    out.push({
      // The subquery's own filters read below under "Kept when" — they take
      // supplied values, so burying them in the join sentence would hide what
      // the run needs. The grouping key is in because joining totals to the
      // wrong key is the mistake this sentence exists to catch.
      text:
        `each row matched to the ${j.table} totals${(j.through ?? []).length ? ` — each ${j.table} row joined to ${(j.through ?? []).map((t) => `its ${t.table} (${t.onLeft} = ${t.table}.${t.onRight})`).join(", then ")}, and counted only where it has one —` : ""} grouped by ${j.groupBy}, ` +
        `computing ${j.aggregates.map((a) => `${a.alias} ← ${a.aggregate}${a.column ? ` of ${a.column}` : ""}`).join(" · ")}` +
        `${(j.filters ?? []).length > 0 ? ` where ${(j.filters ?? []).map((f) => `${f.column} ${phraseOf(f as never)}`).join(" and ")}` : " over every row"}`,
      label: "From",
      note: JOIN_NOTE[j.kind](j.table, j.table),
    });
  }

  // ── Kept when ─────────────────────────────────────────────────────────────
  //
  // ⚠ The empty case gets a clause, not silence. An operation with no filter
  // reads the whole table, and "nothing is written under Kept when" is
  // indistinguishable on a screen from "this section did not render".
  if (filters.length === 0) {
    out.push({
      label: "Kept when",
      text: "EVERY row — this operation has no filter",
      note: "nothing is excluded, and no value is supplied when it runs",
    });
  } else {
    // Same grouping as the compiler: one OR term per `orGroup`, ANDed with
    // the rest, first-appearance order. The test pins agreement on the SQL.
    const seen = new Set<string>();
    for (const f of filters) {
      const phrase = `${f.column ?? wordsFor(f.compute as ValueWords)} ${phraseOf(f as never)}`;
      if (f.orGroup === undefined) {
        out.push({ label: "Kept when", text: phrase });
        continue;
      }
      if (seen.has(f.orGroup)) continue;
      seen.add(f.orGroup);
      out.push({
        label: "Kept when",
        text: filters.filter((g) => g.orGroup === f.orGroup).map((g) => `${g.column ?? wordsFor(g.compute as ValueWords)} ${phraseOf(g as never)}`).join(" — OR — "),
      });
    }
    for (const h of having) {
      out.push({ label: "Kept when", text: `${h.aggregate}(${h.column}) ${FILTER_PHRASE[h.op]} (${h.param}) — after summarising` });
    }
  }

  // ── You get ───────────────────────────────────────────────────────────────
  const aggregated = spec.columns.filter((c) => c.aggregate !== undefined);
  const plain = spec.columns.filter((c) => c.aggregate === undefined);
  // A computed expression reads in words, not SQL: the approval screen says
  // what the value MEANS, and the compiler remains the only place that says
  // how it is spelled.
  out.push({
    label: "You get",
    text:
      (spec.distinct ? "DISTINCT " : "") +
      spec.columns
        .map((c) => {
          const what = c.aggregate
            ? `${AGGREGATE_PHRASE[c.aggregate]}${c.aggregateDistinct ? " DISTINCT" : ""} ${c.column ?? wordsFor(c.compute as ValueWords)}`
            : c.compute !== undefined
              ? wordsFor(c.compute as ValueWords)
              : (c.column as string);
          return `${c.alias} ← ${what}`;
        })
        .join(" · "),
    // plain columns only when the select list MIXES aggregated and plain ones,
    // and emits no GROUP BY when every column is aggregated (one row in total).
    //
    // ⚠ That is the same rule in a second place, which this repo normally
    // refuses. It is allowed here because the test asserts the two AGREE —
    // `compileOperation` is pure, so the readback's claim is checked against the
    // presence of `GROUP BY` in the SQL it actually emits, not against a copy of
    // the rule. Delete that test and this comment becomes a lie.
    ...(aggregated.length === 0
      ? {}
      : plain.length === 0
        ? { note: "ONE row in total — every matching row is summarised into it" }
        : {
            note:
              `one row per distinct combination of ${plain.map((c) => c.alias).join(" · ")} — ` +
              `the summarised columns are computed across the rows that share it`,
          }),
  });

  // ── Ordered by ────────────────────────────────────────────────────────────
  //
  // ⚠ Also a clause when empty, and the note ESCALATES when a limit exists.
  // "the first 500" of an unordered result is an arbitrary 500 that can differ
  // between two runs over identical data — a flow that looks stable in a test
  // run and is not. `spec.limit` is the only thing that makes it matter.
  if (sort.length === 0) {
    out.push({
      label: "Ordered by",
      text: "NOTHING — the database may return these rows in any order",
      ...(spec.limit === undefined
        ? {}
        : {
            note:
              `⚠ with a limit of ${spec.limit} and no order, WHICH ${spec.limit} rows you get is ` +
              `arbitrary and can change between runs over identical data`,
          }),
    });
  } else {
    for (const s of sort) out.push({ label: "Ordered by", text: `${s.column}, ${SORT_PHRASE[s.dir]}` });
  }

  // ── At most ───────────────────────────────────────────────────────────────
  //
  // ⚠ `compileOperation` emits no LIMIT when the spec has none, and nothing
  // downstream adds one — so an unbounded operation is unbounded, and its
  // response feeds a `query` step whose callback is capped at 5 MiB. That
  // succeeds on a small table and fails outright on a large one, which is the
  // failure shape this programme has hit twice already.
  out.push(
    spec.limit === undefined
      ? {
          label: "At most",
          text: "NO LIMIT — every matching row is returned",
          note: "a table that grows can make this too large to carry between steps",
        }
      : { label: "At most", text: `${spec.limit} row${spec.limit === 1 ? "" : "s"}` },
  );

  return out;
}
