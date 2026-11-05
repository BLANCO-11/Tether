import crypto from "node:crypto";
import {
  NODE_TYPES,
  buildApprovalSummary,
  buildCodeInput,
  buildCondition,
  buildFanOutParams,
  buildSingleParams,
  checkCodeInputExpr,
  normaliseModel,
  rowsExpr,
  type AuthoredStep,
  type BranchTest,
  type CodeInputValue,
  type InputBinding,
  type ItemPredicate,
  type Mapping,
  type OutputShapes as RenderShapes,
  type Source,
  type VariableType,
  allResultsRows,
} from "@foundry/flow-edit";
import { OUTPUT_SHAPES } from "./flow-output-shape.js";
import { stepNamesRead } from "./flow-input-refs.js";
import { namesManifestRef } from "./sql-projection.js";
import { config } from "../config/index.js";
import type { NamespaceRef } from "./kestra-client.service.js";
// Type-only, so no runtime cycle: the expectation vocabulary lives with the
// code that evaluates it, and the compiler only needs to carry it through.
import type { FlowExpectation } from "./flow-expectation.service.js";

/**
 * Foundry flow model → Kestra YAML. **The only YAML emitter in the system (R8).**
 * archive/kestra-migration/02-rules.md R8 · 07 §7.2 · 05 §6.5
 *
 * ── Why this exists in Phase 3, when the plan puts it in Phase 5 ─────────────
 *
 * 08 §10 schedules the compiler with client authoring, and that ordering is
 * right for the *untrusted-input* half of its job. But Phase 3's exit criterion
 * cannot be met without the emitter itself:
 *
 *   * A Kestra Schedule trigger is part of the FLOW DEFINITION, not a separate
 *     API object. "Approval deploys the trigger, revocation removes it" (§5.4)
 *     therefore means the live YAML and the draft YAML differ — the same model
 *     compiled twice, once with a `triggers:` block and once without. There is
 *     no way to do that by storing one YAML blob per revision except string
 *     surgery, which is precisely the ad-hoc emission R8 forbids.
 *   * Approval binds to a REVISION, so promotion has to deploy that revision's
 *     content. Something must turn a stored revision into deployable YAML.
 *
 * So the emitter lands here. What stays in Phase 5 is everything that assumes
 * the model came from somewhere untrusted: `flow-validator.service.ts` with its
 * LLM-consumable findings, the redraft loop, and the caps. See DECISIONS.md D-16
 * for the boundary, and READ THAT BEFORE accepting a model over a client-facing
 * route — `expr` fields are opaque to this compiler on purpose.
 *
 * ── What makes the output safe ───────────────────────────────────────────────
 *
 * Not a blocklist. Three structural properties:
 *
 *  1. **Task types are chosen here, from a fixed set.** Nothing in a model names
 *     a Kestra task type, so no model can introduce one. That is R8 in one line.
 *  2. **Every URI is built from `config.kestra.foundryUrl`.** A model cannot
 *     name a host, so the network allowlist of exactly one host holds even if a
 *     model is hostile.
 *  3. **Free-text expressions are re-indented into a block scalar**, so an
 *     expression cannot terminate its own scalar and inject a sibling key. This
 *     is why there is no "does it contain `type:`" check — that check would be
 *     the weaker version of the thing re-indentation makes impossible.
 */

// ── The model ────────────────────────────────────────────────────────────────

export type FlowInputType = "STRING" | "INT" | "FLOAT" | "BOOLEAN" | "DATE" | "DATETIME";

/**
 * A value derived from the run's firing time, resolved by the ENGINE at run
 * creation — the only way an unattended run can supply a required input.
 *
 * Closed on purpose: six derivations cover the calendar cases (last/this
 * month, yesterday/today, this year, the run's own timestamp) and each is one
 * measured Pebble expression (see `computedInputExpression`). A free-form
 * expression field would be author-controlled text reaching the YAML — the
 * thing the step-expression allowlist exists to prevent — so there is not one.
 */
export type ComputedInputFn = "priorMonth" | "currentMonth" | "priorDate" | "currentDate" | "currentYear" | "runTimestamp" | "currentMonthStart" | "priorMonthStart";

export interface FlowInput {
  id: string;
  type: FlowInputType;
  /** Rendered as a YAML string; Kestra coerces per `type`. */
  defaults?: string;
  /**
   * Mutually exclusive with `defaults`: an input has one answer — a value, or
   * a value derived from the run's firing time. Enforced by `flowModelSchema`
   * and by `applyInputValues`, which clears the other side on every write.
   */
  computed?: ComputedInputFn;
  /** Slice 5d: whole days added to a computed `currentDate` (negative = before the day it runs). Only with `currentDate`. */
  offsetDays?: number;
  required?: boolean;
  /**
   * A STRING input's shape (phase 5, D-255) — `month` is `YYYY-MM`. Kestra has
   * no MONTH type, so like `label` it rides the MODEL and is not emitted; the
   * checker types the input `Month` and the run routes validate against it.
   */
  format?: "month";
  /**
   * What a PERSON is asked for, and why. Presentation only — see
   * `flowModelSchema`'s note for the reasoning.
   *
   * ⚠ **Deliberately NOT emitted into the YAML.** Kestra's input declaration
   * has no field for either, so writing them would be inventing a key the
   * engine ignores; and they are read by the browser, which never sees the
   * compiled flow. They ride the MODEL, which is where every other thing a
   * screen renders already lives.
   */
  label?: string;
  description?: string;
}

/**
 * The step kinds this compiler will emit.
 *
 * `approval` is gate 3.
 * `notify` is still deliberately ABSENT rather than stubbed: an allowlist with
 * unreachable entries is an allowlist nobody trusts.
 /**
  * A user-named static value on a step: an extra context parameter or
  * a tool's extra input. Static strings (inspector-authored), emitted inline
  * as JSON — valid by construction. Never a template, so Kestra renders
  * nothing in them unless a value literally contains `{{ }}`.
  */
 export interface NamedParam {
   name: string;
   value: string;
   description?: string;
 }
export type FlowStepKind =
  | "tool"
  | "datasource"
  | "query"
  | "transform"
  | "code"
  | "approval"
  | "branch"
  | "merge"
  /**
   * Wave-1 component kinds — declared in `@foundry/flow-edit`, carried through
   * `splitDraft`, and emitted as Foundry callbacks since Stage 4 (`/api/steps/llm`,
   * `/api/steps/http`). They are members of the model so a draft reaching for one
   * is refused with a sentence naming the kind when the save checks fail, rather
   * than failing the shape parse with a union error no redraft can act on.
   */
  | "llm"
  | "http"
  /** For each (compiled-builder phase F, D-361) — see `ForEachStep`. */
  | "for_each"
  | "collect";

/**
 * Typed property rows (property-rows project) — one row's feed per parameter.
 *
 * A row names a VALUE, never an expression the compiler must parse: `fixed` is
 * a literal string, `step` is an upstream step's field, `expression` is an
 * opaque template that travels as written. The compiler renders rows into the
 * same runtime shapes the legacy display strings already produce (a single
 * `[{…}]` call, or a fan-out `{{ rows | jq('[.[] | {…}]') | first }}` when every
 * `step` feed names one upstream step) — see `renderCallRows`.
 *
 * `{{#stepId.field#}}` inside an `expression` template is the one placeholder
 * the compiler expands (`expandRowPlaceholders`): a scalar read of that step's
 * output through the envelope table (`OUTPUT_SHAPES`), refused by name when
 * the step is unknown or produces nothing readable. Anything else in the
 * template is Pebble the save-time allowlist already scanned.
 */
export type RowSource =
  | { kind: "fixed"; value: string }
  | { kind: "step"; stepId: string; field: string }
  | { kind: "expression"; template: string };
/** One typed row: the parameter's feed. */
export interface RowValue {
  source: RowSource;
}

 export interface CallStep extends StepLabel {
   id: string;
   kind: "tool" | "datasource" | "query";
   /** `tool_name`, `<datasource>.<query>`, or `<datasource>.<operation>`. Resolved server-side, per workspace. */
   ref: string;
   /**
    * Frozen step SQL (mock-data plan, build-time human approval). The exact
    * statement the executor runs — through `checkSqlShape` — instead of the
    * stored named-query/operation text. Absent means legacy: the stored text.
    * Carried verbatim into the step callback body; never generated per run.
    */
   sql?: string;
   /**
    * The datasource address, explicit. When absent the executor falls back to
    * the `<datasource>.` prefix of `ref` — `ref` stays the compatibility
    * address, this is the one the builder writes.
    */
   datasourceRef?: string;
   /**
    * The placeholder order and descriptors for a STEP-LOCAL `sql` — what the
    * stored reader row supplies when there is one. Without them a step-local
    * statement cannot carry a single `$1`: `checkSqlShape` refuses it at
    * execution with `placeholder_mismatch`. @see flow.service's step schema.
    */
   sqlParamOrder?: string[];
   sqlParamsSchema?: Record<string, unknown>;
   /** D-311: the DB-operation spec a schema-built reader's `sql` was compiled from (typing only; the compiler emits `sql`). */
   sqlSpec?: unknown;
   /**
    * Expression producing the step's params. **Array-shaped (M1)** — one taskrun
    * per step regardless of item count, never a `ForEach` per item.
    *
    * Opaque to the compiler: it is emitted verbatim inside a JSON body. See the
    * D-16 boundary note above.
    */
  /**
   * ⚠ **OPTIONAL since Stage 3.** A converted step drops this when its typed
   * bindings are complete; presence then means the upgrade left the expression
   * as written (unreadable, partial) and it is emitted verbatim. Absent means
   * `inputs` renders it. `validateModel` refuses a step with neither.
   */
  paramsExpr?: string;
  /**
   * Typed bindings (Stage 3) — authoritative when `paramsExpr` is absent: a
   * converted step drops the display string, and the compiler renders these
   * through `render.ts` (`displayParams` below). When `paramsExpr` is present
   * the upgrade left it as written (unreadable expression, partial bindings)
   * and it is emitted verbatim. See `inputBindingSchema` in `flow.service.ts`
   * for the zod half.
   */
  inputs?: InputBinding[];
  /** The upstream step a fan-out reads its rows from — `{ stepId, field }`. */
  over?: { stepId: string; field: string } | null;
  /** The per-item filter, when the fan-out narrows which rows become calls. */
  where?: { field: string; test: BranchTest; value?: string } | null;
  /**
   * Typed property rows (property-rows project) — authoritative when
   * `paramsExpr` is absent, exactly as `inputs` already is: a converted step
   * drops the display string and the compiler renders these (`renderCallRows`
   * below). When `paramsExpr` is present it wins verbatim — the upgrade left
   * it as written — so a legacy step compiles byte-identically.
   */
  params?: Record<string, RowValue>;
  /**
   * Caller-supplied values beyond the endpoint schema, merged into the first
   * params object at execution. Emitted as JSON; see `NamedParam`.
   */
   extraInputs?: NamedParam[];
  dependsOn?: string[];
  /** Kestra `options.readIdleTimeout`. A batched fan-out of N emails is slow. */
  timeoutSeconds?: number;
  /** Re-attempt on failure. Read `StepRetry` — the safety argument differs by kind. */
  retry?: StepRetry;
}

export interface TransformStep extends StepLabel {
  id: string;
  kind: "transform";
  /**
   * A pure reshape, evaluated IN KESTRA because it touches no credential (R2).
   * Shipping it to Foundry would be work we chose to keep for no reason.
   *
   * ⚠ **OPTIONAL since the property-rows project.** A converted step drops this
   * when its typed rows are complete; presence then means the panel left the
   * expression as written and it is emitted verbatim. Absent means the rows
   * render it (`renderTransformRows` below). `validateModel` refuses a step
   * with neither — the same rule, widened evidence.
   */
  expr?: string;
  /**
   * Stage 3 — `mode` selects which text runs: `"expression"` (the default an
   * `expr`-only v1 step normalises to) emits `expr` as today, `"template"`
   * emits `templateText`. A rows-converted step carries neither display string
   * and renders from `outputColumns`.
   */
  mode?: "expression" | "template";
  templateText?: string;
  /**
   * Typed property rows (property-rows project) — the declared feed
   * (`inputBindings`) and the projected columns (`outputColumns`), each row a
   * `{ name, source }` over the shared `RowSource` vocabulary. Panel state
   * beside `expr` until the panel converts the step; `outputColumns` renders
   * the projection when `expr` is absent. `inputBindings` rows never render —
   * they declare what the projection reads — but their `expression` templates
   * are still save-scanned with everything else (see `rowExpressionTemplates`).
   */
  inputBindings?: Array<{ name: string; source: RowSource }>;
  outputColumns?: Array<{ name: string; type?: string; source: RowSource }>;
  /**
   * The DECLARED output fields of a drafted `{from, program, fields}` reshape
   * (phase 3 step 2): the keys of the object the program returns, or of each
   * element when it returns a list. Never read by the emitter — the checker
   * holds downstream reads to it (FT0302).
   */
  fields?: string[];
  dependsOn?: string[];
}
export interface CodeStep extends StepLabel {
  id: string;
  kind: "code";
  /**
   * The generated fragment. Must define `run(payload: dict) -> dict`.
   *
   * Never empty and never a placeholder: assertion 30 — "a flow cannot deploy
   * with an empty `script:` block". An import strips generated code (§5.2), so
   * an imported flow arrives `needs_regeneration` and must generate BEFORE it
   * reaches Kestra. Letting an empty one deploy would require Kestra to trigger
   * generation, which inverts the whole model.
   */
  code: string;
  /** Expression producing the JSON written to `input.json`. Opaque — see D-16. */
  /** As `paramsExpr` above: dropped when converted, verbatim when present. */
  inputExpr?: string;
  /**
   * Typed bindings (Stage 3) — names come from `contract.input`, carried
   * beside `inputExpr` exactly as the call kinds carry theirs.
   */
  inputs?: InputBinding[];
  /**
   * Typed property rows (property-rows project) — one row per contract input,
   * `{ name, source }` over the shared `RowSource` vocabulary. Read after
   * `inputs` (Stage 3 wins when both are present) and rendered into the input
   * object (`renderCodeRows`) when `inputExpr` is absent. `outputKeys` is
   * unchanged — the contract's field names, still required.
   */
  inputBindings?: Array<{ name: string; source: RowSource }>;
  /**
   * The output contract's field names, asserted IN THE CONTAINER before the
   * value crosses back. A violation is then a specific, mechanical signal
   * (`contract_violation` → triage level 1) instead of a downstream `KeyError`
   * three steps later.
   */
  outputKeys: string[];
  dependsOn?: string[];
  timeoutSeconds?: number;
  /** Safe by construction here — a fragment cannot have had an external effect. */
  retry?: StepRetry;
}

/**
 * Gate 3 — a human decision, awaited by PAUSING the execution.
 * 04 §5.3 · 05 §6.5 (the gate `flow-approval.service.ts:32` described and did not have)
 *
 * Emitted as **two** tasks, and for the
 * reason:
 *
 *   <id>        http.Request → POST /api/steps/approval   registers the request
 *   <id>_await  core.flow.Pause                            durable wait
 *
 * The wait is in Kestra's DATABASE, so the exit criterion — kill the API server
 * while a run is waiting for a human, restart it, and the run still resumes — is
 * satisfied by the engine rather than by Foundry staying up. A human takes hours;
 * an in-process wait would not survive a deploy.
 *
 * ── Why there is a registration task and not just a Pause ────────────────────
 *
 * A bare `Pause` would work, and "list what is waiting" would then mean scraping
 * Kestra for PAUSED executions and inferring which task each was sitting on. That
 * is the engine as a system of record (R6), reachable only by a component that
 * can address Kestra, and it carries no context — an approver would be asked to
 * approve a task id. The registration task writes a Foundry row holding the
 * summary, so the inbox is a database query and the question has an answer.
 *
 * ── How gate 3 differs from gate 2 ───────────────────────────────────────────
 *
 * Gate 2 (`flow-approval.service.ts`) approves a REVISION once, before it is
 * armed: "this automation may run unattended". Gate 3 approves ONE EXECUTION
 * mid-flight: "this particular batch may proceed". They are not substitutes —
 * an armed flow with an approval step still stops for a human every run.
 *
 * ⚠ **This is not separation of duties.** Foundry has one shared
 * `PARENT_API_KEY` and no user model, so `decidedBy` is self-asserted exactly as
 * `approver_user_id` is (I-13). What the gate actually provides is that the send
 * does not happen until somebody deliberately says so, and that who said it and
 * when is recorded. Do not describe it as more than that.
 */
export interface ApprovalStep extends StepLabel {
  id: string;
  kind: "approval";
  /**
   * Expression producing the one-line question, **as a JSON STRING** — quotes
   * included.
   *
   * ⚠ Same trap as `promptExpr`, and "as a JSON string" is not enough guidance
   * on its own: the author of this comment got it wrong within the hour. A
   * literal is easy —
   *
   *     summaryExpr: '"Proceed with the monthly close?"'
   *
   * — but a COMPUTED one needs `@json`, because `| first` unwraps a jq string
   * into raw text and the quotes are then gone:
   *
   *     ✗  jq('"Send to " + (length|tostring) + " people?"') | first
   *        → Send to 11 people?          Kestra: JsonParseException, naming nothing
   *     ✓  jq('("Send to " + (length|tostring) + " people?") | @json') | first
   *        → "Send to 11 people?"        valid, and escaped
   *
   * `@json` also escapes quotes, newlines and backslashes inside the value, so
   * the second form keeps working the day a name contains an apostrophe. This is
   * I-11 in its most literal form.
   */
  /** As `paramsExpr` above: dropped when converted, verbatim when present. */
  summaryExpr?: string;
  /**
   * Expression producing the JSON an approver needs in order to decide — the
   * rows about to be acted on, not a count.
   *
   * A count is what makes an approval gate theatre: "approve sending 10 emails"
   * is unanswerable without knowing to whom. Optional, because some gates really
   * are one-line ("proceed with the monthly close?"), but the default should be
   * to pass the evidence.
   */
  contextExpr?: string;
  /**
   * The typed question + evidence (Stage 3) — authoritative when `summaryExpr`
   * is absent. `summary` is the question text; `context` the upstream output
   * the approver is shown (`null` = explicitly no evidence).
   */
  summary?: string;
  context?: Source | null;
  dependsOn?: string[];
  /**
   * How long the execution may stay PAUSED waiting for a person. Bounded for the
   * same reason the wait is bounded at all — an unbounded Pause holds an M3
   * budget slot for ever — but the default is much longer, because the thing it
   * is waiting for is asleep, in a meeting, or on another continent.
   */
  awaitSeconds?: number;
}

/**
 * Re-attempt a step that failed, inside the same execution.
 * 02 R8 · 05 §6.6
 *
 * The only loop this system was missing. Array-shaped fan-out (M1) and the
 * redraft loop both already exist; a *transient* failure — a 503, a dropped
 * connection, a database still coming up — killed the run permanently, because
 * the compiler emitted no `retry:` block at all.
 *
 * ── Every field here is compiler-chosen, and one of them is load-bearing ─────
 *
 * Kestra's retry block accepts exactly seven properties (measured against
 * v1.3.29 by `POST /flows/validate`, with a bogus field as the negative control:
 * *"Unrecognized field … 7 known properties: behavior, interval, maxDuration,
 * maxAttempt, maxAttempts, warningOnRetry, type"*). Two of them matter here:
 *
 *  * **`behavior` is emitted EXPLICITLY as `RETRY_FAILED_TASK`.** The other
 *    accepted value is `CREATE_NEW_EXECUTION`, and it would be a catastrophe in
 *    this architecture rather than a different flavour of retry: a new execution
 *    calls `begin` again, so it mints a SECOND execution token, takes a SECOND
 *    M3 budget slot, and creates a SECOND `flow_executions` row — while the
 *    first is still open and will never reach `complete` (I-10). One run would
 *    appear as two, and a five-attempt retry would brick the workspace's budget.
 *    It is the default today; emitting it anyway means a change of default is a
 *    diff here, not a silent behaviour change on an engine upgrade.
 *  * **`maxAttempts` (plural), not `maxAttempt`.** Both validate and neither is
 *    flagged deprecated, but the engine's own constraint violation names the
 *    plural (`tasks[0].retry.maxAttempts: must be greater than or equal to 1`),
 *    so the plural is the one it actually binds.
 *
 * ── Is a retry SAFE? Three different answers, and only one has a caveat ──────
 *
 * A retry re-runs the whole task. Whether that is safe is a property of the step
 * kind, not a preference, which is why `approval` cannot carry this
 * field and `transform` has nothing to gain from it:
 *
 *  * **`code` — safe by construction.** A fragment is a pure function with
 *    `networkMode: none`, no credentials and no volumes (R9). It has no way to
 *    have an external effect, so re-running it cannot duplicate one.
 *  * **`datasource` — safe by construction.** A named query is a read: since
 *    Stage 2, `checkSqlShape` refuses `INSERT`/`UPDATE`/`DELETE`/DDL and refuses
 *    multiple statements, and `runNamedQuery` binds parameters rather than
 *    interpolating. There is nothing for a second execution to duplicate.
 *  * **`query` — safe by construction, like `datasource`.** A DB operation is a
 *    read-only SELECT compiled from a visual spec against the introspected
 *    schema; `checkSqlShape` refuses writes and multi-statements, and
 *    `runOperation` binds parameters positionally. There is nothing for a second
 *    execution to duplicate.
 *  * **`tool` — safe up to a lost response, and no further.** A tool step is the
 *    one that sends email and files tickets. What bounds the damage is that
 *    `stepExecutionService.tool` throws **only when EVERY item failed** — a
 *    partial failure returns 200 with a warning, so Kestra never retries it.
 *    The 7-of-10-then-retry-all-10 duplication is therefore structurally
 *    impossible, not merely unlikely, and `step-execution.test.ts` pins that
 *    semantic *as the retry-safety argument* so nobody "improves" it into
 *    throwing on any failure.
 *
 *    ⚠ The residual, stated plainly: a call whose **response** was lost had its
 *    effect and looks like a failure. If all N items land that way, the retry
 *    duplicates all N. Foundry cannot tell the two apart from outside, and
 *    nothing here pretends otherwise — which is why `retry` is opt-in per step
 *    rather than a default the compiler applies to every tool call.
 */
export interface StepRetry {
  /**
   * Total attempts, the original included. Bounded 2..5: fewer than 2 is not a
   * retry, and more than 5 against a service that is genuinely down is just
   * latency — the run should fail and be seen.
   */
  maxAttempts: number;
  /** `constant` waits the same each time; `exponential` doubles. Default constant. */
  backoff?: "constant" | "exponential";
  /** Wait before the next attempt (the FIRST wait, when exponential). Default 5s. */
  intervalSeconds?: number;
  /** Optional overall cap. `maxAttempts` already bounds the step; this bounds the clock. */
  maxDurationSeconds?: number;
}

/** The kinds that may carry `retry`. See `StepRetry` for why the others may not. */
const RETRYABLE_KINDS = new Set<FlowStepKind>(["tool", "datasource", "query", "code", "llm", "http"]);

/**
 * A conditional guard — foundations Phase 3 · D-123.
 *
 * ── ⚠ ONE ARM, and the second one is DEFERRED rather than forgotten ──────────
 *
 * A `branch` guards everything transitively downstream of it: the compiler emits
 * `io.kestra.plugin.core.flow.If` and hoists the arm's tasks into `then:`. There
 * is **no `else`**, and adding one is not a small change — it needs a second way
 * to say which arm a step belongs to, and every candidate for that either
 * reintroduces path addressing (nested step arrays, which D-123 exists to
 * refuse) or adds a per-step arm marker that `touchedBy`, `assertOnlyTouched`,
 * `downstreamOf` and the canvas would all have to learn. The stated
 * requirement — *"if the report is empty, do not email"* — is a guard, and a
 * guard is what this is. Say "a step can be made conditional"; **never say the
 * product has if/else.**
 *
 * ── The id space stays FLAT (D-123) ──────────────────────────────────────────
 *
 * Arm membership is an ordinary `dependsOn` edge, so `targetStepId`, `applyOp`,
 * `reaches`, `candidateUpstream` and `assertOnlyTouched` all survive unchanged.
 * The nesting exists only in the emitted YAML, where Kestra requires it.
 *
 * ⚠ **An arm may not contain an `approval` or another `branch`**,
 * and `validateModel` refuses all three by name. A `Pause` inside a conditional
 * block is unverified against this engine, and the failure mode for guessing is
 * the worst one this product has: it would fail at RENDER time, after approval,
 * on a schedule. Nested `If` needs recursive emission and has the same problem.
 * Refusing is cheap; a wrong guess is discovered by a customer.
 */
