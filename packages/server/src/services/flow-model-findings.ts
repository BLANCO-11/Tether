/**
 * The pure, workspace-free checks a flow model must pass — **as one list**, so
 * every path that accepts a model cannot disagree about which of them apply.
 * foundations Phase 2 task 2.10 · I-127 · D-133
 *
 * ── The defect this closes, and why it was invisible ─────────────────────────
 *
 * Four checks over a model's steps had grown up inside `flow-generation.service
 * .ts` and were called by name at each site. `authorFlow` called all four;
 * `flowRefineService.refine` called ONE of them (`validateModelExpressions`) plus
 * `checkFlowShape`. Nothing was wrong at either site in isolation — the drift is
 * the whole defect, and it is silent, because a missing check is an absence and
 * an absence produces no finding.
 *
 * ⚠ **The sharpest of the three that refine was missing is `checkTextToolInput`,
 * which is I-119's control**: the drafted flow that fetched 11 employees, called
 * `llm_complete` with a 204-character *description* of the rows instead of the
 * rows, exited 0 with `engineStatus: success`, and reported *"The input does not
 * provide any employee attendance data for period 2026-06."* Nothing failed. So
 * before this module existed, a **refine turn could reintroduce I-119** and be
 * caught only at runtime, on a flow that had already passed generation's version
 * of the same check.
 *
 * ── What is NOT here, and where it lives instead ─────────────────────────────
 *
 * - **Refs** — `flowValidator.checkFlowRefs`, run inside `flowService
 *   .writeRevision` via `assertValid`, which every revision passes through. It
 *   needs the workspace's `refFingerprints()` keys, so it is not pure and it is
 *   not this module's business. That is why the gap here was **three** checks
 *   and not four.
 * - **Declared trigger names** — `flowValidator.checkFlowTriggers`, Phase 6:
 *   a webhook/api declaration's name must satisfy the trigger API's own rule
 *   (1..255 chars). Pure, and inside `assertValid` with the refs; the compiler's
 *   `validateModel` enforces the identical rule as a hard gate.
 * - **The caps** — `flowValidator.checkFlowShape`, which takes a whole
 *   `FlowModel` (it counts steps by kind and measures the model's serialised
 *   size), not a step array. `writeRevision` is the authority; `authorFlow` and
 *   `refine` both call it EARLY as well, before an inference call is spent.
 *   Adapting it to this signature would mean changing what it measures, and task
 *   2.10's rule is to adapt the call site rather than the check.
 * - **`validateModel`** — the compiler's own structural check, which needs a
 *   `code` step's placeholder filled in first.
 *
 * ── The two groups, and why the partition is asserted ────────────────────────
 *
 * `draftFlow` feeds ONE class of finding back per attempt — a model handed six
 * findings fixes the loudest and re-breaks the rest — so it needs the expression
 * findings separately from the shape findings. It gets them from
 * `EXPRESSION_CHECKS` and `SHAPE_CHECKS` rather than by naming the functions, and
 * `flow-model-findings.test.ts` asserts `PURE_MODEL_CHECKS` is exactly those two
 * concatenated. So a check added here lands in one of the two groups or the test
 * goes red: `draftFlow`'s staged feedback cannot silently stop covering the set
 * that `authorFlow` and `refine` enforce.
 *
 * ⚠ Each check is a **named entry**, not an anonymous function in a list, because
 * the guard that keeps this honest is *"every entry is reachable through
 * `pureModelFindings`"* — and that test needs a fixture per name, which means a
 * new check with no fixture fails rather than passing unnoticed (I-38).
 */
