/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PROPOSING a DB operation — the one place a model touches a database read
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A datasource onboarded ten minutes ago has an introspected schema and **no
 * readable components**, so no flow can read it until a person hand-builds a
 * named query or a DB operation. This module closes that, and it is deliberately
 * the smallest possible thing that can:
 *
 *   **the model fills in a form; it does not write SQL.**
 *
 * The form is a `DbOperationSpec` — base table, columns, joins, filters, sort,
 * limit — and `compileOperation` turns it into a read-only `SELECT`. That is not
 * a stylistic choice, it is the entire safety argument (D-169):
 *
 *   * every identifier is resolved against the introspected `schemas` rows, so a
 *     table or column the datasource does not have is a STRUCTURED finding, not
 *     interpolated text;
 *   * every value is a positional `$n` parameter, so a filter's value can never
 *     become SQL;
 *   * the compiler emits `SELECT` and nothing else, and `checkSqlShape` refuses
 *     anything write-shaped before it can be stored or previewed.
 *
 * ⚠ **`generation-audit.service.ts` was deletable only because `datasource` steps
 * run reviewed SQL rather than generated SQL.** This module is the closest this
 * system comes to reopening that, and it stays closed by the property above: no
 * text a model writes reaches a database. What it writes is a form, and the form
 * is compiled.
 *
 * ── What this module may see, and why the list is short (FR-005) ─────────────
 *
 * ONE datasource's stored introspected schema, the need statement, and the names
 * already taken on that datasource. **And nothing else.** Specifically NOT: a
 * DSN or connection string, a database handle, any row of data, another
 * datasource's schema, the automation goal, or the flow model.
 *
 * ⚠ The row exclusion is D-54's rule, and it is not squeamishness. Shown real
 * rows to imitate, the output stops being derived from the schema and starts
 * being derived from a sample — and a sample is not a specification. It is also
 * why `datasourceRepo` is **not** imported here: `datasourceRepo.get` returns the
 * row *including* `connectionString`, which would put the one forbidden field a
 * property access away. The 404 for an unknown datasource therefore belongs to
 * the ROUTE, which has `datasourceService.get` — a view that never returns it.
 *
 * ⚠ FR-006 asserts this against **this file's own source**, not against
 * behaviour. A behavioural test passes just as well when a field is present and
 * merely unused, and the next person to touch the function will use it.
 *
 * ── Two channels, and the refusal is the valuable one (D-171) ────────────────
 *
 * `insufficient_schema` is an HTTP **200 success** and is **never retried**, the
 * same rule `insufficient_contract` and `insufficient_catalogue` follow. Re-asking
 * is how *"no column in this schema carries a date"* becomes a plausible-looking
 * `created_at` on attempt 2 — a spec that compiles, runs, returns rows, and
 * answers a different question than the one asked.
 *
 * A `check()` finding is the OTHER kind of answer and IS retried, fed back
 * **verbatim** — I-57, where 25 of 26 findings were a scanner bug handed to a
 * model as fact. Nothing here paraphrases a finding or adds a suggestion to it.
 */

import { strictFromZod, stripNulls, unwrapRoot } from "./strict-from-zod.js";
import { z } from "zod";
import { schemaRepo, type SchemaRow } from "../repositories/schema.repo.js";
import { dbOperationRepo } from "../repositories/db-operation.repo.js";
import { datasourceQueryRepo } from "../repositories/datasource-query.repo.js";
import {
  AGGREGATES,
  FILTER_OPS,
  ARITH_OPS,
  specParamOrder,
  COMPUTED_FILTER_OPS,
  JOIN_KINDS,
  SORT_DIRS,
  dbOperationBodySchema,
  dbOperationSpecSchema,
  canonicalSpec,
  dbOperationService,
  type DbOperationSpec,
  type ColumnAmbiguity,
} from "./db-operation.service.js";
import { inference, InferenceError, type InferenceClient } from "./inference.service.js";
import { PROVENANCE_DECLARATION, wrapUntrusted } from "../prompt-boundary/envelope.js";
import type { ReadbackClause } from "./db-operation-readback.js";

function httpError(message: string, statusCode: number, extra?: Record<string, unknown>) {
  return Object.assign(new Error(message), { statusCode, ...extra });
}

/**
 * The output ceiling for ONE PROPOSAL — a small JSON form, not a program.
 *
 * ⚠ Kept here rather than beside `FRAGMENT_MAX_TOKENS` and `DRAFT_MAX_TOKENS` in
 * `inference.service.ts` because it belongs with the attempt bound it is read
 * next to. If a FOURTH caller appears, move all four back together: the argument
 * in that module's docblock — that one shared ceiling made a large draft run to
 * the limit and be discarded whole — is about them being chosen deliberately, not
 * about where they live.
 */
// 20000 (same ceiling as builder:plan): a reasoning model spends the budget on thinking too.
// At 2048 a two-summary read ran out before writing a word (2026-10-01). At 8192 a three-band
// absence read burned the whole window on reasoning with finish_reason=length and empty content
// (HR A01, 2026-10-06) — three attempts × ~40s, then a false "gateway unreachable".
const PROPOSAL_MAX_TOKENS = 20000;

