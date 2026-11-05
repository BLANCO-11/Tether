/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PROPOSING a SQL query — the dynamic-read path for connected datasources
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The operation proposer fills in a FORM; this module asks the model to write
 * the SELECT itself. Both close the same gap (a datasource with schema and no
 * readable components), and both keep the same safety posture:
 *
 *   * the model sees ONE datasource's introspected schema — names, types, keys
 *     — and nothing else: no DSN, no rows, no other datasource, no flow model
 *     (FR-005; `datasourceRepo` is not imported here for the same reason);
 *   * the SQL is validated by `checkSqlShape` — the SAME rules hand-written
 *     named queries pass — before it is returned, so a write-shaped or
 *     multi-statement answer is a finding to fix, never a proposal;
 *   * the SQL is additionally checked by `checkIdentifierQuoting`, which
 *     `checkSqlShape` cannot stand in for: that one never sees the schema, and
 *     the failure it misses is SQL whose identifiers are all real and all
 *     correctly spelled but written bare, so Postgres folds them to lower case
 *     and addresses nothing. Measured on a Prisma-shaped tenant datasource
 *     where it made all 46 tables unreadable by this path;
 *   * a proposal writes nothing; saving goes through the existing
 *     `POST /:dsId/queries`, which re-runs `check()` on whatever arrives.
 *
 * ── Why this exists beside the operation proposer ────────────────────────────
 *
 * The operation form cannot express column-to-column comparisons
 * (`amount_cents > limit_cents`), per-row arithmetic (`over_by_cents`), or
 * multi-level aggregation — measured live: `claims_over_policy` and
 * `spend_by_cost_centre` both come back `insufficient_schema` from the form
 * path while the schema holds every column they need. Those reads are not
 * missing data; they are missing expressiveness. SQL is the escape hatch, and
 * `checkSqlShape` is what keeps it a read.
 *
 * ── Two channels, same contract as the operation proposer ────────────────────
 *
 * `insufficient_schema` is an HTTP 200 success and is never retried. A
 * `checkSqlShape` finding IS retried, fed back verbatim, up to three attempts.
 */

import { z } from "zod";
import { schemaRepo, type SchemaRow } from "../repositories/schema.repo.js";
import { dbOperationRepo } from "../repositories/db-operation.repo.js";
import { datasourceQueryRepo } from "../repositories/datasource-query.repo.js";
import { checkSqlShape } from "./datasource-query.service.js";
import { checkIdentifierQuoting } from "./db-identifier-quoting.js";
import { namedQueryBodySchema } from "./datasource-query.service.js";
import { inference, InferenceError, type InferenceClient } from "./inference.service.js";
import { PROVENANCE_DECLARATION, wrapUntrusted } from "../prompt-boundary/envelope.js";
import { MAX_PROPOSALS_PER_REQUEST } from "./db-operation-proposal.service.js";

function httpError(message: string, statusCode: number, extra?: Record<string, unknown>) {
  return Object.assign(new Error(message), { statusCode, ...extra });
}

const QUERY_PROPOSAL_MAX_TOKENS = 4096;
const MAX_QUERY_PROPOSAL_ATTEMPTS = 3;

export interface QueryProposalOk {
  status: "ok";
  /** Editable BEFORE creation; immutable after, because it is half of every ref. */
  name: string;
  description: string;
  sqlText: string;
  paramOrder: string[];
  paramsSchema: Record<string, unknown>;
  /** Inference calls spent. Greater than 1 means shape findings were fed back. */
  attempts: number;
  maxPerRequest: number;
}

export interface QueryProposalRefusal {
  status: "insufficient_schema";
  missing: string[];
  reason: string;
  maxPerRequest: number;
}

export type QueryProposal = QueryProposalOk | QueryProposalRefusal;

const queryProposalResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    name: z.string().min(1).max(255),
    description: z.string().max(10_000).optional(),
    sqlText: z.string().min(1).max(64_000),
    paramOrder: z.array(z.string().min(1).max(255)).max(32).default([]),
    paramsSchema: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    status: z.literal("insufficient_schema"),
    missing: z.array(z.string().min(1).max(200)).min(1).max(16),
    reason: z.string().min(1).max(1000),
  }),
]);

