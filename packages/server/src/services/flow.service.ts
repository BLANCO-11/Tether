import { isPiModel, piFlowService, refuseFoundryRuntime } from "./pi-flow.service.js";
import { randomUUID } from "node:crypto";
import { engineIdOf } from "./flow-engine-id.js";
import { lowerPipelinesWith, PipelineError } from "./flow-pipeline.js";
import { dbOperationSpecSchema } from "./db-operation.service.js";
import { checkRunInputs, type DeclaredRunInput } from "./flow-run-inputs.js";
import { blockingOf, buildCatalogueSnapshot, diagnosticLine, introducedUnsafeSteps, MODEL_ORIGINS, type RevisionOrigin } from "./flow-typecheck.js";
import { deriveInputTypes } from "./flow-input-inherit.js";
import { z } from "zod";
import crypto from "node:crypto";
import { flowRepo, type Flow, type FlowRevision } from "../repositories/flow.repo.js";
import { triggerRepo, type Trigger } from "../repositories/trigger.repo.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { syntaxProblem } from "./sql-parse-check.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { manifestBuilderService, type RefInterface } from "./manifest-builder.service.js";
import { tenantMapper } from "./tenant-mapper.service.js";
import { flowCompiler, FlowCompileError, rowExpressionTemplates, type FlowModel, type FlowStep } from "./flow-compiler.service.js";
import { EXPRESSION_FIELDS, validateModelExpressions } from "./flow-expression.service.js";
import { checkDeclaredInputs, checkStepRefs } from "./flow-input-refs.js";
import { queryParamDescriptor } from "./param-descriptor.js";
import { checkFeederCompatibility } from "./flow-input-compat.js";
import { namesManifestRef } from "./sql-projection.js";
import { flowValidator } from "./flow-validator.service.js";
import { expectationSchema, MAX_EXPECTATIONS } from "./flow-expectation.service.js";
import { kestra, KestraError, type NamespaceRef } from "./kestra-client.service.js";
import { contractFieldSchema, type StepContract } from "./step-contract.service.js";
import type { RevisionAuthor } from "./revision-author.js";
import { runRequesterRepo, systemRequester, type RunRequester } from "./run-requester.js";
import { auditService } from "./audit.service.js";
import { checkState, errorsOf, holesOf, NODE_TYPES, normaliseModel, storedReaderKinds, type CatalogueSnapshot, type Diagnostic, type EFlow, type PropertySpec, type StepKind } from "@foundry/flow-edit";
import { draftedHttpStepSchema, draftedLlmStepSchema, failureHandlingKeys } from "./flow-drafted-shape.js";
import { stepApprovalService } from "./step-approval.service.js";
import { resolveGenerationProvider } from "./generation-provider.service.js";
import { chatConfigSchema } from "./flow-chat-config.js";
import { designSelectionSchema } from "./flow-selection.js";
import { fieldTyIn, specMatch, type StoredBuild } from "./builder/spec-match.js";

/**
 * Flow CRUD, revisions, and the DRAFT half of the two-namespace lifecycle.
 * archive/kestra-migration/05-lifecycle-and-flows.md §6.5 · 07 §7.2
 *
 * The live half lives in `flow-approval.service.ts`, and the split is the point:
 * **nothing in this file can write to the live namespace.** Editing a flow is
 * reachable from a client route; promoting one is reachable only through an
 * approval. Keeping the two in separate modules means the live deploy has
 * exactly one caller, which is a property you can check by grepping.
 */

// ── Model validation at the API edge ─────────────────────────────────────────
//
// Shape only. `flowCompiler.validateModel` owns the semantic rules (allowlist,
// reserved ids, cycles) and is the one that must hold, since it runs on every
// compile including promotion. This schema exists so a malformed body is a 400
// with a field path rather than a compile error.

/**
 * Retry, at the API edge. Present on `tool`/`datasource`/`code` and ABSENT from
 * `transform`/`approval` — a discriminated union, so a retry on an approval
 * step is rejected here as an unrecognised key before it reaches the compiler.
 *
 * The compiler refuses it too, with a message explaining what a second
 * run would cost. Both checks are wanted: this one gives a client a field path,
 * that one covers models that never pass through this route (an imported bundle,
 * the seeds, `flow-generation`).
 */
const retrySchema = z.object({
  maxAttempts: z.number().int().min(2).max(5),
  backoff: z.enum(["constant", "exponential"]).optional(),
  intervalSeconds: z.number().int().min(1).max(300).optional(),
  maxDurationSeconds: z.number().int().min(10).max(3600).optional(),
});

 /**
  * A user-named value carried on the step: an extra context parameter
  * or a tool's extra input (query/body params beyond the endpoint schema).
  * Static strings, authored in the inspector — never expressions, so there is
  * nothing to allowlist and nothing Kestra must render.
  */
 const namedParamSchema = z.object({
   name: z.string().min(1).max(64).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "parameter names must be identifiers"),
   value: z.string().max(8000),
   description: z.string().max(1000).optional(),
 });

 /**
  * TWO FIELDS EVERY KIND CARRIES, AND NEITHER IS THE ID. `id` is the ADDRESS —
  * what `dependsOn` names and what outputs resolve through; renaming it
  * repoints every expression that mentions it. `name` is a LABEL: a person's
  * word for the step, changeable at no cost because nothing resolves through
  * it.
  *
  * NEITHER IS IN `structureHash` — relabelling or re-describing a step does
  * not change what the engine runs, so it must not unarm an approved flow.
  */
 const labelled = {
   name: z.string().max(120).optional(),
   description: z.string().max(2000).optional(),
 };

// ── stepSchema: one member per kind, derived from the registry ─────────────────
//
// Stage 3. Each legacy member's NEW typed keys (`mode`, `templateText`, `test`,
// `summary`, `context`) come from `NODE_TYPES` in `@foundry/flow-edit` —
// `propertyToZod` maps one `PropertySpec` to its zod check, and `legacyNewKeys`
// collects them per kind — so a property renamed in the registry cannot
// silently stop being validated here. Three things are deliberately NOT
// derived, and each has its reason written where it happens:
//
// 1. The old display-string keys (`paramsExpr`, `expr`, `inputExpr`, `code`,
//    `outputKeys`, `conditionExpr`, `summaryExpr`, `contextExpr`, `ref`,
//    `elseOf`, `sources`, `awaitSeconds`) keep their CURRENT exact checks —
//    bounds the registry doesn't name (e.g. `ref` max 128, `sources` min 2).
//    They are tolerated caches in this stage (dual representation), and
//    re-deriving them here would change refusals Stage 5 owns.
// 2. `contract` (code) is skipped: it lives in its own column (`contractJson`,
//    see `writeRevision`'s `insertSteps`), never on the stored step.
// 3. The `llm`/`http` members are `draftedLlmStepSchema`/`draftedHttpStepSchema`
//    BY IMPORT, not by derivation: those carry the measured bounds (header
//    caps, url cap, prompt-block shape) and are pinned identical to
//    `AuthoredStep` where they live. Deriving a second, slightly different
//    check for the same kind is how the two disagree.
//
// New typed keys stay OPTIONAL on every legacy member in this stage (zod +
// findings enforce; Stage 5 requires them once the panel writes them). Old
// required keys stay required. Unknown keys still STRIP (zod default, never
// `.strict()`): stored history carries keys no member names, and refusing them
// would refuse history. `node-type-schema.test.ts` pins all three behaviours.

/**
 * The stored form of `Source` (`node-types.ts`) — "a reference, not a value".
 * Step/input ids are slugs (same 1..63 bound as the steps they name); `field`
 * and `value` are tenant data (row and column names, compared text), not
 * slugs, so they carry no max.
 */
const sourceSchema = z.union([
  // `transform` (Stage3C): a client-written column projection riding on a step
  // source. Validated, not merely retained: every producer (client writers,
  // the upgrade's `codeProjectionLike`) emits only these three, so anything
  // else is refused at the edge with a path rather than silently rendered as
  // a bare field downstream.
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

/**
 * Mirror of `BranchTest` in `@foundry/flow-edit` (`node-types.ts`) — the
 * eleven operators the registry's `test`/`where`/`filter` groups speak.
 * Literals, because the type is not yet a runtime export there; Stage 3.2
 * moves `BRANCH_TESTS` alongside the renderers and this follows it.
 */
const branchTestSchema = z.enum([
  "any",
  "none",
  "field_eq",
  "field_ne",
  "field_contains",
  "field_starts",
  "field_ends",
  "field_empty",
  "field_present",
  "field_gt",
  "field_lt",
]);

/**
 * One named input port bound to a source — `null` is explicitly unbound
 * (`unset` in the panel), which is different from the key being absent.
 * `name` follows the contract-field bound: bindings name `contract.input`
 * fields. The array cap is an edge cap in the style of the header cap inside
 * the derived `key-value-list` — the registry names no bound.
 */
const inputBindingSchema = z.object({
  name: z.string().min(1).max(63),
  source: sourceSchema.nullable(),
});
/**
 * One typed property row's feed (property-rows project) — a value, never an
 * expression the server must parse. `fixed` is a literal string, `step` is an
 * upstream step's field, `expression` is an opaque template the compiler
 * carries as written (`{{#stepId.field#}}` placeholders aside). Bounds mirror
 * the display strings these replace (8000) and the step ids they name (63);
 * the column is tenant data, like `sourceSchema`'s `field`, so it carries no
 * max beyond presence.
 */
const rowSourceSchema = z.union([
  z.object({ kind: z.literal("fixed"), value: z.string().max(8000) }),
  z.object({
    kind: z.literal("step"),
    stepId: z.string().min(1).max(63),
    field: z.string().min(1).max(128),
  }),
  z.object({ kind: z.literal("expression"), template: z.string().min(1).max(8000) }),
]);
/** One named row: the parameter (or column, or contract input) and its feed. */
const rowValueSchema = z.object({ source: rowSourceSchema });
/** A row list (`inputBindings`, code `inputBindings`) — names are panel labels
 *  for the feed, capped like every other edge list in this file. */
const rowBindingListSchema = z
  .array(z.object({ name: z.string().min(1).max(128), source: rowSourceSchema }))
  .max(64);
/**
 * One side of a typed branch condition: an upstream step's field, or a fixed
 * literal the panel compares against. Mirrors the wire shape the branch
 * section writes — see `BranchCondition` in the compiler.
 */
const conditionSideSchema = z.union([
  z.object({ stepId: z.string().min(1).max(63), field: z.string().min(1).max(128) }),
  z.object({ fixed: z.string().max(8000) }),
]);
/** One typed branch condition: `left` compared to `right` with a branch test.
 *  `right` is absent for the row-count operators (`any`, `none`). */
const branchConditionSchema = z.object({
  left: conditionSideSchema,
  op: branchTestSchema,
  right: conditionSideSchema.optional(),
});

/**
 * One flow-level output row (Stage 4.5) — a name, a type and a source. Mirrors
 * `VariableType` in `@foundry/flow-edit` (`node-types.ts`); the values are
 * spelled out here rather than derived because this schema is the API edge and
 * the registry's `output-rows` property is flow-level, never a step key (see
 * `propertyToZod`'s throw). `source` is nullable for the panel's `unset`
 * state, exactly as a binding's is — `checkFlowOutput` refuses an unbound row
 * at save rather than projecting it unavailable for ever.
 */
const outputRowTypeSchema = z.enum([
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
]);
const outputRowSchema = z.object({
  name: z.string().min(1).max(63),
  type: outputRowTypeSchema,
  source: sourceSchema.nullable(),
});

/** One registry property to its zod check. `forceOptional` is Stage 3's rule
 *  that new typed fields stay optional on legacy members. */
function propertyToZod(spec: PropertySpec, forceOptional: boolean): z.ZodTypeAny {
  const required = (spec.required ?? false) && !forceOptional;
  const finish = (s: z.ZodTypeAny): z.ZodTypeAny => {
    // `fallback: null` means "explicitly unset" is a storable value, so the
    // check is nullable; `required` then means the key must be present (even
    // as null), otherwise the key itself is optional too.
    let out = spec.fallback === null ? s.nullable() : s;
    return required ? out : out.optional();
  };
  switch (spec.kind) {
    case "text":
    case "paragraph":
    case "expression":
    case "template":
    case "model-picker": {
      let s = z.string();
      if (required) s = s.min(1);
      if (spec.max !== undefined) s = s.max(spec.max);
      return finish(s);
    }
    case "number":
    case "integer": {
      let n = spec.kind === "integer" ? z.number().int() : z.number();
      if (spec.min !== undefined) n = n.min(spec.min);
      if (spec.max !== undefined) n = n.max(spec.max);
      return finish(n);
    }
    case "toggle":
      return finish(z.boolean());
    case "select": {
      const values = (spec.options ?? []).map((o) => o.value);
      if (values.length > 0) return finish(z.enum(values as [string, ...string[]]));
      // The registry's `operator` specs speak `BranchTest` but name no
      // `options` (branch `test.operator`; wave `filter.test` likewise). The
      // stored type IS the eleven-operator union — `AuthoredStep` says so —
      // so an option-less `operator` falls back to it rather than widening to
      // a string. Any other option-less select still throws: a dropdown with
      // no choices is a registry gap, and failing at module load is how it
      // gets fixed instead of shipping as free text. (When the registry names
      // the options, that list wins and this branch goes dormant.)
      if (spec.name === "operator") return finish(branchTestSchema);
      throw new Error(`registry property "${spec.name}" is a select with no options`);
    }
    case "step-field":
      return finish(sourceSchema);
    case "step-list":
      return finish(z.array(z.string().min(1).max(63)).max(32));
    case "key-value-list":
      return finish(
        z.array(z.object({ name: z.string().min(1).max(128), value: z.string().max(8000) })),
      );
    case "field-list":
      return finish(required ? z.array(contractFieldSchema).min(1) : z.array(contractFieldSchema));
    case "prompt-blocks":
      return finish(
        required
          ? z.array(z.object({ role: z.enum(["system", "user", "assistant"]), text: z.string().min(1).max(8000) })).min(1)
          : z.array(z.object({ role: z.enum(["system", "user", "assistant"]), text: z.string().min(1).max(8000) })),
      );
    case "group": {
      const fields: Record<string, z.ZodTypeAny> = {};
      for (const f of spec.fields ?? []) fields[f.name] = propertyToZod(f, false);
      return finish(z.object(fields));
    }
    case "output-rows":
      // Flow-level (`BOUNDARY_TYPES.end`), never a step key. Throwing rather
      // than emitting nothing: a silent skip is how a property stops being
      // validated with no error anywhere.
      throw new Error(`registry property "${spec.name}" is flow-level, never a step key`);
  }
}

/**
 * Registry properties with a pre-Stage-3 stored meaning — their zod below is
 * the CURRENT exact check (bounds the registry doesn't name), not the derived
 * one, so no refusal changes in this stage. Everything else the registry
 * declares on a legacy kind arrives via `legacyNewKeys`, forced optional.
 */
const OLD_STORAGE_KEYS: Record<string, true> = { ref: true, expr: true, elseOf: true, sources: true, awaitSeconds: true };

/** The member's new typed keys, derived from the registry (see note above). */
function legacyNewKeys(kind: StepKind): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const prop of NODE_TYPES[kind].properties) {
    if (prop.name === "contract") continue;
    if (OLD_STORAGE_KEYS[prop.name]) continue;
    shape[prop.name] = propertyToZod(prop, true);
  }
  return shape;
}

