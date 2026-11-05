/**
 * ─────────────────────────────────────────────────────────────────────────────
 * A BARE IDENTIFIER THAT POSTGRES WILL FOLD — the check half of the quoting rule
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Measured at the wire against a tenant's Azure Postgres whose schema is
 * Prisma-shaped — 46 PascalCase tables, camelCase columns. `proposeQuery` had
 * the model write:
 *
 *     SELECT id, email, firstName, ... FROM public.User ORDER BY email
 *
 * Postgres folds every UNQUOTED identifier to lower case, so that asks for
 * `public.user` and `firstname`:
 *
 *     ... FROM public.User                    -> relation "public.user" does not exist
 *     ... firstName ... FROM "public"."User"  -> column "firstname" does not exist
 *     ... every identifier quoted             -> OK, returns rows
 *
 * ⚠ **The model did not hallucinate.** All eleven columns it named are real and
 * correctly spelled — it read the schema right and emitted SQL that cannot
 * address it. Every one of that datasource's 46 tables was affected, so no
 * step-local query against it could work at all.
 *
 * The prompt half of the fix (`db-query-proposal.service.ts`: a quoted SCHEMA
 * rendering, a quoting rule, and a quoted worked example) is what makes the
 * model get this right. This module is the half that makes it CHECKED — a
 * prompt rule the model can ignore is not a control (I-118).
 *
 * ── REFUSE, never repair ─────────────────────────────────────────────────────
 *
 * A finding here joins `checkSqlShape`'s findings and is fed back verbatim into
 * the proposer's retry loop, so the model rewrites its own SQL. It is
 * deliberately NOT a rewrite performed here, for two reasons:
 *
 *  1. Quoting an identifier correctly means knowing which bare words in a
 *     statement are catalog references and which are keywords, functions,
 *     aliases or output-column references. Getting that wrong does not fail
 *     loudly — it produces SQL that compiles and reads something else, which is
 *     D-55's rule about a structural guess ("a wrong guess there compiles and
 *     does the wrong thing"). A refusal that names the identifier and shows the
 *     quoted form costs one attempt and cannot be wrong in that direction.
 *  2. A silent rewrite of a model's SQL means the SQL a person approves on the
 *     readback screen is not the SQL the model proposed, and nothing on that
 *     screen would say so.
 *
 * ── WHAT IS FLAGGED, and why nothing else is (I-62) ──────────────────────────
 *
 * A guard that fires on correct SQL gets widened until the widening permits the
 * defect. So this flags ONE thing, and only when it is provably a future
 * failure: a real identifier that is **not already all-lower-case** — i.e. one
 * that genuinely requires quoting — appearing in the SQL as a BARE word, spelled
 * with exactly the case the catalog holds.
 *
 * Everything below is deliberately NOT flagged:
 *
 *  * **An all-lower-case identifier.** `invoices` and `"invoices"` are the same
 *    relation, so an existing lower-case snake_case datasource (`hr_demo`,
 *    `finance_demo`, `legal_demo`) can never produce a finding here. Quoting is
 *    correct and harmless for those schemas; not quoting them is also correct.
 *    This check cannot regress them, and the prompt change cannot either.
 *  * **Anything inside a string literal or a comment.** `SELECT 'User' AS kind`
 *    names no relation. Scanned and skipped.
 *  * **Anything already inside double quotes.** `"public"."User"` is the correct
 *    form and must never be reported as the thing it is the fix for.
 *  * **An alias declaration.** `AS firstName` and an implicit alias after a
 *    quoted identifier or a `)` (`"u"."firstName" firstName`) name an OUTPUT
 *    column, not a catalog one. Postgres folds it, so the result column is
 *    `firstname` — sloppy, but it runs and returns rows, and this check exists
 *    for what provably cannot run.
 *  * **A different spelling.** Bare `user` where the catalog holds `User` is NOT
 *    reported: `user` is a Postgres reserved word, and a word that is not the
 *    catalog's own spelling is not provably a reference to it. Only the exact
 *    spelling is proof.
 *  * **A name whose lower-cased form is ALSO a real identifier.** If a schema
 *    holds both `User` and `user`, bare `User` folds to `user`, which exists —
 *    so it is not provably wrong, whatever the author meant.
 *
 * ⚠ Two residuals are accepted rather than papered over, both under-flags or
 * vanishing:
 *
 *  * An implicit alias following a BARE word (`SELECT amount Amount`) is
 *    reported. Reaching it requires an unquoted column reference in the same
 *    clause, which is the defect this check is for — so it is self-limiting,
 *    and the finding names a real thing to fix.
 *  * A mixed-case keyword colliding with a mixed-case identifier (a column
 *    called `Order` in SQL written `Order By`) would be reported. No keyword
 *    skip-list is used, deliberately: `"Order"` is one of the commonest Prisma
 *    table names, and skipping it by name would blind the check to exactly the
 *    schema shape that motivated it. Models write `ORDER BY` or `order by`,
 *    neither of which matches the spelling `Order`.
 */

