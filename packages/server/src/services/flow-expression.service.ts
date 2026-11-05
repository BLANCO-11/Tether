/**
 * Vetting the ONE class of string a generated flow model carries verbatim.
 * archive/kestra-migration/progress/DECISIONS.md D-16, D-22 · 02 R8
 *
 * ── Why this file exists, precisely ──────────────────────────────────────────
 *
 * `flow-compiler.service.ts` is the sole YAML emitter (R8) and it is safe for a
 * structural reason: task types and the one reachable host are chosen by the
 * compiler, and free text is re-indented into a block scalar rather than
 * concatenated into YAML. But `paramsExpr`, `inputExpr` and `transform.expr`
 * are **opaque strings emitted verbatim**, and D-16 states the precondition
 * that makes that acceptable:
 *
 *   > it is safe only while models are Foundry-authored.
 *
 * Phase 4.10 ends that. A drafting model now authors those expressions from a
 * goal the tenant wrote, so the precondition has to be replaced by a check —
 * before the expression reaches the compiler, not inside it. The compiler's
 * contract stays "opaque, already vetted"; this is what does the vetting.
 *
 * ── What the exposure actually is ────────────────────────────────────────────
 *
 * The expressions land inside Pebble templates that Kestra evaluates, and
 * Pebble is a function language. `{{ secret('FOUNDRY_CALLBACK') }}` reads
 * Kestra's secret store — which holds the callback secret — and a drafted
 * `paramsExpr` carrying it would post that secret to a tool endpoint the tenant
 * controls. A draft test run is enough: the draft namespace is deliberately
 * exempt from the approval gate, because a draft run is how the first gate gets
 * satisfied at all. So the check must sit at drafting time.
 *
 * ── Allowlist, not blocklist, and that is the entire point ───────────────────
 *
 * A blocklist of `secret(`, `kv(`, `read(`, `fileURI` is defeated by the next
 * Kestra release adding a function nobody here has heard of. The check below
 * inverts it: an expression may reference three variable roots and call five
 * functions, and **anything else fails by name**. A new Pebble builtin is
 * rejected on the day it ships without anyone editing this file.
 *
 * This is a boundary for *generated* models. A Foundry engineer hand-writing a
 * model (`kestra/hr-screening.model.ts`) is outside it by design — that code is
 * reviewed the ordinary way, and narrowing the compiler to this subset would
 * make the hand-written flows that prove Phase 1 uncompilable.
 */

/**
 * Roots a generated expression may read. Everything a drafted flow legitimately
 * needs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ `trigger` WAS ON THIS LIST AND IS NOT ANY MORE — 2026-09-04, and it is
 * I-118's shape exactly: a name the check permitted that the engine could never
 * honour on the one run that matters.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A chat turn wrote `[{"as_of": "{{ trigger.timestamp }}"}]`. Every static check
 * passed. The run died 0.5s in with the engine's own words:
 *
 *     Unable to find `trigger` used in the expression … at line 6
 *
 * `trigger` exists only on a run the engine started FROM a trigger. Every run a
 * person can start — the test run, the "Run now" — has none. And gate 1 requires
 * a **successful run before a flow may be armed**, so a flow that reads
 * `trigger` fails the only run that could ever unlock the arming that would give
 * it a `trigger`. **It is unreachable by construction**, not merely risky: there
 * is no sequence of actions in this product that makes such a flow work.
 *
 * ⚠ MEASURED, both halves, on this engine and not from memory — the discipline
 * this list already states. `{{ trigger.timestamp }}`: the failure above.
 * `{{ execution.startDate }}` on a manually started execution: **SUCCESS**,
 * `startDate=2026-09-04T09:53:42.419471Z`. So the refusal below can name a
 * replacement that has actually been run.
 *
 * ⚠ **This narrows what a generated model may say and nothing else.** A Schedule
 * trigger is still emitted by the compiler for an approved revision — that is a
 * `triggers:` block in the YAML, not an expression, and it never passes through
 * here. What is refused is a *step* reading `trigger.*`.
 */
const ALLOWED_ROOTS = new Set(["inputs", "outputs", "flow", "execution"]);

/**
 * The fields those roots actually carry, **MEASURED ON THIS ENGINE** on
 * 2026-09-06 and never written from memory.
 *
 * ⚠ **The failure that caused this.** A chat-built flow shipped
 * `{{ execution.startedAt }}`. `execution` is an allowed ROOT, so it passed
 * every static check, compiled, deployed, armed — and died at runtime with
 * `Unable to find 'startedAt' used in the expression … at line 6`, which names
 * a field and not a cause and reads like bad data. D-22 has always governed
 * roots and functions; **nothing has ever checked the field under a root that
 * is allowed**, so the allowlist's own vocabulary had a hole one level down.
 *
 * ⚠ This is I-118's shape exactly — there, three of seven allowlisted
 * "functions" were jq's vocabulary rather than Pebble's, the prompt taught them
 * by name, and the control configured from the same list waved the failure
 * through. So these came from a probe flow: one `core.log.Log` task per
 * candidate under `allowFailure`, deployed to `foundry.system` (which by
 * construction can never obtain an execution token, D-09), read back from which
 * taskruns succeeded. **Add nothing here without running it.**
 *
 * ⚠ Only `execution` and `flow` appear, and that is the whole point of the
 * pair: `inputs` and `outputs` have vocabularies the AUTHOR defines — an input
 * is whatever the flow declares, an output whatever a step returns — so a fixed
 * list for either would refuse correct expressions. These two are the engine's,
 * and they are closed.
 */
