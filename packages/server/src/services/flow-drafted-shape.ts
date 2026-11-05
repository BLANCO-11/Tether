import { z } from "zod";
import { FAILURE_HANDLING, type AuthoredStep } from "@foundry/flow-edit";
import { contractFieldSchema, stepContractSchema } from "./step-contract.service.js";

/**
 * A step's human label — carried by every kind, on every path.
 *
 * ⚠ **Here because zod STRIPS what it does not declare, silently.** The canvas
 * posts a hand-authored model through `authorFlow`, which parses with this
 * schema; a `name` the person typed into the inspector was dropped on the way in
 * and the step came back addressed by its id, with nothing failing anywhere.
 * That is CX-015's shape one module further along, and the reason the label
 * round trip is asserted end to end rather than per-file.
 *
 * Neither field reaches the engine — see `flow-step-label.test.ts`, which pins
 * that renaming a step moves no fingerprint and emits no YAML.
 */
const labelled = {
  name: z.string().max(120).optional(),
  description: z.string().max(2000).optional(),
};
/**
 * The typed branch guard (`BranchStep.test`) — carried, never stripped.
 *
 * The compiler reads it as authoritative when `conditionExpr` is absent, and
 * the authored adapter omits the display key when the test cannot be rendered
 * (from-model). Stripping it here turned a guarded branch into "has no
 * condition" on the next turn through `authorFlow`. Mirrors `sourceSchema` +
 * `branchTestSchema` in `flow.service.ts`; local because that module imports
 * this one (its llm/http members), so importing back would be a cycle.
 */
export const draftedBranchTestSchema = z
  .object({
    left: z.union([
      z.object({ from: z.literal("step"), stepId: z.string().min(1).max(63), field: z.string().min(1) }),
      z.object({ from: z.literal("whole"), stepId: z.string().min(1).max(63) }),
      z.object({ from: z.literal("input"), inputId: z.string().min(1).max(63), transform: z.enum(["month", "date"]).optional() }),
      z.object({ from: z.literal("literal"), value: z.string() }),
      z.object({ from: z.literal("self") }),
    ]),
    operator: z.enum([
      "any", "none", "field_eq", "field_ne", "field_contains", "field_starts",
      "field_ends", "field_empty", "field_present", "field_gt", "field_lt",
    ]),
    right: z.string().optional(),
  })
  .nullable()
  .optional();

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT A DRAFTED STEP MAY CONTAIN — the ONE definition (Phase 2 task 2.3)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A leaf module, extracted from `flow-generation.service.ts` where these were
 * module-private, because chat's op vocabulary must use the **same** schema
 * rather than a copy of it.
 *
 * ⚠ **Why one definition and not two that agree.** Both the drafter and a chat
 * op carry a step; a second declaration of what a step may hold means a seventh
 * kind gets **half-added** — expressible by the drafter and inexpressible in
 * chat, or the reverse — and nothing fails, because each half is internally
 * consistent. That is the shape of I-46 exactly: `approval` was a step kind for a
 * whole programme before the drafter was told, so a goal asking for a human
 * decision produced `wait_for_approval:` as a **tool** step, which compiled,
 * deployed and stopped nothing.
 *
 * ⚠ **A leaf, deliberately.** It imports the contract schemas and nothing else
 * at runtime. The `AuthoredStep` import is type-only (erased on emit): it lets
 * the `llm`/`http` members below assert their exactness against the package's
 * shapes without giving chat's op module a runtime path into anything but zod
 * schemas — the "no `draftFlow` in chat" allowlist (task 2.7) is unaffected.
/**
 * Per-input bindings — carried, never stripped.
 *
 * The UAT probe measured the strip: a turn's set_binding applied in memory
 * ("bound to on X", revision bumped) while the stored model never gained the
 * input — because this schema is what `authorFlow` parses the turn's model
 * through, and zod strips what it does not declare. Only blob-parsed bindings
 * survived (rebuilt at write by `normaliseCall`), which is why recipient edits
 * vanished while blob creates persisted. Mirrors `sourceSchema` in
 * `flow.service.ts`; local for the same cycle reason as the branch guard above.
 */