/**
 * ⚠ Same shape and same reason as `MAX_DRAFT_ATTEMPTS` and
 * `MAX_FRAGMENT_ATTEMPTS`. Attempts are spent on `check()` findings — a
 * mechanical mistake worth re-asking about — and NEVER on a refusal.
 */
const MAX_PROPOSAL_ATTEMPTS = 3;

/**
 * FR-014 — how many operations may be proposed for one generation or one chat
 * turn. **The approval-fatigue control.**
 *
 * ⚠ **Enforced by the SURFACES (T13, T21), not here, and that is forced rather
 * than chosen.** One propose call has no notion of "this generation": the server
 * holds no proposal state at all, because D-170 forbids persisting a proposal and
 * D-179 forbids a turn storing one. A server-side counter would be that state
 * under another name.
 *
 * ⚠ **Never silently truncate** (`step-payload-bounds` FR-012). A surface that
 * stops offering proposals without saying it has stopped reads as *"there is
 * nothing more to propose"* — which is the opposite of true, and the reader has
 * no way to tell. The bound must be on screen.
 *
 * ⚠ Do not delete this as premature. A person clicking through a queue of
 * proposals is exactly the state where SC-006's acceptance rate stops meaning
 * anything: high acceptance then reads identically whether the proposals are
 * good or nobody is reading them.
 */
export const MAX_PROPOSALS_PER_REQUEST = 3;

// ── The two response channels ────────────────────────────────────────────────

export interface OperationProposalOk {
  status: "ok";
  /** Editable BEFORE creation; immutable after, because it is half of every ref. */
  name: string;
  description: string;
  spec: DbOperationSpec;
  /** ⚠ The PRIMARY review artefact (FR-011). Pure code, never a model. */
  readback: ReadbackClause[];
  outputColumns: Array<{ alias: string; source: string; type: string | null; nullable?: boolean }>;
  /** Bare column names two joined tables could both have meant, with the winner.
   *  ⚠ Carried so the REVIEW surface can show it — a proposal is exactly where a
   *  person is deciding, and a choice the compiler made on their behalf that no
   *  screen renders is a value computed and discarded (I-120). */
  ambiguousColumns: ColumnAmbiguity[];
  /**
   * The THIRD answer (2026-10-01): a read, AND what it had to interpret or could not give. Before it the proposer could only answer
   * all or nothing — so a goal with one word the data lacks was refused whole ("annual leave with deductions"), and a word it chose
   * a meaning for ("deductions" → annual leave days) was a guess nobody saw. Each carries the need's own words, for the caller to
   * check against the person's text and ask about.
   */
  assumed: Array<{ words: string; as: string }>;
  leftOut: Array<{ words: string; why: string }>;
  /** The need's words that state a parameter's value — checked against the person's text by the caller, never trusted. */
  values: Array<{ param: string; words: string }>;
  /** The need's words this read itself DOES (a definition, a condition, a total) — checked as the person's, then stated in the readback. */
  covers: string[];
  /** Available, collapsed — not the primary artefact. */
  compiledSql: string;
  paramsSchema: Record<string, unknown>;
  /** Inference calls spent. Greater than 1 means `check()` findings were fed back. */
  attempts: number;
  /**
   * `MAX_PROPOSALS_PER_REQUEST`, travelling with the response.
   *
   * ⚠ On BOTH channels, and not for symmetry: FR-014 requires the bound to be on
   * screen, and a surface that hardcoded the number would be a second definition
   * of it — the two would drift, and the screen would state a bound the server
   * does not hold. A refusal is still one of the N, so it carries it too.
   */
  maxPerRequest: number;
}

export interface OperationProposalRefusal {
  status: "insufficient_schema";
  missing: string[];
  reason: string;
  /** See `OperationProposalOk.maxPerRequest` — a refusal spends one of the N too. */
  maxPerRequest: number;
}

export type OperationProposal = OperationProposalOk | OperationProposalRefusal;

/**
 * ⚠ A status-less response is REJECTED, never read as `ok` — `parseFragmentResponse`'s
 * own warning. A bare spec object with no `status` would be read as a proposal and
 * the refusal channel would quietly stop existing, which is the failure this
 * whole module is shaped around.
 */
const proposalResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    // Validated properly below against `dbOperationBodySchema`'s own rule rather
    // than a second copy of the identifier regex — one definition of what a name
    // may be, or the save refuses something the proposal offered.
    name: z.string().min(1).max(255),
    description: z.string().max(10_000).optional(),
    spec: dbOperationSpecSchema,
    /** The need's words the read had to INTERPRET — no column, table or value says them — and what they were read as. */
    assumed: z.array(z.object({ words: z.string().min(1).max(200), as: z.string().min(1).max(300) })).max(8).default([]),
    /** The need's words the schema cannot give: the read is written for the rest. */
    left_out: z.array(z.object({ words: z.string().min(1).max(200), why: z.string().min(1).max(300) })).max(8).default([]),
    /** For a parameter whose value the need's words STATE, those words ("9.5+ hours" for full_day_hours) — never a value you chose. */
    values: z.array(z.object({ param: z.string().min(1).max(64), words: z.string().min(1).max(200) })).max(16).default([]),
    /** The need's words the read itself carries out — its filters, joins, totals and definitions — copied exactly. */
    covers: z.array(z.union([z.string().min(1).max(300), z.object({ words: z.string().min(1).max(300), by: z.array(z.string().min(1).max(200)).max(8).default([]) })])).max(16).default([]),
    /** The need's words that are not about the data at all — when it runs, how the rows are sent. */
    others: z.array(z.object({ words: z.string().min(1).max(200), why: z.string().min(1).max(300) })).max(16).default([]),
  }),
  z.object({
    status: z.literal("insufficient_schema"),
    missing: z.array(z.string().min(1).max(200)).min(1).max(16),
    reason: z.string().min(1).max(1000),
  }),
]);