export const stepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("transform"),
    id: z.string().min(1).max(63),
    ...labelled,
    /**
     * Blank since the property-rows project: a converted step writes `""`
     * when its typed rows are complete, and the compiler renders the reshape
     * from `outputColumns`. Non-blank still means verbatim — the upgrade left
     * the expression as written — so legacy steps are untouched. A blank
     * display with no rows is refused by the compiler, naming the step. Still
     * REQUIRED as a key: omitting it is history, not a conversion.
     */
    expr: z.string().max(8000),
    /**
     * Typed rows (property-rows project) — the declared feed and the
     * projected columns. Panel state beside `expr`; `outputColumns` renders
     * the projection when `expr` is blank. `type` is the column's display
     * pill and never reaches the compiler.
     */
    inputBindings: rowBindingListSchema.optional(),
    outputColumns: z
      .array(
        z.object({
          name: z.string().min(1).max(128),
          type: z.string().max(64).optional(),
          source: rowSourceSchema,
        }),
      )
      .max(64)
      .optional(),
    /** A drafted reshape's declared output fields (phase 3 step 2) — checker-only, never emitted. */
    fields: z.array(z.string().min(1).max(128)).max(64).optional(),
    /**
     * A typed combinator PIPELINE (compiled-builder 2d) and the step it reads. Accepted as structure here; its TYPES are
     * checked where the catalogue is known (`lowerPipelinesWith` at the top of `writeRevision`), which also writes `expr`.
     * ⚠ Without these two keys a zod object strips them silently at the HTTP boundary, and the pipeline (the source of
     * truth a readback must show) would be lost while the lowered `expr` survived.
     */
    from: z.string().min(1).max(63).optional(),
    pipeline: z.array(z.record(z.string(), z.unknown())).min(1).max(32).optional(),
    ...legacyNewKeys("transform"),
    dependsOn: z.array(z.string().min(1).max(63)).max(32).optional(),
  }),
  z.object({
    kind: z.enum(["tool", "datasource", "query"]),
    id: z.string().min(1).max(63),
    ...labelled,
    ref: z.string().min(1).max(128),
    /**
     * Frozen SQL at build (mock-data plan, rev 2): the model drafts from schemas alone,
     * the human approves, and the text is frozen into the version. Absent => legacy
     * ref resolution. checkSqlShape still refuses writes/multi-statements on both paths.
     */
    sql: z.string().min(1).max(64_000).optional(),
    /** Datasource owning `sql` when the step carries frozen text. */
    datasourceRef: z.string().min(1).max(128).optional(),
    /**
     * ── The binding for a STEP-LOCAL read (no saved reader behind it) ─────────
     *
     * `runOperation`/`runNamedQuery` take the placeholder order and the
     * descriptors from the stored `datasource_operations`/`datasource_queries`
     * row. A step that carries its own `sql` and names no saved reader has no
     * such row, so without these two fields `order` is `[]` and `paramsSchema`
     * is `{}` — and `checkSqlShape` then refuses the statement at execution
     * with `placeholder_mismatch` the moment it carries a single `$1`.
     *
     * ⚠ **They exist so that a step-local read can take PARAMETERS AT ALL.**
     * The alternative — interpolating a value into the SQL text — is SQL
     * injection with extra steps, and is why `$n` plus a declared order is the
     * only binding this product has ever had. `proposeQuery` already returns
     * both, so these carry what it produced rather than inventing a second
     * shape: the spellings match `namedQueryBodySchema` deliberately.
     *
     * ⚠ Meaningless without `sql`; a stored reader supplies its own. The
     * compiler refuses the mismatch rather than silently preferring one.
     */
    sqlParamOrder: z
      .array(z.string().min(1).max(64))
      .max(32)
      .optional(),
    sqlParamsSchema: z.record(queryParamDescriptor).optional(),
    /**
     * A reader built from the SCHEMA (compiled-builder D-311, slice 5d): the DB-operation spec its `sql` was compiled from. The
     * type checker compiles it again (`buildCatalogueSnapshot`) and types the step from it only when the result is the stored
     * `sql` byte for byte — so a spec cannot claim columns its statement does not return. Meaningless without `sql`.
     */
    sqlSpec: dbOperationSpecSchema.optional(),
    /**
     * Blank since the property-rows project: a converted step writes `""`
     * when its typed `params` rows are complete, and the compiler renders the
     * params block from them. Non-blank still means verbatim — the upgrade
     * left the expression as written — so legacy steps are untouched. A blank
     * display with no rows is refused by the compiler, naming the step.
     *
     * ⚠ OPTIONAL since phase 7, and ABSENT means BLANK. This used to say the key was
     * required ("omitting it is history, not a conversion"), but the model upgrade
     * (`normaliseModel`) DELETES it when a step converts to typed bindings — so a
     * model this server stored could not be posted back to it (kestra:canvas: an
     * edit of an armed flow, 400 "paramsExpr Required"). The compiler already treats
     * a blank or absent display the same way (`displayParams`), and still refuses a
     * step with neither text nor renderable bindings, by name.
     */
    paramsExpr: z.string().max(8000).optional(),
    /**
     * Typed rows (property-rows project) — one feed per parameter, keyed by
     * parameter name. Authoritative when `paramsExpr` is blank. Not a
     * registry property (a catalogue kind's ports come from
     * `catalogue.entries[ref].params`), so written here, optional, exactly
     * as `inputs` already is.
     */
    params: z.record(z.string().min(1).max(128), rowValueSchema).optional(),
    /**
     * Caller-supplied values beyond the endpoint's paramsSchema (http query
     * params, extra body fields). Merged into the first params object at
     * execution; last wins on collision. Structure like paramsExpr's values
     * (see structureHash), for the same reason.
     */
    extraInputs: z.array(namedParamSchema).max(32).optional(),
    /**
     * Typed bindings (Stage 3) — carried beside `paramsExpr`, which stays the
     * enforced shape in this stage. Not registry properties (a catalogue
     * kind's ports come from `catalogue.entries[ref].params`), so written
     * here, optional, until the registry owns them.
     */
    inputs: z.array(inputBindingSchema).max(64).optional(),
    // `field` may be EMPTY: the renderers read `stepId` alone, and the v1→v2
    // upgrade writes `field: ""` itself — `min(1)` refused its own output on
    // the next client save (found in phase 3 step 3).
    over: z.object({ stepId: z.string().min(1).max(63), field: z.string().max(128) }).nullable().optional(),
    where: z
      .object({ field: z.string().min(1), test: branchTestSchema, value: z.string().optional() })
      .nullable()
      .optional(),
    ...legacyNewKeys("tool"),
    dependsOn: z.array(z.string().min(1).max(63)).max(32).optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    retry: retrySchema.optional(),
  }),
  z.object({
    kind: z.literal("code"),
    id: z.string().min(1).max(63),
    ...labelled,
    // Generous, because a fragment is a whole function body. Still bounded:
    // a 200 KB "fragment" is a monolith wearing a step's clothes, which is the
    // exact thing per-step generation exists to stop.
    code: z.string().min(1).max(64_000),
    /**
     * Blank since the property-rows project: a converted step writes `""`
     * when its `inputBindings` rows are complete, and the compiler renders
     * the input object from them. Non-blank still means verbatim, so legacy
     * steps are untouched. A blank display with no rows is refused by the
     * compiler, naming the step. Still REQUIRED as a key (`AuthoredStep`
     * carries it): omitting it is history, not a conversion.
     */
    inputExpr: z.string().max(8000),
    outputKeys: z.array(z.string().min(1).max(63)).min(1).max(32),
    /**
     * Typed bindings (Stage 3) — names come from `contract.input`, carried
     * beside `inputExpr` exactly as the call kinds carry theirs. The contract
     * itself is NOT a step key (it lives in its own column), so the
     * registry's `contract` property is skipped in `legacyNewKeys`.
     */
    inputs: z.array(inputBindingSchema).max(64).optional(),
    /**
     * Typed rows (property-rows project) — one feed per contract input.
     * Rendered before `inputs`: the record can only exist if the new panel
     * wrote it, so it is always the freshest vocabulary. Read when
     * `inputExpr` is blank.
     */
    inputBindings: rowBindingListSchema.optional(),
    dependsOn: z.array(z.string().min(1).max(63)).max(32).optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    retry: retrySchema.optional(),
    ...failureHandlingKeys,
  }),
  /**
   * A conditional guard — foundations Phase 3. ONE arm, no `else`; see
   * `BranchStep` in the compiler for why the second arm is deferred rather than
   * forgotten.
   */
  z.object({
    kind: z.literal("branch"),
    id: z.string().min(1).max(63),
    ...labelled,
    /**
     * A Pebble expression producing a boolean. Built by the inspector, not typed.
     *
     * ⚠ **Optional ONLY so an `else` can exist** — a branch with `elseOf` and no
     * condition is the closing arm of an if/elif chain, and there is nothing for
     * it to test. `validateModel` refuses a conditionless branch that is not an
     * `else`, so the optionality here is not a hole: the shape check is where a
     * missing condition is caught, with a message naming the step.
     *
     * Blank since the property-rows project: a conditions-converted step
     * writes `""`, and the compiler renders `conditions`. Non-blank still
     * means verbatim.
     */
    conditionExpr: z.string().max(8000).optional(),
    /** The branch this one continues — `if` → `elif` → `else`. See `BranchStep`. */
    elseOf: z.string().min(1).max(63).optional(),
    /**
     * Typed conditions (property-rows project) — rendered before the typed
     * `test`: the array can only exist if the new panel wrote it, so it is
     * always the freshest vocabulary. Read when `conditionExpr` is blank. A
     * single condition renders through the same builder the `test` uses; two
     * or more refuse at render time, naming the step. An `else` carries
     * none, as before.
     */
    conditions: z.array(branchConditionSchema).max(8).optional(),
    ...legacyNewKeys("branch"),
    dependsOn: z.array(z.string().min(1).max(63)).max(32).optional(),
  }),
  /**
   * For each (compiled-builder phase F, D-361) — the box and its output. Ids and settings only, never an expression: the
   * compiler builds every path itself. `validateModel` checks everything cross-step (what it runs over, what is inside, what
   * reads what) and names the step.
   */
  z.object({
    kind: z.literal("for_each"),
    id: z.string().min(1).max(63),
    ...labelled,
    over: z.object({ stepId: z.string().min(1).max(63), field: z.string().max(63) }).strict(),
    concurrency: z.number().int().min(1).max(20),
    onError: z.enum(["continue", "stop"]),
    dependsOn: z.array(z.string().min(1).max(63)).max(32).optional(),
  }),
  z.object({
    kind: z.literal("collect"),
    id: z.string().min(1).max(63),
    ...labelled,
    loop: z.string().min(1).max(63),
    result: z.string().min(1).max(63),
    dependsOn: z.array(z.string().min(1).max(63)).max(32).optional(),
  }),
  z.object({
    kind: z.literal("merge"),
    id: z.string().min(1).max(63),
    ...labelled,
    /**
     * The steps whose results come back together, in priority order — the first
     * that actually ran wins. See `MergeStep` in the compiler.
     *
     * ⚠ **Ids, never expressions.** There is no field here a `outputs.…` string
     * could go in: the compiler looks each id's kind up and builds the coalesce
     * itself, so a merge cannot be the route by which unvetted Pebble reaches
     * the emitter. Everything the shape needs — at least two, no duplicates,
     * each one a kind that produces a JSON result, each one earlier in the flow
     * — is checked by `validateModel`, which every revision passes through.
     *
     * The `min(2)` here and `validateModel`'s own count check are deliberately
     * both present: this one gives a caller a field-level error, that one gives
     * a message naming the step, and a model reaching the compiler by any other
     * route is still refused.
     */
    sources: z.array(z.string().min(1).max(63)).min(2).max(32),
    // No registry properties beyond `sources` today — the spread keeps the
    // derivation wired so a new one arrives as an optional key, not a strip.
    ...legacyNewKeys("merge"),
    dependsOn: z.array(z.string().min(1).max(63)).max(32).optional(),
  }),
  z.object({
    kind: z.literal("approval"),
    id: z.string().min(1).max(63),
    ...labelled,
    /**
     * The hand-written question, as a JSON string (I-11). Optional since phase 3
     * step 4: builders write the typed `summary` + `context` (registry keys below)
     * and the compiler renders them. `validateModel` refuses an approval with
     * neither, naming the step — the optionality is not a hole.
     */
    summaryExpr: z.string().min(1).max(4000).optional(),
    /** The evidence. Optional, but a gate shown only a count is a gate that
     *  cannot be answered — see `ApprovalStep` in the compiler. */
    contextExpr: z.string().min(1).max(8000).optional(),
    ...legacyNewKeys("approval"),
    dependsOn: z.array(z.string().min(1).max(63)).max(32).optional(),
    // Floor 60s, ceiling 7 days — mirrors `validateModel`. Wider than a machine
    // because the thing being waited on is a person, and higher at the bottom
    // because a 30-second human gate is one that always times out.
    awaitSeconds: z.number().int().min(60).max(604_800).optional(),
  }),
  // Wave-1 component kinds — the drafted shapes by import (see note 3 above).
  draftedLlmStepSchema,
  draftedHttpStepSchema,
]);

