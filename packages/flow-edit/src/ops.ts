// packages/flow-edit/src/ops.ts — the twenty-one things a chat turn may do to a flow.
// foundations Phase 2.3 · D-118.
//
// ── Why an op at all ─────────────────────────────────────────────────────────
//
// `flow-refine.service.ts` sends the whole model and gets the whole model back.
// That is defensible once per instruction and wrong for a conversation: ten
// turns is ten full re-emissions, each one an opportunity to rename a step and
// discard its generated fragment, and there is no way to BOUND it — the only way
// to stop a turn being a redesign is for a redesign not to fit in the answer.
//
// So the model returns one op, and **pure code applies it**. Everything below is
// that code. The model chooses *what* to do; it never performs the edit, so it
// cannot half-perform one.
//
// ── The two deletions are the controls ───────────────────────────────────────
//
// There is **no rename op**, and `replace_step` may change neither `id` nor
// `kind`. `buildRefinePrompt` currently only *warns* that renaming a step
// discards its generated code — and a warning is not a control. A kind change
// rewrites every field of a step, which from one ambiguous sentence is the
// collateral-damage case exactly; it is `remove_step` + `add_step`, two turns and
// two diffs, so the person sees both.
//
// ── PURE, and it does not parse ──────────────────────────────────────────────
//
// No zod here, on purpose. The op SCHEMA is
// `packages/server/src/services/flow-chat-op.ts`, because the schema's step field
// must BE `draftedStepSchema` — one definition of what a step may contain, or a
// seventh kind gets half-added: expressible by the drafter and inexpressible in
// chat, with nothing failing (D-134). This file operates on an op that has
// already been parsed, and `flow-chat-op.test.ts` pins the two shapes against
// each other by assignment so they cannot drift apart silently.

import {
  addStep,
  connect,
  dependenciesOf,
  disconnect,
  isValidStepId,
  reaches,
  removeStep,
  replaceStep,
  RETRYABLE_KINDS,
  spliceApproval,
  type AuthoredFlow,
  type AuthoredStep,
  type ContractField,
  type EditResult,
  type FlowInput,
  type FlowOutputRow,
  type InputBinding,
  type Source,
  type StepRetry,
} from "./index.js";
import { NODE_TYPES, propertySpec } from "./node-types.js";
import { BRANCH_TESTS } from "./render.js";
import { isBlankFeed } from "./typecheck/check.js";

/** A branch's typed test — the `AuthoredStep` field, never a second definition of it. */
type GuardTest = NonNullable<Extract<AuthoredStep, { kind: "branch" }>["test"]>;

/**
 * The one guard an op carries: exactly one of the hand-written `conditionExpr`
 * or the typed `test`. Both is refused — an op is fresh model output, so two
 * guards is a reply that disagrees with itself (a STORED flow carrying both is
 * different, and `normaliseModel` settles it); neither is an `otherwise` where
 * that is legal.
 */
function guardOf(conditionExpr: string | undefined, test: GuardTest | undefined): { error: string } | { guard: { conditionExpr?: string; test?: GuardTest } } {
  const expr = conditionExpr?.trim() ? conditionExpr : undefined;
  if (expr && test) return { error: `give the condition as "test" only — not both "test" and "conditionExpr"` };
  return { guard: expr ? { conditionExpr: expr } : test ? { test } : {} };
}

/**
 * A declared input, as a chat op may name one.
 *
 * ⚠ **No `defaults`, and the schema REJECTS one rather than stripping it.**
 * `authorFlow` deliberately *applies* an authored flow's input values, because it
 * trusts that a person at a canvas typed them — which is right there and exactly
 * wrong here. A `defaults` inside a chat op would be applied just as faithfully
 * and become what a scheduled run uses for ever: `period="2023-10"` with a
 * friendly box in front of it.
 *
 * Rejecting rather than stripping is the difference between the person hearing
 * about it and the value disappearing. A stripped field is a request that looked
 * like it worked.
 */
export type ChatFlowInput = Omit<FlowInput, "defaults">;

/**
 * The twenty-two ops. One per turn.
 *
 * ⚠ The model emits the FIRST op and sets `more: true` — a boolean, not a
 * narration. That matches what a person actually asks for (components added
 * sequentially) rather than compromising against it, and it makes *"a turn
 * cannot be a redesign"* structural rather than a prompt rule.
 *
 * ⚠ `set_property` / `set_binding` / `set_output_rows` are the registry
 * vocabulary (Stage 6.1) that replaced the old thirteen-name field op:
 * untyped names could not name the properties the registry declares
 * (`model`, `temperature`, `url` existed nowhere in the model), so chat
 * could not configure a component at all.
 */

export type FlowEditOp =
  /**
   * ⚠ **`inputs` is the step's PREREQUISITES, not a second way to declare one.**
   *
   * Measured 2026-09-06: an automation whose first step reads an input could
   * not be started at all. `declare_input` was refused because no flow existed
   * yet (a stepless revision is illegal — `steps: z.array(...).min(1)` and the
   * compiler both refuse one), and the `add_step` was refused because the input
   * it read was undeclared. Neither refusal was wrong; the vocabulary simply
   * had no legal opening move for an automation that takes a parameter.
   *
   * So a step may carry the inputs it reads, exactly as it already carries
   * `dependsOn`. It is applied through `declareInputs`, the same function
   * `declare_input` uses — one implementation with two call sites, never two
   * implementations — and the array is validated against what the step actually
   * reads, so it cannot become a general side channel.
   */
  | { op: "add_step"; step: AuthoredStep; inputs?: ChatFlowInput[] }
  /**
   * Add a step BETWEEN two linked steps — the chat equivalent of the canvas
   * splice. The new step runs after `afterStepId`, and `beforeStepId` is
   * rewired from `afterStepId` onto it, in one atomic op. A branch can only
   * guard what runs after it, so this is the only way to place one mid-chain;
   * an appended branch guards nothing. Never an approval: gates go through
   * `add_gate`, like `add_step`.
   */
  | {
      op: "insert_step";
      step: AuthoredStep;
      afterStepId: string;
      beforeStepId: string;
    }
  | { op: "remove_step"; stepId: string }
  | { op: "replace_step"; stepId: string; step: AuthoredStep }
  | { op: "connect"; from: string; to: string }
  | { op: "disconnect"; from: string; to: string }
  | { op: "add_gate"; beforeStepId: string; summaryExpr?: string }
  | { op: "declare_input"; input: ChatFlowInput }
  /**
   * The flow's own schedule — `null` removes it.
   *
   * ⚠ **On the MODEL, which is the artefact an approval covers.** D-18 refuses
   * a `schedule` *trigger row* for a flow precisely because that would be a
   * second way to fire it on a timer that no approval covers; this is the first
   * way, and it is why the field has been on `AuthoredFlow` and emitted by the
   * compiler since Phase 6. Setting it writes a revision like any other edit, so
   * an armed flow goes back to `draft_pending` and must be approved again — a
   * schedule change is a change to what runs unattended.
   *
   * ⚠ Added 2026-09-06 because the builder was OFFERING to schedule and could
   * not: asked "do that every Monday morning" it replied "to add the Monday
   * schedule trigger, I need the run time and timezone" — a question with no
   * answer it could act on. A capability the vocabulary lacks is either taught
   * as absent or built; asking for a timezone was neither.
   *
   * ⚠ **The cron is validated by the COMPILER, not here.** `flow-compiler`
   * already refuses a cron that is not 5 or 6 fields and checks each one; a
   * second copy of that rule is free to drift in the direction where the cheap
   * one says yes.
   */
  | { op: "set_schedule"; schedule: { cron: string; timezone?: string } | null }
  /**
   * Declare (or clear) WHICH STEP IS THE ANSWER — 2026-09-08.
   *
   * ⚠ Modelled on `set_schedule` because it has the same shape: a flow-level
   * field, `null` to clear, no step of its own to file the change against. It
   * exists because there was NO WAY for a person to declare a result at all —
   * the builder's exit-point panel reports and does not edit (a form there
   * would be a second author of `model.output`, D-197), and it points at chat.
   */
  | { op: "set_output"; output: { stepId: string; description?: string } | null }
  /**
   * Change a branch guard's condition — foundations Phase 3.
   *
   * ⚠ **Its own op, NEVER an overload of `replace_step`.** A condition change is
   * not a field edit: it changes **what runs**. `replace_step` reads as "adjust
   * this step's settings" on screen and in the transcript, and a turn that
   * silently turned "only email when there is something to report" into "always
   * email" would be described that way for ever. `applyOp` refuses a
   * `replace_step` that moves `conditionExpr`, so the two cannot be confused.
   */
  | { op: "set_condition"; stepId: string; conditionExpr?: string; test?: GuardTest }
  /**
   * Set ONE registry property on a step — the granular alternative to
   * re-emitting the whole step with `replace_step`. The name must be a
   * property `NODE_TYPES[step.kind]` declares (or the free labels `name` /
   * `description`, which every kind carries); the value is validated against
   * that spec's kind at apply time, because the schema cannot see the step.
   * Anything else is refused with a message naming the op that owns it.
   */
  | { op: "set_property"; stepId: string; property: string; value: unknown }
  /**
   * Bind (or unbind, with `null`) ONE named input on a step that carries
   * `inputs` — `tool`, `datasource`, `query` and `code`. On a `code` step the
   * name must be in `contract.input`. The typed successor of the retired
   * `paramsExpr` / `inputExpr` display strings.
   */
  | { op: "set_binding"; stepId: string; name: string; source: Source | null }
  /**
   * Declare what the automation returns — the End boundary's rows, written to
   * the flow, not to a step. Each row names a value and where it is read
   * from. `set_output`'s single-step form stays for the one-step answer.
   */
  | { op: "set_output_rows"; rows: FlowOutputRow[] }
  /**
   * Add or remove ONE contract field on a `code` step — the dynamic-I/O gap.
   * Every other kind's inputs and outputs are owned by its endpoint, query,
   * runtime or model, so these refuse non-`code` steps outright.
   */
  | { op: "add_io"; stepId: string; which: "input" | "output"; field: ContractField }
  | { op: "remove_io"; stepId: string; which: "input" | "output"; name: string }
  /**
   * Set or clear a step's runtime retry. Only the compiler's `RETRYABLE_KINDS`
   * may carry one; `null` removes it.
   */
  | { op: "set_retry"; stepId: string; retry: StepRetry | null }
  /**
   * Remove a declared input. Refused while any step still reads
   * `inputs.<id>` — rewiring is a separate, visible edit. There is
   * deliberately no `set_defaults` op: confirming a default stays human-only.
   */
  | { op: "remove_input"; inputId: string }
  /**
   * Rename (or retype in place) a declared input, rebinding every reader in
   * one atomic op — expression templates `inputs.<old>` AND structured
   * `inputs[]` bindings (`source.from === "input"`). Refused with no partial
   * write when the old input is undeclared, when the new id collides with a
   * third input, or when any rebind is invalid. There is deliberately no
   * `set_defaults` op: confirming a default stays human-only.
   */
  | { op: "replace_input"; inputId: string; input: ChatFlowInput }
  /**
   * Continue a condition with one more arm — an `elif` (with `conditionExpr`) or
   * an `otherwise` (without). Atomic by construction: the new link AND its first
   * guarded step land together, so chat can never propose the bare branch the
   * compiler refuses as "guards nothing". The first step runs after the new link;
   * anything it declares in `dependsOn` is ignored, because a continuation link
   * may not run after steps (compiler §if/elif/else).
   */
  | {
      op: "add_arm";
      elseOf: string;
      armId: string;
      conditionExpr?: string;
      /** The typed test — what builders now write (phase 3 step 4). Neither = `otherwise`. */
      test?: GuardTest;
      step: AuthoredStep;
    }
  /**
   * Remove one `elif`/`otherwise` link. Refused while its arm still guards steps
   * (remove or rewire those first), and a link the chain continues through is
   * rewired — the next link continues whoever this one continued. The head of a
   * chain is not an arm: remove the whole condition with `remove_step`.
   */
  | { op: "remove_arm"; stepId: string }
  /**
   * START a condition: a branch AND the first step it guards, together.
   *
   * ⚠ **This is `add_arm`'s argument applied to the case it did not cover, and
   * the gap was measured rather than reasoned about.** Asked *"if any of them
   * are on the enterprise plan, post to the #escalations channel"* on a flow
   * that ended at a transform, the builder added the post UNGUARDED — because
   * that is the only thing the vocabulary allowed. `add_step` refuses a branch
   * ("guards nothing"), `insert_step` needs a step to insert BEFORE, and
   * `add_arm` continues a condition that already exists. Starting one at the
   * tail of a flow was expressible in no single op.
   *
   * ⚠ The two-op workaround is not merely clumsy, it is DANGEROUS: it passes
   * through a state where the step the person wanted guarded runs on every
   * execution. A conversation that stops there — or an approval taken there —
   * ships an automation that posts to a channel, or mails a customer, every
   * single run. That intermediate state is indistinguishable from a finished
   * flow, which is exactly why `add_arm` was made atomic for the arm case.
   */
  | {
      op: "add_guarded_step";
      afterStepId: string;
      branchId: string;
      /** Exactly one of `conditionExpr` (hand-written) or `test` (typed) — refused otherwise. */
      conditionExpr?: string;
      test?: GuardTest;
      step: AuthoredStep;
    };

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The desync signal — the shared protocol with the chat loop (`flow-chat.service.ts`).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A call-kind step (`tool`/`datasource`/`query`) carries its inputs TWICE: the
 * structured `inputs` bindings, and the rendered `paramsExpr` display (a `code`
 * step carries `inputExpr` beside its `inputs` the same way). The compiler reads
 * the display **verbatim when present** and only renders the bindings in its
 * absence — so an op that moves the bindings while the display still names the
 * old feed compiles the OLD feed and files success. Measured 2026-09-14: the
 * next turn's validator correctly refused the dangling ref, one turn too late.
 *
 * The rule, enforced by `applyOp` below: **no op reports a bare `ok` while the
 * two representations disagree.** ⚠ Since I-204 the repair is to DROP the
 * display, never to re-render it: a binding op writes bindings only
 * (`uncoveredBlobKeys`), and a display is dropped whenever it carries nothing
 * the bindings do not. The old re-render (`displayKeeping`) kept two
 * representations of one step's inputs — the checker typed one, the compiler
 * ran the other — and wrote `""` for every step read. Where the display cannot
 * be dropped losslessly — a fan-out (`over`) whose program may hold a filter,
 * a `{{ … }}` blob, a key no binding carries — the result carries a
 * `BindingDesync` with no suggestion instead of a bare `ok`. The display is
 * dropped or left, never reinterpreted: this module never parses display text
 * back into bindings.
 *
 * Consuming it (chat loop — mechanical, zero inference, in-turn):
 *
 * ```ts
 * import { applyOp } from "@foundry/flow-edit";
 * import type { BindingDesync } from "@foundry/flow-edit"; // via ApplyResult below
 *
 * const applied = applyOp(current, op);
 * if (!applied.ok) return { ok: false, correctable: false, findings: [applied.error], op };
 * let next = applied.flow;
 * let desync: BindingDesync | null = "desync" in applied ? applied.desync : null;
 * while (desync) {
 *   // Pure repair: the suggestion is computed from the bindings, not the model.
 *   if (desync.suggestedParamsExpr === null)
 *     return { ok: false, correctable: true, findings: [desync.reason], op }; // needs a person/model retry
 *   next = applyDesyncRepair(next, desync)!; // `""` = drop the display field
 *   desync = bindingDesync(next, desync.stepId, op.op); // confirm clean
 * }
 * // File `next` only here — never while `desync` is non-null. The repair touches
 * // the already-touched step, so `assertOnlyTouched` still runs against `permitted`,
 * // and the repair files no `describeOp` line of its own (it is not an op).
 * ```
 *
 * Agreement, exactly: a blank/absent display agrees with anything (the bindings
 * rule); otherwise every binding with a renderable source must read byte-equal
 * to its display pair, and every explicitly-unbound (`null`-source) name must be
 * absent from the display. Display keys with no binding are legacy/blob content
 * and are preserved, not flagged. `bindingDesync` is the pure checker; it
 * returns `null` when the step agrees.
 */