/**
 * The reply's SHAPE as a strict JSON Schema, derived from `proposalResponseSchema` (P1-I2): sent as `response_format`, so the
 * gateway decodes only a reply of this shape — malformed JSON, a missing `status` or an unknown property cannot come back, and no
 * attempt is spent on one. Zod still checks every rule on the parsed reply.
 */
export const PROPOSAL_STRICT = strictFromZod(proposalResponseSchema);

export const needSchema = z.object({
  need: z.string().min(3).max(2000),
});

// ── Rendering the schema the proposer is allowed to see ──────────────────────

/**
 * One line per entity: its columns with types, primary keys marked, and every
 * foreign key's target named.
 *
 * ⚠ The foreign keys are the half that makes a JOIN possible at all. Without
 * them the model has to guess which column pairs relate two tables, and a guessed
 * join is the defect the readback's join note exists to catch — better not to
 * create it in the first place.
 *
 * ⚠ Entity-level rows (`columnName === null`) carry metadata only and are skipped;
 * a table with no columns still gets a line, so "this table exists and has no
 * introspected columns" is visible rather than absent.
 */
function schemaText(rows: SchemaRow[]): string {
  const byEntity = new Map<string, { schema: string | null; name: string; cols: string[] }>();
  for (const r of rows) {
    const key = `${r.entitySchema ?? ""} ${r.entityName}`;
    let e = byEntity.get(key);
    if (!e) {
      e = { schema: r.entitySchema ?? null, name: r.entityName, cols: [] };
      byEntity.set(key, e);
    }
    if (!r.columnName) continue;
    const marks: string[] = [];
    if (r.isPrimaryKey) marks.push("pk");
    if (r.isForeignKey && r.foreignKeyReference) marks.push(`fk to ${r.foreignKeyReference}`);
    // builder-behaviour P7 (R17): what the schema's OWNER declared about the column (`key`: a row's identity, `email`: an address,
    // `unit=…`) — a read that must return a row's identity or address finds it by the owner's word, never by guessing from a name.
    if (r.semanticTag) marks.push(`declared: ${r.semanticTag}`);
    e.cols.push(
      `${r.columnName}:${r.columnType ?? "unknown"}${marks.length ? ` [${marks.join(", ")}]` : ""}`,
    );
  }
  return [...byEntity.values()]
    .map((e) => {
      const name = e.schema ? `${e.schema}.${e.name}` : e.name;
      return e.cols.length
        ? `  ${name}\n${e.cols.map((c) => `    ${c}`).join("\n")}`
        : `  ${name}\n    (no introspected columns)`;
    })
    .join("\n");
}

/**
 * A compile finding as the proposer reads it on its retry: the compiler's message VERBATIM, then the schema's own facts about the
 * identifier — the columns the named table does have, and which tables of the schema do have the column (2026-10-02: F02 spent all
 * three attempts on `issue_date` under `expense_claims` because the retry was told only that it was absent, never where it lives).
 * Facts, never advice (I-57): nothing here says what the read should do, only what the schema holds.
 */
export function findingForRetry(f: { code?: string; message: string; identifier?: string; available?: string[] }, rows: readonly SchemaRow[]): string {
  if (f.code !== "unknown_column" || !f.identifier) return f.message;
  const bare = f.identifier.slice(f.identifier.lastIndexOf(".") + 1);
  const holders = [...new Set(rows.filter((r) => r.columnName === bare).map((r) => (r.entitySchema ? `${r.entitySchema}.${r.entityName}` : r.entityName)))];
  const parts = [f.message];
  if (f.available?.length) parts.push(`the columns there are: ${f.available.join(", ")}`);
  parts.push(holders.length ? `“${bare}” is a column of ${holders.join(", ")}` : `no table in the schema has a column “${bare}”`);
  return parts.join(" — ");
}

// ── The prompt ───────────────────────────────────────────────────────────────

/**
 * Block order is the draft prompt's, for the same reason: the RULES and RESPONSE
 * blocks are byte-identical for every proposal in the fleet, the datasource's
 * schema and taken names come next, and the NEED goes **last**. It buys latency
 * on the prefill, not tokens.
 *
 * ⚠ The enum lines are rendered FROM the exported arrays, never retyped. A ninth
 * filter operator added to `FILTER_OPS` reaches this prompt automatically — the
 * same pairing D-176 exists for, in the other direction: there the rule had no
 * check, here the prompt cannot fall behind the vocabulary.
 */