export const flowModelSchema = z.object({
  id: z.string().min(1).max(63),
  inputs: z
    .array(
      z
        .object({
          id: z.string().min(1).max(63),
          type: z.enum(["STRING", "INT", "FLOAT", "BOOLEAN", "DATE", "DATETIME"]),
          defaults: z.string().max(512).optional(),
          /**
           * A value derived from the run's firing time, resolved by the engine
           * at run creation (see `computedInputExpression`). The only way an
           * unattended run can supply a required input — mutually exclusive
           * with `defaults`, enforced by the refine below.
           */
          computed: z.enum(["priorMonth", "currentMonth", "priorDate", "currentDate", "currentYear", "runTimestamp", "currentMonthStart", "priorMonthStart"]).optional(),
          /** Slice 5d: whole days added to a computed `currentDate` — see `FlowInput.offsetDays`. */
          offsetDays: z.number().int().min(-3650).max(3650).optional(),
          required: z.boolean().optional(),
          /** A STRING input's shape — see `FlowInput.format` (phase 5, D-255). */
          format: z.literal("month").optional(),
          /**
           * ⚠ **What a PERSON is being asked for**, in their words — added
           * 2026-09-04 after a report from use.
           *
           * An input id is slug-shaped because it is interpolated into
           * expressions (`{{ inputs.as_of }}`), so it reads like code, and the
           * test drawer rendered it verbatim as the field's label. What a
           * non-technical person actually saw was a box called `as_of` with the
           * hint *"Defaults to 2026-09-04T11:21:39.237Z"* — a machine timestamp
           * and an identifier, with nothing anywhere saying what to type.
           *
           * There was no field for the answer. That is why this exists: not to
           * decorate the id, but to give the sentence somewhere to live.
           *
           * ⚠ **Both are OPTIONAL and stay optional.** Every flow already stored
           * has neither, and a required field here would refuse every existing
           * revision on its next write. Absent means "fall back to the id",
           * which is exactly today's behaviour.
           *
           * ⚠ They ARE inside `structureHash` — see that method. A label change
           * is a change to what a person is asked, and a run whose operator was
           * asked a different question is not the same run.
           */
          label: z.string().min(1).max(120).optional(),
          description: z.string().min(1).max(500).optional(),
        })
        // An input has one answer: a value, or a value derived from the run's
        // firing time — never both on one input.
        .refine((i) => !(i.defaults !== undefined && i.computed !== undefined), {
          message: "an input takes either defaults or computed, not both",
        })
        .refine((i) => i.offsetDays === undefined || i.computed === "currentDate", {
          message: "a day offset applies to a computed currentDate only",
        }),
    )
    .max(32)
    .optional(),
  steps: z.array(stepSchema).min(1).max(64),
  schedule: z
    .object({ cron: z.string().min(1).max(128), timezone: z.string().max(64).optional() })
    .optional(),
  /**
   * Phase 6 — declared triggers. Foundry-side only: unlike `schedule` (which
   * the compiler deploys as a Kestra trigger on approval), `webhook`/`api`
   * emit no YAML — approval materializes a `triggers` row instead
   * (`flowService.materializeDeclaredTriggers`). A draft carries the
   * declaration but never the row. The zod object must ACCEPT these keys or
   * they would be stripped here and the declaration would never reach the
   * revision — the same reason `steps` is listed explicitly.
   */
  /**
   * ⚠ **`webhook` IS RETIRED AND IS DELIBERATELY ABSENT FROM THIS SCHEMA.**
   * `z.object` strips unknown keys, so a model still carrying `webhook` loses
   * the declaration on its next write rather than materialising a retired
   * trigger. See `FLOW_TRIGGER_TYPES` in `trigger.service.ts` for what the two
   * types actually differed by and why the unauthenticated one is the one that
   * went. `api` below is what replaced it.
   *
   * ⚠ Measured before removing: **0 of 30** revisions on this deployment
   * declare `webhook`, so nothing is being silently stripped from anything.
   */
  api: z.object({ name: z.string().min(1).max(255) }).optional(),
  concurrencyLimit: z.number().int().min(1).max(64).optional(),
  /**
   * What this flow claims about its own output — archive/GAPS.md §2.3, D-68.
   *
   * ⚠ On the MODEL, so it travels through `writeRevision` with everything else:
   * the caps, the ref check, the expression allowlist. A separate table would be
   * a second way to declare a claim, reachable without any of them.
   *
   * It is emitted into no YAML. Expectations are evaluated by Foundry against
   * the run's outputs after the fact — a Kestra-side assertion would make a
   * wrong answer look like a broken flow, and the two need different fixes.
   */
  expectations: z.array(expectationSchema).max(MAX_EXPECTATIONS).optional(),
  /**
   * WHAT THIS AUTOMATION RETURNS — see `FlowModel.output` for the whole reasoning.
   *
   * ⚠ **It must be listed here or it would be STRIPPED**, exactly as the
   * comment on `webhook`/`api` above says of those: `z.object` drops unknown
   * keys, so a declaration absent from this schema never reaches the revision
   * and the feature would appear to do nothing with no error anywhere.
   *
   * ⚠ **OPTIONAL and staying optional.** Every revision already stored has no
   * `output`, and a required field here would refuse every existing flow on its
   * next write. Absent means what it means today: the caller reads whichever
   * step it knows about.
   */
  output: z
    .object({
      /**
       * Legacy single-step declaration (pre-rows revisions). Still accepted so
       * stored history validates on read; new declarations use `rows`.
       */
      stepId: z.string().min(1).max(63).optional(),
      description: z.string().min(1).max(500).optional(),
      /**
       * The End boundary's rows (`BOUNDARY_TYPES.end`): one name, type and
       * source per returned value. Defaults to `[]` so a legacy `{stepId}`
       * declaration parses with no rows to check — `checkFlowOutput` then
       * applies the legacy rule, exactly as before.
       */
      rows: z.array(outputRowSchema).max(32).default([]),
    })
    .optional(),
});

export const createFlowSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  model: flowModelSchema,
  /**
   * ⚠ A RAW, UNTRUSTED name. It is the input to `authorOf()`, never the output.
   *
   * The field stays on the body schema because a harness posting over HTTP has
   * no session and its label is worth keeping — but a route must feed it through
   * `authorOf(req, input.createdBy)`, which refuses it outright from a signed-in
   * caller and stamps `system` otherwise. What reaches the service is
   * `author`, below; that is the value with an attestation attached.
   */
  createdBy: z.string().min(1).max(255).optional(),
});

/**
 * What the SERVICE takes: the client's fields, plus the author attestation the
 * route resolved — never the raw `createdBy`.
 *
 * Same split as `ApproveInput` in `flow-approval.service.ts`, and the same
 * reason `verifyVia` is a function argument rather than a schema field (D-44):
 * a value on the body schema is a value a client can set, and this one must not
 * be. `author` is REQUIRED, so a new caller — route, harness or seed — cannot
 * reach `writeRevision` without saying whether anybody was behind the write.
 */
export type CreateFlowInput = Omit<z.infer<typeof createFlowSchema>, "createdBy" | "model"> & {
  /**
   * The compiler's model, not the storage schema's: in-process callers
   * (`draftFlow`, chat, refine, harnesses) hold a `FlowModel`, which carries
   * the declared-but-unemitted kinds (`llm`/`http`) that the storage schema
   * cannot parse. `writeRevision` still parses and validates before persisting,
   * so widening the parameter changes no refusal — the HTTP boundary schemas
   * above are untouched and still 400 anything they cannot store.
   */
  model: FlowModel;
  author: RevisionAuthor;
};