import { checkConstructedDates } from "./flow-date-params.js";
import { DEAD_STEP_KINDS } from "./flow-dead-step-kinds.js";
import type { FlowModel } from "./flow-compiler.service.js";
import { collectUnknownBindingSteps, unknownBindingMessage } from "./flow-compiler.service.js";
import { EXPRESSION_FIELDS, validateModelExpressions } from "./flow-expression.service.js";
import { checkDeclaredInputs, checkStepRefs, stepNamesRead } from "./flow-input-refs.js";
import {
  checkBulkToolInput,
  checkEncodedInQuotes,
  checkFanOutFirstResult,
  checkJsonPositions,
  checkOutputShapes,
  checkFreeTextInQuotes,
  checkPluckedThenJq,
  checkTextToolInput,
  checkTextValueThenJq,
} from "./flow-output-shape.js";

/** One check, and the name the guard identifies it by. */
export interface PureModelCheck {
  readonly name: string;
  /**
   * Deliberately over the RAW step objects, matching
   * `validateModelExpressions`'s own signature and reason: these run on a parsed
   * generator response, before the model is known to be well-formed, and
   * refusing to look at a step because its `kind` is unfamiliar would let an
   * unknown kind smuggle an expression through.
   *
   * `flowOutput` is the model's own `output` (rows plus the legacy single-step
   * `stepId`) — present so `unused_step` can exempt the step a flow returns.
   * Optional, and every check but that one ignores it, so existing callers and
   * staged runners keep compiling when they do not carry an output.
   *
   * ⚠ **The clause that stood here — *"only the liveness exemption narrows,
   * never a refusal"* — IS WHAT MADE OMITTING IT LOOK FREE, AND IT IS FALSE.**
   * A narrowed exemption on this check IS a refusal on the three authoring
   * paths (see `unused_step` in `SHAPE_CHECKS`), so a caller that drops this
   * argument does not lose a warning, it invents a rejection. `draftFlow` did
   * exactly that and a pure read — one step, and that step is the answer —
   * could not be drafted at all. **Pass the model's `output` wherever you have
   * one.**
   */
  readonly run: (
    steps: Array<Record<string, unknown>>,
    declaredInputs: readonly string[],
    flowOutput?: unknown,
  ) => string[];
}

/**
 * D-22's allowlist over every expression field a step can carry.
 *
 * LOCAL, in the sense `RELATIONAL_CHECKS` defines below: every finding here
 * names ONE subject — an expression this step contains — and no later edit
 * anywhere else in the flow can make it false.
 */