export const queryNeedSchema = z.object({
  need: z.string().min(3).max(2000),
});

// ── Rendering the schema the proposer is allowed to see ──────────────────────
//
// One line per entity, columns with types, primary keys and foreign-key targets
// marked. Names + types only — never a row of data (D-54).
//
// ⚠ EVERY IDENTIFIER IS RENDERED DOUBLE-QUOTED, and that is the fix for a
// measured, total failure rather than a style choice. This rendering used to be
// bare (`public.User`, `firstName:text`) — the same rendering the operation
// proposer still uses, correctly, because ITS answer is a form spec that
// `compileOperation` quotes on the way out. Here the model writes the SQL, and
// a model copies what it is shown far more reliably than it follows prose. Shown
// `public.User` it wrote `FROM public.User`, which Postgres folds to
// `public.user` — a relation that does not exist. All 46 tables of that tenant's
// Prisma-shaped datasource were unreadable by this path.
//
// ⚠ This cannot regress a lower-case snake_case schema. `"invoices"` and
// `invoices` are the same relation, so `hr_demo` / `finance_demo` /
// `legal_demo`-shaped datasources see the same tables under a spelling that
// means exactly what the bare one did — and `checkIdentifierQuoting` cannot
// produce a finding against them at all, because it only knows about names that
// are not already all-lower-case.

/** Double-quote one identifier, doubling any embedded quote. */
const qi = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/**
 * Quote a `table.column` foreign-key target the introspectors emit.
 *
 * Split at the LAST dot: the reference is unqualified (`introspect/types.ts`
 * documents it as `"referenced_table.column"`), and a column name containing a
 * dot is the only thing this mis-splits. Rendered quoted for the same reason as
 * everything else — a target shown bare is a target that gets copied bare.
 */
function qRef(ref: string): string {
  const cut = ref.lastIndexOf(".");
  if (cut <= 0 || cut === ref.length - 1) return qi(ref);
  return `${qi(ref.slice(0, cut))}.${qi(ref.slice(cut + 1))}`;
}

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
    if (r.isForeignKey && r.foreignKeyReference) marks.push(`fk to ${qRef(r.foreignKeyReference)}`);
    e.cols.push(
      `${qi(r.columnName)}:${r.columnType ?? "unknown"}${marks.length ? ` [${marks.join(", ")}]` : ""}`,
    );
  }
  return [...byEntity.values()]
    .map((e) => {
      const name = e.schema ? `${qi(e.schema)}.${qi(e.name)}` : qi(e.name);
      return e.cols.length
        ? `  ${name}\n${e.cols.map((c) => `    ${c}`).join("\n")}`
        : `  ${name}\n    (no introspected columns)`;
    })
    .join("\n");
}

// ── The prompt ───────────────────────────────────────────────────────────────

