// packages/flow-edit/src/from-model.ts — read a STORED flow back into the shape
// a person edits. foundations Phase 2.2, and the fix for I-130.
//
// ── The direction that was missing ───────────────────────────────────────────
//
// `splitDraft` on the server goes one way: an authored flow (a `code` step
// carries a CONTRACT and no code) becomes a stored `FlowModel` (a `code` step
// carries code and derived `outputKeys`, and the contract goes to its own
// column). Nothing went back. So `FlowBuilder` accepted an `initial` prop that
// no call site could fill, the canvas was **create-only**, and the three
// authoring modes were three one-way streets: a flow designed from a goal could
// never be opened on the canvas, and a canvas flow could never be reopened.
//
// This is the inverse, and it is possible only because the contract is persisted
// per step — `flow_steps.contract_json`, stored beside `generated_code`
// *because the two have different lifetimes*, whose own comment says "losing the
// contract means a fragment can never be regenerated." That column is what makes
// the reopen cheap; without it this function could not exist honestly.
//
// ── Why `code` comes out here and never goes back in ─────────────────────────
//
// This file, not `index.ts`, is where a stored step's `code` is read — and that
// split is enforced rather than stylistic. `scripts/ui-honesty-check.sh` asserts
// that `index.ts` contains no `code:` field at all, because `AuthoredStep` is
// what a canvas emits and a body typed on a canvas is code no contract
// describes. The stored shape read below is the *other* shape, so it must live
// where that assertion is not pointed — and the guarantee that the two do not
// meet is a **runtime test** (`from-model.test.ts`: no returned step carries a
// `code` key, over a model whose every step did), not a grep.
//
// The bytes are not thrown away. They come out as `carriedCode`, which is what
// makes a chat turn cost at most one fragment: see `carriedCode` below.
//
// ── PURE, like the rest of this package ──────────────────────────────────────
//
// No I/O, no server imports. The stored shapes below are a declared MIRROR of
// `flowModelSchema` and `stepContractSchema`, and the mirror is pinned from the
// server side by `services/flow-authored-from-model.test.ts`, which assigns a
// real `FlowModel` to `StoredFlow` — so a new field on the server's model is a
// type error there rather than a silent drop here.

import { RETRYABLE_KINDS } from "./index.js";
import type {
  AuthoredFlow,
  AuthoredStep,
  ContractField,
  FlowInput,
  FlowOutputRow,
  NamedParam,
  StepContract,
} from "./index.js";
import { normaliseModel } from "./model-version.js";
import {
  buildApprovalSummary,
  buildCodeInput,
  buildCondition,
  buildFanOutParams,
  buildSingleParams,
  rowsExpr,
  type CodeInputValue,
  type ItemPredicate,
  type Mapping,
  type OutputShapes,
} from "./render.js";
import type { InputBinding, Source } from "./node-types.js";
import type { BranchTest } from "./render.js";

/**
 * A contract as PERSISTED — `stepContractSchema`, which carries `stepId` where
 * this package's `StepContract` does not (`splitDraft` adds it on the way in).
 * Optional here so a caller holding either shape can pass it.
 */
export type StoredContract = StepContract & { stepId?: string };

/**
 * A step as PERSISTED. A structural mirror of `flowModelSchema`'s
 * discriminated union, flattened: every field optional, `kind` a plain string.
 *
 * ⚠ Flattened deliberately. A faithful copy of the union here would be a second
 * declaration of what a step may contain — the thing task 2.10 (D-134) exists to
 * prevent — and this function does not need one: it reads the fields each kind
 * has and REFUSES a kind it does not recognise, which is the behaviour that makes
 * a new step kind a failure rather than a silent deletion.
 */
/**
 * Typed property rows (property-rows project) as STORED — carried through on
 * open, never interpreted here. Local shapes by contract ("others define
 * local types and note the merge point"): the canonical row vocabulary
 * reunites in `index.ts` once every row section's write path has landed, and
 * the Catalogue slice owns that reunification.
 */
type RowSourceLike =
  | { kind: "fixed"; value: string }
  | { kind: "step"; stepId: string; field: string }
  | { kind: "expression"; template: string };