export const EXPRESSION_CHECKS: readonly PureModelCheck[] = [
  {
    name: "validateModelExpressions",
    run: (steps) => validateModelExpressions(steps).map((f) => f.message),
  },
];
/**
 * ── THE DEAD-STEP WARNING (`unused_step`) ─────────────────────────────────────
 *
 * A `code`, `transform`, `query` or `datasource` step whose output nothing reads
 * still runs on every execution — its call is made, its rows are fetched, and
 * nobody looks at the result. That is pure waste with a misleading shape: the
 * next person to read the model assumes the step matters. So it is reported,
 * with the step named and removal suggested.
 *
 * WARNING **A warning at the STORAGE boundary, and a refusal at the AUTHORING
 * one. The paragraph below said the second half was not so, and it was wrong.**
 * It read:
 *
 * > A warning, never a refusal. This lives in this list and nowhere else: no
 * > validator, no compiler gate and no arming check names it, so a flow with a
 * > dead step still saves, compiles, deploys and arms. The generation, refine
 * > and chat paths surface it as feedback beside the refusals; none of them may
 * > promote it into a gate.
 *
 * Sentence two is still exactly true — `writeRevision`, the compiler and the
 * arming checks name it nowhere, so a flow with a dead step does save, compile,
 * deploy and arm. Sentence three is false of three of its four subjects:
 * `draftFlow` spends an attempt on it, `authorFlow` throws `FlowDraftError`
 * over it and `flowRefineService.refine` answers 400. Only chat treats it as
 * feedback, under MODEL HEALTH. It is a member of `SHAPE_CHECKS`, and every one
 * of those callers refuses on any finding in the group — a warning cannot ride
 * a list whose contract is "findings refuse" and stay a warning by prose alone.
 *
 * ⚠ That mattered on 2026-09-16 rather than being a documentation nicety. A
 * pure-read goal is undraftable the moment the exemption cannot fire, which is
 * what `draftFlow` omitting `drafted.output` did for a fortnight. The exemption
 * is now threaded on every path; **the refusal is left as it is**, because
 * splitting this one check out of the group is a design change and not a
 * correction. If it is ever wanted as a true warning, it needs its own return
 * channel, not a promise in a comment.
 *
 * Only the four pure kinds warn. A `tool` step may send mail, write a row or
 * spend money — unread output is not evidence an effect did not happen — and
 * `approval`, `branch` and `merge` schedule other work rather than produce a
 * value, so "nothing reads it" is their normal shape, not a defect. Any other
 * kind (including a missing one: these run on raw drafts) stays silent rather
 * than being judged by a rule written for four kinds.
 *
 * Liveness — what counts as "read" — reuses the readers that already exist and
 * invents no reference grammar:
 *
 * - `outputs.<id>` in any expression field, through `stepNamesRead` (the same
 *   reader `checkStepRefs` uses, so the two cannot disagree about what an
 *   expression reads). `dependsOn` is deliberately NOT a read: a step can
 *   depend on A and read B, and ordering is not data flow.
 * - Structured bindings that name a step: `inputs`/`params`/`inputBindings`/
 *   `outputColumns` rows (`from: "step" | "whole"`, `RowSource` `kind: "step"`,
 *   or a `kind: "expression"` template read through `stepNamesRead`), the
 *   fan-out `over`, approval `context`, branch `test`/`conditions` sides and
 *   the step-owned sources (`inputSource`, `arraySource`, `loopVars`,
 *   `contextStepId`) — the same fields `collectUnknownBindingSteps` walks, so
 *   a step the existence check treats as a reader counts as one here too.
 * - A `merge` step's `sources`: the merge coalesces exactly those outputs, so
 *   each source is read even though no expression names it.
 * - The flow's output: `output.rows` sources and the legacy single-step
 *   `output.stepId`. The step a flow returns is read by definition.
 */
/** One `{ from: "step" | "whole", stepId }` source read into `out`, or nothing when it reads no step. */
function takeSource(out: Set<string>, source: unknown): void {
  if (source === null || typeof source !== "object" || Array.isArray(source)) return;
  const rec = source as Record<string, unknown>;
  if ((rec.from === "step" || rec.from === "whole") && typeof rec.stepId === "string" && rec.stepId) {
    out.add(rec.stepId);
  }
}