import type { SchemaRow } from "../repositories/schema.repo.js";

export interface IdentifierQuotingProblem {
  code: "unquoted_identifier" | "misquoted_identifier";
  message: string;
}

/**
 * One bare (unquoted, non-literal, non-comment) word token, with just enough
 * about what precedes it to tell a catalog reference from an alias.
 *
 * `prev` is the last significant character before the token:
 *   `"` — the token follows a quoted identifier, so it is an implicit alias
 *   `)` — the token follows a parenthesised expression, likewise
 *   `.` — the token is the right-hand side of a qualified reference
 *   anything else, or nothing
 *
 * `prevWord` is the bare word immediately before it, when there was one — the
 * only thing that distinguishes `AS firstName` from `SELECT firstName`.
 */
interface BareWord {
  word: string;
  prev: string | null;
  prevWord: string | null;
  /** True for a `"double quoted"` identifier, false for a bare word. */
  quoted?: boolean;
}

const WORD_START = /[A-Za-z_]/;
const WORD_CHAR = /[A-Za-z0-9_$]/;

/**
 * Walk the statement once, yielding every bare word token.
 *
 * A local scanner rather than `datasource-query.service.ts`'s `stripLiterals`
 * (which is module-private anyway): that one blanks quoted identifiers into
 * spaces of equal length, and the whole alias exclusion below turns on being
 * able to tell "preceded by a quoted identifier" from "preceded by whitespace".
 */
function scanTokens(sql: string): BareWord[] {
  const out: BareWord[] = [];
  let i = 0;
  // The last significant (non-whitespace) character consumed, and the last bare
  // word seen — both carried forward so a token knows its own left context.
  let prev: string | null = null;
  let prevWord: string | null = null;

  while (i < sql.length) {
    const c = sql[i]!;

    if (c === "'" || c === '"') {
      // Doubled quote is an escape inside the literal/identifier, not a close —
      // same rule `stripLiterals` applies, for the same reason.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      // ⚠ A DOUBLE-quoted run is an identifier and is emitted, because
      // `checkQuotedIdentifiers` below needs it. A SINGLE-quoted run is a string
      // literal and stays discarded — `SELECT 'User'` names no relation.
      if (c === '"') {
        out.push({
          word: sql.slice(i + 1, Math.min(j, sql.length)).replace(/""/g, '"'),
          prev,
          prevWord,
          quoted: true,
        });
      }
      prev = c;
      prevWord = null;
      i = Math.min(j, sql.length) + 1;
      continue;
    }

    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }

    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }

    if (WORD_START.test(c)) {
      let j = i;
      while (j < sql.length && WORD_CHAR.test(sql[j]!)) j++;
      const word = sql.slice(i, j);
      out.push({ word, prev, prevWord });
      prev = word[word.length - 1]!;
      prevWord = word;
      i = j;
      continue;
    }

    if (!/\s/.test(c)) {
      prev = c;
      // A punctuation character ends the run of words — `a, b` must not let `b`
      // see `a` as the word immediately before it, or every comma-separated
      // alias would read as one.
      if (c !== ".") prevWord = null;
    }
    i++;
  }
  return out;
}

/**
 * Every token, bare and quoted. `bareWords` is the bare-only view of this, so
 * there is ONE scanner: a second one would drift in the direction where the
 * untested copy stops matching, and both halves of this check depend on the
 * same reading of what is a literal, a comment and an alias.
 */
