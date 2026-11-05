/**
 * Named datasource queries, as an authoring surface.
 *
 * A `datasource` step names a QUERY by ref (`<datasource>.<query>`) rather than
 * carrying SQL, and named queries are half of the callable catalogue a flow is
 * built from (04 §5.1). Until now they existed only because the `kestra:phaseN`
 * harnesses seeded them through the repo — `e2e:ui` recorded that as a GAP,
 * because the thing a client must reference could not be authored by a client.
 *
 * ⚠ This route is a NEW SQL-authoring surface, and that is worth saying out loud.
 * The reason `generation-audit.service.ts` was deletable in Phase 4 is that
 * `datasource` steps run named queries rather than generated SQL — the SQL was
 * reviewed once, by a human, in a file. That argument is unchanged (nothing here
 * is model-generated) but the SQL now arrives over HTTP, so the shape rules below
 * are the review that used to happen in code review.
 *
 * Three properties are enforced here and each one closes something measured:
 *
 *  1. **A named query is ONE statement.** Measured against the live HR
 *     datasource: `client.query("SELECT 1; SELECT 2", [])` is **ACCEPTED** and
 *     runs both statements, because `pg` uses the simple protocol when the values
 *     array is empty. With one parameter the same SQL is refused
 *     (*"cannot insert multiple commands into a prepared statement"*). So
 *     multi-statement execution is available today to exactly those named queries
 *     that take no parameters — a protection that exists by accident and
 *     disappears when someone removes the last parameter. Worse, `runNamedQuery`
 *     reads `r.rows` from the result, and pg returns an ARRAY of results for a
 *     multi-statement query, so `data` comes back `undefined`: the statements run
 *     and the step reports nothing.
 *
 *  2. **A named query READS.** Write keywords are rejected at statement level,
 *     including inside a CTE — `WITH x AS (INSERT … RETURNING …) SELECT * FROM x`
 *     is a write that begins with `WITH`, so a leading-keyword check alone would
 *     pass it. This is a **shape** rule layered on top of the credential, not a
 *     replacement for it: the primary control is still the absent grants on
 *     `foundry_ro` (see `demo/hr-roles.ts`). It matters because that role is only
 *     guaranteed for demo-seeded datasources — a datasource registered by hand
 *     through the API carries whatever credential the caller supplied, which is a
 *     documented open item. Measured on `foundry_ro`, the data-modifying CTE is
 *     refused with *"cannot execute SELECT in a read-only transaction"* — note
 *     that is `default_transaction_read_only` talking, i.e. the session default
 *     rather than the missing grant, and neither applies to a read-write DSN.
 *
 *  3. **`paramOrder` agrees with the placeholders.** A mismatch is invisible
 *     until a flow runs, which is after approval. Too few names and every
 *     execution errors; too many and the extra parameter binds nothing — the
 *     manifest then advertises a parameter that does nothing, and since
 *     `refInterfaces()` is what an IMPORT is checked against (D-25), that false
 *     signature travels to another tenant and passes the structural check.
 *
 * What is deliberately NOT done here: the SQL is not executed to validate it.
 * A validating run would need the datasource credential on the authoring path
 * and would execute caller-supplied SQL at authoring time, which is a larger
 * surface than the one being protected. `POST …/queries/:name/preview` is the
 * place for that if it is ever wanted, with its own bounded reasoning.
 */

import { z } from "zod";
import {
  datasourceQueryRepo,
  type DatasourceQuery,
} from "../repositories/datasource-query.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { queryParamDescriptor } from "./param-descriptor.js";
import { schemaIntrospectorService } from "./schema-introspector.service.js";
import { decrypt } from "../utils/encryptor.js";
import { isSqliteType, sqliteFileService } from "./sqlite-file.service.js";
import type { DescribedQuery } from "./introspect/types.js";
import { QUERY_COLUMN_TAG_VALUES, withDeclaredTags } from "./query-column-tags.js";

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * A ref is `<datasource>.<query>`, split at the FIRST dot by
 * `step-execution.service.ts`, and `refFingerprints()` keys its map on the
 * CONCATENATION. A dot on either side therefore breaks two things at once: the
 * split picks the wrong boundary, and two distinct pairs can produce one key
 * (`"a.b" + "c"` and `"a" + "b.c"` are both `a.b.c`). Tool names already carry
 * this same regex, which is why a tool cannot collide with a query ref.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Moved to `services/param-descriptor.ts` — same shape, same four types, same
 * defaults — because `tools.paramsSchema` needed the identical treatment
 * (**I-125**) and two copies of "what a parameter descriptor is" is how the two
 * kinds of callable ref end up describing a parameter differently. The type
 * vocabulary here is deliberately NARROWER than a tool's: this parameter binds
 * to a positional `$n`, so it is a scalar. That file's header carries the
 * measurement.
 */