type ConditionSideLike = { stepId: string; field: string } | { fixed: string };
export type StoredStep = {
  id: string;
  kind: string;
  /** A person's label. NOT the address — see `StepLabel` in `index.ts`. */
  name?: string;
  /** Prose. Read by people; never by the compiler. */
  description?: string;
  ref?: string;
  paramsExpr?: string;
  /** Caller-supplied tool values beyond the endpoint schema. */
  extraInputs?: NamedParam[];
  expr?: string;
  inputExpr?: string;
  promptExpr?: string;
  /** Named static values for the agent's LLM context. */
  contextParams?: NamedParam[];
  summaryExpr?: string;
  contextExpr?: string;
  /**
   * Stage-3 typed fields (v2 revisions carry these INSTEAD of the expression
   * strings above). Optional because v1 history has none — `normaliseModel`
   * derives them on the way in, and this function emits both representations.
   */
  inputs?: InputBinding[];
  over?: { stepId: string; field: string } | null;
  where?: { field: string; test: BranchTest; value?: string } | null;
  /**
   * Typed property rows (property-rows project). Carried onto the authored
   * step beside the display strings; the panel's sections read these, the
   * server renders them when the display is blank. `params` keyed by
   * parameter name; the binding/column lists in panel order.
   */
  params?: Record<string, { source: RowSourceLike }>;
  inputBindings?: Array<{ name: string; source: RowSourceLike }>;
  outputColumns?: Array<{ name: string; type?: string; source: RowSourceLike }>;
  conditions?: Array<{ left: ConditionSideLike; op: BranchTest; right?: ConditionSideLike }>;
  mode?: "expression" | "template";
  templateText?: string;
  test?: { left: Source; operator: BranchTest; right?: string } | null;
  summary?: string;
  context?: Source | null;
  /** The branch guard's condition. Absent on a terminal `else`. */
  conditionExpr?: string;
  /** The branch this one continues — `if` → `elif` → `else`. */
  elseOf?: string;
  /** A merge's candidate steps, in priority order. See `MergeStep` server-side. */
  sources?: string[];
  /** The generated fragment body. Comes OUT as `carriedCode`; never goes onto an `AuthoredStep`. */
  code?: string;
  /** Derived server-side from the contract. Deliberately dropped, never carried. */
  outputKeys?: string[];
  dependsOn?: string[];
  timeoutSeconds?: number;
  awaitSeconds?: number;
  /** An `llm` step's model id — the deployment's configured model. */
  model?: string;
  tempPreset?: "precise" | "balanced" | "creative" | "custom";
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  promptBlocks?: Array<{ role: "system" | "user" | "assistant"; text: string }>;
  contextStepId?: string | null;
  outputFields?: ContractField[];
  memoryEnabled?: boolean;
  visionDetail?: "high" | "low";
  reasoningSeparated?: boolean;
  /** An `http` step's request shape. */
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  url?: string;
  headers?: Array<{ name: string; value: string }>;
  queryParams?: Array<{ name: string; value: string }>;
  body?: { kind: "none" | "json" | "form" | "binary" | "raw"; content: string; contentType?: string; fileVar?: string };
  auth?: { kind: "none" | "api-key" | "basic" | "bearer" | "custom"; headerName?: string; secretRef?: string };
  timeouts?: { connectMs?: number; readMs?: number; writeMs?: number } | null;
  sslVerify?: boolean;
  /** Runtime retry. The authored shape cannot express it — reported in `dropped`. */
  retry?: unknown;
};

/** A flow as PERSISTED — `flowModelSchema`. */
export type StoredFlow = {
  id: string;
  /** Absent = 1. `normaliseModel` stamps 2; v2 revisions carry new fields only. */
  version?: number;
  inputs?: FlowInput[];
  steps: StoredStep[];
  schedule?: { cron: string; timezone?: string };
  /** The declared result — see `AuthoredFlow.output`. Mirrors it exactly. */
  output?: { stepId?: string; description?: string; rows?: FlowOutputRow[] };
  /** A webhook trigger declaration — Phase 6. Same name rule as `AuthoredFlow`. */
  webhook?: { name: string };
  /** An api trigger declaration — Phase 6. Same name rule as `AuthoredFlow`. */
  api?: { name: string };
  concurrencyLimit?: number;
  expectations?: unknown[];
};