/** Metadata only — see `flowService.updateMeta` for why a rename is not a revision. */
export const updateFlowSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(2000).nullable().optional(),
    /**
     * Per-flow chat configuration (Phase 5). NULL clears it back to "nobody
     * chose" — which is why the refine below tests presence (`!== undefined`),
     * not truthiness: `{chatConfig: null}` is something to update.
     */
    chatConfig: chatConfigSchema.nullable().optional(),
    /** Scope chosen in the builder; NULL clears it the same way. */
    designSelection: designSelectionSchema.nullable().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.chatConfig !== undefined ||
      v.designSelection !== undefined,
    {
      message: "nothing to update",
    },
  );

export const saveRevisionSchema = z.object({
  model: flowModelSchema,
  /** Raw and untrusted, exactly as on `createFlowSchema`. */
  createdBy: z.string().min(1).max(255).optional(),
});

/** @see CreateFlowInput — same split, same reason. */
export type SaveRevisionInput = Omit<z.infer<typeof saveRevisionSchema>, "createdBy" | "model"> & {
  /** @see CreateFlowInput.model — the compiler's model, validated on write. */
  model: FlowModel;
  author: RevisionAuthor;
};

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = statusCode;
  return e;
}

/** Turn a compile failure into a 400 rather than a 500 — it is a bad model, not a bug. */
function rethrowCompile(e: unknown): never {
  if (e instanceof FlowCompileError) {
    throw httpError(e.stepId ? `step "${e.stepId}": ${e.message}` : e.message, 400);
  }
  throw e;
}
/**
 * Typed rows (property-rows project) through the save-time expression checks.
 *
 * The three checks in `writeRevision` read the display-string fields
 * (`paramsExpr`, `inputExpr`, `conditionExpr`, `expr`). A converted step
 * dropped those for `expression` templates that emit just as verbatim —
 * unscanned they would be a hole in D-22 exactly the size of the new feature.
 * So the checked copy folds each step's row templates into its kind's display
 * key; the stored model is untouched, and a finding still names the step (the
 * field it names is the runtime channel, as before). `fixed` values are data
 * and never scanned — the parity `literal` bindings keep.
 */
function stepsWithRowTemplates(steps: FlowStep[]): Array<Record<string, unknown>> {
  return steps.map((s) => {
    const templates = rowExpressionTemplates(s);
    if (!templates.length) return s as unknown as Record<string, unknown>;
    const key =
      s.kind === "code"
        ? "inputExpr"
        : s.kind === "branch"
          ? "conditionExpr"
          : s.kind === "transform"
            ? "expr"
            : "paramsExpr";
    const rec = s as unknown as Record<string, unknown>;
    const cur = typeof rec[key] === "string" ? (rec[key] as string) : "";
    return { ...rec, [key]: [cur, ...templates].filter((t) => t).join("\n") };
  });
}

export interface FlowNamespaces {
  live: NamespaceRef;
  draft: NamespaceRef;
}

/**
 * Whether a working copy is UNDECIDED — the one definition (`saveIncomplete` refuses anything else): it has holes; or the goal asks for
 * something it does not do (the builder's `unmet`, I-299); or the conversation HOLDS a question the build waits on (a choice among
 * readers that fit equally). 2026-10-04 (B08/B12/E05): the builder held a complete build for a reader choice by relabelling it, this
 * rule knew only holes and unmet, and the turn crashed with "nothing undecided".
 */
export function undecided(holes: number, build?: StoredIncomplete["build"]): boolean {
  const unmet = (build?.trace as { unmet?: unknown } | undefined)?.unmet;
  const held = (build?.goalSpec as { conversation?: { pending?: unknown } } | undefined)?.conversation?.pending;
  return holes > 0 || (Array.isArray(unmet) && unmet.length > 0) || (typeof held === "string" && held.length > 0);
}

