// packages/flow-edit/src/render.ts — building Kestra expressions from picks, inside D-22 by
// construction. Stage 3.2: moved verbatim from `packages/client/src/lib/flow-expr.ts`
// (pure string builders + the branch vocabulary), so the client panel, the server
// compiler and the stored-model upgrade all render from one module.
//
// ── What lives here and what deliberately does not ──────────────────────────
//
// Here: every function that ASSEMBLES an expression from typed picks, plus the
// `BranchTest` vocabulary and `BRANCH_TESTS` table they speak. The client keeps
// thin re-exports (`lib/flow-expr.ts`) for its own call sites; the server
// imports the same functions so a `test` is rendered ONCE, at compile time, by
// the module the panel also uses.
//
// NOT here: the inverse readers (`parseCondition`, `readItemPredicate`,
// `soleStepRead`), the allowlist preview (`validateAgainstAllowlist`), and the
// expression-string parsers (`parseParams`, `codeInputSources`) — those stay
// beside the panel that owns them, and the upgrade in `model-version.ts` says
// why it carries its own shapes-free copies instead of importing them.
//
// ── Still checked, still by construction ────────────────────────────────────
//
// Every expression below is assembled from `outputs.<id>`, `inputs.<id>`, a
// literal, and the jq and `json` calls that are already permitted. Nothing here
// can emit a call to anything else, because there is no code path that writes a
// function name it was given. See the original module's header for the measured
// history (I-11 `~` concatenation, I-42 date flattening, I-43 `@json` placement,
// I-118 engine-measured operators, the `tonumber?` trap).

import type { AuthoredStep, StepKind } from "./index.js";
import type { Source } from "./node-types.js";

/** The eleven branch-guard operators — one list for the panel, the compiler and the upgrade. */
export type BranchTest =
  | "any"
  | "none"
  | "field_eq"
  | "field_ne"
  | "field_contains"
  | "field_starts"
  | "field_ends"
  | "field_empty"
  | "field_present"
  | "field_gt"
  | "field_lt";

/** Served by `GET …/catalogue`: how each kind's output is reached. */
/**
 * ⚠ **PARTIAL, and it always should have been.** The server sends an entry per
 * kind it HAS; `outputExpr` has always read it with `?.` for exactly that
 * reason. It was typed total, which meant the client's own kind list and the
 * server's had to match member for member — so removing a kind from one made a
 * cast at the seam stop compiling, in a file that never depended on totality.
 */
export type OutputShapes = Partial<
  Record<StepKind, { template: string | null; describes: string | null; caution: string | null }>
>;

/** `outputs.rank.vars.result` — the server's table, applied. */
export function outputExpr(shapes: OutputShapes, kind: StepKind, stepId: string): string | null {
  const t = shapes[kind]?.template;
  return t ? t.replaceAll("<id>", stepId) : null;
}

/**
 * Where a `datasource` or `query` step's ROWS are, as opposed to its response
 * body.
 *
 * The ops-api query endpoint answers `{results: [{data: [...]}]}`, so rows are at
 * `.results[0].data`. Hardcoding that path here rather than in five call sites
 * is the same argument as everything else in this file.
 */
export function rowsExpr(shapes: OutputShapes, step: AuthoredStep): string | null {
  const base = outputExpr(shapes, step.kind, step.id);
  if (!base) return null;
  if (step.kind === "datasource" || step.kind === "tool" || step.kind === "query") {
    return step.over?.stepId ? allResultsRows(base) : `${base}.results[0].data`;
  }
  return base;
}

/**
 * The rows of a FAN-OUT call (phase 7, R03): it ran once per element, so its
 * envelope carries ONE result per element — none at all when there was nothing
 * to run over. `.results[0].data` read the first call only, and failed outright
 * ("Unable to find `0`") on an empty run. This reads every call's `data`, a
 * list's rows spliced in, an object kept whole. Measured on the engine: two
 * calls → both, zero → `[]`, per-call rows → flattened.
 *
 * ONE spelling, used by the renderer and by the compiler's field reads.
 */
export function allResultsRows(base: string): string {
  return `${base} | jq('[.results[]?.data | if type == "array" then .[] else . end]') | first`;
}

// ── A mapping: one parameter, one source ─────────────────────────────────────

export type Mapping = { param: string; source: Source };

