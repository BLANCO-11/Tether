/**
 * Does a step read a column its DB operation actually returns? — 2026-09-08
 *
 * ── The defect, measured at the wire ────────────────────────────────────────
 *
 * Kestra execution `3VRhNsJO8222ebwGOQClFH` failed with
 * `{"to":["Expected string, received null"]}` on all 8 of its email calls. The
 * transform was:
 *
 *   [.[] | {to: [.customer_email], subject: "Your order is late", body: tostring}]
 *
 * and `orders_demo.past_due_orders` projects seven columns, none of them
 * `customer_email`. The literal `null` is nowhere in the flow — it is what a jq
 * read of an absent key yields — so no check for bad VALUES could have seen it.
 *
 * ⚠ **The failing case is the lucky one.** A null recipient is refused by the
 * mail route, so that flow went red. `sort_by(.created_at) | first` over rows
 * with no `created_at` returns an arbitrary row and the execution settles
 * SUCCESS. Measured across this deployment's 29 transform steps over an
 * operation: **14 read a column that does not exist**, and only the email ones
 * failed. That is D-68's finding — *"eleven rows of nulls, a green run"* — with
 * a new subject.
 *
 * ── Why this is checkable at all, and why it was not before ─────────────────
 *
 * `checkOutputShapes` validates the envelope (`results`/`succeeded`/`failed`/
 * `warnings`/`readFrom`) and stops, stating the bound it believed: *"only the
 * tenant's data says whether `employees` exists."* True of a tool and of a
 * named query, whose columns live in SQL text nothing here parses. **False of a
 * DB operation**, which is a structured spec: `specJson.columns[].alias` is the
 * projection, so it is the exact key set of every object at `.results[0].data[i]`.
 * `RefInterface.columns` now carries it — read that field's docblock.
 *
 * ── ⚠ WHY THIS IS A STAGE-AWARE SCANNER AND NOT A NAME LIST ─────────────────
 *
 * The first version of this check was a regex for `.name` over the whole jq
 * program, and it reported **false positives on real flows** — the failure mode
 * I-62 warns about, where a guard that cries wolf gets widened and the widening
 * permits the defect. jq is a pipeline, and only the FIRST stages see the query
 * rows:
 *
 *   group_by(.customer)
 *   | map({customer: .[0].customer, amount_owed: (map(.amount) | add)})
 *   | sort_by(.amount_owed)
 *
 * `.customer` and `.amount` are read off the rows and are genuinely wrong when
 * the operation does not project them. `.amount_owed` is read off an object jq
 * itself built one stage earlier and is **correct**. A flat name list cannot
 * tell those apart, so it either misses the first two or slanders the third.
 *
 * So the program is split at top-level `|` and a read in stage *i* is checked
 * only against keys constructed in stages *< i*. Verified against all 14
 * measured cases: every one is reported and `.amount_owed` is not.
 *
 * ── ⚠ WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
 *
 * - **Only `operation` refs.** A tool and a named query declare no output shape
 *   here, so `columns === undefined` and this says nothing at all. It never
 *   guesses from a name.
 * - **Only where the source is UNAMBIGUOUS.** An expression naming two upstream
 *   steps could take its jq input from either; attributing the program to one of
 *   them would be a guess, so such an expression is skipped entirely.
 * - **Only where the rows are actually the jq input** — the read must go through
 *   `.results[…].data`. `json(outputs.x.body) | jq('.succeeded')` reads the
 *   envelope, not a row, and is right.
 * - **It reports and BLOCKS, but only on a name that cannot exist.** The finding
 *   carries the full column list, which is what makes the corrective pass able
 *   to fix it: the model is handed the projection rather than asked to guess
 *   again (the `unknown_ref` idiom, whose `available` list exists for the same
 *   reason).
 * - **No arithmetic on jq semantics beyond stages.** `.a.b` reports `a` only;
 *   whether `a` has a `b` is the tenant's data again.
 */
import { selectProjection, isStepLocalSql } from "./sql-projection.js";
import type { FlowModel } from "./flow-compiler.service.js";
import type { FlowFinding } from "./flow-validator.service.js";
import { EXPRESSION_FIELDS } from "./flow-expression.service.js";