export interface BranchStep extends StepLabel {
  id: string;
  kind: "branch";
  /**
   * The condition, as a Pebble expression producing a boolean.
   *
   * ⚠ **BUILT, never typed** (D-50). The inspector asks which upstream step,
   * which field and which comparison, and `lib/flow-expr.ts` assembles a string
   * that is inside D-22's allowlist by construction — because D-22 is a good
   * boundary and a terrible text box, and `outline:measure` had a real draft
   * refused for a jq variable binding.
   *
   * ⚠ It is scanned by `checkSpanBalance` like every other expression (I-113).
   * The allowlist checks which functions are called; until I-113 nothing checked
   * that an expression PARSES, and Kestra accepts an unparseable Pebble
   * expression at validate time and fails at render time.
   */
  conditionExpr?: string;
  /**
   * The typed guard (Stage 3) — authoritative when `conditionExpr` is absent.
   * Explicit `null` is unknown-with-display (the upgrade kept the old string);
   * absent with no `conditionExpr` is an `else` only when `elseOf` names one.
   */
  test?: { left: Source; operator: BranchTest; right?: string } | null;
  /**
   * Typed branch conditions (property-rows project) — authoritative when both
   * `conditionExpr` and `test` are absent. A single condition renders through
   * the same builder the typed `test` uses; two or more refuse by name at
   * render time. An `else` (`elseOf` set) carries none, as before.
   */
  conditions?: BranchCondition[];
  dependsOn?: string[];
  /**
   * The branch this one CONTINUES — `if` → `elif` → `else`.
   *
   * Absent on the opening `if`. Present on every `elif` and on the closing
   * `else`, naming the branch immediately before it. The arm runs when that
   * branch's condition was FALSE, which is what the compiler emits into its
   * `else:` list — a real Kestra `else`, not a negated copy of the condition.
   *
   * ⚠ **THIS IS NOT WHAT D-123 REFUSED, and the difference is the whole
   * argument.** D-123 refused a per-step arm marker — every step in the flow
   * carrying a field saying which arm it belongs to, which `touchedBy`,
   * `assertOnlyTouched`, `downstreamOf` and the canvas would all have to learn.
   * This is one field on the BRANCH, naming another branch by id, exactly the
   * shape `dependsOn` already has. **Downstream steps carry nothing**, and
   * `armOf` is unchanged: an arm is still everything transitively downstream of
   * a branch via `dependsOn`.
   *
   * ⚠ An `else` is a branch with `elseOf` and NO condition. That is the only
   * shape in which `conditionExpr` may be absent, and the only branch that can
   * end a chain — nothing may continue it, because there is nothing left to be
   * false.
   */
  elseOf?: string;
}
/**
 * One side of a typed branch condition (property-rows project): an upstream
 * step's field, or a fixed literal the panel compares against. Mirrors the
 * wire shape the branch section writes.
 */
export type ConditionSide = { stepId: string; field: string } | { fixed: string };
/**
 * One typed branch condition (property-rows project): `left` compared to
 * `right` with a `BranchTest` operator. A single condition renders through the
 * same builder the typed `test` uses; ⚠ **two or more are a conjunction** —
 * every one must hold. There is deliberately no connector field: see
 * `conjoinConditions`.
 */
export interface BranchCondition {
  left: ConditionSide;
  op: BranchTest;
  right?: ConditionSide;
}

/**
 * Where the arms come back together — the shared tail after a branch.
 *
 * ── ⚠ WHY A KIND AND NOT A CONVENTION ───────────────────────────────────────
 *
 * `armOf` is a blind transitive closure over `dependsOn`, so **any** step that
 * reads an arm member's output BECOMES an arm member and runs only on that
 * path. A shared tail after a branch was therefore not merely awkward, it was
 * **unexpressible**: it had to be duplicated into every arm, and the copies
 * drift — one gets the fix, the other keeps the bug, and both look right on the
 * canvas.
 *
 * ⚠ A `transform` does NOT solve this. It is swallowed into the arm identically;
 * nothing about its kind exempts it. There is no workaround without an
 * exemption, and this kind IS the exemption: `armOf` stops here, so a merge and
 * everything downstream of it stay top-level and run whichever way the branch
 * went.
 *
 * ⚠ **One exemption, in one function, and deliberately NOT a per-step arm
 * marker** — D-123 already refused that: a marker is a second way to say which
 * arm a step belongs to, free to disagree with `dependsOn`, which is the only
 * thing the engine actually honours.
 *
 * ── ⚠ THE COALESCE IS `??` AND MUST NOT BECOME `default(…)` ──────────────────
 *
 * Referencing the output of a task that did not run FAILS AT RENDER — measured
 * 2026-09-04 against v1.3.29, with a positive control (arm taken) proving the
 * expressions discriminate rather than always falling back:
 *
 *     {{ outputs.inner.value }}                        FAILS at render
 *     {{ outputs.inner.value ?? "NOTHING" }}           NOTHING
 *     {{ outputs.inner.value | default("NOTHING") }}   NOTHING
 *
 * Both coalescing forms work on the engine. `??` is the one emitted because it
 * is an **operator**, and D-22's allowlist governs which *functions* may be
 * called — so `??` passes the scanner unchanged while `default` would need a
 * new entry on the one list standing between a drafted expression and a runtime
 * failure. Verified against `validateGeneratedExpr`, not assumed: `??` PASSES,
 * `default(…)` is REJECTED by name. **Adding `default` to `ALLOWED_CALLS` to
 * "tidy" this is I-118's exact shape.**
 *
 * ⚠ `{{ json(outputs) }}` also fails — `outputs` as a whole is not renderable,
 * even though `json` IS allowlisted. Do not build on it.
 *
 * ── ⚠ SOURCES ARE RESTRICTED TO THE FOUR JSON-BODIED KINDS ──────────────────
 *
 * `MERGE_SOURCE_KINDS` is `tool`, `datasource`, `query`, `transform` — the kinds
 * whose raw output is a JSON **string**, so one uniform `json(outputs.<merge>
 * .value)` reads the result no matter which arm produced it. A `code` step's
 * `vars.result` is an object and would render as a Java map, not JSON; an
 * an
 * `approval` and a `branch` produce nothing at all. Those refusals are by name,
 * with a reason — the same posture the arm ban below states: refusing is cheap,
 * and a wrong guess is discovered by a customer.
 */
export interface MergeStep extends StepLabel {
  id: string;
  kind: "merge";
  /**
   * Candidate steps, in priority order — the first that produced output wins.
   *
   * Ids, not expressions. The compiler looks each one's kind up and builds the
   * path itself, exactly as the inspector does for every other field (D-50):
   * the person picks the steps, nobody types `outputs.…`.
   */
  sources: string[];
  dependsOn?: string[];
}

/**
 * For each (compiled-builder phase F, D-361) — a `core.flow.ForEach` over a transform's bounded list of records.
 *
 * ── ⚠ THE BODY IS DERIVED, LIKE AN ARM ────────────────────────────────────────
 *
 * `loopOf` is the transitive `dependsOn` closure from this step (with an else-if's continuation where its chain is), never
 * entering a `collect` — the merge exemption one level out. Inside the body this step's VALUE is the current item, so a body
 * step reads it exactly as it reads a one-record transform.
 *
 * ── ⚠ WHAT THE EMITTER DOES, AND THE THREE ENGINE FACTS IT RESTS ON (E-F0.1) ─
 *
 *  1. **Rows are numbered first** (`<id>-rows`, `_i`): ForEach keys its iterations by VALUE, so two identical rows ran ONCE,
 *     and the collected map comes back in no order. A number makes every row distinct and restores input order.
 *  2. **Inside an `If` arm `taskrun.value` is ABSENT** — one `parent.` per enclosing `If`. Body tasks are emitted by the
 *     ordinary per-kind emitters and then re-addressed (`loopBody`): `outputs.<member>.` → `outputs.<member>[<value>].`, and
 *     this step's own `outputs.<id>.value` → `<value>`.
 *  3. **`allowFailure: true` keeps the loop going** past a failed item and ends the run WARNING, not FAILED; without it one
 *     item fails the run. That is `onError`.
 */
export interface ForEachStep extends StepLabel {
  id: string;
  kind: "for_each";
  over: { stepId: string; field: string };
  concurrency: number;
  onError: "continue" | "stop";
  dependsOn?: string[];
}
/** A loop's output: one row per item, in input order — the item's fields, `i`, `ok`, `error`, `result`. See `ForEachStep`. */
export interface CollectStep extends StepLabel {
  id: string;
  kind: "collect";
  loop: string;
  result: string;
  dependsOn?: string[];
}
/** The kinds a loop's result may be — each has a raw JSON value to carry out of the loop. */
export const COLLECT_RESULT_KINDS = new Set<FlowStepKind>(["tool", "datasource", "query", "transform", "merge"]);
export const MAX_LOOP_CONCURRENCY = 20;
/** D-370: a one-call loop's rows go to the step API in chunks of this many — well under its 1,000-row cap per call. */
export const LOOP_BATCH = 100;
/** D-370: the most rows a loop's list may have (its own `limit`) — bounds one run's per-item work either way. */
export const MAX_LOOP_ROWS = 1000;

/** The kinds a merge may name as a source. See `MergeStep` for why only these four. */
export const MERGE_SOURCE_KINDS = new Set<FlowStepKind>(["tool", "datasource", "query", "transform"]);

/**
 * ⚠ **A LABEL AND A DESCRIPTION, ON EVERY KIND, AND NEITHER REACHES THE YAML.**
 *
 * `id` is the ADDRESS — `dependsOn` names it, `outputs.<id>` resolves through
 * it, and D-123's flat step-id space is about it. `name` is a person's word for
 * the step and nothing resolves through it, so it is free to change.
 *
 * ⚠ **Both are deliberately ABSENT from `structureHash`.** That function builds
 * an explicit shape per kind precisely so a new field has to be argued onto one
 * side of §6.5's asymmetry, and this is the argument: relabelling a step does
 * not change what the engine runs, so it must not unarm an approved flow.
 *
 * ⚠ **And neither is emitted.** A Kestra task `id` is the step id; a label
 * rendered into the YAML would appear in `kestra-ui`, which has **no tenant
 * isolation** — the same reason D-70 keeps the requester's identity out of the
 * engine and sends a pointer label instead. Free text a person typed is exactly
 * the kind of thing that must not travel there.
 */
export interface StepLabel {
  /** A person's word for this step. Not an identifier. */
  name?: string;
  /** What this step is for, in prose. Never read by the compiler. */
  description?: string;
}

export type FlowStep =
  | CallStep
  | TransformStep
  | CodeStep
  | ApprovalStep
  | BranchStep
  | MergeStep
  | LlmStep
  | HttpStep
  | ForEachStep
  | CollectStep;

/**
 * Wave-1 component steps — the STORED shape, which for these two kinds is the
 * authored shape (nothing is derived server-side: no contract split, no
 * `outputKeys`). Read from `AuthoredStep` rather than re-declared, so the
 * compiler's model and the package's model cannot disagree about what an `llm`
 * or `http` step carries. Emitted as Foundry callbacks (`/api/steps/llm`,
 * `/api/steps/http`) since Stage 4 — see the emit loop's per-kind branches.
 */
export type LlmStep = Extract<AuthoredStep, { kind: "llm" }>;
export type HttpStep = Extract<AuthoredStep, { kind: "http" }>;

export interface FlowSchedule {
  /** Standard 5-field cron. Kestra owns parsing, catch-up and overlap policy. */
  cron: string;
  timezone?: string;
}

export interface FlowModel {
  /** Kestra flow id. Slug-shaped and immutable — it addresses both namespaces. */
  id: string;
  inputs?: FlowInput[];
  steps: FlowStep[];
  /**
   * Present on the model, emitted ONLY into the live namespace and only when
   * `withSchedule` is set. An unapproved flow has no trigger in Kestra and
   * therefore structurally cannot fire (§5.4) — that is stronger than a runtime
   * check, and it is why this is a compile-time argument rather than a field the
   * deploy path reads.
   */
  schedule?: FlowSchedule;
  /**
   * A webhook trigger declaration — Phase 6. `name` follows the SAME rule the
   * trigger API enforces (`createTriggerSchema` in trigger.service.ts): a
   * non-empty string of at most 255 characters (the `triggers.name` varchar
   * width). The declared trigger is materialised as a workspace `triggers` row
   * when the flow is saved (idempotent by name), so the name must be creatable
   * under that schema.
   *
   * ⚠ Foundry-side only: never emitted into the Kestra YAML (webhook/api
   * triggers are served by Foundry's own routers, not by the engine).
   */
  /** ⚠ `webhook` retired 2026-09-08 — see `FLOW_TRIGGER_TYPES`. Use `api`. */
  /** An api trigger declaration — Phase 6. Same `name` rule as `webhook`. */
  api?: { name: string };
  /** Kestra's own per-flow overlap guard. Complements M3, replaces nothing. */
  concurrencyLimit?: number;
  /**
   * Storage version — Stage 3. Absent = 1 (every revision written before the
   * typed model). `writeRevision` stamps 2; entries normalise on read, so the
   * compiler only ever sees v2. NOT in `structureHash`: the representation is
   * not the structure.
   */
  version?: number;
  /**
   * What the flow claims about its own output (archive/GAPS.md §2.3, D-68).
   *
   * ⚠ **The compiler reads this and emits nothing from it**, and that is the
   * design, not an omission. An assertion emitted into the YAML would fail the
   * execution — so "the flow produced the wrong number of rows" and "the flow
   * broke" would arrive as one status, and they need different fixes and
   * different people. Foundry evaluates them afterwards, against the outputs the
   * engine already holds; see `flow-expectation.service.ts`.
   *
   * `structureHash` therefore does not move when an expectation changes, which
   * is also correct: the deployed behaviour is byte-identical.
   */
  expectations?: FlowExpectation[];
  /**
   * WHICH STEP IS THE ANSWER — 2026-09-08.
   *
   * ── The gap this closes, measured at the wire ───────────────────────────────
   *
   * A Foundry flow had no notion of its own result. `FOUNDRY_EMITS` carries no
   * `core.output.OutputValues`, so the compiled YAML declares no outputs and
   * nothing marks which task holds the deliverable. Firing a trigger answers
   * `202 {fireId, started, error}` — no data and not even an execution id — so
   * an integration had to: fire, list the trigger's fires, match its `fireId`,
   * take `flowExecutionId`, poll `GET …/flow-executions/:id`, and pluck
   * `steps[i].output.value` **by a step id it had hardcoded**. Rename the step
   * and the integration breaks with no error anywhere.
   *
   * On a screen it was no better: a person opened the run and read the last
   * box. "Go and find the answer", not "here is the answer".
   *
   * ── ⚠ THE COMPILER READS THIS AND EMITS NOTHING FROM IT ────────────────────
   *
   * Exactly as `expectations` above, and for a sharper reason: emitting an
   * `OutputValues` task would put a class in the YAML that is NOT in
   * `FOUNDRY_EMITS` (UXI-003 — rendering a task type the compiler cannot emit
   * is a claim the runtime will not honour), and it would need a new entry on
   * the one allowlist standing between a drafted flow and a runtime failure.
   * The value is already in the engine's task outputs and already crosses back
   * through `flow-visibility.service.ts`'s **redacted** view; this field only
   * says which one to read. So the deployed behaviour is byte-identical, no new
   * data leaves the system, and no plugin or allowlist changes.
   *
   * ⚠ **NOT in `structureHash`**, following `expectations`. The steps that run
   * are identical, so no unapproved action becomes reachable — and the value was
   * already readable by anyone who could read the execution. The counter-argument
   * is real and is recorded rather than dismissed: this DOES change what an API
   * caller receives, so a reviewer approving a revision is not approving the
   * choice of result step. If that ever needs to be an approval-bound decision,
   * it moves into the hash and every armed flow re-approves once.
   *
   * ⚠ `stepId` must name a step that EXISTS and that produces something —
   * `checkFlowOutput` enforces both, and refuses `approval` and `branch` by
   * name. `approval` yields no value at all and `branch` schedules other tasks;
   * declaring either the result would hand a caller `null` for ever, which is
   * the "green run, wrong answer" class this repo keeps re-learning.
   */
  output?: FlowOutput;
}

/**
 * One flow-level output row (Stage 4.5) — the End boundary's declaration of
 * what the automation returns. `name` is what an API caller receives;
 * `source` is where it is read from (a step's output, a flow input, or a
 * literal — `Source` in `@foundry/flow-edit`); `type` is the declared
 * `VariableType`. A `null` source is explicitly unbound (`unset` in the
 * panel) — refused at save by `checkFlowOutput`, never projected.
 */
export interface FlowOutputRow {
  name: string;
  type: VariableType;
  source: Source | null;
}

/**
 * What the flow returns. See `FlowModel.output`.
 *
 * `rows` is the declaration (Stage 4.5); `stepId` is the legacy single-step
 * form pre-rows revisions carry. `description` is what the result IS, in a
 * person's words — the same job `FlowInput.label` does at the other end of
 * the flow, and for the same reason: a step id is slug-shaped because it is
 * interpolated into expressions, so `longest_waiting_ticket` is what an API
 * consumer would otherwise see as the name of the thing it is being handed.
 */
export interface FlowOutput {
  /**
   * Legacy single-step declaration (pre-rows revisions). Still read by
   * `flow-result.ts`'s legacy path so stored history projects on the run
   * view; new declarations use `rows`.
   */
  stepId?: string;
  description?: string;
  rows?: FlowOutputRow[];
}

/**
 * The kinds that may be declared a flow's result.
 *
 * ⚠ A SUPERSET of `MERGE_SOURCE_KINDS`, deliberately. A merge needs its sources
 * to share one spelling so a tail can read whichever arm ran, which is why that
 * set is four; this one only needs the step to HAVE a readable output, so `code`
 * (`vars.result`) and `merge` itself are in — and since Stage 4 the two
 * Foundry-callback kinds are in as well: `llm` answers `{text, …}` and `http`
 * answers `{body, status_code, headers, size}`, both readable off
 * `outputs.<id>.body`. `approval` and `branch` are the two that are out, and
 * they are out because they genuinely produce nothing.
 */
export const OUTPUT_STEP_KINDS = new Set<FlowStepKind>([
  "tool",
  "datasource",
  "query",
  "transform",
  "code",
  "merge",
  "llm",
  "http",
  "collect",
]);

export class FlowCompileError extends Error {
  constructor(
    message: string,
    public readonly stepId?: string,
  ) {
    super(message);
    this.name = "FlowCompileError";
  }
}

// ── Validation ───────────────────────────────────────────────────────────────

const ID_RE = /^[a-z][a-z0-9_]{0,62}$/;
const REF_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const INPUT_TYPES = new Set<FlowInputType>([
  "STRING",
  "INT",
  "FLOAT",
  "BOOLEAN",
  "DATE",
  "DATETIME",
]);
const KINDS = new Set<FlowStepKind>([
  "tool",
  "datasource",
  "query",
  "transform",
  "code",
  "approval",
  "branch",
  "merge",
  // Wave 1 (Stage 4.1/4.2): Foundry-callback steps — the credential (model key,
  // egress decision) never enters the engine (R2), so they follow the `tool`
  // pattern exactly.
  "llm",
  "http",
  "for_each",
  "collect",
]);

/**
 * Task ids the compiler emits itself. A model step taking one of these names
 * would silently replace the gate or the terminal task, so the collision is an
 * error rather than a last-write-wins.
 */
export const RESERVED_STEP_IDS = new Set(["begin", "complete"]);

/**
 * An `approval` step emits `<id>` plus `<id>_await`, so a model step called
 * `x_await` beside a model step called `x` would collide. Checked explicitly
 * rather than left to Kestra: Kestra's own error names a duplicate task id with
 * no hint that one of the two was synthesised.
 */
export const AWAIT_SUFFIX = "_await";

/**
 * Placeholders an IMPORTED flow carries in place of stripped generated code
 * (§5.2). Rejected by name so that assertion 30 fails at compile time with a
 * sentence about regeneration, rather than deploying a fragment whose `run()`
 * raises at execution.
 */
const CODE_PLACEHOLDERS = /^\s*(needs_regeneration|TODO|pass)\s*$/i;

/** Cron, conservatively: 5 or 6 whitespace-separated fields of cron charset. */
const CRON_FIELD_RE = /^[0-9*/,\-?LW#]+$/;

/**
 * A flow-declared trigger name's length cap — Phase 6. The SAME rule
 * `createTriggerSchema` enforces (trigger.service.ts: `z.string().min(1)
 * .max(255)`), which is also the `triggers.name` varchar width. A declared
 * webhook/api trigger becomes a `triggers` row at save, so this must never be
 * wider than what that schema would accept.
 */
const TRIGGER_NAME_MAX = 255;

function assertCron(cron: string) {
  const fields = cron.trim().split(/\s+/);
  if (fields.length < 5 || fields.length > 6) {
    throw new FlowCompileError(
      `schedule cron must have 5 or 6 fields, got ${fields.length}: "${cron}"`,
    );
  }
  for (const f of fields) {
    if (!CRON_FIELD_RE.test(f)) {
      throw new FlowCompileError(`schedule cron field "${f}" is not a cron expression`);
    }
  }
}

/**
 * IANA-shaped, and nothing that could leave the quoted scalar it lands in.
 * Kestra does the real resolution; an unknown zone fails the flow validate call.
 */
const TZ_RE = /^[A-Za-z][A-Za-z0-9+_-]*(\/[A-Za-z0-9+_-]+){0,2}$/;

/**
 * A step's `retry`, if it has one — and a REFUSAL if it has one and may not.
 *
 * The refusal is the interesting half, and it is checked here rather than left
 * to the type system because a model arrives as JSON from `POST /flows` and from
 * an imported bundle. TypeScript is not in the room at either point.
 *
 * The messages name the reason, not the rule. "`approval` steps cannot retry" tells
 * an author to delete a line; a message naming what a second attempt would DO tells
 * them what would have happened, which is the thing they need in order to decide
 * whether they wanted something else instead.
 */
function validateRetry(step: FlowStep): void {
  const retry = (step as { retry?: StepRetry }).retry;
  if (retry === undefined) return;

  if (!RETRYABLE_KINDS.has(step.kind)) {
    const why: Record<string, string> = {
      // Both of these are the FIRST of a two-task pair, and re-running the first
      // task does not re-run the pause — it starts a second thing to wait for.
      approval:
        `a decision is per (execution, step) and outlives the task that asked for it, so re-asking ` +
        `resolves to the same row — a retry would either do nothing or re-open a question a person ` +
        `has already answered`,
      transform:
        `a transform is evaluated by Kestra with no network and no I/O, so it cannot fail ` +
        `transiently — if it failed, the expression is wrong and it will fail identically next time`,
    };
    throw new FlowCompileError(
      `step "${step.id}" is a \`${step.kind}\` step and cannot declare \`retry\`: ${why[step.kind] ?? "not retryable"}`,
      step.id,
    );
  }

  if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 2 || retry.maxAttempts > 5) {
    throw new FlowCompileError(
      `step "${step.id}" retry.maxAttempts must be an integer 2..5 (it counts the first attempt)`,
      step.id,
    );
  }
  if (retry.backoff !== undefined && retry.backoff !== "constant" && retry.backoff !== "exponential") {
    throw new FlowCompileError(
      `step "${step.id}" retry.backoff must be "constant" or "exponential"`,
      step.id,
    );
  }
  if (retry.intervalSeconds !== undefined) {
    if (!Number.isInteger(retry.intervalSeconds) || retry.intervalSeconds < 1 || retry.intervalSeconds > 300) {
      throw new FlowCompileError(
        `step "${step.id}" retry.intervalSeconds must be an integer 1..300`,
        step.id,
      );
    }
  }
  if (retry.maxDurationSeconds !== undefined) {
    if (
      !Number.isInteger(retry.maxDurationSeconds) ||
      retry.maxDurationSeconds < 10 ||
      retry.maxDurationSeconds > 3600
    ) {
      throw new FlowCompileError(
        `step "${step.id}" retry.maxDurationSeconds must be an integer 10..3600`,
        step.id,
      );
    }
  }
}