const PROPOSAL_RULES = [
  `You are FILLING IN A FORM that describes ONE READ from ONE database.`,
  `You are NOT writing SQL. You never see SQL, and nothing you write becomes SQL:`,
  `the form is compiled to a read-only SELECT by code, against the schema below.`,
  ``,
  `THE FORM`,
  `  base     {"table": "<table>"}   and "schema" only if the table needs qualifying`,
  `  columns  [{"column": "<col>", "alias": "<result name>", "aggregate": "<optional>"}]`,
  `  joins    [{"table": "<t>", "onLeft": "<col>", "onRight": "<col of t>", "kind": "<kind>"}]`,
  `  aggregateJoins  [{"table": "<t>", "groupBy": "<col of t>", "onLeft": "<col>", "kind": "<kind>",`,
  `                   "aggregates": [{"aggregate": "<aggregate>", "column": "<col of t, omit for count>", "alias": "<name>"}],`,
  `                   "filters": [{"column": "<col of t>", "op": "<op>", "param": "<parameter NAME>"}]}]`,
  `                   (an aggregateJoins filter may also take "value": <number, true/false or text> in place of "param")`,
  `                   and "through": [{"table": "<t2>", "onLeft": "<col of t>", "onRight": "<col of t2>"}] when the rows`,
  `                   are grouped, measured or kept by a column of a RELATED table — "groupBy": "<t2>.<col>",`,
  `                   a filter's "column": "<t2>.<col>" (each through table is joined inside the summary, inner)`,
  `  filters  [{"column": "<col>", "op": "<op>", "param": "<parameter NAME>"}]`,
  `           or, for a NUMBER the rule itself fixes: {"column": "<col>", "op": "<op>", "value": <number>}`,
  `           or, for a boolean column: {"column": "<col>", "op": "eq", "value": true} (or false)`,
  `           or, for TEXT the need says in its own words: {"column": "<col>", "op": "eq", "value": "<text>"} (eq or neq)`,
  `           or, comparing two columns of the SAME row ("the reading is above its class's maximum"): {"column": "<col>", "op": "<op>", "against": "<other col>"}`,
  `  sort     [{"column": "<col>", "dir": "<dir>"}]`,
  `  limit    a whole number`,
  ``,
  `  An aggregate may summarise a COMPUTED value instead of a column: {"aggregate": "<aggregate>", "compute": <value>, "alias": "<name>"}`,
  `           (either "column" or "compute", never both — e.g. {"aggregate": "sum", "compute": {"caseWhen": ...}, "alias": "total"})`,
  `  A <value> is one of:`,
  `    {"column": "<col>"}  — a column, or a summary's alias`,
  `    {"param": "<parameter NAME>", "type": "<number|date|datetime>"}`,
  `    {"diffDays": {"start": <value>, "end": <value>}}  — whole days from start to end (a date's age: start the date, end the day it runs)`,
  `    {"diffMinutes": {"start": <value>, "end": <value>}}  — minutes from start to end, for hours and minutes`,
  `    {"addDays": {"value": <value>, "days": <value>}}  — a date moved by a number of days (negative goes back)`,
  `    {"number": <number>}  — a number the rule itself fixes (see below)`,
  `    {"arith": {"op": "<${ARITH_OPS.join("|")}>", "left": <value>, "right": <value>}}`,
  `    {"percent": {"part": <value>, "whole": <value>}}  — part × 100 ÷ whole`,
  `    {"coalesce": [<value>, <value>]}  — the first that is not empty`,
  `    {"caseWhen": {"arms": [{"op": "<comparison>", "left": <value>, "right": <value>, "then": <value>}], "else": <value>}}  — the first arm whose test holds wins, else "else" (banded labels: thresholded bucketing of a field)`,
  ``,
  `  aggregate is one of: ${AGGREGATES.join(", ")}`,
  `  kind is one of:      ${JOIN_KINDS.join(", ")}`,
  `  op is one of:        ${FILTER_OPS.join(", ")}`,
  `  dir is one of:       ${SORT_DIRS.join(", ")}`,
  ``,
  `RULES`,
  `  * EVERY table and column you name MUST appear in the SCHEMA below, spelled exactly.`,
  `    There is nothing else to read. A table you remember from another database does not`,
  `    exist here, and a plausible column name is the one mistake with no cheap recovery.`,
  `  * A filter's "param" is a NAME, not a value — "as_of", "region", "min_amount". The`,
  `    person running the automation supplies the value. You NEVER write a date, a period,`,
  `    a threshold or any number the need STATES: a value you chose is a value nobody asked`,
  `    for, and it produces a read that succeeds and answers the wrong question.`,
  `  * A NUMBER the rule itself needs — the 0 of "count a missing summary as 0" ({"coalesce":`,
  `    [{"column": "days"}, {"number": 0}]}), a test of a boolean column ("value": true), the 100 of a`,
  `    percentage — is written as a number ("value" or {"number": …}), never as a parameter:`,
  `    a parameter is a question put to the person, and nobody should be asked what 0 is. A`,
  `    number the need STATES ("85 percent", "9.5 hours") is always a parameter, listed in`,
  `    "values" — a stated number written as a fixed one is REFUSED.`,
  `  * TEXT the need says in its own words — “active employees”, “sick leave”, “high risk” — when`,
  `    the contract gives it no parameter, is a fixed text value, spelled as the column holds it`,
  `    ("value": "Active"). Text the need does not say is never fixed: it is REFUSED.`,
  `  * A column of a JOINED table is named "<table>.<column>" — {"column": "department.name",`,
  `    "alias": "department_name"}. The "column" is always a column that EXISTS in the SCHEMA;`,
  `    "department_name" there is an alias, not a column, and is refused.`,
  `  * "alias" is the RESULT column's name. Make it readable — "customer_name", not "name2"`,
  `    — and make every alias distinct.`,
  `  * "onLeft" is a column of the base table or of an EARLIER join; "onRight" is a column`,
  `    of the table being joined. The SCHEMA marks foreign keys with their target: use them.`,
  `  * A SUMMARY of related rows — "days worked", "leave taken in the period", "how many orders" —`,
  `    is an "aggregateJoins" entry: the related table's rows are counted or totalled per`,
  `    "groupBy" key INSIDE it (its own "filters" keep only the rows to summarise, e.g. only`,
  `    the rows in the need's period), and the outer read gets ONE row per base row.`,
  `    Select its results in "columns" by their alias: {"column": "days_worked", "alias": "days_worked"}.`,
  `    A RATE or a SHARE — "loans returned late in over 20% of cases", "more than half late" — is`,
  `    one summary per kind of row (each its own "aggregateJoins" entry with its own filters:`,
  `    the days worked, the working days), a computed column over their aliases`,
  `    ({"percent": {"part": {"column": "days_present"}, "whole": {"column": "working_days"}}}),`,
  `    and a filter on that computed value against a parameter ("max_attendance_pct").`,
  `    Two summaries of two related tables are two entries. NEVER summarise by a plain join:`,
  `    joining two related tables directly multiplies the rows and every total is wrong.`,
  `  * A PERIOD is filtered the way the need states it. A calendar month — "August 2026", "for`,
  `    the month", "monthly", "this month" — is ONE "month" filter on the date column with ONE`,
  `    parameter ("period"): it reads a YYYY-MM value and keeps every day of that month. A start`,
  `    and an end ("gte"/"lte", two parameters) only when the need names a range of DAYS ("1 to`,
  `    14 August", "the last 30 days"). Never a start and end for a month: no month a person`,
  `    names is a start date, and the person would be asked for two dates they never thought of.`,
  `  * A parameter is ONLY for a value the need states (list it in "values") or one that changes`,
  `    from run to run (a period, a date). Every other parameter is a question put to the person`,
  `    before the read can run, so never invent one for what the data already says: a missing`,
  `    row, a null, a count of rows. Where the rule genuinely needs a number the need does not`,
  `    state, keep the parameter and say so in "assumed".`,
  `  * "kind" changes the ANSWER, not the style. "inner" DROPS base rows with no match;`,
  `    "left" keeps them with blanks. Pick the one the need actually describes.`,
  `  * ALWAYS set a "limit" unless the need says every row is wanted. And if you set one,`,
  `    ALSO set a "sort" — "the first 500" of an unordered read is an arbitrary 500 that`,
  `    can differ between two runs over identical data.`,
  `  * "name" is a plain identifier — lowercase letters, digits and underscores, starting`,
  `    with a letter. It becomes half of a step reference, so it must be unique on this`,
  `    datasource: it may NOT be any of the NAMES ALREADY TAKEN below.`,
  `  * "description" is one sentence for the person who will approve this.`,
  ``,
  `RESPONSE — reply with ONE json object, no prose, no markdown fence.`,
  ``,
  `  If the schema can express the need — or PART of it:`,
  `    {"status": "ok", "name": "overdue_loans",`,
  `     "description": "Loans past their due date as of a supplied date, with the borrower name.",`,
  `     "spec": {"base": {"table": "loans"}, "columns": [...], "joins": [...],`,
  `              "filters": [...], "sort": [...], "limit": 500},`,
  `     "assumed": [{"words": "late", "as": "due_date before the supplied date"}],`,
  `     "left_out": [{"words": "with penalties", "why": "no column holds a penalty"}],`,
  `     "values": [{"param": "min_days", "words": "more than 10 days"}],`,
  `     "covers": ["past their due date", "with the borrower name"]}`,
  ``,
  `  "assumed": EVERY word of the need you had to INTERPRET — no table, column or value in the`,
  `    schema says it, and you chose what it means. "words" is copied EXACTLY from the need;`,
  `    "as" says what you read it as, in the schema's terms. The person is asked to confirm`,
  `    each one: a meaning chosen without saying so is a guess nobody reviewed. Words the`,
  `    schema names directly — a table, a column, or one of a column's values ("active" for`,
  `    a status of Active), or a date or period given as a parameter — are NOT assumptions.`,
  `    [] when none.`,
  `  "values": for each PARAMETER whose value the need's words state, those words copied`,
  `    EXACTLY ("9.5+ hours" for full_day_hours). You still never write the value into the`,
  `    read; this only says where the person already gave it. [] when none is stated.`,
  `  "covers": each phrase of the need this read itself CARRIES OUT — a filter, a join, a`,
  `    total, a definition the need gives — copied EXACTLY from the need. The person is told`,
  `    the read does these. Not what happens after the rows are read. [] when none.`,
  `  "left_out": each part of the need this schema cannot give — "words" copied EXACTLY from`,
  `    the need, "why" naming what is not there. Write the read for everything else; the`,
  `    person is asked what they meant. Only DATA the need asks for: what happens to the rows`,
  `    after they are read — a file, an email, a message — is not a read's, never left_out.`,
  `    [] when nothing is left out.`,
  ``,
  `  If it CANNOT give ANY of it — the data the need asks for is not in this schema at all:`,
  `    {"status": "insufficient_schema",`,
  `     "missing": ["a due date or invoice date column"],`,
  `     "reason": "no column in the introspected schema carries a date; overdue cannot be expressed"}`,
  ``,
  `  A refusal is a correct and useful answer, not a failure — it is how a gap in this`,
  `  datasource gets noticed instead of silently papered over with the nearest column`,
  `  whose name looked close enough. Guessing is the one unrecoverable mistake: it`,
  `  produces a read that compiles, runs, returns rows, and answers a different`,
  `  question than the one asked.`,
  ``,
  `⚠ YOU HAVE NOT SEEN A SINGLE ROW OF DATA, and you are not going to. Everything`,
  `  below is schema metadata — names, types, keys. Do not describe what the data`,
  `  contains, do not estimate how many rows anything has, and do not assume units:`,
  `  a column called "amount" may be in cents.`,
].join("\n");