const ROOT_FIELDS: Record<string, Set<string>> = {
  // RESOLVES: id, startDate, originalId, state
  execution: new Set(["id", "startDate", "originalId", "state"]),
  // RESOLVES: id, namespace, revision, tenantId
  flow: new Set(["id", "namespace", "revision", "tenantId"]),
};

/**
 * Wrong spellings worth answering by name, with the field that means it.
 *
 * ⚠ A refusal that names no alternative is how a correct rejection becomes
 * three more attempts at the same idea — the argument `UNREACHABLE_ROOTS`
 * already makes one level up. `startedAt` is the one that actually shipped;
 * the rest were measured as failing in the same probe run.
 */
const FIELD_REPLACEMENTS: Record<string, string> = {
  startedAt: "startDate",
  startTime: "startDate",
  started: "startDate",
  start_date: "startDate",
  createdAt: "startDate",
  timestamp: "startDate",
};

/** `execution.foo` / `flow.bar` — the root and the field it reaches for. */
const ROOT_FIELD_RE = /\b(execution|flow)\.([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Roots that exist in Pebble but that a Foundry flow can never usefully read,
 * with what to write instead.
 *
 * ⚠ **Its own message, not the generic "allowed roots are …".** The generic one
 * is true and useless here: it tells an author that `trigger` is not on a list
 * without saying that the thing they wanted — when did this run start — has an
 * answer, or what that answer is. A refusal that names no alternative is how a
 * correct rejection becomes three more attempts at the same idea.
 */
const UNREACHABLE_ROOTS: Record<string, string> = {
  trigger:
    "`trigger` only exists on a run the engine started from a schedule or a webhook, " +
    "and a flow cannot be armed until it has completed a run somebody started by hand — " +
    "so a step reading it can never get there. Use `{{ execution.startDate }}` for when " +
    "this run began, or declare an input and pass the value in.",
};

/**
 * Functions and filters a generated expression may call.
 *
 * `json` and `jq` are how every real expression in the reference flows reshapes
 * a step's body; `first` unwraps jq's single-element result (and is the I-11
 * trap, not a hazard). The absent names are the point: `secret`, `kv`, `read`,
 * `fileURI`, `namespace`, `render`, `fromJson` on a URI — none is listed, so
 * none is reachable.
 *
 * ⚠ **Every name here has been RUN against the engine** — see `PEBBLE_ABSENT`.
 * This list is what stands between a drafted expression and a runtime failure,
 * so a name added from memory is a hole in the one control that was supposed to
 * close it. `first` and `length` render; the three that did not are below.
 */
/**
 * ⚠ `toJson` added 2026-09-26 (compiled-builder 2d), and ONLY because it was run: `logs/input-splice-probe.mts` rendered
 * `jq('… ' ~ (inputs.x | toJson) ~ ' …')` for an INT, a DATE and a STRING holding both `'` and `"`, and each reached jq
 * as the exact JSON literal. It is how a combinator reads a flow input without a template inside jq (I-11). It serialises a
 * value and reads nothing, so it opens no new root; `secret(…)` stays refused as a call.
 */
const ALLOWED_CALLS = new Set(["json", "jq", "first", "length", "toJson"]);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PEBBLE OPERATORS — words that are neither calls nor roots
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ **This is NOT a widening of `ALLOWED_CALLS`, and the distinction is the
 * whole safety argument.** `CALL_RE` is `identifier\s*\(`, and the `\s*` is
 * load-bearing: without it `secret ('FOUNDRY_CALLBACK')` with one space walks
 * past D-22 entirely. So the space must keep making a call, and the only safe
 * way to admit an operator is to name the operator.
 *
 * `and` is here because a branch arm with two conditions renders
 * `{{ (A) and (B) }}` (Phase 4a.1), and `A and (B` matched `CALL_RE` as a call
 * to `and`. It is exempt from the CALL check and from the ROOT check — it is
 * neither, and being told *"`and` is not readable … Allowed roots: inputs,
 * outputs, …"* is advice for a mistake nobody made (the I-43/I-57 lesson: a
 * finding that names the wrong thing costs a redraft and reproduces the error).
 *
 * ⚠ **MEASURED, and only what was measured is here.** `and` was run against
 * v1.3.29 in a `core.flow.If`, 2026-09-22, with a positive and a negative
 * control. `or` and `not` are NOT on this list: they are plausible, they are
 * unmeasured, and `PEBBLE_ABSENT` below is the record of what happens when a
 * name is added to this file from memory — `not` is in it, having come back
 * `ParserException: Unexpected token "not" of type OPERATOR`.
 *
 * ⚠ **An OR needs no entry here.** An `elif` chain already expresses one: two
 * arms with the same body is a disjunction, and `elseOf` is the mechanism. What
 * no chain can express is one arm requiring both things at once, which is the
 * gap `and` closes.
 */
export const PEBBLE_OPERATORS = new Set(["and"]);

/**
 * ⚠ **jq's vocabulary, NOT Pebble's — and this list is MEASURED, not recalled.**
 *
 * All three were on `ALLOWED_CALLS` until 2026-08-07, and the draft prompt
 * offered them by name (*"You may call: json(...), jq('...'), | first, tostring,
 * tonumber, length, not"*). So the model was told to use filters the engine does
 * not have, and the allowlist that exists to catch exactly that had been
 * configured from the same wrong list. The result is I-44's shape: it parses,
 * passes every static check, compiles, deploys, and dies at execution.
 *
 * Measured against the running engine (a `Parallel` of one `Log` per name, so
 * each renders independently rather than the first failure hiding the rest):
 *
 *     first      SUCCESS
 *     length     SUCCESS
 *     tostring   FAILED   Filter [tostring] does not exist.
 *     tonumber   FAILED   Filter [tonumber] does not exist.
 *     not        FAILED   ParserException: Unexpected token "not" of type OPERATOR
 *
 * ⚠ **They are still legal INSIDE `jq('…')`, and nothing here changes that.**
 * The scan runs over `blankStrings(span.body)`, so a jq program's quoted text is
 * blanked before any filter is looked for — `| jq('… | tostring')` is invisible
 * to this and always was. Which means the docblock that justified their presence
 * (*"they are reachable as Pebble filters"*) was not merely wrong about the
 * engine; it described a scan that never saw them in the position it named. The
 * three Finance scenarios all use `|tostring` inside jq and are unaffected.
 */
const PEBBLE_ABSENT = new Set(["tostring", "tonumber", "not"]);

/**
 * `{{ … }}` — the only construct Kestra evaluates. Anything outside one is
 * literal text.
 *
 * ⚠ **This is a scanner and not a regex, and the regex it replaced was the
 * single most expensive bug in generation.**
 *
 * It used to be `/\{\{([\s\S]*?)\}\}/g` — non-greedy, so it closed the template
 * at the FIRST `}}`. A jq program that builds a nested object ends in one:
 *
 *   {{ outputs.p.value | jq('[.[] | {to: .email, vars: {name: .full_name}}]') | first }}
 *                                                                        ↑↑
 *                                                        the scan stopped here
 *
 * The body then ended mid-string with an unbalanced quote, `blankStrings`
 * blanked nothing, and every field name in the jq program was reported as an
 * unreadable variable root — *"`to` is not readable … Allowed roots: inputs,
 * outputs, …"*, five to nine of them per step.
 *
 * That expression is CORRECT. It is also the single most natural thing a
 * drafter writes, because reshaping rows for a tool call is what a `transform`
 * is for. So D-22's allowlist was systematically refusing the main case, the
 * findings named a problem that did not exist, and the redraft loop was handed
 * them verbatim — measured, three attempts and ~90 s spent to produce nothing,
 * repeatedly. It is the whole of *"autogenerate takes forever"*.
 *
 * Two rules, and they pull in opposite directions on purpose:
 *
 *   * finding the CLOSE respects quotes, so `}}` inside a jq program does not
 *     end the template;
 *   * finding a NESTED `{{` ignores quotes, because `jq('… "{{ inputs.x }}" …')`
 *     is I-11 and must still be caught.
 */
interface TemplateSpan {
  /** The text between `{{` and its true `}}`. */
  body: string;
  /** With the delimiters, for quoting back in a finding. */
  raw: string;
  /** A `{{` occurs inside this one — I-11, wherever it sits. */
  nested: boolean;
}

/** Index just past the closing quote of the span opening at `i`, or `-1`. */
function skipQuoted(s: string, i: number): number {
  const quote = s[i];
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === "\\") {
      j += 2;
      continue;
    }
    if (s[j] === quote) return j + 1;
    j++;
  }
  return -1;
}