/**
 * jq needs `"` and `\` escaped inside a double-quoted string literal — and a
 * `'` written as jq's own `\u0027`, because every jq program here sits inside a
 * single-quoted PEBBLE literal, which a raw `'` closes. Measured: an
 * `llm_complete` instruction reading "this month's attendance" failed to parse
 * (build:measure R05, 2026-09-23, `Unclosed """`). A value without a `'` is
 * byte-identical to before.
 */
function jqString(value: string): string {
  // ⚠ And a control character as jq's JSON escape (I-289): a raw newline inside the literal broke the program at run time
  // with `Unable to parse jq value '[]'`, a message that names neither the literal nor the newline (measured, kestra-bindings).
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/'/g, "\\u0027").replace(/[\u0000-\u001f]/g, controlEscape)}"`;
}
const controlEscape = (c: string) => (c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\t" ? "\\t" : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** A JSON-stringified value made safe inside a single-quoted Pebble literal (see `jqString`). */
function jqJson(value: string): string {
  return JSON.stringify(value).replace(/'/g, "\\u0027");
}

/**
 * A jq program is assembled from two kinds of piece, and the distinction is
 * I-11 rather than tidiness.
 *
 * ⚠ **Pebble does not re-evaluate `{{ }}` inside a filter argument.** Writing
 * `jq('{"p": "{{ inputs.period }}"}')` looks obviously right and is silently
 * wrong: the braces are characters inside a Pebble string literal, so the flow
 * ships with the text `{{ inputs.period }}` as the value. The fix I-11 names is
 * concatenation with `~`, which means the program cannot be one string — it is
 * a sequence of literal chunks with Pebble expressions between them.
 *
 * (It is also wrong in a second, quieter way: a nested `{{` truncates the outer
 * template for anything scanning it, so D-22's own allowlist check reads half an
 * expression. Measured while writing this file.)
 */
type Seg = { lit: string } | { pebble: string };

/** `.name`, or `.["odd name"]` when it is not a bare identifier. */
function fieldRef(field: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(field) ? `.${field}` : `.[${jqString(field)}]`;
}

/** The jq cut a typed input conversion applies — quote-free on purpose (E2.1/E2.2). */
const INPUT_CUT = { month: ".[0:7]", date: ".[0:10]" } as const;

/**
 * One flow input as the TEXT of a template: bare `{{ inputs.x }}`, or — with a
 * conversion — handed to jq inside a Pebble map. Engine-probed (E2.2): piping
 * `inputs.x` straight into jq is refused for a bare date (E2.1), and the map form
 * carries no double quote, so it can sit inside a JSON string unescaped.
 */
function inputValueTemplate(inputId: string, transform?: "month" | "date"): string {
  if (!transform) return `{{ inputs.${inputId} }}`;
  return `{{ {'v': inputs.${inputId}} | jq('.v | ${INPUT_CUT[transform]}') | first }}`;
}

/**
 * One flow input as a JSON STRING LITERAL, quotes and escaping included — for a JSON body or a jq program (I-288).
 *
 * ⚠ Never `"{{ inputs.x }}"`. Pebble renders the value into the surrounding text unescaped, so an input holding `\`, `"` or a
 * newline produced a body that is not JSON (Foundry refuses it) — and spliced into a jq program, the same value CHANGES the
 * program. Measured on Kestra (`bind-escape-probe`, 13 types and texts): `(inputs.x ~ '') | toJson` is the exact JSON string
 * of the value's TEXT — `~ ''` keeps I-285's rule that an input arrives as text (an INT is `"7"`, a FLOAT `"0.0"`), and
 * `toJson` escapes. A conversion cuts inside jq and re-encodes there with `@json` (I-43), so its output is a literal too.
 */
function inputJsonLiteral(inputId: string, transform?: "month" | "date"): string {
  if (!transform) return `{{ (inputs.${inputId} ~ '') | toJson }}`;
  return `{{ {'v': inputs.${inputId}} | jq('.v | ${INPUT_CUT[transform]} | @json') | first }}`;
}

/**
 * The escaped input spelling (I-288) written back in the LEGACY spelling it replaced — `"{{ inputs.x }}"` in a JSON body,
 * `"' ~ inputs.x ~ '"` in a jq program, the quoted map form for a conversion. Both spellings pass the same input to the
 * same parameter; only the escaping differs. So a comparison of WHAT a feed passes (FT0206's `sameFeed`) reads them as one,
 * and a stored v1 blob — which only ever carried the legacy spelling — still agrees with the bindings it was parsed into.
 * ⚠ For comparison and test fixtures only: never emit the result, it is the unescaped form.
 */
export function toLegacyInputSpelling(text: string): string {
  return text
    .replace(/\{\{ \(inputs\.([A-Za-z0-9_]+) ~ ''\) \| toJson \}\}/g, '"{{ inputs.$1 }}"')
    .replace(/\{\{ \{'v': inputs\.([A-Za-z0-9_]+)\} \| jq\('\.v \| (\.\[0:(?:7|10)\]) \| @json'\) \| first \}\}/g, `"{{ {'v': inputs.$1} | jq('.v | $2') | first }}"`)
    .replace(/' ~ \(\(inputs\.([A-Za-z0-9_]+) ~ ''\) \| toJson\) ~ '/g, `"' ~ inputs.$1 ~ '"`);
}

/**
 * The inverse of `toLegacyInputSpelling`: every legacy input spelling written as the escaped one (I-288). For a writer that
 * edits a display string's TEXT in the legacy spelling it was built for (the client's `writeToolParam`), so what it stores is
 * escaped. Idempotent on escaped text — no escaped form contains a legacy pattern.
 */
export function toEscapedInputSpelling(text: string): string {
  return text
    .replace(/"\{\{ \{'v': inputs\.([A-Za-z0-9_]+)\} \| jq\('\.v \| (\.\[0:(?:7|10)\])'\) \| first \}\}"/g, `{{ {'v': inputs.$1} | jq('.v | $2 | @json') | first }}`)
    .replace(/"\{\{\s*inputs\.([A-Za-z0-9_]+)\s*\}\}"/g, "{{ (inputs.$1 ~ '') | toJson }}")
    .replace(/"' ~ inputs\.([A-Za-z0-9_]+) ~ '"/g, `' ~ ((inputs.$1 ~ '') | toJson) ~ '`);
}

/**
 * One mapping as jq segments, evaluated against a row (`.`).
 *
 * ⚠ `transform: "date"` is I-42 as a checkbox. A value containing an ISO
 * timestamp cannot cross into an `http.Request` body via `jq()` — it dies with
 * `Unable to parse jq value '[{…}]' with type 'java.util.ArrayList'`, a message
 * that names neither the field nor the reason and reads like bad DATA. The
 * mitigation is to flatten it to `YYYY-MM-DD`, which is what `split("T")[0]`
 * does. Offered as a control rather than applied automatically, because only the
 * person knows which columns are dates — and splitting a non-date silently
 * truncates it.
 */
function jqValue(source: Source): Seg[] {
  switch (source.from) {
    case "step": {
      const field = `.${source.field}`;
      if (source.transform === "date") return [{ lit: `(${field} | tostring | split("T")[0])` }];
      if (source.transform === "text") return [{ lit: `(${field} | tostring)` }];
      if (source.transform === "number") return [{ lit: `(${field} | tonumber)` }];
      return [{ lit: field }];
    }
    case "input":
      // `'…"' ~ inputs.period ~ '"…'` — the quotes belong to the jq program and
      // the value is spliced between them by Pebble, before jq ever runs.
      // ⚠ The value arrives as a JSON string LITERAL (`toJson`, I-288) — never spliced between quotes, where a `"` or `\` in
      // it would rewrite the jq program. JSON string syntax is jq string syntax, so the literal is a jq string as it stands.
      if (source.transform) return [{ lit: `(` }, { pebble: `((inputs.${source.inputId} ~ '') | toJson)` }, { lit: ` | ${INPUT_CUT[source.transform]})` }];
      return [{ pebble: `((inputs.${source.inputId} ~ '') | toJson)` }];
    case "literal":
      return literalSegs(source.value);
    case "self":
      // The element `.` itself — a list of names or numbers has no field to name.
      return [{ lit: "." }];
    case "whole":
      // The whole upstream rows, not one column of them. A fan-out program is
      // evaluated per ROW, where the rows array has no address — so this source
      // has no honest per-row spelling, and the caller must refuse to build
      // rather than build the row in its place. Returning the bare element
      // would silently mean "this row", which is a different claim.
      return [{ lit: "whole" }];
  }
}

/**
 * A literal as a jq string, with each `{{ inputs.<id> }}` placeholder SPLICED
 * (`"Report for ' ~ inputs.period ~ '"`) rather than left inside the program.
 *
 * ⚠ I-11: Pebble does not re-evaluate `{{ }}` inside a filter argument, so a
 * literal carrying a placeholder, written into a jq program verbatim, ships the
 * braces themselves — "Report for {{ inputs.period }}" in somebody's inbox. In
 * the plain JSON single-call form the whole string is one template and it
 * renders; only the jq forms needed this. Any other `{{ … }}` stays literal
 * text (the checker reports it as FT0602).
 */
const INPUT_PLACEHOLDER = /\{\{\s*inputs\.([A-Za-z0-9_]+)\s*\}\}/g;
function literalSegs(value: string): Seg[] {
  const parts = [...value.matchAll(INPUT_PLACEHOLDER)];
  if (!parts.length) return [{ lit: jqString(value) }];
  const inner = (t: string) => jqString(t).slice(1, -1);
  const segs: Seg[] = [{ lit: `"` }];
  let at = 0;
  for (const m of parts) {
    if (m.index! > at) segs.push({ lit: inner(value.slice(at, m.index)) });
    segs.push({ pebble: `inputs.${m[1]}` });
    at = m.index! + m[0].length;
  }
  if (at < value.length) segs.push({ lit: inner(value.slice(at)) });
  segs.push({ lit: `"` });
  return segs;
}

/**
 * Segments → the text that goes inside `jq(…)`.
 *
 * Adjacent literals collapse into one quoted chunk; a Pebble segment closes the
 * quote, concatenates, and reopens. An expression with no inputs therefore comes
 * out as a single `'…'`, byte-identical to what a person would have written by
 * hand — which matters, because these strings are read in review.
 */
function assembleJq(segs: Seg[]): string {
  const parts: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf) parts.push(`'${buf}'`);
    buf = "";
  };
  for (const s of segs) {
    if ("lit" in s) buf += s.lit;
    else {
      flush();
      parts.push(s.pebble);
    }
  }
  flush();
  return parts.length ? parts.join(" ~ ") : `''`;
}