const paramDescriptor = queryParamDescriptor;

/**
 * A query seed — hand-written SQL retired in favour of `*-generated.ts`
 * (model-proposed, oracle-compared). The shape stays: name, description,
 * SQL, ordered params and their descriptors.
 */
export interface NamedQuerySpec {
  name: string;
  description: string;
  sqlText: string;
  paramOrder: string[];
  paramsSchema: Record<string, { type: string; required: boolean; description: string }>;
}

export const namedQueryBodySchema = z.object({
  name: z.string().min(1).max(255).regex(IDENTIFIER, "name must be a plain identifier"),
  description: z.string().max(4000).optional(),
  sqlText: z.string().min(1).max(64_000),
  paramOrder: z
    .array(z.string().min(1).max(64).regex(IDENTIFIER, "parameter names must be identifiers"))
    .max(32)
    .default([]),
  paramsSchema: z.record(paramDescriptor).default({}),
  /** Tags on computed result columns (`query-column-tags.ts`) — the owner's declaration, checked against what the query returns. */
  columnTags: z.record(z.string().regex(IDENTIFIER), z.enum(QUERY_COLUMN_TAG_VALUES)).optional(),
});

/** Update takes everything except the name — renaming is a delete plus a create,
 *  because the name IS the ref and a rename is what a flow would break on. */
export const namedQueryUpdateSchema = namedQueryBodySchema.omit({ name: true }).partial();

// ── SQL shape ────────────────────────────────────────────────────────────────

/**
 * Blank out string literals, quoted identifiers and comments.
 *
 * Every check below scans for keywords and `$n` placeholders, and all of them
 * would otherwise false-positive on ordinary content: `SELECT 'update' AS verb`,
 * a column called `"insert"`, or `-- $3 was removed`. Replacing with spaces of
 * equal length rather than deleting keeps the reported offsets meaningful.
 */
function stripLiterals(sql: string): string {
  let out = "";
  let i = 0;
  const blank = (n: number) => " ".repeat(n);
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      // Doubled quote is an escaped quote inside the literal, not a close.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      out += blank(Math.min(j, sql.length) - i + 1);
      i = j + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      const end = nl === -1 ? sql.length : nl;
      out += blank(end - i);
      i = end;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += blank(stop - i);
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Statement-level write keywords.
 *
 * Word-boundary matched against literal-stripped SQL, so `created_at`,
 * `updated_at` and `deleted_at` do not match `create`, `update` or `delete` —
 * the `\b` after the keyword fails on the following word character. `set` is in
 * because the only place it appears in a read is `SET LOCAL`/`SET TRANSACTION`,
 * both of which change session state a later statement inherits.
 */
const WRITE_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "truncate",
  "drop",
  "alter",
  "create",
  "grant",
  "revoke",
  "copy",
  "merge",
  "call",
  "do",
  "set",
  "vacuum",
  "analyze",
  "reindex",
  "listen",
  "notify",
  "lock",
  "prepare",
  "execute",
  "begin",
  "commit",
  "rollback",
  "savepoint",
];

export interface SqlShapeProblem {
  code:
    | "multiple_statements"
    | "not_a_read"
    | "dollar_quoted_block"
    | "placeholder_mismatch"
    | "placeholder_gap"
    | "duplicate_param"
    | "params_schema_mismatch"
    | "sqlite_dialect";
  message: string;
}

/**
 * The SQLite half of saving a named query: does it RUN on this datasource?
 * Postgres and MySQL are checked by running them; a SQLite file can be asked
 * at save time, so it is (`sqliteFileService.statementProblem`).
 */
export async function dialectProblems(
  ds: { type: string; connectionStringEnc: string | null },
  sqlText: string,
): Promise<SqlShapeProblem[]> {
  if (!isSqliteType(ds.type) || !ds.connectionStringEnc) return [];
  const problem = await sqliteFileService.statementProblem(decrypt(ds.connectionStringEnc), sqlText);
  return problem ? [{ code: "sqlite_dialect", message: problem }] : [];
}