/**
 * Every step transitively downstream of `branchId` via `dependsOn` — the branch's
 * ARM, in the model's own order.
 *
 * ⚠ **Computed from `dependsOn`, never from ordinal position.** That is the same
 * rule `downstreamOf` follows for replay, and the reason is recorded there: *on a
 * branching flow an ordinal version both refuses safe replays and permits
 * hanging ones.* That sentence was written about the flows that existed then and
 * is now literally about this.
 *
 * ⚠ **The closure STOPS at a `merge`, and that one line is the whole of how a
 * shared tail works.** A merge is never an arm member, so it stays top-level and
 * runs whichever way the branch went; and because the walk never enters it,
 * nothing reachable only *through* a merge is pulled into the arm either. See
 * `MergeStep` for why this is an exemption in this function rather than a marker
 * on the step (D-123).
 *
 * ⚠ The escape hatch this leaves open is a step depending on a merge AND on an
 * arm member directly — that step is still reached by the second edge and is
 * still an arm member, which would emit it inside the `then:` block reading a
 * task that has not run. `validateModel` refuses exactly that, by name.
 */
export function armOf(model: FlowModel, branchId: string): FlowStep[] {
  const inArm = new Set<string>([branchId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of model.steps) {
      if (inArm.has(s.id)) continue;
      if (s.kind === "merge" || s.kind === "collect") continue;
      if ((s.dependsOn ?? []).some((d) => inArm.has(d))) {
        inArm.add(s.id);
        grew = true;
      }
    }
  }
  return model.steps.filter((s) => s.id !== branchId && inArm.has(s.id));
}

/**
 * A loop's body (D-361): the transitive `dependsOn` closure from the `for_each`, plus an else-if's continuation (which depends
 * on nothing) when its chain's head is inside, never entering a `collect`. In model order.
 */
export function loopOf(model: FlowModel, loopId: string): FlowStep[] {
  const inside = new Set<string>([loopId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of model.steps) {
      if (inside.has(s.id) || s.kind === "collect") continue;
      if ((s.dependsOn ?? []).some((d) => inside.has(d)) || (s.kind === "branch" && s.elseOf && inside.has(s.elseOf))) {
        inside.add(s.id);
        grew = true;
      }
    }
  }
  return model.steps.filter((s) => s.id !== loopId && inside.has(s.id));
}

/**
 * The task ids a loop adds beside its own (D-361). A hyphen — which a step id can never contain (`ID_RE`) — so they cannot
 * collide with a step. Read in Pebble with brackets: `outputs['<id>-rows']`.
 */
const LOOP_ROWS = "-rows";
const LOOP_PICK = "-pick";
/** D-370: a batched loop's rows, cut into chunks of `LOOP_BATCH`. */
const LOOP_CHUNKS = "-chunks";

/**
 * D-370: the loop's one call when it runs in BATCHES, or null when it runs per item. Batched only when the body is exactly one
 * `tool` call, fed from the item's fields, literals and run inputs alone, one call per row — so the step API's positional
 * `results[k]` is row k of the chunk. Anything more inside (a condition, a transform, a second step) is a per-item decision; a
 * field the call SKIPS when empty (D-273 `onNull: "skip"`) drops rows before the call and breaks the join, so it stays per item.
 */
export function batchedCall(model: FlowModel, loop: ForEachStep): FlowStep | null {
  const members = loopOf(model, loop.id);
  if (members.length !== 1) return null;
  const c = members[0]! as FlowStep & { over?: unknown; paramsExpr?: string; params?: Record<string, unknown>; where?: unknown; inputs?: InputBinding[] };
  // `[{}]` is the engine's canonical "nothing bound" (`withParams`), not hand-written params: still one call per row.
  if (c.kind !== "tool" || c.over || (c.paramsExpr?.trim() && c.paramsExpr.trim() !== "[{}]") || Object.keys(c.params ?? {}).length || c.where) return null;
  const collect = model.steps.find((s): s is CollectStep => s.kind === "collect" && s.loop === loop.id);
  if (collect && collect.result !== c.id) return null;
  const fits = (b: InputBinding) => { const x = b.source; return !x || x.from === "literal" || x.from === "input" || (x.from === "step" && x.stepId === loop.id && x.onNull !== "skip"); };
  return (c.inputs ?? []).every(fits) ? c : null;
}
/** An item whose result step did not finish. Never valid JSON, so it cannot be mistaken for a result's own raw value. */
const NO_RESULT = "__no_result__";

/**
 * A loop body's task, re-addressed to the CURRENT ITEM (D-361, E-F0.1). The per-kind emitters wrote it as if it ran once:
 * `outputs.<member>.` becomes `outputs.<member>[<value>].` (a body task's outputs are a map keyed by the item), and the loop's
 * own `outputs.<loop>.value` becomes `<value>` — the item. `<value>` is `taskrun.value` with one `parent.` per `If` around
 * the task inside the loop: in an `If`'s arm `taskrun.value` is absent (measured). `allowFailure` is added to every task
 * when the loop keeps going, so a failed item is recorded and the others still run.
 */