/**
 * The `paramsExpr` for a `tool` or `datasource` step that fans out over an
 * upstream step's rows — one object per invocation.
 *
 * ⚠ Always an ARRAY. One taskrun sends all of them (M1), so a hundred emails is
 * one array and never a loop; a `paramsExpr` producing a bare object is the
 * commonest hand-authoring mistake and it fails at runtime rather than here.
 *
 * ⚠ And this is the shape that respects I-42's rule: *a `tool` or `approval`
 * step never consumes a raw query row.* The projection below picks named fields,
 * so the raw row never reaches the call — the mitigation is the mechanism, not a
 * warning beside it.
 *
 * A `predicate` narrows WHICH rows become calls — `[.[] | select(…) | {…}]`.
 * Each destination step carries its own predicate, so one list fans out to
 * several steps and every item lands exactly where its values say it should:
 * that is the if/elif routing, inside the flat model. A predicate matching
 * nothing yields `[]`, which the runtime treats as a valid no-op (`EMPTY_BATCH`),
 * never an error.
 */
export function buildFanOutParams(
  shapes: OutputShapes,
  over: AuthoredStep,
  mappings: Mapping[],
  predicate?: ItemPredicate,
): string | null {
  const rows = rowsExpr(shapes, over);
  if (!rows) return null;
  // ⚠ A `whole` binding has no per-row spelling (see `jqValue`): building
  // without it would silently drop the parameter, so this builds nothing
  // rather than a fan-out missing a value the person configured.
  if (mappings.some((m) => m.source.from === "whole")) return null;
  const segs: Seg[] = [{ lit: "[.[] | " }];
  if (predicate) {
    const test = perItemTest(predicate.test, predicate.field, predicate.value);
    // ⚠ No silent unfiltered fan-out: a predicate that builds nothing means the
    // picks do not describe a filter, so this builds no expression rather than
    // one that sends every row where the person asked for a subset.
    if (!test) return null;
    segs.push({ lit: `select(${test}) | ` });
  }
  // D-273: a row whose skipped field is null becomes no call at all.
  const skips = mappings.flatMap((m) => (m.source.from === "step" && m.source.onNull === "skip" ? [fieldRef(m.source.field)] : []));
  if (skips.length) segs.push({ lit: `select(${skips.map((f) => `${f} != null`).join(" and ")}) | ` });
  segs.push({ lit: "{" });
  mappings.forEach((m, i) => {
    if (i) segs.push({ lit: ", " });
    segs.push({ lit: `${jqString(m.param)}: ` }, ...jqValue(m.source));
  });
  segs.push({ lit: "}]" });
  return `{{ ${rows} | jq(${assembleJq(segs)}) | first }}`;
}