const draftedSourceSchema = z.union([
  z.object({
    from: z.literal("step"),
    stepId: z.string().min(1).max(63),
    field: z.string().min(1),
    transform: z.enum(["date", "text", "number"]).optional(),
    /** D-273: what a NULL in this field does — `skip` the row, or `fail` the step. */
    onNull: z.enum(["skip", "fail"]).optional(),
  }),
  z.object({ from: z.literal("whole"), stepId: z.string().min(1).max(63), transform: z.literal("text").optional(), onNull: z.record(z.string().min(1), z.enum(["skip", "fail"])).optional() }),
  z.object({ from: z.literal("input"), inputId: z.string().min(1).max(63), transform: z.enum(["month", "date"]).optional() }),
  z.object({ from: z.literal("literal"), value: z.string() }),
  z.object({ from: z.literal("self") }),
]);
const draftedInputsSchema = z
  .array(
    z.object({
      name: z.string().min(1).max(63),
      // ⚠ Nullable, mirroring `inputBindingSchema` in `flow.service.ts`.
      // A `null` source is an explicitly unbound input (`unset` in the
      // panel) — the skipped-`@json` body convention stores exactly this,
      // and without nullability any flow carrying one fails EVERY chat turn
      // at write time no matter the op (measured 2026-09-14: a retype-only
      // turn died with `inputs.1.source — Invalid input`). `normaliseCall`
      // keeps the display alongside a null, so nothing downstream loses it.
      source: draftedSourceSchema.nullable(),
    }),
  )
  .max(64)
  .optional();

/**
 * A `code` step as the DRAFTER emits it: a contract and where its payload comes
 * from, never code.
 *
 * `outputKeys` is deliberately absent. The compiler needs it, but deriving it
 * from `contract.output` means the declared shape and the in-container check
 * **cannot disagree** — a drafter that emitted both could declare one contract
 * and enforce another, and the mismatch would surface as a `contract_violation`
 * blaming the fragment for obeying the contract it was given.
 */
/**
 * A step's runtime retry, as the drafter or chat may declare it.
 *
 * ⚠ Bounds mirror the server's `retrySchema` in `flow.service.ts` and the
 * compiler's `validateRetry`, which stay the authority: 2–5 attempts, 1–300s
 * interval, 10–3600s ceiling. Only the retryable variants below carry it.
 */
const draftedRetrySchema = z.object({
  maxAttempts: z.number().int().min(2).max(5),
  backoff: z.enum(["constant", "exponential"]).optional(),
  intervalSeconds: z.number().int().min(1).max(300).optional(),
  maxDurationSeconds: z.number().int().min(10).max(3600).optional(),
});

const draftedCodeStepSchema = z.object({
  id: z.string().min(1).max(63),
  ...labelled,
  kind: z.literal("code"),
  contract: stepContractSchema.omit({ stepId: true }),
  /**
   * OPTIONAL since phase 3 task 6 (build:measure r7): the drafter is taught
   * typed `inputs`, one per contract input, and the compiler renders the
   * payload (`displayCodeInput`). A hand-written one was r7's leading
   * rejection — `{{ json(…) }}` quoted inside a JSON string (R04, F2, I1).
   * Still accepted, and a non-blank one wins verbatim; `""` is "absent".
   */
  inputExpr: z.string().max(8000).default(""),
  inputs: draftedInputsSchema,
  dependsOn: z.array(z.string()).max(32).optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
  retry: draftedRetrySchema.optional(),
});