export const flowService = {
  /** Both namespaces for a workspace — resolved once, used by every deploy path. */
  async namespaces(workspaceId: string): Promise<FlowNamespaces> {
    const ws = await workspaceRepo.get(workspaceId);
    if (!ws) throw httpError("workspace not found", 404);
    const ns = tenantMapper.namespacesFor(ws);
    return { live: ns.live, draft: ns.draft };
  },

  /**
   * Ask Kestra whether the YAML is acceptable BEFORE deploying it.
   *
   * A machine gate, and cheap. The alternative is discovering a dialect mistake
   * when a scheduled execution fails at 3 a.m., which is when nobody is reading
   * `constraints` strings.
   */
  async assertKestraAccepts(yaml: string) {
    let findings: Array<{ constraints?: string }>;
    try {
      findings = await kestra.validateFlow(yaml);
    } catch (e) {
      if (e instanceof KestraError) {
        throw httpError(`Kestra rejected the compiled flow: ${JSON.stringify(e.body ?? e.message)}`, 502);
      }
      throw e;
    }
    const problems = findings.filter((f) => f.constraints).map((f) => f.constraints);
    if (problems.length) {
      throw httpError(`Kestra rejected the compiled flow: ${problems.join("; ")}`, 400);
    }
  },

  /**
   * Persist a model as a new revision and deploy it to the DRAFT namespace.
   *
   * Never the live one. §6.5: *"editing never interrupts a running schedule —
   * the live namespace keeps serving the approved revision while the draft
   * evolves."* That guarantee is this function not having a live branch.
   *
   * The draft is compiled WITHOUT the schedule even when the model declares one:
   * a draft that carried its trigger would fire unattended from the draft
   * namespace and route around the approval gate entirely.
   */
  async writeRevision(
    workspaceId: string,
    flow: Flow,
    model: FlowModel,
    /**
     * Who wrote it AND whether anything verified them — archive/GAPS.md §1.2.
     *
     * Required, and a `RevisionAuthor` rather than a string, because this is the
     * one function every revision passes through (the same argument that put
     * D-22's expression allowlist and D-37's caps here). A caller that could
     * omit it would be a caller that writes an unattested author, which is the
     * defect. Non-interactive writers say `systemAuthor("…")` and mean it.
     */
    author: RevisionAuthor,
    /** One per `code` step, from `flow-generation.service.ts`. Persisted verbatim. */
    contracts: Record<string, StepContract> = {},
    /**
     * Write the revision already hidden from the version list.
     *
     * WARNING **Defaults to visible, and the default is the safe direction.** Every
     * existing caller writes a version somebody meant to keep; only the chat
     * turn opts in, because a conversation makes one version per session and
     * not one per sentence. A default of `true` would silently empty the
     * version list for every path in the product.
     */
    hidden = false,
    /**
     * Who PRODUCED the model (D-242) — distinct from `author`, who is
     * accountable for it. Only `drafter` and `chat` are held to "may not
     * introduce an unsafe block"; absent is no new refusal, so every harness,
     * seed and import written before this parameter behaves as it did.
     */
    opts: { origin?: RevisionOrigin; build?: { goalSpec: unknown; trace: unknown } } = {},
  ): Promise<{ flow: Flow; revision: FlowRevision }> {
    const { draft } = await this.namespaces(workspaceId);
    const revision = flow.draftRevision + 1;
    const [current, interfaces] = await Promise.all([
      manifestBuilderService.refFingerprints(workspaceId),
      manifestBuilderService.refInterfaces(workspaceId),
    ]);
    const previous = opts.origin && MODEL_ORIGINS.has(opts.origin) && flow.draftRevision > 0 ? await flowRepo.getRevision(flow.id, flow.draftRevision) : undefined;
    // ── Every check a revision must pass, in ONE function (compiled-builder D-318) ──
    // So the property test's oracle is this funnel, not a re-assembly of it. The steps and their reasons are in
    // `gateRevisionModel`'s body, unchanged; what stays here is fetching what they read, and persisting what passes.
    let compiled;
    ({ model, compiled } = await gateRevisionModel(model, {
      catalogue: (m) => buildCatalogueSnapshot(workspaceId, m, interfaces),
      refNames: Object.keys(current),
      interfaces,
      allowedModels: (await resolveGenerationProvider()).allowedModels,
      contracts,
      datasourceTypes: Object.fromEntries((await datasourceRepo.listByWorkspace(workspaceId)).map((d) => [d.name, d.type])),
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(previous ? { previous: previous.modelJson as FlowModel } : {}),
      compile: { namespace: draft, withSchedule: false, labels: { foundry_flow: flow.id, foundry_revision: String(revision), foundry_env: "draft" } },
    }));

    // Spec match (compiled-builder phase 5 task 7, D-303): a revision the builder produced does what the spec the person confirmed
    // says — derived from the compiled model, compared both ways. A mismatch is the BUILDER's bug, so it is a refusal naming it,
    // never a stored revision that quietly does something else. Every other writer stores no spec, so nothing is checked for it.
    if (opts.build) {
      // The reader inputs' declared fields (`selects`) are catalogue facts the check reads, never infers from names.
      const snap = await buildCatalogueSnapshot(workspaceId, model as FlowModel, interfaces);
      const mismatch = specMatch(model as never, opts.build as StoredBuild, (ref, input) => snap.refs[ref]?.params.find((p) => p.name === input)?.selects, fieldTyIn(snap.refs));
      if (mismatch.length) throw Object.assign(new Error(`spec match: the built flow does not do what the confirmed spec says (a builder bug) — ${mismatch.join("; ")}`), { statusCode: 500, code: "spec_mismatch", mismatch });
    }

    await this.assertKestraAccepts(compiled.yaml);

    // `current` above is also the staleness baseline: the refs AS OF NOW, which
    // is what a later sweep compares against. Capturing it at approval instead
    // would miss a tool that changed between writing the revision and approving
    // it.
    const row = await flowRepo.insertRevision({
      flowId: flow.id,
      revision,
      // Stamped 2: the model above is normalised, and `normaliseModel` stamps
      // what it returns — this spread states the write rule explicitly rather
      // than relying on it, so a future normalise that stops stamping cannot
      // silently write an unversioned row. Absent `version` reads as 1.
      modelJson: { ...model, version: 2 },
      compiledYamlHash: compiled.hash,
      structureHash: flowCompiler.structureHash(model),
      /**
       * -------------------------------------------------------------------
       * WARNING A revision may be born HIDDEN - 2026-09-04, reported from use
       * -------------------------------------------------------------------
       *
       * "in chat when we make a change it increments the version for each
       * change instead of session as a whole, also version should not show up
       * until user says save draft."
       *
       * Measured: one authoring conversation produced SIX revisions from five
       * turns - one per applied turn, plus one for a canvas gesture made in
       * chat mode. Each is a permanent row in the list a reviewer reads, and
       * `ChatWorkbench` says so in its own comment: "Every op writes a
       * revision immediately (this surface cannot stage)."
       *
       * WARNING **This reuses `hidden_at` rather than inventing a working copy**,
       * and that is the whole reason the change is small. The soft-hide already
       * exists, was designed for exactly this ("hide a revision from the version
       * list without destroying it"), and keeps every property that matters:
       * `getRevision` is unfiltered, so replay, diff and approval all still
       * work on a hidden revision, and only `listRevisions` filters.
       *
       * WARNING **What it deliberately does NOT do is stage the WORK.** Every turn
       * still compiles, still runs `assertKestraAccepts`, still deploys to the
       * draft namespace. A staged working copy would have moved all of that to
       * save time, so a person would author five turns and then learn the
       * second one never compiled. The feedback loop is the expensive part to
       * lose; the version-list noise is not.
       */
      hiddenAt: hidden ? new Date() : null,
      // Both halves, always. `created_by_kind` has no database default on
      // purpose — omitting it here would not be a silent `system`, it would be
      // a failed insert.
      createdBy: author.createdBy,
      createdByKind: author.createdByKind,
      // D-304: the new builder's confirmed GoalSpec and trace; NULL from every other writer.
      ...(opts.build ? { goalSpec: opts.build.goalSpec, buildTrace: opts.build.trace } : {}),
    });

    await flowRepo.insertSteps(
      model.steps.map((s, i) => ({
        flowId: flow.id,
        revision,
        stepId: s.id,
        ordinal: i,
        kind: s.kind,
        configJson: s,
        // Only `tool`, `datasource` and `query` name something in the manifest,
        // and a step-local read does not even though its kind says otherwise.
        // A `transform` and a `code` fragment reach nothing
        // fingerprintable, so an empty map here is the honest answer — not a
        // gap. See `flowCompiler.refsOf` and `namesManifestRef`.
        //
        // ⚠ This used to test the KIND alone, so a step carrying its own SQL
        // recorded `{"<ds>.<name>": "<missing>"}` — a record saying the
        // revision was written against something that was never there. The
        // same mis-read in `refsOf` is what made such a flow unpublishable;
        // fixing one and not the other would leave the row disagreeing with
        // the gate that reads the same question.
        manifestRefsJson: namesManifestRef(s) ? { [s.ref]: current[s.ref] ?? "<missing>" } : {},
        // The contract a `code` step's fragment was generated FROM, kept beside
        // the code so a regeneration has a source. NULL for every other kind —
        // and NULL for a hand-written `code` step, which is honest: nobody
        // declared a contract, so there is nothing to regenerate from.
        contractJson: s.kind === "code" ? (contracts[s.id] ?? null) : null,
      })),
    );

    await kestra.deployFlow(draft, model.id, compiled.yaml);

    // `status` tracks the DRAFT's position in the lifecycle. An armed flow whose
    // draft moves ahead becomes `draft_pending`: still firing the approved
    // revision, with an unapproved one waiting. Collapsing that to "armed" is
    // what makes an approval UI unable to say what is actually running.
    const status = flow.armedRevision != null ? "draft_pending" : "draft";
    const updated = await flowRepo.update(flow.id, { draftRevision: revision, status });
    return { flow: updated ?? flow, revision: row };
  },

  /**
   * `contracts` is not part of `createFlowSchema` on purpose. A contract is what
   * a fragment is generated FROM and judged against, so one arriving in a
   * request body would be a client asserting the standard its own code is held
   * to. It is passed in-process by `flow-generation.service.ts` and nowhere else.
   */
  /**
   * @param designSelection What this automation was designed against, or null
   * when nobody chose (Phase 3.3). ⚠ A separate argument rather than a field on
   * `CreateFlowInput`, for the same reason `contracts` is: it is passed
   * in-process by `runGeneration`, which validated it against the workspace
   * before spending any inference. A field on the body schema would let
   * `POST /flows` record a scope naming datasources that do not exist — a stored
   * claim about an automation's design that was never checked.
   */
  async create(
    workspaceId: string,
    input: CreateFlowInput,
    contracts: Record<string, StepContract> = {},
    designSelection: unknown = null,
    /** See `writeRevision`. A chat turn's first revision is hidden too. */
    hidden = false,
    /** See `writeRevision` (D-242; `build`: D-304). */
    opts: { origin?: RevisionOrigin; build?: { goalSpec: unknown; trace: unknown }; freshEngineId?: boolean } = {},
  ) {
    // `freshEngineId` (a flow a PERSON made — chat, the builder, generation): the engine id is the flow's own uuid, `f-<uuid>`,
    // unique by construction and never derived from the name — the name stays free text until the person renames it (2026-09-27:
    // engine ids like `get_me_a_list_of_all_the_fulfilled_order`, uniquified by suffixes, and a builder id that mixed `_` and `-`
    // and would have been refused as not slug-shaped). Harnesses and seeds name their own ids and look flows up by them: unchanged.
    if (opts.freshEngineId) {
      const id = randomUUID();
      const taken = new Set((await flowRepo.listByWorkspace(workspaceId)).map((f) => f.name));
      let name = input.name;
      for (let n = 2; taken.has(name) && n <= 100; n++) name = `${input.name} ${n}`;
      const model = { ...input.model, id: engineIdOf(id) };
      const flow = await flowRepo.create({ id, workspaceId, name, description: input.description ?? null, kestraFlowId: model.id, draftRevision: 0, status: "draft", designSelection: designSelection ?? null });
      if (!flow) throw httpError("could not create the flow", 500);
      try {
        return await this.writeRevision(workspaceId, flow, model, input.author, contracts, hidden, opts);
      } catch (e) {
        await flowRepo.remove(workspaceId, flow.id);
        throw e;
      }
    }
    // ⚠ **Names and slugs are uniquified, never refused.** The display name is
    // NOT an identifier (the flow id is), but the engine address
    // (`kestraFlowId`, derived from the name) must be unique per workspace —
    // and chat seeds every flow as "Untitled automation". Refusing the second
    // one with a 409 surfaced as a page-level "That did not go through" over a
    // message the person already sent. So the first free `base`, `base 2`,
    // `base-2` pair wins; the TOCTOU backstop below retries instead of throwing.
    //
    // ⚠ **THE SUFFIX SEPARATOR MUST MATCH THE BASE ID'S STYLE AND USED TO BE A
    // HARDCODED HYPHEN** — reported from use on 2026-09-16, with the same
    // page-level "That did not go through" this comment was written to stop,
    // one layer down.
    //
    // `assertCompilable` accepts a flow id that is all-underscore (`ID_RE`,
    // `^[a-z][a-z0-9_]{0,62}$`) or all-hyphen (`^[a-z][a-z0-9-]{0,62}$`) and
    // **never a mix**. Chat seeds every flow as "Untitled automation", whose
    // derived id is `untitled_automation` — so the second one became
    // `untitled_automation-2`, which satisfies NEITHER pattern and is refused
    // at the first save with `flow id "untitled_automation-2" is not
    // slug-shaped`.
    //
    // ⚠ It fires on the SECOND colliding flow, never the first, so it looks
    // like creation breaking rather than a naming rule — and every default-named
    // flow collides by construction.
    //
    // ⚠ The name half (`${baseName} ${n}`) needs no equivalent: a display name
    // is free text and is not an identifier.
    let modelId = input.model.id;
    let name = input.name;
    const fresh = async () => {
      const existing = await flowRepo.listByWorkspace(workspaceId);
      return {
        slugs: new Set(existing.map((f) => f.kestraFlowId)),
        names: new Set(existing.map((f) => f.name)),
      };
    };
    let known = await fresh();
    const baseId = input.model.id;
    const baseName = input.name;
    /**
     * `base` + the separator `base` already uses + `n`.
     *
     * An id with no separator at all takes a hyphen, which is what the previous
     * code did and is correct for that case — `report` → `report-2` satisfies
     * the all-hyphen pattern. An id already carrying an underscore takes an
     * underscore. An id that is somehow already mixed was un-compilable before
     * this function saw it, so there is no third case to invent a rule for.
     */
    const withSuffix = (n: number) => `${baseId}${baseId.includes("_") ? "_" : "-"}${n}`;
    let n = 1;
    while (known.slugs.has(modelId) || known.names.has(name)) {
      n += 1;
      if (n > 100) {
        throw httpError(`a flow with id "${modelId}" already exists in this workspace`, 409);
      }
      modelId = withSuffix(n);
      name = `${baseName} ${n}`;
    }
    const model = { ...input.model, id: modelId };
    let flow = await flowRepo.create({
      workspaceId,
      name,
      description: input.description ?? null,
      kestraFlowId: model.id,
      draftRevision: 0,
      status: "draft",
      designSelection: designSelection ?? null,
    });
    // The pre-check above is TOCTOU-racy; a lost race retries with a fresh
    // read rather than failing the turn — `undefined` means a concurrent
    // submission won the slug, which is exactly what the loop above resolves.
    for (let race = 0; !flow && race < 5; race += 1) {
      known = await fresh();
      n += 1;
      modelId = withSuffix(n);
      name = `${baseName} ${n}`;
      model.id = modelId;
      flow = await flowRepo.create({
        workspaceId,
        name,
        description: input.description ?? null,
        kestraFlowId: model.id,
        draftRevision: 0,
        status: "draft",
        designSelection: designSelection ?? null,
      });
    }
    if (!flow) {
      throw httpError(`a flow with id "${modelId}" already exists in this workspace`, 409);
    }
    try {
      return await this.writeRevision(workspaceId, flow, model, input.author, contracts, hidden, opts);
    } catch (e) {
      // A flow row with no revision is a flow that cannot be read, deployed or
      // deleted through the UI — worse than the failure that produced it.
      await flowRepo.remove(workspaceId, flow.id);
      throw e;
    }
  },

  /**
   * Edit → a NEW revision. Never an update in place.
   *
   * This is §6.5's central rule as code: if a revision could be edited, then
   * approving revision 3 would be a blank cheque over whatever revision 3 later
   * became — privilege escalation by editing.
   */
  async saveRevision(
    workspaceId: string,
    flowId: string,
    input: SaveRevisionInput,
    contracts: Record<string, StepContract> = {},
    /** See `writeRevision`. */
    hidden = false,
    /** See `writeRevision` (D-242). */
    opts: { origin?: RevisionOrigin } = {},
  ) {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) throw httpError("flow not found", 404);
    if (input.model.id !== flow.kestraFlowId) {
      // The flow id addresses both namespaces. Letting it move would orphan the
      // deployed live flow while the draft carried on under a new name.
      throw httpError(
        `flow id is immutable: this flow is "${flow.kestraFlowId}", the model says "${input.model.id}"`,
        400,
      );
    }

    // ── A contract survives an edit it was not part of (Stage 7.3) ───────────
    //
    // A contract is per STEP, and an edit that renames the flow or deletes a
    // different step does not change what any surviving `code` step was
    // generated from. Before Stage 7 nothing exercised this, because the only
    // caller that passed contracts was `regenerateStep`, which passes all of
    // them: `POST /:flowId/revisions` passed none, so the first edit through
    // that route silently dropped every contract and left the fragments
    // permanently un-regenerable — `regenerateStep` refuses a step with no
    // contract, correctly and unhelpfully.
    //
    // Inherit, then let the caller override. Only steps still present carry
    // over, so deleting a step drops its contract with it.
    const inherited = await this.contractsFor(flow.id, flow.draftRevision);
    const stillPresent = new Set(input.model.steps.map((s) => s.id));
    const merged: Record<string, StepContract> = {};
    for (const [stepId, contract] of Object.entries(inherited)) {
      if (stillPresent.has(stepId)) merged[stepId] = contract;
    }
    Object.assign(merged, contracts);

    // ⚠ The author is the person (or system caller) doing THIS edit, never the
    // one inherited from the previous revision. A revision is a new act, and
    // gate 2 compares an approver against the author of the revision it is
    // approving — inheriting would let one browser edit launder every later
    // harness write into a `user` attestation.
    return this.writeRevision(workspaceId, flow, input.model, input.author, merged, hidden, opts);
  },

  /**
   * The contracts a revision's `code` steps were generated from, keyed by step
   * id. Empty for a revision with no `code` step, and for one whose fragments
   * were hand-written.
   *
   * This is what `regenerateStep` reads. A revision with a `code` step and no
   * contract can be run and approved but **not regenerated** — the honest
   * outcome, and a much better one than regenerating from a contract somebody
   * inferred from the code, which would silently redefine the standard the
   * fragment is judged against.
   */
  async contractsFor(flowId: string, revision: number): Promise<Record<string, StepContract>> {
    const out: Record<string, StepContract> = {};
    for (const row of await flowRepo.listSteps(flowId, revision)) {
      if (row.kind === "code" && row.contractJson) {
        out[row.stepId] = row.contractJson as StepContract;
      }
    }
    return out;
  },

  /**
   * Rename a flow, change its description, or set its chat config / design scope. **Metadata only.**
   *
   * Deliberately cannot touch `model.id`, the draft, the armed revision or the
   * status. A generated flow arrives named after the goal a person typed, and
   * fixing that name must not be an edit to what the flow DOES — an edit
   * invalidates an approval (§6.5), so a rename that wrote a revision would
   * unarm a live automation for a typo. `kestraFlowId` stays immutable for the
   * same reason `saveRevision` refuses to move it: it addresses both namespaces.
   */
  async updateMeta(
    workspaceId: string,
    flowId: string,
    patch: { name?: string; description?: string | null; chatConfig?: unknown; designSelection?: unknown },
  ) {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) throw httpError("flow not found", 404);
    const updated = await flowRepo.update(flow.id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      // META only: no revision, no arming change — same reason a rename is not
      // a revision (see the docblock above). NULL clears back to "nobody chose".
      ...(patch.chatConfig !== undefined ? { chatConfig: patch.chatConfig as never } : {}),
      ...(patch.designSelection !== undefined ? { designSelection: patch.designSelection as never } : {}),
    });
    return updated ?? flow;
  },

  /**
   * Store the flow's INCOMPLETE working copy — the legal-move engine's state with its holes (compiled-builder D-319).
   *
   * ⚠ Incomplete is allowed; INVALID is not. The state is re-judged here by the engine's own `checkState` against this
   * workspace's catalogue, and any `error` refuses the save — so storage cannot hold a state no legal move sequence could
   * reach, whoever the caller. A state with NO holes is refused too: it is complete, and a complete flow is a revision,
   * which has to pass `writeRevision`'s whole funnel. Writes no revision, deploys nothing, arms and disarms nothing.
   */
  async saveIncomplete(workspaceId: string, flowId: string, state: EFlow, build?: StoredIncomplete["build"]): Promise<IncompleteView> {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) throw httpError("flow not found", 404);
    if (!Array.isArray(state?.holes) || !Array.isArray(state?.steps)) throw httpError("a working copy is an engine state: `steps` and `holes`", 400);
    const diagnostics = checkState(state, await buildCatalogueSnapshot(workspaceId, state as unknown as FlowModel));
    const errors = errorsOf(diagnostics);
    if (errors.length) throw httpError(`this state is invalid, not merely incomplete: ${errors.map((d) => d.message).join(" · ")}`, 400);
    // I-299: a state with no holes is still undecided when the GOAL asks for something it does not do (no action, an unbuilt
    // condition) — the builder's `unmet`, recomputed from the stored spec whenever it is resumed, never replayed as done.
    if (!undecided(holesOf(diagnostics).length, build)) throw httpError("this state has nothing undecided — it is complete; write it as a revision", 400);
    const stored: StoredIncomplete = { basedOnRevision: flow.draftRevision, model: state, savedAt: new Date().toISOString(), ...(build ? { build } : {}) };
    await flowRepo.update(flow.id, { incompleteModel: stored as never });
    return { ...stored, stale: false, diagnostics };
  },

  /**
   * The working copy, re-judged NOW — the catalogue can have moved since it was saved (a reader removed, a column
   * retyped), so the stored verdict is never replayed. `stale` says a revision was written after it: the draft it was
   * based on is no longer the draft. `null` when there is none.
   */
  async getIncomplete(workspaceId: string, flowId: string): Promise<IncompleteView | null> {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) throw httpError("flow not found", 404);
    const stored = flow.incompleteModel as StoredIncomplete | null;
    if (!stored) return null;
    const diagnostics = checkState(stored.model, await buildCatalogueSnapshot(workspaceId, stored.model as unknown as FlowModel));
    return { ...stored, stale: stored.basedOnRevision !== flow.draftRevision, diagnostics };
  },

  /** Drop the working copy — after it was completed into a revision, or abandoned. Idempotent. */
  async clearIncomplete(workspaceId: string, flowId: string): Promise<void> {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) throw httpError("flow not found", 404);
    if (flow.incompleteModel != null) await flowRepo.update(flow.id, { incompleteModel: null });
  },

  async get(workspaceId: string, flowId: string) {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) return undefined;
    const [revisions, approvals, crons] = await Promise.all([
      flowRepo.listRevisions(flow.id),
      flowRepo.listApprovals(flow.id),
      // ⚠ The SAME computation the list uses, not a second one reading the
      // draft model that is already loaded a few lines up in the route. Two
      // definitions of "what fires this" would disagree exactly when a flow is
      // armed and its draft has moved — the case §6.5 exists for. D-197.
      flowRepo.firingCronsFor([flow]),
    ]);
    return { flow: { ...flow, schedule: crons.get(flow.id) ?? null }, revisions, approvals, understoodGoal: await understoodGoalOf(flow) };
  },

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * HIDE ONE REVISION FROM THE VERSION LIST — asked for as "delete"
   * ─────────────────────────────────────────────────────────────────────────
   *
   * ⚠ **It hides; it does not delete, and the difference is not cosmetic.**
   * `flow_revisions` is insert-only because an approval POINTS at a revision
   * (D-37) — that pointer is the whole of what stops approve-once being a blank
   * cheque, and it is what a reviewer reads to see what was signed off. A real
   * DELETE would also take the model a replay re-runs and the `from` side of
   * every diff above it. So `hidden_at` is set, `getRevision` stays unfiltered,
   * and only `listRevisions` filters.
   *
   * ⚠ **Two refusals, and neither is politeness.**
   *
   *   * **The DRAFT.** It is the working copy every edit lands on and the one
   *     `writeRevision` increments from. A flow whose newest revision is hidden
   *     would show a version list that does not contain the thing the builder
   *     is editing — the list and the editor disagreeing about what exists.
   *
   *   * **The LIVE one.** It is what the schedule fires. Hiding it would remove
   *     from the page the only row that says what is running in production,
   *     while it carried on running. `revoke` is the operation for stopping it,
   *     and the refusal says so rather than making the person guess.
   *
   * A revision that was approved and later superseded is hidable, and that is
   * deliberate: its approval row is untouched and still points at it, so the
   * audit trail survives the row leaving the list. That is exactly the property
   * the soft delete buys.
   */
  /**
   * ---------------------------------------------------------------------------
   * SAVE DRAFT - put the conversation's current version in the list
   * ---------------------------------------------------------------------------
   *
   * WARNING **Reported from use**: "in chat when we make a change it increments the
   * version for each change instead of session as a whole, also version should
   * not show up until user says save draft." Measured: one conversation, five
   * turns, SIX revisions - each a permanent row in the list a reviewer reads.
   *
   * A chat turn now writes its revision HIDDEN (see `writeRevision`), so the
   * conversation leaves the version list alone while it is happening. This is
   * what a person means by "save": the current draft joins the list.
   *
   * WARNING **It unhides ONE revision - the current draft - and leaves the rest
   * hidden.** That is the whole point: the intermediate steps of a conversation
   * are not versions anybody wants to read, and they are not deleted either.
   * `getRevision` stays unfiltered, so every one of them is still there for a
   * diff, a replay or an approval that points at it.
   *
   * WARNING **Saving twice is not an error.** A person who presses it again after no
   * further turns has asked for a state that already holds, and refusing would
   * be a refusal about bookkeeping rather than about the flow.
   */
  async saveDraft(workspaceId: string, flowId: string) {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) throw httpError("flow not found", 404);

    const row = await flowRepo.getRevision(flow.id, flow.draftRevision);
    if (!row) throw httpError(`revision ${flow.draftRevision} does not exist`, 404);

    // Already in the list. Idempotent, and says which.
    if (!row.hiddenAt) return { flow, revision: flow.draftRevision, alreadyVisible: true };

    await flowRepo.unhideRevision(flow.id, flow.draftRevision);
    return { flow, revision: flow.draftRevision, alreadyVisible: false };
  },

  async hideRevision(workspaceId: string, flowId: string, revision: number) {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) throw httpError("flow not found", 404);

    const row = await flowRepo.getRevision(flow.id, revision);
    if (!row) throw httpError(`revision ${revision} does not exist`, 404);
    if (row.hiddenAt) return { flow, revision, alreadyHidden: true };

    if (revision === flow.draftRevision) {
      throw httpError(
        `revision ${revision} is the current draft — it is what the builder edits and what the ` +
          "next version is written from, so it cannot be removed from the list.",
        409,
      );
    }
    if (revision === flow.armedRevision) {
      throw httpError(
        `revision ${revision} is live — it is what runs unattended right now. Stop using it first, ` +
          "then it can be removed from the list.",
        409,
      );
    }

    await flowRepo.hideRevision(flow.id, revision);
    return { flow, revision, alreadyHidden: false };
  },

  /**
   * ⚠ **`schedule` IS ADDED HERE, and it is not a column.** A flow's cron lives
   * on its model (D-18), so the `flows` row has nowhere to carry it — and the
   * list route spreads that row straight onto the wire. Six client surfaces
   * read `FlowSummary.schedule` and every one of them read `undefined`; see
   * `flowRepo.firingCronsFor` for what that cost and why the value is the armed
   * revision's rather than the draft's.
   */
  async list(workspaceId: string) {
    const rows = await flowRepo.listByWorkspace(workspaceId);
    const [approvals, crons] = await Promise.all([
      flowRepo.currentApprovalsFor(rows.map((r) => r.id)),
      flowRepo.firingCronsFor(rows),
    ]);
    const byFlow = new Map(approvals.map((a) => [a.flowId, a]));
    return rows.map((flow) => ({
      flow: { ...flow, schedule: crons.get(flow.id) ?? null },
      approval: byFlow.get(flow.id) ?? null,
    }));
  },

  /**
   * Start a manual test run against the DRAFT namespace (§6.5, stage 7).
   *
   * This is how gate 1 is satisfied: `enableReadiness()` needs one succeeded
   * execution before a flow may be armed, and the draft namespace is where that
   * run happens. It cannot start a live execution — the namespace is chosen
   * here, not by the caller.
   *
   * `opts.useProductionData` (default false) is the per-run production opt-in
   * (mock-data plan §4): the draft run reads production instead of mock. The
   * route gates this branch to admins; the service records the opt-in as an
   * `access`/`datasource` audit event and forwards it to `begin` as the
   * `foundry_use_prod` label, which `begin` persists onto the execution row.
   * The label is transport, the row is state: step callbacks resolve the
   * override from the row and never read the label.
   */
  async testRun(
    workspaceId: string,
    flowId: string,
    inputs: Record<string, string> = {},
    /**
     * Who asked — archive/GAPS.md §1.1b. Optional so the ~15 harness call sites keep
     * working; they get `system`, which is true of them. A route passes
     * `requesterOf(req)`.
     */
    requester: RunRequester = systemRequester("test-run"),
    opts: { useProductionData?: boolean } = {},
  ) {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) throw httpError("flow not found", 404);
    refuseFoundryRuntime(flow, "a test run through the compiled engine");
    if (flow.draftRevision < 1) throw httpError("flow has no revision to run", 409);
    // Phase 5 task 4 (D-255): a supplied value that does not fit its declared
    // type is refused HERE, naming the input — before a run request, an audit
    // row or an execution exists. The same rule trigger fire applies.
    {
      const rev = await flowRepo.getRevision(flow.id, flow.draftRevision);
      const declared = ((rev?.modelJson as { inputs?: DeclaredRunInput[] } | null)?.inputs ?? []);
      const issues = checkRunInputs(declared, inputs);
      if (issues.length) throw httpError(issues.map((i) => i.message).join(" · "), 400);
    }
    const { draft } = await this.namespaces(workspaceId);
    // BEFORE the execution starts, so the label can never name a row that does
    // not exist yet — see `runRequesterRepo.record`.
    const requestId = await runRequesterRepo.record(workspaceId, flow.id, requester);
    const useProdOverride = opts.useProductionData === true;
    if (useProdOverride) {
      // Every production read on a draft run is an audited access, recorded
      // where the person is known. The step callbacks that follow carry an
      // execution token, not an identity, so recording it there is impossible
      // and recording it here is the only chance.
      await auditService.record({
        workspaceId,
        actor: requester.actor,
        operation: "access",
        entity: "datasource",
        description:
          `Production-data test run of flow "${flow.name}" (revision ${flow.draftRevision}): ` +
          `draft steps read production instead of mock data.`,
        whereText: `Flows · ${flow.name}`,
        whereEntityType: "flow",
        whereEntityId: flow.id,
        raw: { flowId: flow.id, revision: flow.draftRevision, runRequestId: requestId, useProductionData: true },
      });
    }
    try {
      const execution = await kestra.startExecution(draft, flow.kestraFlowId, inputs, {
        foundry_flow: flow.id,
        foundry_revision: String(flow.draftRevision),
        foundry_env: "draft",
        // ⚠ A POINTER, never the person. A label lives in Kestra's database and
        // renders in `kestra-ui`, which has no tenant isolation.
        foundry_run_request: requestId,
        // Transport for the opt-in, not state: `begin` verifies this against
        // Kestra's authoritative record and persists it onto the execution
        // row, which is what the step callbacks read. Absent when false, so
        // ordinary runs carry no new label at all.
        ...(useProdOverride ? { foundry_use_prod: "1" } : {}),
      });
      return {
        kestraExecutionId: execution.id,
        namespace: draft.value,
        revision: flow.draftRevision,
        usedProductionData: useProdOverride,
      };
    } catch (e) {
      if (e instanceof KestraError) {
        // ⚠ The engine's own sentence, not just the status. Kestra answers a
        // missing input with `422 {"message":"Invalid entity: Missing required
        // input:period"}` — which names the fix — and this used to discard the
        // body and report `Kestra POST executions → 422`. The caller then had a
        // number, an engine nobody outside can reach, and no way to learn which
        // input was missing.
        const detail =
          (e.body as { message?: string } | null)?.message ?? JSON.stringify(e.body ?? e.message);
        // 422 here is the CALLER's fault, not the engine's: the run was refused
        // because the inputs supplied do not satisfy what the flow declares. A
        // 502 would say "the engine is broken", send a client looking at
        // infrastructure, and hide a form field somebody has to fill in.
        throw httpError(`Kestra refused the run: ${detail}`, e.status === 422 ? 400 : 502);
      }
      throw e;
    }
  },

  /** Gate 1 for a flow (§6.5) — has any revision of it ever completed a run? */
  async hasSucceededRun(flowId: string): Promise<boolean> {
    return flowExecutionRepo.hasSucceeded(flowId);
  },

  /**
   * Phase 6 — materialize the webhook/api triggers a model DECLARES.
   *
   * ⚠ **APPROVAL-ONLY, and `flowApprovalService.approve` is the only caller.**
   * Never call this from the draft path: a draft that carried its trigger would
   * be a trigger row pointing at behaviour nobody approved — the same reason
   * `writeRevision` compiles drafts without the schedule. The declaration is
   * part of the model an approver reviews; the row is the deployment of it,
   * the Foundry-side sibling of the Schedule trigger approval deploys into
   * Kestra.
   *
   * Idempotent create-or-resolve by NAME within the workspace:
   *   - no row with that name → create one, `enabled: true`. Approval is the
   *     arm act and both gates have just passed in `approve` (gate 1: the
   *     flow has succeeded once; gate 2: this very approval), so a row that
   *     came out disabled would silently kill the LLM-created trigger the
   *     model just promised — its receiver answers 404 on a disabled trigger,
   *     exactly like the webhook's.
   *   - same name + same type + same flow → reuse. A re-approval of the same
   *     declaration must not duplicate the row.
   *   - same name, anything else → 409 naming the conflict. A trigger name is
   *     a workspace identifier (the credential seam resolves by it), so a
   *     declaration that collides with a different type — or with another
   *     flow's trigger of any type — cannot be satisfied by a second row.
   *
   * `schedule` is NEVER materialized here: a cron lives on the model and is
   * deployed by compiling with `withSchedule` (D-18); a `schedule` row would
   * be a second, unapproved way to fire on a timer.
   */
  async materializeDeclaredTriggers(workspaceId: string, flow: Flow, model: FlowModel): Promise<Trigger[]> {
    // ⚠ `webhook` is retired (2026-09-08) and is no longer read here. It is also
    // no longer accepted by `flowModelSchema`, so a stored model carrying one
    // has already lost it — this loop could not see it either way.
    const declared = model as unknown as { api?: { name?: string } };
    const names: Array<{ type: "api"; name: string }> = [];
    if (declared.api?.name) names.push({ type: "api", name: declared.api.name });
    if (!names.length) return [];

    const materialized: Trigger[] = [];
    for (const d of names) {
      if (d.name.length > 255) {
        throw httpError(
          `declared "${d.type}" trigger name "${d.name}" is too long (max 255 characters)`,
          400,
        );
      }
      const existing = await triggerRepo.getByName(workspaceId, d.name);
      if (existing) {
        if (existing.type !== d.type) {
          throw httpError(
            `cannot materialize the declared "${d.type}" trigger "${d.name}": a ` +
              `"${existing.type}" trigger with that name already exists in this workspace`,
            409,
          );
        }
        // A null `flowId` is a legacy row bound to nothing (the only
        // constructor left, `createForFlow`, always binds); adopting it beats
        // duplicating the name the credential seam resolves by.
        if (existing.flowId != null && existing.flowId !== flow.id) {
          throw httpError(
            `cannot materialize the declared "${d.type}" trigger "${d.name}": that name ` +
              `already belongs to another flow's trigger in this workspace`,
            409,
          );
        }
        materialized.push(existing);
        continue;
      }
      materialized.push(
        await triggerRepo.create({
          workspaceId,
          flowId: flow.id,
          name: d.name,
          type: d.type,
          // Empty inputs: the plan's `defaults` are authoritative (D-107) and
          // `declaredFrom` records where the row came from, the same
          // provenance convention `draftForFlow` uses.
          config: { inputs: {}, declaredFrom: "model" },
          enabled: true,
          webhookToken: crypto.randomBytes(18).toString("hex"),
        }),
      );
    }
    return materialized;
  },

  /**
   * Copy a flow's draft model into a new draft flow — new id, new engine id,
   * name suffixed " (copy)". Approvals, triggers and armed state are NOT
   * copied: the duplicate starts as an unarmed draft the person can edit.
   */
  async duplicate(workspaceId: string, flowId: string, author: RevisionAuthor) {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) throw httpError("flow not found", 404);
    if (flow.draftRevision < 1) {
      throw httpError("flow has no revision to copy", 409);
    }
    const row = await flowRepo.getRevision(flow.id, flow.draftRevision);
    if (!row) throw httpError("flow has no revision to copy", 404);
    const baseName = `${flow.name} (copy)`;
    // A Forge workflow copies its bundle — workflow.json and the step files — through the save every Forge revision
    // passes (its read checks included). It is never read as a compiled model.
    if (isPiModel(row.modelJson)) {
      const saved = await piFlowService.save({
        workspaceId,
        flowId: null,
        bundle: { workflow: row.modelJson.workflow, files: row.modelJson.files },
        name: baseName,
        description: flow.description ?? null,
        author,
      });
      return { flow: (await flowRepo.get(workspaceId, saved.flowId))!, revision: saved.revision };
    }
    const model = normaliseModel(row.modelJson) as unknown as FlowModel;
    const contracts = await this.contractsFor(flow.id, flow.draftRevision);
    // No `build`/goalSpec: `specMatch` would re-judge the copy against a confirmed
    // spec and can refuse a byte-identical model (import path has the same bound).
    return this.create(
      workspaceId,
      {
        name: baseName,
        description: flow.description ?? undefined,
        model,
        author,
      },
      contracts,
      flow.designSelection ?? null,
      false,
      { freshEngineId: true, origin: "import" },
    );
  },

  /**
   * Delete a flow, and its deployments with it.
   *
   * Kestra first, Foundry second, and deliberately so: the reverse order can
   * leave a flow deployed with a live Schedule trigger and no Foundry row behind
   * it — an automation that fires unattended and that nothing in the product can
   * see, approve or revoke.
   */
  /**
   * Delete a flow — and say so in the audit trail (2026-10-10). A flow used to vanish with no record of who removed it
   * or what it was (flow e2cbacc1, pi-runtime P4): the row, its revisions and its conversation go with it. The record is
   * written FIRST, from the flow as it stands, so a delete that then fails leaves a record of the attempt rather than
   * a gap. `by` is the person (the route passes the signed-in identity); harnesses and seeds are `system`, and say so.
   */
  async remove(workspaceId: string, flowId: string, by = "system") {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) return false;
    await auditService.record({
      workspaceId,
      actor: by,
      operation: "delete",
      entity: "flow",
      entityId: flow.id,
      description:
        `Deleted workflow "${flow.name}" — ${flow.runtime === "foundry" ? "built with Forge" : "compiled"}, ` +
        `draft revision ${flow.draftRevision}, ${flow.armedRevision != null ? `armed revision ${flow.armedRevision}` : "never armed"}.`,
      whereText: `Flows · ${flow.name}`,
      whereEntityType: "flow",
      whereEntityId: flow.id,
      raw: {
        flowId: flow.id,
        name: flow.name,
        runtime: flow.runtime,
        status: flow.status,
        draftRevision: flow.draftRevision,
        // Named `armedAtDelete`, not after the column: flow-armed-pin counts the column's key in this file to prove the
        // approval path is its only writer, and a record of what it WAS must not read as a write.
        armedAtDelete: flow.armedRevision,
        createdAt: flow.createdAt,
      },
    });
    const { live, draft } = await this.namespaces(workspaceId);
    // A Pi-built flow was never deployed to Kestra (pi-runtime P3) — there is nothing there to remove.
    for (const ns of flow.runtime === "foundry" ? [] : [live, draft]) {
      try {
        await kestra.deleteFlow(ns, flow.kestraFlowId);
      } catch (e) {
        if (e instanceof KestraError && e.status === 404) continue;
        throw httpError(
          `refusing to delete: the flow could not be removed from ${ns.value} (${(e as Error).message})`,
          502,
        );
      }
    }
    // Undecided gates die with the flow: their executions can never be resumed
    // (engine deployments removed above), so leaving them pending would strand
    // permanent residents in the approvals inbox. Rows stay as expired history.
    await stepApprovalService.expireForFlow(flowId, `flow "${flow.name}" was deleted`);
    return flowRepo.remove(workspaceId, flowId);
  },
};