/**
 * Which rows of a fan-out become calls — the per-item half of `BranchTest`.
 *
 * Reuses the `BranchTest` vocabulary but NOT the row-count tests: a per-item
 * test is always about a value, never about how many rows there are. `field`
 * empty means the item itself (a list of names or numbers has no column).
 *
 * Plus `field_gte`/`field_lte`, which the branch guards do not offer: routing a
 * list through if/elif needs gapless bands (`< 70` / `>= 70`), and `gt`+`lt`
 * alone always leave the boundary value homeless. Same `tonumber?` guard, same
 * jq comparison family as the measured `gt`/`lt` — and proved the same way,
 * by a seeded flow that runs them (`showcase-routing`, `showcase:verify` §7).
 */
export type ItemPredicate = {
  test: Exclude<BranchTest, "any" | "none"> | "field_gte" | "field_lte";
  field?: string;
  value?: string;
};

/**
 * One per-item jq predicate — the inner expression `buildCondition` wraps in
 * `any(.[]; …)`, here wrapped in `select(…)` instead. Same operators, same
 * guards (`// ""` so a missing field answers false instead of erroring;
 * `| tonumber?` so a string field compares false against a number instead of
 * jq's total ordering answering true). Empty string = the picks describe no
 * filter, and the caller must refuse to build rather than build unfiltered.
 */