export type AuthoredFromModel = {
  flow: AuthoredFlow;
  /**
   * Step id → the fragment body that step already has.
   *
   * ⚠ **This is the fragment-cost control, not a convenience.** Fed back through
   * `applyFragments`, a `code` step whose contract is byte-identical to the one
   * it was generated from keeps its previous bytes and costs **zero** inference;
   * only a step whose contract changed, or a new one, is generated. See
   * `services/flow-fragment-carry.ts`, which owns that comparison — the
   * carrying is not unconditional and must not be made so here.
   *
   * A step whose stored `code` is the server's UNGENERATED placeholder is
   * **absent** from this map: the placeholder is not code, and carrying it would
   * hand `flow-compiler` the one string it rejects by name.
   */
  carriedCode: Record<string, string>;
  /**
   * What the authored shape cannot carry, in words, one entry per thing.
   *
   * ⚠ **Reported rather than silently dropped, and this is the sharp edge of the
   * reopen.** `draftResponseSchema` — which is what the canvas posts and what
   * `authorFlow` parses — has no `concurrencyLimit`, no `expectations` and no
   * per-step `retry`. So a flow reopened on the canvas and saved comes back
   * **without its concurrency limit or its claims**. Losing them with nothing
   * on screen is how an automation stops running and nobody finds out until the
   * month it was supposed to report; a surface showing this list is the whole
   * mitigation, and `ui-honesty-check.sh` asserts one exists.
   *
   * The trigger declarations (`schedule`, `webhook`, `api`) are NOT reported
   * here: Phase 6 added them to `AuthoredFlow`/`draftResponseSchema`, so the
   * canvas carries them through and saving cannot lose them.
   *
   * Empty for the common case: a flow with no schedule, no claims and no retry.
   */
  dropped: string[];
};

export type FromModelResult =
  | ({ ok: true } & AuthoredFromModel)
  | { ok: false; error: string };

export type FromModelOptions = {
  /**
   * The server's `UNGENERATED` placeholder, so a step that was never generated
   * is not reported as having code.
   *
   * ⚠ **Passed in rather than duplicated.** The literal lives in
   * `flow-generation.service.ts` and the compiler rejects it by name; a copy here
   * would be a second definition that drifts in the direction where a
  * placeholder is mistaken for a fragment — which compiles, deploys, and fails
  * at execution. Omitting it is safe for a client that never uses
  * `carriedCode`, and the server always passes it.
  */
  ungenerated?: string;
  /**
   * How each kind's output is reached (`GET …/catalogue` serves it) — needed
   * to RENDER the old display strings from the typed fields. A v1 step the
   * upgrade could not read carries its stored string, so it needs no shapes;
   * a v2 step without them gets a blank display (the typed fields stay
   * authoritative). Both real call sites hold the table; the parameter is
   * optional so existing two-argument calls keep working.
   */
  shapes?: OutputShapes;
};
/** The kinds a step may be. Local so a refusal can name the list. */
const KNOWN_KINDS = [
  "datasource",
  "query",
  "tool",
  "transform",
  "code",
  "approval",
  "branch",
  "merge",
  "llm",
  "http",
] as const;

function contractFields(fields: ContractField[]): ContractField[] {
  return fields.map((f) => ({
    name: f.name,
    type: f.type,
    ...(f.description !== undefined ? { description: f.description } : {}),
    ...(f.items !== undefined ? { items: f.items } : {}),
  }));
}

// ── Dual representation (Stage 3): typed truth + rendered display ───────────
//
// `blankStep`, this function and every writer emit BOTH the new typed fields
// (authoritative) and the old display strings (rendered via `render.ts` for the
// Stage-4 panel, which still reads expressions). A rendered string is parseable
// by construction — it came from the same builders the parsers read — so the
// two representations cannot disagree about what was meant.
//
// Each helper returns `undefined` when the display cannot be honestly
// rendered, and the caller then falls back to the stored string (a v1 step the
// upgrade left as written) or `""`. The typed fields are always emitted as
// normalised; they never depend on rendering.

/** A stored step as the shape the builders read (kind + id are what they use). */
function asAuthoredRef(step: StoredStep): AuthoredStep {
  // The builders read `kind`/`id` only (`rowsExpr`); nothing else crosses.
  return step as unknown as AuthoredStep;
}

function whereToPredicate(where: StoredStep["where"]): ItemPredicate | undefined {
  if (!where) return undefined;
  // `any`/`none` count rows; a per-item filter cannot spell them, so a fan-out
  // carrying one renders without a `select` — the typed `where` keeps the truth.
  if (where.test === "any" || where.test === "none") return undefined;
  return { test: where.test, field: where.field, value: where.value };
}