/** Every step id one step's structured (non-expression) fields name as a data source. */
function bindingStepIds(step: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const takeRowSource = (rs: unknown): void => {
    if (rs === null || typeof rs !== "object" || Array.isArray(rs)) return;
    const rec = rs as Record<string, unknown>;
    if (rec.kind === "step" && typeof rec.stepId === "string" && rec.stepId) {
      out.add(rec.stepId);
    } else if (rec.kind === "expression" && typeof rec.template === "string") {
      for (const name of stepNamesRead(rec.template)) out.add(name);
    }
    // `fixed` is data, never a read.
  };
  const takeRowArray = (field: string): void => {
    if (!Array.isArray(step[field])) return;
    for (const row of step[field] as Array<unknown>) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      takeRowSource((row as Record<string, unknown>).source);
    }
  };
  if (Array.isArray(step.inputs)) {
    for (const binding of step.inputs as Array<unknown>) {
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) continue;
      takeSource(out, (binding as Record<string, unknown>).source);
    }
  }
  if (step.params !== null && typeof step.params === "object" && !Array.isArray(step.params)) {
    for (const row of Object.values(step.params as Record<string, unknown>)) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      takeRowSource((row as Record<string, unknown>).source);
    }
  }
  takeRowArray("inputBindings");
  takeRowArray("outputColumns");
  // The upstream step a fan-out reads its rows from.
  const over = step.over;
  if (over !== null && typeof over === "object" && !Array.isArray(over)) {
    const id = (over as Record<string, unknown>).stepId;
    if (typeof id === "string" && id) out.add(id);
  }
  // An approval's evidence.
  if ("context" in step) takeSource(out, step.context);
  // Branch guards: the typed test and the typed conditions.
  const test = step.test;
  if (test !== null && typeof test === "object" && !Array.isArray(test) && "left" in test) {
    takeSource(out, (test as Record<string, unknown>).left);
  }
  if (Array.isArray(step.conditions)) {
    for (const condition of step.conditions as Array<unknown>) {
      if (!condition || typeof condition !== "object" || Array.isArray(condition)) continue;
      for (const side of ["left", "right"] as const) {
        const value = (condition as Record<string, unknown>)[side];
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          const rec = value as Record<string, unknown>;
          // A `ConditionSide` is `{ stepId, field }` or `{ fixed }` — the same
          // guard `collectUnknownBindingSteps` keeps, so the two agree.
          if (!("fixed" in rec) && typeof rec.stepId === "string" && rec.stepId) out.add(rec.stepId);
        }
      }
    }
  }
  // Step-owned sources on the wave kinds.
  if (typeof step.contextStepId === "string" && step.contextStepId) out.add(step.contextStepId);
  for (const field of ["inputSource", "arraySource"] as const) {
    if (field in step) takeSource(out, step[field]);
  }
  if (Array.isArray(step.loopVars)) {
    for (const variable of step.loopVars as Array<unknown>) {
      if (!variable || typeof variable !== "object" || Array.isArray(variable)) continue;
      takeSource(out, (variable as Record<string, unknown>).initial);
    }
  }
  // A merge coalesces its sources' outputs — each one is read by definition.
  if (Array.isArray(step.sources)) {
    for (const source of step.sources as Array<unknown>) {
      if (typeof source === "string" && source) out.add(source);
    }
  }
  return [...out];
}

/** Every step id the flow's own output reads: `output.rows` sources and the legacy `output.stepId`. */
function flowOutputStepIds(flowOutput: unknown): string[] {
  const out = new Set<string>();
  if (flowOutput === null || typeof flowOutput !== "object" || Array.isArray(flowOutput)) return [];
  const rec = flowOutput as Record<string, unknown>;
  if (typeof rec.stepId === "string" && rec.stepId) out.add(rec.stepId);
  if (Array.isArray(rec.rows)) {
    for (const row of rec.rows as Array<unknown>) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      takeSource(out, (row as Record<string, unknown>).source);
    }
  }
  return [...out];
}

/**
 * Warn once per pure-kind step whose output nothing reads. Never blocks: see
 * the docblock above for why this is a warning and where it must not travel.
 */
export function checkUnusedSteps(
  steps: Array<Record<string, unknown>>,
  flowOutput?: unknown,
): string[] {
  const read = new Set<string>();
  for (const step of steps) {
    for (const field of EXPRESSION_FIELDS) {
      const value = step[field];
      if (typeof value !== "string") continue;
      for (const name of stepNamesRead(value)) read.add(name);
    }
    for (const name of bindingStepIds(step)) read.add(name);
  }
  for (const name of flowOutputStepIds(flowOutput)) read.add(name);
  const findings: string[] = [];
  for (const step of steps) {
    const id = step.id;
    if (typeof id !== "string" || !id) continue;
    if (typeof step.kind !== "string" || !DEAD_STEP_KINDS[step.kind]) continue;
    if (read.has(id)) continue;
    findings.push(
      `step "${id}" (kind ${step.kind}) produces output nothing reads — no expression reads ` +
        `\`outputs.${id}\`, no binding names it as a step, and no flow output comes from it. ` +
        `Remove the step, or read its output from a later step. It still runs on every execution, ` +
        `so an unread step is cost without effect — unused_step.`,
    );
  }
  return findings;
}