function perItemTest(
  test: ItemPredicate["test"],
  field: string | undefined,
  value: string | undefined,
): string {
  // ⚠ Stripped to an identifier, not escaped — same rule as `buildCondition`.
  const f = (field ?? "").replace(/[^A-Za-z0-9_]/g, "");
  const v = jqJson(value ?? "");
  // The subject: `.field` when a column is named, `.` for the bare item itself.
  const subj = (fn: (s: string) => string): string => (f ? fn(`.${f}`) : fn("."));
  switch (test) {
    case "field_eq":
      return subj((s) => `${s} == ${v}`);
    case "field_ne":
      return subj((s) => `${s} != ${v}`);
    case "field_contains":
      return subj((s) => `(${s} // "") | contains(${v})`);
    case "field_starts":
      return subj((s) => `(${s} // "") | startswith(${v})`);
    case "field_ends":
      return subj((s) => `(${s} // "") | endswith(${v})`);
    case "field_empty":
      return subj((s) => `(${s} // "") == ""`);
    case "field_present":
      // A bare element is always present — there is nothing to test.
      if (!f) return "";
      return `has("${f}")`;
    case "field_gt":
    case "field_gte":
    case "field_lt":
    case "field_lte": {
      const n = Number(value);
      if (!Number.isFinite(n)) return "";
      const op = test === "field_gt" ? ">" : test === "field_gte" ? ">=" : test === "field_lt" ? "<" : "<=";
      return subj((s) => `(${s} | tonumber?) ${op} ${n}`);
    }
  }
}

/**
 * The `paramsExpr` for a call made exactly ONCE — a lookup by period, a fixed
 * digest recipient, or one call over what ONE upstream step returned (post the
 * summary's text, email the digest).
 *
 * Still an array of one, for the reason above.
 *
 * ── Two forms, chosen by what the bindings read ─────────────────────────────
 *
 * Literal and flow-input bindings only → the JSON-text form
 * `[{ "p": "{{ inputs.x }}", "q": "lit" }]`, BYTE-IDENTICAL to what this
 * function has always written (a different spelling would rewrite every stored
 * step's bytes, and its hash, on the next open).
 *
 * Any `step` or `whole` binding → the whole object is built IN jq over that
 * step's output, `{{ <rows> | jq('[{…}]') | first }}` (I-11: build the JSON
 * value in jq and interpolate that; never splice a rendered string into a JSON
 * body). A field read is `(if type=="array" then [.[] | .f] else .f end)`:
 * over rows it is the column as a list, over one object (an `llm_complete`
 * answer's `{text}`) it is the value. `whole` is `.`.
 *
 * ⚠ **This used to write `""` for every step read** — measured in phase 3
 * (E3.1): *"post the summary's text to chat"* compiled, deployed, ran green and
 * posted empty text. The value was never unaddressable; one upstream's output
 * is exactly one Pebble expression away.
 *
 * `null` = refused, never a guess: step reads from MORE THAN ONE upstream (one
 * jq program has one input — combine them in a `transform` first), an upstream
 * the caller could not resolve, or a kind whose output has no address.
 *
 * `ctx` is optional so a caller with no step context keeps the old answer for
 * the literal/input case; a step read with no `ctx` is refused (`null`).
 */