/** A flow's stored incomplete working copy (D-319), and the view of it: re-judged against the catalogue as it is now. */
/** `build`: the GoalSpec the person confirmed and the trace so far (D-304) — present when the new builder wrote it. */
/**
 * The goal the builder has understood for a flow, as it stands now: an unfinished build's conversation goal (it changes as the person
 * replies — restated, typos read as meant), else the goal its draft revision was built from. `null` when neither has one (a flow made
 * on the canvas, or before the builder stored goals). `building`: the goal belongs to a build still in progress.
 */
export async function understoodGoalOf(flow: { id: string; draftRevision: number; incompleteModel?: unknown }): Promise<{ text: string; building: boolean } | null> {
  type GS = { goal?: string; conversation?: { goal?: string } };
  const inc = (flow.incompleteModel as StoredIncomplete | null)?.build?.goalSpec as GS | undefined;
  const building = inc?.conversation?.goal ?? inc?.goal;
  if (building?.trim()) return { text: building.trim(), building: true };
  const rev = flow.draftRevision > 0 ? await flowRepo.getRevision(flow.id, flow.draftRevision) : undefined;
  const saved = (rev?.goalSpec as GS | null | undefined)?.goal;
  return saved?.trim() ? { text: saved.trim(), building: false } : null;
}