function scanTemplates(expr: string): { spans: TemplateSpan[]; unterminated: boolean } {
  const spans: TemplateSpan[] = [];
  let i = 0;
  while (i < expr.length) {
    const open = expr.indexOf("{{", i);
    if (open < 0) break;

    let j = open + 2;
    let closed = -1;
    while (j < expr.length) {
      const ch = expr[j]!;
      if (ch === "'" || ch === '"') {
        const after = skipQuoted(expr, j);
        // An unterminated quote cannot be reasoned about; treat the whole
        // template as unterminated rather than guessing where it ends.
        if (after < 0) return { spans, unterminated: true };
        j = after;
        continue;
      }
      if (ch === "}" && expr[j + 1] === "}") {
        closed = j;
        break;
      }
      j++;
    }
    if (closed < 0) return { spans, unterminated: true };

    const body = expr.slice(open + 2, closed);
    spans.push({ body, raw: expr.slice(open, closed + 2), nested: body.includes("{{") });
    i = closed + 2;
  }
  return { spans, unterminated: false };
}

/** A call site: an identifier immediately followed by `(`. */
const CALL_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

/**
 * A variable reference: an identifier NOT followed by `(` and not preceded by a
 * `.` (so `outputs.screen.body` yields `outputs`, not `screen` and `body`) and
 * not inside a quoted string.
 */