/**
 * The three that answer *"does this model read and pass its data correctly?"* —
 * I-44 / I-117 (the wrong output shape), I-11 (a structure in a JSON string
 * position) and **I-119** (a description of the data instead of the data).
 */
export const SHAPE_CHECKS: readonly PureModelCheck[] = [
  { name: "checkOutputShapes", run: checkOutputShapes },
  // Phase 7 (R03): a fan-out step's results are one per element, never just [0].
  { name: "checkFanOutFirstResult", run: checkFanOutFirstResult },
  { name: "checkJsonPositions", run: checkJsonPositions },
  { name: "checkTextToolInput", run: checkTextToolInput },
  // The 2026-08-18 addition. A leaf plucked in Pebble and then piped into `jq`,
  // which cannot parse a bare String — execution `e097b55b` failed rendering and
  // therefore never made the call at all. In SHAPE_CHECKS so **refine runs it too**:
  // I-119 is the record of three of these being enforced on a generated model and
  // not on an edited one.
  { name: "checkPluckedThenJq", run: checkPluckedThenJq },
  // Its twin, and the reason both exist. `checkPluckedThenJq`'s prompt rule
  // forbade the plucked-then-jq shape and left the positive form implicit — the
  // very NEXT draft (`fa04cfc3`) took the adjacent mistake instead and put the
  // model's prose in quotes, where its newlines broke the JSON. A rule that
  // forbids one of two adjacent errors moves the model to the other.
  { name: "checkFreeTextInQuotes", run: checkFreeTextInQuotes },
  // The 2026-08-19 addition, and the third in this family in two days. Execution
  // `a6488641` kept the quotes on `DRAFT_RULES`' OWN prescribed expression, so the
  // `@json`-encoded value arrived with two pairs of quotes and the body was invalid
  // JSON at the second one. All five checks above passed it — see the docblock on
  // `checkEncodedInQuotes` for why each one did, because they are five different
  // reasons and every one of them is individually correct.
  { name: "checkEncodedInQuotes", run: checkEncodedInQuotes },
  // The 2026-08-19 incident, and the OTHER side of `checkTextToolInput`'s
  // corridor. Execution `05aca859` bound `llm_complete`'s `input` to a whole
  // 7.19 MiB tool response and serialised it; the step callback was 8,401,233
  // bytes and the transport refused it. ⚠ In SHAPE_CHECKS and not
  // EXPRESSION_CHECKS because **refine must run it** — an unbounded `input` is
  // as easy to introduce by editing one step as by generating a flow, and I-119
  // is the record of exactly that gap. The two checks' remedies are each other's
  // findings if either is edited alone; `flow-output-shape.test.ts` holds the
  // corridor table that keeps them apart.
  { name: "checkBulkToolInput", run: checkBulkToolInput },
  // P6 of `proposed-db-operations`, and the first finding this feature's own
  // machinery made reachable. Once a proposed DB operation could be referenced
  // from a draft (D-204), a step had `type: date` parameters to bind for the
  // first time — and the drafter bound one by pasting `-31` onto a month.
  // Execution `7cwL1ris`: `date/time field value out of range: "2026-06-31"`.
  // ⚠ In SHAPE_CHECKS and not EXPRESSION_CHECKS for `checkBulkToolInput`'s
  // reason — **refine and chat must run it too**. An impossible date is easier
  // to introduce by editing one step's params than by drafting a whole flow,
  // and I-119 is the record of three checks enforced on a generated model and
  // not on an edited one.
  { name: "checkConstructedDates", run: checkConstructedDates },
  // The 2026-09-12 addition, and `checkPluckedThenJq`'s known blind spot made a
  // check: that one reads unquoted positions only, so a TEXT `.value` piped into
  // `jq` inside quotes passed every check in this list. An encoder-only program
  // (`@json`, `tostring`, `tojson`) with no field descent feeds opaque text to a
  // JSON parser and the step never runs. ⚠ In SHAPE_CHECKS and not
  // EXPRESSION_CHECKS for `checkBulkToolInput`'s reason — **refine and chat must
  // run it too**, through `pureModelFindings` (MODEL HEALTH) and the corrective
  // pass alike.
  { name: "checkTextValueThenJq", run: checkTextValueThenJq },
];