/** A call step's `paramsExpr`, rendered from its typed bindings. */
function renderParamsExpr(
  step: StoredStep,
  inputs: InputBinding[],
  byId: Map<string, StoredStep>,
  shapes: OutputShapes,
): string | undefined {
  // A `null` binding is an unknown the upgrade refused to guess — there is no
  // honest rendering of it, so the caller carries the stored string instead.
  if (inputs.some((b) => b.source === null)) return undefined;
  const mappings: Mapping[] = inputs.map((b) => ({ param: b.name, source: b.source as Source }));
  if (step.over?.stepId) {
    const over = byId.get(step.over.stepId);
    if (!over) return undefined;
    return buildFanOutParams(shapes, asAuthoredRef(over), mappings, whereToPredicate(step.where)) ?? undefined;
  }
  return buildSingleParams(mappings, { shapes, steps: [...byId.values()].map(asAuthoredRef) }) ?? undefined;
}

/** A branch's `conditionExpr`, rendered from its typed test. */
function renderConditionExpr(
  test: StoredStep["test"],
  byId: Map<string, StoredStep>,
  shapes: OutputShapes,
): string | undefined {
  if (!test) return undefined;
  // Only a step read names rows a guard can test — an input/literal/self
  // `left` has no rows address, so there is nothing honest to render.
  const stepId = test.left.from === "step" || test.left.from === "whole" ? test.left.stepId : "";
  const over = stepId ? byId.get(stepId) : undefined;
  const field = test.left.from === "step" ? test.left.field : undefined;
  const out = buildCondition(
    shapes,
    over ? asAuthoredRef(over) : null,
    test.operator,
    field,
    test.right,
  );
  return out === "" ? undefined : out;
}

/** A typed binding as the `CodeInputValue` the payload builder reads. */
function toCodeValue(source: Source | null | undefined, byId: Map<string, StoredStep>): CodeInputValue {
  if (!source) return null;
  if (source.from === "input") return { kind: "input", inputId: source.inputId, ...(source.transform ? { transform: source.transform } : {}) };
  if (source.from === "literal") return { kind: "literal", value: source.value };
  if (source.from === "whole" || source.from === "step") {
    const found = byId.get(source.stepId);
    if (!found) return null;
    const field = source.from === "step" ? source.field : "";
    const transform = source.from === "step" ? source.transform : undefined;
    const onNull = source.onNull;
    return { kind: "step", step: asAuthoredRef(found), field, ...(transform ? { transform } : {}), ...(onNull ? { onNull } : {}) };
  }
  // `self` (the bare per-row element) has no address in a payload the step
  // runs once with — bound to nothing rather than guessed into something.
  return null;
}

/** A code step's `inputExpr`, rendered from its typed bindings + contract names. */
function renderCodeInputExpr(
  names: string[],
  inputs: InputBinding[],
  byId: Map<string, StoredStep>,
  shapes: OutputShapes,
): string | undefined {
  if (inputs.some((b) => b.source === null)) return undefined;
  const known = new Map(inputs.map((b) => [b.name, b.source]));
  return buildCodeInput(
    shapes,
    names.map((name) => ({ name, source: toCodeValue(known.get(name) ?? null, byId) })),
  );
}