export function buildSingleParams(
  mappings: Mapping[],
  ctx?: { shapes: OutputShapes; steps: readonly AuthoredStep[] },
): string | null {
  // ⚠ The empty call is the canonical blank `blankStep` writes (`"[{}]"`),
  // not `"[{  }]"`. An untouched step upgrades to empty bindings and
  // re-renders here on reopen — a different blank would rewrite every
  // untouched step's bytes (and its hash) on the first open.
  if (mappings.length === 0) return "[{}]";
  const upstream = new Set<string>();
  for (const m of mappings) if (m.source.from === "step" || m.source.from === "whole") upstream.add(m.source.stepId);
  if (upstream.size === 0) {
    const pairs = mappings.map((m) => {
      if (m.source.from === "input") return `${JSON.stringify(m.param)}: ${inputJsonLiteral(m.source.inputId, m.source.transform)}`;
      if (m.source.from === "literal") return `${JSON.stringify(m.param)}: ${JSON.stringify(m.source.value)}`;
      // `self` — the bare per-row element has no meaning outside a fan-out.
      return `${JSON.stringify(m.param)}: ""`;
    });
    return `[{ ${pairs.join(", ")} }]`;
  }
  if (upstream.size > 1 || !ctx) return null;
  const [stepId] = [...upstream];
  const from = ctx.steps.find((s) => s.id === stepId);
  const rows = from ? rowsExpr(ctx.shapes, from) : null;
  if (!rows) return null;
  const segs: Seg[] = [{ lit: "[{" }];
  mappings.forEach((m, i) => {
    if (i) segs.push({ lit: ", " });
    segs.push({ lit: `${jqString(m.param)}: ` }, ...singleValue(m.source));
  });
  segs.push({ lit: "}]" });
  return `{{ ${rows} | jq(${assembleJq(segs)}) | first }}`;
}

/** One single-call value as jq segments, evaluated against ONE upstream's whole output (`.`). */
function singleValue(source: Source): Seg[] {
  switch (source.from) {
    case "step": {
      const f = fieldRef(source.field);
      const t =
        source.transform === "date" ? ` | tostring | split("T")[0]`
        : source.transform === "text" ? ` | tostring`
        : source.transform === "number" ? ` | tonumber`
        : "";
      const keep = source.onNull === "skip" ? `select(${f} != null) | ` : "";
      return [{ lit: `(if type == "array" then [.[] | ${keep}${f}${t}] else ${f}${t} end)` }];
    }
    case "whole":
      return [{ lit: source.transform === "text" ? "(. | tostring)" : "." }];
    case "self":
      // No row context — the old answer, kept rather than guessed.
      return [{ lit: `""` }];
    default:
      return jqValue(source);
  }
}

/**
 * A `code` step's `inputExpr` — a JSON object whose keys are the contract's
 * declared input fields.
 *
 * The keys come from the CONTRACT, so what the fragment is handed and what it
 * was told it would be handed are built from one list. A mismatch here is the
 * `contract_violation` that blames a fragment for obeying its contract.
 *
 * ── The two field shapes, and why there are two ─────────────────────────────
 *
 * `{ name, from }` is the legacy whole-rows bind (a drop, the convert action):
 * the input reads the source step's whole rows. `{ name, source }` is the full
 * picker source: a whole-rows bind when the step field is empty, a column
 * projection (`rows | jq('[.[] | .field]')` — `jq` is in-vocabulary for
 * `inputExpr`, see `EXPRESSION_RULES`) when it names one, a flow input, or a
 * fixed string. `self` (the bare per-row element) has no address in a payload
 * the step runs once with, so `codeInputValue` maps it to `null` — bound to
 * nothing rather than guessed into something.
 */
export type CodeInputValue =
  | { kind: "step"; step: AuthoredStep | null; field: string; transform?: "date" | "text" | "number"; onNull?: "skip" | "fail" | Record<string, "skip" | "fail"> }
  | { kind: "input"; inputId: string; transform?: "month" | "date" }
  | { kind: "literal"; value: string }
  | null;

/** One projected column, with the same transform wrappers `jqValue` emits. */
function codeProjection(field: string, transform?: "date" | "text" | "number"): string {
  const f = /^[A-Za-z_][A-Za-z0-9_]*$/.test(field) ? `.${field}` : `.[${JSON.stringify(field)}]`;
  if (transform === "date") return `(${f} | tostring | split("T")[0])`;
  if (transform === "text") return `(${f} | tostring)`;
  if (transform === "number") return `(${f} | tonumber)`;
  return f;
}