/**
 * Everything structural that can be known about a named query without running
 * it. Returns problems rather than throwing so a caller can report all of them
 * at once — an author fixing one rule at a time through four round-trips is how
 * a correct rule gets worked around.
 */
export function checkSqlShape(
  sqlText: string,
  paramOrder: string[],
  paramsSchema: Record<string, unknown>,
): SqlShapeProblem[] {
  const problems: SqlShapeProblem[] = [];
  const bare = stripLiterals(sqlText);

  // Dollar-quoting is checked BEFORE anything else: `$$ … $$` is a function or
  // DO body, its contents are not SQL at this level, and `stripLiterals` does
  // not know about it — so every check below would be reading a body it cannot
  // parse. A named query is a single statement, never a procedural block.
  if (/\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$/.test(bare)) {
    problems.push({
      code: "dollar_quoted_block",
      message:
        "dollar-quoted blocks ($$ … $$) are not allowed in a named query — a named query is a " +
        "single read statement, not a procedural body, and the contents of a block are not " +
        "checkable by the rules applied to the statement around them",
    });
    return problems;
  }

  // ── one statement ─────────────────────────────────────────────────────────
  // Trailing semicolons and whitespace are fine; a semicolon with SQL after it
  // is not. This is not cosmetic: with an empty values array `pg` uses the
  // SIMPLE protocol and runs every statement (measured), and `runNamedQuery`
  // then reads `.rows` off an array of results and reports `undefined` — so the
  // extra statements execute and the step shows nothing.
  const stmtSplit = bare.replace(/;\s*$/, "");
  if (stmtSplit.includes(";")) {
    problems.push({
      code: "multiple_statements",
      message:
        "a named query must be a single statement — a query taking no parameters runs through " +
        "pg's simple protocol, where every statement after the first also executes while the " +
        "step reports no rows at all",
    });
  }

  // ── it reads ──────────────────────────────────────────────────────────────
  const firstWord = bare.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (firstWord !== "select" && firstWord !== "with" && firstWord !== "table" && firstWord !== "values") {
    problems.push({
      code: "not_a_read",
      message: `a named query must begin with SELECT, WITH, TABLE or VALUES — this one begins with "${firstWord || "(nothing)"}"`,
    });
  }
  const found = WRITE_KEYWORDS.filter((k) => new RegExp(`\\b${k}\\b`, "i").test(bare));
  if (found.length > 0) {
    problems.push({
      code: "not_a_read",
      message:
        `a named query must only read; found ${found.map((f) => f.toUpperCase()).join(", ")}. ` +
        "This is checked even inside a CTE, because `WITH x AS (INSERT … RETURNING …) SELECT * " +
        "FROM x` is a write that begins with WITH. The datasource credential is the primary " +
        "control, but it is only guaranteed read-only for demo-seeded datasources",
    });
  }

  // ── placeholders agree with paramOrder ────────────────────────────────────
  const dupes = paramOrder.filter((p, i) => paramOrder.indexOf(p) !== i);
  if (dupes.length > 0) {
    problems.push({
      code: "duplicate_param",
      message:
        `paramOrder repeats ${[...new Set(dupes)].join(", ")} — each position binds one declared ` +
        "name, so a repeat means one of the two positions is not the one the author meant. Reuse " +
        "a value by referencing the same placeholder twice in the SQL instead",
    });
  }

  const positions = new Set<number>();
  for (const m of bare.matchAll(/\$(\d+)/g)) positions.add(Number(m[1]));
  const highest = positions.size === 0 ? 0 : Math.max(...positions);

  if (highest !== paramOrder.length) {
    problems.push({
      code: "placeholder_mismatch",
      message:
        `the SQL uses ${highest === 0 ? "no placeholders" : `$1..$${highest}`} but paramOrder ` +
        `declares ${paramOrder.length} parameter(s) (${paramOrder.join(", ") || "none"}). ` +
        (highest > paramOrder.length
          ? "A placeholder with nothing to bind fails on every execution, which is after approval."
          : "A declared parameter that binds nothing is advertised in the manifest and in " +
            "refInterfaces() — so an import into another tenant checks against a signature the " +
            "query does not actually have (D-25)."),
    });
  }
  const gaps = [];
  for (let n = 1; n <= highest; n++) if (!positions.has(n)) gaps.push(`$${n}`);
  if (gaps.length > 0) {
    problems.push({
      code: "placeholder_gap",
      message:
        `the SQL skips ${gaps.join(", ")} — positions are what paramOrder maps onto, so a gap ` +
        "silently shifts every later parameter onto the wrong placeholder",
    });
  }

  // ── paramsSchema describes exactly the declared parameters ────────────────
  const described = Object.keys(paramsSchema ?? {});
  const undescribed = paramOrder.filter((p) => !described.includes(p));
  const orphaned = described.filter((d) => !paramOrder.includes(d));
  if (undescribed.length > 0 || orphaned.length > 0) {
    const parts = [];
    if (undescribed.length) parts.push(`no descriptor for ${undescribed.join(", ")}`);
    if (orphaned.length) parts.push(`descriptor for undeclared ${orphaned.join(", ")}`);
    problems.push({
      code: "params_schema_mismatch",
      message:
        `paramsSchema must describe exactly the declared parameters: ${parts.join("; ")}. ` +
        "The manifest defaults an undescribed parameter to type \"string\", so a missing " +
        "descriptor is not an omission — it is a type assertion nobody made",
    });
  }

  return problems;
}