function loopBody(text: string, loop: ForEachStep, members: string[], ifs: number, gates: ReadonlyMap<string, string> = new Map()): string {
  const value = `${"parent.".repeat(ifs)}taskrun.value`;
  let t = text.replace(new RegExp(`outputs\\.${loop.id}\\.value\\b`, "g"), value);
  for (const m of members) t = t.replace(new RegExp(`outputs\\.${m}\\.`, "g"), `outputs.${m}[${value}].`);
  // builder-behaviour P7 (P4-I4): an approval INSIDE a loop is the item's own — its request names the item (`scope`, the item's row
  // number), so each item's question is its own row and its own resume; a step the gate guards runs only when THAT item was approved
  // (a rejected item's step is SKIPPED and the other items go on — measured, phase-7 E1: Kestra pauses and resumes each item alone).
  t = t.replace(/^( +)("resumeTaskId": "[^"\n]+",)$/gm, (_m, ind: string, line: string) => `${ind}${line}\n${ind}"scope": "{{ json(${value})._i }}",`);
  t = t.replace(/^( {2}- id: (\S+)\n {4}type: [^\n]+\n)/gm, (head: string, _h: string, id: string) => {
    const gate = gates.get(id);
    return gate ? `${head}    runIf: ${JSON.stringify(`{{ outputs.${gate}${AWAIT_SUFFIX}[${value}].onResume.decision == 'approved' }}`)}\n` : head;
  });
  if (loop.onError === "continue") t = t.replace(/^( {2}- id: [^\n]+\n {4}type: [^\n]+\n)/gm, "$1    allowFailure: true\n");
  return t;
}

/**
 * The loop's output (D-361): one row per item, IN INPUT ORDER — the numbered rows joined with the per-item picks by `_i`, the
 * item's own fields kept, `i`/`ok`/`error`/`result` added. A result is the result step's raw JSON parsed; for a call, the
 * payload inside Foundry's envelope (`.results[0].data`), which is what the loop's output type says `result` holds.
 */
/**
 * D-370: a BATCHED loop's output — the same rows as `collectExpr`'s, read from each chunk's pick `{is, r}`: `is` the chunk's item
 * numbers in order, `r` the batch call's envelope, whose `results[k]` is row k (`{ok, data, error}`). A batch that did not finish
 * (the step API answers 502 when EVERY call in it failed) marks its items not ok, with the batch named as the reason.
 */
export function collectBatchExpr(loopId: string): string {
  const program =
    `.rows as $rows | ([(.picks // {})[] | .value | fromjson | . as $p | (if $p.r == "${NO_RESULT}" then null else ($p.r | fromjson) end) as $b` +
    ` | range(0; $p.is | length) as $k | {key: ($p.is[$k] | tostring), value: (if $b == null then {ok: false, error: "the batch call for these items did not finish"} else ($b.results[$k] // {ok: false, error: "no result for this item"}) end)}] | from_entries) as $m` +
    ` | [$rows[] | ._i as $i | ($m[$i | tostring] // {ok: false, error: "did not finish"}) as $x | ($x.ok == true) as $ok` +
    ` | del(._i) + {ff_i: $i, ff_ok: $ok, ff_error: (if $ok then null else ($x.error // "did not finish") end), ff_result: (if $ok then $x.data else null end)}]`;
  return `{{ {'rows': json(outputs['${loopId}${LOOP_ROWS}'].value), 'picks': outputs['${loopId}${LOOP_PICK}'] ?? {}} | jq('${program}') | first }}`;
}

function collectExpr(loopId: string, result: FlowStep): string {
  const payload = result.kind === "transform" || result.kind === "merge" ? "" : " | .results[0].data";
  const program =
    `.rows as $rows | ([(.picks // {})[] | .value | fromjson] | map({key: (.i | tostring), value: .r}) | from_entries) as $p` +
    ` | [$rows[] | ._i as $i | ($p[$i | tostring]) as $r | (($r != null) and ($r != "${NO_RESULT}")) as $ok` +
    ` | del(._i) + {ff_i: $i, ff_ok: $ok, ff_error: (if $ok then null else "did not finish" end), ff_result: (if $ok then ($r | fromjson${payload}) else null end)}]`;
  return `{{ {'rows': json(outputs['${loopId}${LOOP_ROWS}'].value), 'picks': outputs['${loopId}${LOOP_PICK}'] ?? {}} | jq('${program}') | first }}`;
}

/**
 * For each (D-361): every rule a loop needs that is CROSS-step. The engine's moves never build a model that breaks one; these
 * are here because a model can reach the compiler by other routes, and each refusal names the step and the reason.
 */
function validateLoops(model: FlowModel): void {
  const loops = model.steps.filter((s): s is ForEachStep => s.kind === "for_each");
  const collects = model.steps.filter((s): s is CollectStep => s.kind === "collect");
  if (!loops.length && !collects.length) return;
  const byId = new Map(model.steps.map((s) => [s.id, s]));
  const orderOf = new Map(model.steps.map((s, i) => [s.id, i]));
  const armed = new Set<string>();
  for (const b of model.steps) if (b.kind === "branch") for (const inner of armOf(model, b.id)) armed.add(inner.id);
  const bodyOf = new Map<string, string>();
  for (const l of loops) {
    for (const inner of loopOf(model, l.id)) {
      const already = bodyOf.get(inner.id);
      if (already) throw new FlowCompileError(`step "${inner.id}" is inside two loops ("${already}" and "${l.id}")`, inner.id);
      bodyOf.set(inner.id, l.id);
    }
  }
  for (const l of loops) {
    const over = byId.get(l.over?.stepId ?? "");
    if (!over || over.kind !== "transform") throw new FlowCompileError(`loop "${l.id}" runs over "${l.over?.stepId}", which is not a transform in this flow`, l.id);
    // D-370: at most MAX_LOOP_ROWS — the list's own last `limit` (the engine's `boundedList`, mirrored for models by other routes).
    const pipe = ((over as { pipeline?: Array<{ op: string; n?: { value?: unknown } }> }).pipeline ?? []);
    const lim = pipe.map((c) => c.op).lastIndexOf("limit");
    if (lim >= 0 && !(Number(pipe[lim]!.n?.value) <= MAX_LOOP_ROWS)) throw new FlowCompileError(`loop "${l.id}" runs over "${over.id}", whose limit is above ${MAX_LOOP_ROWS} — a loop runs over at most ${MAX_LOOP_ROWS} rows; filter or limit the list first`, l.id);
    if ((orderOf.get(over.id) ?? 0) > (orderOf.get(l.id) ?? 0)) throw new FlowCompileError(`loop "${l.id}" comes before the list it runs over ("${over.id}")`, l.id);
    if (bodyOf.has(l.id)) throw new FlowCompileError(`loop "${l.id}" is inside the loop "${bodyOf.get(l.id)}" — a loop inside a loop is not emitted`, l.id);
    if (armed.has(l.id) || armed.has(over.id)) throw new FlowCompileError(`loop "${l.id}" is under a condition — a loop runs at the top level`, l.id);
    if (!Number.isInteger(l.concurrency) || l.concurrency < 1 || l.concurrency > MAX_LOOP_CONCURRENCY) throw new FlowCompileError(`loop "${l.id}" runs ${l.concurrency} items at once; the range is 1 to ${MAX_LOOP_CONCURRENCY}`, l.id);
    if (l.onError !== "continue" && l.onError !== "stop") throw new FlowCompileError(`loop "${l.id}" has onError "${String(l.onError)}"; it keeps going ("continue") or stops the run ("stop")`, l.id);
    const members = loopOf(model, l.id);
    if (!members.length) throw new FlowCompileError(`loop "${l.id}" runs nothing — put the steps it repeats inside it`, l.id);
    for (const m of members) {
      // builder-behaviour P5: refused again — Kestra v1.3.29 resumes an execution's FIRST paused task (its resume takes no taskrun id;
      // measured 2026-10-04), so an item's decision cannot be delivered to that item. `loopBody`'s per-item guard stays for when it can.
      if (m.kind === "approval") throw new FlowCompileError(`approval "${m.id}" is inside the loop "${l.id}", and a decision cannot be delivered to its own item — put the approval before the loop`, m.id);
      if (m.kind === "code" || m.kind === "llm" || m.kind === "http") throw new FlowCompileError(`step "${m.id}" is a ${m.kind} step inside the loop "${l.id}", which is not emitted yet`, m.id);
      for (const d of m.dependsOn ?? []) {
        if (d === l.id || bodyOf.get(d) === l.id) continue;
        if ((orderOf.get(d) ?? 0) > (orderOf.get(l.id) ?? 0)) throw new FlowCompileError(`step "${m.id}" runs inside the loop "${l.id}" but reads "${d}", which is placed after the loop begins`, m.id);
        if (byId.get(d)?.kind === "collect") throw new FlowCompileError(`step "${m.id}" runs inside the loop "${l.id}" but reads the loop output "${d}"`, m.id);
      }
    }
  }
  // Nothing outside a loop reads the loop or its body (other than that loop's own collect reading its result).
  for (const s of model.steps) {
    const mine = bodyOf.get(s.id);
    const reads = [...(s.dependsOn ?? []), ...((s as { over?: { stepId?: string } | null }).over?.stepId ? [(s as { over: { stepId: string } }).over.stepId] : []), ...(s.kind === "merge" ? s.sources : [])];
    for (const r of reads) {
      const theirs = byId.get(r)?.kind === "for_each" ? r : bodyOf.get(r);
      if (!theirs || theirs === mine) continue;
      if (s.kind === "for_each" && r === s.id) continue;
      if (s.kind === "collect" && s.loop === theirs && r === s.result) continue;
      throw new FlowCompileError(`step "${s.id}" reads "${r}", which runs once per item of the loop "${theirs}" — read the loop's output`, s.id);
    }
  }
  const seen = new Map<string, string>();
  for (const c of collects) {
    const l = byId.get(c.loop);
    if (!l || l.kind !== "for_each") throw new FlowCompileError(`loop output "${c.id}" names "${c.loop}", which is not a loop in this flow`, c.id);
    if (seen.has(c.loop)) throw new FlowCompileError(`the loop "${c.loop}" has two outputs ("${seen.get(c.loop)}" and "${c.id}")`, c.id);
    seen.set(c.loop, c.id);
    const r = byId.get(c.result);
    if (!r || bodyOf.get(r.id) !== c.loop) throw new FlowCompileError(`loop output "${c.id}" names "${c.result}" as its result, which is not a step inside "${c.loop}"`, c.id);
    if (armed.has(r.id)) throw new FlowCompileError(`loop output "${c.id}" names "${r.id}", which runs only on one path — merge the paths first`, c.id);
    if (!COLLECT_RESULT_KINDS.has(r.kind)) throw new FlowCompileError(`loop output "${c.id}" names "${r.id}", a ${r.kind} step, which has no value to carry out of the loop`, c.id);
    if (r.kind === "merge" && r.sources.some((x) => byId.get(x)?.kind !== "transform")) throw new FlowCompileError(`loop output "${c.id}" names the merge "${r.id}", whose sources are not all transforms`, c.id);
    if ((orderOf.get(r.id) ?? 0) > (orderOf.get(c.id) ?? 0)) throw new FlowCompileError(`loop output "${c.id}" comes before its result "${r.id}"`, c.id);
  }
}

/**
 * The RAW output path of a merge source — the value before `json(…)` parses it.
 *
 * ⚠ Deliberately NOT `outputExprFor`, and the difference is the whole point.
 * That helper returns the *readable* expression, which for the three HTTP kinds
 * is `json(outputs.<id>.body)` — and calling `json` on a task that did not run
 * fails at render before `??` ever gets to choose. The coalesce has to happen on
 * the bare path, with one `json(…)` applied by the READER afterwards. That is
 * also why `MERGE_SOURCE_KINDS` is restricted to kinds whose raw value is a JSON
 * string: it makes the reader's single `json(outputs.<merge>.value)` correct
 * regardless of which arm won.
 */
function rawOutputPath(kind: FlowStepKind, id: string): string {
  return kind === "transform" ? `outputs.${id}.value` : `outputs.${id}.body`;
}

/** `{{ outputs.a.body ?? outputs.b.value ?? "null" }}` — see `MergeStep`. */
export function mergeExpr(model: FlowModel, step: MergeStep): string {
  const byId = new Map(model.steps.map((s) => [s.id, s]));
  const terms = step.sources.map((id) => rawOutputPath(byId.get(id)!.kind, id));
  return `{{ ${[...terms, `"null"`].join(" ?? ")} }}`;
}
/**
 * ── EVERY BINDING THAT NAMES A STEP MUST NAME ONE THAT EXISTS ────────────────
 *
 * Measured 2026-09-15: a chat turn bound `fetch.period` to `derive_month.month`
 * with no `derive_month` step in the flow. The revision saved, compiled and
 * deployed — `checkStepRefs` scans the legacy display strings (`paramsExpr`,
 * `inputExpr`, …) and the save path folds row `expression` templates into them
 * (`stepsWithRowTemplates`), but a STRUCTURED `Source` (`{from:"step"|"whole",
 * stepId}`), a `RowSource` (`{kind:"step", stepId}`), an `over.stepId`, an
 * approval `context`, a branch `test`/`conditions` side, a flow output row, or
 * a `{{#stepId.field#}}` placeholder names its step outside every string any
 * expression check reads. `dependsOn` was rewired; the binding was not — the
 * same class as the `checkStepRefs` incident, in the fields it never looked at.
 *
 * What this covers, and what it deliberately does not:
 *
 *  * Structured step readers: `inputs` rows, `params` rows, `inputBindings`,
 *    `outputColumns`, `over`, approval `context`, branch `test.left` and
 *    `conditions` sides, flow output rows, and the step-owned `Source`s
 *    (`inputSource`, `arraySource`, `loopVars`, `contextStepId`).
 *  * `expression` row templates: `outputs.<id>` reads (the same reader
 *    `checkStepRefs` uses, so the two cannot disagree) and `{{#id.field#}}`
 *    placeholders (which no expression check reads — they are not `{{…}}`
 *    spans). `fixed`/`literal` values are data and never scanned.
 *  * NOT the legacy display strings (`paramsExpr`, `inputExpr`, `expr`, …):
 *    `checkStepRefs` owns those, and reporting them here too would name the
 *    same defect twice. NOT `inputs.<id>` reads: `checkDeclaredInputs` owns
 *    those. NOT `dependsOn`, `elseOf`, merge `sources`, expectations or the
 *    legacy single-step output: each already has a refusal naming it.
 *
 * Existence only, deliberately not order — the same rule `checkStepRefs` keeps:
 * topology belongs to the dependency checks, and answering it here would put
 * two definitions of what may run after what in two places.
 */
export interface UnknownBindingRef {
  /** The step carrying the binding, or `null` for a flow-level output row. */
  stepId: string | null;
  /** Where the read lives: `step "fetch".inputs[period]`, `output row "x"`, … */
  reader: string;
  /** The step id named, which no step in this flow declares. */
  missingStepId: string;
  /**
   * True for flow-level output rows. The validator's `checkFlowOutput` already
   * refuses those (`unknown_output_row_step`), so its binding-step check skips
   * them; the compiler, model and feeder layers have no such check and keep them.
   */
  outputRow: boolean;
}

/** The panel's neutral placeholder: `{{#stepId.field#}}`. See `RowSource`. */
const BINDING_PLACEHOLDER_RE = /\{\{#([A-Za-z][A-Za-z0-9_]*)\.[A-Za-z0-9_]+#\}\}/g;

/** Every step a row `expression` template reads: `outputs.<id>` plus placeholders. */
function bindingTemplateSteps(template: string): string[] {
  const out = new Set<string>();
  for (const name of stepNamesRead(template)) out.add(name);
  for (const m of template.matchAll(BINDING_PLACEHOLDER_RE)) {
    if (m[1]) out.add(m[1]);
  }
  return [...out];
}

/**
 * Every binding in the model that names a step the model does not declare, in
 * step order. Empty means every step reader resolves. Each layer formats the
 * entries in its own finding vocabulary; the rule name is `unknown_binding_step`
 * everywhere.
 */
export function collectUnknownBindingSteps(model: FlowModel): UnknownBindingRef[] {
  const steps = Array.isArray((model as { steps?: unknown })?.steps)
    ? (model.steps as Array<Record<string, unknown>>)
    : [];
  const known = new Set<string>();
  for (const s of steps) {
    const id = (s as { id?: unknown })?.id;
    if (typeof id === "string" && id) known.add(id);
  }
  const found: UnknownBindingRef[] = [];
  const seenKeys = new Set<string>();
  const report = (stepId: string | null, reader: string, missing: string, outputRow: boolean): void => {
    const key = `${reader}→${missing}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    found.push({ stepId, reader, missingStepId: missing, outputRow });
  };
  /** A `Source` (`{from:"step"|"whole", stepId}`) — other `from`s read no step. */
  const checkSource = (stepId: string | null, reader: string, source: unknown, outputRow = false): void => {
    if (source === null || typeof source !== "object" || Array.isArray(source)) return;
    const rec = source as Record<string, unknown>;
    if (
      (rec.from === "step" || rec.from === "whole") &&
      typeof rec.stepId === "string" &&
      !known.has(rec.stepId)
    ) {
      report(stepId, reader, rec.stepId, outputRow);
    }
  };
  /** A `RowSource`: a `step` feed names its step; an `expression` names any it reads. */
  const checkRowSource = (stepId: string, reader: string, rs: unknown): void => {
    if (rs === null || typeof rs !== "object" || Array.isArray(rs)) return;
    const rec = rs as Record<string, unknown>;
    if (rec.kind === "step" && typeof rec.stepId === "string" && !known.has(rec.stepId)) {
      report(stepId, reader, rec.stepId, false);
    } else if (rec.kind === "expression" && typeof rec.template === "string") {
      for (const name of bindingTemplateSteps(rec.template)) {
        if (!known.has(name)) report(stepId, `${reader} template`, name, false);
      }
    }
    // `fixed` is data, never a read.
  };
  for (const s of steps) {
    const rec = (s ?? {}) as Record<string, unknown>;
    const id = typeof rec.id === "string" && rec.id ? rec.id : "<unnamed step>";
    // Typed input bindings (Stage 3) — the rev-2 vehicle.
    if (Array.isArray(rec.inputs)) {
      for (const b of rec.inputs as Array<unknown>) {
        const br = b as Record<string, unknown> | null;
        if (!br || typeof br !== "object" || typeof br.name !== "string") continue;
        checkSource(id, `step "${id}".inputs[${br.name}]`, br.source);
      }
    }
    // Typed property rows — authoritative when the display string is absent.
    if (rec.params !== null && typeof rec.params === "object" && !Array.isArray(rec.params)) {
      for (const [pname, row] of Object.entries(rec.params as Record<string, unknown>)) {
        checkRowSource(id, `step "${id}".params[${pname}]`, (row as Record<string, unknown>)?.source);
      }
    }
    for (const field of ["inputBindings", "outputColumns"] as const) {
      if (!Array.isArray(rec[field])) continue;
      for (const r of rec[field] as Array<unknown>) {
        const rr = r as Record<string, unknown> | null;
        if (!rr || typeof rr !== "object" || typeof rr.name !== "string") continue;
        checkRowSource(id, `step "${id}".${field}[${rr.name}]`, rr.source);
      }
    }
    // The upstream step a fan-out reads its rows from.
    const over = rec.over as Record<string, unknown> | null | undefined;
    if (over !== null && typeof over === "object" && !Array.isArray(over)) {
      if (typeof over.stepId === "string" && !known.has(over.stepId)) {
        report(id, `step "${id}".over`, over.stepId, false);
      }
    }
    // An approval's evidence.
    if ("context" in rec) checkSource(id, `step "${id}".context`, rec.context);
    // Branch guards: the typed test and the typed conditions.
    const test = rec.test as Record<string, unknown> | null | undefined;
    if (test !== null && typeof test === "object" && !Array.isArray(test) && "left" in test) {
      checkSource(id, `step "${id}".test.left`, (test as Record<string, unknown>).left);
    }
    if (Array.isArray(rec.conditions)) {
      (rec.conditions as Array<unknown>).forEach((c, i) => {
        if (!c || typeof c !== "object" || Array.isArray(c)) return;
        for (const side of ["left", "right"] as const) {
          const sd = (c as Record<string, unknown>)[side] as Record<string, unknown> | undefined;
          if (
            sd !== null &&
            typeof sd === "object" &&
            !Array.isArray(sd) &&
            typeof sd.stepId === "string" &&
            !("fixed" in sd) &&
            !known.has(sd.stepId)
          ) {
            report(id, `step "${id}".conditions[${i}].${side}`, sd.stepId, false);
          }
        }
      });
    }
    // Step-owned sources on the wave kinds — refused elsewhere by kind, read here anyway.
    if (typeof rec.contextStepId === "string" && rec.contextStepId && !known.has(rec.contextStepId)) {
      report(id, `step "${id}".contextStepId`, rec.contextStepId, false);
    }
    for (const f of ["inputSource", "arraySource"] as const) {
      if (f in rec) checkSource(id, `step "${id}".${f}`, rec[f]);
    }
    if (Array.isArray(rec.loopVars)) {
      for (const v of rec.loopVars as Array<unknown>) {
        const vr = v as Record<string, unknown> | null;
        if (!vr || typeof vr !== "object" || typeof vr.name !== "string") continue;
        checkSource(id, `step "${id}".loopVars[${vr.name}]`, vr.initial);
      }
    }
  }
  // Flow-level output rows — what the automation hands its caller.
  const rows = (model as { output?: { rows?: unknown } })?.output?.rows;
  if (Array.isArray(rows)) {
    for (const r of rows as Array<unknown>) {
      if (!r || typeof r !== "object" || Array.isArray(r)) continue;
      const rr = r as Record<string, unknown>;
      const name = typeof rr.name === "string" && rr.name ? rr.name : "(unnamed row)";
      checkSource(null, `output row "${name}"`, rr.source, true);
    }
  }
  return found;
}

/**
 * One unknown-binding finding in words, naming the reader, the missing step and
 * the steps that do exist — the sentence every layer reports, so a redraft that
 * fixes one layer's wording fixes them all. The trailing token is the stable
 * rule name (`unknown_binding_step`); the validator carries it in `rule` as well.
 */
export function unknownBindingMessage(ref: UnknownBindingRef, declaredIds: readonly string[]): string {
  const have = declaredIds.length ? ` (steps: ${declaredIds.join(", ")})` : " (steps: none)";
  return (
    `${ref.reader} reads step "${ref.missingStepId}", which is not a step in this flow${have}. ` +
    `Point it at a step that exists, or add the missing one back — unknown_binding_step.`
  );
}


export function validateModel(model: FlowModel): void {
  // The single read boundary for everything the compiler checks or emits: a v1
  // model upgrades here (never throws; unparseable expressions stay as written
  // with null bindings), so the yaml route, deploy, replay and approval — every
  // path that reaches `compile` or this function — see v2. Idempotent, so the
  // double normalise through `compile` below is a pass-through, not a rewrite.
  model = normaliseModel(model) as unknown as FlowModel;
  if (!ID_RE.test(model.id) && !/^[a-z][a-z0-9-]{0,62}$/.test(model.id)) {
    throw new FlowCompileError(`flow id "${model.id}" is not slug-shaped`);
  }
  if (!Array.isArray(model.steps) || model.steps.length === 0) {
    throw new FlowCompileError("a flow must declare at least one step");
  }
  // ── Complexity-plan seam (Phase 0.2): flow-level failure handling ─────────────
  //
  // Same rule as the per-step `failureMode` refusal in the step loop below, at
  // the flow level: absent or `"none"` is today's behaviour; anything else
  // would claim a run-wide failure policy the emitted YAML contains nothing
  // for. Narrowed with `in` — the key is not on `FlowModel` yet, so reading it
  // off the narrowed union would miss it rather than refuse it.
  const rawModel: unknown = model;
  const flowFailureMode =
    typeof rawModel === "object" && rawModel !== null && "failureMode" in rawModel
      ? rawModel.failureMode
      : undefined;
  if (flowFailureMode !== undefined && flowFailureMode !== "none") {
    throw new FlowCompileError(
      `this flow declares \`failureMode\` "${String(flowFailureMode)}" — ` +
        `flow-level failure handling is not emitted yet (complexity plan Phase 3)`,
    );
  }

  const inputIds = new Set<string>();
  for (const input of model.inputs ?? []) {
    if (!ID_RE.test(input.id)) throw new FlowCompileError(`input id "${input.id}" is not slug-shaped`);
    if (inputIds.has(input.id)) throw new FlowCompileError(`duplicate input "${input.id}"`);
    if (!INPUT_TYPES.has(input.type)) {
      throw new FlowCompileError(`input "${input.id}" has unsupported type "${input.type}"`);
    }
    inputIds.add(input.id);
  }

  const seen = new Set<string>();
  for (const step of model.steps) {
    if (!ID_RE.test(step.id)) throw new FlowCompileError(`step id "${step.id}" is not slug-shaped`, step.id);
    if (RESERVED_STEP_IDS.has(step.id)) {
      throw new FlowCompileError(
        `step id "${step.id}" is reserved — the compiler emits a task with that id`,
        step.id,
      );
    }
    if (seen.has(step.id)) throw new FlowCompileError(`duplicate step id "${step.id}"`, step.id);
    seen.add(step.id);
    // ── Complexity-plan seams (Phase 0.2): declared-but-unemitted kinds ─────────
    //
    // ⚠ BEFORE the generic `runtime: null` refusal below AND the `KINDS`
    // allowlist: each of these three needs a sentence naming the kind, what it
    // would DO, and which phase unlocks it — not "declared but has no emitter"
    // and not the allowlist's union-shaped error. Narrowed with `in` — `join`
    // is in neither the registry nor `FlowStepKind` yet, so reading it off the
    // narrowed union would be the union parse error this refusal replaces.
    const rawStep: unknown = step;
    const rawKind =
      typeof rawStep === "object" && rawStep !== null && "kind" in rawStep ? rawStep.kind : undefined;
    if (rawKind === "iteration") {
      throw new FlowCompileError(
        `step "${step.id}" is an \`iteration\` step, which runs its child steps once per array item — ` +
          `this compiler emits no per-item loop yet (complexity plan Phase 1)`,
        step.id,
      );
    }
    if (rawKind === "loop") {
      throw new FlowCompileError(
        `step "${step.id}" is a \`loop\` step, which repeats its child steps until a test holds — ` +
          `this kind stays reserved with no emitter yet`,
        step.id,
      );
    }
    if (rawKind === "join") {
      throw new FlowCompileError(
        `step "${step.id}" is a \`join\` step, which combines one upstream step's fanned-out rows — ` +
          `this compiler emits no join yet (complexity plan Phase 2)`,
        step.id,
      );
    }

    // ── Complexity-plan seam (Phase 0.2): step-level failure handling ───────────
    //
    // `failureMode` defaults to `"none"`; anything else names behaviour (what
    // the run does when this step fails) this compiler emits nothing for.
    // Refused by name rather than stripped: silently running with `"none"`
    // semantics while the model says otherwise is the appended-gate shape —
    // a guard that reads as present on the canvas and does nothing at runtime.
    const failureMode =
      typeof rawStep === "object" && rawStep !== null && "failureMode" in rawStep
        ? rawStep.failureMode
        : undefined;
    if (failureMode !== undefined && failureMode !== "none") {
      throw new FlowCompileError(
        `step "${step.id}" declares \`failureMode\` "${String(failureMode)}" — ` +
          `per-step failure handling is not emitted yet (complexity plan Phase 3)`,
        step.id,
      );
    }

    // ⚠ BEFORE `validateRetry` and the `KINDS` allowlist: a declared-but-
    // unimplemented kind is refused for having no emitter, whatever else it
    // carries. Offering a type before its emitter is how `notify` happened
    // (authorable, unemittable); the registry's `runtime: null` is what stops
    // the repeat, and this is the save-time half of it.
    if (NODE_TYPES[step.kind]?.runtime === null) {
      throw new FlowCompileError(
        `step "${step.id}" is a \`${step.kind}\` step, which is declared but has no emitter yet`,
        step.id,
      );
    }

    validateRetry(step);

    if (!KINDS.has(step.kind)) {
      // The R8 allowlist. Reached by an unknown kind and by `code` until
      // Phase 4 teaches this compiler to emit them.
      throw new FlowCompileError(
        `step kind "${(step as { kind: string }).kind}" is not emittable; ` +
          `allowed: ${[...KINDS].join(", ")}`,
        step.id,
      );
    }

    if (step.kind === "transform") {
      // Dual read (property-rows project): a converted step drops `expr` and
      // renders from its typed rows instead. Refused only with neither — the
      // same rule, widened evidence.
      if (!step.expr?.trim() && !hasTransformRows(step))
        throw new FlowCompileError(`transform "${step.id}" has no expression`, step.id);
    } else if (step.kind === "code") {
      // Assertion 30 — an empty `script:` must never reach Kestra. Generation
      // is an AUTHOR-time operation (§5.3.1); a flow that deploys without its
      // fragment would need Kestra to trigger generation, which inverts the
      // model. An import arrives with the code stripped, so this is the path
      // that catches "imported but never regenerated" too.
      if (!step.code?.trim() || CODE_PLACEHOLDERS.test(step.code)) {
        throw new FlowCompileError(
          `code step "${step.id}" has no generated fragment — generate it before deploying ` +
            `(an imported flow arrives with code stripped and must be regenerated)`,
          step.id,
        );
      }
      if (!/(^|\n)\s*def\s+run\s*\(/.test(step.code)) {
        // The wrapper calls `run(payload)`. Without it the container raises
        // NameError at the last line, which reads as a wrapper bug.
        throw new FlowCompileError(
          `code step "${step.id}" must define \`run(payload)\` — the wrapper calls it`,
          step.id,
        );
      }
      // Dual read: a converted step carries bindings instead of the display
      // string. Refused only in its pre-normalise shape (neither key at all —
      // the routes still 400 that via the schema); a normalised blank (`{}` →
      // `inputs: []`) renders as blank below, exactly as the old emitter did.
      // Same refusal, same message — the rule is unchanged, only the evidence
      // it accepts widened. `inputBindings` (property-rows project) joins
      // `inputs` as evidence: an empty array renders the blank, a populated
      // one renders the input object.
      if (!step.inputExpr?.trim() && step.inputs === undefined && step.inputBindings === undefined) {
        throw new FlowCompileError(`code step "${step.id}" has no input expression`, step.id);
      }
      // Shape backstop (run 4171a39b): a non-blank `inputExpr` wins VERBATIM at
      // emit, bypassing the structured feed `buildCodeInput` renders as `{...}`
      // BY CONSTRUCTION — so a blob that is not a JSON object dies in the
      // runner's `json.load` with every other check green. The op layer refuses
      // the same blob first, but canvas/import paths bypass ops: this BLOCKS.
      // One implementation — `checkCodeInputExpr` in `@foundry/flow-edit` — so
      // the two layers cannot disagree about what an object is. Coverage reads
      // the bound names (the contract's shadow here; a compiler `CodeStep`
      // carries no contract): explicitly-unbound (`null`-source) names are not
      // feed keys, so they are not required.
      if (step.inputExpr?.trim()) {
        const bound = new Set<string>();
        for (const b of step.inputs ?? []) if (b.source !== null) bound.add(b.name);
        for (const b of step.inputBindings ?? []) if (b.source !== null) bound.add(b.name);
        const malformed = checkCodeInputExpr(step.id, step.inputExpr, [...bound]);
        if (malformed) throw new FlowCompileError(malformed, step.id);
      }
      if (!Array.isArray(step.outputKeys) || step.outputKeys.length === 0) {
        // A `code` step with no declared output shape is a step whose contract
        // cannot be checked, which is the condition §6.7 says produces invented
        // values. Refusing here is cheaper than discovering it downstream.
        throw new FlowCompileError(
          `code step "${step.id}" declares no output fields — there would be no contract to check`,
          step.id,
        );
      }
      for (const k of step.outputKeys) {
        if (!ID_RE.test(k)) {
          throw new FlowCompileError(`code step "${step.id}" output field "${k}" is not slug-shaped`, step.id);
        }
      }
    } else if (step.kind === "approval") {
      if (!step.summaryExpr?.trim() && !(step.summary !== undefined && step.summary.trim())) {
        // An approval with no question is a button. The summary is the whole
        // difference between a gate and a delay.
        throw new FlowCompileError(
          `approval step "${step.id}" has no summary — an approver would be asked to approve a task id`,
          step.id,
        );
      }
      if (step.awaitSeconds !== undefined) {
        // Floor 60s, ceiling 7 days. The ceiling is far higher than a machine's
        // day because the thing being waited on is a person, and the floor is
        // higher than a machine wait's floor because no human answers in half a minute
        // — a 30s approval gate is a gate that always times out, which reads as
        // a broken flow rather than as a misconfiguration.
        if (
          !Number.isInteger(step.awaitSeconds) ||
          step.awaitSeconds < 60 ||
          step.awaitSeconds > 604_800
        ) {
          throw new FlowCompileError(
            `approval step "${step.id}" awaitSeconds must be an integer 60..604800 (7 days)`,
            step.id,
          );
        }
      }
    } else if (step.kind === "branch") {
      // ⚠ The condition is checked for PRESENCE here and for shape by
      // `validateModelExpressions` (D-22's allowlist) and `checkSpanBalance`
      // (I-113 — the allowlist checks which functions are called and never
      // checked that the expression PARSES, and Kestra accepts an unparseable
      // Pebble expression at validate time and fails at render time).
      // ⚠ An `else` legitimately has none — it is the arm that runs when the
      // branch it continues was false, so there is nothing for it to test. The
      // chain checks below refuse a conditionless branch that is NOT one, and
      // they say so by name; this check would otherwise refuse every `else`
      // before that reasoning ever ran.
      if (!hasBranchCondition(step) && !step.elseOf) {
        throw new FlowCompileError(`branch step "${step.id}" has no condition`, step.id);
      }
    } else if (step.kind === "merge") {
      // Everything a merge needs checking for is CROSS-step — do the named
      // sources exist, are they kinds that produce a JSON result, do they come
      // earlier — so it is all in the dedicated loop further down, where the
      // whole model is in hand. This branch exists so the `else` below narrows
      // to `CallStep` and reads `ref`/`paramsExpr` off something that has them.
      //
      // ⚠ Deleting it does not produce a type error at the call site — it
      // produces a merge step being validated as a tool call, failing on a ref
      // it was never supposed to carry.
    } else if (step.kind === "for_each" || step.kind === "collect") {
      // Cross-step, like a merge — see `validateLoops`, which has the whole model in hand.
    } else if (step.kind === "tool" || step.kind === "datasource" || step.kind === "query") {
      if (!REF_RE.test(step.ref ?? "")) {
        throw new FlowCompileError(`step "${step.id}" has a malformed ref "${step.ref}"`, step.id);
      }
      // Dual read (property-rows project): a `params` record with at least one
      // row joins `paramsExpr` and `inputs` as evidence. Same refusal, same
      // message — the rule is unchanged, only the evidence it accepts widened.
      if (!step.paramsExpr?.trim() && !(step.inputs?.length) && !Object.keys(step.params ?? {}).length)
        throw new FlowCompileError(`step "${step.id}" has no params`, step.id);
      if (step.timeoutSeconds !== undefined) {
        if (!Number.isInteger(step.timeoutSeconds) || step.timeoutSeconds < 1 || step.timeoutSeconds > 3600) {
          throw new FlowCompileError(
            `step "${step.id}" timeoutSeconds must be an integer 1..3600`,
            step.id,
          );
        }
      }
    } else if (step.kind === "llm" || step.kind === "http") {
      // Wave 1 Foundry-callback steps — reachable because the emit loop below
      // handles them. Shape is enforced by `stepSchema`; the save refusals
      // (empty/unconfigured model, literal token, empty url) live in
      // `flow-validator.service.ts`'s checks, which name the step and run on
      // every write — this branch exists so the allowlist below does not
      // refuse kinds that now have emitters.
    } else {
      // Unreachable: `runtime: null` kinds are refused above, unknown kinds by
      // the `KINDS` allowlist. The narrowing leaves only those two here for the
      // type system, which cannot see either guarantee — so this arm re-states
      // the allowlist, reading `step.kind` directly with no assertion.
      throw new FlowCompileError(
        `step kind "${step.kind}" is not emittable; ` + `allowed: ${[...KINDS].join(", ")}`,
        step.id,
      );
    }
  }

  // An `approval` step synthesises a SECOND task id. Kestra would
  // reject the duplicate, but its message names `x_await` as if the model had
  // declared it.
  //
  // ⚠ This loop is per-kind and `approval` was missing from it for the length of
  // one test run. It used to cover only one of the two kinds that emit
  // `<id>_await`, which is a check that silently stops covering half the cases
  // the day a kind is added — which is exactly what happened. One kind emits it
  // today; the loop stays a loop for the day a second one returns.
  for (const step of model.steps) {
    if (step.kind !== "approval") continue;
    for (const id of [`${step.id}${AWAIT_SUFFIX}`]) {
      if (seen.has(id)) {
        throw new FlowCompileError(
          `${step.kind} step "${step.id}" needs the task id "${id}", which another step already uses`,
          step.id,
        );
      }
    }
  }
  // Every binding that names a step must name one that exists — `collectUnknownBindingSteps`
  // above. `seen` holds every declared id by now, so this is existence regardless
  // of order (a forward read is a topology question for the dependency checks).
  {
    const declared = [...seen];
    for (const ref of collectUnknownBindingSteps(model)) {
      throw new FlowCompileError(unknownBindingMessage(ref, declared), ref.stepId ?? undefined);
    }
  }


  // Dependencies: must exist, and must not cycle. `begin` is an implicit
  // dependency of everything and is not nameable.
  for (const step of model.steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!seen.has(dep)) {
        throw new FlowCompileError(`step "${step.id}" depends on unknown step "${dep}"`, step.id);
      }
      if (dep === step.id) throw new FlowCompileError(`step "${step.id}" depends on itself`, step.id);
    }
  }
  assertAcyclic(model.steps);

  // ── branch guards — foundations Phase 3 ────────────────────────────────────
  //
  // ⚠ Every refusal here is a refusal to GUESS about the engine. A `Pause`
  // inside a conditional block and a nested `If` are both plausible and both
  // unverified against this engine, and the failure mode for guessing is the
  // worst one this product has: it fails at RENDER time, after approval, on a
  // schedule, with an error naming neither step nor field (I-113's shape).
  // Refusing costs a feature nobody has asked for; a wrong guess is discovered
  // by a customer.
  // ── if / elif / else, through `elseOf` ──────────────────────────────────────
  //
  // ⚠ Every one of these refusals exists because the alternative COMPILES and
  // does something else. A dangling `elseOf` emits an arm nobody nests, so it
  // runs unconditionally; two branches continuing one branch means the second
  // silently replaces the first in `continuedBy`; a cycle never terminates the
  // recursion. None of those is a YAML error.
  {
    const byId = new Map(model.steps.map((s) => [s.id, s]));
    const claimed = new Map<string, string>();
    for (const step of model.steps) {
      if (step.kind !== "branch" || !step.elseOf) continue;
      const target = byId.get(step.elseOf);
      if (!target) {
        throw new FlowCompileError(
          `branch "${step.id}" continues "${step.elseOf}", which is not a step in this flow`,
          step.id,
        );
      }
      if (target.kind !== "branch") {
        throw new FlowCompileError(
          `branch "${step.id}" continues "${step.elseOf}", which is a ${target.kind} step — ` +
            `only a condition can have an "otherwise"`,
          step.id,
        );
      }
      if (!hasBranchCondition(target)) {
        throw new FlowCompileError(
          `branch "${step.id}" continues "${step.elseOf}", which is itself an "otherwise" and tests ` +
            `nothing — there is no condition left to be false`,
          step.id,
        );
      }
      const already = claimed.get(step.elseOf);
      if (already) {
        throw new FlowCompileError(
          `branches "${already}" and "${step.id}" both continue "${step.elseOf}" — a condition has ` +
            `one "otherwise", not two`,
          step.id,
        );
      }
      claimed.set(step.elseOf, step.id);
      if (step.dependsOn?.length) {
        // Otherwise it would be inside the arm it is meant to be the ALTERNATIVE
        // to — `armOf` is transitive, so an `elif` depending on its own `if`
        // runs only when that `if` was true, which is exactly backwards.
        throw new FlowCompileError(
          `branch "${step.id}" continues "${step.elseOf}" and also runs after ` +
            `${step.dependsOn.join(", ")}. A continuation cannot do both: it would sit inside the ` +
            `arm it is the alternative to`,
          step.id,
        );
      }
    }
    // A cycle: follow each chain and refuse if it revisits.
    for (const step of model.steps) {
      if (step.kind !== "branch" || !step.elseOf) continue;
      const seen = new Set<string>([step.id]);
      let cur: string | undefined = step.elseOf;
      while (cur) {
        if (seen.has(cur)) {
          throw new FlowCompileError(
            `the "otherwise" chain through branch "${step.id}" loops back on itself`,
            step.id,
          );
        }
        seen.add(cur);
        const nxt = byId.get(cur);
        cur = nxt && nxt.kind === "branch" ? nxt.elseOf : undefined;
      }
    }
    // A branch that is neither a condition nor a continuation tests nothing and
    // continues nothing — it would emit no task and hoist its arm to top level,
    // i.e. a guard that guards nothing while looking like one.
    for (const step of model.steps) {
      if (step.kind !== "branch") continue;
      if (!hasBranchCondition(step) && !step.elseOf) {
        throw new FlowCompileError(
          `branch "${step.id}" has no condition. Only an "otherwise" may omit one, and an ` +
            `"otherwise" has to say which condition it follows`,
          step.id,
        );
      }
    }
  }

  for (const step of model.steps) {
    if (step.kind !== "branch") continue;
    const arm = armOf(model, step.id);
    if (!arm.length) {
      // Kestra's `If` requires at least one task under `then:`. An empty arm is
      // also meaningless: a condition guarding nothing.
      throw new FlowCompileError(
        `branch "${step.id}" guards nothing — no step runs after it, so the condition decides nothing. ` +
          `To guard steps, insert the branch BEFORE them (between two steps), not after the last one`,
        step.id,
      );
    }
    for (const inner of arm) {
      /**
       * ⚠ **A PAUSE USED TO BE REFUSED HERE AND IS NOW ALLOWED
       * — because the measurement that was missing got taken.**
       *
       * The old refusal said *"a pause … is unverified inside a conditional
       * block on this engine, and an unverified guess here fails at render
       * time, after approval"*. That was the honest thing to write with no
       * evidence, and it was a want of evidence, never a guarantee.
       *
       * Measured 2026-09-04 against v1.3.29: a `core.flow.Pause` inside an `If`
       * arm **works end to end** — validate 200, execution PAUSED with
       * `gate:RUNNING, hold:PAUSED`, resume 204, the arm completed AND the
       * top-level tail ran. `approval` IS that shape, so it is admitted.
       *
       * ⚠ **A nested `branch` stays refused, and NOT for the same reason.** The
       * engine supports it — nested `If` with a native `else:` was measured
       * working in the same pass — but Foundry's assembler nests through
       * `elseOf` and renders one arm at a fixed depth, so emitting a branch
       * inside a branch needs recursive emission that does not exist yet. This
       * is a compiler limit that knows it is one.
       */
      if (inner.kind === "branch") {
        throw new FlowCompileError(
          `branch "${step.id}" guards another condition ("${inner.id}"), which is not supported. ` +
            `The engine allows a nested condition; this compiler does not emit one yet — its ` +
            `assembler nests arms through "otherwise", not recursively`,
          step.id,
        );
      }
    }
  }

  /**
   * ⚠ **The one hole `armOf`'s merge exemption leaves open, closed by name.**
   *
   * `armOf` skips merge steps, so a merge is never an arm member and neither is
   * anything reachable only through one. But a step depending on a merge AND on
   * an arm member directly is still reached by that second edge — so it is an
   * arm member, gets emitted inside the `then:` block, and reads
   * `outputs.<merge>` which has not run at that point. That renders as a
   * failure mid-arm, after approval.
   *
   * It is refused rather than repaired because both repairs are worse: pulling
   * the step out of the arm silently ignores a dependency the author wrote, and
   * pulling the merge in destroys the exemption for everyone else.
   */
  const mergeIds = new Set(model.steps.filter((s) => s.kind === "merge").map((s) => s.id));
  if (mergeIds.size) {
    for (const step of model.steps) {
      if (step.kind !== "branch") continue;
      for (const inner of armOf(model, step.id)) {
        const via = (inner.dependsOn ?? []).find((d) => mergeIds.has(d));
        if (via) {
          throw new FlowCompileError(
            `step "${inner.id}" runs inside branch "${step.id}" and also reads the merge "${via}". ` +
              `A merge runs AFTER the whole condition, so a step inside an arm cannot read one — ` +
              `move "${inner.id}" after the merge, or drop its dependency on the arm`,
            inner.id,
          );
        }
      }
    }
  }

  // ── merge sources — the shared tail after a branch ──────────────────────────
  validateLoops(model);

  const orderOf = new Map(model.steps.map((s, i) => [s.id, i]));
  for (const step of model.steps) {
    if (step.kind !== "merge") continue;
    if (step.sources.length < 2) {
      // A merge of one is a rename with a coalesce bolted on: it produces
      // exactly what its single source produced, and reads on the canvas as a
      // join that joins nothing.
      throw new FlowCompileError(
        `merge "${step.id}" names ${step.sources.length} source. A merge combines the results of ` +
          `two or more steps — with one there is nothing to choose between`,
        step.id,
      );
    }
    if (new Set(step.sources).size !== step.sources.length) {
      throw new FlowCompileError(
        `merge "${step.id}" names the same source twice. The second can never be reached — the ` +
          `first already matched`,
        step.id,
      );
    }
    for (const src of step.sources) {
      const target = model.steps.find((s) => s.id === src);
      if (!target) {
        throw new FlowCompileError(
          `merge "${step.id}" names "${src}", which is not a step in this flow`,
          step.id,
        );
      }
      if (target.id === step.id) {
        throw new FlowCompileError(`merge "${step.id}" names itself as a source`, step.id);
      }
      if (!MERGE_SOURCE_KINDS.has(target.kind)) {
        throw new FlowCompileError(
          `merge "${step.id}" names "${src}", which is a ${target.kind} step. A merge can only ` +
            `combine steps that produce a JSON result — ` +
            `${[...MERGE_SOURCE_KINDS].join(", ")}. See the step's own output shape for what it does produce`,
          step.id,
        );
      }
      // Kestra runs tasks in emission order and the assembler emits in model
      // order, so a merge placed before one of its sources reads a task that
      // has not run yet — and `??` would quietly hand back the wrong arm's
      // value or the "null" fallback rather than failing. Same reasoning as
      // gate 3's placement rule: order is the mechanism, so order is checked.
      if ((orderOf.get(src) ?? 0) > (orderOf.get(step.id) ?? 0)) {
        throw new FlowCompileError(
          `merge "${step.id}" comes before its source "${src}". A merge reads what earlier steps ` +
            `produced, so it must sit after every step it combines`,
          step.id,
        );
      }
    }
  }

  /**
   * ⚠ **A step may be guarded by at most ONE branch**, and this is the check
   * that nearly was not written.
   *
   * The obvious refusal — *"nothing outside an arm may depend on a step inside
   * it"* — is **unreachable**, and it was written, tested and deleted before it
   * shipped. An arm is the transitive closure of `dependsOn`, so a step that
   * depends on an arm member IS an arm member: the condition can never be true.
   * That is I-38 exactly, and the test that "proved" it was the thing that
   * showed it could not fire.
   *
   * The real hazard is two arms overlapping. A step reachable from two branches
   * would be emitted inside ONE `then:` block, so the other branch's condition
   * would be silently ignored for it — a guard that reads as present on the
   * canvas and does nothing at runtime, which is the same shape as an appended
   * approval gate.
   */
  const armedBy = new Map<string, string>();
  for (const step of model.steps) {
    if (step.kind !== "branch") continue;
    for (const inner of armOf(model, step.id)) {
      const already = armedBy.get(inner.id);
      if (already && already !== step.id) {
        throw new FlowCompileError(
          `step "${inner.id}" runs after both branch "${already}" and branch "${step.id}". ` +
            `A step can be guarded by only one condition — the second would be silently ignored`,
          inner.id,
        );
      }
      armedBy.set(inner.id, step.id);
    }
  }

  if (model.schedule) {
    assertCron(model.schedule.cron);
    if (model.schedule.timezone && !TZ_RE.test(model.schedule.timezone)) {
      throw new FlowCompileError(`schedule timezone "${model.schedule.timezone}" is malformed`);
    }
  }
  // ── Declared webhook/api trigger names — Phase 6 ───────────────────────────
  //
  // The SAME rule `createTriggerSchema` enforces (trigger.service.ts): a
  // non-empty string of at most 255 characters. A declared trigger is
  // materialised as a `triggers` row when the flow is saved, so a name this
  // rule refuses could never be created under that schema. Checked here rather
  // than by the type system because a model arrives as JSON from `POST /flows`
  // and from an imported bundle — TypeScript is not in the room at either
  // point.
  // ⚠ `webhook` retired 2026-09-08 — it can no longer be declared, so there is
  // nothing here to name-check. `api` is what replaced it.
  for (const [type, decl] of [["api", model.api]] as const) {
    if (!decl) continue;
    const name: unknown = decl.name;
    if (typeof name !== "string" || name.length < 1 || name.length > TRIGGER_NAME_MAX) {
      throw new FlowCompileError(
        `the declared ${type} trigger name must be a non-empty string of at most ` +
          `${TRIGGER_NAME_MAX} characters (the trigger API's rule), got ` +
          `${typeof name === "string" ? JSON.stringify(name) : String(name)}`,
      );
    }
  }
  if (model.concurrencyLimit !== undefined) {
    if (!Number.isInteger(model.concurrencyLimit) || model.concurrencyLimit < 1) {
      throw new FlowCompileError("concurrencyLimit must be a positive integer");
    }
  }
}

function assertAcyclic(steps: FlowStep[]) {
  const deps = new Map(steps.map((s) => [s.id, s.dependsOn ?? []]));
  const state = new Map<string, 0 | 1 | 2>();
  const walk = (id: string, trail: string[]) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      throw new FlowCompileError(`dependency cycle: ${[...trail, id].join(" → ")}`, id);
    }
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) walk(d, [...trail, id]);
    state.set(id, 2);
  };
  for (const s of steps) walk(s.id, []);
}