/** An approval's `contextExpr`, rendered from its typed evidence source. */
function renderContextExpr(
  context: Source | null | undefined,
  byId: Map<string, StoredStep>,
  shapes: OutputShapes,
): string | undefined {
  if (!context) return undefined;
  if (context.from === "input") {
    return /^[A-Za-z0-9_]+$/.test(context.inputId) ? `{{ inputs.${context.inputId} }}` : undefined;
  }
  if (context.from === "literal") return JSON.stringify(context.value);
  if (context.from === "whole" || context.from === "step") {
    const found = byId.get(context.stepId);
    if (!found) return undefined;
    const rows = rowsExpr(shapes, asAuthoredRef(found));
    if (!rows) return undefined;
    if (context.from === "whole" || !context.field) return `{{ ${rows} }}`;
    const f = /^[A-Za-z_][A-Za-z0-9_]*$/.test(context.field) ? `.${context.field}` : `.[${JSON.stringify(context.field)}]`;
    const proj = context.transform === "date"
      ? `(${f} | tostring | split("T")[0])`
      : context.transform === "text"
        ? `(${f} | tostring)`
        : context.transform === "number"
          ? `(${f} | tonumber)`
          : f;
    return `{{ ${rows} | jq('[.[] | ${proj}]') }}`;
  }
  return undefined;
}
/**
 * Read a stored flow model plus its per-step contracts back into the shape a
 * person edits — the drafter's own response shape, which is what `authorFlow`
 * takes.
 *
 * Refuses rather than guessing in three cases, all of which are a wrong answer
 * somebody would act on:
 *
 * - **A `code` step with no stored contract.** The contract is the standard the
 *   fragment is judged against, so inferring one from the code silently
 *   redefines that standard — `flowService.contractsFor` already states the
 *   honest outcome for this case ("can be run and approved but not
 *   regenerated"), and reopening it on a canvas that then re-derives
 *   `outputKeys` from an invented contract is worse than refusing to open it.
 * - **A contract whose `stepId` names a different step.** That is a contract
 *   copied between steps, and carrying it would judge one fragment against
 *   another's declaration.
 * - **An unrecognised kind.** ⚠ This is the assertion that made Phase 3 a
 *   FAILURE rather than data loss: adding `branch` turned the test below red on
 *   the day the kind was declared, which is exactly what an absence check is
 *   for. A version of this function that skipped what it did not know would open
 *   a branching flow on the canvas with the branch quietly deleted and its arm
 *   dangling.
 */