// ── impact of an edit ────────────────────────────────────────────────────────

/**
 * Which live flows an edit to this ref will suspend.
 *
 * A query's `sql_text` is inside its ref fingerprint by design (D-17), so
 * editing SQL moves the fingerprint, and the sweep then routes that through
 * `checkStaleness` → `markStale` → `status: "suspended"`, which unarms the flow
 * and removes its Kestra schedule. That is correct — the approval was given
 * against different SQL — but it happens on a poll loop some time after the
 * PATCH returns 200, so from the author's side an unrelated automation stops
 * running for no visible reason.
 *
 * So the write routes report it. This is deliberately a REPORT and not a
 * refusal: refusing would make an armed flow a lock on its own query, and the
 * way out of that would be to revoke the approval first — i.e. exactly the
 * suspension being avoided, just done by hand.
 *
 * Selected on `armedRevision IS NOT NULL`, matching the sweep's own work list
 * and never on `status` (I-14).
 */
async function armedFlowsUsing(
  workspaceId: string,
  ref: string,
): Promise<Array<{ id: string; name: string; armedRevision: number }>> {
  const live = (await flowRepo.listLive()).filter((f) => f.workspaceId === workspaceId);
  const hits = [];
  for (const flow of live) {
    if (flow.armedRevision == null) continue;
    // `manifestRefsJson` is read rather than the step config, because it is what
    // the staleness comparison itself reads — so this report can never disagree
    // with the suspension it is predicting. A step config could name a ref in a
    // shape this function did not think to parse.
    const steps = await flowRepo.listSteps(flow.id, flow.armedRevision);
    if (steps.some((s) => Object.hasOwn(s.manifestRefsJson ?? {}, ref))) {
      hits.push({ id: flow.id, name: flow.name, armedRevision: flow.armedRevision });
    }
  }
  return hits;
}

// ── public shape ─────────────────────────────────────────────────────────────

function toPublic(q: DatasourceQuery, datasourceName: string) {
  return {
    id: q.id,
    datasourceId: q.datasourceId,
    name: q.name,
    /** What a `datasource` step's `ref` must say. Returned so a client never
     *  has to build it by string concatenation and get the boundary wrong. */
    ref: `${datasourceName}.${q.name}`,
    description: q.description,
    sqlText: q.sqlText,
    paramOrder: q.paramOrder ?? [],
    paramsSchema: q.paramsSchema ?? {},
    columnTags: q.columnTags ?? {},
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
  };
}

/** A declared tag the described columns cannot carry is refused by name — a declaration may fill a silence, never invent one.
 *  Undescribable (no credential, not Postgres): nothing to check against, and a declaration has no effect until it is described. */
function assertTagsFit(described: DescribedQuery | null, tags: Record<string, string>) {
  if (!described || !Object.keys(tags).length) return;
  const { problems } = withDeclaredTags(described.columns, tags);
  if (problems.length) throw httpError(`columnTags: ${problems.join("; ")}`, 400);
}