const ROOT_RE = /(^|[^.\w'"])([A-Za-z_][A-Za-z0-9_]*)/g;

/** Pebble filter application — `| jq(...)`, `| first`. Bare filters are checked as calls. */
const FILTER_RE = /\|\s*([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * The `{{ … }}` spans of an expression, each with the offset it starts at.
 *
 * ⚠ **Exported so a second checker does not re-find `{{ … }}` with a regex.**
 * That is exactly I-57: `/\{\{([\s\S]*?)\}\}/g` closes the template at the first
 * `}}`, which a jq program building a nested object supplies itself — and the
 * failure is silent and total, because every field name after the cut is then
 * read as an unknown variable. `scanTemplates` is the one place that knows a
 * close must respect quotes, and it stays the one place.
 *
 * The offset is derived the same way `checkJsonSkeleton` derives it — searching
 * forward from the end of the previous span, since spans come back in order
 * from this same string — rather than by a second scan.
 */
export function templateSpans(expr: string): Array<{ body: string; raw: string; start: number }> {
  const { spans } = scanTemplates(expr);
  const out: Array<{ body: string; raw: string; start: number }> = [];
  let pos = 0;
  for (const span of spans) {
    const found = expr.indexOf(span.raw, pos);
    const start = found < 0 ? pos : found;
    out.push({ body: span.body, raw: span.raw, start });
    pos = start + span.raw.length;
  }
  return out;
}

export interface ExpressionFinding {
  /** Fed back to the drafting model verbatim — the working loop is error-in, fix-out. */
  message: string;
}

/**
 * jq's own vocabulary. Not an allowlist of anything — a lookup used ONLY to say
 * something useful when one of these turns up at the Pebble level.
 *
 * A drafter writing `{{ outputs.x.body | map(select(.a)) }}` has made a real
 * mistake and the rejection is right, but *"Read a value from a prior step with
 * `outputs.<step>` instead"* is advice for a different mistake. What it needs to
 * hear is that jq functions live inside `jq('…')`. Measured: this exact
 * expression failed a real draft, and the redraft could not act on the finding.
 *
 * `first` and `length` are deliberately absent — both are real Pebble filters
 * (measured), so they are allowed outright and never reach this branch.
 * `tostring`/`tonumber`/`not` are NOT here either: they get their own message
 * from `PEBBLE_ABSENT`, because *"jq only runs inside `jq('…')`"* is the right
 * advice and *"write `| jq('… tostring(…) …')`"* is not — they take no argument.
 */
const JQ_BUILTINS = new Set([
  "map", "select", "contains", "join", "split", "keys", "values", "has", "any", "all",
  "add", "sort", "sort_by", "group_by", "unique", "unique_by", "min", "max", "min_by",
  "max_by", "range", "reduce", "to_entries", "from_entries", "with_entries", "flatten",
  "ascii_downcase", "ascii_upcase", "ltrimstr", "rtrimstr", "startswith", "endswith",
  "test", "capture", "sub", "gsub", "splits", "tojson", "fromjson", "type", "empty",
  "floor", "ceil", "round", "todate", "fromdate", "last", "nth", "indices", "index",
  "del", "getpath", "setpath", "walk", "paths", "limit",
]);

/**
 * Strip quoted spans so a jq program's string literals are not mined for
 * identifiers. `jq('[.[] | {sender: "hr-bot@acme-hr.example"}]')` must not
 * report `sender` as an unknown variable root, and a literal containing the
 * word `secret` must not read as a call to `secret()`.
 *
 * Replaces with spaces rather than deleting, so offsets stay honest if this
 * ever reports a position.
 */
function blankStrings(s: string): string {
  return s.replace(/'([^'\\]|\\.)*'|"([^"\\]|\\.)*"/g, (m) => " ".repeat(m.length));
}

/**
 * Is this expression safe to hand to the compiler?
 *
 * Returns findings rather than throwing: a drafted flow is regenerated with the
 * findings appended, exactly like a fragment's static findings, so an expression
 * mistake costs one cycle instead of a failed draft.
 */
/**
 * The literal JSON skeleton AROUND an expression's `{{ … }}` spans must have
 * balanced brackets. A stray or missing `[`/`]`/`{`/`}` in the literal text is
 * invisible to everything else in this file — it isn't Pebble syntax, so the
 * allowlist scan never looks at it — and it compiles and deploys cleanly, then
 * fails at RUNTIME with a bare `JSON.parse` syntax error naming a byte offset.
 * That is the least actionable failure this file produces, for a mistake this
 * cheap to catch before a person ever runs the flow: `paramsExpr`'s own
 * contract is "produce a JSON ARRAY", and this is what checks that the literal
 * half of that contract actually holds — independent of what any span renders
 * to at runtime.
 *
 * A `{{ … }}` span is skipped whole, never inspected: what is inside it is
 * Pebble/jq syntax — its own parens and brackets mean something else entirely
 * — and the allowlist scan below already vets its content on its own terms.
 *
 * Takes `scanTemplates`'s own `spans` rather than re-finding `{{ … }}`
 * boundaries itself. A naive second scan here would need the same
 * quote-aware "close respects quotes" logic `scanTemplates` already got right
 * (I-57) — re-deriving it would be a second definition of where a span ends,
 * free to drift from the first, and a re-derivation that gets it wrong here
 * would find the `}}` INSIDE a Pebble string like `'}}' ~ secret(...)` and
 * treat everything after it as literal text.
 *
 * A single pass over the WHOLE string, not independent chunks between spans —
 * a JSON string's quotes can straddle a span, as in `"period": "{{ inputs.period }}"`,
 * where the opening `"` sits before the span and the closing one after it.
 * Whether we are inside a JSON string is state that has to survive skipping
 * the span in between, which independent per-chunk scanning cannot carry.
 */
function checkJsonSkeleton(expr: string, spans: TemplateSpan[], where: string): ExpressionFinding[] {
  // Each span's [start, end) range in `expr`, in order — found by searching
  // forward from the end of the previous one, since `spans` is itself already
  // in left-to-right order from the same string.
  const ranges: Array<[number, number]> = [];
  let pos = 0;
  for (const span of spans) {
    const start = expr.indexOf(span.raw, pos);
    const idx = start < 0 ? pos : start; // defensive; `spans` came from this same `expr`
    ranges.push([idx, idx + span.raw.length]);
    pos = idx + span.raw.length;
  }

  const stack: Array<"[" | "{"> = [];
  let inString = false;
  let i = 0;
  let r = 0;
  while (i < expr.length) {
    if (r < ranges.length && i === ranges[r]![0]) {
      i = ranges[r]![1];
      r++;
      continue;
    }
    const ch = expr[i]!;
    if (ch === '"') {
      // An escaped quote (`\"`) does not toggle string state. Count
      // immediately preceding backslashes; an even count (including zero)
      // means this quote is not escaped.
      let bs = 0;
      let k = i - 1;
      while (k >= 0 && expr[k] === "\\") {
        bs++;
        k--;
      }
      if (bs % 2 === 0) inString = !inString;
      i++;
      continue;
    }
    if (!inString && (ch === "[" || ch === "{")) {
      stack.push(ch);
    } else if (!inString && (ch === "]" || ch === "}")) {
      const want = ch === "]" ? "[" : "{";
      if (stack.pop() !== want) {
        return [
          {
            message:
              `${where}: an unexpected \`${ch}\` in the literal (non-templated) text — the ` +
              `brackets outside \`{{ … }}\` do not balance, in \`${expr}\`. This compiles and ` +
              `deploys, then fails at runtime with a bare JSON parse error naming a byte offset.`,
          },
        ];
      }
    }
    i++;
  }
  // An unterminated literal string is a different check's job — don't also
  // report a bracket-balance finding for it here.
  if (inString) return [];
  if (stack.length) {
    return [
      {
        message:
          `${where}: an unclosed \`${stack[stack.length - 1]}\` in the literal (non-templated) ` +
          `text — the brackets outside \`{{ … }}\` do not balance, in \`${expr}\`.`,
      },
    ];
  }
  return [];
}

/**
 * The brackets INSIDE a `{{ … }}` span must balance, counting only what is
 * outside the span's own string literals.
 * `breaking-2026-08-07/report.md` F1 · **I-113**
 *
 * ── ⚠ The gap this closes, and how it presented ─────────────────────────────
 *
 * Reported from use as a Pebble `ParserException: Unclosed ")"` on a step that
 * had passed every gate. The expression, from `flow_revisions`:
 *
 *   {{ json(outputs.x.body) | jq('(.employees | map({…}) | tostring)) | @json' | first }}
 *                             ^^^^                                  ^
 *                             opens                    jq's own close, INSIDE the string
 *
 * Outside the quotes, `jq(` opens a paren and nothing closes it. The model put
 * jq's closing paren inside the jq program, where Pebble cannot see it.
 *
 * ⚠ **`validateGeneratedExpr` returned ZERO findings on it, and on two other
 * malformed variants.** It checked four things — an unterminated `{{`, the JSON
 * skeleton OUTSIDE the templates, nested templates (I-11), and which names are
 * called — and `blankStrings()` erases the quoted content before the allowlist
 * scan, so the imbalance was invisible to every check that ran. The literal text
 * outside a span was balance-checked and the Pebble expression inside one never
 * was.
 *
 * ⚠ **And the engine cannot catch it either — measured.** A flow carrying this
 * exact expression was posted to `POST /api/v1/main/flows/validate` and came
 * back `warnings: [], infos: []`. Pebble expressions are parsed at RENDER time,
 * not at validate time, so "let Kestra check it" is not available as a fix.
 *
 * That makes this I-44's shape and worse: it compiles, deploys, passes every
 * static check — and by the time it fails the flow may have been APPROVED, so
 * the failure lands after the gate, on a schedule, naming neither the step nor
 * the field.
 *
 * ── ⚠ Why this checks so little, deliberately ───────────────────────────────
 *
 * Only bracket balance, only outside strings. The jq program inside `'…'` is not
 * inspected at all — its parens mean something else, and I-57 is the record of
 * what an over-eager expression check costs: the allowlist once found `{{ … }}`
 * with a non-greedy regex, so valid jq building a nested object closed the
 * template at its own `}}`, and **25 of 26 findings in a measured run were the
 * validator being wrong**. Those findings are fed to the redraft verbatim, so
 * the model rewrote correct expressions into different ones.
 *
 * ⚠ **The `DRAFT_RULES` worked example must pass this**, and a test asserts it.
 * That example's `jq('("Send " + (…) + " for ' ~ inputs.period ~ '?") | @json')`
 * splits one jq program across two Pebble strings around a `~`, so its parens
 * balance only when the strings are skipped correctly. An example the validators
 * reject teaches a mistake and charges a redraft for it in every workspace, for
 * ever (D-55).
 *
 * An unterminated QUOTE is not this function's business — `scanTemplates`
 * already refuses the whole expression for one, because it cannot tell where the
 * span ends.
 */
function checkSpanBalance(span: TemplateSpan, where: string): ExpressionFinding[] {
  const body = span.body;
  const stack: Array<{ ch: "(" | "[" | "{"; at: number }> = [];
  const CLOSE_OF: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === "'" || ch === '"') {
      const after = skipQuoted(body, i);
      // Unreachable in practice — `scanTemplates` refuses the expression before
      // this runs. Bailing rather than guessing where the string ends: a scan
      // that carried on would read the jq program as Pebble.
      if (after < 0) return [];
      i = after;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      stack.push({ ch, at: i });
    } else if (ch === ")" || ch === "]" || ch === "}") {
      const open = stack.pop();
      if (!open || CLOSE_OF[open.ch] !== ch) {
        return [
          {
            message:
              `${where}: an unexpected \`${ch}\` inside \`{{ … }}\` — the brackets in the ` +
              `expression do not balance, in \`${span.raw.slice(0, 200)}\`. Pebble parses this at ` +
              `RUN time, so it deploys cleanly and then fails the execution with ` +
              `\`ParserException\`. If the \`${ch}\` belongs to a jq program, it must sit INSIDE ` +
              `the quotes: \`jq('… ${ch}')\`, never \`jq('…' ${ch})\`.`,
          },
        ];
      }
    }
    i++;
  }
  if (stack.length) {
    const open = stack[stack.length - 1]!;
    return [
      {
        message:
          `${where}: an unclosed \`${open.ch}\` inside \`{{ … }}\` — the brackets in the ` +
          `expression do not balance, in \`${span.raw.slice(0, 200)}\`. Pebble parses this at ` +
          `RUN time, so it deploys cleanly and then fails the execution with ` +
          `\`ParserException: Unclosed "${CLOSE_OF[open.ch]}"\`. The commonest cause is a \`)\` ` +
          `that closes \`jq(\` being written inside the jq program instead of after the quotes: ` +
          `write \`jq('…program…')\`, not \`jq('…program…)'\`.`,
      },
    ];
  }
  return [];
}

export function validateGeneratedExpr(expr: string, where: string): ExpressionFinding[] {
  const findings: ExpressionFinding[] = [];

  const { spans, unterminated } = scanTemplates(expr);

  /**
   * ⚠ Reported, never ignored. A `{{` the scanner could not close means either
   * an unbalanced quote or a missing `}}`, and in both cases everything after it
   * is UNSCANNED — so silently analysing the spans found so far would be a check
   * that passes over the part it could not read. That is the shape of a control
   * that fires always-or-never; here it fails closed.
   */
  if (unterminated) {
    return [
      {
        message:
          `${where}: a \`{{\` is never closed — either a \`}}\` is missing or a quote inside it ` +
          `is unbalanced. The expression cannot be checked, so it is refused.`,
      },
    ];
  }

  // Structural, before anything about the spans' CONTENT — a skeleton that
  // does not balance is wrong whatever any span renders to, and it is exactly
  // the class of mistake the allowlist scan below cannot see at all.
  const skeleton = checkJsonSkeleton(expr, spans, where);
  if (skeleton.length) return skeleton;

  // I-11 first, and it stops the rest. A nested template means the drafter
  // expects an inner value to be substituted and it will not be, so anything
  // else this function might say about the span describes an expression that
  // was never going to work.
  const nested = spans.filter((s) => s.nested);
  if (nested.length) {
    for (const span of nested) {
      findings.push({
        message:
          `${where}: a \`{{ … }}\` is nested inside another one, in \`${span.raw.slice(0, 120)}\`. ` +
          `The engine does not re-evaluate a template inside a filter argument, so the inner ` +
          `one would be rendered as literal text. Concatenate instead: ` +
          `\`jq('… contains("' ~ inputs.period ~ '") …')\`.`,
      });
    }
    return findings;
  }

  /**
   * ⚠ Before the allowlist scan, and it RETURNS rather than accumulating.
   *
   * A span whose brackets do not balance is not an expression yet, so anything
   * the allowlist has to say about which names it calls describes something that
   * was never going to parse. Reporting both would put a second finding in the
   * redraft prompt for one mistake — and the redraft is where extra findings do
   * real damage (I-57), because the model acts on all of them.
   */
  const unbalanced = spans.flatMap((s) => checkSpanBalance(s, where));
  if (unbalanced.length) return unbalanced;

  for (const span of spans) {
    const body = blankStrings(span.body);

    const called = new Set<string>();
    /**
     * ⚠ Names that appeared with WHITESPACE before the `(` — `and (x)`, not
     * `and(x)`. Only these may be exempted as operators.
     *
     * Without it the exemption admits `and('x')` as a call: Pebble has no such
     * function, so it passes every static check and dies at RENDER naming
     * nothing — I-44's exact shape, which is the failure class this file exists
     * to prevent. `json (x)` lands here too and is unaffected, being on
     * `ALLOWED_CALLS`; `secret ('FOUNDRY_CALLBACK')` lands here and is still
     * refused, because it is not an operator.
     */
    const spacedBeforeParen = new Set<string>();
    for (const c of body.matchAll(CALL_RE)) {
      called.add(c[1]);
      if (/\s\($/.test(c[0])) spacedBeforeParen.add(c[1]);
    }
    for (const f of body.matchAll(FILTER_RE)) called.add(f[1]);

    for (const name of called) {
      if (ALLOWED_CALLS.has(name)) continue;
      // ⚠ An operator is not a call. `CALL_RE` cannot tell them apart because
      // it must keep treating `json (x)` as a call — see PEBBLE_OPERATORS. The
      // space is what distinguishes `(A) and (B)` from a call to `and`.
      if (PEBBLE_OPERATORS.has(name) && spacedBeforeParen.has(name)) continue;
      /**
       * ⚠ Its own message, and the message is the whole value of this branch.
       *
       * The generic one below would say *"`tostring(…)` is not callable … read a
       * value from a prior step with `outputs.<step>`"*, which is advice for a
       * different mistake entirely — the drafter is not reaching for the wrong
       * root, it is applying a real jq filter one level too high. It has to be
       * told WHERE the filter goes, and told without a `(…)` these three do not
       * take. Measured: this exact expression, `| jq('…') | first | tostring`,
       * reached a deployed flow and failed at execution.
       */
      if (PEBBLE_ABSENT.has(name)) {
        findings.push({
          message:
            `${where}: \`| ${name}\` is a jq filter and the engine has no such Pebble filter — ` +
            `it fails at RUN TIME, not here, with "Filter [${name}] does not exist". Move it ` +
            `INSIDE the jq program: \`| jq('… | ${name}') | first\`, never \`| jq('…') | ${name}\`.`,
        });
        continue;
      }
      // Same rejection, actionable message. `map`/`select`/`contains` at the
      // Pebble level is the drafter reaching for jq without the jq program, and
      // it needs to be told where jq lives — not to read from `outputs.<step>`,
      // which it already did.
      if (JQ_BUILTINS.has(name)) {
        findings.push({
          message:
            `${where}: \`${name}(…)\` is a jq function and the engine has no such filter. ` +
            `jq only runs inside \`jq('…')\` — write \`| jq('… ${name}(…) …') | first\`.`,
        });
        continue;
      }
      findings.push({
        message:
          `${where}: \`${name}(…)\` is not callable in a generated expression. ` +
          `Allowed: ${[...ALLOWED_CALLS].join(", ")}. ` +
          `Read a value from a prior step with \`outputs.<step>\` instead.`,
      });
    }

    for (const r of body.matchAll(ROOT_RE)) {
      const name = r[2];
      // A call site was already judged above; a filter name likewise.
      if (called.has(name)) continue;
      if (ALLOWED_ROOTS.has(name)) continue;
      // ⚠ An operator is not a root either, and the roots message would be
      // advice for a mistake nobody made.
      if (PEBBLE_OPERATORS.has(name)) continue;
      // Bare literals inside a Pebble expression: `true`, `null`, numbers.
      if (name === "true" || name === "false" || name === "null") continue;
      /**
       * ⚠ `@json` outside the jq program — I-43, and it needs its OWN message.
       *
       * The generic one says *"`json` is not readable … Allowed roots: inputs,
       * outputs, …"*, which is wrong twice over: `json` is not being read as a
       * root, and `json(…)` is on the allowlist, so the drafter is told the
       * opposite of what the prompt taught it. Measured — a real draft was
       * rejected for `| jq('…') | @json` and the redraft could not act on the
       * finding, so it cost a full ~30 s decode and reproduced the mistake.
       *
       * The `@` is stripped before the identifier is captured, so the preceding
       * character is the only place the distinction survives.
       */
      if (r[1] === "@") {
        findings.push({
          message:
            `${where}: \`@${name}\` is a jq encoder, not an engine filter — it belongs INSIDE ` +
            `the jq program. Write \`| jq('… | @${name}')\`, not \`| jq('…') | @${name}\`.`,
        });
        continue;
      }
      // ⚠ A root that EXISTS in the engine but is unreachable here answers with
      // the replacement, not with a list it is absent from. See UNREACHABLE_ROOTS.
      const unreachable = UNREACHABLE_ROOTS[name];
      if (unreachable) {
        findings.push({ message: `${where}: ${unreachable}` });
        continue;
      }
      findings.push({
        message:
          `${where}: \`${name}\` is not readable in a generated expression. ` +
          `Allowed roots: ${[...ALLOWED_ROOTS].join(", ")}.`,
      });
    }

    /**
     * ⚠ The field under an allowed root — the hole `execution.startedAt` went
     * through. Runs after the root loop and independently of it: a bad field on
     * a GOOD root produces no root finding at all, which is exactly why this
     * failure reached a live run.
     */
    for (const m of body.matchAll(ROOT_FIELD_RE)) {
      const root = m[1]!;
      const field = m[2]!;
      const allowed = ROOT_FIELDS[root]!;
      if (allowed.has(field)) continue;
      const instead = FIELD_REPLACEMENTS[field];
      findings.push({
        message:
          `${where}: \`${root}.${field}\` does not exist on this engine` +
          (instead ? `. Use \`${root}.${instead}\`` : "") +
          `. ${root} carries: ${[...allowed].join(", ")}. ` +
          `This compiles and deploys, then fails at runtime with a message naming the field.`,
      });
    }
  }

  return findings;
}

/**
 * EVERY expression field a step can carry, and adding a step kind means adding
 * its fields here.
 *
 * This list is what stops `{{ secret('FOUNDRY_CALLBACK') }}` reaching the
 * compiler (D-22), and a field missing from it is not checked at all — the
 * omission is silent, because an unchecked expression compiles and runs
 * perfectly. `summaryExpr`/`contextExpr` are gate 3's, and they matter as much
 * as the rest: an approval's summary is rendered into a JSON body by the same
 * mechanism as a prompt.
 *
 * ⚠ **EXPORTED because it now has a second consumer** — `checkConstructedDates`
 * scans the same fields for a date built by concatenation. Two copies of this
 * list would double the silent failure the paragraph above describes: a field
 * added to one copy is unchecked by the other, and nothing anywhere reports it
 * (D-197). `flow-date-params.test.ts` asserts both consumers see the same list.
 */
export const EXPRESSION_FIELDS = [
  "paramsExpr",
  "inputExpr",
  "expr",
  "promptExpr",
  "summaryExpr",
  "contextExpr",
] as const;

/**
 * Every expression a drafted model carries, checked in one pass.
 *
 * Deliberately takes the raw step objects rather than a typed `FlowStep[]`: it
 * runs on a *parsed generator response*, before the model is known to be
 * well-formed, and refusing to look at a step because its `kind` is unfamiliar
 * would let an unknown kind smuggle an expression through.
 */
export function validateModelExpressions(
  steps: Array<Record<string, unknown>>,
): ExpressionFinding[] {
  const findings: ExpressionFinding[] = [];
  for (const step of steps) {
    const id = typeof step.id === "string" ? step.id : "<unnamed step>";
    for (const field of EXPRESSION_FIELDS) {
      const value = step[field];
      if (typeof value === "string") {
        findings.push(...validateGeneratedExpr(value, `step "${id}".${field}`));
      }
    }
  }
  return findings;
}

export const flowExpressionService = {
  validateGeneratedExpr,
  validateModelExpressions,
  ALLOWED_ROOTS,
  ALLOWED_CALLS,
  PEBBLE_OPERATORS,
  EXPRESSION_FIELDS,
};