/**
 * A ref written as a CALL — `support_demo.support_tickets()` — normalised to the
 * name it unambiguously means.
 *
 * ── Why this is a normalisation and not a leniency (D-55's bound) ────────────
 *
 * `TYPE_SYNONYMS` in `step-contract.service.ts` states the rule: this maps a
 * NAME to a name and never guesses at STRUCTURE. A trailing `()` on a ref has
 * exactly one reading — the model wrote the function-call form of the same
 * component — and the alternative is a whole turn spent on nothing.
 *
 * ⚠ **MEASURED, which is why it exists.** Rebuilding the UAT flows on
 * `gpt-5.6-luna`, **2 of 12 turns failed outright** on
 * `support_demo.support_tickets()`, and the finding was almost comic about it:
 * *"'support_demo' IS a datasource in this workspace, but it has no readable
 * component named 'support_tickets()'. Its readable components are:
 * support_demo.support_tickets"* — the correct name, printed one line below the
 * rejected one, differing by two characters.
 *
 * ⚠ **EMPTY PARENTHESES ONLY.** `foo(bar)` is NOT normalised: a ref carrying an
 * argument is a model trying to pass a parameter through the ref instead of
 * through `paramsExpr`, which is a structural mistake and must be refused with
 * the finding that names it. Dropping the argument would silently discard what
 * the model was trying to say.
 *
 * The prompt teaches the plain form; this is the safety net, not the teaching.
 */
const refSchema = z.preprocess(
  (v) => (typeof v === "string" ? v.replace(/\(\s*\)$/, "") : v),
  z.string().min(1).max(128),
);

/**
 * The two wave-1 component shapes — written field-for-field from `AuthoredStep`
 * in `@foundry/flow-edit`, and pinned identical to it by the static checks
 * below the union. A bound here is validation (the same caps style as the
 * members above); the KEYS are the contract, and a key missing or renamed
 * there fails the check rather than drifting silently.
 */
const draftedPromptBlockSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  text: z.string().min(1).max(8000),
});

/**
 * A model that writes `outputFields: ["summary"]` means one string field. The
 * name is slugged to the contract's own rule (`step-contract.service.ts:120`),
 * never invented: anything that cannot become a valid name is passed through
 * unchanged and fails loudly at the schema, as it does today.
 */
function coerceContractField(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const name = v.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 63);
  return /^[a-z][a-z0-9_]*$/.test(name) ? { name, type: "string" } : v;
}

/**
 * What a step does when it fails after its retries (the registry's FAILURE_HANDLING, spread into every retryable
 * kind). Stored so the compiler's by-name refusal of a mode it cannot emit yet can see it: stripped here, a step set to
 * "use a default value" saved as "stop the run" with nothing said (node-type-schema.test.ts, 2026-10-13). The options
 * are read from the registry, never retyped.
 */
const failureModes = FAILURE_HANDLING.find((p) => p.name === "failureMode")!.options!.map((o) => o.value) as [string, ...string[]];
export const failureHandlingKeys = {
  failureMode: z.enum(failureModes).optional(),
  defaultValue: z.unknown().optional(),
};

const draftedLlmStepSchema = z.object({
  id: z.string().min(1).max(63),
  ...labelled,
  kind: z.literal("llm"),
  model: z.string().min(1).max(128),
  tempPreset: z.enum(["precise", "balanced", "creative", "custom"]),
  temperature: z.number().min(0).max(1),
  topP: z.number().min(0).max(1),
  frequencyPenalty: z.number(),
  presencePenalty: z.number(),
  promptBlocks: z.array(draftedPromptBlockSchema).min(1).max(32),
  contextStepId: z.string().min(1).max(63).nullable().optional(),
  outputFields: z.preprocess(
    (v) => (Array.isArray(v) ? v.map(coerceContractField) : v),
    z.array(contractFieldSchema).max(32),
  ),
  memoryEnabled: z.boolean(),
  visionDetail: z.enum(["high", "low"]),
  reasoningSeparated: z.boolean(),
  dependsOn: z.array(z.string()).max(32).optional(),
  retry: draftedRetrySchema.optional(),
  ...failureHandlingKeys,
});

const draftedHeaderSchema = z.object({
  name: z.string().min(1).max(128),
  value: z.string().max(8000),
});