async function assertDatasource(workspaceId: string, dsId: string) {
  const ds = await datasourceRepo.get(workspaceId, dsId);
  if (!ds) throw httpError("datasource not found", 404);
  // A datasource whose name is not an identifier cannot host a resolvable query:
  // `runNamedQuery` splits the ref at the first dot, so `"a.b".c` resolves as
  // datasource `a`, query `b.c`, and 404s at execution time — after approval.
  // Creation now rejects such a name; this catches rows that predate that.
  if (!IDENTIFIER.test(ds.name)) {
    throw httpError(
      `datasource "${ds.name}" has a name that is not a plain identifier, so a ref built from ` +
        "it cannot be resolved: a step ref is split at the FIRST dot, and every query on this " +
        "datasource would 404 at execution time. Rename the datasource first",
      409,
    );
  }
  return ds;
}

/**
 * Ask the database what this query takes and returns, without reading a row (compiled-builder I-271, G13).
 * `null` when the datasource has no credential, is not Postgres, or the database cannot describe the statement. The
 * query then stays untyped (`Rows<Json>`), which the catalogue already handles, and registration is never refused for it.
 */
export async function describeOrNull(
  ds: { type: string; connectionStringEnc?: string | null },
  sql: string,
  paramOrder: string[],
): Promise<DescribedQuery | null> {
  if (!ds.connectionStringEnc) return null;
  try {
    return await schemaIntrospectorService.describeQuery(ds.type, decrypt(ds.connectionStringEnc), sql, paramOrder);
  } catch (e) {
    console.warn(`[describe] ${(e as Error).message}`);
    return null;
  }
}