const QUERY_PROPOSAL_RULES = [
  `You are WRITING ONE READ-ONLY SQL QUERY for ONE database.`,
  ``,
  `THE QUERY`,
  `  * ONE statement, starting with SELECT (or WITH ... SELECT). Nothing else: no`,
  `    INSERT, UPDATE, DELETE, DDL, transaction words, semicolons joining statements.`,
  `  * EVERY table and column you name MUST appear in the SCHEMA below, spelled exactly.`,
  `    There is nothing else to read. A table you remember from another database does not`,
  `    exist here, and a plausible column name is the one mistake with no cheap recovery.`,
  `  * DOUBLE-QUOTE EVERY TABLE AND COLUMN IDENTIFIER, exactly as the SCHEMA spells it.`,
  `    Postgres folds an UNQUOTED identifier to lower case, so a table shown as`,
  `    "public"."User" must be written "public"."User" — bare public.User asks for`,
  `    public.user, which does not exist, and the query fails at execution, after a person`,
  `    has approved it. The same is true of every column: bare firstName asks for`,
  `    firstname. Quoting is correct for lower-case names too ("invoices" is invoices), so`,
  `    quote them all and you cannot get this wrong.`,
  `    Quote ONLY identifiers. Do NOT quote SQL keywords (SELECT, FROM, JOIN, WHERE, ORDER`,
  `    BY), function names (count, sum, now, coalesce) or the $1, $2 parameters. An alias`,
  `    you invent may be quoted — quote it if you want its exact spelling in the result.`,
  `  * Parameters are positional $1, $2, ... in the order of PARAM ORDER below — never a`,
  `    literal date, period, threshold or default. A value you chose is a value nobody`,
  `    asked for, and it produces a read that succeeds and answers the wrong question.`,
  `  * "name" is a plain identifier — lowercase letters, digits and underscores, starting`,
  `    with a letter. It becomes half of a step reference, so it must be unique on this`,
  `    datasource: it may NOT be any of the NAMES ALREADY TAKEN below.`,
  `  * "description" is one sentence for the person who will approve this.`,
  `  * If REQUIRED COLUMNS is present, the step that consumes this query already reads`,
  `    those exact key names. Project one column for EACH of them, ALIASED to that exact`,
  `    spelling with AS — join whatever tables the schema needs to reach them, following`,
  `    the fk marks. The names are what the answer must be called, NOT names you will find`,
  `    in the schema: "candidate_email" may be "u"."email" two joins away. You may project`,
  `    more than is listed; do not project FEWER without saying so.`,
  `    If the schema genuinely cannot supply one, simply OMIT that column. Omitting it is`,
  `    honest and recoverable — the step is told which names came back and drops the ones`,
  `    it cannot have. Aliasing the nearest-looking column onto the`,
  `    name instead is the one unrecoverable mistake: it produces a report that is full,`,
  `    plausible and wrong, and nothing downstream can tell.`,
  `  * "paramOrder" lists the parameter names in $1, $2, ... order; "paramsSchema"`,
  `    describes each with {"type": "string"|"number"|"boolean"|"array", "required": true,`,
  `    "description": "..."}. Every $n must have its name in paramOrder, and every name`,
  `    in paramOrder must appear as a $n.`,
  `    When your SQL reads a parameter as a month (YYYY-MM) or a date (YYYY-MM-DD), say so`,
  `    with "format": "month" or "format": "date" — it is what refuses a value like "monthly"`,
  `    before a run. Leave "format" out for any other parameter.`,
  ``,
  `RESPONSE — reply with ONE json object, no prose, no markdown fence.`,
  ``,
  `  If the schema can express the need:`,
  `    {"status": "ok", "name": "overdue_invoices",`,
  `     "description": "Invoices past their due date as of a supplied date, with the customer name.",`,
  // ⚠ The worked example is QUOTED, and it has to be. A model copies the example
  //   far more reliably than it follows the prose above it, so an example written
  //   the old bare way teaches the defect the rule forbids, in every workspace,
  //   for ever. It is quoted here even though this example's own identifiers are
  //   lower case — because what is being taught is the HABIT, and a lower-case
  //   example left bare reads as "quote only the awkward ones".
  `     "sqlText": "SELECT \\"i\\".\\"invoice_code\\", \\"c\\".\\"name\\" AS customer_name, \\"i\\".\\"due_date\\" FROM \\"public\\".\\"invoices\\" AS \\"i\\" JOIN \\"public\\".\\"customers\\" AS \\"c\\" ON \\"c\\".\\"id\\" = \\"i\\".\\"customer_id\\" WHERE \\"i\\".\\"due_date\\" < $1 ORDER BY \\"i\\".\\"due_date\\" LIMIT 500",`,
  `     "paramOrder": ["as_of"],`,
  `     "paramsSchema": {"as_of": {"type": "string", "required": true, "format": "date", "description": "The date to judge against, YYYY-MM-DD."}}}`,
  ``,
  `  If it CANNOT — because the data the need asks for is not in this schema:`,
  `    {"status": "insufficient_schema",`,
  `     "missing": ["a due date or invoice date column"],`,
  `     "reason": "no column in the introspected schema carries a date; overdue cannot be expressed"}`,
  ``,
  `  A refusal is a correct and useful answer, not a failure — it is how a gap in this`,
  `  datasource gets noticed instead of silently papered over with the nearest column`,
  `  whose name looked close enough. Guessing is the one unrecoverable mistake: it`,
  `  produces a read that runs, returns rows, and answers a different`,
  `  question than the one asked.`,
  ``,
  `YOU HAVE NOT SEEN A SINGLE ROW OF DATA, and you are not going to. Everything`,
  `  below is schema metadata — names, types, keys. Do not describe what the data`,
  `  contains, do not estimate how many rows anything has, and do not assume units:`,
  `  a column called "amount" may be in cents.`,
].join("\n");