const draftedHttpStepSchema = z.object({
  id: z.string().min(1).max(63),
  ...labelled,
  kind: z.literal("http"),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string().min(1).max(8000),
  headers: z.array(draftedHeaderSchema).max(64),
  queryParams: z.array(draftedHeaderSchema).max(64),
  body: z.object({
    kind: z.enum(["none", "json", "form", "binary", "raw"]),
    content: z.string().max(8000),
    contentType: z.string().max(256).optional(),
    fileVar: z.string().max(128).optional(),
  }),
  auth: z.object({
    kind: z.enum(["none", "api-key", "basic", "bearer", "custom"]),
    headerName: z.string().max(128).optional(),
    secretRef: z.string().max(128).optional(),
  }),
  timeouts: z
    .object({
      connectMs: z.number().int().min(1).optional(),
      readMs: z.number().int().min(1).optional(),
      writeMs: z.number().int().min(1).optional(),
    })
    .nullable()
    .optional(),
  sslVerify: z.boolean(),
  dependsOn: z.array(z.string()).max(32).optional(),
  retry: draftedRetrySchema.optional(),
  ...failureHandlingKeys,
});

/**
 * The wire fields every retired callable spelling carries — the `{ref,
 * paramsExpr}` shape without `retry` (see the alias members below for why).
 * One const so the five spellings cannot drift apart field by field.
 */
const retiredCallFields = {
  id: z.string().min(1).max(63),
  ...labelled,
  ref: refSchema,
  paramsExpr: z.string().min(1).max(8000),
  dependsOn: z.array(z.string()).max(32).optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
};


const draftedStepSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1).max(63),
    ...labelled,
    kind: z.enum(["tool", "datasource", "query"]),
    ref: refSchema,
    /**
     * OPTIONAL since phase 3 step 3 — the drafter is taught `inputs` (+ `over`
     * / `where`) and the compiler renders the call from them. Still accepted
     * when present (chat reopens stored flows through this schema), and a
     * non-blank one wins verbatim. Defaults to `""`, the stored spelling of
     * "absent" (`displayParams`).
     */
    paramsExpr: z.string().max(8000).default(""),
    inputs: draftedInputsSchema,
    /** Fan out: one call per row of this step's output. */
    over: z.object({ stepId: z.string().min(1).max(63), field: z.string().max(128).default("") }).nullable().optional(),
    /** Which rows of `over` become calls — the per-item filter. */
    where: z
      .object({
        field: z.string().min(1).max(128),
        test: z.enum(["field_eq", "field_ne", "field_contains", "field_starts", "field_ends", "field_empty", "field_present", "field_gt", "field_lt"]),
        value: z.string().max(8000).optional(),
      })
      .nullable()
      .optional(),
    /**
     * ── A read that lives in the WORKFLOW rather than in the data source ──────
     *
     * ⚠ **DECLARED HERE BECAUSE ZOD STRIPS WHAT IT DOES NOT KNOW, AND THE
     * STRIPPING WAS SILENT — 2026-09-16.**
     *
     * `parseDraft` is the door into `authorFlow`, and a chat turn goes through
     * it on every op: the current flow is serialised, parsed by this schema, and
     * whatever this schema has not heard of is gone. These four fields were not
     * here, so a step carrying its own statement arrived as a bare `ref` and the
     * consequences stacked:
     *
     *   1. `refFindings` resolved the ref, found no saved reader by that name
     *      (there is none, by design) and answered *"finance_demo IS a
     *      datasource … but it has no readable component named
     *      employees_with_cost_centre"* — so the turn came back
     *      `needs_component` and the person's request was never applied.
     *   2. Worse and unreported: `splitDraft` passes this arm through whole, so
     *      a turn that HAD succeeded would have written the step back **without
     *      its SQL**. Silent data loss on the one field that says what runs.
     *
     * ⚠ Goal mode hid it. `fillGapsWithStepSql` mutates the model AFTER
     * `parseDraft`, so a drafted step-local read never passed through this
     * schema and goal mode worked while chat could not.
     *
     * ⚠ **This is the FOURTH allowlist these four fields had to be added to** —
     * after `AuthoredStep`, `authoredFromModel` and `authoredToStoredFlow`. Any
     * new field on a step owes the same sweep, and the failure mode is the same
     * every time: nothing errors, and the loss surfaces somewhere else as a
     * component that does not exist.
     *
     * Bounds mirror `flow.service.ts`'s stored step schema — one shape, two
     * doors. `flowValidator.checkStepLocalSql` owns the rules; this only
     * carries them.
     */
    sql: z.string().min(1).max(64_000).optional(),
    datasourceRef: z.string().min(1).max(128).optional(),
    sqlParamOrder: z.array(z.string().min(1).max(64)).max(32).optional(),
    sqlParamsSchema: z.record(z.unknown()).optional(),
    dependsOn: z.array(z.string()).max(32).optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    retry: draftedRetrySchema.optional(),
  }),
  /**
   * ⚠ The callable aliases — `action`, `notify`, `report`, `end` and `trigger`.
   * One member per spelling (not one enum across five): a member whose `kind`
   * is itself a union is never eliminated by control flow, so `splitDraft`'s
   * kind switch could not narrow the bundle away and every downstream union
   * carried all five retired spellings. The shared fields live in
   * `retiredCallFields` below, so the five spellings cannot drift apart.
   *
   * They ride the `{ref, paramsExpr}` shape, deliberately WITHOUT `retry`: the
   * compiler's `RETRYABLE_KINDS` refuses it on these, and a drafted retry that
   * dies in validation is a turn spent on nothing.
   */
  z.object({ ...retiredCallFields, kind: z.literal("action") }).strict(),
  z.object({ ...retiredCallFields, kind: z.literal("notify") }).strict(),
  z.object({ ...retiredCallFields, kind: z.literal("report") }).strict(),
  z.object({ ...retiredCallFields, kind: z.literal("end") }).strict(),
  z.object({ ...retiredCallFields, kind: z.literal("trigger") }).strict(),
  /**
   * A reshape, in one of two forms (phase 3 step 2):
   *
   *  - `{from, program, fields}` — the TAUGHT form. The drafter writes only a
   *    jq program over one upstream step's output and the field names it
   *    returns; `splitDraft` builds the Pebble around it (the rows path, the
   *    quoting, `| first`), so the model never escapes a string (I-11/I-43).
   *    `fields` is the step's DECLARED output, which the checker holds every
   *    downstream read to (FT0302).
   *  - `{expr}` — the legacy hand-written template, still accepted: chat
   *    reopens stored flows through this same schema.
   *
   * Exactly one of `expr` / `program` — `splitDraft` refuses both or neither by
   * name (a discriminated union cannot carry a refinement).
   */
  z.object({
    id: z.string().min(1).max(63),
    ...labelled,
    kind: z.literal("transform"),
    expr: z.string().min(1).max(8000).optional(),
    from: z.string().min(1).max(63).optional(),
    program: z.string().min(1).max(8000).optional(),
    fields: z.array(z.string().min(1).max(128)).min(1).max(64).optional(),
    dependsOn: z.array(z.string()).max(32).optional(),
  }),
  /**
   * The retired display alias for `transform`. One member per spelling, so a
   * retired spelling is excludable by kind (`flow-chat-op.test.ts` pins the
   * current spellings against `AuthoredStep` that way) and each spelling's
   * fields read without unpicking an enum. Parseable; `splitDraft` normalizes
   * it to `transform` with the fields carried over, inventing nothing.
   */
  z.object({
    id: z.string().min(1).max(63),
    ...labelled,
    kind: z.literal("calculate"),
    expr: z.string().min(1).max(8000),
    dependsOn: z.array(z.string()).max(32).optional(),
  }),
  draftedCodeStepSchema,
  /**
   * A conditional guard — foundations Phase 3.
   *
   * ⚠ Added here IN THE SAME COMMIT as the kind, because I-46 is what happens
   * otherwise: `approval` was a step kind for a whole programme before the
   * drafter was told, so a goal asking for a human decision produced
   * `wait_for_approval:` as a **tool** step — a step named after a pause that
   * does not pause, which compiled, deployed and stopped nothing.
   */
  z.object({
    id: z.string().min(1).max(63),
    ...labelled,
    kind: z.literal("branch"),
    /**
     * ⚠ **Optional ONLY so an `else` can exist**, and this file was the FOURTH
     * copy of that rule — CX-018. `flow.service.ts`'s `stepSchema` and the
     * portability bundle were widened for the if/elif/else chain and this one was
     * missed, so the canvas could build a chain it could not post: the `authored`
     * path parses here, and a terminal `else` came back
     * `conditionExpr — Required` from a 422 naming a step the person had just
     * drawn. `validateModel` refuses a conditionless branch that is NOT an
     * `else`, so the optionality is not a hole — the shape check is where a
     * missing condition is caught, with a message naming the step.
     */
    conditionExpr: z.string().min(1).max(8000).optional(),
    /** The branch this one continues — `if` → `elif` → `else`. See `BranchStep`. */
    elseOf: z.string().min(1).max(63).optional(),
    /** The typed guard — authoritative when `conditionExpr` is absent. Carried, never stripped. */
    test: draftedBranchTestSchema,
    dependsOn: z.array(z.string()).max(32).optional(),
  }),
  /**
   * The retired display alias for `branch` — same fields, same `else` rule.
   * One member per spelling (see `calculate` above for why). Parseable;
   * `splitDraft` normalizes it to `branch` with the fields carried over.
   */
  z.object({
    id: z.string().min(1).max(63),
    ...labelled,
    kind: z.literal("condition"),
    /** Optional ONLY so an `else` can exist — see the `branch` member above. */
    conditionExpr: z.string().min(1).max(8000).optional(),
    /** The branch this one continues — `if` → `elif` → `else`. See `BranchStep`. */
    elseOf: z.string().min(1).max(63).optional(),
    test: draftedBranchTestSchema,
    dependsOn: z.array(z.string()).max(32).optional(),
  }),
  /**
   * Where the arms come back together — see `MergeStep` in the compiler.
   *
   * ⚠ Added here IN THE SAME COMMIT as the kind, for the reason the branch
   * member above states and I-46 measured. The failure mode is specific and
   * quiet: without this member a model that correctly answers "put a merge
   * here" — because `STEP_SHAPES` now tells it to — has its reply rejected as
   * malformed, and the finding it gets back names a union it cannot satisfy.
   * The model would be right and the parser would be the thing that is wrong.
   *
   * ⚠ **A single spelling, no display alias.** Every other kind in this union
   * accepts two or more (`["branch","condition"]`) because those aliases
   * predate the real kinds. A new kind is owed none, and
   * a synonym invented on day one is a second name nothing keeps in step.
   */
  z.object({
    id: z.string().min(1).max(63),
    ...labelled,
    kind: z.literal("merge"),
    /**
     * ⚠ **`min(2)` here is a SHAPE bound and not the real check.** Everything
     * that needs the whole model — do these ids exist, is each one a kind that
     * produces a JSON result, does each appear earlier in the flow — is
     * `validateModel`'s, so a merge that parses can still be refused with a
     * message naming the step. Same division as `conditionExpr` above.
     */
    sources: z.array(z.string().min(1).max(63)).min(2).max(32),
    dependsOn: z.array(z.string()).max(32).optional(),
  }),
  /**
   * ⚠ Gate 3, and it was MISSING here until outline mode surfaced it.
   *
   * `approval` has been a step kind since away-from-demo-mode Stage 3 and the
   * drafter was never told it exists — not in the schema, not in `DRAFT_RULES`.
   * So a goal saying "wait for someone to approve before sending" could not
   * produce a gate: the best the drafter could do was invent a `tool` step, and
   * it did exactly that (`wait_for_approval:tool`, measured by
   * `outline:measure`). A step that names itself after a pause and does not
   * pause is worse than no step at all — the send goes out and the run looks
   * like it stopped for a person.
   *
   * It went unnoticed because gate 3 was only ever added the OTHER way: by
   * `FlowReview` splicing it into an existing flow (Stage 7), which is a
   * client-side edit the drafter never sees. Outline mode is what made it
   * visible, because a person writing steps in their own words writes
   * "wait for approval" as a step.
   */
  z.object({
    id: z.string().min(1).max(63),
    ...labelled,
    kind: z.literal("approval"),
    /**
     * The hand-written question — a JSON STRING built in jq and `@json`-encoded
     * (I-11, I-43). Optional since phase 3 step 4: what builders are taught is
     * the typed pair below. `lowerDrafted` refuses neither; both is a stored
     * flow's dual read, settled by `normaliseModel` (the typed form wins).
     */
    summaryExpr: z.string().min(1).max(8000).optional(),
    /** The hand-written evidence. Beside a typed `context`, the typed one wins (as above). */
    contextExpr: z.string().min(1).max(8000).optional(),
    /** The question, as plain text — may carry `{{ inputs.<id> }}`. The compiler builds the JSON string. */
    summary: z.string().min(1).max(500).optional(),
    /**
     * The EVIDENCE: the step whose rows the approver sees (`whole`), a flow input,
     * or `null` for a deliberately one-line gate. Joins `dependsOn` when lowered.
     */
    context: z
      .union([
        z.object({ from: z.literal("whole"), stepId: z.string().min(1).max(63) }),
        z.object({ from: z.literal("input"), inputId: z.string().min(1).max(63), transform: z.enum(["month", "date"]).optional() }),
      ])
      .nullable()
      .optional(),
    dependsOn: z.array(z.string()).max(32).optional(),
    awaitSeconds: z.number().int().min(60).max(604_800).optional(),
  }),
  /**
   * An `llm` step as the DRAFTER emits it — the exact shape `AuthoredStep`
   * carries (see the static check below the union), not a second declaration.
   * Added here IN THE SAME COMMIT as the kind, for the reason the `branch`
   * member above states (I-46): a schema that cannot parse a kind is a kind no
   * conversation and no draft can ever produce.
   *
   * ⚠ Parseable is not savable. The registry marks `llm` `runtime: null` until
   * Stage 4 lands its emitter, and `validateModel` refuses it by name until
   * then — so a draft reaching for one is refused with a sentence, not compiled
   * into a step that hangs.
   */
  draftedLlmStepSchema,
  /**
   * An `http` step as the DRAFTER emits it — same exact-shape contract as
   * `llm` above. `auth.secretRef` names an environment variable; a literal
   * token anywhere in the stored step is refused at save (constitution
   * article VIII). Same `runtime: null` staging as `llm`.
   */
  draftedHttpStepSchema,
]);