// ── YAML emission ────────────────────────────────────────────────────────────

/**
 * A double-quoted YAML scalar.
 *
 * Only ever given values this module controls or has validated against a
 * charset, but quoted-and-escaped anyway: an emitter that is safe *because of
 * its callers* stops being safe the first time it gains one.
 */
function q(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The Pebble expression for one `ComputedInputFn` — the SINGLE place the
 * engine's spelling lives.
 *
 * `ROOT` is the run's firing time: `trigger.date` when the model declares a
 * schedule, `now()` otherwise. The coalesced form is load-bearing, not style:
 * a bare `trigger.date` is unresolvable on a MANUAL fire of a scheduled flow
 * (measured 2026-09-14: execution creation 422s "Unable to find `trigger`"),
 * while `(trigger.date ?? now())` renders on both paths — the scheduled tick
 * on schedule fires, creation time on hand fires.
 *
 * ── Measured 2026-09-14 against Kestra 1.3.29 (`foundry.default.hr.draft`) ──
 * A `now() | dateAdd(-1,'MONTHS') | date('yyyy-MM')` defaults render on a
 * manual fire → `2026-08`. B `trigger.date | date('yyyy-MM')` defaults render
 * on a SCHEDULED fire → `2026-09`. C `timeZone='Europe/London'` is honored
 * (`14:25` vs `13:25` UTC). D the Schedule trigger's own `inputs:` block is
 * dynamic with a `now()` root → `2026-08`. Negative controls, same day:
 * `trigger.date` and `execution.startDate` do NOT resolve in trigger-eval
 * context (the scheduled execution dies before creation), and bare
 * `trigger.date` does not resolve on a manual fire. `(trigger.date ?? now())`
 * with `dateAdd(-1,'MONTHS')` renders on a manual fire → `2026-08`, and the
 * same expression with `trigger.date` renders on a schedule → `2026-08`.
 *
 * M1 follows: computed values are emitted into the input's own `defaults:`,
 * which covers every firing path, because defaults apply whenever no value is
 * sent. `TZ` is appended only when the model sets a timezone AND `timeZone=`
 * was proven (C) — otherwise the engine's server default governs.
 */
export function computedInputExpression(
  fn: ComputedInputFn,
  opts: { scheduled: boolean; timezone?: string; offsetDays?: number },
): string {
  // Slice 5d: "N days before the day it runs" — the same `dateAdd(n, 'DAYS')` as `priorDate` (measured 2026-09-14), with n an
  // integer checked here, so nothing but digits and a sign reaches the expression.
  if (opts.offsetDays !== undefined) {
    if (fn !== "currentDate" || !Number.isInteger(opts.offsetDays) || Math.abs(opts.offsetDays) > 3650) {
      throw new FlowCompileError(`a day offset (${opts.offsetDays}) is a whole number of days within ten years, on currentDate only`);
    }
  }
  // ⚠ The timezone is author-controlled (`schedule.timezone`, free text up to
  // 64 chars) and is embedded inside a Pebble string literal — a quote in it
  // would break out of the literal. IANA names need only these chars, so
  // anything else refuses to compile rather than emitting a guess.
  if (opts.timezone !== undefined && !/^[A-Za-z0-9_+/-]+$/.test(opts.timezone)) {
    throw new FlowCompileError(
      `schedule.timezone "${opts.timezone}" cannot be used in a computed input — ` +
        `use an IANA name like "Europe/London".`,
    );
  }
  const root = opts.scheduled ? "(trigger.date ?? now())" : "now()";
  const tz = opts.timezone ? `, timeZone='${opts.timezone}'` : "";
  switch (fn) {
    case "priorMonth":
      return `{{ ${root} | dateAdd(-1, 'MONTHS') | date('yyyy-MM'${tz}) }}`;
    case "currentMonth":
      return `{{ ${root} | date('yyyy-MM'${tz}) }}`;
    case "priorDate":
      return `{{ ${root} | dateAdd(-1, 'DAYS') | date('yyyy-MM-dd'${tz}) }}`;
    case "currentDate":
      return opts.offsetDays ? `{{ ${root} | dateAdd(${opts.offsetDays}, 'DAYS') | date('yyyy-MM-dd'${tz}) }}` : `{{ ${root} | date('yyyy-MM-dd'${tz}) }}`;
    case "currentYear":
      return `{{ ${root} | date('yyyy'${tz}) }}`;
    case "runTimestamp":
      return `{{ ${root} }}`;
    // The FIRST DAY of the month it runs (or of the month before) — "from the start of the month" as a date (2026-10-01: a read's
    // `from_date` could only be the day it runs). Built from pieces already measured on the engine: the month as `yyyy-MM` (above)
    // and `~` concatenation (I-11), so nothing here is a new Pebble name. The month's LAST day needs date parsing in Pebble, which
    // has not been measured, and is not offered.
    case "currentMonthStart":
      return `{{ (${root} | date('yyyy-MM'${tz})) ~ '-01' }}`;
    case "priorMonthStart":
      return `{{ (${root} | dateAdd(-1, 'MONTHS') | date('yyyy-MM'${tz})) ~ '-01' }}`;
  }
}

/**
 * Re-indent a free-text expression into a `|` block scalar.
 *
 * This is the containment. Every line is prefixed with the block's indent, so
 * whatever the expression contains — newlines, `type:`, a `- id:` that looks
 * like a sibling task — stays a line of the scalar. There is no sequence of
 * characters that ends the block early, because ending it requires DEDENTING,
 * and nothing here can emit less indentation than it is given.
 */
function block(expr: string, indent: string): string {
  const lines = expr.replace(/\r\n/g, "\n").replace(/\s+$/, "").split("\n");
  return lines.map((l) => `${indent}${l}`).join("\n");
}
// ── Typed display rendering (Stage 3.3) ───────────────────────────────────────
//
// The dual-representation read rule, in one place: an old display string that
// is PRESENT is returned verbatim (the upgrade left it as written because the
// expression is unreadable, partial, or hand-shaped); when it is ABSENT the
// step was converted and the typed fields render through `render.ts` — the one
// module the panel also uses, so a `test` is rendered once, at compile time.
//
// Every helper returns `null` when there is nothing to render (no old string,
// no usable typed fields). Emit sites turn that into a refusal naming the step
// (`validateModel` already refused the truly-empty, so null there is
// writer-written garbage, never history); `structureHash` and the portability
// bundle read it as "nothing", which is what their old code hashed/omitted
// for the same absence. Nothing here guesses: a binding whose source is `null`
// is unknown, and an unknown input refuses rather than renders a subset.

/** Server catalogue shapes, in the partial form the renderers read. */
const RENDER_SHAPES = OUTPUT_SHAPES as unknown as RenderShapes;

/** One model step as the renderers see it (they speak `AuthoredStep`). */
function typedStep(steps: FlowStep[], id: string): AuthoredStep | null {
  const found = steps.find((x) => x.id === id);
  // Same step, the renderers' view: `AuthoredStep` is the shape carrying the
  // typed fields this module reads, and the two interfaces describe one row.
  const typed = found as unknown as AuthoredStep | undefined;
  return typed ?? null;
}

/** A binding's source — throws naming the step when it is unknown (`null`),
 *  which refuses rather than renders a subset (see the block comment above). */
function boundSource(b: InputBinding, stepId: string): Source {
  if (!b.source) {
    throw new FlowCompileError(
      `step "${stepId}" has an unbound input "${b.name}" — rebind it before deploying`,
      stepId,
    );
  }
  return b.source;
}

/** A branch has something to test — display string, typed test (`null` is
 *  unknown-with-display, not a condition), or at least one typed `conditions`
 *  row (property-rows project). */
function hasBranchCondition(step: BranchStep): boolean {
  return (
    !!step.conditionExpr?.trim() ||
    (step.test !== undefined && step.test !== null) ||
    (step.conditions?.length ?? 0) > 0
  );
}
/** A transform carries typed rows to render from when `expr` is absent. */
function hasTransformRows(step: TransformStep): boolean {
  return (step.inputBindings?.length ?? 0) > 0 || (step.outputColumns?.length ?? 0) > 0;
}
// ── Typed property rows (property-rows project) ───────────────────────────────
//
// A converted step dropped its display string; these render the rows into the
// exact runtime shapes the displays already produce. Every refusal names the
// step and the row: a feed that cannot be rendered honestly refuses at save
// rather than emitting a subset (the same rule the Stage-3 helpers keep).

/** `{{#stepId.field#}}` — the panel's neutral placeholder for an upstream field. */
const ROW_PLACEHOLDER_RE = /\{\{#([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z0-9_]+)#\}\}/g;

/** A whole `{{ … }}` span, and nothing else — the only template spliced raw. */
const SINGLE_SPAN_RE = /^\{\{\s*([\s\S]+?)\s*\}\}$/;

/**
 * One upstream field as a scalar Pebble read, through the envelope table
 * (`OUTPUT_SHAPES`) — the `{{#stepId.field#}}` expansion. Query-shaped outputs
 * are rows, so those read the first row's field; an empty result reads null,
 * which renders as nothing — the honest miss, not a guess at which row.
 */
function stepFieldRead(steps: FlowStep[], stepId: string, refStepId: string, field: string): string {
  const target = steps.find((s) => s.id === refStepId);
  if (!target) {
    throw new FlowCompileError(`step "${stepId}" reads "${refStepId}", which is not a step in this flow`, stepId);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) {
    throw new FlowCompileError(
      `step "${stepId}" reads column "${field}" of "${refStepId}", which is not a plain field name`,
      stepId,
    );
  }
  switch (target.kind) {
    case "transform":
    case "merge":
    case "for_each":
    case "collect":
      return `json(outputs.${refStepId}.value).${field}`;
    case "code":
      return `outputs.${refStepId}.vars.result.${field}`;
    case "tool":
    case "llm":
    case "http":
      return `json(outputs.${refStepId}.body).${field}`;
    case "datasource":
    case "query":
      // A fan-out read ran once per element: its rows are every call's, not call 0's.
      return (target as { over?: { stepId?: string } | null }).over?.stepId
        ? `${allResultsRows(`json(outputs.${refStepId}.body)`)} | jq('first | .${field}') | first`
        : `json(outputs.${refStepId}.body).results[0].data | jq('first | .${field}') | first`;
    default:
      throw new FlowCompileError(
        `step "${stepId}" reads "${refStepId}", which is a ${target.kind} step — it produces no value to read a field from`,
        stepId,
      );
  }
}

/** Expand every `{{#stepId.field#}}` in an authored template. Anything else in
 *  the template is Pebble the save-time allowlist already scanned. */
function expandRowPlaceholders(template: string, steps: FlowStep[], stepId: string): string {
  return template.replace(ROW_PLACEHOLDER_RE, (_span: string, sid: string, field: string) =>
    stepFieldRead(steps, stepId, sid, field),
  );
}

/** jq needs `"` and `\` escaped inside a double-quoted string literal — the
 *  same rule `render.ts` keeps, so a row renders what the builders would. */
function jqRowString(value: string): string {
  // `'` as jq's `\u0027`: the program sits in a single-quoted Pebble literal.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/'/g, "\\u0027")}"`;
}

/** `.field`, or `.["field"]` when the name is not a plain identifier — the
 *  same rule `codeProjection` in `render.ts` keeps. */
function jqRowField(field: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(field) ? `.${field}` : `.[${JSON.stringify(field)}]`;
}

/** `rowOverRows`, exported for the combinator pipeline's lowering (compiled-builder 2d) — ONE rows-path definition. */
export function transformRowsPath(steps: FlowStep[], stepId: string, from: string): string {
  return rowOverRows(steps, stepId, "transform", from);
}

/** The upstream rows a fan-out or projection reads, or a refusal naming why
 *  this step's rows cannot be built from it. */
function rowOverRows(steps: FlowStep[], stepId: string, what: string, overId: string): string {
  const over = typedStep(steps, overId);
  const rowsPath = over ? rowsExpr(RENDER_SHAPES, over) : null;
  if (!over || !rowsPath) {
    throw new FlowCompileError(
      `${what} "${stepId}" reads "${overId}", which ${over ? "produces no readable rows" : "is not a step in this flow"}`,
      stepId,
    );
  }
  return rowsPath;
}

/**
 * The first bracket that does not balance in a jq program, in words, or null.
 *
 * Valid jq always balances, so this cannot refuse a correct program. String
 * contents are skipped — including a `\(…)` interpolation, whose code can hold
 * strings of its own — so `"a)"` is not a stray `)`.
 */
export function jqBracketProblem(program: string): string | null {
  const close: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  // Frames: a bracket, a string, or a `\(…)` interpolation inside a string.
  const stack: Array<{ t: string; at: number }> = [];
  let i = 0;
  while (i < program.length) {
    const c = program[i]!;
    const top = stack.at(-1);
    if (top?.t === "str") {
      if (c === "\\" && program[i + 1] === "(") {
        stack.push({ t: "interp", at: i + 1 });
        i += 2;
      } else if (c === "\\") i += 2;
      else {
        if (c === '"') stack.pop();
        i++;
      }
      continue;
    }
    if (c === '"') stack.push({ t: "str", at: i });
    else if (close[c]) stack.push({ t: c, at: i });
    else if (c === ")" || c === "]" || c === "}") {
      const opener = stack.pop();
      const want = opener ? (opener.t === "interp" ? ")" : close[opener.t]) : undefined;
      if (want !== c) {
        return (
          `a "${c}" at position ${i + 1} that closes nothing` +
          (opener ? ` (the "${opener.t === "interp" ? "\\(" : opener.t}" at position ${opener.at + 1} needs "${want}")` : "")
        );
      }
    }
    i++;
  }
  const open = stack.at(-1);
  if (!open) return null;
  return open.t === "str" ? `an unclosed string at position ${open.at + 1}` : `an unclosed "${open.t === "interp" ? "\\(" : open.t}" at position ${open.at + 1}`;
}

/**
 * A `|` directly inside an object VALUE — `{text: A | B}` — or null.
 *
 * ⚠ **The engine's jq dialect refuses it and standard jq does not**, which is
 * why a model writes it. Probed on Kestra v1.3.29 (build:measure r11, R07):
 * `{text: (map(.n)) | join(",")}` fails "Unable to parse jq value …", while
 * `{text: ((map(.n)) | join(","))}` runs. Same misleading sentence as I-233.
 * Strings and nested brackets are skipped, so only a pipe at the value's own
 * level counts.
 */
export function jqObjectPipeProblem(program: string): string | null {
  const stack: Array<{ t: string; value?: boolean; key?: string }> = [];
  let i = 0;
  let word = "";
  while (i < program.length) {
    const c = program[i]!;
    const top = stack.at(-1);
    if (top?.t === "str") {
      if (c === "\\" && program[i + 1] === "(") {
        stack.push({ t: "interp" });
        i += 2;
      } else if (c === "\\") i += 2;
      else {
        if (c === '"') stack.pop();
        i++;
      }
      continue;
    }
    if (c === '"') stack.push({ t: "str" });
    else if (c === "(" || c === "[") stack.push({ t: c });
    else if (c === "{") stack.push({ t: "{", value: false });
    else if (c === ")" || c === "]" || c === "}") stack.pop();
    else if (top?.t === "{") {
      if (c === ":") {
        top.value = true;
        top.key = word.trim() || top.key;
      } else if (c === ",") top.value = false;
      else if (c === "|" && top.value && program[i + 1] !== "=") {
        return `a "|" inside the value of "${top.key ?? "?"}" at position ${i + 1} — wrap the whole value in parentheses: {${top.key ?? "key"}: ( … | … )}`;
      }
    }
    word = /[A-Za-z0-9_$"]/.test(c) ? (/[A-Za-z0-9_$"]/.test(program[i - 1] ?? "") ? word + c : c) : word;
    i++;
  }
  return null;
}

/**
 * A drafted reshape `{from, program}` → the transform's `expr` (phase 3 step 2).
 *
 * `{{ <rows of from> | jq('<program>') | first }}` — the shape every seeded
 * transform already runs. The model writes the jq program only; the rows path,
 * the quoting and `| first` are ours, so a drafted reshape cannot get I-11
 * (a template inside the program) or I-43 (`@json` outside it) wrong.
 *
 * Refused by name, never repaired: a `'` (it would close the Pebble literal —
 * jq strings use `"`), a `{{`/`}}`-looking Pebble template (jq cannot see
 * Pebble; I-11), and an upstream with no readable rows.
 */
export function lowerTransformProgram(steps: FlowStep[], stepId: string, from: string, program: string): string {
  if (program.includes("'")) {
    throw new FlowCompileError(
      `transform "${stepId}" program contains a single quote — jq strings use double quotes ("like this"); remove the '`,
      stepId,
    );
  }
  if (/\{\{|(?<![.\w$])(?:inputs|outputs)\./.test(program)) {
    throw new FlowCompileError(
      `transform "${stepId}" program reads a Pebble value (inputs.… / outputs.… / {{ }}) — a program sees ONLY "${from}"'s output as "."; read fields off "." instead`,
      stepId,
    );
  }
  const unbalanced = jqBracketProblem(program);
  if (unbalanced) {
    // ⚠ Kestra reports a jq SYNTAX error as "Unable to parse jq value '[…]' with
    // type java.util.ArrayList" — it names the INPUT, never the program, so it
    // reads as a data problem (build:measure r10 R10: `{to: …, body: (…)] ]`,
    // an object never closed; probed on the engine both empty and full).
    throw new FlowCompileError(`transform "${stepId}" program has ${unbalanced} — fix the jq and keep every (, [ and { closed`, stepId);
  }
  const pipe = jqObjectPipeProblem(program);
  if (pipe) throw new FlowCompileError(`transform "${stepId}" program has ${pipe}`, stepId);
  const rows = rowOverRows(steps, stepId, "transform", from);
  // ⚠ A program that yields a STRING is wrapped as `{text: …}`. `| first`
  // unwraps a jq string into raw text (I-11), and raw text can be neither
  // `json()`-parsed nor piped into jq by the step that reads it — measured
  // (build:measure R11: a `join("\n")` digest killed the next step on
  // "- Name: 70%"; Kestra 6dA6pCPsMpgOVod2mZWonJ proves the wrapped form). So a
  // transform's output is always an object or a list, and text is `.text`.
  return `{{ ${rows} | jq('(${program.trim()}) | if type == "string" then {text: .} else . end') | first }}`;
}

/**
 * A call step's `params` record as the runtime params block. Uniform `step`
 * feeds fan out over their shared upstream — `{{ rows | jq('[.[] | {…}]') |
 * first }}`, the shape every demo flow already runs — while fixed-only or
 * template-fed rows render one call `[{…}]`. `fixed` is always a JSON string;
 * an `expression` holding one `{{ … }}` span splices its inside, anything else
 * embeds as written — never decomposed.
 */
function renderCallRows(step: CallStep, steps: FlowStep[], rows: Array<[string, RowValue]>): string {
  const seen: Record<string, true> = {};
  for (const [, v] of rows) if (v.source.kind === "step") seen[v.source.stepId] = true;
  const overIds = Object.keys(seen).sort();
  const overId = overIds[0];
  if (overIds.length > 1) {
    throw new FlowCompileError(
      `step "${step.id}" feeds params from ${overIds.join(", ")} — one call fans out over one upstream step, not ${overIds.length}`,
      step.id,
    );
  }
  if (overId === undefined) {
    // No row context: one call. A `step` feed here has no row to project, so
    // it reads the whole column — the same shape `codeValueText` emits.
    const pairs = rows.map(([name, v]) => {
      const s = v.source;
      if (s.kind === "fixed") return `${JSON.stringify(name)}: ${JSON.stringify(s.value)}`;
      if (s.kind === "step") {
        const rowsPath = rowOverRows(steps, step.id, `step "${step.id}" param "${name}"`, s.stepId);
        return `${JSON.stringify(name)}: {{ ${rowsPath} | jq('[.[] | ${jqRowField(s.field)}]') }}`;
      }
      const template = expandRowPlaceholders(s.template, steps, step.id);
      const inner = SINGLE_SPAN_RE.exec(template)?.[1];
      return inner !== undefined
        ? `${JSON.stringify(name)}: ${inner}`
        : `${JSON.stringify(name)}: ${JSON.stringify(template)}`;
    });
    return `[{ ${pairs.join(", ")} }]`;
  }
  const rowsPath = rowOverRows(steps, step.id, `step "${step.id}"`, overId);
  // Assembled like `assembleJq` in `render.ts` (unexported): literal chunks
  // joined with `~`-spliced Pebble. Adjacent literals collapse, so a
  // fixed-only fan-out reads exactly as a hand-written program would.
  const parts: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf) parts.push(`'${buf}'`);
    buf = "";
  };
  buf += "[.[] | {";
  rows.forEach(([name, v], i) => {
    if (i) buf += ", ";
    const s = v.source;
    if (s.kind === "fixed") {
      buf += `${jqRowString(name)}: ${jqRowString(s.value)}`;
      return;
    }
    if (s.kind === "step") {
      buf += `${jqRowString(name)}: ${jqRowField(s.field)}`;
      return;
    }
    const template = expandRowPlaceholders(s.template, steps, step.id);
    const inner = SINGLE_SPAN_RE.exec(template)?.[1];
    if (inner === undefined) {
      throw new FlowCompileError(
        `step "${step.id}" param "${name}" mixes text and references — a fan-out splices one {{ … }} reference per row; use a fixed value or a single reference`,
        step.id,
      );
    }
    buf += `${jqRowString(name)}: `;
    flush();
    parts.push(inner);
  });
  buf += "}]";
  flush();
  return `{{ ${rowsPath} | jq(${parts.join(" ~ ")}) | first }}`;
}

/**
 * A code step's `inputBindings` as the `input.json` object. The fragment runs
 * once, so every `step` feed reads the whole column — the same shape the
 * Stage-3 `codeValueText` emits. An empty list renders the blank (`{}`),
 * exactly as `inputs: []` does.
 */
function renderCodeRows(step: CodeStep, steps: FlowStep[], rows: Array<{ name: string; source: RowSource }>): string {
  if (!rows.length) return "{}";
  const pairs = rows.map(({ name, source }) => {
    if (source.kind === "fixed") return `${JSON.stringify(name)}: ${JSON.stringify(source.value)}`;
    if (source.kind === "step") {
      const rowsPath = rowOverRows(steps, step.id, `code step "${step.id}" input "${name}"`, source.stepId);
      return `${JSON.stringify(name)}: {{ ${rowsPath} | jq('[.[] | ${jqRowField(source.field)}]') }}`;
    }
    const template = expandRowPlaceholders(source.template, steps, step.id);
    const inner = SINGLE_SPAN_RE.exec(template)?.[1];
    return inner !== undefined
      ? `${JSON.stringify(name)}: ${inner}`
      : `${JSON.stringify(name)}: ${JSON.stringify(template)}`;
  });
  return `{${pairs.join(", ")}}`;
}

/**
 * A transform's `outputColumns` as the reshape — `{{ rows | jq('[.[] |
 * {col: .field, …}]') }}`, the shape every hand-shaped transform already runs.
 * No trailing `| first`: a reshape keeps the array for downstream fan-outs.
 * `inputBindings` declares the feed and never renders, but every `step` feed
 * across both lists must name the one upstream step being reshaped.
 */
function renderTransformRows(step: TransformStep, steps: FlowStep[]): string {
  const cols = step.outputColumns ?? [];
  const feeds: Array<{ name: string; source: RowSource }> = [...(step.inputBindings ?? []), ...cols];
  if (!feeds.length) {
    throw new FlowCompileError(`transform "${step.id}" has no expression`, step.id);
  }
  const seen: Record<string, true> = {};
  for (const r of feeds) if (r.source.kind === "step") seen[r.source.stepId] = true;
  const overIds = Object.keys(seen).sort();
  const overId = overIds[0];
  if (overId === undefined) {
    throw new FlowCompileError(
      `transform "${step.id}" names no upstream step — feed its rows from an upstream step's field`,
      step.id,
    );
  }
  if (overIds.length > 1) {
    throw new FlowCompileError(
      `transform "${step.id}" reads ${overIds.join(", ")} — one reshape reads one upstream step, not ${overIds.length}`,
      step.id,
    );
  }
  const rowsPath = rowOverRows(steps, step.id, `transform "${step.id}"`, overId);
  if (!cols.length) {
    throw new FlowCompileError(`transform "${step.id}" declares no output columns — there is nothing to project`, step.id);
  }
  const parts: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf) parts.push(`'${buf}'`);
    buf = "";
  };
  buf += "[.[] | {";
  cols.forEach((c, i) => {
    if (i) buf += ", ";
    const s = c.source;
    if (s.kind === "fixed") {
      buf += `${jqRowString(c.name)}: ${jqRowString(s.value)}`;
      return;
    }
    if (s.kind === "step") {
      buf += `${jqRowString(c.name)}: ${jqRowField(s.field)}`;
      return;
    }
    const template = expandRowPlaceholders(s.template, steps, step.id);
    const inner = SINGLE_SPAN_RE.exec(template)?.[1];
    if (inner === undefined) {
      throw new FlowCompileError(
        `transform "${step.id}" column "${c.name}" mixes text and references — a projection splices one {{ … }} reference per column; use a fixed value or a single reference`,
        step.id,
      );
    }
    buf += `${jqRowString(c.name)}: `;
    flush();
    parts.push(inner);
  });
  buf += "}]";
  flush();
  return `{{ ${rowsPath} | jq(${parts.join(" ~ ")}) }}`;
}