export function authoredFromModel(
  model: StoredFlow,
  contracts: Record<string, StoredContract>,
  opts: FromModelOptions = {},
): FromModelResult {
  const steps: AuthoredStep[] = [];
  const carriedCode: Record<string, string> = {};
  const dropped: string[] = [];

  // Stage 3: accept a v1 or a v2 stored model. `normaliseModel` derives the
  // typed fields from the expression strings (or keeps the stored new ones),
  // so every arm below reads the typed fields and renders the display beside
  // them — all call sites work unchanged.
  // `as unknown as StoredFlow`: the upgrade is untyped by design (it reads
  // history, which may predate any shape); the arms below re-check per kind.
  const normalised = normaliseModel(model) as unknown as StoredFlow;
  const shapes = opts.shapes ?? {};
  const stored = Array.isArray(normalised.steps) ? normalised.steps : [];
  const byId = new Map(stored.map((s) => [s.id, s]));

  for (const s of stored) {
    const dependsOn = s.dependsOn !== undefined ? { dependsOn: s.dependsOn } : {};
    const timeout = s.timeoutSeconds !== undefined ? { timeoutSeconds: s.timeoutSeconds } : {};
    const await_ = s.awaitSeconds !== undefined ? { awaitSeconds: s.awaitSeconds } : {};

    /**
     * ⚠ **The canvas CAN express a retry now, and this used to say it could
     * not.** The message was also wrong on the surface people read it on: the
     * builder page's `authoredToStoredFlow` has always carried `retry` from the
     * previous revision, so *"reopening and saving removes it"* was untrue
     * there and true only on the copy path, which has no previous revision.
     *
     * It is now read into the authored step for the kinds the compiler accepts
     * one on, and reported as dropped only for the kinds it does not — where
     * the model is carrying something the engine would refuse anyway.
     */
    const retry =
      s.retry !== undefined && RETRYABLE_KINDS.includes(s.kind as never)
        ? { retry: s.retry as never }
        : {};
    if (s.retry !== undefined && !RETRYABLE_KINDS.includes(s.kind as never)) {
      dropped.push(
        `step "${s.id}" is a \`${s.kind}\` step carrying a runtime retry, which the compiler refuses — it is not kept`,
      );
    }

    /**
     * ⚠ **The label round-trips, and it has to.** A field the canvas reads but
     * does not write back is silent data loss on the first save — the exact
     * shape the retry carry had before it became editable. Written once here so
     * every kind gets it, rather than six times inside the switch where the
     * seventh would be forgotten.
     */
    const label = {
      ...(s.name ? { name: s.name as string } : {}),
      ...(s.description ? { description: s.description as string } : {}),
    };

    switch (s.kind) {
      case "datasource":
      case "query":
      case "tool": {
        // Dual representation: the typed bindings are authoritative; the
        // display string is the stored one when the upgrade left it as written
        // (unknown), else rendered — parseable by construction.
        const inputs = Array.isArray(s.inputs) ? s.inputs : [];
        /**
         * ⚠ **A STEP-LOCAL READ'S OWN STATEMENT, AND ITS ABSENCE HERE WAS A
         * REAL DEFECT — 2026-09-16.**
         *
         * This arm is an ALLOWLIST, the same shape as `bundleStep`'s, and the
         * four fields a step-local read carries were never added to it. They
         * are written by the drafter and stored correctly; every reader that
         * comes back through this adapter — the chat turn
         * (`flow-chat.service.ts`), the builder canvas and `FlowReview` — got a
         * step with a `ref` and nothing behind it.
         *
         * What that cost, measured on flow `cd9f339b`: the chat turn read
         * `fetch_employees` without its SQL, so `refFindings` resolved the ref,
         * found no saved reader by that name (there is none, by design) and
         * answered *"finance_demo IS a datasource … but it has no readable
         * component named employees_with_cost_centres"*. The turn came back
         * `needs_component` and the person's actual request — format the rows —
         * was never applied. The exemption in `refFindings` was already there
         * and correct; it could not fire on a field this adapter had removed.
         *
         * `datasource`/`query` only, matching `authoredToStoredFlow`'s own rule
         * on the write side: a `tool` never carries either.
         *
         * ⚠ **Do not "tidy" these back out.** A field dropped here is invisible
         * — `dropped` did not name it, nothing errored, and the loss surfaced
         * one screen later as a component that does not exist.
         */
        const local = s as unknown as {
          sql?: string;
          datasourceRef?: string;
          sqlParamOrder?: string[];
          sqlParamsSchema?: Record<string, unknown>;
        };
        const stepLocalSql =
          s.kind === "datasource" || s.kind === "query"
            ? {
                ...(local.sql !== undefined ? { sql: local.sql } : {}),
                ...(local.datasourceRef !== undefined ? { datasourceRef: local.datasourceRef } : {}),
                ...(local.sqlParamOrder !== undefined ? { sqlParamOrder: local.sqlParamOrder } : {}),
                ...(local.sqlParamsSchema !== undefined
                  ? { sqlParamsSchema: local.sqlParamsSchema }
                  : {}),
              }
            : {};
        steps.push({
          kind: s.kind,
          id: s.id,
          ...label,
          ref: s.ref ?? "",
          ...stepLocalSql,
          // A rows-converted step carries a blank display beside its rows —
          // rendering the `"[{}]"` fallback here would shadow the rows on the
          // next save (a non-blank display wins verbatim), stranding the
          // conversion. Blank is ABSENT downstream: the save upgrade drops it
          // and the compiler renders the rows.
          paramsExpr: s.paramsExpr ?? (s.params !== undefined ? "" : (renderParamsExpr(s, inputs, byId, shapes) ?? "")),
          ...(s.params !== undefined ? { params: s.params } : {}),
          ...(inputs.length > 0 ? { inputs } : {}),
          ...(s.over !== undefined ? { over: s.over } : {}),
          ...(s.where !== undefined ? { where: s.where } : {}),
          ...(s.extraInputs ? { extraInputs: s.extraInputs } : {}),
          ...dependsOn,
          ...timeout,
          ...retry,
        });
        break;
      }

      case "transform": {
        const mode = s.mode === "template" ? "template" : "expression";
        steps.push({
          kind: "transform",
          id: s.id,
          ...label,
          // The display shares the field: a template transform reads its text
          // here for the Stage-4 panel; the typed `templateText` is the truth.
          expr: mode === "template" ? (s.templateText ?? s.expr ?? "") : (s.expr ?? ""),
          mode,
          ...(s.templateText !== undefined ? { templateText: s.templateText } : {}),
          // Typed rows ride beside the display; a rows-converted step carries
          // a blank `expr` the compiler renders from `outputColumns`.
          ...(s.inputBindings !== undefined ? { inputBindings: s.inputBindings } : {}),
          ...(s.outputColumns !== undefined ? { outputColumns: s.outputColumns } : {}),
          ...dependsOn,
        });
        break;
      }

      case "code": {
        const stored = contracts[s.id];
        if (!stored) {
          return {
            ok: false,
            error:
              `step "${s.id}" is generated code with no stored contract, so it cannot be opened for ` +
              `editing — the contract is what the fragment was generated from, and inferring one from ` +
              `the code would redefine the standard it is judged against`,
          };
        }
        if (stored.stepId !== undefined && stored.stepId !== s.id) {
          return {
            ok: false,
            error:
              `step "${s.id}" holds a contract belonging to "${stored.stepId}" — refusing rather than ` +
              `judging one step's fragment against another's declaration`,
          };
        }
        // ⚠ `stepId` is stripped, and `outputKeys` is not read at all. Both are
        // derived on the way back in (`splitDraft`), which is what stops a
        // declared contract and an enforced output shape disagreeing.
        // A rows-converted step carries a blank display beside its rows —
        // rendering the fallback here would shadow them on the next save.
        // Blank is ABSENT downstream: the save upgrade drops it and the
        // compiler renders `inputBindings`.
        steps.push({
          kind: "code",
          id: s.id,
          ...label,
          inputExpr:
            s.inputExpr ??
            (s.inputBindings !== undefined
              ? ""
              : (renderCodeInputExpr(
                  stored.input.map((f) => f.name),
                  Array.isArray(s.inputs) ? s.inputs : [],
                  byId,
                  shapes,
                ) ??
                "")),
          contract: {
            purpose: stored.purpose,
            input: contractFields(stored.input),
            output: contractFields(stored.output),
          },
          ...(Array.isArray(s.inputs) && s.inputs.length > 0 ? { inputs: s.inputs } : {}),
          // Typed rows ride beside the display; a rows-converted step carries
          // a blank `inputExpr` the compiler renders from these.
          ...(s.inputBindings !== undefined ? { inputBindings: s.inputBindings } : {}),
          ...dependsOn,
          ...timeout,
          ...retry,
        });
        if (s.code !== undefined && s.code !== "" && s.code !== opts.ungenerated) {
          carriedCode[s.id] = s.code;
        }
        break;
      }

      case "branch": {
        // Dual representation: the typed test is authoritative (including an
        // explicit `null` — unknown, kept beside the stored display); the
        // display is the stored string or rendered from the test.
        // A stored "" is not a condition — it is the absence of one written
        // down. It defers to the render, and to the test past that.
        const storedCond = s.conditionExpr?.trim() ? s.conditionExpr : undefined;
        const renderedOpt = storedCond ?? renderConditionExpr(s.test, byId, shapes);
        const rendered = renderedOpt ?? "";
        // ⚠ A typed test the renderer cannot display is still authoritative —
        // the compiler, the arm-chain check and the panel all read `test`.
        // Emitting "" for it poisons every downstream shape check with a
        // min-length failure on a branch that is actually guarded (chat's
        // add_arm died exactly here). Omit the key; the test carries it.
        const unrenderedTyped = renderedOpt === undefined && s.test != null;
        steps.push({
          kind: "branch",
          id: s.id,
          ...label,
          /**
           * ⚠ **Omitting the key IS WRONG FOR AN `if` AND RIGHT FOR A TERMINAL
           * `else`.** An `else` legitimately has no condition; defaulting it to
           * `""` would make the canvas show an empty guard where there should
           * be none, and writing that back is a branch the server refuses. So
           * the key is omitted only for an `else` with neither a test nor a
           * stored condition, and defaulted everywhere else.
           */
          ...(s.elseOf ? { elseOf: s.elseOf } : {}),
          ...(s.test !== undefined ? { test: s.test } : {}),
          ...(s.elseOf && s.test == null && s.conditionExpr === undefined ? {} : unrenderedTyped ? {} : { conditionExpr: rendered }),
          // Typed rows ride beside the display; a conditions-converted step
          // carries a blank `conditionExpr` the compiler renders from these.
          ...(s.conditions !== undefined ? { conditions: s.conditions } : {}),
          ...dependsOn,
        });
        break;
      }

      case "merge":
        steps.push({
          kind: "merge",
          id: s.id,
          ...label,
          /**
           * ⚠ **`?? []` rather than dropping the step, and the empty case is
           * NOT silently repaired.** A stored merge always has at least two
           * sources — the server refuses fewer — so an empty array here means
           * the row is malformed, and the honest thing is to open it empty so a
           * person SEES an unconfigured merge rather than have the editor
           * invent two ids. Writing it back is a refused save, which is the
           * control (`blankStep`'s own reasoning, from the other direction).
           *
           * ⚠ The ORDER is carried as stored, never sorted. It is a priority —
           * the first source that ran wins — so re-ordering it silently changes
           * which arm's result the tail acts on.
           */
          sources: s.sources ?? [],
          ...dependsOn,
        });
        break;

      case "approval": {
        // Dual representation: the typed question + evidence are authoritative;
        // the display strings are the stored ones (unknown) or rendered — the
        // question through the builder, the evidence from its source.
        const overStep =
          s.context && (s.context.from === "step" || s.context.from === "whole")
            ? byId.get(s.context.stepId)
            : undefined;
        steps.push({
          kind: "approval",
          id: s.id,
          ...label,
          summaryExpr:
            s.summaryExpr ??
            (s.summary !== undefined
              ? buildApprovalSummary(shapes, overStep ? asAuthoredRef(overStep) : null, s.summary)
              : ""),
          ...(s.summary !== undefined ? { summary: s.summary } : {}),
          ...(s.contextExpr !== undefined
            ? { contextExpr: s.contextExpr }
            : s.context
              ? { contextExpr: renderContextExpr(s.context, byId, shapes) ?? "" }
              : {}),
          ...(s.context !== undefined ? { context: s.context } : {}),
          ...dependsOn,
          ...await_,
        });
        break;
      }
      case "llm":
        steps.push({
          kind: "llm",
          id: s.id,
          ...label,
          model: s.model ?? "",
          tempPreset: s.tempPreset ?? "balanced",
          temperature: s.temperature ?? 0.7,
          topP: s.topP ?? 1,
          frequencyPenalty: s.frequencyPenalty ?? 0,
          presencePenalty: s.presencePenalty ?? 0,
          promptBlocks: s.promptBlocks ?? [{ role: "user", text: "" }],
          ...(s.contextStepId !== undefined ? { contextStepId: s.contextStepId } : {}),
          outputFields: s.outputFields ? contractFields(s.outputFields) : [],
          memoryEnabled: s.memoryEnabled ?? false,
          visionDetail: s.visionDetail ?? "low",
          reasoningSeparated: s.reasoningSeparated ?? false,
          ...dependsOn,
          ...retry,
        });
        break;

      case "http":
        steps.push({
          kind: "http",
          id: s.id,
          ...label,
          method: s.method ?? "GET",
          url: s.url ?? "",
          headers: s.headers ?? [],
          queryParams: s.queryParams ?? [],
          body: s.body ?? { kind: "none" as const, content: "" },
          auth: s.auth ?? { kind: "none" as const },
          ...(s.timeouts !== undefined ? { timeouts: s.timeouts } : {}),
          sslVerify: s.sslVerify ?? true,
          ...dependsOn,
          ...retry,
        });
        break;

      default:
        return {
          ok: false,
          error:
            `step "${s.id}" has kind "${s.kind}", which this editor does not know how to open ` +
            `(it knows ${KNOWN_KINDS.join(", ")}) — refusing rather than opening the flow without it`,
        };
    }
  }

  // ── Trigger declarations ride through (Phase 6) ────────────────────────────
  //
  // `AuthoredFlow` mirrors `draftResponseSchema`, which now carries all three,
  // so the canvas round-trips them. `concurrencyLimit`/`expectations`/`retry`
  // are still not authored and are reported below.
  const triggers = {
    ...(normalised.schedule !== undefined ? { schedule: normalised.schedule } : {}),
    ...(normalised.webhook !== undefined ? { webhook: normalised.webhook } : {}),
    ...(normalised.api !== undefined ? { api: normalised.api } : {}),
  };

  if (normalised.concurrencyLimit !== undefined) {
    dropped.push(
      `the concurrency limit (${normalised.concurrencyLimit}) is not part of what the canvas edits — reopening and saving removes it`,
    );
  }
  if (Array.isArray(normalised.expectations) && normalised.expectations.length > 0) {
    dropped.push(
      `this flow's ${normalised.expectations.length} expectation(s) are not part of what the canvas edits — ` +
        `reopening and saving removes them, and gate 1 stops requiring them`,
    );
  }

  return {
    ok: true,
    flow: {
      id: typeof normalised.id === "string" ? normalised.id : model.id,
      ...(normalised.inputs !== undefined ? { inputs: normalised.inputs } : {}),
      steps,
      ...triggers,
      // The End boundary's rows — read back so reopening and saving keeps
      // them. (The write half is `authoredToStoredFlow`; one without the
      // other is a form that appears to save and reverts.)
      ...(normalised.output !== undefined ? { output: normalised.output } : {}),
    },
    carriedCode,
    dropped,
  };
}
