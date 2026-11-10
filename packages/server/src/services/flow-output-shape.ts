/**
 * How a step's output is REACHED, per kind — as data rather than as prose.
 * ISSUES.md I-42, I-44 · DECISIONS.md D-49…D-51
 *
 * ── Why this is a module and not three sentences in a prompt ─────────────────
 *
 * Until Stage 5 this knowledge existed in exactly one place: four lines of
 * English inside `DRAFT_RULES`, addressed to a model. That was enough while the
 * only author of an expression WAS a model. The editable canvas has to build
 * expressions itself — it offers "read the output of step X" as a click — so it
 * needs the same fact in a form a program can use.
 *
 * The failure mode this exists to prevent is a second copy that drifts. A
 * client-side table saying a `code` step's output is `.value` would be wrong
 * (I-44) and would fail at RUNTIME, inside Kestra, with `Unable to find 'value'`
 * — long after the expression was authored, approved and armed.
 *
 * ⚠ `flow-output-shape.test.ts` asserts every expression below appears verbatim
 * in `DRAFT_RULES`. The prompt is deliberately NOT generated from this table:
 * the drafting prompt's bytes are a measured artefact (`kestra:refusal`,
 * `outline:measure`), and regenerating it from a constant would let a tidy-up
 * here silently move the prefix every one of those numbers was taken against.
 * A test that fails on drift is the cheaper half of that trade.
 */

/** The kinds a flow model can declare. Mirrors the compiler's emittable set. */
import { templateSpans } from "./flow-expression.service.js";

export type StepKind =
  | "datasource"
  | "query"
  | "transform"
  | "code"
  | "tool"
  | "approval"
  /** A conditional guard — foundations Phase 3. No output; see `OUTPUT_SHAPES.branch`. */
  | "branch"
  /** Where the arms come back together. Reads like a `transform`; see `MergeStep`. */
  | "merge"
  /** A model call answered by Foundry — the text is at `.text`; see `OUTPUT_SHAPES.llm`. */
  | "llm"
  /** A Foundry-dialled request — `{body, status_code, headers, size}`; see `OUTPUT_SHAPES.http`. */
  | "http"
  /** For each (D-361): inside the body, the current item; see `OUTPUT_SHAPES.for_each`. */
  | "for_each"
  /** A loop's output — one row per item; see `OUTPUT_SHAPES.collect`. */
  | "collect";

export interface OutputShape {
  /**
   * The expression that yields this step's output, with `<id>` as the
   * placeholder. Empty when the kind produces nothing readable.
   */
  template: string | null;
  /** What the value IS, for a person choosing it in the inspector. */
  describes: string | null;
  /**
   * ⚠ Shown beside the pick when there is something a chooser would otherwise
   * get wrong. Null when there is nothing to warn about — a note on every row is
   * a note nobody reads.
   */
  caution: string | null;
}

/**
 * ⚠ The two entries most likely to be "corrected" by someone who has not been
 * bitten is `code`. It is written the way it is because a
 * flow was run and the other spelling failed.
 */
export const OUTPUT_SHAPES: Record<StepKind, OutputShape> = {
  /**
   * For each (D-361). ⚠ **Read only from INSIDE the loop, and never literally.** The compiler emits the body's tasks with this
   * template and then rewrites `outputs.<id>.value` to the ForEach's current value (`taskrun.value`, with one `parent.` per
   * enclosing `If`) — so inside, the step reads like a one-record transform: the item. Nothing outside may read it.
   */
  for_each: {
    template: "json(outputs.<id>.value)",
    describes: "inside the loop, the current item (one row of the list it runs over)",
    caution: "Only a step inside the loop can read it. After the loop, read the loop's output — one row per item.",
  },
  /** A loop's output: a `core.debug.Return` after the ForEach, one row per item in input order. Reads like a `transform`. */
  collect: {
    template: "json(outputs.<id>.value)",
    describes: "one row per item of the loop — its fields, plus the loop's own ff_i, ff_ok, ff_error and ff_result",
    caution: "An item whose steps did not finish has ff_ok = false and ff_result = null.",
  },
  datasource: {
    template: "json(outputs.<id>.body)",
    describes: "the query's HTTP response body — rows are at `.results[0].data`",
    caution:
      "A raw query row must not be handed to a `tool` or `approval` step. Put a " +
      "`transform` in between that picks the fields the call needs, with dates flattened " +
      'to "YYYY-MM-DD" — a timestamp crossing into a tool body fails the step at runtime (I-42).',
  },
  // A DB operation's output is the SAME envelope as a named query's: both are
  // read-only SQL whose rows arrive at `.results[0].data`.
  query: {
    template: "json(outputs.<id>.body)",
    describes: "the operation's HTTP response body — rows are at `.results[0].data`",
    caution:
      "A raw query row must not be handed to a `tool` or `approval` step. Put a " +
      "`transform` in between that picks the fields the call needs, with dates flattened " +
      'to "YYYY-MM-DD" — a timestamp crossing into a tool body fails the step at runtime (I-42).',
  },
  tool: {
    template: "json(outputs.<id>.body)",
    describes: "the tool call's HTTP response body",
    caution: null,
  },
  transform: {
    template: "json(outputs.<id>.value)",
    describes: "the value the jq expression produced",
    caution: null,
  },
  code: {
    // ⚠ `.vars.result`, NOT `.value`. I-44 — found by running a real flow, and
    // invisible to every test that did not execute one.
    template: "outputs.<id>.vars.result",
    describes: "the object the fragment's `run(payload)` returned",
    caution:
      "A `code` step's output is `.vars.result`, not `.value` — the other spelling " +
      "compiles, deploys and fails at execution (I-44).",
  },
  approval: {
    // A gate is a decision, not a value. Offering an output here would invite a
    // downstream step to branch on it — and a rejection KILLS the execution, so
    // there is no "no" to read.
    template: null,
    describes: null,
    caution:
      "A gate produces no data. Rejecting it kills the execution, so there is no " +
      'downstream "no" to read.',
  },
  /**
   * A branch guard — foundations Phase 3, task 3.4.
   *
   * ⚠ **No output, and `approval` deliberately keeps none either.** A branch kind
   * makes *"if approved do X, if not do Y"* askable for the first time, and the
   * answer is still no in this phase: rejecting a gate **kills** the execution,
   * so giving `approval` an output would change what a rejection MEANS. That is a
   * decision about the approval model, not about branching, and it is not made
   * here.
   *
   * The guard itself produces nothing because it produces no data — it decides
   * whether the tasks after it run at all. Reading `outputs.<branch>` would be
   * reading the engine's own control flow, which R6 keeps as Kestra's.
   */
  branch: {
    template: null,
    describes: null,
    caution:
      "A condition produces no data. It decides whether the steps after it run at " +
      "all — there is nothing to read from it.",
  },
  /**
   * ⚠ **`json(outputs.<id>.value)` — the SAME shape as a `transform`, and that
   * is by construction rather than by coincidence.**
   *
   * A merge emits `core.debug.Return`, exactly as a transform does, and its
   * sources are restricted to the four kinds whose raw output is a JSON string
   * (`MERGE_SOURCE_KINDS`) precisely so that this one spelling is correct no
   * matter which arm actually ran. If a `code` source were ever admitted, this
   * entry would stop being true for some merges and not others — which is the
   * worst possible state for a shape table, because the wrong spelling compiles,
   * deploys and fails at execution (I-44).
   */
  merge: {
    template: "json(outputs.<id>.value)",
    describes: "whichever of the merged steps produced a result",
    caution:
      "If no branch matched, none of the merged steps ran and this is `null` — not an " +
      "error. A step that reads a merge should cope with nothing having happened.",
  },
  /**
   * ⚠ **`json(outputs.<id>.body)` — the Foundry-callback envelope, NOT the
   * model's bare answer.** `POST /api/steps/llm` answers
   * `{text, reasoning_content, …declared fields}`, and Kestra stores that JSON
   * as the task's `body` — so the answer text is at `.text`, exactly as the
   * registry's `llm` ports declare. Reading the envelope whole hands a
   * downstream step metadata it cannot use.
   */
  llm: {
    template: "json(outputs.<id>.body)",
    describes: "the model's answer — the text is at `.text`",
    caution:
      "An answer is text, not a shape. Declare the fields you need; nothing downstream " +
      "should branch on a field a model invented.",
  },
  /**
   * `POST /api/steps/http` answers `{body, status_code, headers, size}` — the
   * response envelope, stored as the task's `body`. The payload is at `.body`;
   * `files` is deliberately NOT declared in wave 1 (no file plumbing exists
   * end to end).
   */
  http: {
    template: "json(outputs.<id>.body)",
    describes: "the response envelope — the payload is at `.body`, with `.status_code`, `.headers` and `.size` beside it",
    caution: null,
  },
};