/** One contract input's JSON value text — a template, a fixed string, or `null`. */
function codeValueText(shapes: OutputShapes, value: CodeInputValue): string {
  if (!value) return "null";
  if (value.kind === "literal") return JSON.stringify(value.value);
  if (value.kind === "input") {
    // ⚠ QUOTED. Bare, a STRING input renders `{"month": 2026-06}` — not JSON,
    // and the fragment wrapper refuses it (build:measure r8, R08 and L2:
    // FRAGMENT_BAD_INPUT). Quoted is the form a literal `"{{ inputs.x }}"`
    // already ran green in (r7 L2), and the one a call's params use.
    return /^[A-Za-z0-9_]+$/.test(value.inputId) ? inputJsonLiteral(value.inputId, value.transform) : "null";
  }
  const rows = value.step ? rowsExpr(shapes, value.step) : null;
  if (!rows) return "null";
  // D-273: `skip` drops the rows before the fragment sees them.
  if (!value.field) {
    const skip = Object.entries(value.onNull ?? {}).filter(([, v]) => v === "skip").map(([k]) => `${fieldRef(k)} != null`);
    return skip.length ? `{{ ${rows} | jq('[.[] | select(${skip.join(" and ").replace(/'/g, "''")})]') }}` : `{{ ${rows} }}`;
  }
  const keep = value.onNull === "skip" ? `select(${fieldRef(value.field)} != null) | ` : "";
  return `{{ ${rows} | jq('[.[] | ${keep}${codeProjection(value.field, value.transform)}]') }}`;
}

export function buildCodeInput(
  shapes: OutputShapes,
  fields: Array<{ name: string; from: AuthoredStep | null } | { name: string; source: CodeInputValue }>,
): string {
  const pairs = fields.map((f) => {
    if ("source" in f) return `${JSON.stringify(f.name)}: ${codeValueText(shapes, f.source)}`;
    const src = f.from ? rowsExpr(shapes, f.from) : null;
    return `${JSON.stringify(f.name)}: ${src ? `{{ ${src} }}` : "null"}`;
  });
  return `{${pairs.join(", ")}}`;
}

/**
 * An `approval` step's question, as a JSON STRING.
 *
 * ⚠ Two traps in one line, both paid for. `summaryExpr` must produce a JSON
 * string with its quotes (I-11) — interpolating rendered text into a JSON body
 * produces a 400 that names nothing. And `@json` is a **jq** encoder, not a
 * Pebble filter (I-43): it goes inside the jq program, never after it.
 */
export function buildApprovalSummary(
  shapes: OutputShapes,
  over: AuthoredStep | null,
  text: string,
): string {
  const rows = over ? rowsExpr(shapes, over) : null;
  if (!rows) return JSON.stringify(text);
  // ⚠ `literalSegs`, never a bare `jqString`: a question carrying
  // `{{ inputs.period }}` inside the jq argument ships the braces verbatim (I-11).
  const segs: Seg[] = [
    { lit: `((` },
    ...literalSegs(text),
    { lit: `) + " (" + (length|tostring) + " rows)") | @json` },
  ];
  return `{{ ${rows} | jq(${assembleJq(segs)}) | first }}`;
}

/**
 * A branch guard's condition — foundations Phase 3.
 *
 * ⚠ **BUILT, never typed** (D-50). D-22 is a good boundary and a terrible text
 * box: `outline:measure` had a real draft refused for a jq variable binding, and
 * a person typing Pebble into a box would hit the same wall with less to go on.
 * The inspector asks which upstream step and which comparison; this assembles a
 * string that is inside the allowlist **by construction** — `json`, `jq`,
 * `length` and `first` are all on it.
 *
 * ⚠ **EVERY OPERATOR BELOW WAS RUN AGAINST THE ENGINE BEFORE IT WAS OFFERED,
 * IN BOTH DIRECTIONS** (2026-09-03, `foundry.system` probe flow, deleted after).
 * I-118 is the record of what the alternative costs: three filters were offered
 * from memory that Pebble does not have, so the draft prompt taught a runtime
 * failure and the control configured from the same list waved it through. A
 * real user run died on `| tostring` after passing every static check.
 *
 * ⚠ **The distinction that makes this list bigger than four:** `ALLOWED_CALLS`
 * (`json`, `jq`, `first`, `length`) is the **Pebble** filter allowlist. The text
 * inside `jq('…')` is a **jq** program and is opaque to it, so jq builtins —
 * `contains`, `startswith`, `endswith`, `has`, `tonumber` — are available where
 * the identically-named Pebble filters are not. That is exactly the confusion
 * I-118 was, pointed the other way, so it is written down rather than assumed.
 *
 * ⚠ **AND THE MEASUREMENT FOUND A REAL TRAP.** A naive numeric comparison on a
 * field the catalogue does not type — `any(.[]; .n > 5)` where `.n` is the
 * STRING `"2"` — returned **true** on the engine, because jq's total ordering
 * puts every string above every number. So the guard is not "quietly always
 * false" as this comment used to warn; it is quietly always **TRUE**, which on
 * a branch means the guarded steps ALWAYS run. `| tonumber?` is what makes it
 * honest, and it was measured to yield `false` rather than erroring on both
 * `null` and `"not-a-number"`.
 *
 * Each was checked to produce `true` on data that should match and `false` on
 * data that should not — an operator that always answered the same thing would
 * otherwise look identical to one that works.
 */