/** `jq('…')` and `jq("…")` program bodies, in source order. */
function jqPrograms(expr: string): string[] {
  const out: string[] = [];
  const re = /jq\(\s*(['"])([\s\S]*?)\1\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) out.push(m[2]);
  return out;
}

/**
 * Split a jq program at its TOP-LEVEL `|` only.
 *
 * `map(.amount) | add` inside `(...)` is one stage from the outside, so depth
 * has to be tracked across `()`, `[]`, `{}` and both quote styles. Getting this
 * wrong in the permissive direction merges stages and loses a real finding;
 * getting it wrong the other way splits an inner pipeline and invents one.
 */
export function jqStages(program: string): string[] {
  const stages: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < program.length; i += 1) {
    const c = program[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "|" && depth === 0) {
      stages.push(program.slice(start, i));
      start = i + 1;
    }
  }
  stages.push(program.slice(start));
  return stages;
}

/**
 * Drop jq STRING LITERALS, keeping only what an interpolation reads.
 *
 * ⚠ **THIS EXISTS BECAUSE THE CHECK FIRED ON AN EMAIL ADDRESS.** A real
 * authoring attempt was refused with *'reads "com", "saini" from
 * "unhappy_responses", which returns no such column'* — the flow contained
 * `sender: "himanshu.saini@microland.com"`, and `readsIn` was scanning the raw
 * stage text, so the dots inside a quoted literal read as column accesses. Any
 * dotted string would do it: a hostname, a filename, a version, a decimal in
 * prose. **I-62 exactly** — a guard that cries wolf gets widened, and the
 * widening people reach for is the one that permits the defect.
 *
 * ⚠ **An interpolation is a REAL read and is kept.** jq's `"\(.customer_name)"`
 * reads a column from inside a string, so stripping literals wholesale would
 * trade a false positive for a false negative — silently, and in the direction
 * this module exists to prevent. So the contents of each `\( … )` survive, with
 * paren nesting tracked, and everything else between the quotes does not.
 *
 * ⚠ Only DOUBLE quotes. jq has no single-quoted string; a `'` inside a jq
 * program is Pebble's own delimiter for the `jq('…')` argument and never opens a
 * jq literal. Treating it as one would swallow the whole program.
 */
export function stripStrings(stage: string): string {
  let out = "";
  let i = 0;
  while (i < stage.length) {
    if (stage[i] !== '"') {
      out += stage[i];
      i += 1;
      continue;
    }
    i += 1; // past the opening quote
    while (i < stage.length && stage[i] !== '"') {
      if (stage[i] === "\\" && stage[i + 1] === "(") {
        // An interpolation: keep its body, honouring nested parens.
        i += 2;
        let depth = 1;
        while (i < stage.length && depth > 0) {
          if (stage[i] === "(") depth += 1;
          else if (stage[i] === ")") depth -= 1;
          if (depth > 0) out += stage[i];
          i += 1;
        }
        // A space so `"\(.a)\(.b)"` cannot concatenate into one name.
        out += " ";
        continue;
      }
      // Any other escape consumes the next character, so a `\"` does not end
      // the literal early and leave the rest of the program unscanned.
      i += stage[i] === "\\" ? 2 : 1;
    }
    i += 1; // past the closing quote
  }
  return out;
}

/**
 * **jq's object-construction SHORTHAND, which is both a read and a key.**
 *
 * `{partner_count}` is jq's spelling of `{partner_count: .partner_count}`, and
 * ⚠ **it was invisible to both scanners below**: it carries no leading dot, so
 * `readsIn` did not see the read, and no colon, so `keysIn` did not see the key.
 *
 * That is why this check could not catch the defect it was extended for on
 * 2026-09-17 — flow `264234b4`'s `jq('map({partner_count})')` over a statement
 * projecting `onboarded_count`. Giving the check a shape to compare against was
 * only half; without this it had the projection and still read nothing.
 *
 * ⚠ **Matched conservatively.** An element qualifies only when it is a bare
 * identifier sitting between `{` or `,` and `,` or `}` — so `{a: .x}` (a colon
 * follows), `{$v}` (not an identifier) and `f(a, b)` or `[a, b]` (neither
 * delimiter is a brace) are all left alone. A miss here under-reports, which is
 * the direction this module is allowed to fail in; a false match would refuse a
 * correct save.
 */
function shorthandIn(stage: string): string[] {
  const out: string[] = [];
  const text = stripStrings(stage);
  // Overlapping delimiters — `{a, b}` shares the comma — so the scan steps
  // forward one character at a time rather than using a global match.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{" && text[i] !== ",") continue;
    const m = /^[{,]\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=[,}])/.exec(text.slice(i));
    if (m) out.push(m[1]!);
  }
  return out;
}

/** `.name` reads in one stage. `.a.b` yields `a`; `.[0]` and `.[]` yield nothing. */
function readsIn(stage: string): string[] {
  return [
    ...[...stripStrings(stage).matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!),
    ...shorthandIn(stage),
  ];
}