/** Every word of what the read is for is accounted for — code checks it (`accountingGaps`, `covers.by` against the compiled SQL). */
const ACCOUNTING = [
  `ACCOUNTING — every word of each part the need says the read is FOR (the “…” after "gives the rows for") goes`,
  `  in exactly one place, copied exactly: "covers" (the schema gives it directly — a table, a column, a value, a`,
  `  filter or join on them), "assumed" (you chose what it means), "left_out" (the schema cannot give it), "values"`,
  `  (it states a parameter's value), or "others" (it is not about the data at all — when it runs, how the rows are`,
  `  sent, who receives them — "why" says which). A word that names a thing the rows must hold (a manager, a region)`,
  `  is never "others": if no table or column holds it, it is "left_out". A word left in none of them is refused.`,
  `  Each "covers" entry is {"words": "...", "by": ["table.column", ...]} — the columns of THIS read (selected,`,
  `  joined, filtered or computed) that give those words. Words no column of the read gives are never "covers".`,
].join("\n");

/** A definition the data allows is proposed and confirmed, never refused. */
const DEFINITIONS = [
  `DEFINITIONS — the line between a refusal and a read:`,
  `  When every table and column the need is ABOUT exists, but one of its words needs a definition the schema does`,
  `  not state ("attendance percentage", "active", "late", a rate), do NOT refuse. Write the read with the plainest`,
  `  definition built ONLY from columns listed in SCHEMA, and put that word in "assumed", "as" stating the definition`,
  `  in the schema's own table and column names. The person confirms it before anything runs.`,
  `  Refuse (insufficient_schema) only when the THING itself is absent — no table or column holds it at all (a`,
  `  manager, when nothing records who manages whom). A definition is never a reason to refuse; a missing thing is.`,
].join("\n");