/** What each test is called on screen, and whether it needs a field / a value. */
export const BRANCH_TESTS: ReadonlyArray<{
  test: BranchTest;
  label: string;
  needsField: boolean;
  needsValue: boolean;
}> = [
  { test: "any", label: "has any rows", needsField: false, needsValue: false },
  { test: "none", label: "has no rows", needsField: false, needsValue: false },
  { test: "field_eq", label: "is", needsField: true, needsValue: true },
  { test: "field_ne", label: "is not", needsField: true, needsValue: true },
  { test: "field_contains", label: "contains", needsField: true, needsValue: true },
  { test: "field_starts", label: "starts with", needsField: true, needsValue: true },
  { test: "field_ends", label: "ends with", needsField: true, needsValue: true },
  { test: "field_empty", label: "is empty", needsField: true, needsValue: false },
  { test: "field_present", label: "is present", needsField: true, needsValue: false },
  { test: "field_gt", label: "is greater than", needsField: true, needsValue: true },
  { test: "field_lt", label: "is less than", needsField: true, needsValue: true },
];

export function buildCondition(
  shapes: OutputShapes,
  over: AuthoredStep | null,
  test: BranchTest,
  field?: string,
  value?: string,
): string {
  const rows = over ? rowsExpr(shapes, over) : null;
  // ⚠ No upstream step means no condition that can be true or false about
  // anything. `"false"` would be a guard that silently never runs its arm;
  // this returns a literal the compiler refuses (empty), so the person is told.
  if (!rows) return "";
  const wrap = (prog: string) => `{{ ${rows} | jq('${prog}') | first }}`;
  if (test === "any") return wrap("length > 0");
  if (test === "none") return wrap("length == 0");

  // ⚠ Stripped to an identifier, not escaped. A field name is chosen from the
  // step's declared output shape, so anything outside this set is not a field
  // that exists — and building the program out of a sanitised token means there
  // is no quoting to get wrong.
  const f = (field ?? "").replace(/[^A-Za-z0-9_]/g, "");
  if (!f) return "";
  const v = jqJson(value ?? "");
  switch (test) {
    case "field_eq":
      return wrap(`any(.[]; .${f} == ${v})`);
    case "field_ne":
      return wrap(`any(.[]; .${f} != ${v})`);
    case "field_contains":
      // ⚠ `// ""` throughout: jq's string builtins ERROR on null, and a row
      // missing the field is the ordinary case, not an exceptional one. A step
      // that throws mid-guard fails the run rather than answering false.
      return wrap(`any(.[]; (.${f} // "") | contains(${v}))`);
    case "field_starts":
      return wrap(`any(.[]; (.${f} // "") | startswith(${v}))`);
    case "field_ends":
      return wrap(`any(.[]; (.${f} // "") | endswith(${v}))`);
    case "field_empty":
      return wrap(`any(.[]; (.${f} // "") == "")`);
    case "field_present":
      return wrap(`any(.[]; has("${f}"))`);
    case "field_gt":
    case "field_lt": {
      // ⚠ `tonumber?` is the whole safety of these two — see the measurement
      // above. Without it a string field compares TRUE against every number.
      const n = Number(value);
      if (!Number.isFinite(n)) return "";
      return wrap(`any(.[]; (.${f} | tonumber?) ${test === "field_gt" ? ">" : "<"} ${n})`);
    }
  }
}