export interface StoredIncomplete { basedOnRevision: number; model: EFlow; savedAt: string; build?: { goalSpec: unknown; trace: unknown } }
export interface IncompleteView extends StoredIncomplete { stale: boolean; diagnostics: Diagnostic[] }

/** What `gateRevisionModel` reads: the catalogue, the ref list and interfaces, the models a step may name, and how to compile. */
export interface RevisionGateInputs {
  catalogue: (model: FlowModel) => Promise<CatalogueSnapshot>;
  refNames: string[];
  interfaces: Record<string, RefInterface>;
  allowedModels: Awaited<ReturnType<typeof resolveGenerationProvider>>["allowedModels"];
  contracts: Record<string, StepContract>;
  origin?: RevisionOrigin;
  previous?: FlowModel;
  compile: Parameters<typeof flowCompiler.compile>[1];
  /** The workspace's datasources' engine types, by name — a step's SQL is parsed on its own engine (`sqlParses`). Absent: not checked. */
  datasourceTypes?: Record<string, string>;
}

/**
 * EVERY check a revision must pass before it is persisted, and the compile — `writeRevision`'s pure half, extracted unchanged
 * (compiled-builder D-318). `writeRevision` is its one production caller; the legal-move property test is the other, so
 * "every state the engine reaches is accepted" is a claim about THIS funnel, never about a copy of it (D-249). Throws the
 * same 400s it always did; returns the model as it will be stored (normalised, pipelines lowered, input types derived) and
 * the compiled flow. Kestra's own acceptance (`assertKestraAccepts`) stays in `writeRevision`: it needs the engine.
 */