/**
 * One typed branch condition through the same builder the typed `test` uses.
 * A `left` step with a `fixed` right is the classic column comparison; `any`
 * and `none` read row counts off the left step. Anything the builder cannot
 * shape returns "" and refuses downstream by name — never a guessed program.
 */
function renderBranchCondition(stepId: string, steps: FlowStep[], cond: BranchCondition): string {
  const leftStepId = "stepId" in cond.left ? cond.left.stepId : null;
  const over = leftStepId ? typedStep(steps, leftStepId) : null;
  if (leftStepId && !over) {
    throw new FlowCompileError(
      `branch step "${stepId}" reads "${leftStepId}", which is not a step in this flow`,
      stepId,
    );
  }
  if (cond.right && "stepId" in cond.right) {
    throw new FlowCompileError(
      `branch step "${stepId}" compares two step columns — compare one column to a fixed value`,
      stepId,
    );
  }
  if (!over) {
    throw new FlowCompileError(
      `branch step "${stepId}" compares fixed values with no upstream step — there is nothing to test rows against`,
      stepId,
    );
  }
  const field = leftStepId && "stepId" in cond.left ? cond.left.field : undefined;
  const value = cond.right && "fixed" in cond.right ? cond.right.fixed : undefined;
  return buildCondition(RENDER_SHAPES, over, cond.op, field, value);
}

/**
 * Every authored `expression` template the typed rows carry — the save-time
 * allowlist scans these exactly as it scans the display strings they replace
 * (`writeRevision` folds them into the checked copy). `fixed` values are data,
 * never scanned — the same parity `literal` bindings already keep.
 */
export function rowExpressionTemplates(step: FlowStep): string[] {
  const sources: RowSource[] = [];
  if (step.kind === "tool" || step.kind === "datasource" || step.kind === "query") {
    for (const v of Object.values(step.params ?? {})) sources.push(v.source);
  } else if (step.kind === "transform") {
    for (const r of step.inputBindings ?? []) sources.push(r.source);
    for (const c of step.outputColumns ?? []) sources.push(c.source);
  } else if (step.kind === "code") {
    for (const r of step.inputBindings ?? []) sources.push(r.source);
  }
  const out: string[] = [];
  for (const s of sources) if (s.kind === "expression") out.push(s.template);
  return out;
}

/** Call params: old display verbatim when non-blank, else rendered from rows. */
export function displayParams(step: CallStep, steps: FlowStep[]): string | null {
  // A blank display is ABSENT, not params: a converted step writes `""`
  // beside its typed rows, and refusing at emit time what validation passed
  // would strand every conversion. Non-blank wins verbatim — the dual-read
  // rule, extended from `displayCondition`'s blank handling to all displays.
  if (step.paramsExpr?.trim()) return step.paramsExpr;
  // Typed rows (property-rows project) render before the Stage-3 bindings: a
  // converted step dropped the display string, and these are what is left.
  const rows = Object.entries(step.params ?? {});
  if (rows.length) return renderCallRows(step, steps, rows);
  const bindings = step.inputs ?? [];
  if (!bindings.length && !step.over && !step.where) return null;
  const over = step.over?.stepId ? typedStep(steps, step.over.stepId) : null;
  const mappings: Mapping[] = bindings.map((b) => ({ param: b.name, source: boundSource(b, step.id) }));
  if (over) {
    // `where` never stores `any`/`none`/`gte`/`lte` (the upgrade keeps the old
    // string for those) — a writer-written one builds nothing, and building
    // nothing is refused rather than sent as an unfiltered fan-out. The cast
    // bridges the stored eleven-operator union to the narrower per-item one;
    // an out-of-range test falls out of `perItemTest` as empty, hence null.
    const stored = step.where;
    const predicate = stored
      ? ({ test: stored.test, field: stored.field, value: stored.value } as ItemPredicate)
      : undefined;
    return buildFanOutParams(RENDER_SHAPES, over, mappings, predicate);
  }
  // One call over ONE upstream's output builds its object in jq (E3.1); a
  // read from two upstreams has no single program and is refused (null) —
  // `missingInput` names the fix.
  return buildSingleParams(mappings, { shapes: RENDER_SHAPES, steps: steps as unknown as AuthoredStep[] });
}
/** Transform reshape: old display verbatim when non-blank, else rendered from rows. */
export function displayTransform(step: TransformStep, steps: FlowStep[]): string | null {
  // Same dual-read rule as `displayParams`: a converted step carries a blank
  // display beside its `outputColumns`; unrenderable rows refuse as null so
  // callers (emit, portability) refuse by name instead of shipping half a step.
  if (step.expr?.trim()) return step.expr;
  try {
    return renderTransformRows(step, steps);
  } catch {
    return null;
  }
}


function toCodeInputValue(b: InputBinding, steps: FlowStep[], stepId: string): CodeInputValue {
  const s = boundSource(b, stepId);
  // ⚠ Every field the renderer reads must be carried here: an input's
  // `transform` (D-272) and a source's `onNull` (D-273) were both dropped at
  // this hop once, silently — the model was checked with them and the compiled
  // payload ran without.
  if (s.from === "input") return { kind: "input", inputId: s.inputId, ...(s.transform ? { transform: s.transform } : {}) };
  if (s.from === "literal") return { kind: "literal", value: s.value };
  // `self` (the bare per-row element) has no address in a payload the step runs
  // once with — bound to nothing rather than guessed into something.
  if (s.from === "self") return null;
  const target = typedStep(steps, s.stepId);
  if (s.from === "whole") return { kind: "step", step: target, field: "", ...(s.onNull ? { onNull: s.onNull } : {}) };
  // `transform` is typed on the step arm (`Source`), so a stored projection
  // rides straight into the renderer's own `transform` — no translation.
  return { kind: "step", step: target, field: s.field, transform: s.transform, ...(s.onNull ? { onNull: s.onNull } : {}) };
}
export function displayCodeInput(step: CodeStep, steps: FlowStep[]): string | null {
  // Blank is ABSENT — see `displayParams`. Non-blank wins verbatim.
  if (step.inputExpr?.trim()) return step.inputExpr;
  // Typed rows (property-rows project) render before the Stage-3 bindings: a
  // `params`-style record can only exist if the new panel wrote it, so it is
  // always the freshest vocabulary. (The upgrade stamps `inputs: []` on every
  // display-less step — including rows-converted ones — so testing `inputs`
  // first would strand every conversion behind the blank.)
  if (step.inputBindings !== undefined) return renderCodeRows(step, steps, step.inputBindings);
  if (step.inputs !== undefined) {
    // No bindings is the blank (`{}`) — rendered as blank, exactly as the old
    // emitter did for the display it replaces. Anything bound renders.
    if (!step.inputs.length) return "{}";
    return buildCodeInput(
      RENDER_SHAPES,
      step.inputs.map((b) => ({ name: b.name, source: toCodeInputValue(b, steps, step.id) })),
    );
  }
  return "{}";
}
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO OR MORE CONDITIONS ON ONE ARM — the conjunction  (Phase 4a.1)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `conditions` has accepted an array since the property-rows project and the
 * compiler refused anything past the first by name, so `amount > 1000 AND
 * region = EU` was **unexpressible** — the gap people hit first.
 *
 * ⚠ **AND ONLY, AND THAT IS NOT A LIMITATION TO APOLOGISE FOR.** An `elif`
 * chain already expresses OR: two arms with the same body is a disjunction, and
 * `elseOf` is the mechanism. What no chain can express is a single arm requiring
 * BOTH things at once. So the array is an implicit conjunction, and an explicit
 * connector field is deliberately not added — a `join` on the wire shape would
 * be a second way to say what the array already says, free to disagree with it,
 * and every existing row would need a value it does not have.
 *
 * ── ⚠ THE SPELLING WAS MEASURED AGAINST THE ENGINE, NOT REASONED ────────────
 *
 * Probed on v1.3.29, 2026-09-22, with a positive and a negative control (a
 * condition that must fire and one that must not) — without both, *"the arm
 * ran"* and *"the spelling works"* are the same output:
 *
 *     (A) and (B)                        TT fires, TF does not     ✅
 *     ((A) == 'true') and ((B) == 'true') TT does NOT fire          ❌
 *
 * So Pebble's `and` evaluates the `| first` result directly, and the
 * defensive-looking string comparison is the broken one — anybody "hardening"
 * this by comparing to `'true'` would silently turn every guard false.
 *
 * ⚠ **The first probe's control FAILED and that is why the reading is trusted.**
 * It read `outputs.rows.body` — Foundry's envelope — against a
 * `core.debug.Return` whose output is `.value`, so every case came back false
 * and `and` looked broken. A probe with no control would have recorded that as
 * a property of the engine.
 *
 * ── ⚠ ONE TEMPLATE, NEVER TWO ───────────────────────────────────────────────
 *
 * `{{ A }} and {{ B }}` is **string concatenation**: it renders to the literal
 * text `true and false`, which is not `true`, so the arm never runs — and it
 * never errors either. The conjunction has to happen INSIDE one `{{ }}`, which
 * is why each part is unwrapped rather than joined as-is.
 *
 * The unwrap REFUSES anything it does not recognise rather than falling back to
 * concatenation, because the fallback is exactly the silent-false shape above.
 */
function conjoinConditions(stepId: string, rendered: string[]): string {
  const inner = rendered.map((r) => {
    const m = /^\{\{([\s\S]*)\}\}$/.exec(r.trim());
    if (!m) {
      throw new FlowCompileError(
        `branch step "${stepId}" has a condition that is not a single template, so it cannot be ` +
          `combined with the others: ${r}`,
        stepId,
      );
    }
    const body = m[1]!.trim();
    // ⚠ I-11: a nested `{{ }}` is not re-evaluated by Pebble. One arriving here
    // would be carried into the conjunction and fail at RENDER time, naming
    // nothing — so it is refused where the step id is still in hand.
    if (body.includes("{{")) {
      throw new FlowCompileError(
        `branch step "${stepId}" has a condition containing a nested "{{" — it cannot be combined`,
        stepId,
      );
    }
    return `(${body})`;
  });
  return `{{ ${inner.join(" and ")} }}`;
}

export function displayCondition(step: BranchStep, steps: FlowStep[]): string | null {
  // A blank display is ABSENT, not a condition: a writer-written step carrying
  // `conditionExpr: ""` beside a `test` renders the test (which `validateModel`
  // already accepted via `hasBranchCondition`), rather than refusing at emit
  // time what validation passed. Non-blank wins verbatim — the dual-read rule.
  if (step.conditionExpr?.trim()) return step.conditionExpr;
  // Typed rows (property-rows project) render before the Stage-3 test: a
  // `conditions` array can only exist if the new panel wrote it, so it is
  // always the freshest vocabulary. Two or more refuse by name — an arm
  // conjunction is not a shape this compiler emits yet.
  const conds = step.conditions ?? [];
  if (conds.length > 1) {
    return conjoinConditions(
      step.id,
      conds.map((c) => renderBranchCondition(step.id, steps, c)),
    );
  }
  const first = conds[0];
  if (first) return renderBranchCondition(step.id, steps, first) || null;
  const test = step.test;
  if (!test) return null;
  const over =
    test.left.from === "step" || test.left.from === "whole" ? typedStep(steps, test.left.stepId) : null;
  const field = test.left.from === "step" ? test.left.field : undefined;
  return buildCondition(RENDER_SHAPES, over, test.operator, field, test.right) || null;
}

/** An approval's question: old display verbatim when present, else rendered. */
export function displaySummary(step: ApprovalStep, steps: FlowStep[]): string | null {
  if (step.summaryExpr !== undefined) return step.summaryExpr;
  if (step.summary === undefined || step.summary === "") return null;
  const c = step.context;
  const over = c && (c.from === "step" || c.from === "whole") ? typedStep(steps, c.stepId) : null;
  return buildApprovalSummary(RENDER_SHAPES, over, step.summary);
}

/** An approval's evidence: old display verbatim when present, else rendered —
 *  `null` when there is nothing (the old emitter wrote the JSON `null` for a
 *  missing `contextExpr`, and emit sites below default to it). Only sources
 *  with a canonical single-expression spelling travel; a step column or `self`
 *  has no builder the upgrade recognises, so it reads as nothing rather than a
 *  guess (and the hash below moves honestly for it). */
export function displayContext(step: ApprovalStep, steps: FlowStep[]): string | null {
  if (step.contextExpr !== undefined) return step.contextExpr;
  const c = step.context;
  if (!c) return null;
  if (c.from === "whole") {
    const rows = typedStep(steps, c.stepId);
    const r = rows ? rowsExpr(RENDER_SHAPES, rows) : null;
    return r ? `{{ ${r} }}` : null;
  }
  if (c.from === "input") return `{{ inputs.${c.inputId} }}`;
  if (c.from === "literal") return JSON.stringify(c.value);
  return null;
}

/**
 * Wave 1 (Stage 4.1) — an `llm` step's callback params, as a JSON block.
 *
 * Static by construction: every value is JSON-stringified here, so the body
 * Kestra posts parses before any rendering happens. A prompt block carrying a
 * `{{ … }}` reference renders INSIDE its JSON string at runtime — the model
 * reads prose, so interpolation-as-text is the intended use, but a value whose
 * quotes break the JSON fails the step loudly rather than answering wrongly.
 */
function llmParamsBlock(step: LlmStep): string {
  return JSON.stringify(
    {
      model: step.model,
      temperature: step.temperature,
      topP: step.topP,
      frequencyPenalty: step.frequencyPenalty,
      presencePenalty: step.presencePenalty,
      messages: step.promptBlocks.map((b) => ({ role: b.role, text: b.text })),
      outputFields: step.outputFields,
      contextStepId: step.contextStepId ?? null,
    },
    null,
    2,
  );
}

/**
 * Wave 1 (Stage 4.2) — an `http` step's callback params, as a JSON block.
 *
 * The request fields travel; the secret does not — `auth` carries a
 * `secretRef` (an env-var name, refused at save when it looks like a value),
 * which Foundry resolves server-side when it dials.
 */
function httpParamsBlock(step: HttpStep): string {
  return JSON.stringify(
    {
      method: step.method,
      url: step.url,
      headers: step.headers,
      queryParams: step.queryParams,
      body: step.body,
      auth: step.auth,
      timeouts: step.timeouts ?? null,
      sslVerify: step.sslVerify,
    },
    null,
    2,
  );
}

/**
 * The one refusal for a step with nothing renderable — no display string and
 * no usable typed fields. One message, three emit sites, so a step that
 * reaches emission without inputs is refused the same way everywhere.
 * Unreachable for stored models (`validateModel` refused the truly-empty
 * first); reachable only for writer-written unknowns with no display to fall
 * back to.
 */
function missingInput(step: { id: string; kind: string; inputs?: Array<{ source: unknown }>; over?: unknown }): never {
  // The one refusal a person can act on by name: a single call reading fields
  // from two upstream steps has no one jq program to build it in (E3.1).
  const upstream = new Set<string>();
  for (const b of step.inputs ?? []) {
    const src = b.source as { from?: string; stepId?: string } | null;
    if (src && (src.from === "step" || src.from === "whole") && src.stepId) upstream.add(src.stepId);
  }
  if (!step.over && upstream.size > 1) {
    throw new FlowCompileError(
      `step "${step.id}" (${step.kind}) reads from ${upstream.size} upstream steps (${[...upstream].join(", ")}) in one call — combine them in a transform first, then bind this step to the transform`,
      step.id,
    );
  }
  throw new FlowCompileError(
    `step "${step.id}" (${step.kind}) has neither a display expression nor renderable typed inputs`,
    step.id,
  );
}