/**
 * ── THE THIRD GROUP: findings a LATER EDIT CAN SATISFY ───────────────────────
 *
 * ⚠ **The criterion is the ARITY OF THE FINDING'S SUBJECT, and it is a rule
 * rather than a list. Read it before adding a check to any of the three
 * groups.**
 *
 * > A check is **LOCAL** when its finding names ONE subject — an expression this
 * > step contains, a shape it reads through, a date it constructs. It is true at
 * > every state of the flow, and no edit anywhere else can make it false.
 * >
 * > A check is **RELATIONAL** when its finding names TWO — this step *and*
 * > something it does or does not connect to: an input nothing declares, a step
 * > that is not there, an output nothing reads. **Another edit, elsewhere in the
 * > same flow, can make it false.**
 *
 * ── Why the distinction had to become structure ──────────────────────────────
 *
 * A chat turn may apply up to `MAX_OPS_PER_TURN` ops and writes ONCE, after the
 * loop. Every check used to run per op, against models nobody would ever
 * receive — so an instruction whose ops are individually incomplete was
 * unreachable. Not occasionally: **by construction.**
 *
 * Measured on flow `cd9f339b`, 2026-09-16. *"return just the formatted employee
 * info"* needs two ops — `add_step` for the transform, `set_output` to make it
 * the answer. Op 1 was refused `unused_step` ("nothing reads this"), which is a
 * TRUE statement about a flow half way through an edit and a meaningless one
 * about the edit. Op 2 was never reached, and the person's request was never
 * applied.
 *
 * ⚠ **`unused_step` was the one that fired; it is not the one that matters.**
 * Every member below is unreachable-by-sequence in exactly the same way, and
 * chat's own empty-automation refusal already walks into a second instance —
 * *"add the step…, declare any inputs on the next reply"* instructs a model to
 * produce a state `checkDeclaredInputs` would refuse. Fixing the instance
 * would have left four.
 *
 * ── The contract ─────────────────────────────────────────────────────────────
 *
 * These run on the model a caller is ABOUT TO KEEP, never on an intermediate.
 * A single-shot caller (`draftFlow`, `refine`, the canvas post) has only one
 * model, so intermediate and final coincide and it runs them exactly as before.
 * A sequencing caller (a chat turn) runs `localModelFindings` per op and these
 * once, immediately before its single write.
 *
 * ⚠ **A check whose finding a later edit can satisfy MUST live here.** In a
 * local group it does not merely report early — it makes a whole class of
 * instruction impossible to express, and the symptom is a model that looks like
 * it reasoned badly.
 */
export const RELATIONAL_CHECKS: readonly PureModelCheck[] = [
  /**
   * WARNING An expression may only read an input the flow DECLARES - added
   * 2026-09-04 after a run died on `{{ inputs.as_of }}` in a flow whose six
   * revisions all carry `inputs: null`. See `flow-input-refs.ts`; it is in
   * EXPRESSION_CHECKS rather than SHAPE_CHECKS because it is D-22's question
   * ("may this expression say that?") asked about the name rather than the
   * shape.
   */
  {
    name: "checkDeclaredInputs",
    run: (steps, declaredInputs) => checkDeclaredInputs(steps, declaredInputs, EXPRESSION_FIELDS),
  },
  /**
   * WARNING Its twin - an expression reading a step that is not in the model. Found
   * by running the flow `checkDeclaredInputs` had just unblocked, which is the
   * argument for fixing a class rather than an instance.
   */
  {
    name: "checkStepRefs",
    run: (steps) => checkStepRefs(steps, EXPRESSION_FIELDS),
  },
  /**
   * Its structured twin — a binding that names a step this model does not
   * contain. `checkStepRefs` above reads the legacy display strings; the typed
   * `Source`/`RowSource` bindings (`inputs`, `params`, `inputBindings`, `over`,
   * approval `context`, branch `test`/`conditions`, output rows) name their step
   * outside every string that check reads, so a turn that rebound a feed to a
   * missing derivation step saved, compiled and deployed with every check green.
   * In EXPRESSION_CHECKS rather than SHAPE_CHECKS because it asks D-22's
   * question ("may this read say that?") about the step rather than the shape.
   */
  {
    name: "unknown_binding_step",
    run: (steps) => {
      const model = { id: "draft", steps } as unknown as FlowModel;
      const ids = steps.map((s) => (typeof s.id === "string" ? s.id : "")).filter(Boolean);
      return collectUnknownBindingSteps(model).map((ref) => unknownBindingMessage(ref, ids));
    },
  },
];