export type BindingDesync = {
  /** Discriminator, so findings renderers and logs can name what this is. */
  kind: "binding-desync";
  /** The step whose two representations disagree. */
  stepId: string;
  /** The op that left the disagreement — never a repair hint, only provenance. */
  op: FlowEditOp["op"];
  /** Which display disagrees: the call display, or a code step's input object. */
  display: "paramsExpr" | "inputExpr";
  /** The stale display text, as left on the step. */
  paramsExpr: string;
  /** The structured truth, as left on the step. */
  bindings: InputBinding[];
  /**
   * The repair: `""` = DROP the `[display]` field (it carries nothing the
   * bindings do not — `applyDesyncRepair` deletes it). `null` when it cannot be
   * dropped losslessly (fan-out, `{{ … }}` blob, a key no binding carries):
   * the loop must NOT guess, it files `reason` as a correctable finding.
   * (A non-empty string is still spread verbatim, for callers building one.)
   */
  suggestedParamsExpr: string | null;
  /** One sentence for findings/transcript, naming the step and the repair. */
  reason: string;
};

export type ApplyResult =
  | EditResult
  | { ok: true; flow: AuthoredFlow; desync: BindingDesync };

/** Every op name, so a refusal and a prompt can be built from one list. */
export const FLOW_EDIT_OPS = [
  "add_step",
  "insert_step",
  "remove_step",
  "replace_step",
  "connect",
  "disconnect",
  "add_gate",
  "declare_input",
  "set_condition",
  "set_property",
  "set_binding",
  "set_output_rows",
  "add_io",
  "remove_io",
  "set_retry",
  "remove_input",
  "replace_input",
  "add_arm",
  "remove_arm",
  // ⚠ `set_schedule` was ABSENT from this list until 2026-09-06, though the op
  // has existed since the schedule work. This list's own docblock says it is
  // what a refusal and a prompt are built from, so an op missing from it is an
  // op those two cannot name — the silent half of adding a capability.
  "set_schedule",
  "add_guarded_step",
  // ⚠ In this list from the day the op existed, unlike `set_schedule` — which
  // was absent for months while the op worked, so a refusal and a prompt could
  // not name it. That is the silent half of adding a capability.
  "set_output",
  ] as const;

/**
 * Apply one op. Pure — the input flow is never mutated, and every refusal is a
 * message rather than a throw.
 *
 * Each branch delegates to the edit function the canvas already uses, so a chat
 * edit and a dragged edit are the **same operation**. That is the whole reason
 * this package exists: a cycle refused, a deleted step taking its inbound edges
 * with it, a gate spliced before its target — those hold once, for both.
 *
 * The desync gate lives HERE, not in each branch: a successful inner result is
 * scanned over the op's own footprint (`touchedBy` on the pre-op flow), and the
 * first step whose display disagrees with its bindings turns the bare `ok` into
 * an `ok` carrying a `BindingDesync` (see its docblock for the repair). Steps
 * outside the footprint are never scanned — flagging a desync this op did not
 * touch would strand unrelated turns behind someone else's stale template.
 *
 * ⚠ **Only NEWLY introduced disagreement fails.** A step whose display
 * disagreed identically BEFORE the op (same signature — the drafter's
 * blob-plus-bindings shape, untouched by this op) is skipped: failing it
 * would hold every later turn hostage to a mess it did not make, which is
 * exactly what the footprint rule above exists to prevent. The staleness
 * persists (status quo ante), it just does not veto progress.
 */
export function applyOp(flow: AuthoredFlow, op: FlowEditOp): ApplyResult {
  const inner = applyOpInner(flow, op);
  if (!inner.ok) return inner;
  // A branch that already knows (only `set_binding` on a code step's
  // catalogue-shape feed, where the staleness is visible only while old and
  // new feeds are both in hand) carries its own signal — the scan below could
  // only presence-check that state, never improve it.
  if ("desync" in inner) return inner;
  const before = new Map<string, string>();
  for (const stepId of touchedBy(flow, op)) {
    const pre = bindingDesync(flow, stepId, op.op);
    if (pre) before.set(stepId, desyncSignature(pre));
  }
  for (const stepId of touchedBy(flow, op)) {
    const desync = bindingDesync(inner.flow, stepId, op.op);
    if (desync && desyncSignature(desync) !== before.get(stepId)) {
      return { ok: true, flow: inner.flow, desync };
    }
  }
  return inner;
}

/**
 * Identity of a disagreement: the step, the stale text, and the structured
 * truth it disagrees with. Compared pre/post so the gate fires whenever the
 * op changed what disagrees — the reason sentence alone is too coarse (a
 * rebind under an identical blob changes the bindings while the sentence
 * stays the same, and that IS a new disagreement).
 */
function desyncSignature(d: BindingDesync): string {
  return JSON.stringify([d.stepId, d.display, d.paramsExpr, d.bindings, d.suggestedParamsExpr ?? null]);
}

/**
 * The op itself, without the desync gate — every branch below. Separated so the
 * gate above reads as what it is: one scan over the footprint, not a rule
 * threaded through forty returns.
 */
function applyOpInner(flow: AuthoredFlow, op: FlowEditOp): ApplyResult {
  switch (op.op) {
    case "add_step":
      /**
       * ⚠ **`approval` is refused here and the message names `add_gate`.**
       * `addStep` appends, and an appended gate compiles, deploys and stops
       * nothing — Kestra runs tasks in emission order, so the email has already
       * gone by the time anyone is asked. `spliceApproval` is the only correct
       * placement and `add_gate` is the only way to reach it.
       */
      if (op.step.kind === "approval") {
        return {
          ok: false,
          error:
            `a gate cannot be added as an ordinary step — use add_gate, which puts it BEFORE the ` +
            `step it guards. A gate added at the end pauses nothing that has not already happened`,
        };
      }
      /**
       * ⚠ **A bare appended branch is refused here, naming `insert_step` and
       * `add_arm`.** One op per turn means no later turn can give it an arm
       * before the save compiles — the compiler's "guards nothing" would be the
       * answer, about a step the person did not ask for. A first condition goes
       * mid-chain with `insert_step` (it guards what runs after it); a further
       * arm goes on an existing condition with `add_arm` (link plus first
       * guarded step, atomically).
       */
      if (op.step.kind === "branch") {
        return {
          ok: false,
          error:
            `a branch appended at the end guards nothing — no step runs after it. ` +
            // ⚠ Names `add_guarded_step` FIRST. It is the answer whenever the
            // guarded step is new, which is the common case and the one that
            // produced an unguarded post to a channel when the only advice
            // here was the two-op `insert_step` route.
            `To start a condition, use add_guarded_step (the branch and the step it guards, together), ` +
            `or insert the branch BETWEEN two linked steps with insert_step; ` +
            `to add an elif/otherwise to a condition that already exists, use add_arm`,
        };
      }
      /**
       * ⚠ **A merge IS allowed to be appended, unlike a branch above, and the
       * asymmetry is not an oversight.** A branch appended at the end guards
       * nothing because it acts on what comes *after* it. A merge acts on what
       * came *before* it, so appending is not merely safe — it is the only
       * placement that can be correct, and `addStep` appends. That makes
       * `add_step` the right op for a merge with no new op needed.
       *
       * Only the *existence* of each source is checked here, deliberately.
       * Whether a source is a kind that produces a JSON result, and whether it
       * appears earlier, are `validateModel`'s — re-implementing those would be
       * a second definition of the rule, free to drift in the direction where
       * the cheap copy says yes. What this catches is the one mistake a turn
       * makes often and a 422 explains badly: a typo'd or invented step id.
       */
      if (op.step.kind === "merge") {
        const missing = op.step.sources.filter((id) => !flow.steps.some((s) => s.id === id));
        if (missing.length) {
          return {
            ok: false,
            error:
              `a merge combines steps that already exist, and ${missing.map((m) => `"${m}"`).join(", ")} ` +
              `${missing.length === 1 ? "is" : "are"} not in this flow. Name the last step of each ` +
              `arm of the condition`,
          };
        }
      }
      {
        // A code step's blob bypasses the structured feed (`buildCodeInput`
        // renders `{...}` by construction; a legacy `inputExpr` wins verbatim),
        // so a malformed one must be refused here — it would otherwise die in
        // the runner's `json.load` with every static check green (run 4171a39b).
        const malformed = refusedCodeInput(op.step);
        if (malformed) return malformed;
        const added = addStep(flow, op.step);
        // ⚠ The step first: an input declared beside a step that was itself
        // refused would leave the flow carrying a parameter nothing reads.
        if (!added.ok || !op.inputs?.length) return added;
        return declareInputs(added.flow, op.inputs);
      }

    case "insert_step": {
      const after = flow.steps.find((s) => s.id === op.afterStepId);
      if (!after) return { ok: false, error: `"${op.afterStepId}" is not in this flow` };
      const before = flow.steps.find((s) => s.id === op.beforeStepId);
      if (!before) return { ok: false, error: `"${op.beforeStepId}" is not in this flow` };
      if (op.afterStepId === op.beforeStepId) {
        return { ok: false, error: "a step cannot be inserted between a step and itself" };
      }
      if (!dependenciesOf(before).includes(op.afterStepId)) {
        return {
          ok: false,
          error:
            `"${op.beforeStepId}" does not run after "${op.afterStepId}" — insert_step places a step ` +
            `BETWEEN two steps that are already linked. Link them first with connect, or append the ` +
            `step with add_step`,
        };
      }
      // ⚠ Same control as `add_step`: gates go through `add_gate`, never as an
      // ordinary step — even mid-chain, where the placement would be right but
      // the id and the transcript would not say gate.
      if (op.step.kind === "approval") {
        return {
          ok: false,
          error:
            `a gate cannot be inserted as an ordinary step — use add_gate, which puts it BEFORE the ` +
            `step it guards`,
        };
      }
      // Extra edges the carried step declares, beyond the inserted one. Each is
      // a new edge off the new step, so each gets `connect`'s checks: it must
      // exist, and it must not close a loop through the rewired `before`.
      const extra = (op.step.dependsOn ?? []).filter((d) => d !== op.afterStepId);
      for (const d of extra) {
        if (!flow.steps.some((s) => s.id === d)) {
          return { ok: false, error: `"${d}" is not in this flow` };
        }
        if (d === op.beforeStepId || reaches(flow, d, op.beforeStepId)) {
          return {
            ok: false,
            error: `that would make a loop — "${op.beforeStepId}" already runs after "${d}"`,
          };
        }
      }
      // ⚠ `addStep` + rewire, literally: the new step runs after `after`, and
      // `before` is moved off `after` onto it via `disconnect` + `connect`, so
      // the edge checks hold once, for both callers. Then the step is moved to
      // `before`'s position — spliced, never appended (Kestra runs tasks in
      // emission order, and an appended step placed mid-chain would run last).
      // Same blob rule as `add_step` — a mid-chain code step wins its
      // `inputExpr` verbatim too.
      const malformedInsert = refusedCodeInput(op.step);
      if (malformedInsert) return malformedInsert;
      const added = addStep(flow, { ...op.step, dependsOn: [op.afterStepId, ...extra] });
      if (!added.ok) return added;
      const off = disconnect(added.flow, op.afterStepId, op.beforeStepId);
      if (!off.ok) return off;
      const on = connect(off.flow, op.step.id, op.beforeStepId);
      if (!on.ok) return on;
      const at = on.flow.steps.findIndex((s) => s.id === op.beforeStepId);
      const steps = on.flow.steps.filter((s) => s.id !== op.step.id);
      const moved = on.flow.steps.find((s) => s.id === op.step.id)!;
      steps.splice(at, 0, moved);
      return { ok: true, flow: { ...on.flow, steps } };
    }

    case "remove_step":
      return removeStep(flow, op.stepId);

    case "replace_step": {
      const current = flow.steps.find((s) => s.id === op.stepId);
      if (!current) return { ok: false, error: `"${op.stepId}" is not in this flow` };
      // ⚠ Neither of these is a validation nicety; each is one of the two
      // deleted capabilities, refused at the only place they could arrive.
      if (op.step.id !== op.stepId) {
        return {
          ok: false,
          error:
            `a step cannot be renamed ("${op.stepId}" → "${op.step.id}"). A rename discards the ` +
            `generated code of every step whose contract mentioned the old name, and nothing on ` +
            `screen would say so`,
        };
      }
      /**
       * ⚠ A condition change is `set_condition`, not a field edit. Without this
       * the op vocabulary would have two ways to change what runs, and only one
       * of them says so — `describeOp` for `replace_step` reads "changed the
       * settings of X".
       */
      if (
        isGuard(current) &&
        isGuard(op.step) &&
        (current.conditionExpr !== op.step.conditionExpr ||
          JSON.stringify(current.test ?? null) !== JSON.stringify(op.step.test ?? null))
      ) {
        return {
          ok: false,
          error:
            `changing "${op.stepId}"'s condition is not a settings change — it changes which steps ` +
            `run. Use set_condition, which says so`,
        };
      }
      if (op.step.kind !== current.kind) {
        return {
          ok: false,
          error:
            `"${op.stepId}" is a ${current.kind} step and cannot become a ${op.step.kind} one in ` +
            `place — remove it and add the new step, so both changes are visible as changes`,
        };
      }
      // Same blob rule — a replaced code step rewrites its whole feed.
      const malformedReplace = refusedCodeInput(op.step);
      if (malformedReplace) return malformedReplace;
      return replaceStep(flow, op.stepId, op.step);
    }

    case "connect":
      return connect(flow, op.from, op.to);

    case "disconnect":
      return disconnect(flow, op.from, op.to);

    case "add_gate":
      // ⚠ The ONLY caller of `spliceApproval` on this path, and a test asserts
      // that `applyOp` is where the name appears.
      return spliceApproval(
        flow,
        op.beforeStepId,
        op.summaryExpr ? { summaryExpr: op.summaryExpr } : {},
      );

    case "set_condition": {
      const step = flow.steps.find((s) => s.id === op.stepId);
      if (!step) return { ok: false, error: `"${op.stepId}" is not in this flow` };
      if (!isGuard(step)) {
        return {
          ok: false,
          error: `"${op.stepId}" is not a condition — only a branch step has one`,
        };
      }
      const g = guardOf(op.conditionExpr, op.test);
      if ("error" in g) return { ok: false, error: g.error };
      if (!g.guard.conditionExpr && !g.guard.test) {
        return { ok: false, error: `set_condition needs a "test" (or a "conditionExpr") — to make "${op.stepId}" an otherwise, remove its condition with replace_step` };
      }
      // ⚠ The replaced forms are DROPPED, not kept beside the new one: typed
      // `conditions` rows render before `test`, and a new `conditionExpr` beside
      // a stale `test` would be discarded by `normaliseModel` — either way the
      // OLD guard would compile.
      const { conditionExpr: _e, test: _t, conditions: _c, ...rest } = step as typeof step & { conditions?: unknown };
      return {
        ok: true,
        flow: {
          ...flow,
          steps: flow.steps.map((s) => (s.id === op.stepId ? ({ ...rest, ...g.guard } as AuthoredStep) : s)),
        },
      };
    }

    case "set_property":
      return applySetProperty(flow, op.stepId, op.property, op.value);

    case "set_binding":
      return applySetBinding(flow, op.stepId, op.name, op.source);

    case "set_output_rows":
      return applySetOutputRows(flow, op.rows);

    case "add_io":
      return applyAddIo(flow, op.stepId, op.which, op.field);

    case "remove_io":
      return applyRemoveIo(flow, op.stepId, op.which, op.name);

    case "set_retry":
      return applySetRetry(flow, op.stepId, op.retry);

    case "remove_input": {
      const inputs = flow.inputs ?? [];
      if (!inputs.some((i) => i.id === op.inputId)) {
        return { ok: false, error: `this flow declares no input called "${op.inputId}"` };
      }
      const readers = inputsReadBy(flow, op.inputId).map((id) => `"${id}"`);
      if (readers.length) {
        return {
          ok: false,
          error:
            `input "${op.inputId}" cannot be removed while ${readers.join(", ")} still ` +
            `read${readers.length === 1 ? "s" : ""} inputs.${op.inputId} — rewire those steps first`,
        };
      }
      return { ok: true, flow: { ...flow, inputs: inputs.filter((i) => i.id !== op.inputId) } };
    }

    case "replace_input": {
      const inputs = flow.inputs ?? [];
      const old = inputs.find((i) => i.id === op.inputId);
      if (!old) {
        return { ok: false, error: `this flow declares no input called "${op.inputId}"` };
      }
      // In-place retype: the id is unchanged, so there is nothing to declare
      // and no reader to rebind — only the declaration itself changes.
      if (op.input.id === op.inputId) {
        return {
          ok: true,
          flow: { ...flow, inputs: inputs.map((i) => (i.id === op.inputId ? { ...i, ...op.input } : i)) },
        };
      }
      // Declare the new id FIRST, through the same function `declare_input`
      // uses — a collision with a third input refuses here, before anything
      // has been rebound or removed.
      const declared = declareInputs(flow, [op.input]);
      if (!declared.ok) return declared;
      // Rebind every reader on copies: expression templates AND structured
      // bindings. Anything invalid refuses here, with the flow untouched.
      const rebound: AuthoredStep[] = [];
      for (const step of declared.flow.steps) {
        const next = rebindStepInput(step, op.inputId, op.input.id);
        if (!next.ok) return next;
        rebound.push(next.step);
      }
      // A rename keeps its default: the parameter is the same, only the name
      // changed, and dropping it would silently change what a scheduled run uses.
      const { defaults } = old;
      const renamed =
        defaults === undefined
          ? { ...op.input }
          : { ...op.input, defaults };
      return {
        ok: true,
        flow: {
          ...declared.flow,
          inputs: declared.flow.inputs!.filter((i) => i.id !== op.inputId).map((i) =>
            i.id === op.input.id ? renamed : i,
          ),
          steps: rebound,
        },
      };
    }

    case "add_arm":
      return applyAddArm(flow, op.elseOf, op.armId, op.conditionExpr, op.step, op.test);

    case "remove_arm":
      return applyRemoveArm(flow, op.stepId);

    case "add_guarded_step":
      return applyAddGuardedStep(flow, op.afterStepId, op.branchId, op.conditionExpr, op.step, op.test);

    case "declare_input":
      return declareInputs(flow, [op.input]);

    case "set_schedule":
      // `undefined` rather than `null` on removal: the field is optional on
      // `AuthoredFlow`, and a literal null would serialise into the model as a
      // schedule that is present and empty.
      return { ok: true, flow: { ...flow, schedule: op.schedule ?? undefined } };

    case "set_output": {
      // ⚠ Refused HERE for a step that is not in the flow, rather than left to
      // `checkFlowOutput` server-side. Both fire, and this one fires with the
      // step list in a message a chat turn can act on — `checkFlowOutput` is
      // the authority that no route can bypass, and this is the one that makes
      // the answer useful. Same division as every other op's local refusal.
      if (op.output && !flow.steps.some((s) => s.id === op.output!.stepId)) {
        return {
          ok: false,
          error:
            `there is no step "${op.output.stepId}" to take the result from. This automation's ` +
            `steps are: ${flow.steps.map((s) => s.id).join(", ") || "none yet"}`,
        };
      }
      // `undefined` on removal, for `set_schedule`'s reason.
      return { ok: true, flow: { ...flow, output: op.output ?? undefined } };
    }
  }
}
/**
 * Add declared inputs to a flow, merging an identical redeclare silently.
 *
 * ⚠ **The ONE implementation**, reached by `declare_input` and by `add_step`'s
 * `inputs`. A turn echoes the boundary it binds against, so redeclaring what
 * is already true (same id, type, required, computed) is a no-op, not an
 * error — refusing it kills turns like "convert period…" where the new step
 * rides alongside the echoed input. A CONFLICT (same id, different shape)
 * still refuses: silently keeping one of two different declarations would
 * rewrite the flow's boundary under the turn.
 */