/** The concrete expression for one step — `outputs.rank.vars.result`. */
export function outputExprFor(kind: StepKind, stepId: string): string | null {
  const shape = OUTPUT_SHAPES[kind];
  if (!shape?.template) return null;
  return shape.template.replaceAll("<id>", stepId);
}

/** The first path segment each kind's output must be read through. */
const ROOT_SEGMENT: Record<StepKind, string | null> = {
  datasource: "body",
  query: "body",
  tool: "body",
  transform: "value",
  code: "vars",
  // Same root as a `transform` — a merge is a `core.debug.Return` too.
  merge: "value",
  for_each: "value",
  collect: "value",
  approval: null,
  // A condition has no output to have a root segment of.
  branch: null,
  // Foundry-callback envelopes, stored as the task's `body` like the call kinds.
  llm: "body",
  http: "body",
};

/**
 * The top-level keys of an `http` step's envelope — `POST /api/steps/http`
 * answers `{body, status_code, headers, size}`, not `StepBatchResult`.
 */
const HTTP_ENVELOPE_KEYS = new Set(["body", "status_code", "headers", "size"]);

/**
 * The I-117 finding for the two Foundry-callback kinds, or `null` when the
 * generic `StepBatchResult` wording applies. An `llm` step's envelope is
 * `{text, reasoning_content, …declared fields}` — the fix names the step's own
 * declared fields rather than `.results[0].data`, which does not exist there.
 */
function llmHttpBodyFinding(
  who: string,
  field: string,
  target: string,
  key: string,
  kind: StepKind,
  step: Record<string, unknown> | undefined,
): string | null {
  if (kind === "llm") {
    const fields = (step?.["outputFields"] ?? []) as Array<{ name?: unknown }>;
    const names = fields.map((f) => f.name).filter((n): n is string => typeof n === "string");
    return (
      `step "${who}".${field} reads \`json(outputs.${target}.body).${key}\`, but there is no ` +
      `\`.${key}\` there. An \`llm\` step's body is \`{text, reasoning_content` +
      `${names.length ? `, ${names.map((n) => `\`${n}\``).join(", ")}` : ""}\` — ` +
      `the model's answer text is at \`json(outputs.${target}.body).text\`. Use that; inventing ` +
      `a key at the top of the body compiles and deploys, then fails the run with ` +
      `"Unable to find \`${key}\`".`
    );
  }
  if (kind === "http") {
    return (
      `step "${who}".${field} reads \`json(outputs.${target}.body).${key}\`, but there is no ` +
      `\`.${key}\` there. An \`http\` step's body is \`{body, status_code, headers, size}\` — ` +
      `the payload is at \`json(outputs.${target}.body).body\`. Use that; inventing ` +
      `a key at the top of the body compiles and deploys, then fails the run with ` +
      `"Unable to find \`${key}\`".`
    );
  }
  return null;
}

/** `outputs.<step>.<segment>` — the reference sites this check inspects. */
const OUTPUT_REF_RE = /outputs\.([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/g;

/** `outputs.<id>.vars` NOT followed by `.result` — see its use in `checkOutputShapes`. */
const CODE_VARS_SHORT_RE = /outputs\.([A-Za-z_][A-Za-z0-9_]*)\.vars(?!\.result\b)(?![A-Za-z0-9_])/g;

/**
 * `json(outputs.<step>.body).<key>` — the SECOND segment, which used to be
 * treated as unknowable and is not.
 * **I-117**
 *
 * ── ⚠ The docblock this replaces was wrong, and a real run proved it ────────
 *
 * `checkOutputShapes` said, of its own bound: *"`.body.employees` — an invented
 * response field — is not detectable here: `body` is right and only the tenant's
 * data says whether `employees` exists."* That is false. **The body is
 * FOUNDRY's envelope, not the tenant's payload**: `POST /api/steps/{tool,
 * datasource}` answers `StepBatchResult`, which is exactly
 * `{results, succeeded, failed, warnings, readFrom?}` — and the tenant's data is
 * always at `.results[i].data`, never at the top.
 *
 * So every key at the top of `body` other than those five is statically wrong,
 * for BOTH kinds, with no knowledge of the tenant needed at all.
 *
 * Found by a real run failing at execution with ``Unable to find `employees` ``
 * on `json(outputs.fetch_attendance.body).employees` — ⚠ **an expression
 * `DRAFT_RULES` explicitly warns against by name**, which is the whole argument
 * for this being a check rather than a sentence.
 */
const BODY_KEYS = new Set(["results", "succeeded", "failed", "warnings", "readFrom"]);

/** `json(outputs.x.body).<key>` — captures the step and the key after the envelope. */
const BODY_FIELD_RE =
  /json\(\s*outputs\.([A-Za-z_][A-Za-z0-9_]*)\.body\s*\)\.([A-Za-z_][A-Za-z0-9_]*)/g;


/** Every expression field a step can carry. Mirrors `validateModelExpressions`. */
const EXPR_FIELDS = ["paramsExpr", "inputExpr", "expr", "promptExpr", "summaryExpr", "contextExpr"];

/**
 * A whole-output read — the expressions that always yield an object or an array.
 *
 * Deliberately anchored and deliberately narrow: `json(outputs.x.body)` is a
 * structure, `json(outputs.x.body).results[0].data[0].name` is a scalar and is
 * perfectly fine inside quotes. Only the forms with nothing selected out of them
 * are matched.
 */
const WHOLE_OUTPUT_RE =
  /^\s*(?:json\(\s*outputs\.[A-Za-z_][A-Za-z0-9_]*\.(?:body|value)\s*\)|outputs\.[A-Za-z_][A-Za-z0-9_]*\.vars\.result)(?:\.results\[0\]\.data)?\s*$/;

/**
 * Every `{{ … }}` that sits INSIDE a double-quoted JSON string, by walking the
 * literal text between templates and tracking string state.
 *
 * ⚠ It replaced `/"[^"]*\{\{([^{}]*)\}\}[^"]*"/g`, which paired the CLOSING
 * quote of one key with the OPENING quote of the next: in
 * `{"employees": {{ X }}, "absences": {{ Y }}}` it read `": {{ X }}, "` as a
 * quoted string and refused a correct code-step feed (measured 2026-09-28 on a
 * three-input feed). Any structured value that was not the LAST key tripped it.
 * Template bodies are skipped whole — their own quotes (a jq program) never
 * toggle the JSON string state.
 */
function quotedTemplates(value: string): string[] {
  const out: string[] = [];
  let inString = false;
  let pos = 0;
  const walk = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\\") { i++; continue; }
      if (ch === '"') inString = !inString;
    }
  };
  for (const span of templateSpans(value)) {
    walk(value.slice(pos, span.start));
    if (inString) out.push(span.body);
    pos = span.start + span.raw.length;
  }
  return out;
}

/**
 * Is a structured value being interpolated into a JSON **string** position?
 *
 * ── The failure, measured on a real draft ────────────────────────────────────
 *
 * `[{ "input": "{{ json(outputs.fetch.body) }}" }]` renders to
 * `"input": "{"total": 62, …}"` — invalid at the first inner quote. Kestra
 * reports `JsonParseException: Unexpected character ('r'): was expecting comma
 * to separate Object entries`, which names a character offset in a redacted
 * source and nothing about the step, the field, or the reason.
 *
 * This is the I-11 family and it has a documented fix: build the value in jq and
 * `@json`-encode it, which produces a string WITH its quotes, so it goes in an
 * unquoted position. The check exists because the failure is invisible until
 * runtime and its message is unactionable.
 *
 * ⚠ Narrow on purpose. Only a WHOLE output read is flagged — a scalar plucked
 * out of one belongs in quotes and must not be reported.
 */
export function checkJsonPositions(steps: Array<Record<string, unknown>>): string[] {
  const findings: string[] = [];
  for (const step of steps) {
    const who = typeof step.id === "string" ? step.id : "<unnamed step>";
    for (const field of EXPR_FIELDS) {
      const value = step[field];
      if (typeof value !== "string") continue;
      for (const expr of quotedTemplates(value)) {
        if (!WHOLE_OUTPUT_RE.test(expr)) continue;
        findings.push(
          `step "${who}".${field} puts \`{{${expr}}}\` inside a quoted JSON string. That ` +
            `expression yields an object or an array, so the rendered body is invalid JSON at ` +
            `its first inner quote. To pass structured data as TEXT, encode it: ` +
            `\`{{${expr.trim()} | jq('tostring | @json') | first }}\` — with no surrounding ` +
            `quotes, because @json supplies them. To pass it as a structure, drop the quotes.`,
        );
      }
    }
  }
  return [...new Set(findings)];
}