/**
 * ── THE FOURTH GROUP: reported, and NEVER a reason to refuse ─────────────────
 *
 * ⚠ **`unused_step` is here rather than in `RELATIONAL_CHECKS`, and the
 * difference is not a technicality.**
 *
 * The other relational findings are cross-reference ERRORS: an expression reads
 * an input nothing declares, or a step that is not in the model. Those are
 * broken at the moment they are stored, whoever stored them.
 *
 * *"Nothing reads this step"* is not. It is the ordinary shape of a flow
 * somebody has not finished — and the single most common shape of all, a
 * one-step read, is indistinguishable from it. So a caller that builds a flow
 * ACROSS several units of work (a conversation is exactly this: turn 2 adds the
 * step that reads turn 1's) must be able to keep a model this fires on, or it
 * cannot reach turn 2.
 *
 * ⚠ **This was found by building the relational split and running it**, not by
 * reading: with `unused_step` deferred-but-refusing, the FIRST `add_step` of
 * every conversation was refused, because a one-step flow has nothing reading
 * its one step and `add_step` cannot declare an output. The whole-turn gate was
 * correct and the check's severity was wrong, and only the second of those is
 * visible from a test that mocks `authorFlow`.
 *
 * It refuses where the model arrives COMPLETE in one shot — `draftFlow`, the
 * canvas post, `refine` — because a whole flow emitted at once with a dead step
 * in it is a real defect, and `DRAFT_RULES` tells the drafter to declare the
 * result. It advises where the flow is still being written.
 */
export const ADVISORY_CHECKS: readonly PureModelCheck[] = [
  // The purity warning: a step whose output nothing reads still runs on every
  // execution and still costs its call, so it is reported — but as a WARNING,
  // never a refusal. It lives in no validator, no compiler gate and no arming
  // check: a flow with a dead step still saves, compiles, deploys and arms.
  // In SHAPE_CHECKS and not EXPRESSION_CHECKS because it answers that group's
  // question ("does this model read and pass its data correctly?") from the
  // other end — not "is this read well-formed" but "is this output read at
  // all". So **refine and chat run it too**, through `pureModelFindings`.
  { name: "unused_step", run: (steps, _declared, flowOutput) => checkUnusedSteps(steps, flowOutput) },
];

/** The whole set, in the order the findings are reported. */
export const PURE_MODEL_CHECKS: readonly PureModelCheck[] = [
  ...EXPRESSION_CHECKS,
  ...SHAPE_CHECKS,
  ...RELATIONAL_CHECKS,
  ...ADVISORY_CHECKS,
];

/**
 * The LOCAL groups alone — what a caller part way through a SEQUENCE of edits
 * may judge an intermediate model by.
 *
 * ⚠ Deliberately a separate export rather than a flag on `pureModelFindings`:
 * the strict answer stays the one you get by default, so a new caller that
 * reaches for the obvious function is judged by everything. Narrowing is the
 * thing you have to ask for by name.
 */