/**
 * The `retry:` block, at the given indent. Empty string when the step declares
 * none — a step without `retry` must emit no key at all, so an unretried step's
 * YAML is byte-identical to what it was before this existed.
 *
 * `behavior` and `warningOnRetry` are NOT author-settable; see `StepRetry` for
 * why `RETRY_FAILED_TASK` in particular is the compiler's call and not a
 * default worth inheriting.
 */
function retryBlock(retry: StepRetry | undefined, indent: string): string {
  if (!retry) return "";
  const interval = retry.intervalSeconds ?? 5;
  const kind = retry.backoff ?? "constant";
  return (
    `${indent}retry:\n` +
    `${indent}  type: ${kind}\n` +
    `${indent}  maxAttempts: ${retry.maxAttempts}\n` +
    `${indent}  interval: PT${interval}S\n` +
    // `exponential` doubles from `interval` and needs a ceiling, or attempt 5 of
    // a 300s interval waits 80 minutes. Derived, not author-settable: the point
    // of the cap is that it cannot be raised past the bound below.
    (kind === "exponential"
      ? `${indent}  maxInterval: PT${Math.min(interval * 2 ** (retry.maxAttempts - 1), 900)}S\n`
      : "") +
    (retry.maxDurationSeconds ? `${indent}  maxDuration: PT${retry.maxDurationSeconds}S\n` : "") +
    // ⚠ Explicit. The alternative, `CREATE_NEW_EXECUTION`, would call `begin`
    // again — a second execution token, a second M3 slot and a second
    // `flow_executions` row for one logical run.
    `${indent}  behavior: RETRY_FAILED_TASK\n` +
    // The recovered run ends WARNING rather than SUCCESS, so "it worked, on the
    // third go" is a fact the engine records rather than something you only find
    // by reading attempt counts. Every consumer already treats warning as
    // settled-and-successful (`toStatus`, `KESTRA_TERMINAL`, `adapters.ts`), so
    // this makes a run more honest without making it look failed.
    `${indent}  warningOnRetry: true\n`
  );
}

interface HttpTask {
  id: string;
  path: string;
  authHeader: string;
  body: string;
  timeoutSeconds?: number;
  retry?: StepRetry;
  /** Rendered as a YAML comment — dependency order, for a human reading Kestra. */
  note?: string;
}

function httpRequest(t: HttpTask): string {
  return (
    `  - id: ${t.id}\n` +
    `    type: io.kestra.plugin.core.http.Request\n` +
    (t.note ? `    # ${t.note}\n` : "") +
    `    uri: ${q(`{{ vars.foundry }}${t.path}`)}\n` +
    `    method: POST\n` +
    `    contentType: application/json\n` +
    (t.timeoutSeconds ? `    options:\n      readIdleTimeout: PT${t.timeoutSeconds}S\n` : "") +
    retryBlock(t.retry, "    ") +
    `    headers:\n` +
    `      Authorization: ${q(t.authHeader)}\n` +
    `    body: |\n${t.body}`
  );
}

/** `{{ json(outputs.begin.body).token }}` — every step after `begin` uses it. */
const STEP_AUTH = "Bearer {{ json(outputs.begin.body).token }}";

// ── the `code` step wrapper ──────────────────────────────────────────────────

/**
 * Largest result a fragment may return through Kestra's output marker.
 *
 * §5.3.2 caps step payloads at ~1 MB because task outputs travel through the
 * execution context, which is **persisted in Kestra's database** — 62 employee
 * rows are fine, 500k rows bloat every execution record.
 *
 * §5.3.2 also says an over-cap payload should go to internal storage and be
 * passed by reference. That is a SECOND output channel, and the same section
 * says to pick one and never mix, so this cap is enforced as an explicit,
 * named failure instead. A fragment that outgrows it fails with a sentence
 * saying so; it does not silently truncate, and it does not quietly work until
 * the day the dataset grows. See DECISIONS.md D-20.
 */
const FRAGMENT_MAX_OUTPUT_BYTES = 1_000_000;

/**
 * The wrapper around every generated fragment. **Compiler-emitted, identical
 * for every `code` step, never generated.**
 *
 * All of a fragment's I/O lives here, and that is what makes the R9 guarantees
 * checkable by reading one function instead of every fragment:
 *
 *  * the input is read from `input.json` and nowhere else — a fragment has no
 *    other source of data, and with `networkMode: none` no way to acquire one;
 *  * the output contract is checked HERE, before the value crosses back, so a
 *    violation is a mechanical `contract_violation` (triage level 1) rather
 *    than a `KeyError` in a step three positions downstream;
 *  * the size cap is checked here, so it cannot be forgotten per fragment;
 *  * the output marker is printed here, so a fragment cannot pick a channel,
 *    half-write one, or declare its own contract satisfied.
 *
 * Every name is `_`-prefixed. The fragment shares this module's global scope,
 * and a fragment that happened to define `main` or `payload` would otherwise
 * shadow the wrapper's own — a collision that would present as a bizarre
 * runtime error in generated code rather than as a naming clash.
 */
function codeWrapper(step: CodeStep): string {
  const keys = JSON.stringify(step.outputKeys);
  return [
    `import json as _json, sys as _sys, traceback as _traceback`,
    ``,
    `_OUTPUT_KEYS = ${keys}`,
    `_MAX_OUTPUT_BYTES = ${FRAGMENT_MAX_OUTPUT_BYTES}`,
    ``,
    `def _refuse(_kind, _detail):`,
    `    """Fail with a CLASSIFIABLE reason (06 §6.9), not a stack trace."""`,
    `    print("::" + _json.dumps({"outputs": {`,
    `        "contract_ok": False, "failure_class": _kind, "detail": _detail}}) + "::")`,
    `    _sys.stderr.write("FRAGMENT_" + _kind.upper() + ": " + _detail + "\\n")`,
    `    _sys.exit(1)`,
    ``,
    `# ── generated fragment begins ────────────────────────────────────────────`,
    block(step.code, ""),
    `# ── generated fragment ends ──────────────────────────────────────────────`,
    ``,
    `if __name__ == "__main__":`,
    `    # The feed is an OBJECT by construction (buildCodeInput renders brace-objects);`,
    `    # a legacy blob wins verbatim and may not be one (run 4171a39b). The load used`,
    `    # to sit OUTSIDE the try and died raw - the one unclassified traceback in this`,
    `    # wrapper - instead of the _refuse every other failure gets. A bad feed is refused`,
    `    # the same way: bad_input, naming the step and the object the feed must be.`,
    `    try:`,
    `        with open("input.json", "r", encoding="utf-8") as _f:`,
    `            _payload = _json.load(_f)`,
    `    except Exception as _e:`,
    `        _refuse("bad_input", "step \\"${step.id}\\" input feed must be a JSON object (" + str(_e) + ")")`,
    `    if not isinstance(_payload, dict):`,
    `        _refuse("bad_input", "step \\"${step.id}\\" input feed must be a JSON object, got " + type(_payload).__name__)`,
    `    try:`,
    `        _result = run(_payload)`,
    `    except Exception:`,
    `        # A throw on a DECLARED input is bad code, not a bad boundary —`,
    `        # triage level 1, regenerate this fragment only (06 §6.9).`,
    `        _refuse("contract_violation", _traceback.format_exc(limit=4))`,
    `    if not isinstance(_result, dict):`,
    `        _refuse("contract_violation",`,
    `                "run() returned " + type(_result).__name__ + ", expected dict")`,
    `    _missing = [_k for _k in _OUTPUT_KEYS if _k not in _result]`,
    `    if _missing:`,
    `        _refuse("contract_violation", "output is missing declared field(s): " + ", ".join(_missing))`,
    `    try:`,
    `        _encoded = _json.dumps({"outputs": {"result": _result, "contract_ok": True}})`,
    `    except (TypeError, ValueError) as _e:`,
    `        _refuse("contract_violation", "output is not JSON-serialisable: " + str(_e))`,
    `    if len(_encoded) > _MAX_OUTPUT_BYTES:`,
    `        _refuse("output_too_large",`,
    `                "result is " + str(len(_encoded)) + " bytes; the cap is "`,
    `                + str(_MAX_OUTPUT_BYTES) + " (04 §5.3.2 — split the step or aggregate earlier)")`,
    `    print("::" + _encoded + "::")`,
  ].join("\n");
}

export interface CompileOptions {
  /** The namespace this YAML is FOR. Live and draft differ only by the trigger. */
  namespace: NamespaceRef;
  /**
   * Emit the Schedule trigger. **Only true for an approved revision going to the
   * live namespace** — this is where §5.4's structural gate is enforced.
   */
  withSchedule?: boolean;
  /** Stamped as flow labels so `kestra-ui` stays filterable during debugging. */
  labels?: Record<string, string>;
}

export interface CompiledFlow {
  yaml: string;
  /** `sha256:…` of the YAML, stored on the revision. */
  hash: string;
  /** Every tool / named-query ref the model touches, in declaration order. */
  refs: string[];
}