function sameInput(a: ChatFlowInput, b: ChatFlowInput): boolean {
  return a.type === b.type && (a.required ?? false) === (b.required ?? false) && a.computed === b.computed;
}
function declareInputs(
  flow: AuthoredFlow,
  add: readonly ChatFlowInput[],
): { ok: true; flow: AuthoredFlow } | { ok: false; error: string } {
  let inputs = flow.inputs ?? [];
  for (const input of add) {
    const existing = inputs.find((i) => i.id === input.id);
    if (existing) {
      if (sameInput(existing, input)) continue;
      return { ok: false, error: `this flow already declares an input called "${input.id}" with a different type` };
    }
    inputs = [...inputs, input];
  }
  return { ok: true, flow: { ...flow, inputs } };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The granular editors behind `set_property`, `set_binding`, `set_output_rows`,
 * `add_io`, `remove_io`, `set_retry`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ Every branch below ends in either a refusal or one of the canvas's own
 * edit functions, exactly like the ops above it. A chat edit and a
 * hand except through `replaceStep`, which keeps the step's position.
 */

/** A `branch` — the guard. The `condition` spelling is retired (Stage 2). */
function isGuard(s: AuthoredStep): s is Extract<AuthoredStep, { kind: "branch" }> {
  return s.kind === "branch";
}

/** Which human-owned thing a kind's settings belong to, for refusals. */
function ownerOf(kind: AuthoredStep["kind"]): string {
  switch (kind) {
    case "code":
      return "its code contract";
    case "transform":
      return "its expression";
    case "approval":
      return "the approval gate";
    case "branch":
      return "its guard";
    // ⚠ Its own answer, never the `default:` below. A merge falling through
    // would be described as owned by "the endpoint" — it has none — and the
    // refusal would send someone to a Parameters section that does not exist
    // for this kind. A wrong signpost is worse than a vague one.
    case "merge":
      return "the steps it combines";
    case "datasource":
    case "query":
      return "the query";
    case "llm":
      return "the model";
    case "http":
      return "the request";
    default:
      return "the endpoint";
  }
}

/**
 * The inspector section that owns a kind's own settings, for refusals. One
 * answer since Stage 5: every `set_property` control renders in Behavior
 * (bindings in Inputs, the component pick in Basic) — the per-kind section
 * names died with the per-kind forms, and a refusal naming one would send
 * someone to a head that is not on the screen.
 */
function sectionOf(_kind: AuthoredStep["kind"]): string {
  return "Behavior";
}

/** The expression fields a step may read `inputs.<id>` through. */
const EXPR_FIELDS = [
  "paramsExpr",
  "expr",
  "promptExpr",
  "inputExpr",
  "summaryExpr",
  "contextExpr",
  "conditionExpr",
] as const;

/**
 * A reference to one input inside expression text: `inputs.<id>` followed by
 * an identifier boundary, so `period` never matches `period_format` (or
 * `periods`). The boundary is a negative lookahead rather than `\b` because
 * an id may itself end in a non-word character, where `\b` would misfire;
 * the id is escaped because the pattern must stay exact even for one that
 * is not identifier-shaped.
 */
function inputRefPattern(id: string, global: boolean): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`inputs\\.${escaped}(?![A-Za-z0-9_])`, global ? "g" : "");
}

/**
 * The stored binding lists a step may read an input through — `inputs` and
 * the legacy-carried `inputBindings` (the same two keys `inventory.ts` reads).
 */
const BINDING_FIELDS = ["inputs", "inputBindings"] as const;

/** One stored binding reads this input — `source.from === "input"` by shape,
 * OR any string nested in the binding embeds `inputs.<id>` inside prose.
 * Measured 2026-09-14: a mail step's subject rode as a literal
 * `"Attendance report … for {{ inputs.period }}"`, which is a read of the
 * input exactly as a binding is — and the rename that missed it left a
 * dangling ref the next turn's validator correctly refused. */
function bindingReadsInput(binding: unknown, id: string): boolean {
  if (typeof binding === "object" && binding !== null && "source" in binding) {
    const source = (binding as Record<string, unknown>).source;
    if (typeof source === "object" && source !== null && "from" in source && "inputId" in source) {
      const s = source as Record<string, unknown>;
      if (s.from === "input" && s.inputId === id) return true;
    }
  }
  return embedsInputRef(binding, inputRefPattern(id, false));
}

/**
 * Any string nested in this value names `inputs.<id>` — the prose-embedded
 * half of `bindingReadsInput` above. Plain objects and arrays are walked;
 * everything else reads as absent. The pattern is caller's (non-global for
 * tests — `lastIndex` is reset before each `test` so a shared global never
 * skips a match it already reported).
 */
function embedsInputRef(value: unknown, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  if (typeof value === "string") return pattern.test(value);
  if (Array.isArray(value)) return value.some((v) => embedsInputRef(v, pattern));
  if (typeof value === "object" && value !== null)
    return Object.values(value).some((v) => embedsInputRef(v, pattern));
  return false;
}

/**
 * A copy of this value with every embedded `inputs.<old>` rewritten —
 * references preserved where nothing matched (same reference back, so
 * callers keep their byte-identical guarantees).
 */
function rewriteEmbeddedStrings<T>(value: T, pattern: RegExp, replacement: string): { value: T; changed: boolean } {
  if (typeof value === "string") {
    const next = value.replace(pattern, replacement);
    return { value: (next === value ? value : next) as unknown as T, changed: next !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => {
      const r = rewriteEmbeddedStrings(v, pattern, replacement);
      if (r.changed) changed = true;
      return r.value;
    });
    return { value: (changed ? next : value) as unknown as T, changed };
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = rewriteEmbeddedStrings(v, pattern, replacement);
      if (r.changed) changed = true;
      out[k] = r.value;
    }
    return { value: (changed ? out : value) as unknown as T, changed };
  }
  return { value, changed: false };
}
function stepReadsInput(step: AuthoredStep, id: string): boolean {
  const pattern = inputRefPattern(id, false);
  const record: Record<string, unknown> = { ...step };
  if (
    EXPR_FIELDS.some((f) => {
      const v = record[f];
      return typeof v === "string" && pattern.test(v);
    })
  ) {
    return true;
  }
  return BINDING_FIELDS.some((f) => {
    const list = record[f];
    return Array.isArray(list) && list.some((b) => bindingReadsInput(b, id));
  });
}

/**
 * Every step id that reads an input — through an expression template
 * (`inputs.<id>`), a structured binding (`source.from === "input"`), or a
 * literal value embedding the ref inside prose. The reader set behind
 * `remove_input`'s refusal and `replace_input`'s rebind.
 */
export function inputsReadBy(flow: AuthoredFlow, id: string): string[] {
  return flow.steps.filter((s) => stepReadsInput(s, id)).map((s) => s.id);
}
/**
 * A copy of this step with every read of `oldId` rebound to `newId` —
 * expression templates rewritten, structured bindings repointed, literal
 * prose carrying an embedded ref rewritten in place. Pure and total: the
 * step is never mutated, and every read of a well-formed stored step can
 * move, so callers validate first and build the rebound steps on copies —
 * a refusal leaves the flow byte-identical by construction.
 */
function rebindStepInput(
  step: AuthoredStep,
  oldId: string,
  newId: string,
): { ok: true; step: AuthoredStep } | { ok: false; error: string } {
  const record: Record<string, unknown> = { ...step };
  let changed = false;
  const pattern = inputRefPattern(oldId, true);
  for (const f of EXPR_FIELDS) {
    const v = record[f];
    if (typeof v === "string") {
      const rebound = v.replace(pattern, `inputs.${newId}`);
      if (rebound !== v) {
        record[f] = rebound;
        changed = true;
      }
    }
  }
  for (const f of BINDING_FIELDS) {
    const list = record[f];
    if (!Array.isArray(list)) continue;
    const rebound = (list as InputBinding[]).map((b) => {
      let next: unknown = b;
      if (bindingReadsInput(b, oldId) && typeof b === "object" && b !== null && "source" in b) {
        const { source } = b as { source: unknown };
        if (typeof source === "object" && source !== null) {
          const s = source as Record<string, unknown>;
          if (s.from === "input" && s.inputId === oldId)
            next = { ...(b as object), source: { ...s, inputId: newId } };
        }
      }
      // A literal value can carry the ref inside prose — the subject line
      // above — which the repoint above never touches.
      const r = rewriteEmbeddedStrings(next, pattern, `inputs.${newId}`);
      return r.value as InputBinding;
    });
    if (rebound.some((b, i) => b !== list[i])) {
      record[f] = rebound;
      changed = true;
    }
  }
  return { ok: true, step: changed ? (record as AuthoredStep) : step };
}
/**
 * I-204 — can this step's hand-written blob go, now that bindings are set?
 *
 * The compiler emits a non-blank `paramsExpr` / `inputExpr` VERBATIM over the
 * bindings, so a binding op that re-rendered the blob (the old
 * `displayKeeping` merge) kept TWO representations of one step's inputs — and
 * the merge wrote `""` for every step read, so a rebind to a step field
 * compiled an empty value. The rule now: a binding op writes bindings ONLY,
 * and the blob is dropped whenever doing so loses nothing.
 *
 * Returns the blob's top-level keys no non-null binding carries — `[]` means
 * the blob can go — or `null` when its contents cannot be read off it:
 *  - a `{{ … }}` program, or any blob on a fan-out (`over`): a `select(…)`
 *    filter may live there that no binding represents, and dropping it would
 *    send to every row;
 *  - a blob with no readable key (`[]` is "no calls", not blank).
 * Keys are over-detected (a nested `"k":` inside a value counts), which only
 * ever makes this answer "cannot drop" — the safe direction.
 */
