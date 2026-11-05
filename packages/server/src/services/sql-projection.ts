/**
 * **What keys does a SELECT's rows arrive under?** — 2026-09-17
 *
 * ── The defect this exists for ──────────────────────────────────────────────
 *
 * Flow `264234b4`, revision 2, on this deployment. Step one is step-local SQL:
 *
 *   SELECT count(*) AS "onboarded_count" FROM "public"."partners_user"
 *
 * Step two reads it with `jq('map({partner_count}) | tostring | @json')`.
 * `{partner_count}` is jq shorthand for `{partner_count: .partner_count}`, that
 * key does not exist, and a jq read of an absent key yields **null** rather than
 * an error. So the model was handed `[{"partner_count": null}]` and truthfully
 * answered that it had no count — while the database read was perfectly healthy
 * and returned 10 rows on the mock and 9 in production.
 *
 * ⚠ **`checkRefOutputFields` already catches exactly this** and could not see
 * it. That check compares a jq read against `RefInterface.columns`, and columns
 * were populated for a **DB operation only** — a structured spec whose
 * `specJson.columns[].alias` is the projection. This flow's read is step-local
 * SQL naming a ref that does not exist (`ML_ZERO_DB` holds zero operations and
 * zero named queries), so `columns` was `undefined` and the check followed its
 * own rule: *cannot see, so says nothing*. `flow-ref-columns.ts` names the gap
 * outright — *"a named query, whose columns live in SQL text nothing here
 * parses."* This module is what parses it.
 *
 * So **no new rule was added to fix that flow.** This is a shape SOURCE for a
 * check that already existed, already blocked, and already emits the right
 * message.
 *
 * ── ⚠ IT REFUSES THE WHOLE STATEMENT, NEVER A PARTIAL LIST ──────────────────
 *
 * `unknown_output_column` is `blocking: true`. A projection missing one real
 * column therefore does not merely under-report — it **refuses a save that
 * should have succeeded**, naming a column the author can see in their own SQL.
 * That is I-62's failure mode, where a guard that cries wolf gets widened until
 * the widening permits the defect it was written for.
 *
 * So every doubt returns `undefined` for the entire statement, and the caller
 * then says nothing at all: `SELECT *`, a set operation, a CTE, an unaliased
 * expression, an implicit alias (`SELECT a b`), a dollar-quoted body, an
 * unterminated quote, more than one statement.
 *
 * ── ⚠ AN UNQUOTED NON-LOWERCASE ALIAS REFUSES THE STATEMENT, AND THAT IS THE
 *      DIALECT QUESTION BEING SIDESTEPPED RATHER THAN ANSWERED ───────────────
 *
 * Postgres folds an unquoted identifier to lower case, so `AS Onboarded_Count`
 * arrives under the key `onboarded_count`. **MySQL preserves it.** Folding here
 * would invent a false positive on MySQL; not folding would invent one on
 * Postgres — and this module is handed no dialect, because a step-local
 * statement is checked before anything resolves a datasource.
 *
 * Rather than guess, an unquoted alias that is not already all-lower-case
 * returns `undefined` for the whole statement. It costs almost nothing (real
 * SQL is lower-case or quoted) and it cannot be wrong in either dialect.
 * ⚠ **Do not "improve" this by folding.** The improvement is to pass the
 * dialect in, and that is a different change with a different blast radius.
 *
 * A QUOTED alias is taken byte-exact in both dialects, which is why the flow
 * above is checkable at all: `AS "onboarded_count"` is unambiguous.
 */

/**
 * An unquoted identifier we are willing to trust: already lower case, so it
 * survives Postgres's folding unchanged and MySQL's non-folding unchanged.
 */
const SAFE_BARE_IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * The column keys a statement's rows arrive under, or `undefined` when that
 * cannot be known with certainty.
 *
 * ⚠ `undefined` and `[]` are NOT interchangeable, for `RefInterface.columns`'
 * reason: an empty array is a claim that the statement projects nothing, and a
 * caller comparing against it would report every read as unknown. This never
 * returns an empty array.
 */