export const LOCAL_CHECKS: readonly PureModelCheck[] = [
  ...EXPRESSION_CHECKS,
  ...SHAPE_CHECKS,
];

/** Run one group. `draftFlow` uses this to keep its per-class feedback. */
export function runChecks(
  checks: readonly PureModelCheck[],
  steps: Array<Record<string, unknown>>,
  declaredInputs: readonly string[],
  flowOutput?: unknown,
): string[] {
  return checks.flatMap((c) => c.run(steps, declaredInputs, flowOutput));
}

/**
 * Every pure check, over the steps of a model somebody wants to build.
 *
 * The one call `authorFlow`, `flowRefineService.refine` and chat make. A caller
 * that wants the caps as well calls `flowValidator.checkFlowShape` beside it —
 * see the docblock above for why that one is not in here.
 */
export function pureModelFindings(
  draftedSteps: Array<Record<string, unknown>>,
  /**
   * The ids the model DECLARES as inputs.
   *
   * WARNING **Required, and deliberately not defaulted to `[]`.** An optional
   * parameter here is I-127's exact shape - a shared checker whose omitted
   * input silently gives one consumer less than another - and this repo has
   * paid for it three times (`operations` missing from chat's catalogue,
   * `expressionsBlock` as a five-line summary, `readerlessDatasources` nearly
   * computed twice). Making it required means a new caller cannot forget it;
   * a forgotten `[]` would report every input as undeclared, which is at least
   * loud, but there is no reason to allow the mistake at all.
   */
  declaredInputs: readonly string[],
  /**
   * The model's own `output`, threaded so `unused_step` can exempt the step a
   * flow returns. Optional — deliberately unlike `declaredInputs` above: every
   * other check ignores it, so omitting it narrows one warning's exemption and
   * can never silence a refusal. The three model-carrying callers (generation,
   * refine, chat) pass it; staged or output-less callers leave it absent.
   */
  flowOutput?: unknown,
): string[] {
  return runChecks(PURE_MODEL_CHECKS, draftedSteps, declaredInputs, flowOutput);
}

/**
 * The LOCAL half — for a caller judging a model it is part way through editing.
 *
 * ⚠ **Use this ONLY when another edit is still to come in the same unit of
 * work.** It deliberately cannot see a relational break, so a caller that
 * stopped here and kept the model would store one. The one caller today is a
 * chat turn's per-op check, and it pairs every use with `relationalFindings`
 * before its single write — `flow-chat-relational.test.ts` reads the file off
 * disk and requires the pair, because a narrowing whose partner is missing is
 * a check silently switched off (I-120).
 */
export function localModelFindings(
  draftedSteps: Array<Record<string, unknown>>,
  declaredInputs: readonly string[],
  flowOutput?: unknown,
): string[] {
  return runChecks(LOCAL_CHECKS, draftedSteps, declaredInputs, flowOutput);
}

/**
 * The RELATIONAL half — what only the FINAL model of a unit of work can answer.
 *
 * Never on an intermediate: see `RELATIONAL_CHECKS` for the measured case where
 * doing so made a whole class of instruction impossible to express.
 */
export function relationalFindings(
  draftedSteps: Array<Record<string, unknown>>,
  declaredInputs: readonly string[],
  flowOutput?: unknown,
): string[] {
  return runChecks(RELATIONAL_CHECKS, draftedSteps, declaredInputs, flowOutput);
}

/**
 * The ADVISORY half — true, worth saying, and never a reason to refuse.
 *
 * ⚠ A caller that routes this into a refusal has misread the group: see
 * `ADVISORY_CHECKS` for the measured consequence, which was that the first
 * message of every conversation stopped working.
 */
export function advisoryFindings(
  draftedSteps: Array<Record<string, unknown>>,
  declaredInputs: readonly string[],
  flowOutput?: unknown,
): string[] {
  return runChecks(ADVISORY_CHECKS, draftedSteps, declaredInputs, flowOutput);
}