/**
 * Rendered ONLY for a SQLite datasource, so every Postgres prompt stays
 * byte-identical — the generation measurements were taken against those bytes.
 * The rules above still hold: `$n` parameters and quoted identifiers are what
 * Foundry binds and translates, so they are kept, not replaced.
 */
const SQLITE_DIALECT_BLOCK = [
  `DIALECT — THIS DATABASE IS SQLITE, NOT POSTGRES`,
  `  * Write SQL that SQLite runs. There are NO :: casts, and no date_trunc, to_date,`,
  `    EXTRACT, now(), interval or generate_series.`,
  `  * Dates and timestamps are stored as TEXT in ISO form (2026-06-30, 2026-06-30 14:05:00).`,
  `    Compare them as strings; strftime('%Y-%m', "col") is the month, date('now') is today,`,
  `    and julianday("a") - julianday("b") is a difference in days.`,
  `  * Keep the $1, $2 parameters and the double-quoted identifiers exactly as the rules`,
  `    above say — Foundry binds and translates them for SQLite.`,
].join("\n");

function buildQueryProposalPrompt(opts: {
  dialect?: "sqlite";
  need: string;
  wanted: string[];
  params: Array<{ name: string; fedBy: string }> | undefined;
  schemaRows: SchemaRow[];
  takenNames: string[];
  findings: string[];
}): string {
  const blocks = [
    QUERY_PROPOSAL_RULES,
    ``,
    ...(opts.dialect === "sqlite" ? [SQLITE_DIALECT_BLOCK, ``] : []),
    PROVENANCE_DECLARATION,
    ``,
    `SCHEMA — the only tables and columns that exist for this task`,
    wrapUntrusted(schemaText(opts.schemaRows), "datasource schema"),
    ``,
    `NAMES ALREADY TAKEN ON THIS DATASOURCE`,
    opts.takenNames.length ? opts.takenNames.map((n) => `  ${n}`).join("\n") : `  (none)`,
    ``,
    `NEED`,
    `  ${opts.need}`,
  ];

  /**
   * ⚠ Rendered only when there IS a contract. An empty `REQUIRED COLUMNS`
   * heading reads as "this query is required to return nothing", and the
   * direct-from-a-person path (`POST /:dsId/queries/propose`) has no consuming
   * step at all — there the four-word need is genuinely the whole brief.
   */
  if (opts.wanted.length) {
    blocks.push(
      ``,
      `REQUIRED COLUMNS — the consuming step reads these key names`,
      ...opts.wanted.map((c) => `  ${c}`),
    );
  }

  /**
   * ⚠ The step's WRITES, beside its reads (build:measure R07). Same rule as
   * `REQUIRED COLUMNS`: rendered only when a consuming step exists. Without it
   * the proposer names its own parameters and the step binds different ones.
   */
  if (opts.params && !opts.params.length) {
    // ⚠ The step binds NOTHING (r8 S1: "since yesterday" drafted with no
    // input, and the proposer invented `opened_since`). Distinct from
    // `undefined` — the person-driven path, which has no step at all.
    blocks.push(
      ``,
      `REQUIRED PARAMETERS — NONE. The consuming step passes no parameters, so paramOrder must be []`,
      `and the SQL must use no $n. Compute any relative date IN the SQL (e.g. now() - interval '1 day').`,
    );
  } else if (opts.params?.length) {
    blocks.push(
      ``,
      `REQUIRED PARAMETERS — the consuming step passes EXACTLY these, by these names.`,
      `paramOrder and paramsSchema must name these and no others. If a range is needed`,
      `(a month given as YYYY-MM, say), derive both ends IN THE SQL from the one parameter`,
      `(e.g. to_date($1, 'YYYY-MM') and + interval '1 month') — never ask for a second one.`,
      ...opts.params.map((p) => `  ${p.name} — ${p.fedBy}`),
    );
  }

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
 * The proposal's parameter NAMES against the ones the consuming step binds.
 * Names only, as a set — order is the proposal's to choose, and `$n` is mapped
 * from `paramOrder`. Empty `bound` means no contract, so nothing to check.
 */
export function paramContractProblems(
  bound: Array<{ name: string }>,
  paramOrder: string[] | undefined,
  /** True when `bound` is a real contract even if empty — the step passes nothing. */
  exact = false,
): string[] {
  if (!bound.length && !exact) return [];
  if (!bound.length) {
    return paramOrder?.length
      ? [`param_contract: the step passes NO parameters; your SQL asks for ${paramOrder.map((n) => `"${n}"`).join(", ")}, which it will never receive. Use no $n — compute any date in the SQL`]
      : [];
  }
  const want = new Set(bound.map((b) => b.name));
  const got = new Set(paramOrder ?? []);
  const extra = [...got].filter((n) => !want.has(n)).sort();
  const missing = [...want].filter((n) => !got.has(n)).sort();
  if (!extra.length && !missing.length) return [];
  return [
    `param_contract: the step passes exactly ${[...want].sort().map((n) => `"${n}"`).join(", ")}` +
      (extra.length ? `; your SQL asks for ${extra.map((n) => `"${n}"`).join(", ")}, which it will never receive` : "") +
      (missing.length ? `; your SQL never uses ${missing.map((n) => `"${n}"`).join(", ")}` : "") +
      `. Use those names; derive any range IN the SQL from them`,
  ];
}

/**
 * Parse a proposal response into one of the two channels.
 *
 * Tolerant of a markdown fence and surrounding prose — models emit both, and
 * re-asking over formatting spends an attempt on nothing. NOT tolerant of a
 * missing `status`.
 */
export function parseQueryProposalResponse(raw: string): z.infer<typeof queryProposalResponseSchema> {
  const fenced = raw.match(/```(?:json|sql)?\s*([\s\S]*?)```/);
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

  const result = queryProposalResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `the proposer's response matches neither channel: ${JSON.stringify(
        result.error.flatten().fieldErrors,
      )}`,
    );
  }
  return result.data;
}