export function selectProjection(sql: string): string[] | undefined {
  if (typeof sql !== "string" || sql.trim().length === 0) return undefined;

  const uncommented = stripComments(sql);
  if (uncommented === undefined) return undefined;

  const text = uncommented.trim().replace(/;+\s*$/, "");
  const m = maskLiterals(text);
  // An unterminated quote — the mask cannot be trusted, so nothing can.
  if (m === undefined) return undefined;
  // More than one statement. The mask hides a `;` inside a literal, so this is
  // asking about real syntax rather than about text.
  if (m.includes(";")) return undefined;

  // A CTE's outer SELECT is parseable in principle and following one correctly
  // is a parser, not a scan. Refused whole.
  if (/^\s*with\b/i.test(m)) return undefined;

  const select = /^\s*select\b/i.exec(m);
  if (!select) return undefined;

  // A set operation's arms can project different aliases; the first arm's names
  // win at runtime, which is exactly the kind of subtlety this must not guess.
  if (hasTopLevel(m, /^(union|intersect|except)\b/i, select[0].length)) return undefined;

  let start = select[0].length;
  const qualifier = /^\s*(distinct|all)\b/i.exec(m.slice(start));
  if (qualifier) {
    // `DISTINCT ON (…)` puts an expression list before the projection.
    if (
      /distinct/i.test(qualifier[1]!) &&
      /^\s*on\b/i.test(m.slice(start + qualifier[0].length))
    ) {
      return undefined;
    }
    start += qualifier[0].length;
  }

  const end = topLevelFrom(m, start);
  const keys: string[] = [];
  for (const [from, to] of splitTopLevel(m, start, end)) {
    const key = keyOf(text.slice(from, to), m.slice(from, to));
    if (key === undefined) return undefined;
    keys.push(key);
  }
  // `SELECT FROM t` is legal in Postgres and projects nothing. Not an error,
  // and not a shape a caller may compare against either.
  if (keys.length === 0) return undefined;
  // Two columns under one key is a statement whose rows cannot be described by
  // a key set at all — the later one wins in the payload and the earlier is
  // silently unreachable.
  if (new Set(keys).size !== keys.length) return undefined;
  return keys;
}

/** The key one select-list item arrives under, or `undefined`. */
function keyOf(real: string, m: string): string | undefined {
  const at = lastTopLevelAs(m);
  if (at !== null) {
    return identKey(real.slice(at.end).trim(), m.slice(at.end).trim());
  }
  // No `AS`, so the item must BE a column reference. An expression without an
  // alias has no name a caller could read it by, and `SELECT a b` — an implicit
  // alias — is deliberately refused rather than parsed: telling that apart from
  // a two-token expression is the parser this module declines to be.
  //
  // The mask preserves length and every position outside a literal, so trimming
  // the two strings removes the same characters from each and the slices below
  // stay aligned.
  const realTrimmed = real.trim();
  const maskTrimmed = m.trim();
  const dot = lastTopLevelDot(maskTrimmed);
  if (dot === null) return identKey(realTrimmed, maskTrimmed);
  return identKey(realTrimmed.slice(dot + 1).trim(), maskTrimmed.slice(dot + 1).trim());
}

/** An identifier token as a key: quoted is byte-exact, bare must be lower case. */
function identKey(real: string, m: string): string | undefined {
  if (real.length === 0) return undefined;
  if (real.startsWith('"')) {
    // The mask proves the quote closes at the very end, i.e. this is ONE token.
    if (!m.endsWith('"') || m.length < 2 || m.slice(1, -1).includes('"')) return undefined;
    const inner = real.slice(1, -1).replace(/""/g, '"');
    return inner.length > 0 ? inner : undefined;
  }
  return SAFE_BARE_IDENT.test(real) ? real : undefined;
}