/**
 * The drafted `llm`/`http` spellings stay IDENTICAL to the authored ones — one
 * definition, not two that agree. Each check asserts both directions (a key the
 * schema drops and a key it invents both fail), and the const assignment is
 * what makes the check load-bearing rather than prose: it errors iff the
 * conditional resolves to `never`.
 */
type _LlmAuthored = Extract<AuthoredStep, { kind: "llm" }>;
type _HttpAuthored = Extract<AuthoredStep, { kind: "http" }>;
type _Identical<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _llmShapeMatchesAuthored: _Identical<z.infer<typeof draftedLlmStepSchema>, _LlmAuthored> = true;
const _httpShapeMatchesAuthored: _Identical<z.infer<typeof draftedHttpStepSchema>, _HttpAuthored> = true;

export type DraftedStep = z.infer<typeof draftedStepSchema>;
export type DraftedCodeStep = z.infer<typeof draftedCodeStepSchema>;
export type DraftedLlmStep = z.infer<typeof draftedLlmStepSchema>;
export type DraftedHttpStep = z.infer<typeof draftedHttpStepSchema>;
export type DraftedRetry = z.infer<typeof draftedRetrySchema>;
export {
  draftedCodeStepSchema,
  draftedHttpStepSchema,
  draftedLlmStepSchema,
  draftedRetrySchema,
  draftedStepSchema,
};