/**
 * Does every `outputs.<step>.…` reference use the shape that step actually has?
 *
 * ── Why this is a check and not a sentence in the prompt ─────────────────────
 *
 * The rule is already in `DRAFT_RULES`, stated three ways with a worked example,
 * and a real draft still emitted `outputs.draft_report.vars.result` for a
 * **tool** step — because `llm_complete` *feels* like generation, and
 * `.vars.result` is the generation shape. That mismatch compiles, deploys,
 * passes every static check, and fails at execution with
 * ``Unable to find `vars` `` — after the steps before it have already run.
 *
 * A prompt rule the model can ignore is not a control (the `validateOutline`
 * argument, applied to the other half of the draft). This is the control: it is
 * computed from `OUTPUT_SHAPES`, which is the same table the canvas builds
 * expressions from and which `flow-output-shape.test.ts` pins against the prompt.
 *
 * ⚠ It checks the FIRST segment only. `.body.employees` — an invented response
 * field — is not detectable here: `body` is right and only the tenant's data
 * says whether `employees` exists. Deliberately not guessed at; a check that
 * fired on unknown sub-paths would reject every legitimate `.results[0].data`.
 *
 * Findings are written for the redraft loop: they name the step, what it is, and
 * the expression that reads it correctly.
 */
/**
 * The finding a wrong output shape produces — and ⚠ **the advice matters as much
 * as the diagnosis**, because this text is fed to the redraft VERBATIM.
 *
 * ── The real failure that rewrote this (2026-08-07) ─────────────────────────
 *
 * A user's generation failed all three attempts against a single, correct
 * finding. The goal was an attendance report; the drafter wrote
 * `outputs.summary_text.text` for an `llm_complete` **tool** step, and was told:
 *
 *   …its output is `json(outputs.summary_text.body)`. Use that exactly.
 *
 * ⚠ **That advice was wrong for this case, and following it loses the value.**
 * `llm_complete`'s own catalogue description — which the drafter also reads —
 * says *"it returns `{text}`"*. The model wanted the text and was told to write
 * the envelope and nothing more. The correct expression was
 * `json(outputs.summary_text.body).text`, which this check ACCEPTS (it inspects
 * the first segment only) and which "use that exactly" steers away from.
 *
 * So the model was caught between two true statements the prompt never joined:
 * the tool returns `{text}`, and a tool's output is reached through `.body`.
 *
 * ⚠ **The fix is here and NOT in `DRAFT_RULES`.** Findings are appended per
 * attempt, so this wording is outside the cached prefix every `kestra:refusal`
 * and `outline:measure` number was taken against. Fixing it in the rules would
 * have moved that prefix and owed a re-measurement in the same commit (D-55).
 *
 * ── ⚠ Why the suggestion is conditional ─────────────────────────────────────
 *
 * "Move what you wrote inside the envelope" is right when the wrong segment was
 * a FIELD name (`.text`, `.employees`) and wrong when it was another kind's
 * ENVELOPE (`.vars` on a tool step is the code-step shape, and
 * `json(outputs.x.body).vars` is not a thing). So a segment that names any known
 * envelope gets the plain correction, and only a genuine field guess is offered
 * the rewrite.
 */
const ENVELOPE_SEGMENTS = new Set(["body", "value", "vars", "onResume", "result"]);

function shapeFinding(
  who: string,
  field: string,
  target: string,
  segment: string,
  kind: StepKind,
): string {
  const correct = outputExprFor(kind, target)!;
  const describes = OUTPUT_SHAPES[kind].describes;
  const head =
    `step "${who}".${field} reads \`outputs.${target}.${segment}\`, but "${target}" is a ` +
    `\`${kind}\` step and its output is reached through \`${correct}\`` +
    `${describes ? ` — ${describes}` : ""}.`;

  /**
   * ⚠ A field guess on a DATASOURCE (or a DB OPERATION — same envelope) is an
   * INVENTED field, and relocating it would teach the invention.
   *
   * A named query's envelope is fixed: rows are always at `.results[0].data`,
   * whatever the query is called and whatever columns it selects —
   * `DRAFT_RULES` states this and it is the rule most drafts get wrong.
   * `json(outputs.fetch.body).employees` is not "the field, relocated"; it is
   * the same fabrication one level deeper, and it fails at runtime with
   * ``Unable to find `employees` ``.
   *
   * ⚠ The first version of this function did exactly that, and it was caught by
   * RUNNING it over the four cases rather than by reading it.
   */
  if ((kind === "datasource" || kind === "query") && !ENVELOPE_SEGMENTS.has(segment)) {
    return (
      `${head} There is no \`.${segment}\` — a named query's envelope is fixed, and its ROWS ` +
      `are always at \`${correct}.results[0].data\`. Use that; inventing a field name there ` +
      `fails the flow at runtime with "Unable to find \`${segment}\`".`
    );
  }

  /**
   * A field guess on a TOOL, which is the case that produced this rewrite. The
   * field is real — the tool's own catalogue description names it
   * (`llm_complete` says *"it returns `{text}`"*) — and the only thing wrong is
   * that it was written beside the envelope instead of inside it.
   *
   * ⚠ TOOL only, not every `.body` kind: an `llm` step's envelope is
   * `{text, reasoning_content, …declared fields}` and an `http` step's is
   * `{body, status_code, headers, size}` — neither has `.results[0].data, so
   * that advice would relocate a guess into a shape that does not exist.
   */
  if (kind === "tool" && !ENVELOPE_SEGMENTS.has(segment) && correct.includes(".body")) {
    return (
      `${head} A field the tool's description names — like \`{text}\` — is not at the top of the ` +
      `body: the body is Tether's envelope and every call's own payload sits at ` +
      `\`.results[0].data\`. Write \`${correct}.results[0].data.${segment}\`, never ` +
      `\`outputs.${target}.${segment}\` and never \`${correct}.${segment}\`.`
    );
  }
  // An envelope guess: another kind's shape. There is no field to relocate.
  return (
    `${head} Use that exactly — \`.${segment}\` is a different step kind's shape, and ` +
    `the wrong spelling compiles and fails at execution.`
  );
}

/**
 * A fan-out step read as if it ran once (phase 7, R03).
 *
 * A call with `over` runs once per element, so its envelope carries ONE result per
 * element — none when there was nothing to run over. `.results[0].data` reads the
 * first call only, and on an empty run it does not render at all: execution
 * `6HvcQ4Qx…` died "Unable to find `0`" reading a per-employee lookup that had no
 * employees. Refused wherever a model is checked (it is in SHAPE_CHECKS), with the
 * form that reads every call — the renderer's own (`allResultsRows`).
 */