function uncoveredBlobKeys(
  display: string,
  isCode: boolean,
  over: unknown,
  bindings: readonly InputBinding[],
): string[] | null {
  const t = display.trim();
  if (over != null || t.startsWith("{{")) return null;
  if (isCode ? !t.startsWith("{") : !t.startsWith("[")) return null;
  const keys = new Set([...t.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g)].map((m) => m[1]!));
  if (keys.size === 0) return null;
  // A `null`-source binding means two different things by blob shape. Beside a
  // PLAIN blob (string values only) it is "explicitly unbound" and its pair
  // goes with the blob — what the old merge did. Beside a template blob it is
  // the partial shape FT0602 names: the value lives in the blob in a form no
  // Source expresses, so dropping the blob would drop the value.
  const plain = (isCode ? parseCodeDisplay(t) : parseSingleRowDisplay(t)) !== null;
  const bound = new Set(bindings.filter((b) => plain || b.source !== null).map((b) => b.name));
  return [...keys].filter((k) => !bound.has(k));
}

/**
 * The pairs of a PLAIN blob — one JSON row of string values, the shape
 * `buildSingleParams` writes (or a code step's `{…}` object of strings) — that
 * no binding names, as LITERAL bindings. Exact, not a reinterpretation: a
 * literal binding renders `JSON.stringify(value)`, which is the pair's own
 * value text, so the step compiles the same inputs from bindings alone and
 * the blob can go. Anything else (a `{{ … }}` program, a non-string value, a
 * fan-out, a code key outside the contract) lifts nothing — the blob then
 * stays and the gate signals. A `null`-source binding keeps its pair out: it
 * says "unbound", and the pair is dropped with the blob, as it was before.
 */
function liftedLiterals(
  display: string,
  contract: readonly string[] | null,
  over: unknown,
  next: readonly InputBinding[],
): InputBinding[] {
  if (over != null) return [];
  const pairs = contract ? parseCodeDisplay(display) : parseSingleRowDisplay(display);
  if (!pairs) return [];
  const named = new Set(next.map((b) => b.name));
  const out: InputBinding[] = [];
  for (const [key, raw] of pairs) {
    if (named.has(key) || typeof raw !== "string") continue;
    if (contract && !contract.includes(key)) continue;
    out.push({ name: key, source: { from: "literal", value: raw } });
  }
  return out;
}

/** The step without its blob field — absent, never `""`, so nothing reads it as a display. */
function withoutBlob(step: AuthoredStep, field: "paramsExpr" | "inputExpr"): AuthoredStep {
  const { [field]: _dropped, ...rest } = step as unknown as Record<string, unknown>;
  return rest as unknown as AuthoredStep;
}

/** Marker for "this binding holds no feed, so its display pair is dropped". */
const DROP_PAIR = Symbol("drop-pair");

/**
 * One binding as its display pair's value text — the same render
 * `buildSingleParams` performs, pair by pair: an input reads
 * `{{ inputs.<id> }}`, a literal is its raw value (quoted once, at pair
 * serialization), and anything else (a step field, whole rows, the bare
 * element) is the empty string.
 * `null` (explicitly unbound) drops the pair: an unbound input passes no feed,
 * and compiling a stale value for it is the false success this module exists
 * to prevent. `DROP_PAIR`, not `""`: dropping lets the blank-display path
 * throw the honest "unbound input" refusal instead of compiling silence.
 */
function callValueText(source: Source | null): string | typeof DROP_PAIR {
  if (source === null) return DROP_PAIR;
  if (source.from === "input") return `{{ inputs.${source.inputId} }}`;
  if (source.from === "literal") return source.value;
  return "";
}

/**
 * One code-step binding as its `inputExpr` pair's value text. Inputs and
 * literals render without catalogue shapes, exactly as above; a step feed
 * needs `rowsExpr` shapes this module does not have, so it is `null` — no safe
 * render — and callers keep the pair's raw text (or signal when there is none).
 */
function codeValueText(source: Source | null): string | typeof DROP_PAIR | null {
  if (source === null) return DROP_PAIR;
  if (source.from === "input") return `{{ inputs.${source.inputId} }}`;
  if (source.from === "literal") return source.value;
  return null;
}

/** One display row as ordered pairs, or null when it is not a mergeable row. */
function parseSingleRowDisplay(display: string): Array<[string, string]> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(display);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) return null;
  const row = parsed[0];
  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
  const entries = Object.entries(row);
  if (!entries.every(([, v]) => typeof v === "string")) return null;
  return entries as Array<[string, string]>;
}

/**
 * A code step's `inputExpr` as the runner sees it — the shape `buildCodeInput`
 * (`render.ts`) guarantees BY CONSTRUCTION (`{...}`, one key per contract
 * input), checked on a legacy blob that bypasses it.
 *
 * Measured 2026-09-15 (run 4171a39b): `inputExpr: "{{ inputs.period }}"`
 * rendered to `2026-08-31`, the runner's `json.load` died on the bare value,
 * and the whole run failed — while op validation, model findings and the
 * compiler were all green. The feed is an OBJECT by construction; a blob that
 * is not one must be refused where it is written, not where it runs.
 *
 * Pure and template-aware: each `{{ ... }}` span is blanked before parsing, so
 * a template is never asked to be JSON — only the SHAPE around it is. Returns
 * the refusal sentence, or null when the blob is well-shaped. A blank blob
 * agrees with anything (clear-then-fill): PRESENCE is the compiler's refusal,
 * not this one's. Zero scenario words by construction — step id, contract
 * input names and the object shape are the whole vocabulary.
 */
function blankTemplateSpans(text: string): string {
  // Quote-aware, mirroring the server's `scanTemplates`: the close is the
  // first `}}` outside a quoted string, so a jq program carrying `}}` inside
  // quotes does not cut the span early (I-57). An unterminated `{{` is left in
  // place — the parse then fails closed below.
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{{", i);
    if (open < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open);
    let j = open + 2;
    let closed = -1;
    while (j < text.length) {
      const ch = text[j]!;
      if (ch === "'" || ch === '"') {
        const quote = ch;
        j++;
        while (j < text.length) {
          if (text[j] === "\\") {
            j += 2;
            continue;
          }
          if (text[j] === quote) {
            j++;
            break;
          }
          j++;
        }
        continue;
      }
      if (ch === "}" && text[j + 1] === "}") {
        closed = j;
        break;
      }
      j++;
    }
    if (closed < 0) {
      out += text.slice(open);
      break;
    }
    out += "null";
    i = closed + 2;
  }
  return out;
}

/**
 * The refusal behind every code-step `inputExpr` write: the blob must
 * skeleton-parse as a JSON object (spans blanked, top-level braces required)
 * AND its top-level keys must cover `inputNames` (the contract's input names
 * at the op layer, the bound names at the compiler). Shared — the compiler
 * imports this rather than re-deriving it, so the two cannot disagree about
 * what an object is.
 */
export function checkCodeInputExpr(
  stepId: string,
  inputExpr: string,
  inputNames: readonly string[],
): string | null {
  if (inputExpr.trim() === "") return null;
  const skeleton = blankTemplateSpans(inputExpr).trim();
  let keys: string[] | null = null;
  if (skeleton.startsWith("{") && skeleton.endsWith("}")) {
    try {
      const parsed: unknown = JSON.parse(skeleton);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        keys = Object.keys(parsed);
      }
    } catch {
      keys = null;
    }
  }
  const want = inputNames.length ? inputNames.map((n) => `"${n}"`).join(", ") : "no contract inputs";
  if (keys === null) {
    const got = inputExpr.length > 160 ? `${inputExpr.slice(0, 160)}…` : inputExpr;
    return (
      `code step "${stepId}" inputExpr must be a JSON object with one key per contract input ` +
      `(${want}) — blank the {{ ... }} spans and the rest must parse, e.g. {"name": {{ ... }}}. ` +
      `Got: ${got}`
    );
  }
  const missing = inputNames.filter((n) => !keys!.includes(n));
  if (missing.length > 0) {
    return (
      `code step "${stepId}" inputExpr is missing contract input ` +
      `${missing.map((n) => `"${n}"`).join(", ")} — the feed must be a JSON object carrying every ` +
      `contract input (${want}). Add ${missing.map((n) => `"${n}": {{ ... }}`).join(", ")} to the object`
    );
  }
  return null;
}

/** A whole code step's blob, refused before it is written — see `checkCodeInputExpr`. */
function refusedCodeInput(step: AuthoredStep): { ok: false; error: string } | null {
  if (step.kind !== "code") return null;
  const bad = checkCodeInputExpr(
    step.id,
    step.inputExpr,
    step.contract.input.map((f) => f.name),
  );
  return bad ? { ok: false, error: bad } : null;
}
/** A code `inputExpr` object as ordered pairs, or null when not mergeable. */
function parseCodeDisplay(display: string): Array<[string, string | null]> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(display);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed);
  if (!entries.every(([, v]) => typeof v === "string" || v === null)) return null;
  return entries as Array<[string, string | null]>;
}

/**
 * Does this step's display disagree with its bindings — the check behind the
 * `applyOp` gate and the repair loop it documents. `null` is agreement.
 *
 * Pure and op-agnostic except for provenance: it reads the AFTER state only.
 * A blank/absent display agrees with anything (the bindings rule at compile);
 * the canonical blanks (`"[{}]"`, `"{}"`) count as blank. Otherwise every
 * renderable binding must read byte-equal to its display pair, every
 * explicitly-unbound name must be absent, and every unrenderable
 * (catalogue-shape) code bind must at least be present. Display keys no
 * binding names are legacy/blob content — preserved, never flagged.
 */
export function bindingDesync(
  flow: AuthoredFlow,
  stepId: string,
  op: FlowEditOp["op"],
): BindingDesync | null {
  const step = flow.steps.find((s) => s.id === stepId);
  if (!step) return null;
  const record = step as unknown as Record<string, unknown>;
  const isCode = step.kind === "code";
  if (step.kind !== "tool" && step.kind !== "datasource" && step.kind !== "query" && !isCode) {
    return null;
  }
  const field = isCode ? "inputExpr" : "paramsExpr";
  const display = record[field];
  if (typeof display !== "string" || display.trim() === "") return null;
  const bindings = step.inputs ?? [];
  if (bindings.length === 0) return null;
  const valueText = isCode ? codeValueText : callValueText;
  const displayName = isCode ? "inputExpr" : "paramsExpr";
  // I-204: the only repair is DROPPING the blob, and only when it carries
  // nothing the bindings do not (`""` = drop). Re-rendering it from the
  // bindings kept two representations and wrote `""` for every step read.
  const uncovered = uncoveredBlobKeys(display, isCode, record["over"], bindings);
  const drop = uncovered !== null && uncovered.length === 0 ? "" : null;
  const stale = (why: string): BindingDesync => ({
    kind: "binding-desync",
    stepId,
    op,
    display: field,
    paramsExpr: display,
    bindings,
    suggestedParamsExpr: drop,
    reason:
      `"${stepId}" binds ${bindings.length === 1 ? "an input" : "inputs"} the hand-written ${displayName} ` +
      `does not carry (${why}). ` +
      (drop === null
        ? uncovered?.length
          ? `It also passes ${uncovered.map((k) => `"${k}"`).join(", ")}, which no binding does — bind ` +
            `${uncovered.length === 1 ? "it" : "them"} so ${displayName} can be dropped`
          : `It is not a shape this turn can read — resend the step with its inputs as bindings only`
        : `Drop ${displayName} so the bindings compile — they carry everything it passes`) +
      `, in the inspector's Behavior section`,
  });
  // A fan-out renders through catalogue shapes this module does not have.
  if (!isCode && record["over"] != null) {
    return stale("a fan-out display this module cannot rebuild");
  }
  const base = isCode ? parseCodeDisplay(display) : parseSingleRowDisplay(display);
  if (base === null || base.length === 0) {
    // The canonical blanks agree (the bindings rule); anything else beside
    // bindings is a blob the bindings cannot be read through.
    if (base !== null) return null;
    return stale("an expression blob beside structured bindings");
  }
  const rawByKey = new Map(base.map(([key, raw]) => [key, raw] as const));
  for (const binding of bindings) {
    const text = valueText(binding.source);
    if (text === DROP_PAIR) {
      if (rawByKey.has(binding.name)) return stale(`"${binding.name}" is unbound but the display still passes a value for it`);
      continue;
    }
    if (text === null) {
      if (!rawByKey.has(binding.name)) return stale(`"${binding.name}" reads a catalogue-shape feed no display pair carries`);
      continue;
    }
    if (rawByKey.get(binding.name) !== text) return stale(`"${binding.name}" reads differently than the display passes it`);
  }
  return null;
}

/**
 * Apply a `BindingDesync` mechanically — the repair half of the protocol in
 * `BindingDesync`'s docblock. The only repair (I-204) is DROPPING the named
 * step's blob field (`suggestedParamsExpr: ""`), and nothing else is touched.
 * Returns the repaired flow, or `null` when there is no safe suggestion (the
 * loop files `reason` instead of guessing). Pure, like everything else here.
 */
export function applyDesyncRepair(flow: AuthoredFlow, desync: BindingDesync): AuthoredFlow | null {
  if (desync.suggestedParamsExpr === null) return null;
  const step = flow.steps.find((s) => s.id === desync.stepId);
  if (!step) return null;
  const repaired = (s: AuthoredStep): AuthoredStep =>
    desync.suggestedParamsExpr === ""
      ? withoutBlob(s, desync.display)
      : ({ ...s, [desync.display]: desync.suggestedParamsExpr } as AuthoredStep);
  return { ...flow, steps: flow.steps.map((s) => (s.id === desync.stepId ? repaired(s) : s)) };
}

/**
 * The retired display strings — expression text the panel used to store and
 * parse back. Each is refused with the op that owns its successor, because a
 * parse failure would name nothing to act on.
 */