function buildProposalPrompt(opts: {
  need: string;
  schemaRows: SchemaRow[];
  takenNames: string[];
  findings: string[];
  revise?: { name: string; spec: DbOperationSpec };
}): string {
  const blocks = [
    PROPOSAL_RULES,
    ``,
    DEFINITIONS,
    ``,
    ACCOUNTING,
    ``,
    PROVENANCE_DECLARATION,
    ``,
    `SCHEMA — the only tables and columns that exist for this task`,
    wrapUntrusted(schemaText(opts.schemaRows), "datasource schema"),
    ``,
    `NAMES ALREADY TAKEN ON THIS DATASOURCE`,
    opts.takenNames.length ? opts.takenNames.map((n) => `  ${n}`).join("\n") : `  (none)`,
    ``,
    // A REVISION: the read already written for this need, which the person has since said more about. It is revised IN PLACE —
    // its parameters are inputs a person may already have answered, keyed by name, so a renamed one loses that answer.
    ...(opts.revise
      ? [
          `THE READ AS IT STANDS — REVISE THIS ONE; do not start again`,
          `  ${JSON.stringify(opts.revise.spec)}`,
          `  Change only what the need now says differently. KEEP every parameter whose meaning is unchanged under`,
          `  EXACTLY its current name — a person may already have given its value. Add or remove a parameter only`,
          `  when the need now asks for a different input.`,
          ``,
        ]
      : []),
    // NEED last — see the block-order note above.
    `NEED`,
    `  ${opts.need}`,
  ];

  // Findings go AFTER the need, so the first prompt stays a byte-exact prefix of
  // the retry's — the rule `buildDraftPrompt` follows for the same reason.
  if (opts.findings.length) {
    blocks.push(
      ``,
      `YOUR PREVIOUS ANSWER WAS REJECTED. Fix exactly these and reply again:`,
      ...opts.findings.map((f) => `  * ${f}`),
    );
  }
  return blocks.join("\n");
}

/**
 * Parse a proposal response into one of the two channels.
 *
 * Tolerant of a markdown fence and surrounding prose — models emit both, and
 * re-asking over formatting spends an attempt on nothing. NOT tolerant of a
 * missing `status`.
 */