const FIRST_RESULT_RE = /outputs\.([A-Za-z_][A-Za-z0-9_]*)\.body\)?\s*(?:\|\s*jq\(\s*'\s*)?\.results\s*\[\s*0\s*\]/g;

export function checkFanOutFirstResult(steps: Array<Record<string, unknown>>): string[] {
  const fanOut = new Set<string>();
  for (const s of steps) {
    const over = s.over as { stepId?: unknown } | null | undefined;
    if (typeof s.id === "string" && typeof over?.stepId === "string" && over.stepId) fanOut.add(s.id);
  }
  if (!fanOut.size) return [];
  const findings: string[] = [];
  for (const step of steps) {
    const who = typeof step.id === "string" ? step.id : "<unnamed step>";
    for (const field of EXPR_FIELDS) {
      const value = step[field];
      if (typeof value !== "string") continue;
      for (const m of value.matchAll(FIRST_RESULT_RE)) {
        const target = m[1]!;
        if (!fanOut.has(target)) continue;
        findings.push(
          `step "${who}" reads \`.results[0]\` of "${target}", which runs once per element — its results hold ONE ` +
            `entry per element (none when there were no elements), so [0] reads only the first call and fails on an ` +
            `empty run. Read every call: \`json(outputs.${target}.body) | jq('[.results[]?.data | if type == "array" ` +
            `then .[] else . end] | …') | first\`.`,
        );
        break;
      }
    }
  }
  return findings;
}

export function checkOutputShapes(
  steps: Array<Record<string, unknown>>,
): string[] {
  const kindOf = new Map<string, StepKind>();
  const byId = new Map<string, Record<string, unknown>>();
  for (const s of steps) {
    if (typeof s.id === "string" && typeof s.kind === "string" && s.kind in OUTPUT_SHAPES) {
      kindOf.set(s.id, s.kind as StepKind);
      byId.set(s.id, s);
    }
  }
  const findings: string[] = [];
  for (const step of steps) {
    const who = typeof step.id === "string" ? step.id : "<unnamed step>";
    for (const field of EXPR_FIELDS) {
      const value = step[field];
      if (typeof value !== "string") continue;
      /**
       * ⚠ I-117 — an invented key at the top of the response envelope.
       *
       * `json(outputs.fetch.body).employees` passes every other check here (the
       * first segment IS `body`), compiles, deploys, and dies at execution with
       * ``Unable to find `employees` ``. That is I-44's shape, and it happened on
       * a real run despite `DRAFT_RULES` naming `.employees` as a wrong answer —
       * which is the repo's own maxim arriving again: a prompt rule the model
       * can ignore is not a control.
       */
      for (const m of value.matchAll(BODY_FIELD_RE)) {
        const [, target, key] = m;
        const kind = kindOf.get(target!);
        if (!kind || !ROOT_SEGMENT[kind] || ROOT_SEGMENT[kind] !== "body") continue;
        // The envelope's top-level keys differ by kind: the call kinds share
        // `StepBatchResult`, while `llm` answers `{text, reasoning_content,
        // …declared fields}` and `http` answers `{body, status_code, headers,
        // size}`. Without this, the registry's own read expressions —
        // `json(outputs.<id>.body).text` — would read as invented keys.
        if (kind === "llm") {
          const declared = new Set(["text", "reasoning_content"]);
          const fields = (byId.get(target!)?.["outputFields"] ?? []) as Array<{ name?: unknown }>;
          for (const f of fields) if (typeof f.name === "string") declared.add(f.name);
          if (declared.has(key!)) continue;
        } else if (kind === "http") {
          if (HTTP_ENVELOPE_KEYS.has(key!)) continue;
        } else if (BODY_KEYS.has(key!)) continue;
        findings.push(
          llmHttpBodyFinding(who, field, target!, key!, kind, byId.get(target!)) ??
            `step "${who}".${field} reads \`json(outputs.${target}.body).${key}\`, but there is no ` +
              `\`.${key}\` there. A step's body is Tether's own envelope — ` +
              `\`{results, succeeded, failed, warnings}\` — and the ${kind === "datasource" || kind === "query" ? "query's rows are" : "call's own payload is"} ` +
              `at \`json(outputs.${target}.body).results[0].data\`. Use that; inventing a key at ` +
              `the top of the body compiles and deploys, then fails the run with ` +
              `"Unable to find \`${key}\`".`,
        );
      }

      /**
       * ⚠ A `code` step read as `outputs.<id>.vars` — the RIGHT first segment,
       * one level short. Measured 2026-09-28 (execution 3FXOKgHtAvUhRao63uo1KR):
       * a chat-built transform wrote `outputs.headcount_csv.vars | jq('… .summary …
       * .filename … .csv_text')`; every field was null (the fields live on
       * `.vars.result`), Kestra dropped the null keys, and the email step sent
       * `attachments: [{}]` — a green transform over an empty payload. The
       * first-segment comparison below cannot see it, because `vars` IS the
       * first segment of `vars.result`.
       */
      for (const m of value.matchAll(CODE_VARS_SHORT_RE)) {
        const [, target] = m;
        if (kindOf.get(target!) !== "code") continue;
        findings.push(
          `step "${who}".${field} reads \`outputs.${target}.vars\`, but "${target}" is a \`code\` step ` +
            `and its returned fields are one level down, at \`outputs.${target}.vars.result\`. Reading ` +
            `\`.vars\` gets every field as null — it compiles and runs, and the step after it ` +
            `receives nothing. Use \`outputs.${target}.vars.result\`.`,
        );
      }

      for (const m of value.matchAll(OUTPUT_REF_RE)) {
        const [, target, segment] = m;
        const kind = kindOf.get(target!);
        // An unknown target is `validateModel`'s problem, not this one — and an
        // pausing step is read through `<id>_await`, which is not a declared id.
        if (!kind) continue;
        const expected = ROOT_SEGMENT[kind];
        if (expected === null) {
          findings.push(
            `step "${who}".${field} reads \`outputs.${target}\`, but "${target}" is an ` +
              `\`approval\` step and produces no output. A gate is a decision, not a value — ` +
              `rejecting it kills the run, so there is no downstream answer to read.`,
          );
          continue;
        }
        if (segment !== expected) {
          findings.push(shapeFinding(who, field, target!, segment!, kind));
        }
      }
    }
  }
  return [...new Set(findings)];
}

/**
 * ⚠ **I-119 — the failure that is GREEN, and the worst one in this file.**
 *
 * A real run: query returns 11 employees, every step succeeds, `engineStatus:
 * success`, and the report reads *"The input does not provide any employee
 * attendance data for period 2026-06."* The model was right. Its `input` was:
 *
 *     json(outputs.fetch.body).results[0].data
 *       | jq('("Generate a concise report for employees with less than 80 percent
 *              attendance for period " + .period + ". Include the evaluated count,
 *              below-threshold count, and a short bullet list …") | @json') | first
 *
 * It reads the upstream step, so it looks wired up. Then the jq program throws
 * every row away and emits a 200-character **instruction** — the drafter wrote a
 * second prompt where the data was supposed to go. `prompt_tokens: 240`.
 *
 * ── Why this is worse than the two issues above it ──────────────────────────
 *
 * I-117 and I-118 fail LOUDLY at execution. This one exits 0. Nothing in the
 * product reports a problem: the tool call succeeded, the step succeeded, the
 * run succeeded, and `complete` recorded `expectations: {evaluated: 0}` because
 * the flow declared none. It is the measured `period="2023-10"` failure — *"…
 * emailed 0 of 11, and still exited 0 with tests_passed=true and audit clean"* —
 * arriving through a different door. On a schedule nobody would ever look.
 *
 * ── ⚠ THE BOUND, and it is a heuristic where the others are decidable ───────
 *
 * I-117's control is decidable: `StepBatchResult`'s keys are fixed, so a key at
 * the top of a body is *guaranteed* wrong. This one is not. "Did the author mean
 * to send this text?" is a question about intent, and the only mechanical grip on
 * it is: **serialising structure into a string in jq requires `tostring` or
 * `tojson`.** So a jq program that emits a long string literal and calls neither
 * has no data in it, whatever it references.
 *
 * Scoped to `llm_complete`'s `input` alone — the one parameter in the catalogue
 * whose documented meaning is *"the text to work on, typically the previous
 * step's output"*. `mail_send`'s `body` legitimately IS assembled prose. Stating
 * what is forbidden rather than a pattern that resembles it is I-62.
 *
 * MIN_INSTRUCTION_LITERAL separates a label from a sentence, and both sides are
 * pinned by tests: *"Attendance report for "* is 22 characters and *"Employees
 * below threshold in "* is 29, while the literal above is 204. 60 sits in the
 * gap with room either way. ⚠ **A number in a control is a liability** — if it
 * has to move, move it because a real expression landed on the wrong side, and
 * add that expression to the tests.
 */
const MIN_INSTRUCTION_LITERAL = 60;

/** `jq('…')` / `jq("…")` — the program, so its literals can be measured. */
const JQ_PROGRAM_RE = /\bjq\(\s*(['"])([\s\S]*?)\1\s*\)/g;

/** A string literal inside a jq program. jq uses double quotes for strings. */
const JQ_STRING_RE = /"((?:[^"\\]|\\.)*)"/g;

/**
 * A `{{ … }}` that is NOT inside a double-quoted JSON string. The complement of
 * `quotedTemplates`, and the only position where piping into `jq` makes sense
 * at all — `@json` supplies its own quotes.
 */
const UNQUOTED_TEMPLATE_RE = /(?<!")\{\{([^{}]*)\}\}(?!")/g;

/**
 * A Pebble path that plucks a LEAF out of `results[0].data` (or `.vars.result`)
 * and then pipes it into `jq`. Group 1 is the plucked path, e.g. `.text` or
 * `.report.text`.
 *
 * Anchored on `results[0].data` deliberately: that is the documented boundary
 * between "the step's envelope", which is always a structure, and "the payload",
 * which may be anything the tool returned.
 */
const PLUCKED_THEN_JQ_RE =
  /(?:json\(\s*outputs\.[A-Za-z_][A-Za-z0-9_]*\.(?:body|value)\s*\)\.results\[0\]\.data|outputs\.[A-Za-z_][A-Za-z0-9_]*\.vars\.result)((?:\.[A-Za-z_][A-Za-z0-9_]*)+)\s*\|\s*jq\(/;

/**
 * Is a leaf plucked in Pebble and then handed to `jq`, which cannot parse it?
 *
 * ── The failure, measured on a real run ──────────────────────────────────────
 *
 * Execution `e097b55b` (2026-08-18), the first real use of `foundry_email_send`.
 * The drafter wrote, for the tool's `body` parameter:
 *
 *   {{ json(outputs.report_text.body).results[0].data.text | jq('tostring | @json') | first }}
 *
 * `results[0].data` is an object, so `.data.text` is the LLM's report — a plain
 * String. Kestra's `jq` filter parses its input **as JSON**, so handed a raw
 * multi-line String it throws:
 *
 *   PebbleException: Unable to parse jq value 'Attendance report for 2026-06 …'
 *   with type 'java.lang.String'
 *
 * ⚠ **The step never made an HTTP request** — `responseCode: null`, `request:
 * null`. So the failure looks like nothing at all from the tool's side: no call,
 * no log row, no evidence anywhere that an email was even attempted. The message
 * names a template line and a character type; it names no step, no parameter and
 * no fix. And the step immediately ABOVE the broken one uses the identical idiom
 * and works, because there the value is still an object — which is precisely why
 * this is invisible to a careful reader.
 *
 * ── Why it is a separate check ───────────────────────────────────────────────
 *
 * `checkJsonPositions` is deliberately narrow about the OPPOSITE case: a whole
 * output read inside quotes. Its docblock states *"a scalar plucked out of one
 * belongs in quotes and must not be reported"*, and that remains true. This is
 * the inverse — a plucked leaf, **unquoted**, piped into `jq`. Widening the
 * existing check would have made it report the quoted form it exists to permit.
 *
 * ── Why a static check is honest here ────────────────────────────────────────
 *
 * Nothing can know statically whether `.data.text` is a String or an object. It
 * does not need to: the advice — move the selection **inside** jq — is correct
 * either way, and strictly safer.
 *
 *   {{ json(outputs.report_text.body).results[0].data | jq('.text | @json') | first }}
 *
 * jq then receives the JSON-parseable object and selects the field itself. If the
 * leaf was already a structure, this is equivalent; if it was a scalar, it is the
 * difference between a delivered email and a run that failed rendering.
 *
 * ⚠ Only the **unquoted** position is flagged. `"{{ …data[0].email }}"` in quotes
 * is the documented form for a scalar and must stay silent.
 */
export function checkPluckedThenJq(steps: Array<Record<string, unknown>>): string[] {
  const findings: string[] = [];
  for (const step of steps) {
    const who = typeof step.id === "string" ? step.id : "<unnamed step>";
    for (const field of EXPR_FIELDS) {
      const value = step[field];
      if (typeof value !== "string") continue;
      for (const m of value.matchAll(UNQUOTED_TEMPLATE_RE)) {
        const expr = m[1] ?? "";
        const hit = PLUCKED_THEN_JQ_RE.exec(expr);
        if (!hit) continue;
        const plucked = hit[1] ?? "";
        findings.push(
          `step "${who}".${field} selects \`${plucked}\` in the template and then pipes it ` +
            `into \`jq\`. Kestra's \`jq\` filter parses its input as JSON, so if \`${plucked}\` ` +
            `is text (an LLM's answer, a generated report) it fails at render time with ` +
            `"Unable to parse jq value … with type 'java.lang.String'" and the step never runs ` +
            `at all. Move the selection INSIDE jq, which receives the whole object and can ` +
            `select from it: \`| jq('${plucked} | @json') | first\`.`,
        );
      }
    }
  }
  return [...new Set(findings)];
}
/**
 * Is opaque TEXT piped straight into `jq`, which can only parse JSON?
 *
 * ── The failure, measured on a real run ──────────────────────────────────────
 *
 * Kestra's `jq` filter parses its input **as JSON**, so handed a raw String it
 * throws:
 *
 *   PebbleException: Unable to parse jq value '…'
 *   with type 'java.lang.String'
 *
 * ⚠ **The step never runs at all** — the render fails before any call, so the
 * failure looks like nothing from the tool's side: no call, no log row, no
 * evidence anywhere that the step was even attempted. The message names a
 * template line and a character type; it names no step, no parameter and no fix.
 *
 * ── Why this is not `checkPluckedThenJq` ─────────────────────────────────────
 *
 * That check reads UNQUOTED positions only — `"{{ … }}"` in quotes is the
 * documented form for a scalar and must stay silent there. But a TEXT `.value`
 * piped into `jq` is broken quoted AND unquoted: the quotes decide the JSON the
 * template renders into, while `jq` chokes one level earlier, on its input. So
 * this check reads `templateSpans` over `paramsExpr` QUOTED INCLUDED — the known
 * blind spot of the unquoted-only check — and fires in both positions.
 *
 * ── Why only `paramsExpr`, and only the first jq program ─────────────────────
 *
 * A transform's `expr` legitimately filters a `.value` through `jq`
 * (`{{ outputs.fetch.value | jq('[.[] | select(.rate < 80)]') | first }}` is the
 * sanctioned filter form); scanning `expr` would refuse the very remedy the
 * text/bulk checks prescribe. And only the FIRST `jq` program reads the raw
 * `.value` — a later one reads JSON the earlier one produced, which parses.
 *
 * ── Why an encoder with no descent ───────────────────────────────────────────
 *
 * Every legitimate in-repo `.value | jq(…)` DESCENDS — `.[]`, `.calls`, `.rate`:
 * it selects structure out of something JSON-parseable. A program that only
 * ENCODES (`@json`, `tostring`, `tojson`) with no `/\.[A-Za-z_]/` field descent
 * outside its string literals selects nothing — it feeds opaque text to a JSON
 * parser. The descent is measured outside string literals so a `"tostring"` in a
 * message does not count as either side.
 *
 * ── Kind-blind by design ─────────────────────────────────────────────────────
 *
 * Whether `.value` holds opaque prose or JSON text is a property of the DATA,
 * not of the step's kind or ref — a transform's `.value` can be either — so no
 * kind/ref gate could be correct. The check fires on the expression shape for
 * any kind, and the remedy is safe either way: single-line text drops the pipe
 * (`"text":"{{ outputs.X.value }}"` renders identically), and multi-line text
 * moves the selection inside `jq` over the structured upstream step, the way the
 * showcase posts `json(outputs.message.value).calls | jq('[.[] | {...}]')`
 * (`ANNOUNCE_PARAMS_EXPR`, `DIGEST_POST_EXPR`) read the structure and let `jq`
 * do the selecting.
 */
const TEXT_VALUE_THEN_JQ_RE = /outputs\.([A-Za-z_][A-Za-z0-9_]*)\.value\s*\|\s*jq\(/;

/** A jq encoder — serialises its input into text rather than selecting from it. */
const JQ_TEXT_ENCODER_RE = /@json|\btostring\b|\btojson\b/;

/** Field descent — `.name`, `.rate` — measured outside the program's literals. */
const JQ_FIELD_DESCENT_RE = /\.[A-Za-z_]/;

export function checkTextValueThenJq(steps: Array<Record<string, unknown>>): string[] {
  const findings: string[] = [];
  for (const step of steps) {
    const who = typeof step.id === "string" ? step.id : "<unnamed step>";
    const params = step.paramsExpr;
    if (typeof params !== "string") continue;
    for (const span of templateSpans(params)) {
      const boundary = TEXT_VALUE_THEN_JQ_RE.exec(span.body);
      if (!boundary) continue;
      const source = boundary[1] ?? "";
      // The first program is the one fed the raw `.value`; later ones read JSON.
      const first = span.body.matchAll(JQ_PROGRAM_RE).next().value?.[2] ?? "";
      // Measured outside the program's literals, so a `"tostring"` inside a
      // message counts as neither encoding nor descending.
      const bare = first.replace(JQ_STRING_RE, '""');
      if (!JQ_TEXT_ENCODER_RE.test(bare)) continue;
      if (JQ_FIELD_DESCENT_RE.test(bare)) continue;
      const key = /"([^"]+)"\s*:\s*"$/.exec(params.slice(0, span.start))?.[1];
      const named = key ? `\`"${key}"\`` : "a parameter";
      findings.push(
        `step "${who}".paramsExpr pipes \`outputs.${source}.value\` straight into \`jq('${first.trim()}')\` for ${named}. ` +
          `Kestra's \`jq\` filter parses its input as JSON, so if that \`.value\` is text it fails at render time with ` +
          `"Unable to parse jq value … with type 'java.lang.String'" and the step never runs ` +
          `at all. If the text is single-line, drop the pipe: \`"${key ?? "text"}":"{{ outputs.${source}.value }}"\`. ` +
          `If it is multi-line, select from the structured upstream step inside \`jq\` instead — the showcase posts ` +
          `\`json(outputs.message.value).calls | jq('[.[] | {...}]')\` (ANNOUNCE_PARAMS_EXPR, DIGEST_POST_EXPR), never a text \`.value\` through \`jq\`.`,
      );
    }
  }
  return [...new Set(findings)];
}

/**
 * The leaves of an `llm_complete` result that are FREE TEXT, and therefore certain
 * to contain newlines.
 *
 * ⚠ Deliberately a short list, not "every leaf". `.model`, `.finish_reason`,
 * `.chars` and `.latency_ms` are single-line and belong in quotes like any other
 * scalar — flagging them would make this check about `llm_complete` rather than
 * about newlines, and the false positives would get it reverted.
 */
const FREE_TEXT_LEAVES = new Set(["text", "note"]);

/**
 * A quoted `{{ … }}` that plucks a leaf. Group 1 is the source step id, group 2
 * the plucked path.
 */
const QUOTED_PLUCK_RE =
  /"[^"]*\{\{\s*json\(\s*outputs\.([A-Za-z_][A-Za-z0-9_]*)\.(?:body|value)\s*\)\.results\[0\]\.data((?:\.[A-Za-z_][A-Za-z0-9_]*)+)\s*\}\}[^"]*"/g;

/**
 * Is a model's prose being interpolated into a quoted JSON string?
 *
 * ── The failure, measured on a real run ──────────────────────────────────────
 *
 * Execution `fa04cfc3` (2026-08-18) — the **second** draft of the same automation,
 * generated after `checkPluckedThenJq` and its prompt rule had already shipped.
 * The drafter avoided the shape that rule forbids and took the adjacent one:
 *
 *   "body":"{{ json(outputs.report.body).results[0].data.text }}"
 *
 * The leaf is plucked in Pebble and placed INSIDE quotes with no encoding. Its
 * value is the model's report, which contains newlines, so Kestra threw:
 *
 *   JsonParseException: Illegal unquoted character ((CTRL-CHAR, code 10)):
 *   has to be escaped using backslash to be included in string value
 *
 * ⚠ Again the step made **no HTTP request** — so, again, nothing anywhere reported
 * an email problem and no `email_sends` row existed. Two different rendering
 * failures, one invisible symptom.
 *
 * ── Why the two existing checks both let it through ──────────────────────────
 *
 * This is the form `checkJsonPositions` **exists to permit**: *"a scalar plucked
 * out of one belongs in quotes and must not be reported"*. That is true of an
 * address, a period or a count. It is false of model prose — the one leaf that is
 * certain to contain a newline. `checkPluckedThenJq` skips quoted positions for the
 * same stated reason.
 *
 * So the blind spot was shared, and the correction is narrow: not "a plucked scalar
 * in quotes" but "a FREE-TEXT leaf in quotes". Widening either existing check would
 * have made it report the forms they are written to allow.
 *
 * ── ⚠ A lesson about the prompt, recorded because it cost a run ─────────────
 *
 * `checkPluckedThenJq`'s prompt rule told the model what NOT to do and left the
 * positive form implicit. The very next draft took the other wrong shape. A rule
 * that forbids one of two adjacent mistakes moves the model to the other one; the
 * prompt now leads with the correct expression and names both wrong forms under it.
 */
export function checkFreeTextInQuotes(steps: Array<Record<string, unknown>>): string[] {
  const refById = new Map<string, string>();
  for (const step of steps) {
    if (typeof step.id === "string" && typeof step.ref === "string") {
      refById.set(step.id, step.ref);
    }
  }

  const findings: string[] = [];
  for (const step of steps) {
    const who = typeof step.id === "string" ? step.id : "<unnamed step>";
    for (const field of EXPR_FIELDS) {
      const value = step[field];
      if (typeof value !== "string") continue;
      for (const m of value.matchAll(QUOTED_PLUCK_RE)) {
        const sourceId = m[1] ?? "";
        const plucked = m[2] ?? "";
        // An unknown source is `validateModel`'s problem — guessing here would
        // make two checks disagree about the same step.
        if (refById.get(sourceId) !== "llm_complete") continue;
        const leaf = plucked.slice(plucked.lastIndexOf(".") + 1);
        if (!FREE_TEXT_LEAVES.has(leaf)) continue;

        findings.push(
          `step "${who}".${field} puts \`${plucked}\` from the \`llm_complete\` step ` +
            `"${sourceId}" inside a quoted JSON string. That value is model prose and contains ` +
            `newlines, so the rendered body is not valid JSON — Kestra fails with "Illegal ` +
            `unquoted character (CTRL-CHAR, code 10)" and the step never runs at all. Encode it ` +
            `and drop the quotes, because @json supplies its own: ` +
            `\`{{ json(outputs.${sourceId}.body).results[0].data | jq('${plucked} | @json') | first }}\`.`,
        );
      }
    }
  }
  return [...new Set(findings)];
}

/**
 * A call's typed binding for one parameter (phase 3 step 3) — the `inputs`
 * form the drafter is taught, where `paramsExpr` is blank. Both text-tool
 * guards read it as well as the string, or they go silent on exactly the
 * flows the drafter now writes.
 */
function typedBinding(step: Record<string, unknown>, name: string): { from?: string; stepId?: string; value?: unknown } | null {
  if (typeof step.paramsExpr === "string" && step.paramsExpr.trim()) return null; // the string wins
  const inputs = Array.isArray(step.inputs) ? (step.inputs as Array<{ name?: unknown; source?: unknown }>) : [];
  const b = inputs.find((x) => x.name === name);
  return b && b.source && typeof b.source === "object" ? (b.source as { from?: string; stepId?: string; value?: unknown }) : null;
}

export function checkTextToolInput(steps: Array<Record<string, unknown>>): string[] {
  const findings: string[] = [];

  for (const step of steps) {
    if (step.kind !== "tool" || step.ref !== "llm_complete") continue;
    const who = typeof step.id === "string" ? step.id : "<unnamed step>";
    const typed = typedBinding(step, "input");
    if (typed?.from === "literal" && typeof typed.value === "string" && !typed.value.includes("{{") && typed.value.length >= MIN_INSTRUCTION_LITERAL) {
      findings.push(
        `step "${who}" binds \`input\` to a ${typed.value.length}-character sentence, so the model receives a ` +
          `DESCRIPTION of the rows instead of the rows. That run SUCCEEDS and the report says there was no ` +
          `data. Bind \`input\` to the data — {"from":"whole","stepId":"<a transform that keeps only the rows ` +
          `and columns the report names>","transform":"text"} — and put the English in \`instruction\`.`,
      );
    }
    const params = step.paramsExpr;
    if (typeof params !== "string") continue;

    /**
     * ⚠ The span is located through `templateSpans`, never by a regex of our
     * own. A `{{ … }}` found with a non-greedy `}}` closes at the first one — and
     * a jq program building an object ends in exactly that (I-57). Here the
     * consequence would be reading a truncated program and measuring the wrong
     * literal, so the check would report on text the engine never sees.
     */
    for (const span of templateSpans(params)) {
      const before = params.slice(0, span.start);
      // The span that produces `input`: the nearest preceding key is `"input"`,
      // with only `:` and whitespace between it and the `{{`.
      if (!/"input"\s*:\s*$/.test(before)) continue;

      for (const prog of span.body.matchAll(JQ_PROGRAM_RE)) {
        const program = prog[2] ?? "";
        // `tostring`/`tojson` are the only ways jq turns structure into text, so
        // their presence means the data is in there somewhere. Deliberately not
        // "does it reference a field" — `.period` is a field and carries nothing.
        if (/\b(tostring|tojson)\b/.test(program)) continue;

        const longest = [...program.matchAll(JQ_STRING_RE)]
          .map((m) => m[1] ?? "")
          .reduce((a, b) => (b.length > a.length ? b : a), "");
        if (longest.length < MIN_INSTRUCTION_LITERAL) continue;

        findings.push(
          `step "${who}".paramsExpr builds \`input\` out of a ${longest.length}-character ` +
            `sentence and never serialises the upstream data, so the model receives a ` +
            `DESCRIPTION of the rows instead of the rows. That run SUCCEEDS and the report ` +
            `says there was no data. \`input\` is the text to work on — pass the data itself, ` +
            `PROJECTED to the rows and columns the report actually names: ` +
            `\`| jq('map({name, rate}) | tostring | @json') | first\`. ` +
            // ⚠ T10 — the remedy used to end at `jq('tostring | @json')`, which is
            // exactly what `checkBulkToolInput` now refuses. Two checks whose
            // remedies are each other's findings is a loop, and a model in it
            // burns a redraft per turn, so the projected form is named here and
            // the unbounded one is named as the adjacent mistake.
            `Serialising the WHOLE response instead is the adjacent mistake: \`input\` accepts ` +
            `32,000 characters and a tool response is bounded by nothing, so that version works ` +
            `or fails depending on how much the endpoint returns. ` +
            `Put the English in \`instruction\`, which is the parameter for it.`,
        );
      }
    }
  }

  return [...new Set(findings)];
}

/**
 * The jq operations that can make the output SMALLER than what came in.
 *
 * ⚠ **This list is the check's escape hatch, and every addition WEAKENS the
 * check** — a program containing any of these is treated as "the drafter has
 * narrowed the data" and `checkBulkToolInput` goes silent on it. That is why it
 * is a named constant with this note rather than an alternation buried in a
 * regex: the next person to extend it should have to read this sentence first.
 *
 * The rule for membership is *"can this operation return less than it was
 * given?"* — not *"is it a jq builtin someone might reasonably write"*:
 *
 * · `map`/`map_values`/`select`/`with_entries`/`del`/`pick` — projection or
 *   filtering, which is the remedy this check exists to ask for.
 * · `group_by`/`unique`/`unique_by`/`add`/`length`/`min`/`max`/`min_by`/`max_by`/
 *   `reduce`/`any`/`all`/`keys` — aggregates. A count or a total is bounded no
 *   matter how large the input is.
 * · `limit`/`first`/`last` — truncation.
 *
 * ⚠ **`sort`, `sort_by`, `reverse`, `flatten`, `to_entries` and `tostring` are
 * deliberately ABSENT.** Every one of them returns exactly as much data as it
 * received; a program that only sorts 4,722 rows still sends 4,722 rows. Adding
 * one of them here would not "reduce false positives", it would silence the check
 * on the precise shape it was written for.
 */
const JQ_REDUCING_OPS = [
  "map",
  "map_values",
  "select",
  "with_entries",
  "del",
  "pick",
  "group_by",
  "unique",
  "unique_by",
  "add",
  "length",
  "min",
  "max",
  "min_by",
  "max_by",
  "reduce",
  "any",
  "all",
  "keys",
  "limit",
  "first",
  "last",
] as const;

/**
 * Any of the above as a whole word.
 *
 * ⚠ Matched against the jq PROGRAM text only, never against the surrounding
 * Pebble expression — which matters for `first`, because the trailing `| first`
 * outside `jq(…)` is the engine's own unwrap and is present in every correct
 * expression in the repo. Reading it as a reduction would silence this check
 * everywhere (I-38: a control that cannot fail).
 */
const JQ_REDUCING_RE = new RegExp(`\\b(?:${JQ_REDUCING_OPS.join("|")})\\b`);

/**
 * A slice or an index — `.[0:50]`, `.[0]`, `.[-1]`, `.[:100]`. Truncation
 * written as syntax rather than as a named builtin, so it needs its own pattern.
 */
const JQ_SLICE_OR_INDEX_RE = /\.\[\s*-?\d*\s*(?::\s*-?\d*\s*)?\]/;

/**
 * Object construction — `{name, rate}`, `{n: .full_name}`. A projection with no
 * builtin in it, and the literal form the remedy text asks for, so it has to
 * count as a reduction or the check would fire on its own advice.
 *
 * ⚠ It can be written so that it reduces nothing (`{all: .}`), and that case is
 * accepted as a miss. A false positive on the recommended form would get this
 * check reverted; a contrived pass-through does no harm beyond staying quiet.
 */
const JQ_OBJECT_CONSTRUCTION_RE = /\{/;

/**
 * The step-callback envelope read WHOLE — no leaf plucked, straight into `jq`.
 * Group 1 is the source step id.
 *
 * ⚠ **`.vars.result` and a bare `.value` are deliberately NOT matched, and that
 * is the load-bearing part of this pattern.** Those are a `code` step's and a
 * `transform` step's outputs — the two remedies this check's finding asks for. A
 * pattern that covered them would fire on exactly the flow the finding tells the
 * drafter to write, and the second draft would look like the first with an extra
 * step and the same complaint. What IS matched is `.results[0].data`, the
 * envelope of a `tool`, `datasource` or `query` step: three sources whose size
 * is decided by an endpoint or a table rather than by anything in the flow.
 */
const WHOLE_PAYLOAD_THEN_JQ_RE =
  /json\(\s*outputs\.([A-Za-z_][A-Za-z0-9_]*)\.(?:body|value)\s*\)\.results\[0\]\.data\s*\|\s*jq\(/;

/**
 * Is an `llm_complete` step's `input` bound to a WHOLE upstream response and
 * serialised, with nothing between the endpoint and the model?
 *
 * ── The failure, measured on a real run ──────────────────────────────────────
 *
 * Execution `05aca859` (2026-08-19), flow `attendance_report_email_2`. The
 * drafter wrote, for `llm_complete`'s `input`:
 *
 *   {{ json(outputs.fetch.body).results[0].data | jq('tostring | @json') | first }}
 *
 * `fetch` called an attendance endpoint with no filter registered, so it returned
 * **4,722 rows / 7.19 MiB** where the report asked for one month. The step
 * callback carrying it was 8,401,233 bytes, the transport refused it, and the run
 * failed with four words about a request entity.
 *
 * ⚠ **The expression is not wrong. It is unbounded**, which is worse, because it
 * works. The same flow passes on a small month and fails on a large one, and
 * nothing in the model says which it will be — the size is decided by an endpoint
 * nobody in this flow controls. `llm_complete` publishes a ceiling of
 * `OPS_LLM_MAX_INPUT_CHARS` (32,000) characters, and 7,539,026 characters is
 * ≈1.9M tokens: past every model this gateway serves, so no cap anywhere makes
 * this expression correct.
 *
 * ── Why it is a separate check, and the corridor it closes ───────────────────
 *
 * `checkTextToolInput` (I-119) refuses the OTHER side of the same mistake: an
 * `input` that describes the rows in a sentence instead of carrying them. Its
 * remedy used to recommend `| jq('tostring | @json') | first` — precisely the
 * expression above. **Two checks whose remedies are each other's findings is a
 * loop**, and a model in it burns a redraft per turn, so the two are edited
 * together and tested together (contract §4's corridor table):
 *
 *   a 204-char sentence, no `tostring`            → checkTextToolInput fires
 *   the whole payload, serialised                  → this check fires
 *   projected AND serialised                       → both silent  ← the contract
 *   a leaf plucked, then jq                        → checkPluckedThenJq's case
 *
 * ⚠ Row 3 is what makes this pair legitimate rather than a trap. If a future
 * narrowing makes it fire from either side, there is no expression a drafter can
 * write, and the right response is to widen this check's reducing set rather than
 * to argue about which finding is more important.
 *
 * ── Why only `llm_complete`, and only `input` ────────────────────────────────
 *
 * Because that is the only parameter in the product with a PUBLISHED ceiling, so
 * it is the only one where "this is too much data" is decidable statically rather
 * than guessed (plan Decision 5). A `mail_send` body is bounded too but is
 * legitimately assembled prose; a tool's own parameters are bounded by whatever
 * the endpoint accepts, which nothing here knows. Widening this check to every
 * tool parameter would make it fire on correct flows, and a check that fires on
 * correct flows gets widened until it fires on nothing.
 */
export function checkBulkToolInput(steps: Array<Record<string, unknown>>): string[] {
  const findings: string[] = [];

  for (const step of steps) {
    if (step.kind !== "tool" || step.ref !== "llm_complete") continue;
    const who = typeof step.id === "string" ? step.id : "<unnamed step>";
    // Typed: `input` is the WHOLE output of a raw call — a response bounded by
    // nothing. A transform's or a code step's whole output was reduced IN A
    // STEP, which is this check's own remedy, so it is silent there.
    const typed = typedBinding(step, "input");
    if (typed?.from === "whole" && typed.stepId) {
      const up = steps.find((x) => x.id === typed.stepId);
      if (up && (up.kind === "tool" || up.kind === "datasource" || up.kind === "query")) {
        findings.push(
          `step "${who}" binds \`input\` to the entire response of "${typed.stepId}", with no filtering or ` +
            `projection. \`llm_complete\` accepts 32,000 characters and a response is bounded by nothing, so ` +
            `this works or fails depending on how much it returns — execution 05aca859 sent 8,010,000 ` +
            `characters and the run failed. Add a \`transform\` from "${typed.stepId}" that keeps only the ` +
            `rows and columns the report names and bind \`input\` to ITS whole output as text; for counts, ` +
            `totals or rankings use a \`code\` step instead.`,
        );
      }
    }
    const params = step.paramsExpr;
    if (typeof params !== "string") continue;

    // ⚠ Spans from `templateSpans`, never a regex of our own — a jq program that
    // builds an object ends in `}}` and a non-greedy pattern closes on it (I-57).
    for (const span of templateSpans(params)) {
      const before = params.slice(0, span.start);
      if (!/"input"\s*:\s*$/.test(before)) continue;

      const boundary = WHOLE_PAYLOAD_THEN_JQ_RE.exec(span.body);
      if (!boundary) continue;
      const source = boundary[1] ?? "";

      for (const prog of span.body.matchAll(JQ_PROGRAM_RE)) {
        const program = prog[2] ?? "";
        // Serialisation is what turns the structure into the characters the
        // ceiling counts. Without it there is no data in there at all, which is
        // `checkTextToolInput`'s finding and not this one's.
        if (!/\b(tostring|tojson)\b/.test(program)) continue;
        if (
          JQ_REDUCING_RE.test(program) ||
          JQ_SLICE_OR_INDEX_RE.test(program) ||
          JQ_OBJECT_CONSTRUCTION_RE.test(program)
        ) {
          continue;
        }

        findings.push(
          `step "${who}".paramsExpr binds \`input\` to the entire response of "${source}" and ` +
            `serialises it whole, with no filtering or projection. \`llm_complete\` accepts ` +
            `32,000 characters and a tool response is bounded by nothing, so this works or ` +
            `fails depending on how much the endpoint happens to return — execution 05aca859 ` +
            `sent 8,010,000 characters and the run failed. If the report needs fewer rows or ` +
            `columns of the same shape, add a \`transform\` step that keeps only the rows and ` +
            `columns the report names, and pass the transform's output to \`input\`. If it ` +
            `needs counts, totals, rankings or per-group figures, add a \`code\` step whose ` +
            `Python computes those figures and pass its small output to \`input\` — arithmetic ` +
            `is not the model's job.`,
        );
      }
    }
  }

  return [...new Set(findings)];
}

/**
 * A jq program whose FINAL filter is the `@json` encoder.
 *
 * Anchored at the end deliberately. `@json` in the middle of a program —
 * `jq('map(@json) | join(",")')` — produces something else entirely and the
 * value is not self-quoting; only the encoder that runs LAST decides the shape
 * of what comes out.
 */
const JQ_ENDS_IN_JSON_ENCODER_RE = /@json\s*$/;

/**
 * Is an expression whose value ALREADY carries its own quotes sitting in a
 * position that adds another pair?
 *
 * ── The failure, measured on a real run ──────────────────────────────────────
 *
 * Execution `a6488641` (2026-08-19), the `report` step of a three-step
 * attendance automation. The drafter wrote, for `llm_complete`'s `input`:
 *
 *   "input":"{{ json(outputs.fetch.body).results[0].data | jq('tostring | @json') | first }}"
 *
 * ⚠ **That is `DRAFT_RULES`' own prescribed expression with the quotes left on.**
 * `| first` unwraps a jq string into raw text, so `@json` is there to put the
 * quotes back — as `ApprovalStep.summaryExpr`'s docblock spells out. Quoting the
 * result gives it two pairs, and the rendered body opens with an empty string:
 *
 *   "input":""{\"period\":\"2026-06\",\"counts\":{…
 *            ↑↑ closed, and the object then starts where a comma must go
 *
 * `POST /api/steps/tool` answered **400** — correctly; the body is not JSON.
 *
 * ⚠ **And Foundry's explanation never reached the log.** Kestra's failure path
 * (`HttpResponseFailure.exception` → `HttpRequest$RequestBody.from` →
 * `JacksonMapper.toObject`) re-parses the REQUEST body to attach it to the
 * exception, and that body is the malformed JSON — so it threw while building the
 * failure and printed `JsonParseException: Unexpected character ('{' (code 123)):
 * was expecting comma to separate Object entries … line: 6, column: 17` over the
 * top of the 400's message. The stack trace is about the request Kestra sent, and
 * it names no step, no parameter and no reason. Reproduced byte-for-byte against
 * that run's own `fetch` output: line 6, column 17.
 *
 * ── Why all five of the checks above let it through ─────────────────────────
 *
 * This is the INVERSE of `checkJsonPositions`, and the difference is one word.
 * That check catches an UNENCODED structure in quotes; this catches an ALREADY
 * ENCODED one. Concretely:
 *
 *   · `checkJsonPositions`  — `WHOLE_OUTPUT_RE` is anchored at both ends, so the
 *      `| jq(…) | first` tail means no match. Correct: this is not a raw
 *      structure interpolation.
 *   · `checkPluckedThenJq`  — reads unquoted positions only, and wants a leaf
 *      plucked before `| jq(`. Here `.data` itself is piped, which is the right
 *      thing to do.
 *   · `checkFreeTextInQuotes` — its `QUOTED_PLUCK_RE` requires a bare pluck and
 *      closes at `}}`, so a pipeline never matches.
 *   · `checkTextToolInput`   — sees `tostring` in the program and returns early,
 *      because the data IS being serialised. It is; it is then double-quoted.
 *   · `checkOutputShapes`    — the first segment is `body`, which is right.
 *
 * So the blind spot was shared by all five, and it is the closest possible
 * near-miss: every check agreed the expression reads the right data the right
 * way, and none of them looked at the two characters around it.
 *
 * ── Narrow on purpose, in two ways ──────────────────────────────────────────
 *
 * ⚠ Only a template **immediately** wrapped in quotes is flagged — `"{{ … }}"`,
 * nothing else between the quotes. An `@json` value spliced into a longer string
 * (`"Report: {{ … }}"`) is also wrong, but locating the string's real boundaries
 * needs a JSON parse of a template that is not yet valid JSON, and a guess there
 * would report on text the engine never sees. The measured shape is the whole
 * quoted value, which is also the only shape `DRAFT_RULES` prescribes.
 *
 * ⚠ The spans come from `templateSpans`, never from a regex of this module's own
 * — I-57, and `checkTextToolInput`'s docblock states the same reason: a jq
 * program building an object supplies its own `}}`, so a non-greedy match reads a
 * truncated program. Here it would measure the wrong final filter.
 */
export function checkEncodedInQuotes(steps: Array<Record<string, unknown>>): string[] {
  const findings: string[] = [];
  for (const step of steps) {
    const who = typeof step.id === "string" ? step.id : "<unnamed step>";
    for (const field of EXPR_FIELDS) {
      const value = step[field];
      if (typeof value !== "string") continue;

      for (const span of templateSpans(value)) {
        // Immediately wrapped: the character before `{{` and after `}}` are both
        // the double quote that will add the second pair.
        if (value[span.start - 1] !== '"') continue;
        if (value[span.start + span.raw.length] !== '"') continue;

        /**
         * The LAST jq program decides the shape. A pipeline may hold several —
         * `| jq('a') | jq('b | @json')` — and only the final one's trailing
         * filter says whether the value arrives with quotes on it.
         */
        const programs = [...span.body.matchAll(JQ_PROGRAM_RE)].map((m) => m[2] ?? "");
        if (programs.length === 0) continue;
        if (!JQ_ENDS_IN_JSON_ENCODER_RE.test(programs[programs.length - 1]!.trim())) continue;

        // The parameter this lands in, when the quoted value follows a key — so
        // the finding names the field a person is looking at. `checkTextToolInput`
        // locates `"input"` the same way.
        const key = /"([^"]+)"\s*:\s*"$/.exec(value.slice(0, span.start))?.[1];
        const named = key ? `\`"${key}"\`` : "a quoted JSON string";

        findings.push(
          `step "${who}".${field} puts ${named} in quotes, around an expression whose jq ` +
            `program ends in \`@json\`. \`| first\` unwraps a jq string into raw text and ` +
            `\`@json\` is what puts the quotes back, so the value already carries them — the ` +
            `surrounding pair makes two, and the rendered body opens with an empty string ` +
            `(\`""{…\`). It is invalid JSON at that point, so the step fails with "Unexpected ` +
            `character ('{'): was expecting comma to separate Object entries" and never makes ` +
            `its call. Drop the surrounding quotes: ` +
            `\`${key ? `"${key}": ` : ""}${span.raw}\`.`,
        );
      }
    }
  }
  return [...new Set(findings)];
}