/** Position of the last depth-0 `AS` keyword in a masked item. */
function lastTopLevelAs(m: string): { end: number } | null {
  let depth = 0;
  let found: number | null = null;
  for (let i = 0; i < m.length; i++) {
    const c = m[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && (c === "a" || c === "A") && /^as\b/i.test(m.slice(i, i + 3))) {
      if (i === 0 || /[\s)"]/.test(m[i - 1]!)) found = i + 2;
    }
  }
  return found === null ? null : { end: found };
}

/** Position of the last depth-0 `.` in a masked item. */
function lastTopLevelDot(m: string): number | null {
  let depth = 0;
  let found: number | null = null;
  for (let i = 0; i < m.length; i++) {
    const c = m[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && c === ".") found = i;
  }
  return found;
}

/** Is `re` matched at depth 0 anywhere at or after `from`? */
function hasTopLevel(m: string, re: RegExp, from: number): boolean {
  let depth = 0;
  for (let i = from; i < m.length; i++) {
    const c = m[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && re.test(m.slice(i)) && (i === 0 || /[\s)]/.test(m[i - 1]!))) {
      return true;
    }
  }
  return false;
}

/** Index of the depth-0 `FROM`, or the end of the text when there is none. */
function topLevelFrom(m: string, start: number): number {
  let depth = 0;
  for (let i = start; i < m.length; i++) {
    const c = m[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (
      depth === 0 &&
      (c === "f" || c === "F") &&
      /^from\b/i.test(m.slice(i, i + 5)) &&
      (i === 0 || /[\s)"]/.test(m[i - 1]!))
    ) {
      return i;
    }
  }
  return m.length;
}

/** Index ranges of the depth-0 comma-separated items between `start` and `end`. */
function splitTopLevel(m: string, start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i++) {
    const c = m[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push([from, i]);
      from = i + 1;
    }
  }
  if (m.slice(from, end).trim().length > 0) out.push([from, end]);
  return out;
}

/**
 * Remove `--` and block comments. A comment can carry a comma, a `FROM` or a
 * quote, so every structural scan below would be wrong without this.
 */
function stripComments(sql: string): string | undefined {
  // A dollar-quoted body can contain anything at all, including an unmatched
  // quote. `$1` placeholders are untouched — this looks for the `$$` form only.
  if (/\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$/.test(sql)) return undefined;
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      const close = closeQuote(sql, i, c);
      if (close < 0) return undefined;
      out += sql.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      if (nl < 0) return `${out} `;
      out += " ";
      i = nl + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      if (close < 0) return undefined;
      out += " ";
      i = close + 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * The text with every literal's CONTENTS replaced by `x`, same length, quotes
 * kept. Structural scans run on this so that a comma, a keyword or a paren
 * inside `'…'` or `"…"` cannot be mistaken for syntax, while every index still
 * addresses the real text.
 */
function maskLiterals(text: string): string | undefined {
  const out = text.split("");
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "'" || c === '"') {
      const close = closeQuote(text, i, c);
      if (close < 0) return undefined;
      for (let k = i + 1; k < close; k++) out[k] = "x";
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** Index of the quote closing the one opened at `start`, or -1. A doubled quote escapes. */
function closeQuote(s: string, start: number, q: string): number {
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === q) {
      if (s[i + 1] === q) {
        i += 2;
        continue;
      }
      return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * **Is this a read that lives in the WORKFLOW rather than in the data source?**
 *
 * ⚠ **Both keys, never one.** `sql` alone leaves the executor to guess the
 * datasource from the `ref` prefix — exactly the guess a step-local read has no
 * registered ref to support. `datasourceRef` alone claims a freeze that is not
 * there.
 *
 * `checkStepLocalSql` reports either half on its own; this predicate answers
 * only "is it the complete shape", and every caller that DECIDES something uses
 * it rather than testing one field.
 *
 * ⚠ Moved here on 2026-09-17 from `flow-validator.service.ts`, where it was a
 * module-private function, because `flow-ref-columns.ts` now needs the same
 * answer and `flow-validator` already imports that module — so defining it
 * again there would have been the second definition D-197 refuses, on a
 * predicate that decides whether a statement is checked at all. This module
 * imports nothing, so it can be the shared home without a cycle.
 */
export function isStepLocalSql(step: { sql?: string; datasourceRef?: string }): boolean {
  return Boolean(step.sql?.trim() && step.datasourceRef?.trim());
}

/**
 * **Does this step resolve its `ref` against the workspace MANIFEST?**
 *
 * ── ⚠ THE DEFECT THIS EXISTS FOR, AND WHY IT IS A PREDICATE RATHER THAN A
 *    FILTER WRITTEN OUT THREE TIMES ─────────────────────────────────────────
 *
 * Three places independently decided which steps name something in the
 * manifest, and on 2026-09-17 they disagreed:
 *
 *   * `checkFlowRefs` exempted a step-local read (it carries its own SQL, so
 *     there is no registered reader to look up) — correct, and it used
 *     `isStepLocalSql` to say so;
 *   * `flowCompiler.refsOf` did not, so every step-local read contributed a ref
 *     that `refFingerprints()` has no key for;
 *   * `flowService.writeRevision` did not either, so it recorded
 *     `{"<ds>.<name>": "<missing>"}` as the shape the revision was written
 *     against.
 *
 * The consequence was measured on the running deployment: **5 of 11 flows —
 * every one carrying a step-local read — could not be published at all.**
 * `flowApprovalService.approve` computes `missing` from `refsOf` and refuses
 * with *"revision N references 1 thing(s) this workspace no longer has"*, about
 * a read the validator had already, deliberately, decided needs no
 * registration. Saving worked, test-running worked, and publishing — the one
 * act that reaches for the manifest — did not. A flow with a cron on it was
 * therefore unschedulable for the same reason, since approval is the only path
 * that deploys a Kestra Schedule.
 *
 * ⚠ **Excluding it loses NOTHING that §6.5 protects.** A step-local read's
 * whole shape — `sql`, `sqlParamOrder`, `sqlParamsSchema`, `datasourceRef` — is
 * inside `flowCompiler.structureHash`, which is stored on every revision row,
 * so editing the statement already invalidates an approval. The manifest
 * fingerprint answers a different question — *did something OUTSIDE this
 * revision change under it* — and for a read that lives in the workflow the
 * honest answer is "there is nothing outside this revision to change", exactly
 * as it is for `transform` and `code`.
 *
 * ⚠ **The datasource is deliberately NOT fingerprinted in its place.**
 * `refFingerprints()`' keys are handed to `checkFlowRefs` as the list of
 * callable refs (`flow-catalogue.service.ts`, `flow.service.ts`), so adding a
 * bare `<datasource>` key would also make `ref: "hr_demo"` a legal ref for an
 * ordinary `datasource` step — a widening of what may be called, bought to fix
 * a staleness gap that has never fired. That gap (deleting a datasource a
 * step-local read points at) is real and is stated here rather than closed by
 * a change that costs more than it buys.
 *
 * ⚠ **A TYPE PREDICATE, because every caller reads `step.ref` immediately
 * after.** Returning a plain boolean would leave the union unnarrowed and each
 * call site reaching for a non-null assertion or re-testing the kind — which is
 * the second definition coming back as a cast.
 */
export function namesManifestRef<T extends { kind?: string; sql?: string; datasourceRef?: string }>(
  step: T,
): step is T & { kind: "tool" | "datasource" | "query"; ref: string } {
  if (step.kind !== "tool" && step.kind !== "datasource" && step.kind !== "query") return false;
  return !isStepLocalSql(step);
}