export function parseProposalResponse(raw: string): z.infer<typeof proposalResponseSchema> {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the proposer returned no JSON object");

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch (e) {
    throw new Error(`the proposer returned invalid JSON: ${(e as Error).message}`);
  }

  // A strict reply arrives wrapped (a root union) and writes null for every absent optional property: both undone here, so zod
  // reads exactly what it always read. A reply that is not wrapped (a client without strict decoding) passes through unchanged.
  parsed = stripNulls(unwrapRoot(parsed, PROPOSAL_STRICT.wrapped));
  // The same read in another spelling is that read (`canonicalSpec`) — never an attempt spent on how it was written.
  if (parsed && typeof parsed === "object" && "spec" in parsed) parsed = { ...(parsed as object), spec: canonicalSpec((parsed as { spec: unknown }).spec) };
  const result = proposalResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`the proposer's response matches neither channel: ${whereWrong(result.error, parsed).join("; ")}`);
  }
  return result.data;
}

/**
 * Each problem with WHERE it is and WHAT was written there (2026-10-01): "column must be a plain identifier" ten times named no
 * field, so the retry could not tell which of its columns to fix, and all three attempts failed the same way. A union's problems
 * are read from the channel the reply claims (`status`), else every channel's.
 */
function whereWrong(err: z.ZodError, parsed: unknown): string[] {
  const at = (path: (string | number)[]) => path.reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k as string] : undefined), parsed);
  const leaves = (e: z.ZodError): z.ZodIssue[] => e.issues.flatMap((i) => (i.code === "invalid_union" ? i.unionErrors.flatMap((u) => leaves(u)) : [i]));
  const all = leaves(err);
  const status = (parsed as { status?: unknown } | null)?.status;
  const mine = all.filter((i) => !(i.path.length === 1 && i.path[0] === "status"));
  const picked = (status === "ok" ? mine.filter((i) => i.path[0] !== "missing" && i.path[0] !== "reason") : mine).slice(0, 12);
  return [...new Set((picked.length ? picked : all).map((i) => {
    const v = at(i.path);
    return `${i.path.join(".") || "(reply)"}${typeof v === "string" ? ` = "${v}"` : ""}: ${i.message}`;
  }))];
}

// ── The proposer ─────────────────────────────────────────────────────────────

/**
 * Propose ONE DB operation for one datasource.
 *
 * ⚠ **Writes nothing** (FR-010, SC-004). No row is created, no proposal is
 * stored, and no id is issued. A proposal is transient by design: a persisted one
 * is a half-created ref with a lifecycle, and the review it is waiting on is
 * exactly what makes it safe (D-170). Saving goes through the EXISTING
 * `POST /:dsId/operations`, which re-runs `check()` and `create()` on whatever
 * spec actually arrives — because the dialog is editable, so the spec that
 * arrives is frequently not the spec that was proposed.
 *
 * @throws 409 when the datasource has no introspected schema — the fix is a
 *         re-scan, and the message says so. Never propose against an empty
 *         schema: every identifier would be unresolvable and all three attempts
 *         would be spent discovering that.
 * @throws 502 when the inference gateway is unreachable. **Infrastructure, not a
 *         bad proposal** — it consumes no attempt.
 * @throws 422 when three attempts produced no spec that compiles. The findings
 *         travel with it, since they are the only actionable part.
 */