/**
 * Propose ONE SQL query for one datasource.
 *
 * Writes nothing. Saving goes through the existing `POST /:dsId/queries`,
 * which re-runs `check()` on whatever SQL actually arrives.
 *
 * @throws 409 when the datasource has no introspected schema.
 * @throws 502 when the inference gateway is unreachable (burns no attempt).
 * @throws 422 when three attempts produced no SQL that passes `checkSqlShape`.
 */
export async function proposeQuery(
  opts: {
    workspaceId: string;
    dsId: string;
    /**
     * The datasource's SQL dialect when it is not Postgres. Supplied by the
     * CALLER from the public datasource record, so this module still never
     * reads a datasource row (the row carries the connection string). On
     * `sqlite` the prompt gains a dialect block; whether the SQL actually runs
     * is checked where it is saved (`datasource-query.service.ts`).
     */
    dialect?: "sqlite";
    need: string;
    /**
     * The key names the consuming step already reads — see `fieldsReadFrom`.
     * ⚠ OPTIONAL, and defaulted rather than required, because the other caller
     * is a person on the datasource page who has no consuming step. A required
     * field there would be an empty array claiming a contract that does not
     * exist.
     */
    wanted?: string[];
    /**
     * The parameter names the consuming step already binds — `paramsBoundBy`.
     * Optional for the same reason as `wanted`. When given, a proposal naming
     * any other set is a FINDING and is re-asked: a mismatch sends nothing and
     * reads 0 rows on a green run (R07).
     */
    params?: Array<{ name: string; fedBy: string }>;
  },
  client: InferenceClient = inference,
): Promise<QueryProposal> {
  // ONE round trip for all three reads, every one scoped to THIS datasource —
  // no code path here can reach another one's schema (FR-005).
  void opts.workspaceId;
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

  // Both kinds of reader share one namespace — a proposed query that collided
  // with an operation would be refused by `create` after approval.
  const takenNames = [...operations.map((o) => o.name), ...queries.map((q) => q.name)].sort();
  const taken = new Set(takenNames);

  let findings: string[] = [];
  let lastFindings: string[] = [];

  for (let attempt = 1; attempt <= MAX_QUERY_PROPOSAL_ATTEMPTS; attempt++) {
    const prompt = buildQueryProposalPrompt({
      ...(opts.dialect === "sqlite" ? { dialect: "sqlite" as const } : {}),
      need: opts.need,
      wanted: opts.wanted ?? [],
      params: opts.params,
      schemaRows,
      takenNames,
      findings,
    });

    let raw: string;
    try {
      raw = await client.complete(prompt, {
        label: `propose-query:${opts.dsId}`,
        maxTokens: QUERY_PROPOSAL_MAX_TOKENS,
      });
    } catch (e) {
      if (e instanceof InferenceError) {
        throw httpError(`the inference gateway is unreachable: ${e.message}`, 502);
      }
      throw e;
    }

    let response: z.infer<typeof queryProposalResponseSchema>;
    try {
      response = parseQueryProposalResponse(raw);
    } catch (e) {
      lastFindings = [(e as Error).message];
      findings = lastFindings;
      continue;
    }

    // RETURNS IMMEDIATELY — never retried. Re-asking a correct "this schema
    // cannot express that" is how it becomes a plausible-looking column.
    if (response.status === "insufficient_schema") {
      return {
        status: "insufficient_schema",
        missing: response.missing,
        reason: response.reason,
        maxPerRequest: MAX_PROPOSALS_PER_REQUEST,
      };
    }

    const nameCheck = namedQueryBodySchema.shape.name.safeParse(response.name);
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

    // The SAME shape rule hand-written queries pass — a write-shaped or
    // multi-statement answer is a finding, never a proposal.
    const shapeProblems = checkSqlShape(response.sqlText, response.paramOrder, response.paramsSchema);

    // The check half of the quoting rule (I-118). `checkSqlShape` cannot see
    // this: it knows nothing about the schema, and every identifier here is
    // real and correctly spelled — the SQL is simply unable to address it.
    // A finding, never a rewrite; the reasoning is in the module's docblock.
    const quotingProblems = checkIdentifierQuoting(response.sqlText, schemaRows);

    const paramProblems = opts.params ? paramContractProblems(opts.params, response.paramOrder, true) : [];

    if (shapeProblems.length > 0 || quotingProblems.length > 0 || nameProblems.length || paramProblems.length) {
      lastFindings = [
        ...nameProblems,
        ...paramProblems,
        ...shapeProblems.map((p) => `${p.code}: ${p.message}`),
        ...quotingProblems.map((p) => `${p.code}: ${p.message}`),
      ];
      findings = lastFindings;
      continue;
    }

    return {
      status: "ok",
      name: response.name,
      description: response.description ?? "",
      sqlText: response.sqlText,
      paramOrder: response.paramOrder,
      paramsSchema: response.paramsSchema,
      attempts: attempt,
      maxPerRequest: MAX_PROPOSALS_PER_REQUEST,
    };
  }

  throw httpError(
    `could not propose a query that passes the shape check in ${MAX_QUERY_PROPOSAL_ATTEMPTS} attempts`,
    422,
    { findings: lastFindings.map((message) => ({ message })) },
  );
}

export const dbQueryProposalService = { proposeQuery };