export async function gateRevisionModel(model: FlowModel, g: RevisionGateInputs): Promise<{ model: FlowModel; compiled: ReturnType<typeof flowCompiler.compile> }> {
  // ── A revision is COMPLETE (compiled-builder D-319) ──────────────────────
  //
  // First, before anything reads the model: a hole's site is deliberately empty (D-317), so every check below would refuse
  // it anyway — but by the site's symptom ("step r needs a ref"), never by its cause. An incomplete flow lives in the flow's
  // working copy (`saveIncomplete`), which no approval, run, replay or trigger can name; that is what makes "cannot be
  // approved or run" structural rather than a check each consumer of a revision must remember. `holes: []` is the engine's
  // complete state and is dropped, so a stored revision carries no hole-shaped key at all.
  const holes = (model as { holes?: Array<{ id?: unknown; reason?: unknown }> }).holes;
  if (Array.isArray(holes) && holes.length) {
    throw httpError(`this flow is incomplete — ${holes.length} undecided: ${holes.map((h) => `\`${String(h.id)}\` (${String(h.reason)})`).join(" · ")}. Save it as a working copy; a revision must be complete.`, 400);
  }
  if (holes !== undefined) { const { holes: _drop, ...rest } = model as FlowModel & { holes?: unknown }; model = rest as FlowModel; }
    // The single write funnel: every revision upgrades here, before validation,
  // so everything downstream (expression checks, caps, `assertValid`,
  // compile, deploy) judges the v2 it will store. Never throws: converted
  // steps arrive with typed fields, unreadable ones keep the display with
  // null bindings, and validation downstream refuses by name as before.
  model = normaliseModel(model) as unknown as FlowModel;
  // ── A DB-operation read is a `query` step (I-297) ─────────────────────────
  // The engine models every reader as `datasource`; stored as that, an operation is resolved as a named query and 404s at run
  // time. Mapped here, the one funnel, so no origin can store it the wrong way. Only when some reader could be one: no cost otherwise.
  if (model.steps.some((s) => s.kind === "datasource")) model = storedReaderKinds(model as never, await g.catalogue(model)) as unknown as FlowModel;
  // ── Combinator pipelines → `expr` (compiled-builder 2d) ─────────────────
  //
  // First, so every check below (D-22, caps, assertValid, the type checker, compile) judges the lowered expression.
  // An ill-typed pipeline is refused by stage and never lowered. Only built when a pipeline exists: no cost otherwise.
  if (model.steps.some((s) => s.kind === "transform" && Array.isArray((s as { pipeline?: unknown }).pipeline))) {
    try {
      model = lowerPipelinesWith(model, await g.catalogue(model));
    } catch (e) {
      if (e instanceof PipelineError) throw httpError(e.message, 400);
      throw e;
    }
  }

  // ── D-22. Every revision, whoever authored it ────────────────────────────
  //
  // `paramsExpr`, `inputExpr`, `expr` and `promptExpr` are emitted into the
  // YAML verbatim, and D-16 says that is safe "only while models are
  // Foundry-authored". Neither caller of this function satisfies that any
  // more: a drafting model authors them now, and `POST /flows` has always
  // accepted them from a client. There is one shared `PARENT_API_KEY` and no
  // user model (I-13), so "client" means the tenant.
  //
  // The concrete exposure is one line long: Kestra's secret store holds the
  // callback secret, `{{ secret('FOUNDRY_CALLBACK') }}` reads it, and a
  // `paramsExpr` posts its params to a tool endpoint the tenant controls. A
  // draft run is enough — the draft namespace is deliberately exempt from the
  // approval gate, because a draft run is how gate 1 gets satisfied at all.
  //
  // So the check sits HERE, at the one function every revision passes
  // through, rather than on the routes. A new route cannot forget it.
  // Typed rows (property-rows project) are checked as the displays they
  // replace — see `stepsWithRowTemplates`. One copy for all three checks.
  const checkedSteps = stepsWithRowTemplates(model.steps);
  const exprFindings = validateModelExpressions(checkedSteps);
  if (exprFindings.length) {
    throw httpError(exprFindings.map((f) => f.message).join(" · "), 400);
  }

  /**
   * -------------------------------------------------------------------------
   * WARNING AN EXPRESSION MAY ONLY READ AN INPUT THIS MODEL DECLARES
   * -------------------------------------------------------------------------
   *
   * It sits HERE, beside D-22, for the reason the comment above already
   * gives: this is the one function every revision passes through, so a new
   * route cannot forget it.
   *
   * WARNING **And that was learned the hard way, ten minutes after writing the
   * check.** It went into `pureModelFindings` first - which `authorFlow`,
   * `refine` and chat all run - and that looked like enough. Then the wire
   * test: `POST /flows/:id/revisions` with the exact model that had died in
   * production was **accepted**, because `saveRevision` goes through
   * `writeRevision` and `writeRevision` does not run `pureModelFindings`.
   * The canvas saves through that route. So did the flow that failed.
   *
   * It stays in `pureModelFindings` as well, and the duplication is
   * deliberate: there the finding is fed BACK to a model as a redraft
   * instruction and costs one attempt; here it is a refusal to persist. Same
   * function, two jobs, and dropping either loses one of them.
   */
  const inputFindings = checkDeclaredInputs(
    checkedSteps,
    (model.inputs ?? []).map((i) => i.id),
    EXPRESSION_FIELDS,
  );
  if (inputFindings.length) {
    throw httpError(inputFindings.join(" · "), 400);
  }

  /**
   * Its twin, and found by running the flow the check above had just
   * unblocked: an expression reading `outputs.<step>` for a step that is not
   * in this model. A chat turn removed a transform and left the step reading
   * it. `dependsOn` had been rewired; the EXPRESSION had not, and only one of
   * those two references was ever checked.
   */
  const stepRefFindings = checkStepRefs(checkedSteps, EXPRESSION_FIELDS);
  if (stepRefFindings.length) {
    throw httpError(stepRefFindings.join(" · "), 400);
  }

  // ── The caps and the ref check, same chokepoint, same reason ─────────────
  //
  // Phase 5 task 5.2, built in Stage 7 because that is when `POST
  // /flows/generate` became reachable from a browser. Fingerprints are
  // computed HERE rather than after the compile, because their keys are also
  // the workspace's callable ref list and `checkFlowRefs` needs them — one
  // query, one answer, so the check and the staleness baseline it writes below
  // cannot disagree about what exists.
  //
  // `refInterfaces` is the second half and answers the question the ref list
  // cannot: not "does this ref exist?" but "is it being CALLED correctly?".
  // A `foundry_email_send` step carrying an undeclared `author` key compiled,
  // deployed and ran, and died at the last hop on the route's `.strict()`
  // body schema — after reading production data. `checkFlowParams` is that
  // refusal moved to the one place it costs nothing.
  //
  // ⚠ Interfaces, NOT fingerprints (D-25): a fingerprint is a hash and knows
  // no parameter names. Fetched in parallel with the fingerprints so the
  // check does not add a round trip to every save.
  const { interfaces, contracts } = g;
  // ── D-272 for every builder (phase 7, found by the regression net) ─────────
  //
  // A STRING input takes the type its consumers all declare — `override: false`,
  // the rule `deriveInputTypes` states for a type somebody chose: only STRING is
  // widened, and only when every consumer agrees and its default parses. It had
  // one call site, the drafter's (`override: true`), so a hand-authored flow — the
  // seeds, an import, any flow stored before phase 2 — was refused here (FT0202
  // "flow input `as_of` is Text, but `as_of` needs Date") for a declaration the
  // checker is right about and nothing else would ever correct. Before the
  // checks, so every check below judges, and the revision stores, the model
  // with the derived type.
  model = deriveInputTypes(model, interfaces, contracts, { override: false }).model;
  // ── Input-to-feeder compatibility, same chokepoint, same reason ──────────
  //
  // A DATE passed raw to a month-format parameter compiles, deploys and dies
  // at runtime, and neither D-22 nor the declared-input check above sees
  // kind-vs-format at all. `interfaces` carries each parameter's `format`
  // when the catalogue declares one; absent means unconstrained prose and
  // never blocks, so this is silent until the annotation lands. Same refusal
  // vocabulary as the checks above: one sentence per reader, joined by ` · `.
  const feederFindings = checkFeederCompatibility(model, interfaces);
  if (feederFindings.length) {
    throw httpError(feederFindings.join(" · "), 400);
  }
  // Wave 1 (Stage 4.1): the deployment's configured models, for the `llm`
  // save refusal. Read per save through the provider's 10s cache, so Save
  // reflects the AI-model page without a restart.
  flowValidator.assertValid(model, g.refNames, interfaces, g.allowedModels);
  // A step's SQL must PARSE on the engine that runs it (2026-10-02, FL02: a read compiled, was saved, and its first run died with
  // "syntax error at or near $"). Every revision passes here, whoever wrote it — the builder, the canvas, an import.
  if (g.datasourceTypes) {
    for (const st of model.steps ?? []) {
      const sql = "sql" in st ? (st as { sql?: string }).sql?.trim() : undefined;
      const ds = "datasourceRef" in st ? (st as { datasourceRef?: string }).datasourceRef : undefined;
      const type = ds ? g.datasourceTypes[ds] : undefined;
      if (!sql || !type) continue;
      const bad = await syntaxProblem(sql, type);
      if (bad) throw httpError(`step "${st.id}" reads with SQL its datasource's engine cannot parse: ${bad}`, 400);
    }
  }

  // ── The type checker gates every builder (phased-typed-build phase 2, D-239) ─
  //
  // Every error refuses; this is the one call site, so the drafter, chat, the
  // canvas, import, templates and seeds are all covered by construction. The
  // structured `diagnostics` travel on the 400 so a builder can route them.
  const typeFindings = blockingOf(model, await g.catalogue(model));
  if (typeFindings.length) {
    const e = httpError(typeFindings.map(diagnosticLine).join(" · "), 400) as Error & { diagnostics?: unknown };
    e.diagnostics = typeFindings;
    throw e;
  }

  // ── Gradual typing for legacy (phase 2 task 2, D-242) ────────────────────
  //
  // FT0602 is a WARNING — a hand-written template the checker cannot see
  // into — and stays one for a person's save and for legacy. What a MODEL may
  // not do is add one: the drafter and chat can bind inputs typed, so a new
  // unsafe block from them is a regression the warning would let through for
  // ever. Judged against the flow's PREVIOUS revision, so a legacy step a chat
  // turn merely carries forward is still allowed. Same 400 shape as above.
  //
  // ⚠ Not a second `blockingOf` call: this is a DIFF between two
  // models, and the one gate above stays the one gate (task 5).
  if (g.origin && MODEL_ORIGINS.has(g.origin)) {
    const introduced = introducedUnsafeSteps(model, g.previous);
    if (introduced.length) {
      const e = httpError(introduced.map(diagnosticLine).join(" · "), 400) as Error & { diagnostics?: unknown };
      e.diagnostics = introduced;
      throw e;
    }
  }

  let compiled;
  try {
    compiled = flowCompiler.compile(model, g.compile);
  } catch (e) {
    rethrowCompile(e);
  }
  return { model, compiled: compiled! };
}