export const datasourceQueryService = {
  async list(workspaceId: string, dsId: string) {
    const ds = await assertDatasource(workspaceId, dsId);
    const rows = await datasourceQueryRepo.listByDatasource(dsId);
    return rows.map((q) => toPublic(q, ds.name));
  },

  async get(workspaceId: string, dsId: string, name: string) {
    const ds = await assertDatasource(workspaceId, dsId);
    const found = (await datasourceQueryRepo.listByDatasource(dsId)).find((q) => q.name === name);
    return found ? toPublic(found, ds.name) : undefined;
  },

  async create(workspaceId: string, dsId: string, input: z.infer<typeof namedQueryBodySchema>) {
    const ds = await assertDatasource(workspaceId, dsId);

    // A create is not an upsert. The repo offers `upsertByName` because the
    // harnesses re-seed idempotently, but over HTTP a silent overwrite would
    // replace the SQL an armed flow was approved against without the caller ever
    // seeing that they had hit an existing name. Same reasoning as D-27's 409 on
    // a duplicate template name.
    const existing = (await datasourceQueryRepo.listByDatasource(dsId)).find(
      (q) => q.name === input.name,
    );
    if (existing) {
      throw httpError(
        `datasource "${ds.name}" already has a query named "${input.name}" — PATCH it to change ` +
          "its SQL, so the response can tell you which armed flows that suspends",
        409,
      );
    }

    const problems = checkSqlShape(input.sqlText, input.paramOrder, input.paramsSchema);
    if (problems.length > 0) throw sqlShapeError(problems);
    const dialect = await dialectProblems(ds, input.sqlText);
    if (dialect.length > 0) throw sqlShapeError(dialect);

    const describedJson = await describeOrNull(ds, input.sqlText, input.paramOrder);
    assertTagsFit(describedJson, input.columnTags ?? {});
    const created = await datasourceQueryRepo.upsertByName({
      datasourceId: dsId,
      name: input.name,
      description: input.description ?? null,
      sqlText: input.sqlText,
      paramOrder: input.paramOrder,
      paramsSchema: input.paramsSchema,
      columnTags: input.columnTags ?? {},
      describedJson,
    });
    return { query: toPublic(created, ds.name) };
  },

  async update(
    workspaceId: string,
    dsId: string,
    name: string,
    input: z.infer<typeof namedQueryUpdateSchema>,
  ) {
    const ds = await assertDatasource(workspaceId, dsId);
    const existing = (await datasourceQueryRepo.listByDatasource(dsId)).find(
      (q) => q.name === name,
    );
    if (!existing) return undefined;

    const merged = {
      sqlText: input.sqlText ?? existing.sqlText,
      paramOrder: input.paramOrder ?? existing.paramOrder ?? [],
      paramsSchema: (input.paramsSchema ?? existing.paramsSchema ?? {}) as Record<string, unknown>,
      description: input.description ?? existing.description,
      columnTags: (input.columnTags ?? existing.columnTags ?? {}) as Record<string, string>,
    };
    // The MERGED shape is checked, not the patch. A PATCH that changes only the
    // SQL can invalidate a paramOrder it never mentioned, and checking the patch
    // alone would accept it.
    const problems = checkSqlShape(merged.sqlText, merged.paramOrder, merged.paramsSchema);
    if (problems.length > 0) throw sqlShapeError(problems);
    const dialect = await dialectProblems(ds, merged.sqlText);
    if (dialect.length > 0) throw sqlShapeError(dialect);

    const ref = `${ds.name}.${name}`;
    const willSuspend = await armedFlowsUsing(workspaceId, ref);

    const saved = await datasourceQueryRepo.upsertByName({
      datasourceId: dsId,
      name,
      description: merged.description ?? null,
      sqlText: merged.sqlText,
      paramOrder: merged.paramOrder as string[],
      paramsSchema: merged.paramsSchema,
      columnTags: merged.columnTags,
      describedJson: await (async () => { const d = await describeOrNull(ds, merged.sqlText, merged.paramOrder as string[]); assertTagsFit(d, merged.columnTags); return d; })(),
    });
    return { query: toPublic(saved, ds.name), ...suspensionNotice(willSuspend, ref, "changed") };
  },

  async remove(workspaceId: string, dsId: string, name: string) {
    const ds = await assertDatasource(workspaceId, dsId);
    const ref = `${ds.name}.${name}`;
    // Computed BEFORE the delete: afterwards the ref fingerprints as "<missing>"
    // and the flow still references it, but the query row is gone and the report
    // would have nothing to name.
    const willSuspend = await armedFlowsUsing(workspaceId, ref);
    const ok = await datasourceQueryRepo.remove(dsId, name);
    if (!ok) return undefined;
    return suspensionNotice(willSuspend, ref, "deleted");
  },

  /** Exposed for the authoring UI: check without saving. */
  check(input: z.infer<typeof namedQueryBodySchema>) {
    const problems = checkSqlShape(input.sqlText, input.paramOrder, input.paramsSchema);
    return { ok: problems.length === 0, problems };
  },

  /**
   * What editing or deleting this query would unarm — computed WITHOUT doing it.
   *
   * The write routes already report this, and for a delete that is soon enough.
   * For an edit it is not: a client has to be able to warn before the write,
   * because the suspension is not undone by restoring the old SQL (the approval
   * is closed by then). Without this route a UI would have to infer the answer
   * from the flow list, which cannot see `manifest_refs_json` on an armed
   * revision — so it would produce a confidently wrong list.
   *
   * Same computation as the write paths use, deliberately: two implementations
   * would eventually disagree, and the one shown in the confirmation is the one
   * that must match what happens.
   */
  async impact(workspaceId: string, dsId: string, name: string) {
    const ds = await assertDatasource(workspaceId, dsId);
    const exists = (await datasourceQueryRepo.listByDatasource(dsId)).some((q) => q.name === name);
    if (!exists) return undefined;
    const ref = `${ds.name}.${name}`;
    return { ref, ...suspensionNotice(await armedFlowsUsing(workspaceId, ref), ref, "changed") };
  },
};

function sqlShapeError(problems: SqlShapeProblem[]) {
  return Object.assign(
    new Error(
      `this named query cannot be saved:\n` + problems.map((p) => `  • ${p.message}`).join("\n"),
    ),
    { statusCode: 400, problems },
  );
}

function suspensionNotice(
  flows: Array<{ id: string; name: string; armedRevision: number }>,
  ref: string,
  verb: string,
) {
  return {
    /**
     * Not a warning about something that MIGHT happen — the sweep will do this,
     * and the only uncertainty is which tick. Named `willSuspendFlows` rather
     * than `affectedFlows` because "affected" is the kind of word a UI renders
     * as an informational chip.
     */
    willSuspendFlows: flows,
    suspensionReason:
      flows.length === 0
        ? null
        : `"${ref}" ${verb}, and its fingerprint includes the SQL (D-17). The staleness sweep ` +
          `will unarm ${flows.length} flow(s) and remove their Kestra schedule; each needs a new ` +
          "approval against the current shape. This is not reversible by putting the old SQL back " +
          "— the approval is already closed by then.",
  };
}