/** Object-literal keys a stage CONSTRUCTS — `{to: …, subject: …}` → to, subject. */
function keysIn(stage: string): string[] {
  // ⚠ Stripped too. A literal containing a colon (`"code: value"`) would
  // otherwise register as a constructed key, which suppresses a finding rather
  // than inventing one — the safe direction, but still wrong, and the two
  // scanners disagreeing about what is a string is how one of them stops
  // matching quietly.
  return [
    ...[...stripStrings(stage).matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((m) => m[1]!),
  ];
  /**
   * ⚠ **A shorthand is deliberately NOT added here, and it was removed after a
   * perturbation showed it could not fail (I-38).**
   *
   * `{partner_count}` constructs the key `partner_count` and reads `.partner_count`
   * — the two strings are the same by definition of the shorthand. So if the
   * name is a real column, a later `.partner_count` passes on `known` anyway;
   * and if it is not, the earlier stage already put it in `unknown`, which is a
   * Set, so the second occurrence adds nothing. Including it changed no answer
   * on any input, which is exactly the shape of a control that cannot fire.
   * `readsIn` is where the shorthand does real work.
   */
}

/**
 * jq builtins and Foundry envelope keys that are never a row column.
 *
 * ⚠ A name missing from here is a FALSE POSITIVE, which is the direction this
 * module must not fail in — so it is deliberately generous, and `tostring`,
 * `length` and friends are in it even though they are usually written without a
 * leading dot.
 */
const NOT_A_COLUMN = new Set([
  "results", "data", "body", "value", "succeeded", "failed", "warnings", "readFrom",
  "vars", "result", "length", "keys", "tostring", "tonumber", "add", "first", "last",
  "reverse", "sort", "unique", "flatten", "type", "empty", "not", "any", "all", "floor",
  "ceil", "round", "min", "max", "join", "split", "ascii_downcase", "ascii_upcase", "tojson",
  "fromjson", "utf8bytelength", "todate", "fromdate", "now", "map", "select", "group_by",
  "sort_by", "unique_by", "min_by", "max_by", "with_entries", "to_entries", "from_entries",
]);

/**
 * The single upstream step an expression reads its ROWS from, or `null`.
 *
 * `null` covers three cases that must all mean "say nothing": no step is read,
 * more than one is (the jq input is then ambiguous), or the read does not go
 * through `.results[…].data` (the jq input is the envelope, not a row).
 */
export function rowSourceOf(expr: string): string | null {
  const steps = new Set(
    [...expr.matchAll(/outputs\.([A-Za-z_][A-Za-z0-9_]*)\.(?:body|value)/g)].map((m) => m[1]),
  );
  if (steps.size !== 1) return null;
  if (!/\.results\s*\[[^\]]*\]\s*\.data/.test(expr)) return null;
  return [...steps][0];
}

/**
 * **The row fields one expression reads, minus everything jq built itself.**
 *
 * The stage-aware scan, extracted so it has ONE definition. `checkRefOutputFields`
 * passes the projection as `known` and gets back the names that cannot exist;
 * `fieldsReadFrom` passes an EMPTY set and gets back every row field the
 * expression wants. Same walk, same exclusions, two questions — and writing the
 * second one out again is how the two would come to disagree about what counts
 * as a read (D-197).
 */
function rowFieldsRead(expr: string, known: Set<string>): string[] {
  const out = new Set<string>();
  for (const program of jqPrograms(expr)) {
    const built = new Set<string>();
    for (const stage of jqStages(program)) {
      for (const name of readsIn(stage)) {
        if (known.has(name) || built.has(name) || NOT_A_COLUMN.has(name)) continue;
        out.add(name);
      }
      // Only AFTER the stage, so a read and a key in the same object literal
      // (`{candidate: .candidate}`) is still checked — that shape is three of
      // the fourteen measured cases.
      for (const key of keysIn(stage)) built.add(key);
    }
  }
  return [...out];
}

/**
 * **Every row field the flow reads out of one step — the step's CONSUMER
 * CONTRACT.** 2026-09-17
 *
 * ⚠ **This exists so the two halves of a draft can stop being written blind.**
 * When a draft names a reader that does not exist, `fillGapsWithStepSql` asks
 * `proposeQuery` to write the SQL — and passed it the reader's four-word name
 * and nothing else. So one model call wrote a transform reading
 * `candidate_email, candidate_name, job_title` while a second, which could not
 * see that, wrote SQL projecting `first_name, last_name, offer_id`. Neither was
 * wrong on its own; nothing reconciled them, and the mismatch used to ship
 * silently and return a report of nulls.
 *
 * This is what the proposer needs: not the automation's goal — that isolation is
 * deliberate (`step-contract`) and stays — but the INTERFACE the step must
 * satisfy. The proposer sees the schema and can alias real columns onto these
 * names; it simply had no idea they were wanted.
 *
 * ⚠ **These names are the drafter's INVENTION, not schema truth**, and that is
 * the point rather than a defect: they are a statement of what the answer needs,
 * made by the one call that saw the goal. Mapping them onto real tables is the
 * proposer's job, and a name it cannot find is an honest `insufficient_schema`.
 */