function allTokens(sql: string): BareWord[] {
  return scanTokens(sql);
}

/** The bare (unquoted) tokens alone — the subject of the fold check. */
export function bareWords(sql: string): BareWord[] {
  return scanTokens(sql).filter((t) => !t.quoted);
}

/**
 * Real identifiers that genuinely require quoting, indexed by their exact
 * spelling, with the set of EVERY real spelling beside it.
 *
 * `exactNames` is what the collision guard needs: a schema holding both `User`
 * and `user` makes bare `User` fold onto a relation that exists, so it is not
 * provably wrong and must not be reported.
 */
function foldingIdentifiers(rows: SchemaRow[]): {
  needQuoting: Map<string, "table" | "column">;
  exactNames: Set<string>;
} {
  const needQuoting = new Map<string, "table" | "column">();
  const exactNames = new Set<string>();

  const note = (name: string | null, kind: "table" | "column") => {
    if (!name) return;
    exactNames.add(name);
    // An all-lower-case name folds to itself, so bare use of it is correct.
    if (name === name.toLowerCase()) return;
    // A table and a column may share a spelling; the wording of the finding is
    // the only thing that differs, and the fix is identical either way.
    if (!needQuoting.has(name)) needQuoting.set(name, kind);
  };

  for (const r of rows) {
    note(r.entityName, "table");
    note(r.entitySchema, "table");
    note(r.columnName, "column");
  }
  return { needQuoting, exactNames };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OTHER DIRECTION: a QUOTED identifier that matches nothing real
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ **This is the failure mode the quoting rule itself introduces, and it is the
 * reason "always quote" is a package rather than a single rule.** Measured on
 * the same database:
 *
 *     SELECT Email   FROM "public"."User"  -> OK    (folds to `email`, which exists)
 *     SELECT "Email" FROM "public"."User"  -> FAIL  column "Email" does not exist
 *
 * Quoting REMOVES the accidental forgiveness of case folding. Bare SQL tolerates
 * a mis-cased name on a lower-case schema; quoted SQL does not. So telling the
 * model to quote everything, without also requiring the names to be byte-exact,
 * would trade one class of failure for another — and the new class would land on
 * the lower-case datasources that work perfectly today (`hr_demo`,
 * `finance_demo`, `legal_demo`), which is a strictly worse bargain.
 *
 * That is what this check pays for. The prompt renders the schema quoted and
 * exact so the model copies bytes rather than remembering casing; this proves
 * it did.
 *
 * ── WHAT IS FLAGGED, and why nothing else is (I-62 again) ────────────────────
 *
 * ONE thing: a quoted identifier that is **not** any real spelling, but whose
 * case-insensitive form **is** one. That pair is the proof — the author plainly
 * meant the real identifier and mis-cased it, and the statement cannot run.
 *
 * Deliberately NOT flagged:
 *
 *  * **A quoted name matching nothing at all, in any casing.** `"user_id"`,
 *    `"recent"`, `"total"` — an alias, a CTE name, or a derived column. There is
 *    no real identifier it could be a mis-spelling OF, so there is no proof, and
 *    a guard without proof is the one that gets widened until it permits the
 *    defect. A name that is simply wrong is `checkSqlShape`'s business.
 *  * **An alias declaration.** `AS "FirstName"` names an output column, and an
 *    output column may be called whatever the author likes — including something
 *    that case-insensitively collides with a real column. This is the exclusion
 *    that matters most: aliasing to a prettier name is a thing people do.
 *  * **An implicit alias** — a quoted identifier directly after another quoted
 *    identifier or a `)`, as in `FROM "public"."User" "U"`.
 *
 * ⚠ One accepted residual, named rather than papered over: a CTE defined as
 * `WITH "User" AS (...)` on a schema that also holds a real `User` spelled
 * differently would be reported. It requires deliberately naming a CTE after a
 * real table in the one casing the catalog does not use; the finding names the
 * identifier and the fix is to spell it as the catalog does.
 */
function checkQuotedIdentifiers(
  tokens: BareWord[],
  exactNames: Set<string>,
): IdentifierQuotingProblem[] {
  // Every real spelling, indexed by its folded form, so a mis-cased quote can be
  // shown the spelling it should have had.
  const byLower = new Map<string, string>();
  for (const n of exactNames) if (!byLower.has(n.toLowerCase())) byLower.set(n.toLowerCase(), n);

  const offenders = new Map<string, string>();
  for (const t of tokens) {
    if (!t.quoted) continue;
    if (exactNames.has(t.word)) continue; // a real spelling — correct
    if (t.prevWord && t.prevWord.toLowerCase() === "as") continue; // explicit alias
    if (t.prev === '"' || t.prev === ")") continue; // implicit alias
    const real = byLower.get(t.word.toLowerCase());
    if (!real) continue; // nothing real it could be a mis-spelling of — no proof
    offenders.set(t.word, real);
  }

  return [...offenders.entries()].map(([written, real]) => ({
    code: "misquoted_identifier" as const,
    message:
      `the identifier "${written}" is quoted but is not how this schema spells it. A quoted ` +
      `identifier is matched exactly — unlike a bare one, which Postgres folds — so this ` +
      `statement fails at execution, after approval. The schema spells it "${real}": copy it ` +
      `byte for byte.`,
  }));
}

/**
 * Every provably-unaddressable identifier in a proposed statement.
 *
 * Returns problems rather than throwing, matching `checkSqlShape` — a proposer
 * fixing one identifier per round trip would spend its three attempts on a
 * schema with two PascalCase tables in it.
 */
export function checkIdentifierQuoting(
  sqlText: string,
  schemaRows: SchemaRow[],
): IdentifierQuotingProblem[] {
  const { needQuoting, exactNames } = foldingIdentifiers(schemaRows);
  // ⚠ NOT an early return on `needQuoting.size === 0` any more. A schema of
  // entirely lower-case names produces no fold findings, and it is exactly where
  // a mis-cased QUOTED name bites — `"Email"` against a real `email`. Returning
  // early here would have switched the new half off for every existing
  // datasource in the product.
  const tokens = allTokens(sqlText);
  const misquoted = exactNames.size ? checkQuotedIdentifiers(tokens, exactNames) : [];
  if (needQuoting.size === 0) return misquoted;
  // Every name declared as an explicit `AS <name>` alias anywhere in the
  // statement. Excluded wholesale, because a later `ORDER BY firstName` is then
  // a reference to that folded OUTPUT column and resolves exactly as written.
  // This can under-flag (a query aliasing to the same name it also reads bare);
  // under-flagging is recoverable, and a guard that cries wolf is not (I-62).
  const declaredAliases = new Set<string>();
  for (const t of tokens) {
    if (t.prevWord && t.prevWord.toLowerCase() === "as") declaredAliases.add(t.word);
  }

  const offenders = new Map<string, "table" | "column">();
  for (const t of tokens) {
    // ⚠ BARE tokens only. `tokens` now carries quoted identifiers too (the other
    // half of this check needs them), and a quoted `"User"` is the CORRECT form —
    // reporting it as unquoted would make this guard fire on the very fix it
    // tells people to apply.
    if (t.quoted) continue;
    const kind = needQuoting.get(t.word);
    if (!kind) continue;
    if (declaredAliases.has(t.word)) continue;
    // `User` folds to `user`, and this schema also holds a real `user` — so the
    // bare form resolves to something that exists and is not provably wrong.
    if (exactNames.has(t.word.toLowerCase())) continue;
    if (t.prev === '"' || t.prev === ")") continue; // implicit alias
    if (t.prevWord && t.prevWord.toLowerCase() === "as") continue; // explicit alias
    offenders.set(t.word, kind);
  }

  const bare = [...offenders.entries()].map(([name, kind]) => ({
    code: "unquoted_identifier" as const,
    message:
      `the ${kind} identifier ${name} is written bare. Postgres folds an unquoted identifier ` +
      `to lower case, so this asks for "${name.toLowerCase()}", which does not exist in this ` +
      `schema — the statement fails at execution, after approval. Write it double-quoted, ` +
      `exactly as the SCHEMA spells it: "${name}"`,
  }));
  return [...bare, ...misquoted];
}