const RETIRED_EXPR_FIELDS: Record<string, string> = {
  conditionExpr:
    `changing "{id}"'s condition is not a settings change — it changes which steps ` +
    `run. Use set_condition, which says so`,
  paramsExpr:
    `"paramsExpr" is how this step's inputs used to be stored — as one text blob. ` +
    `Bind one input at a time with set_binding, naming the input and where it is read from`,
  inputExpr:
    `"inputExpr" is how a code step's inputs used to be stored — as one text blob. ` +
    `Bind one input at a time with set_binding, naming the contract field and where it is read from`,
  summaryExpr:
    `"summaryExpr" is retired — an approval's question is the "summary" property. ` +
    `Set it with set_property and property "summary"`,
  contextExpr:
    `"contextExpr" is retired — an approval's evidence is the "context" property. ` +
    `Set it with set_property and property "context"`,
};

/**
 * The value vocabulary for output rows. `VariableType` in `node-types.ts` is
 * the authority — this list only mirrors it so a chat turn hears about a bad
 * type before a save.
 */
const VARIABLE_TYPES: readonly string[] = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "file",
  "array[string]",
  "array[number]",
  "array[object]",
  "array[boolean]",
  "array[file]",
  "any",
];

/**
 * A `Source` by shape — shared by `step-field` values, `set_binding` and
 * output rows. Shape only: whether the named step exists is each caller's
 * own check. A property value may name a step added on a later turn, while
 * an output row must read a step that is already there.
 */
function checkSource(v: unknown): { ok: true; value: Source } | { ok: false; error: string } {
  const shape =
    `must be a Source — {"from":"step","stepId":"...","field":"..."}, ` +
    `{"from":"whole","stepId":"..."}, {"from":"input","inputId":"..."}, ` +
    `{"from":"literal","value":"..."} or {"from":"self"}`;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return { ok: false, error: shape };
  }
  const r = v as Record<string, unknown>;
  const slug = (key: string): boolean =>
    typeof r[key] === "string" && (r[key] as string).length > 0 && (r[key] as string).length <= 63;
  switch (r["from"]) {
    case "step":
      if (!slug("stepId") || typeof r["field"] !== "string" || (r["field"] as string).length === 0) {
        return { ok: false, error: shape };
      }
      if (
        r["transform"] !== undefined &&
        r["transform"] !== "date" &&
        r["transform"] !== "text" &&
        r["transform"] !== "number"
      ) {
        return { ok: false, error: `"transform" must be one of "date", "text" or "number"` };
      }
      return { ok: true, value: v as Source };
    case "whole":
      if (!slug("stepId")) return { ok: false, error: shape };
      return { ok: true, value: v as Source };
    case "input":
      if (!slug("inputId")) return { ok: false, error: shape };
      return { ok: true, value: v as Source };
    case "literal":
      if (typeof r["value"] !== "string") return { ok: false, error: shape };
      return { ok: true, value: v as Source };
    case "self":
      return { ok: true, value: v as Source };
    default:
      return { ok: false, error: `"from" must be one of "step", "whole", "input", "literal" or "self"` };
  }
}
/**
 * Every step id a value reads through a step-sourced `Source` (`from` "step"
 * or "whole") — walking nested objects and arrays, so a `test` group, a
 * `body` group and a bare `context` all report. Anything else (literals, run
 * inputs, `self`, bare strings) reports nothing: only a step read needs the
 * named step to exist and the edge to exist.
 */
function stepRefsIn(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const e of v) walk(e);
      return;
    }
    if (typeof v !== "object" || v === null) return;
    const r = v as Record<string, unknown>;
    if ((r["from"] === "step" || r["from"] === "whole") && typeof r["stepId"] === "string") {
      out.push(r["stepId"]);
      return;
    }
    for (const key of Object.keys(r)) walk(r[key]);
  };
  walk(value);
  return out;
}

/**
 * Every step id this step reads — every nested step-sourced `Source`, plus
 * the two bare-id spellings (`llm` `contextStepId`, the fan-out `over`). The
 * refcount behind an unbind: dropping an edge while any of these still names
 * its step would file a binding whose feed no longer runs first.
 */
function stepRefsOn(step: AuthoredStep): string[] {
  const refs = stepRefsIn(step);
  const record = step as unknown as Record<string, unknown>;
  if (typeof record["contextStepId"] === "string" && (record["contextStepId"] as string).length > 0) {
    refs.push(record["contextStepId"] as string);
  }
  const over = record["over"] as { stepId?: unknown } | null | undefined;
  if (over && typeof over.stepId === "string" && over.stepId.length > 0) refs.push(over.stepId);
  return refs;
}

/**
 * The phantom-binding refusal, shared by every op that files a step-sourced
 * binding. Three ways a step read fails before it is filed: the step reads
 * itself, the step is not in the flow (naming the step and the ids that are,
 * mirroring `applySetOutputRows`), or the read closes a dependency cycle —
 * the check `dependsOn` ownership exists to enforce, in `connect`'s words.
 */
function refuseBadStepRef(
  flow: AuthoredFlow,
  stepId: string,
  label: string,
  ref: string,
): string | null {
  if (ref === stepId) {
    return `"${label}" cannot read from "${ref}" — a step cannot depend on itself`;
  }
  if (!flow.steps.some((s) => s.id === ref)) {
    return (
      `"${label}" reads from "${ref}", which is not in this flow. ` +
      `Its steps are: ${flow.steps.map((s) => s.id).join(", ") || "none yet"}`
    );
  }
  if (reaches(flow, stepId, ref)) {
    return `that would make a loop — "${ref}" already runs after "${stepId}"`;
  }
  return null;
}

/**
 * The edge half of filing a step-sourced binding. Added refs join `dependsOn`
 * through `connect` — the same existence, self and cycle checks, so a binding
 * and a dragged edge are one operation rather than two that agree. Removed
 * refs leave `dependsOn` only when no remaining binding on the step still
 * names them (refcount across inputs, context, test and every other nested
 * feed) — an edge a second binding still needs is not this unbind's to drop.
 * Never at save-time, never compiler rewiring: the edge is filed by the op
 * that filed the read.
 */
function withBindingEdges(
  flow: AuthoredFlow,
  stepId: string,
  oldRefs: readonly string[],
  newRefs: readonly string[],
): ApplyResult {
  let next = flow;
  for (const ref of new Set(newRefs)) {
    const target = next.steps.find((s) => s.id === stepId);
    if (!target || dependenciesOf(target).includes(ref)) continue;
    const linked = connect(next, ref, stepId);
    if (!linked.ok) return linked;
    next = linked.flow;
  }
  const step = next.steps.find((s) => s.id === stepId);
  if (step) {
    const live = new Set(stepRefsOn(step));
    const drop = new Set([...new Set(oldRefs)].filter((r) => !live.has(r)));
    if (drop.size > 0) {
      next = {
        ...next,
        steps: next.steps.map((s) =>
          s.id === stepId ? { ...s, dependsOn: dependenciesOf(s).filter((d) => !drop.has(d)) } : s,
        ),
      };
    }
  }
  return { ok: true, flow: next };
}

/**
 * The value vocabulary for a contract field's date shape. Mirrored in
 * `applyAddIo` and the `field-list` case below — one definition of the shape,
 * like the name and type rules beside them.
 */
const CONTRACT_FIELD_FORMATS = ["date", "month", "datetime", "text"] as const;

function applySetProperty(
  flow: AuthoredFlow,
  stepId: string,
  property: string,
  value: unknown,
): ApplyResult {
  const step = flow.steps.find((s) => s.id === stepId);
  if (!step) return { ok: false, error: `"${stepId}" is not in this flow` };
  // The retired blob fields first — but ONLY on steps that speak bindings with
  // none yet. Chat-built steps are born as blobs (the create path still takes
  // them, and they run): refusing a blob edit on a blob step while accepting
  // the same blob on replace_step made "send it to X" fail for shape alone.
  // A blob write over granular bindings would silently clobber them, so that
  // combination keeps the refusal and its guidance.
  if (
    (property === "paramsExpr" || property === "inputExpr") &&
    typeof value === "string" &&
    (step.kind === "tool" || step.kind === "datasource" || step.kind === "query" || step.kind === "code") &&
    (step.inputs ?? []).length === 0
  ) {
    // A code blob must still feed an object (run 4171a39b) — refused before it
    // is written, so a refusal leaves the flow byte-identical. Blank stays
    // writable: clearing a field the person then fills is the pattern, and
    // PRESENCE is the compiler's refusal, not this one's.
    if (property === "inputExpr" && step.kind === "code") {
      const malformedBlob = checkCodeInputExpr(
        stepId,
        value,
        step.contract.input.map((f) => f.name),
      );
      if (malformedBlob) return { ok: false, error: malformedBlob };
    }
    return replaceStep(flow, stepId, { ...step, [property]: value } as AuthoredStep);
  }
  const retired = RETIRED_EXPR_FIELDS[property];
  if (retired) return { ok: false, error: retired.replaceAll("{id}", stepId) };
  // Structural keys are owned elsewhere: edges by `connect`/`disconnect`, the
  // kind by remove-plus-add (`replace_step` refuses a kind change for the
  // same reason), the id by nothing — a rename is not an op.
  if (property === "id") {
    const arrow = typeof value === "string" && value.length > 0 ? ` ("${stepId}" → "${value}")` : "";
    return {
      ok: false,
      error:
        `a step cannot be renamed${arrow}. A rename discards the ` +
        `generated code of every step whose contract mentioned the old name, and nothing on ` +
        `screen would say so`,
    };
  }
  if (property === "kind") {
    const want =
      typeof value === "string" && value.length > 0 ? `a ${value} step` : "another kind";
    return {
      ok: false,
      error:
        `"${stepId}" is a ${step.kind} step and cannot become ${want} in ` +
        `place — remove it and add the new step, so both changes are visible as changes`,
    };
  }
  if (property === "dependsOn") {
    return {
      ok: false,
      error:
        `"dependsOn" on "${stepId}" is owned by connect and disconnect — an edge written as a ` +
        `property would skip the cycle check that refuses a loop at the link that closes it`,
    };
  }
  // The free labels ride every kind (StepLabel, not registry properties —
  // `replace_step` is the heavy path for a whole step, this is the light one
  // for its nameplate). Neither is in the server's `structureHash`, so neither
  // unarms a flow.
  if (property === "name" || property === "description") {
    if (typeof value !== "string") {
      return { ok: false, error: `"${property}" on "${stepId}" must be a string` };
    }
    return replaceStep(flow, stepId, { ...step, [property]: value } as AuthoredStep);
  }
  if (value === undefined) {
    return {
      ok: false,
      error: `"${property}" on "${stepId}" needs a value — omitting it carries no change`,
    };
  }
  const spec = propertySpec(step.kind, property);
  if (!spec) {
    return {
      ok: false,
      error:
        `a ${step.kind} step has no "${property}" property. Its settable properties are: ` +
        `${NODE_TYPES[step.kind].properties.map((p) => `"${p.name}"`).join(", ") || "none"} ` +
        `— plus "name" and "description" on every kind`,
    };
  }
  const bad = (want: string): ApplyResult => ({
    ok: false,
    error:
      `"${property}" on "${stepId}" must be ${want} — ` +
      `change it in the inspector's ${sectionOf(step.kind)} section`,
  });
  switch (spec.kind) {
    case "text":
    case "paragraph":
    case "template":
    case "expression":
      // The server refuses empties at save (`min(1)` on required text); apply
      // accepts the string so a turn can clear a field the person then fills.
      if (typeof value !== "string") return bad("a string");
      break;
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return bad("a number");
      if (spec.kind === "integer" && !Number.isInteger(value)) return bad("a whole number");
      if (spec.min !== undefined && spec.max !== undefined && (value < spec.min || value > spec.max)) {
        return bad(`a number ${spec.min}..${spec.max}`);
      }
      if (spec.min !== undefined && value < spec.min) return bad(`a number of at least ${spec.min}`);
      if (spec.max !== undefined && value > spec.max) return bad(`a number of at most ${spec.max}`);
      break;
    }
    case "toggle":
      if (typeof value !== "boolean") return bad("true or false");
      break;
    case "select": {
      const options = (spec.options ?? []).map((o) => o.value);
      if (options.length > 0) {
        if (typeof value !== "string" || !options.includes(value)) {
          return bad(`one of ${options.map((o) => `"${o}"`).join(", ")}`);
        }
      } else if (typeof value !== "string" || !BRANCH_TESTS.some((t) => t.test === value)) {
        // An option-less select speaks `BranchTest` (branch `test.operator`);
        // the stored schema falls back to the same union.
        return bad(`one of ${BRANCH_TESTS.map((t) => `"${t.test}"`).join(", ")}`);
      }
      break;
    }
    case "model-picker":
      if (typeof value !== "string" || value.length === 0) {
        return bad("a model id this deployment configures");
      }
      break;
    case "step-list": {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        return bad("an array of step ids");
      }
      const missing = (value as string[]).filter((id) => !flow.steps.some((s) => s.id === id));
      if (missing.length > 0) {
        return {
          ok: false,
          error:
            `${missing.map((m) => `"${m}"`).join(", ")} ${missing.length === 1 ? "is" : "are"} not in this flow. ` +
            `Its steps are: ${flow.steps.map((s) => s.id).join(", ") || "none yet"}`,
        };
      }
      break;
    }
    case "key-value-list": {
      if (!Array.isArray(value)) return bad("an array of {name, value} rows");
      for (const row of value) {
        if (typeof row !== "object" || row === null || Array.isArray(row)) {
          return bad("an array of {name, value} rows");
        }
        const r = row as Record<string, unknown>;
        if (typeof r["name"] !== "string" || r["name"].length === 0 || r["name"].length > 128) {
          return bad("rows with a name of 1..128 characters and a string value");
        }
        if (typeof r["value"] !== "string" || r["value"].length > 8000) {
          return bad("rows with a name of 1..128 characters and a string value");
        }
        if (r["description"] !== undefined && typeof r["description"] !== "string") {
          return bad("rows with a name, a value, and an optional string description");
        }
      }
      break;
    }
    case "field-list": {
      if (!Array.isArray(value)) return bad("an array of contract fields");
      if (value.length > 32) {
        return {
          ok: false,
          error:
            `"${property}" on "${stepId}" holds at most 32 fields — ` +
            `change it in the inspector's ${sectionOf(step.kind)} section`,
        };
      }
      for (const f of value) {
        if (typeof f !== "object" || f === null || Array.isArray(f)) {
          return bad("an array of contract fields");
        }
        const r = f as Record<string, unknown>;
        // The contract's own name and type rules (`applyAddIo` refuses the
        // same values one field at a time) — one definition of the shape.
        if (
          typeof r["name"] !== "string" ||
          !CONTRACT_FIELD_NAME_RE.test(r["name"]) ||
          r["name"].length > 63
        ) {
          return {
            ok: false,
            error:
              `"${String(r["name"])}" is not a valid field name (lower-case letters, digits and underscores, ` +
              `starting with a letter) — change it in the inspector's ${sectionOf(step.kind)} section`,
          };
        }
        if (
          typeof r["type"] !== "string" ||
          !(CONTRACT_FIELD_TYPES as readonly string[]).includes(r["type"])
        ) {
          return {
            ok: false,
            error:
              `"${String(r["type"])}" is not a contract type — one of string, number, boolean, object, array, any. ` +
              `Change it in the inspector's ${sectionOf(step.kind)} section`,
          };
        }
        if (r["description"] !== undefined && typeof r["description"] !== "string") {
          return bad("fields with a name, a contract type, and an optional string description");
        }
        // The date-shape hint rides the field untouched: validated here, never
        // stripped — `applyAddIo` refuses the same value one field at a time.
        if (
          r["format"] !== undefined &&
          (typeof r["format"] !== "string" ||
            !(CONTRACT_FIELD_FORMATS as readonly string[]).includes(r["format"]))
        ) {
          return {
            ok: false,
            error:
              `"${String(r["format"])}" is not a contract format — one of date, month, datetime, text. ` +
              `Change it in the inspector's ${sectionOf(step.kind)} section`,
          };
        }
        if (
          r["items"] !== undefined &&
          (typeof r["items"] !== "string" ||
            !(CONTRACT_FIELD_TYPES as readonly string[]).includes(r["items"]))
        ) {
          return {
            ok: false,
            error:
              `"${String(r["items"])}" is not a contract type — one of string, number, boolean, object, array, any. ` +
              `Change it in the inspector's ${sectionOf(step.kind)} section`,
          };
        }
      }
      break;
    }
    case "prompt-blocks": {
      if (!Array.isArray(value) || value.length === 0) return bad("at least one prompt block");
      if (value.length > 32) {
        return {
          ok: false,
          error:
            `"${property}" on "${stepId}" holds at most 32 blocks — ` +
            `change it in the inspector's ${sectionOf(step.kind)} section`,
        };
      }
      let anyText = false;
      for (const b of value) {
        if (typeof b !== "object" || b === null || Array.isArray(b)) {
          return bad("blocks with a role and text");
        }
        const r = b as Record<string, unknown>;
        if (r["role"] !== "system" && r["role"] !== "user" && r["role"] !== "assistant") {
          return bad(`blocks whose role is one of "system", "user" or "assistant"`);
        }
        if (typeof r["text"] !== "string" || r["text"].length > 8000) {
          return bad("blocks with a role and text of at most 8000 characters");
        }
        if (r["text"].length > 0) anyText = true;
      }
      if (!anyText) {
        return {
          ok: false,
          error:
            `"${property}" on "${stepId}" needs at least one block that carries text — ` +
            `change it in the inspector's ${sectionOf(step.kind)} section`,
        };
      }
      break;
    }
    case "output-rows":
      // Flow-level, never a step key: the End boundary's rows are declared
      // with `set_output_rows`, which files the change against no step.
      return {
        ok: false,
        error:
          `output rows belong to the flow, not to a step — declare what this automation returns ` +
          `with set_output_rows`,
      };
    case "group": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return bad("an object");
      if (property === "test") {
        const operator = (value as Record<string, unknown>)["operator"];
        if (
          operator !== undefined &&
          (typeof operator !== "string" || !BRANCH_TESTS.some((t) => t.test === operator))
        ) {
          return bad(`an operator that is one of ${BRANCH_TESTS.map((t) => `"${t.test}"`).join(", ")}`);
        }
      }
      break;
    }
  }
  // A step-sourced binding filed as a property — a `context`, a `test` left,
  // an `inputSource`/`arraySource`, a `fileVar` — reads through the same
  // refusal as `set_binding`: the step must exist, and the read must not close
  // a loop. The bare-id spelling (`llm` `contextStepId`) reads the same way.
  // Anything else passes through untouched, as before — no new shape refusal.
  const newRefs = stepRefsIn(value);
  const specRecord = spec as unknown as Record<string, unknown>;
  if (spec.kind === "step-field" && specRecord["refMode"] === "step-id" && typeof value === "string") {
    if (value.length > 0) newRefs.push(value);
  }
  for (const ref of newRefs) {
    const bad = refuseBadStepRef(flow, stepId, `property "${property}" on "${stepId}"`, ref);
    if (bad) return { ok: false, error: bad };
  }
  const oldRefs = stepRefsIn((step as unknown as Record<string, unknown>)[property]);
  const oldBare = (step as unknown as Record<string, unknown>)[property];
  if (spec.kind === "step-field" && specRecord["refMode"] === "step-id" && typeof oldBare === "string") {
    if (oldBare.length > 0) oldRefs.push(oldBare);
  }
  // Position-preserving, like every granular editor: the step keeps its place
  // in emission order (Kestra runs tasks in emission order).
  const replaced = replaceStep(flow, stepId, { ...step, [property]: value } as AuthoredStep);
  if (!replaced.ok) return replaced;
  return withBindingEdges(replaced.flow, stepId, oldRefs, newRefs);
}