export function fieldsReadFrom(model: FlowModel, sourceId: string): string[] {
  const out = new Set<string>();
  for (const step of model.steps ?? []) {
    const rec = step as unknown as Record<string, unknown>;
    for (const field of EXPRESSION_FIELDS) {
      const expr = rec[field];
      if (typeof expr !== "string" || expr.length === 0) continue;
      if (rowSourceOf(expr) !== sourceId) continue;
      for (const name of rowFieldsRead(expr, new Set())) out.add(name);
    }
  }
  return [...out].sort();
}

/**
 * Every expression field on every step, checked against the columns the step it
 * reads from actually projects.
 *
 * `interfaces` is `refInterfaces()`' output. A ref absent from it, or present
 * with no `columns`, contributes nothing — the same "cannot see, so says
 * nothing" rule `literalParamKeys` and `checkFlowParams` follow.
 */
export function checkRefOutputFields(
  model: FlowModel,
  interfaces: Record<string, { columns?: string[] }> = {},
): FlowFinding[] {
  const steps = model.steps ?? [];
  const columnsOfStep = new Map<string, string[]>();
  for (const s of steps) {
    if (s.kind !== "query" && s.kind !== "datasource") continue;
    const rec = s as { ref?: string; sql?: string; datasourceRef?: string };
    /**
     * ⚠ **Frozen SQL WINS over the stored row, and the order is not a
     * preference.** `runNamedQuery` lets `input.sql` replace the stored text
     * while keeping the stored address, so when a step carries its own
     * statement the stored reader's projection describes SQL that is not the
     * one being run. Reading the stored row first would compare a jq read
     * against the wrong contract — and get it wrong in the worst direction,
     * because that produces a confident finding rather than silence.
     *
     * A step-local statement the parser cannot read confidently yields
     * `undefined` and falls through to the stored row, which is the correct
     * order for the ordinary case where a ref still names a real reader.
     */
    const local = isStepLocalSql(rec) ? selectProjection(rec.sql ?? "") : undefined;
    const cols = local ?? interfaces[rec.ref ?? ""]?.columns;
    if (cols && cols.length > 0) columnsOfStep.set(s.id, cols);
  }
  if (columnsOfStep.size === 0) return [];

  const findings: FlowFinding[] = [];
  for (const step of steps) {
    const rec = step as unknown as Record<string, unknown>;
    // ⚠ A transform lowered from a typed combinator PIPELINE is skipped (compiled-builder 2d, D-249: absorb, never
    // duplicate). `typeTransform` already checked every field read, stage by stage, against the REAL types, which is
    // strictly stronger than this scan of the lowered jq text — and the text scan cannot see stages, so it reads a field
    // an earlier stage DERIVED as a missing column (I-276's shape, found by pipeline-e2e).
    if (Array.isArray(rec.pipeline)) continue;
    for (const field of EXPRESSION_FIELDS) {
      const expr = rec[field];
      if (typeof expr !== "string" || expr.length === 0) continue;
      const source = rowSourceOf(expr);
      if (source === null) continue;
      const columns = columnsOfStep.get(source);
      if (!columns) continue;
      const unknown = new Set(rowFieldsRead(expr, new Set(columns)));
      if (unknown.size === 0) continue;

      const missing = [...unknown].sort();
      findings.push({
        rule: "unknown_output_column",
        stepId: step.id,
        message:
          `step "${step.id}".${field} reads ${missing.map((c) => `"${c}"`).join(", ")} from ` +
          `"${source}", which returns no such column. ` +
          `"${(steps.find((s) => s.id === source) as { ref?: string } | undefined)?.ref}" ` +
          `returns exactly: ${columns.join(", ")}. ` +
          `Reading a column that is not there yields null, not an error — so use one of ` +
          `those names, or change the operation to project the column you need.`,
        facts: {
          source,
          missing,
          // The list IS the finding, for `unknown_ref`'s reason: a redraft
          // without it is a second guess at a name.
          returns: columns,
          field,
        },
        blocking: true,
      });
    }
  }
  return findings;
}