export async function proposeOperation(
  opts: {
    workspaceId: string;
    dsId: string;
    need: string;
    /**
     * A caller's own findings on a spec that compiles (the flow builder's: a column the engine could not type). Returned
     * findings are fed back VERBATIM like `check()`'s, and the attempt is re-asked within the same bound.
     */
    /** `said`: the proposal's own claims beside the spec — which parameters the need's words state (`values`). */
    accept?: (spec: DbOperationSpec, said: { values: Array<{ param: string; words: string }>; covers?: string[]; coversBy?: Array<{ words: string; by: string[] }>; assumed?: Array<{ words: string }>; leftOut?: Array<{ words: string }>; others?: Array<{ words: string }> }) => Promise<string[]> | string[];
    /** The read already written for this need, to revise in place (the flow builder's clarification) — never a fresh start. */
    revise?: { name: string; spec: DbOperationSpec };
  },
  client: InferenceClient = inference,
): Promise<OperationProposal> {
  // ⚠ ONE round trip for all three reads, and every one of them is scoped to
  // THIS datasource. There is no code path here that can reach another one's
  // schema (FR-005) — the parameter is `dsId`, singular, all the way down.
  const [schemaRows, operations, queries] = await Promise.all([
    schemaRepo.listByDatasource(opts.dsId),
    dbOperationRepo.listByDatasource(opts.dsId),
    datasourceQueryRepo.listByDatasource(opts.dsId),
  ]);

  if (schemaRows.length === 0) {
    throw httpError(
      "this datasource has no introspected schema, so nothing can be proposed against it: " +
        "every table and column would be unresolvable. Run the schema refresh (re-scan) for " +
        "this datasource first, then propose again",
      409,
    );
  }

  // Both kinds of reader share one namespace, because a step ref is
  // `<datasource>.<name>` whichever kind it resolves to — a proposed operation
  // that collided with a NAMED QUERY would be refused by `create` after the
  // person had already approved it.
  const takenNames = [...operations.map((o) => o.name), ...queries.map((q) => q.name)].sort();
  const taken = new Set(takenNames);

  let findings: string[] = [];
  let lastFindings: string[] = [];

  for (let attempt = 1; attempt <= MAX_PROPOSAL_ATTEMPTS; attempt++) {
    const prompt = buildProposalPrompt({
      need: opts.need,
      schemaRows,
      takenNames,
      findings,
      ...(opts.revise ? { revise: opts.revise } : {}),
    });

    let raw: string;
    try {
      raw = await client.complete(prompt, {
        label: `propose:${opts.dsId}`,
        maxTokens: PROPOSAL_MAX_TOKENS,
        schema: { name: "read_proposal", schema: PROPOSAL_STRICT.schema },
      });
    } catch (e) {
      // ⚠ Infrastructure, not a bad proposal. It burns no attempt: rethrown, not
      // continued, so `attempt` never advances on a gateway failure.
      if (e instanceof InferenceError) {
        throw httpError(`the inference gateway is unreachable: ${e.message}`, 502);
      }
      throw e;
    }

    let response: z.infer<typeof proposalResponseSchema>;
    try {
      response = parseProposalResponse(raw);
    } catch (e) {
      lastFindings = [(e as Error).message];
      findings = lastFindings;
      continue;
    }

    // ⚠ RETURNS IMMEDIATELY. One attempt, never retried (FR-008, D-171).
    // Re-asking a correct "this schema cannot express that" is how it becomes a
    // plausible-looking column on attempt 2.
    if (response.status === "insufficient_schema") {
      return {
        status: "insufficient_schema",
        missing: response.missing,
        reason: response.reason,
        maxPerRequest: MAX_PROPOSALS_PER_REQUEST,
      };
    }

    // ── the name, against the ONE definition of what a name may be ───────────
    // A name is a LABEL, so code makes the model's words into one (2026-10-01: "six_day_shift_over ten_hours" spent all three
    // attempts on a space): letters, digits and underscores, never starting with a digit, and a free one when it is taken. Re-asking
    // a model to spell an identifier is a model call spent on what code decides.
    {
      let label = response.name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "read";
      if (/^\d/.test(label)) label = `read_${label}`;
      const base = label;
      for (let n = 2; taken.has(label); n++) label = `${base}_${n}`;
      response = { ...response, name: label };
    }
    const nameCheck = dbOperationBodySchema.shape.name.safeParse(response.name);
    const nameProblems: string[] = [];
    if (!nameCheck.success) {
      nameProblems.push(
        `the name "${response.name}" is not usable: ` +
          nameCheck.error.issues.map((i) => i.message).join("; "),
      );
    } else if (taken.has(response.name)) {
      nameProblems.push(
        `the name "${response.name}" is already taken on this datasource — pick another; ` +
          `the names in use are: ${takenNames.join(", ")}`,
      );
    }

    // ── does it compile? ────────────────────────────────────────────────────
    //
    // `dbOperationService.check` is the SAME entry point the human-driven builder
    // uses, so a proposal is held to the compiler's rules exactly as a
    // hand-built spec is — and the readback and output columns come back from it
    // rather than being assembled here (FR-026).
    const checked = await dbOperationService.check(opts.workspaceId, opts.dsId, response.spec);
    const callerProblems = checked.ok && opts.accept ? await opts.accept(response.spec, { values: response.values, covers: response.covers.map((c) => (typeof c === "string" ? c : c.words)), coversBy: response.covers.map((c) => (typeof c === "string" ? { words: c, by: [] } : c)), assumed: response.assumed, leftOut: response.left_out, others: response.others }) : [];

    if (!checked.ok || nameProblems.length || callerProblems.length) {
      // ⚠ VERBATIM. `check()`'s findings are already written for a model to act
      // on — offending identifier plus what WAS available. Paraphrasing them or
      // appending advice is I-57: 25 of 26 findings were a scanner bug, handed to
      // a model as fact, and the model dutifully "fixed" them.
      lastFindings = [
        ...nameProblems,
        ...(checked.ok ? [] : checked.problems.map((p) => findingForRetry(p, schemaRows))),
        ...callerProblems,
      ];
      findings = lastFindings;
      continue;
    }

    return {
      status: "ok",
      name: response.name,
      description: response.description ?? "",
      spec: response.spec,
      assumed: response.assumed,
      leftOut: response.left_out,
      values: response.values.filter((v) => checked.ok && specParamOrder(response.spec).includes(v.param)),
      covers: response.covers.map((c) => (typeof c === "string" ? c : c.words)),
      readback: checked.readback,
      outputColumns: checked.outputColumns,
      ambiguousColumns: checked.ambiguousColumns,
      compiledSql: checked.compiledSql,
      paramsSchema: checked.paramsSchema,
      attempts: attempt,
      maxPerRequest: MAX_PROPOSALS_PER_REQUEST,
    };
  }

  // Not a refusal — a failure. A refusal names a boundary in the schema; this
  // names three answers that would not compile, and the findings are the only
  // part anybody can act on.
  throw httpError(
    `could not propose an operation that compiles in ${MAX_PROPOSAL_ATTEMPTS} attempts`,
    422,
    { findings: lastFindings.map((message) => ({ message })) },
  );
}

export const dbOperationProposalService = { proposeOperation };