function applySetBinding(
  flow: AuthoredFlow,
  stepId: string,
  name: string,
  source: Source | null,
): ApplyResult {
  const step = flow.steps.find((s) => s.id === stepId);
  if (!step) return { ok: false, error: `"${stepId}" is not in this flow` };
  if (name.length === 0 || name.length > 63) {
    return { ok: false, error: `an input binding's name must be 1..63 characters` };
  }
  // Only the kinds that carry `inputs` take bound inputs — narrowed by kind,
  // not by key presence: `in` would refuse a step whose `inputs` key is
  // merely absent, and every step starts without one. No cast either way.
  if (
    step.kind !== "tool" &&
    step.kind !== "datasource" &&
    step.kind !== "query" &&
    step.kind !== "code"
  ) {
    return {
      ok: false,
      error:
        `"${stepId}" is ${article(step.kind)} ${step.kind} step and has no named inputs to bind — ` +
        `only tool, datasource, query and code steps take bound inputs. ` +
        `Change its own settings in the inspector's ${sectionOf(step.kind)} section`,
    };
  }
  if (step.kind === "code" && !step.contract.input.some((f) => f.name === name)) {
    return {
      ok: false,
      error:
        `"${stepId}" has no contract input called "${name}" — its inputs are: ` +
        `${step.contract.input.map((f) => `"${f.name}"`).join(", ") || "none"}. ` +
        `Add the field first with add_io, in the inspector's Contract section`,
    };
  }
  if (source !== null) {
    const checked = checkSource(source);
    if (!checked.ok) return { ok: false, error: `"${name}" on "${stepId}" ${checked.error}` };
    // A step-sourced feed is a read the flow must run first: the step must
    // exist (the phantom-binding turn filed a revision for a step that was
    // never there), and the read must not close a dependency cycle.
    if (checked.value.from === "step" || checked.value.from === "whole") {
      const bad = refuseBadStepRef(flow, stepId, `"${name}" on "${stepId}"`, checked.value.stepId);
      if (bad) return { ok: false, error: bad };
    }
  }
  const bindings = step.inputs ?? [];
  const oldSource = bindings.find((b) => b.name === name)?.source ?? null;
  // The edge half, applied to every return below: the new feed's step joins
  // `dependsOn` through `connect`, and the old feed's step leaves it only
  // when no remaining binding still reads it.
  const oldRefs =
    oldSource !== null && (oldSource.from === "step" || oldSource.from === "whole") ? [oldSource.stepId] : [];
  const newRefs =
    source !== null && (source.from === "step" || source.from === "whole") ? [source.stepId] : [];
  const edged = (replaced: EditResult): ApplyResult => {
    if (!replaced.ok) return replaced;
    return withBindingEdges(replaced.flow, stepId, oldRefs, newRefs);
  };
  const next =
    source === null
      ? bindings.filter((b) => b.name !== name)
      : [...bindings.filter((b) => b.name !== name), { name, source }];
  // I-204: a binding op writes BINDINGS ONLY. When the blob beside them
  // carries nothing the bindings do not, it is DROPPED so the compiler renders
  // the bindings — the thing the type checker checked. When it carries more (a
  // legacy key, a `{{ … }}` program, a fan-out filter) it is left untouched and
  // the gate in `applyOp` signals: rewriting it would either keep two
  // representations (FT0206 at save) or silently drop what it passes.
  const field = step.kind === "code" ? "inputExpr" : "paramsExpr";
  const blobRecord = step as unknown as Record<string, unknown>;
  const blob = blobRecord[field];
  if (typeof blob === "string" && !isBlankFeed(blob)) {
    const contract = step.kind === "code" ? step.contract.input.map((f) => f.name) : null;
    // ⚠ An explicit UNBIND (`source: null`) is never lifted back out of the
    // blob — lifting it re-bound the value the person just removed — and it
    // counts as covered, so its pair goes with the blob.
    const lifted = liftedLiterals(blob, contract, blobRecord["over"], next).filter((b) => source !== null || b.name !== name);
    const all = [...lifted, ...next];
    const covering = source === null ? [...all, { name, source: null }] : all;
    const uncovered = uncoveredBlobKeys(blob, step.kind === "code", blobRecord["over"], covering);
    if (uncovered !== null && uncovered.length === 0) {
      return edged(replaceStep(flow, stepId, withoutBlob({ ...step, inputs: all } as AuthoredStep, field)));
    }
  }
  if (step.kind === "code") {
    const record = step as unknown as Record<string, unknown>;
    const display = record["inputExpr"];
    if (typeof display === "string" && display.trim() !== "") {
      // A catalogue-shape feed (step field, whole rows, the bare element)
      // needs `rowsExpr` shapes to render. Keeping the pair's raw text would
      // file the OLD feed as success and the checker below could only
      // presence-check it — the staleness is known HERE, where old and new
      // feeds are both in hand, so this signals explicitly with no suggestion.
      if (codeValueText(source) === null) {
        const replaced = replaceStep(flow, stepId, { ...step, inputs: next });
        if (!replaced.ok) return replaced;
        const edgedFlow = withBindingEdges(replaced.flow, stepId, oldRefs, newRefs);
        if (!edgedFlow.ok) return edgedFlow;
        return {
          ok: true,
          flow: edgedFlow.flow,
          desync: {
            kind: "binding-desync",
            stepId,
            op: "set_binding",
            display: "inputExpr",
            paramsExpr: display,
            bindings: next,
            suggestedParamsExpr: null,
            reason:
              `"${stepId}" binds "${name}" to a step feed, but its hand-written inputExpr still ` +
              `passes the old one and carries inputs no binding does` +
              `${uncoveredNames(display, true, null, next)}. Bind every input it carries so it can ` +
              `be dropped, in the inspector's Behavior section`,
          },
        };
      }
    }
  }
  return edged(replaceStep(flow, stepId, { ...step, inputs: next }));
}

/** ` ("a", "b")` — the blob keys no binding carries, for a reason sentence; `""` when unreadable. */
function uncoveredNames(display: string, isCode: boolean, over: unknown, bindings: readonly InputBinding[]): string {
  const keys = uncoveredBlobKeys(display, isCode, over, bindings);
  return keys?.length ? ` (${keys.map((k) => `"${k}"`).join(", ")})` : "";
}

function applySetOutputRows(flow: AuthoredFlow, rows: FlowOutputRow[]): ApplyResult {
  if (!Array.isArray(rows)) return { ok: false, error: `"rows" must be an array of output rows` };
  if (rows.length > 32) {
    return { ok: false, error: `an automation returns at most 32 values — remove one first` };
  }
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      return { ok: false, error: `an output row must be {name, type, source}` };
    }
    if (typeof row.name !== "string" || row.name.length === 0 || row.name.length > 63) {
      return { ok: false, error: `an output row's name must be 1..63 characters` };
    }
    if (typeof row.type !== "string" || !VARIABLE_TYPES.includes(row.type)) {
      return {
        ok: false,
        error:
          `output row "${row.name}" has type "${String(row.type)}" — one of ${VARIABLE_TYPES.join(", ")}`,
      };
    }
    if (row.source !== null) {
      const checked = checkSource(row.source);
      if (!checked.ok) return { ok: false, error: `output row "${row.name}" ${checked.error}` };
      const s = checked.value;
      if (
        (s.from === "step" || s.from === "whole") &&
        !flow.steps.some((st) => st.id === s.stepId)
      ) {
        return {
          ok: false,
          error:
            `output row "${row.name}" reads from "${s.stepId}", which is not in this flow. ` +
            `Its steps are: ${flow.steps.map((st) => st.id).join(", ") || "none yet"}`,
        };
      }
    }
  }
  return { ok: true, flow: { ...flow, output: { ...flow.output, rows } } };
}

const CONTRACT_FIELD_NAME_RE = /^[a-z][a-z0-9_]*$/;
const CONTRACT_FIELD_TYPES = ["string", "number", "boolean", "object", "array", "any"] as const;

function applyAddIo(
  flow: AuthoredFlow,
  stepId: string,
  which: "input" | "output",
  field: ContractField,
): ApplyResult {
  const step = flow.steps.find((s) => s.id === stepId);
  if (!step) return { ok: false, error: `"${stepId}" is not in this flow` };
  if (step.kind !== "code") {
    return {
      ok: false,
      error:
        `only a code step's inputs and outputs are editable — "${stepId}" is ${article(step.kind)} ` +
        `${step.kind} step, owned by ${ownerOf(step.kind)}. ` +
        `Change its own settings in the inspector's ${sectionOf(step.kind)} section`,
    };
  }
  if (!CONTRACT_FIELD_NAME_RE.test(field.name) || field.name.length > 63) {
    return {
      ok: false,
      error:
        `"${field.name}" is not a valid field name (lower-case letters, digits and underscores, ` +
        `starting with a letter) — change it in the inspector's Contract section`,
    };
  }
  if (!(CONTRACT_FIELD_TYPES as readonly string[]).includes(field.type)) {
    return {
      ok: false,
      error:
        `"${field.type}" is not a contract type — one of string, number, boolean, object, array, any. ` +
        `Change it in the inspector's Contract section`,
    };
  }
  // The date-shape hint is stored on the field untouched — absent reads as
  // text downstream, so only a misspelt value refuses here.
  if (
    field.format !== undefined &&
    !(CONTRACT_FIELD_FORMATS as readonly string[]).includes(field.format)
  ) {
    return {
      ok: false,
      error:
        `"${field.format}" is not a contract format — one of date, month, datetime, text. ` +
        `Change it in the inspector's Contract section`,
    };
  }
  const list = step.contract[which];
  if (list.some((f) => f.name === field.name)) {
    return {
      ok: false,
      error: `"${stepId}" already has an ${which} called "${field.name}"`,
    };
  }
  if (list.length >= 32) {
    return {
      ok: false,
      error: `"${stepId}" already has 32 ${which}s — remove one in the inspector's Contract section first`,
    };
  }
  return replaceStep(flow, stepId, {
    ...step,
    contract: { ...step.contract, [which]: [...list, field] },
  });
}