export const flowCompiler = {
  validateModel,

  /**
   * Compile one revision for one namespace.
   *
   * Deterministic: the same model and options always produce byte-identical
   * YAML. `compiled_yaml_hash` is only meaningful if that holds, and so is
   * "editing an armed flow does not change what the schedule runs" — the check
   * that it did not change is a hash comparison.
   */
  compile(model: FlowModel, opts: CompileOptions): CompiledFlow {
    // Verbatim `@json`-in-quotes never reaches the engine — refused here, not
    // at run time with Kestra's Jackson error. This runs BEFORE normaliseModel
    // below deliberately: normalisation parses plain-JSON paramsExpr into typed
    // rows and drops the display string, so a scan after it would see nothing.
    // Twin of `QUOTED_JSON_FILTER_RE` in flow-validator.service.ts (which guards
    // the save path); this one guards deploy, replay, approval and the yaml
    // route — every path that funnels through here, including revisions written
    // before the validator existed. One-line duplication instead of an import:
    // the validator already imports this module's types.
    for (const step of model.steps ?? []) {
      if (step.kind !== "tool" && step.kind !== "datasource" && step.kind !== "query") continue;
      if (/"\{\{[^"]*?@json[^"]*?\}\}"/.test(step.paramsExpr ?? "")) {
        throw new FlowCompileError(
          `step "${step.id}" puts \`@json\` inside an already-quoted "{{ … }}" span — the value arrives ` +
            `with two sets of quotes and the run dies parsing it. Quote the span and pass raw text, ` +
            `or unquote the span and let \`@json\` do the quoting — one quoting, not both.`,
          step.id,
        );
      }
    }
    // Normalise before validating AND emitting, so the emit loop below reads
    // the same v2 `validateModel` just checked (which re-normalises
    // idempotently — see its own note). The yaml route, deploy, replay and
    // approval all funnel through here.
    model = normaliseModel(model) as unknown as FlowModel;
    validateModel(model);

    const lines: string[] = [];
    lines.push(`# Generated by flow-compiler.service.ts — do not edit in Kestra.`);
    lines.push(`# Foundry is the system of record for the MODEL; Kestra for the deployed YAML.`);
    lines.push(`id: ${model.id}`);
    lines.push(`namespace: ${opts.namespace.value}`);

    if (opts.labels && Object.keys(opts.labels).length) {
      lines.push(`labels:`);
      for (const k of Object.keys(opts.labels).sort()) {
        lines.push(`  ${k}: ${q(opts.labels[k])}`);
      }
    }

    if (model.inputs?.length) {
      lines.push(`inputs:`);
      const scheduled = model.schedule != null;
      const timezone = model.schedule?.timezone;
      for (const i of model.inputs) {
        lines.push(`  - id: ${i.id}`);
        lines.push(`    type: ${i.type}`);
        if (i.required !== undefined) lines.push(`    required: ${i.required ? "true" : "false"}`);
        // A computed input's `defaults:` is the engine expression, never a
        // stored value — resolved at run creation on every firing path (M1,
        // see `computedInputExpression` for the measurement).
        if (i.computed !== undefined) {
          lines.push(`    defaults: ${q(computedInputExpression(i.computed, { scheduled, timezone, ...(i.offsetDays !== undefined ? { offsetDays: i.offsetDays } : {}) }))}`);
        } else if (i.defaults !== undefined) {
          lines.push(`    defaults: ${q(i.defaults)}`);
        }
      }
    }

    lines.push(`variables:`);
    // The ONLY host any emitted task contacts. R8 backed by the network policy.
    lines.push(`  foundry: ${q(config.kestra.foundryUrl)}`);

    if (model.concurrencyLimit !== undefined) {
      lines.push(`concurrency:`);
      lines.push(`  limit: ${model.concurrencyLimit}`);
      // Queue rather than drop: a skipped scheduled run is a silent gap in the
      // record, and a gap is the failure mode this whole migration is about.
      lines.push(`  behavior: QUEUE`);
    }

    lines.push(`tasks:`);

    // ── begin — the gate ─────────────────────────────────────────────────────
    // The one call authenticated with Kestra's own credential, because it is the
    // call that mints the execution token. Foundry checks approval freshness,
    // the manifest fingerprint and the M3 budget before answering; a 403 or 429
    // fails the execution at step 1 with nothing downstream having run.
    const inputsJson = (model.inputs ?? [])
      .map((i) => `        ${q(i.id)}: "{{ inputs.${i.id} }}"`)
      .join(",\n");
    lines.push(
      httpRequest({
        id: "begin",
        path: "/api/executions/begin",
        authHeader: `Bearer {{ secret('${config.kestra.callbackSecretKey}') }}`,
        body: [
          `      {`,
          `        "namespace": "{{ flow.namespace }}",`,
          `        "flowId": "{{ flow.id }}",`,
          `        "executionId": "{{ execution.id }}",`,
          `        "inputs": {${inputsJson ? `\n${inputsJson}\n      ` : ""}}`,
          `      }`,
        ].join("\n"),
      }),
    );

    // ── the model's own steps ────────────────────────────────────────────────
    //
    // ⚠ Emitted into a MAP first, then assembled, because a branch guard hoists
    // its arm's tasks into its own `then:` block (Phase 3). The map keeps the
    // per-kind emission below unchanged and confines the nesting to one place —
    // a version that emitted directly would have to know, at every kind, whether
    // it was inside an arm and at what indent.
    const emitted = new Map<string, string>();
    /**
     * ⚠ **APPENDS, never overwrites.** An `approval` step emits two tasks and an
     * `approval` step emits three, each with its own `lines.push` in the loop
     * below. The first version of this used `set`, so the second push replaced
     * the first and both kinds silently lost their registration task — caught by
     * their own suites, which is the only reason it is a footnote and not a
     * defect that reached a deployment.
     */
    const emit = (id: string, text: string) =>
      emitted.set(id, emitted.has(id) ? `${emitted.get(id)}\n${text}` : text);

    // Which branch owns each step, if any. A step can be in at most one arm:
    // `validateModel` refuses a nested branch, and refuses an outside step
    // depending on one inside an arm.
    const ownedBy = new Map<string, string>();
    for (const s of model.steps) {
      if (s.kind !== "branch") continue;
      for (const inner of armOf(model, s.id)) ownedBy.set(inner.id, s.id);
    }
    // Which loop owns each step, if any (D-361) — its body is emitted inside the ForEach, never at top level.
    const inLoop = new Map<string, string>();
    for (const s of model.steps) if (s.kind === "for_each") for (const inner of loopOf(model, s.id)) inLoop.set(inner.id, s.id);
    // D-370: a batched loop's one call is emitted as today's per-row fan-out over the loop — its rows `json(outputs.<loop>.value)`,
    // which the loop body's re-addressing turns into the current CHUNK. The model is not changed; only what this call emits.
    const batchOf = new Map<string, string>();
    const batchAs = new Map<string, FlowStep>();
    for (const s of model.steps) if (s.kind === "for_each") { const c = batchedCall(model, s); if (c) { const { paramsExpr: _empty, ...call } = c as FlowStep & { paramsExpr?: string }; batchOf.set(s.id, c.id); batchAs.set(c.id, { ...call, over: { stepId: s.id, field: "" } } as FlowStep); } }
    for (const step0 of model.steps) {
      const step = (batchAs.get(step0.id) ?? step0) as typeof step0;
      const note = step.dependsOn?.length ? `after: ${step.dependsOn.join(", ")}` : undefined;
      if (step.kind === "for_each") {
        // The rows, NUMBERED (E-F0.1): ForEach keys iterations by value, so without `_i` identical rows run once and the
        // collected results come back in no order. The ForEach itself is assembled below, around its body.
        const over = model.steps.find((s) => s.id === step.over.stepId)!;
        const rows = rowsExpr(RENDER_SHAPES, over as unknown as AuthoredStep);
        emit(step.id,
          `  - id: ${step.id}${LOOP_ROWS}\n` +
            `    type: io.kestra.plugin.core.debug.Return\n` +
            `    # the rows of ${over.id}, each numbered, so every row runs and the output keeps their order\n` +
            `    format: |\n${block(`{{ ${rows} | jq('[to_entries[] | .value + {_i: .key}]') | first | toJson }}`, "      ")}`,
        );
        if (batchOf.has(step.id)) emit(step.id,
          `  - id: ${step.id}${LOOP_CHUNKS}\n` +
            `    type: io.kestra.plugin.core.debug.Return\n` +
            `    # the numbered rows in batches of ${LOOP_BATCH} — one call to the step API per batch (D-370)\n` +
            `    format: |\n${block(`{{ json(outputs['${step.id}${LOOP_ROWS}'].value) | jq('[range(0; length; ${LOOP_BATCH}) as $k | .[$k:$k + ${LOOP_BATCH}]]') | first | toJson }}`, "      ")}`,
        );
        continue;
      }
      if (step.kind === "collect") {
        const r = model.steps.find((s) => s.id === step.result)!;
        emit(step.id,
          `  - id: ${step.id}\n` +
            `    type: io.kestra.plugin.core.debug.Return\n` +
            (note ? `    # ${note}\n` : "") +
            `    format: |\n${block(batchOf.has(step.loop) ? collectBatchExpr(step.loop) : collectExpr(step.loop, r), "      ")}`,
        );
        continue;
      }
      if (step.kind === "transform") {
        // No credential, so it stays in Kestra (R2's credential test, visible).
        // `mode: "template"` emits `templateText`; a non-blank `expr` emits
        // verbatim (an `expr`-only v1 step normalises to expression mode, so
        // the expression path is byte-identical to before). A rows-converted
        // step carries a blank display and renders from `outputColumns` —
        // refused by name when unrenderable.
        const body =
          step.mode === "template" && step.templateText
            ? step.templateText
            : (step.expr?.trim() ? step.expr : renderTransformRows(step, model.steps));
        emit(step.id,
          `  - id: ${step.id}\n` +
            `    type: io.kestra.plugin.core.debug.Return\n` +
            (note ? `    # ${note}\n` : "") +
            `    format: |\n${block(body, "      ")}`,
        );
        continue;
      }

      if (step.kind === "code") {
        // R9, structurally. Nothing below is derived from the model: the task
        // type, the runner, the image and the network mode are all chosen here,
        // so no fragment and no model can widen them.
        //
        // ⚠ The task runner is `…runner.docker.Docker` and there is no branch
        // that emits `…runner.process.Process` (assertion 23). `Process` runs
        // the fragment IN THE KESTRA CONTAINER — same filesystem, same network,
        // same credentials as the engine. It is one word away and it silently
        // removes every containment property in this block.
        emit(step.id, 
          `  - id: ${step.id}\n` +
            `    type: io.kestra.plugin.scripts.python.Script\n` +
            (note ? `    # ${note}\n` : "") +
            `    containerImage: ${q(config.kestra.fragmentImage)}\n` +
            `    taskRunner:\n` +
            `      type: io.kestra.plugin.scripts.runner.docker.Docker\n` +
            // V1 — measured, see config.kestra.fragmentNetworkMode.
            `      networkMode: ${q(config.kestra.fragmentNetworkMode)}\n` +
            // The image is built locally and pinned by tag. NEVER, not
            // IF_NOT_PRESENT: a pull is the one thing that would reach a
            // registry, and a tag that resolves differently later is exactly
            // what O2 exists to prevent.
            `      pullPolicy: NEVER\n` +
            `      delete: true\n` +
            (step.timeoutSeconds ? `    timeout: PT${step.timeoutSeconds}S\n` : "") +
            // Safe unconditionally here: a pure function with no network cannot
            // have had a side effect on attempt 1 (R9, and see `StepRetry`).
            retryBlock(step.retry, "    ") +
            // The fragment's ONLY source of data. No env, no volumes, no
            // mounted config — 04 §5.3.2, "the container sees its input and
            // nothing else".
            `    inputFiles:\n` +
            `      input.json: |\n${block(displayCodeInput(step, model.steps) ?? missingInput(step), "        ")}\n` +
            `    script: |\n${block(codeWrapper(step), "      ")}`,
        );
        continue;
      }

      if (step.kind === "approval") {
        // A two-task shape, for the reason the header gives: the wait has
        // to outlive this process. See the ApprovalStep doc comment.
        emit(step.id, 
          httpRequest({
            id: step.id,
            note,
            path: "/api/steps/approval",
            authHeader: STEP_AUTH,
            body: [
              `      {`,
              `        "stepId": ${q(step.id)},`,
              `        "taskrunId": "{{ taskrun.id }}",`,
              `        "executionId": "{{ execution.id }}",`,
              // Sent, not derived — the resume path must never reproduce the
              // naming convention. If the two disagreed the execution would sit
              // PAUSED until `pauseDuration` expired, which looks exactly like
              // "nobody has got round to approving it yet".
              `        "resumeTaskId": ${q(`${step.id}${AWAIT_SUFFIX}`)},`,
              `        "summary":`,
              block(displaySummary(step, model.steps) ?? missingInput(step), "          "),
              `        ,`,
              `        "context":`,
              block(displayContext(step, model.steps) ?? "null", "          "),
              `      }`,
            ].join("\n"),
          }),
        );
        emit(step.id, 
          `  - id: ${step.id}${AWAIT_SUFFIX}\n` +
            `    type: io.kestra.plugin.core.flow.Pause\n` +
            `    # waits for a HUMAN — POST /…/step-approvals/:id/decide, then\n` +
            `    # step-approval.service.ts resumes this task. The wait lives HERE,\n` +
            `    # in Kestra's database, so restarting the API server does not lose it.\n` +
            // Default 24h rather than an hour: the thing being waited on
            // is a person. Still bounded — an unbounded Pause holds an M3 slot
            // for ever, and "forever" for a human gate means until someone
            // notices the workspace can no longer start runs.
            `    pauseDuration: PT${step.awaitSeconds ?? 86_400}S\n` +
            `    onResume:\n` +
            `      - id: decision\n` +
            `        type: STRING\n` +
            `      - id: note\n` +
            `        type: STRING\n`,
        );
        continue;
      }

      if (step.kind === "merge") {
        // No credential and no I/O — the same reason a `transform` stays in
        // Kestra (R2's credential test, visible). It is a pure coalesce.
        //
        // ⚠ The final `?? "null"` is load-bearing. A branch chain with no
        // `else` can leave EVERY source unexecuted, and without a terminal
        // literal the whole expression renders to nothing and the step fails —
        // a merge blowing up precisely when the interesting thing happened
        // (no arm matched). `"null"` parses back through `json(…)` as null, so
        // a downstream step sees an absent value rather than an error.
        emit(step.id,
          `  - id: ${step.id}\n` +
            `    type: io.kestra.plugin.core.debug.Return\n` +
            (note ? `    # ${note}\n` : "") +
            `    format: |\n${block(mergeExpr(model, step), "      ")}`,
        );
        continue;
      }

      if (step.kind === "branch") {
        /**
         * ⚠ **`then:` and nothing else** — foundations Phase 3. There is no
         * `else:` and the model has no field for one; see `BranchStep` for why
         * the second arm is deferred rather than forgotten.
         *
         * The arm's tasks are appended by the assembler below, indented by four.
         * They are NOT emitted here, so every kind's own emission stays
         * unchanged and the nesting lives in exactly one place.
         *
         * ⚠ The task type is chosen HERE, by the compiler, like every other type
         * it emits (R8). `conditionExpr` is opaque and interpolated verbatim,
         * exactly as `paramsExpr` is — which is survivable for the same reason
         * (D-16): it has already been through D-22's allowlist and
         * `checkSpanBalance` before it could reach a revision.
         * A converted step's condition is rendered from `test` through
         * `render.ts` (allowlisted by construction); an unreadable one the
         * upgrade left as written still travels verbatim under D-22.
         */
        // ⚠ An `else` emits NO `If` of its own — it is a list of tasks inside
        // the previous branch's `else:`. Only a branch WITH a condition is a
        // task; the assembler below nests the rest. The condition is the old
        // display verbatim when present, else rendered from `test` — and a
        // branch with neither that is not an `else` was already refused above,
        // so an empty render here is writer-written garbage, refused by name.
        const condition = displayCondition(step, model.steps);
        if (!condition && !step.elseOf) {
          throw new FlowCompileError(`branch step "${step.id}" has no renderable condition`, step.id);
        }
        if (condition) {
          emit(
            step.id,
            `  - id: ${step.id}\n` +
              `    type: io.kestra.plugin.core.flow.If\n` +
              (note ? `    # ${note}\n` : "") +
              `    condition: |\n${block(condition, "      ")}\n` +
              `    then:`,
          );
        }
        continue;
      }

      if (step.kind === "llm") {
        // Stage 4.1 — the model key never enters the engine (R2): Kestra posts
        // the rendered prompt to Foundry, which calls the deployment's gateway
        // with the step's chosen model and answers `{text, …}`. Same task shape
        // as `tool` — one callback, one envelope.
        emit(step.id,
          httpRequest({
            id: step.id,
            note,
            path: "/api/steps/llm",
            authHeader: STEP_AUTH,
            retry: step.retry,
            body: [
              `      {`,
              `        "ref": "llm",`,
              `        "stepId": ${q(step.id)},`,
              `        "taskrunId": "{{ taskrun.id }}",`,
              `        "params":`,
              block(llmParamsBlock(step), "          "),
              `      }`,
            ].join("\n"),
          }),
        );
        continue;
      }

      if (step.kind === "http") {
        // Stage 4.2 — the workspace egress policy never enters the engine
        // either: Foundry classifies the host (`STRICT`) and dials, answering
        // `{body, status_code, headers, size}`. No `ref` — there is nothing to
        // resolve; the request fields ARE the step.
        emit(step.id,
          httpRequest({
            id: step.id,
            note,
            path: "/api/steps/http",
            authHeader: STEP_AUTH,
            retry: step.retry,
            body: [
              `      {`,
              `        "stepId": ${q(step.id)},`,
              `        "taskrunId": "{{ taskrun.id }}",`,
              `        "params":`,
              block(httpParamsBlock(step), "          "),
              `      }`,
            ].join("\n"),
          }),
        );
        continue;
      }

      // Only the three ref-calling kinds reach here: `compile` runs
      // `validateModel` first, which refuses anything without an emitter. The
      // type system cannot see that guarantee, so this narrows the remainder
      // explicitly — and re-states the allowlist on the path that is
      // unreachable at runtime rather than asserting a shape.
      if (step.kind !== "tool" && step.kind !== "datasource" && step.kind !== "query") {
        throw new FlowCompileError(
          `step kind "${step.kind}" is not emittable; ` + `allowed: ${[...KINDS].join(", ")}`,
          step.id,
        );
      }

      emit(step.id,
        httpRequest({
          id: step.id,
          note,
          path:
            step.kind === "tool"
              ? "/api/steps/tool"
              : step.kind === "datasource"
                ? "/api/steps/datasource"
                : "/api/steps/query",
          authHeader: STEP_AUTH,
          timeoutSeconds: step.timeoutSeconds,
          retry: step.retry,
          body: [
            `      {`,
            `        "ref": ${q(step.ref)},`,
            // Frozen step SQL (mock-data plan): the human-approved statement,
            // verbatim. The executor runs exactly this text when present and
            // falls back to the stored ref text when absent (legacy).
            // `JSON.stringify` — not `q()` — because a statement spans lines
            // and JSON strings must escape them; `q()` only quotes one line.
            ...(step.kind !== "tool" && step.datasourceRef
              ? [`        "datasourceRef": ${q(step.datasourceRef)},`]
              : []),
            ...(step.kind !== "tool" && step.sql
              ? [`        "sql": ${JSON.stringify(step.sql)},`]
              : []),
            // The binding for a step-local statement. Emitted only beside
            // `sql` — a stored reader supplies its own, and sending both would
            // give the executor two answers to one question.
            ...(step.kind !== "tool" && step.sql && step.sqlParamOrder?.length
              ? [`        "sqlParamOrder": ${JSON.stringify(step.sqlParamOrder)},`]
              : []),
            ...(step.kind !== "tool" && step.sql && step.sqlParamsSchema
              ? [`        "sqlParamsSchema": ${JSON.stringify(step.sqlParamsSchema)},`]
              : []),
            `        "stepId": ${q(step.id)},`,
            `        "taskrunId": "{{ taskrun.id }}",`,
            `        "params":`,
            block(displayParams(step, model.steps) ?? missingInput(step), "          "),
            // Tool-only: caller-supplied values beyond the endpoint schema,
            // merged into the first params object by step-execution. Inline
            // JSON — this body is raw JSON, not YAML. The datasource/query
            // routes have their own body shape.
            ...(step.kind === "tool" && step.extraInputs?.length
              ? [
                  `        ,`,
                  `        "extraParams": ${JSON.stringify(step.extraInputs)}`,
                ]
              : []),
            `      }`,
          ].join("\n"),
        }),
      );
    }


    // ── assemble: top-level tasks in model order, arms nested in their branch ─
    //
    // ⚠ **if / elif / else nests through `elseOf`.** A branch naming another in
    // `elseOf` is not a top-level task: its whole block goes inside that
    // branch's `else:` list, and an `elif` chain therefore nests one level per
    // link. Everything else is unchanged — an arm is still `armOf`, which is
    // still plain `dependsOn`, and no downstream step knows it is in an arm.
    const pad = (t: string, n: number) =>
      t
        .split("\n")
        .map((l) => (l.length ? `${"    ".repeat(n)}${l}` : l))
        .join("\n");
    const continuedBy = new Map<string, FlowStep & { kind: "branch" }>();
    for (const s of model.steps) {
      if (s.kind === "branch" && s.elseOf) continuedBy.set(s.elseOf, s);
    }

    /**
     * One branch and everything under it, at `depth` levels of four spaces. `ifs` counts the `If` tasks around it inside a
     * loop, and `xf` re-addresses a loop body's task to the current item at that depth (D-361); outside a loop both are the
     * identity, so the YAML is byte-identical to before.
     */
    const renderBranch = (step: FlowStep & { kind: "branch" }, depth: number, ifs = 0, xf: (text: string, ifs: number) => string = (t) => t): string[] => {
      const out: string[] = [];
      const head = emitted.get(step.id);
      // A conditionless `else` emits no `If`; only its arm's tasks appear.
      if (head !== undefined) out.push(pad(xf(head, ifs), depth));
      // ⚠ The whole arm indented uniformly. A YAML subtree keeps its meaning
      // under a uniform indent — including the block scalars a `transform` and a
      // `code` step emit, which are relative to their own key.
      const armDepth = head !== undefined ? depth + 1 : depth;
      const armIfs = head !== undefined ? ifs + 1 : ifs;
      for (const inner of armOf(model, step.id)) {
        const innerText = emitted.get(inner.id);
        if (innerText === undefined) continue;
        out.push(pad(xf(innerText, armIfs), armDepth));
      }
      const next = continuedBy.get(step.id);
      if (next) {
        // `else:` sits at the `If`'s own indent, its contents one level deeper.
        out.push(`${"    ".repeat(depth)}    else:`);
        out.push(...renderBranch(next, depth + 2, ifs + 1, xf));
      }
      return out;
    };

    /**
     * A loop and its body (D-361): the numbered rows, the ForEach, the body's tasks one level in — each re-addressed to the
     * current item (`loopBody`) — and, when the loop has an output, one per-item pick of its result.
     */
    const renderLoop = (step: ForEachStep): string[] => {
      const out: string[] = [emitted.get(step.id)!];
      const batched = batchOf.get(step.id);
      out.push(
        `  - id: ${step.id}\n` +
          `    type: io.kestra.plugin.core.flow.ForEach\n` +
          (batched
            ? `    # ${step.concurrency} batch${step.concurrency === 1 ? "" : "es"} of up to ${LOOP_BATCH} at a time (D-370); ${step.onError === "stop" ? "a failing batch fails the run" : "a failing item is recorded and the others still run"}\n`
            : `    # ${step.concurrency} at a time; ${step.onError === "stop" ? "one failing item fails the run" : "a failing item is recorded and the others still run"}\n`) +
          `    values: ${q(`{{ outputs['${step.id}${batched ? LOOP_CHUNKS : LOOP_ROWS}'].value }}`)}\n` +
          `    concurrencyLimit: ${step.concurrency}\n` +
          `    tasks:`,
      );
      const members = loopOf(model, step.id);
      const memberIds = members.map((m) => m.id);
      // P7 (P4-I4): each step an approval inside this loop guards — run only for an item that was approved.
      const gates = new Map(members.flatMap((m) => (m.dependsOn ?? []).filter((d) => members.some((g) => g.id === d && g.kind === "approval")).map((d) => [m.id, d] as const)));
      const xf = (text: string, ifs: number) => loopBody(text, step, memberIds, ifs, gates);
      for (const m of members) {
        if (ownedBy.has(m.id)) continue;
        if (m.kind === "branch") {
          if (m.elseOf) continue;
          out.push(...renderBranch(m, 1, 0, xf));
          continue;
        }
        const text = emitted.get(m.id);
        if (text !== undefined) out.push(pad(xf(text, 0), 1));
      }
      const collect = model.steps.find((s): s is CollectStep => s.kind === "collect" && s.loop === step.id);
      if (collect && batched) {
        out.push(pad(
          `  - id: ${step.id}${LOOP_PICK}\n` +
            `    type: io.kestra.plugin.core.debug.Return\n` +
            `    # this batch's item numbers, in order, and the batch call's envelope — its results[k] is item k (D-370)\n` +
            `    format: ${q(`{{ {'is': json(taskrun.value) | jq('[.[] | ._i]') | first, 'r': outputs.${batched}[taskrun.value].body ?? '${NO_RESULT}'} | toJson }}`)}`,
          1,
        ));
      } else if (collect) {
        const r = model.steps.find((s) => s.id === collect.result)!;
        out.push(pad(
          `  - id: ${step.id}${LOOP_PICK}\n` +
            `    type: io.kestra.plugin.core.debug.Return\n` +
            `    # this item's number and its result — "${NO_RESULT}" when ${r.id} did not finish for it\n` +
            `    format: ${q(`{{ {'i': json(taskrun.value)._i, 'r': outputs.${r.id}[taskrun.value].${r.kind === "transform" || r.kind === "merge" ? "value" : "body"} ?? '${NO_RESULT}'} | toJson }}`)}`,
          1,
        ));
      }
      return out;
    };

    for (const step of model.steps) {
      // An arm member is emitted INSIDE its branch, never at top level; a loop's body inside its ForEach.
      if (ownedBy.has(step.id) || inLoop.has(step.id)) continue;
      if (step.kind === "for_each") {
        lines.push(...renderLoop(step));
        continue;
      }
      if (step.kind === "branch") {
        // A continuation is emitted by the branch it continues, not here.
        if (step.elseOf) continue;
        lines.push(...renderBranch(step, 0));
        continue;
      }
      const text = emitted.get(step.id);
      if (text === undefined) continue;
      lines.push(text);
    }
    // ── complete — terminal ──────────────────────────────────────────────────
    // Authenticated with the execution token, which burns itself here.
    //
    // ⚠ This is a TASK, so a failed execution never reaches it and the Foundry
    // row stays `running` (I-10). That is why `flowVisibilityService` reconciles
    // on read and `begin` reconciles before refusing on budget. Do not "fix" it
    // by inferring completion in Foundry — Kestra is the system of record (R6).
    lines.push(
      httpRequest({
        id: "complete",
        path: "/api/executions/{{ json(outputs.begin.body).flowExecutionId }}/complete",
        authHeader: STEP_AUTH,
        body: `      { "status": "succeeded" }`,
      }),
    );

    // ── the Schedule trigger — live namespace only, approved revisions only ──
    if (opts.withSchedule) {
      if (!model.schedule) {
        throw new FlowCompileError("withSchedule was requested but the model declares no schedule");
      }
      lines.push(`triggers:`);
      lines.push(`  - id: schedule`);
      lines.push(`    type: io.kestra.plugin.core.trigger.Schedule`);
      lines.push(`    cron: ${q(model.schedule.cron)}`);
      if (model.schedule.timezone) lines.push(`    timezone: ${q(model.schedule.timezone)}`);
    }

    const yaml = lines.join("\n") + "\n";
    return {
      yaml,
      hash: "sha256:" + crypto.createHash("sha256").update(yaml).digest("hex"),
      refs: callSteps(model),
    };
  },

  /**
   * Digest of the model's STRUCTURE — ids, kinds, refs, dependencies, inputs and
   * the schedule. Deliberately excludes `generatedCode` and any future fragment
   * body.
   *
  * §6.5's asymmetry is implemented by comparing this across revisions: a
  * structure change needs human re-approval, a fragment-body change needs only
  * an automated re-test. Written as its own function rather than "hash the
  * model minus some keys" so that adding a field is a decision about which side
  * of that line it falls on.
  */
  structureHash(model: FlowModel): string {
    const shape = {
      // ⚠ `label`/`description` ARE hashed. They are what the operator is asked,
      // and a revision that asks a different question is a different revision —
      // the same reason `description` is OUT of an expectation's hash but the
      // predicate is in. Cheap to include, and leaving them out would let the
      // prompt a person answers change under an approved flow silently.
      inputs: (model.inputs ?? []).map((i) => [
        i.id,
        i.type,
        i.required ?? null,
        i.defaults ?? null,
        i.computed ?? null,
        i.label ?? null,
        i.description ?? null,
        // Only when present: appending a null would move the hash of every revision already stored.
        ...(i.offsetDays !== undefined ? [i.offsetDays] : []),
      ]),
      steps: model.steps.map((s) => {
        const head = [s.id, s.kind, (s.dependsOn ?? []).slice().sort()];
        switch (s.kind) {
          case "transform":
            // `mode`/`templateText` are structure when the step is a template:
            // the text is what runs, so editing it must read as changed (§6.5).
            // A non-blank expression hashes verbatim exactly as before — an
            // explicit `mode: "expression"` contributes nothing either, so
            // upgrade-stamped rows hash identically and no armed flow
            // re-approves for the upgrade (the `retryShape` rule). A
            // rows-converted step hashes what the rows render to, so editing
            // rows reads as changed exactly as editing the expression would.
            return [...head, s.expr?.trim() ? s.expr : (hasTransformRows(s) ? renderTransformRows(s, model.steps) : (s.expr ?? null)), ...(s.mode === "template" ? [s.mode, s.templateText ?? null] : [])];
          case "code":
            // `s.code` is EXCLUDED and that is the point (§6.5). A fragment
            // body changing is the automated-retest case; its CONTRACT
            // changing — what goes in, what must come out — is the case that
            // needs a human, because it is what decides which systems a step
            // can touch. Regenerating a fragment must not force a re-approval,
            // or at 1-of-3 first-pass accuracy the gate gets switched off.
            // Dual read (Stage 3): the display string when the upgrade left it
            // as written, else what the typed fields render to. A converted
            // canonical step renders byte-identically, so its hash — STORED on
            // every revision row and compared BETWEEN stored rows by
            // `flowApprovalService.diff` — does not move on upgrade; a step the
            // upgrade could only render lossily moves honestly, which is a real
            // behaviour change and should read as one.
            // Dual read (property-rows project): a blank display hashes what
            // the rows render to — the same value the emitter runs — so a
            // non-blank display hashes verbatim exactly as before.
            return [...head, s.inputExpr?.trim() ? s.inputExpr : displayCodeInput(s, model.steps), s.outputKeys.slice().sort(), ...retryShape(s)];
          case "branch":
            // ⚠ The condition IS structure, and this line is the whole reason it
            // is written down: without it an armed flow reports NO structure
            // change when its branch condition is edited, so "only email when
            // the report is non-empty" could quietly become "always email" and
            // keep its approval. That is the §6.5 asymmetry pointed backwards.
            // ⚠ `elseOf` is structure for the SAME reason the condition is.
            // Without it, moving an arm from "when the report is empty" to
            // "otherwise" reports NO structure change and keeps its approval —
            // and those two are opposite behaviours over the same steps.
            return [...head, s.conditionExpr?.trim() ? s.conditionExpr : (displayCondition(s, model.steps) || null), s.elseOf ?? null];
          case "merge":
            // ⚠ `sources` IS structure, and the ORDER of it is too — so it is
            // hashed as written, never sorted. The list is a priority: the
            // first source that produced output wins, so reordering it changes
            // which arm's result the tail acts on when more than one ran. An
            // armed flow whose merge was reordered is doing something different
            // and must read as changed (§6.5).
            //
            // ⚠ It also needs an explicit case because the `default:` below
            // reads `s.ref` and `s.paramsExpr` — a merge has neither, so
            // falling through would hash two `undefined`s and every merge in
            // the workspace would collide with every other.
            return [...head, s.sources];
          case "approval":
            // All three fields are structure. `summaryExpr` is what the approver
            // is asked, `contextExpr` is what they are shown, and `awaitSeconds`
            // is how long the gate holds before timing out — changing any of
            // them changes what a past approval actually meant, so a revision
            // that edits them is a different revision.
            return [...head, s.summaryExpr ?? displaySummary(s, model.steps), s.contextExpr ?? displayContext(s, model.steps) ?? null, s.awaitSeconds ?? null];
          case "llm":
            // Every field is structure: the model, the sampling, the prompt and
            // the declared output shape all change what an approved run would do.
            // Unsavable until Stage 4 lands the emitter — hashed honestly anyway,
            // so the emitter inherits a hash that already distinguishes edits.
            return [
              ...head,
              s.model,
              s.tempPreset,
              s.temperature,
              s.topP,
              s.frequencyPenalty,
              s.presencePenalty,
              JSON.stringify(s.promptBlocks),
              s.contextStepId ?? null,
              JSON.stringify(s.outputFields),
              s.memoryEnabled,
              s.visionDetail,
              s.reasoningSeparated,
              ...retryShape(s),
            ];
          case "http":
            // Same posture as `llm`: the request line is the behaviour, so the
            // method, target, headers, params, body, auth reference, timeouts
            // and TLS flag are all structure. The secret itself never appears —
            // `auth` carries a `secretRef`, never a token.
            return [
              ...head,
              s.method,
              s.url,
              JSON.stringify(s.headers),
              JSON.stringify(s.queryParams),
              JSON.stringify(s.body),
              JSON.stringify(s.auth),
              JSON.stringify(s.timeouts ?? null),
              s.sslVerify,
              ...retryShape(s),
            ];
          case "for_each":
            // Every setting is structure: what it runs over, how many at once, and whether one failure stops the run are all
            // behaviour an approval was given against (§6.5).
            return [...head, s.over?.stepId ?? null, s.concurrency, s.onError];
          case "collect":
            // Which step is each row's result changes what the steps after the loop read.
            return [...head, s.loop, s.result];
          default:
            // `extraInputs` joins `paramsExpr` — present only, same reason. A
            // blank display hashes what the rows render to, exactly as the
            // emitter runs; non-blank hashes verbatim, as before.
            // Frozen step SQL is structure (§6.5): the approval was given
            // against that exact statement, so editing it must move the hash
            // and invalidate the approval. `null` when absent, so a legacy
            // step hashes byte-identically to before.
            return [...head, s.ref, s.paramsExpr?.trim() ? s.paramsExpr : displayParams(s, model.steps), s.datasourceRef ?? null, s.sql ?? null, s.sqlParamOrder ?? null, s.sqlParamsSchema ?? null, ...retryShape(s), ...(s.extraInputs ? [JSON.stringify(s.extraInputs)] : [])];
        }
      }),
      schedule: model.schedule ? [model.schedule.cron, model.schedule.timezone ?? null] : null,
      // Phase 6 — the trigger SURFACE is structure, exactly as `schedule` is:
      // a declared webhook/api name decides what external systems can start
      // this flow, so an armed flow whose declaration changed must read as
      // changed (§6.5). `null` when absent, so a flow with no declaration
      // hashes identically to the pre-Phase-6 shape modulo the new keys.
      /**
       * ⚠ **PINNED `null` AND IT MUST STAY IN THIS SHAPE — DO NOT TIDY IT
       * AWAY.** `webhook` was retired on 2026-09-08 and can no longer be
       * declared, so this key can only ever be null now. Removing it would
       * change the JSON this hash is taken over, and `structureHash` is
       * **STORED** on every `flow_revisions` row and compared BETWEEN STORED
       * ROWS (`flow-approval.service.ts`'s `diff`) — so every existing
       * revision's hash would stop matching a newly written one and every
       * diff spanning the change would report a structural change that did
       * not happen.
       *
       * This is `manifest-builder`'s hardcoded `isDummy: false` exactly, and
       * that comment says the same thing for the same reason: a key inside a
       * hash is load-bearing long after the feature behind it is gone.
       */
      webhook: null,
      api: model.api?.name ?? null,
      concurrencyLimit: model.concurrencyLimit ?? null,
      // ⚠ **NO `output` KEY, AND THE ABSENCE IS THE DECISION (2026-09-14).**
      // What an automation RETURNS is not what an approval PERMITS: editing
      // the End boundary's rows changes no step, no binding, no schedule, so
      // a revision that only re-points the answer is the same revision for
      // §6.5's purposes. Adding the key would also retcon the hash — it is
      // STORED on every `flow_revisions` row (see `webhook` above) — forcing
      // mass re-approval for a change that alters nothing that runs.
    };
    return "sha256:" + crypto.createHash("sha256").update(JSON.stringify(shape)).digest("hex");
  },

  /** Every tool / named-query / DB-operation ref a model touches — what staleness is computed over. */
  refsOf: callSteps,
};

/**
 * `retry` as it contributes to the structure hash — and NOTHING when the step
 * declares none.
 *
 * Two reasons for that shape. It is on the structure side of §6.5's line at all
 * because retry changes what a past approval permitted: "may send this batch"
 * and "may send this batch up to five times" are different grants, and the whole
 * point of binding approval to a revision is that nobody can widen the grant by
 * editing. And it appends only when present so that a step without retry hashes
 * exactly as it did before this field existed — otherwise every armed flow in
 * every workspace would have reported a structure change on the deploy that
 * introduced retry, which is a re-approval prompt carrying no information.
 */
function retryShape(s: FlowStep): unknown[] {
  const r = (s as { retry?: StepRetry }).retry;
  if (!r) return [];
  return [
    ["retry", r.maxAttempts, r.backoff ?? "constant", r.intervalSeconds ?? 5, r.maxDurationSeconds ?? null],
  ];
}

/**
 * The refs a model resolves against the manifest.
 *
 * `transform` and `code` contribute NOTHING here, and that follows
 * from R9 rather than being an omission: neither names a tool or a query,
 * because neither can reach one — a fragment has no network. Adding a kind
 * means deciding whether it belongs in this list, which is
 * why it is one function rather than a filter repeated at both call sites — the
 * staleness sweep and the compiled-refs record must never disagree.
 *
 * ⚠ **A STEP-LOCAL READ contributes nothing either, and that is `namesManifestRef`'s
 * whole job.** The kind test used to be written out here, so a step carrying its
 * own `sql` + `datasourceRef` contributed a ref `refFingerprints()` has no key
 * for — and `flowApprovalService.approve` refuses a revision whose refs are
 * `<missing>`. That made every flow with such a read unpublishable, and
 * therefore unschedulable. Read `namesManifestRef`'s docblock in
 * `sql-projection.ts` before changing this filter: the reason the exemption is
 * safe is that the statement is already inside `structureHash`.
 */
function callSteps(model: FlowModel): string[] {
  return model.steps
    .filter((s): s is CallStep => namesManifestRef(s))
    .map((s) => s.ref);
}