function applyRemoveIo(
  flow: AuthoredFlow,
  stepId: string,
  which: "input" | "output",
  name: string,
): ApplyResult {
  const step = flow.steps.find((s) => s.id === stepId);
  if (!step) return { ok: false, error: `"${stepId}" is not in this flow` };
  if (step.kind !== "code") {
    return {
      ok: false,
      error:
        `only a code step's inputs and outputs are editable — "${stepId}" is ${article(step.kind)} ` +
        `${step.kind} step, owned by ${ownerOf(step.kind)}. ` +
        `Change its own settings in the inspector's ${sectionOf(step.kind)} section`,
    };
  }
  const list = step.contract[which];
  if (!list.some((f) => f.name === name)) {
    return { ok: false, error: `"${stepId}" has no ${which} called "${name}"` };
  }
  if (which === "output" && list.length === 1) {
    return {
      ok: false,
      error:
        `a code step's contract needs at least one output — "${name}" is the last one. ` +
        `Change it in the inspector's Contract section instead`,
    };
  }
  return replaceStep(flow, stepId, {
    ...step,
    contract: { ...step.contract, [which]: list.filter((f) => f.name !== name) },
  });
}

function applySetRetry(
  flow: AuthoredFlow,
  stepId: string,
  retry: StepRetry | null,
): ApplyResult {
  const step = flow.steps.find((s) => s.id === stepId);
  if (!step) return { ok: false, error: `"${stepId}" is not in this flow` };
  if (step.kind !== "tool" && step.kind !== "datasource" && step.kind !== "query" && step.kind !== "code") {
    return {
      ok: false,
      error:
        `"${stepId}" is ${article(step.kind)} ${step.kind} step and cannot declare retry — ` +
        `only tool, datasource, query and code steps may carry one. ` +
        `Set it in the inspector's Retry section of a step that makes a call`,
    };
  }
  // ⚠ `null` removes. A retry with one attempt is not a retry, and five is
  // where a transient failure stops being transient — the compiler's caps.
  if (retry === null) {
    // `retry` is optional on every member that may carry it, so dropping the key keeps the step's shape.
    const { retry: _dropped, ...rest } = step;
    const cleared: AuthoredStep = rest as AuthoredStep;
    return replaceStep(flow, stepId, cleared);
  }
  if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 2 || retry.maxAttempts > 5) {
    return {
      ok: false,
      error:
        `retry.maxAttempts on "${stepId}" must be a whole number 2..5 (it counts the first attempt) — ` +
        `change it in the inspector's Retry section`,
    };
  }
  if (retry.backoff !== undefined && retry.backoff !== "constant" && retry.backoff !== "exponential") {
    return {
      ok: false,
      error:
        `retry.backoff on "${stepId}" must be "constant" or "exponential" — ` +
        `change it in the inspector's Retry section`,
    };
  }
  if (
    retry.intervalSeconds !== undefined &&
    (!Number.isInteger(retry.intervalSeconds) || retry.intervalSeconds < 1 || retry.intervalSeconds > 300)
  ) {
    return {
      ok: false,
      error:
        `retry.intervalSeconds on "${stepId}" must be a whole number 1..300 — ` +
        `change it in the inspector's Retry section`,
    };
  }
  if (
    retry.maxDurationSeconds !== undefined &&
    (!Number.isInteger(retry.maxDurationSeconds) ||
      retry.maxDurationSeconds < 10 ||
      retry.maxDurationSeconds > 3600)
  ) {
    return {
      ok: false,
      error:
        `retry.maxDurationSeconds on "${stepId}" must be a whole number 10..3600 — ` +
        `change it in the inspector's Retry section`,
    };
  }
  return replaceStep(flow, stepId, { ...step, retry });
}
 /**
  * Continue a condition's `elseOf` chain with one more arm, plus its first
  * guarded step — atomically, so the compiler never sees a bare branch.
  *
  * The new link continues the END of the chain (first-match-wins order is the
  * chain order, so appending is the only placement that needs no reordering).
  * A missing `conditionExpr` makes an `otherwise` arm, which must end the chain.
  */
 function applyAddArm(
   flow: AuthoredFlow,
   elseOf: string,
   armId: string,
   conditionExpr: string | undefined,
   first: AuthoredStep,
   test?: GuardTest,
 ): ApplyResult {
   const g = guardOf(conditionExpr, test);
   if ("error" in g) return { ok: false, error: g.error };
   const target = flow.steps.find((s) => s.id === elseOf);
   if (!target) return { ok: false, error: `"${elseOf}" is not in this flow` };
   if (!isGuard(target)) {
     return {
       ok: false,
        error: `"${elseOf}" is not a condition — only a branch step can grow an elif/otherwise arm`,
     };
   }
   let end = target;
   for (;;) {
     const next = flow.steps.find(
      (s) => s.kind === "branch" && s.elseOf === end.id,
     );
     if (!next || !isGuard(next)) break;
     end = next;
   }
  // A branch is terminal-otherwise only when it carries NO condition in any
  // form: the display string, the typed `test`, or `conditions` rows. Testing
  // `conditionExpr` alone misreads a typed-guarded if (e.g. score < 2 from the
  // inspector) as an otherwise and refuses every arm after it.
  const endGuarded =
    !!end.conditionExpr?.trim() ||
    (end.test !== undefined && end.test !== null) ||
    ((end as { conditions?: unknown[] }).conditions?.length ?? 0) > 0;
  if (!endGuarded) {
     return {
       ok: false,
       error:
         `the chain through "${target.id}" already ends in an otherwise arm ("${end.id}") — ` +
         `nothing runs after an otherwise, so it cannot be continued. Change or remove "${end.id}" first`,
     };
   }
   if (flow.steps.some((s) => s.id === armId)) {
     return { ok: false, error: `this flow already has a step called "${armId}"` };
   }
   if (!isValidStepId(armId)) {
     return {
       ok: false,
       error: `"${armId}" is not a valid step id (lower-case letters, digits and underscores, starting with a letter)`,
     };
   }
   if (first.kind === "approval" || first.kind === "branch") {
     return {
       ok: false,
       error:
         `a condition cannot guard ${article(first.kind)} ${first.kind} step ("${first.id}") — ` +
         `a pause and a nested condition are unverified inside a conditional block. ` +
         `Guard an ordinary step (tool, transform, code, datasource, query) instead`,
     };
   }
   if (flow.steps.some((s) => s.id === first.id)) {
     return { ok: false, error: `this flow already has a step called "${first.id}"` };
   }
   if (!isValidStepId(first.id)) {
     return {
       ok: false,
       error: `"${first.id}" is not a valid step id (lower-case letters, digits and underscores, starting with a letter)`,
     };
   }
   const link: AuthoredStep = {
     kind: "branch",
     id: armId,
     elseOf: end.id,
     ...g.guard,
   };
   const guarded: AuthoredStep = { ...first, dependsOn: [armId] };
   const at = flow.steps.findIndex((s) => s.id === end.id);
   const steps = [...flow.steps];
   steps.splice(at + 1, 0, link, guarded);
   return { ok: true, flow: { ...flow, steps } };
 }

 /**
  * Start a condition: the branch and the first step it guards, in one op.
  *
  * ⚠ Atomic for `add_arm`'s reason, and the cost of not being so was measured:
  * the two-op alternative (add the step, then insert a branch before it) passes
  * through a state where the step runs on EVERY execution. A conversation that
  * stops there ships an automation that posts to a channel or mails a customer
  * unconditionally, and nothing on any screen distinguishes that from a
  * finished flow.
  *
  * The branch is appended after `afterStepId` and the guarded step behind it, so
  * the compiler never sees the bare branch it refuses as "guards nothing".
  */
 function applyAddGuardedStep(
   flow: AuthoredFlow,
   afterStepId: string,
   branchId: string,
   conditionExpr: string | undefined,
   guardedStep: AuthoredStep,
   test?: GuardTest,
 ): ApplyResult {
   const g = guardOf(conditionExpr, test);
   if ("error" in g) return { ok: false, error: g.error };
   // ⚠ A conditionless head is a branch that guards nothing — the state this op
   // exists to make unreachable.
   if (!g.guard.conditionExpr && !g.guard.test) {
     return { ok: false, error: `add_guarded_step needs a "test" (or a "conditionExpr") — a condition with nothing to test guards nothing` };
   }
   const after = flow.steps.find((s) => s.id === afterStepId);
   if (!after) return { ok: false, error: `"${afterStepId}" is not in this flow` };
   for (const [label, id] of [["branchId", branchId], ["step.id", guardedStep.id]] as const) {
     if (flow.steps.some((s) => s.id === id)) {
       return { ok: false, error: `this flow already has a step called "${id}"` };
     }
     if (!isValidStepId(id)) {
       return {
         ok: false,
         error: `${label} "${id}" is not a valid step id (lower-case letters, digits and underscores, starting with a letter)`,
       };
     }
   }
   if (branchId === guardedStep.id) {
     return { ok: false, error: `the branch and the step it guards need different ids` };
   }
   // ⚠ The SAME refusal `add_arm` makes, and it must stay the same: a pause and
   // a nested condition inside a conditional block are unverified against this
   // engine, and two spellings of one rule drift in the direction where the
   // newer one lets something through.
   if (guardedStep.kind === "approval" || guardedStep.kind === "branch") {
     return {
       ok: false,
       error:
         `a condition cannot guard ${article(guardedStep.kind)} ${guardedStep.kind} step ("${guardedStep.id}") — ` +
         `a pause and a nested condition are unverified inside a conditional block. ` +
         `Guard an ordinary step (tool, transform, code, datasource, query) instead`,
     };
   }
   const branch: AuthoredStep = {
     kind: "branch",
     id: branchId,
     ...g.guard,
     dependsOn: [afterStepId],
   };
   const guarded: AuthoredStep = { ...guardedStep, dependsOn: [branchId] };
   const at = flow.steps.findIndex((s) => s.id === afterStepId);
   const steps = [...flow.steps];
   steps.splice(at + 1, 0, branch, guarded);
   return { ok: true, flow: { ...flow, steps } };
 }

 /**
  * Remove one `elif`/`otherwise` link. The arm must already be empty, and a
  * link the chain continues through hands its continuer down — the next link
  * continues whoever this one continued.
  */
 function applyRemoveArm(flow: AuthoredFlow, stepId: string): ApplyResult {
   const link = flow.steps.find((s) => s.id === stepId);
   if (!link) return { ok: false, error: `"${stepId}" is not in this flow` };
  if (link.kind !== "branch") {
     return {
       ok: false,
       error: `"${stepId}" is not a condition — only an elif/otherwise arm can be removed this way. Remove an ordinary step with remove_step`,
     };
   }
   if (!link.elseOf) {
     return {
       ok: false,
       error:
         `"${stepId}" is the head of its chain — it is not an arm. Remove the whole condition with remove_step, or remove one of its elif/otherwise arms`,
     };
   }
   const guarded = flow.steps
     .filter((s) => s.id !== stepId && reaches(flow, stepId, s.id))
     .map((s) => `"${s.id}"`);
   if (guarded.length) {
     return {
       ok: false,
       error:
         `"${stepId}" still guards ${guarded.join(", ")} — remove or rewire those steps first, then remove the arm`,
     };
   }
   const next = flow.steps.find(
    (s) => s.kind === "branch" && s.elseOf === stepId,
   );
   const steps = flow.steps
     .filter((s) => s.id !== stepId)
     .map((s) =>
       next && s.id === next.id ? { ...s, elseOf: link.elseOf } : s,
     );
   return { ok: true, flow: { ...flow, steps } };
 }

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WHICH STEPS AN OP IS PERMITTED TO TOUCH — the real control (2.4)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ **Computed from the flow and the op, NEVER taken from the model.** The whole
 * point is to check the edit against something the model did not write; a
 * "touched" list supplied in the response would agree with whatever the edit did.
 *
 * This converts *"chat silently edited the wrong component"* from a class of bug
 * into a refused turn. It is `regenerateStep`'s assertion 19 — *regenerate B and
 * A and C stay byte-identical* — turned into a per-turn runtime invariant.
 *
 * ⚠ It is deliberately **not** "the step the op names". `remove_step` legitimately
 * rewrites the `dependsOn` of every step that ran after it, and `add_gate`
 * repoints its target — an over-tight set would refuse correct turns, and a
 * refused correct turn is how a control gets widened until it permits the defect
 * (I-62).
 */
export function touchedBy(flow: AuthoredFlow, op: FlowEditOp): string[] {
  switch (op.op) {
    case "add_step":
      return [op.step.id];

    case "insert_step":
      // The new step, plus the step rewired onto it — `disconnect` + `connect`
      // rewrite `before`'s `dependsOn`, and nothing else moves.
      return [op.step.id, op.beforeStepId];

    case "remove_step":
      // The step, plus everything that named it — `removeStep` strips the edge.
      //
      // ⚠ For a BRANCH that is the whole ARM, transitively (Phase 3). Removing a
      // branch strips the edge from its immediate dependants, which un-guards
      // them AND everything after them; a set naming only the immediate ones
      // would make `assertOnlyTouched` fire on a correct edit, and a control
      // that refuses correct work is one that gets widened until it permits the
      // defect (I-62).
      return [op.stepId, ...downstreamIds(flow, op.stepId)];

    case "replace_step":
    case "set_condition":
    case "set_property":
    case "set_binding":
    case "add_io":
    case "remove_io":
    case "set_retry":
      return [op.stepId];

    case "connect":
    case "disconnect":
      // The edge lives on the DOWNSTREAM step's `dependsOn`. `from` is read and
      // never written.
      return [op.to];

    case "add_gate":
      // The gate, and its target, which is repointed to depend on the gate alone.
      return [`${op.beforeStepId}_gate`, op.beforeStepId];

    case "add_arm":
      // The new link and its first guarded step. The continued chain is only
      // read (the new link names it), never rewritten.
      return [op.armId, op.step.id];

    case "add_guarded_step":
      // Both new steps. `afterStepId` is only READ — the branch names it as a
      // dependency and nothing about that step changes.
      return [op.branchId, op.step.id];

    case "remove_arm":
      // The link, plus the link it hands its continuer to — its `elseOf` is
      // rewritten when the chain continues through the removed arm.
      return [op.stepId];

    case "declare_input":
    case "remove_input":
    case "set_schedule":
      // No step changes. An empty set is the strongest possible assertion here,
      // and it is the honest one.
      return [];

    case "replace_input":
      // Both paths enumerate every reader: a rename rewrites them, and an
      // in-place retype leaves their ids untouched but changes what the id
      // delivers — downstream re-validation must see the true footprint.
      // Compatibility refusals live server-side; this module only enumerates.
      return inputsReadBy(flow, op.inputId);

    /**
     * ⚠ **EMPTY, even though it names a step.** `touchedBy` is about steps this
     * op CHANGED, and declaring a step the result changes nothing about that
     * step — not its params, not its dependsOn, not its output. Returning the
     * named step would file the change against a step nobody edited, which is
     * the thing `resolvedStepId` exists to make measurable.
     */
    case "set_output":
    case "set_output_rows":
      return [];
  }
}

/**
 * Did this edit change anything it was not permitted to?
 *
 * Returns `null` when the edit stayed inside its own footprint, or a message
 * naming the steps that moved when they should not have. **A non-null answer is a
 * bug, not bad input** — refuse the turn and write no revision.
 *
 * Comparison is by serialised step, because the failure being caught is a field
 * changing on a step nobody asked about. Step ORDER is deliberately not compared:
 * `spliceApproval` inserts, and an order-sensitive check would fire on every
 * gate.
 */
export function assertOnlyTouched(
  before: AuthoredFlow,
  after: AuthoredFlow,
  permitted: string[],
): string | null {
  const allowed = new Set(permitted);
  const wasThere = new Map(before.steps.map((s) => [s.id, JSON.stringify(s)]));
  const isThere = new Map(after.steps.map((s) => [s.id, JSON.stringify(s)]));
  const moved: string[] = [];

  for (const [id, json] of wasThere) {
    if (allowed.has(id)) continue;
    if (!isThere.has(id)) moved.push(`${id} (removed)`);
    else if (isThere.get(id) !== json) moved.push(id);
  }
  for (const id of isThere.keys()) {
    if (!allowed.has(id) && !wasThere.has(id)) moved.push(`${id} (added)`);
  }

  if (!moved.length) return null;
  return (
    `this edit changed ${moved.length} step(s) it was not about — ${moved.join(", ")}. ` +
    `Refusing the turn rather than saving a revision nobody asked for`
  );
}

/**
 * One sentence describing what an op DID, computed from the op that was applied.
 *
 * ⚠ **This is why the chat tables have no `assistant_text` column.** What the
 * screen says is pure code over the op plus the diff `flowApprovalService.diff`
 * produces — the same function the approval screen reads — so *"what changed"*
 * has exactly one answer. A stored model narration would sit beside a diff it
 * could contradict, looking like the record of the edit.
 *
 * It is also what the prompt's RECENT CHANGES block carries, so a later turn
 * reads what was DONE rather than what was said.
 */
export function describeOp(flow: AuthoredFlow, op: FlowEditOp): string {
  switch (op.op) {
    case "add_step":
      return (
        `added ${article(op.step.kind)} ${op.step.kind} step "${op.step.id}"${afterPart(op.step)}` +
        // ⚠ Named, never silent. An input is what a person is asked for at run
        // time, so one appearing without being mentioned is a question arriving
        // from nowhere.
        (op.inputs?.length
          ? `, and declared ${op.inputs.length === 1 ? "an input" : "inputs"} ` +
            `${op.inputs.map((i) => `"${i.id}"`).join(", ")} for it to read`
          : "")
      );
    case "insert_step":
      return (
        `inserted ${article(op.step.kind)} ${op.step.kind} step "${op.step.id}" ` +
        `between "${op.afterStepId}" and "${op.beforeStepId}"`
      );
    case "remove_step": {
      const dependents = flow.steps
        .filter((s) => dependenciesOf(s).includes(op.stepId))
        .map((s) => s.id);
      return dependents.length
        ? `removed "${op.stepId}", and ${dependents.join(", ")} no longer run after it`
        : `removed "${op.stepId}"`;
    }
    case "replace_step":
      return `changed the settings of "${op.stepId}"`;
    case "connect":
      return `made "${op.to}" run after "${op.from}"`;
    case "disconnect":
      return `stopped "${op.to}" running after "${op.from}"`;
    case "add_gate":
      return `put a human approval in front of "${op.beforeStepId}" — it now waits for a person before it runs`;
    case "declare_input":
      return `declared an input "${op.input.id}" (${op.input.type})`;
    case "set_condition": {
      const guarded = downstreamIds(flow, op.stepId);
      return guarded.length
        ? `changed when "${op.stepId}" lets ${guarded.join(", ")} run`
        : `changed the condition on "${op.stepId}", which still guards nothing`;
    }
    case "set_property": {
      // The panel's own word for the property, so a turn's diff reads in the
      // words of the control the person would have used.
      const step = flow.steps.find((s) => s.id === op.stepId);
      const label = (step && propertySpec(step.kind, op.property)?.label) ?? op.property;
      return `set ${label} on "${op.stepId}"`;
    }
    case "set_binding":
      return op.source === null
        ? `unbound "${op.name}" on "${op.stepId}"`
        : `bound "${op.name}" on "${op.stepId}"`;
    case "set_output_rows":
      return `declared ${op.rows.length} returned values`;
    case "add_io":
      return `added an ${op.which} called "${op.field.name}" to "${op.stepId}"`;
    case "remove_io":
      return `removed the ${op.which} "${op.name}" from "${op.stepId}"`;
    case "set_retry":
      return op.retry === null
        ? `turned off retry on "${op.stepId}"`
        : `set retry on "${op.stepId}"`;
    case "remove_input":
      return `removed input "${op.inputId}"`;
    case "replace_input":
      return op.input.id === op.inputId
        ? `changed input "${op.inputId}"`
        : `renamed input "${op.inputId}" to "${op.input.id}"`;
    case "set_output":
      return op.output
        ? `said the result of this automation is the value of "${op.output.stepId}"` +
            (op.output.description ? ` — ${op.output.description}` : "")
        : "cleared the declared result — an API caller now gets no value back";
    case "set_schedule":
      /**
       * ⚠ The cron is quoted verbatim rather than rendered into English. A
       * schedule is the one setting that runs unattended, and a wrong plain
       * reading of it ("every Monday at 9") is far more convincing than the
       * cron it misdescribes — the person would approve the sentence, not the
       * expression Kestra will actually use.
       */
      return op.schedule
        ? `set it to run on the schedule \`${op.schedule.cron}\`` +
            (op.schedule.timezone ? ` (${op.schedule.timezone})` : "") +
            ` — this still needs approving before it runs unattended`
        : `removed the schedule — it no longer runs on its own`;
    case "add_arm":
      return op.conditionExpr === undefined && op.test === undefined
        ? `added an otherwise arm "${op.armId}" to the condition through "${op.elseOf}", guarding "${op.step.id}"`
        : `added an elif arm "${op.armId}" to the condition through "${op.elseOf}", guarding "${op.step.id}"`;
    case "remove_arm":
      return `removed the arm "${op.stepId}"`;
    case "add_guarded_step":
      // ⚠ Says the step is CONDITIONAL in the same breath as adding it. The
      // whole point of the op is that "posts to the channel" and "posts to the
      // channel only when …" must never read the same on the screen where
      // somebody signs a flow off.
      return (
        `added ${article(op.step.kind)} ${op.step.kind} step "${op.step.id}", ` +
        `which runs only when the new condition "${op.branchId}" holds, after "${op.afterStepId}"`
      );
  }
 }
/**
 * One changed value as a `{ label, from, to }` row — the transcript's detail
 * under `describeOp`'s summary sentence (`temperature 0 → 0.3`, `body not set
 * → from fetch_offers.body`). Computed from the flows before and after the
 * op, never written by the model, so the `turn.text` ban is untouched: this
 * is the same `stepIo`-style source text the panel reads, in the panel's
 * words (`from <step>.<field>`, `from run input <id>`, `not set`,
 * `set in the expression`).
 *
 * Only `set_property` and `set_binding` change a value a row can show; every
 * other op returns `[]` and keeps its one `describeOp` sentence.
 */
export type OpChangeRow = { label: string; from: string; to: string };

/**
 * The rows for one applied op: the property's panel label with its old and
 * new readings, or one bound input's old and new feed. Empty when the op
 * names no step present on both sides, or when old and new read the same.
 */
export function describeOpRows(
  before: AuthoredFlow,
  after: AuthoredFlow,
  op: FlowEditOp,
): OpChangeRow[] {
  switch (op.op) {
    case "set_property":
      return propertyRows(before, after, op.stepId, op.property);
    case "set_binding":
      return bindingRows(before, after, op.stepId, op.name);
    default:
      return [];
  }
}

/**
 * Kinds whose inputs live inside authored text — reported, never mined. Kept
 * beside `MINED_INPUT_KINDS` in `inventory.ts`, which owns the set: a stored
 * binding that is absent here means the text feeds it (`set in the
 * expression`), anywhere else it means nothing does (`not set`).
 */
const MINED_ROW_KINDS: Record<string, true> = { transform: true, code: true };

function propertyRows(
  before: AuthoredFlow,
  after: AuthoredFlow,
  stepId: string,
  property: string,
): OpChangeRow[] {
  const beforeStep = before.steps.find((s) => s.id === stepId);
  const afterStep = after.steps.find((s) => s.id === stepId);
  if (!beforeStep || !afterStep) return [];
  // The panel's own word for the property — the same label `describeOp`
  // reads, so the row sits under its sentence in the same vocabulary.
  const label = propertySpec(afterStep.kind, property)?.label ?? property;
  const oldValue = (beforeStep as unknown as Record<string, unknown>)[property];
  const newValue = (afterStep as unknown as Record<string, unknown>)[property];
  if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return [];
  return [{ label, from: formatOpValue(oldValue), to: formatOpValue(newValue) }];
}

function bindingRows(
  before: AuthoredFlow,
  after: AuthoredFlow,
  stepId: string,
  name: string,
): OpChangeRow[] {
  const beforeStep = before.steps.find((s) => s.id === stepId);
  const afterStep = after.steps.find((s) => s.id === stepId);
  if (!beforeStep || !afterStep) return [];
  const from = bindingWords(beforeStep, name);
  const to = bindingWords(afterStep, name);
  if (from === to) return [];
  return [{ label: name, from, to }];
}

function bindingWords(step: AuthoredStep, name: string): string {
  const record = step as unknown as Record<string, unknown>;
  // The typed vocabulary is in use: bound when the source is set, `not set`
  // when null or unmentioned — the panel's typed-first rule, never `unknown`.
  if (Array.isArray(record["inputs"])) {
    const bound = (record["inputs"] as InputBinding[]).find((b) => b.name === name)?.source ?? null;
    return bound ? formatOpSource(bound) : "not set";
  }
  // No stored bindings: the text feeds the input and this function does not
  // decompose text. Blank text feeds nothing (`not set`); anything else is
  // the honest unknown, never a claim of empty.
  if (MINED_ROW_KINDS[step.kind] === true) return "set in the expression";
  const text = record["paramsExpr"] ?? record["inputExpr"];
  if (typeof text !== "string" || text.trim() === "" || text.trim() === "[{}]") return "not set";
  return "set in the expression";
}

/** A stored `Source` by shape — the same union `checkSource` accepts. */
function isOpSource(value: unknown): value is Source {
  if (typeof value !== "object" || value === null) return false;
  const from = (value as Record<string, unknown>)["from"];
  return (
    from === "step" || from === "whole" || from === "input" || from === "literal" || from === "self"
  );
}

/**
 * A transform row's feed by shape — the `{ kind: fixed | step | expression }`
 * vocabulary `rows/TransformSection.tsx` persists beside the text. Narrower
 * than a `Source` on purpose: rows never fan out (`whole`/`self`) and never
 * read a run input by address.
 */
type OpRowSource =
  | { kind: "fixed"; value: string }
  | { kind: "step"; stepId: string; field: string }
  | { kind: "expression"; template: string };

function isOpRowSource(value: unknown): value is OpRowSource {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as Record<string, unknown>)["kind"];
  return kind === "fixed" || kind === "step" || kind === "expression";
}

/**
 * One stored source in the panel's words. Mirrors `inputSourceText`
 * (client `lib/step-io.ts`) for the `step`/`input` cases without importing
 * client code into this package: `from <step>.<field>`, `the whole of
 * <step>`, `from run input <id>`, a quoted literal, `each item itself`.
 */
function formatOpSource(source: Source): string {
  switch (source.from) {
    case "step":
      return `from ${source.stepId}.${source.field}`;
    case "whole":
      return `the whole of ${source.stepId}`;
    case "input":
      return `from run input ${source.inputId}`;
    case "literal":
      return source.value === "" ? '""' : `"${source.value}"`;
    case "self":
      return "each item itself";
  }
}

/** One transform row's feed in the panel's words. */
function formatOpRowSource(source: OpRowSource): string {
  switch (source.kind) {
    case "step":
      return source.field ? `from ${source.stepId}.${source.field}` : `from ${source.stepId}`;
    case "fixed":
      return JSON.stringify(source.value);
    case "expression":
      return "set in the expression";
  }
}

const OP_VALUE_CHARS = 160;
const OP_ITEM_CHARS = 80;

function truncateOpText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** One stored property value as the short text a row shows. */
function formatOpValue(value: unknown): string {
  if (value === null || value === undefined) return "not set";
  if (typeof value === "string") return value === "" ? '""' : truncateOpText(value, OP_VALUE_CHARS);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    return truncateOpText(value.map(formatOpItem).join(", "), OP_VALUE_CHARS);
  }
  if (isOpSource(value)) return formatOpSource(value);
  if (isOpRowSource(value)) return formatOpRowSource(value);
  return truncateOpText(JSON.stringify(value) ?? "not set", OP_VALUE_CHARS);
}

/** One list element: a name with its feed, type or value — never bare JSON. */
function formatOpItem(item: unknown): string {
  if (item === null || item === undefined) return "not set";
  if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
    return truncateOpText(String(item), OP_ITEM_CHARS);
  }
  if (typeof item !== "object") return truncateOpText(JSON.stringify(item) ?? "", OP_ITEM_CHARS);
  if (isOpSource(item)) return formatOpSource(item);
  if (isOpRowSource(item)) return formatOpRowSource(item);
  const record = item as Record<string, unknown>;
  if (typeof record["name"] === "string") {
    const name = record["name"];
    const source = record["source"];
    if (isOpSource(source)) return `${name}: ${formatOpSource(source)}`;
    if (isOpRowSource(source)) return `${name}: ${formatOpRowSource(source)}`;
    if (typeof record["value"] === "string") {
      return `${name}: ${truncateOpText(record["value"], OP_ITEM_CHARS)}`;
    }
    if (typeof record["type"] === "string") return `${name} (${record["type"]})`;
    return name;
  }
  if (typeof record["role"] === "string" && typeof record["text"] === "string") {
    return `${record["role"]}: ${truncateOpText(record["text"], OP_ITEM_CHARS)}`;
  }
  return truncateOpText(JSON.stringify(item) ?? "", OP_ITEM_CHARS);
}

/** Every step reachable from `stepId` by following `dependsOn` forwards. */
function downstreamIds(flow: AuthoredFlow, stepId: string): string[] {
  const seen = new Set<string>([stepId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of flow.steps) {
      if (seen.has(s.id)) continue;
      if (dependenciesOf(s).some((d) => seen.has(d))) {
        seen.add(s.id);
        grew = true;
      }
    }
  }
  seen.delete(stepId);
  return [...seen];
}

function article(kind: AuthoredStep["kind"] | "input" | "output"): string {
  return kind === "approval" ||
    kind === "llm" ||
    kind === "extract" ||
    kind === "iteration" ||
    kind === "input" ||
    kind === "output"
    ? "an"
    : "a";
}

function afterPart(step: AuthoredStep): string {
  const deps = dependenciesOf(step);
  return deps.length ? `, running after ${deps.join(" and ")}` : "";
}
