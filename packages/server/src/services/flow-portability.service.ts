import { z } from "zod";
import { flowRepo, type Flow } from "../repositories/flow.repo.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { workspaceSecretRepo } from "../repositories/workspace-secret.repo.js";
import { manifestBuilderService, type RefInterface } from "./manifest-builder.service.js";
import { flowService } from "./flow.service.js";
import { stepContractSchema, type StepContract } from "./step-contract.service.js";
import { validateModelExpressions } from "./flow-expression.service.js";
import { expectationSchema, MAX_EXPECTATIONS } from "./flow-expectation.service.js";
import { inference, type InferenceClient } from "./inference.service.js";
import {
  generateFragments,
  UNGENERATED,
  type FragmentOutcome,
} from "./flow-generation.service.js";
import { normaliseModel } from "@foundry/flow-edit";
import {
  displayCodeInput,
  displayCondition,
  displayContext,
  displayParams,
  displaySummary,
  displayTransform,
  validateModel,
  FlowCompileError,
  type FlowModel,
  type FlowStep,
} from "./flow-compiler.service.js";
import type { RevisionAuthor } from "./revision-author.js";

/**
 * Flow **export and import** — sharing a flow between workspaces and tenants.
 * archive/kestra-migration/04-generation-model.md §5.2 · 08 §10 "Phase 6" · phase-6.md 6.2/6.3
 *
 * ── A shared flow is a RECIPE, not a binary ──────────────────────────────────
 *
 * The bundle is Foundry's MODEL. It never contains Kestra YAML — not as a
 * convenience but because R8 says the compiler is the sole emitter, and an export
 * format carrying YAML would make the engine unswappable through the back door.
 * `flowBundleSchema` has no field a YAML string could enter, and a test asserts
 * the serialised bundle contains no `io.kestra` task type.
 *
 * What travels, and what does not (§5.2):
 *
 *   step declarations, inputs, dependencies, expressions   YES
 *   tool / datasource / operation refs, BY NAME            YES — revalidated on import
 *   `code` step CONTRACTS                                  YES — see below
 *   secret references                                       NAMES only, never values
 *   generated fragment code                                 NO — stripped
 *   execution history, step runs, approvals, armed state     NO
 *
 * ── The contract travels; the code does not (D-24) ───────────────────────────
 *
 * §5.2 says generated code is stripped and a `code` step imports as
 * `needs_regeneration`. It does not say what replaces it, and the answer matters:
 * a step with no contract **cannot be regenerated at all** — `regenerateStep`
 * refuses it (`no_contract`, 409) precisely so nobody invents the standard a
 * fragment is judged against. Strip the code and drop the contract and the import
 * is not a recipe, it is a flow that can never be cooked.
 *
 * So the contract is the portable artefact and the code is the local build of it.
 * That inverts which half looks important, and it is the right way round: the
 * contract is what a human reviews and approves, and the code is derivable from
 * it for one inference call.
 *
 * ── Why stripping is still correct, for a different reason than §5.2 gives ────
 *
 * §5.2's stated rationale is *"a fragment generated against one schema is wrong
 * against the other"*. After Phase 4 that premise is **false as written**: a
 * fragment never sees a schema. `buildFragmentPrompt` is the contract and nothing
 * else — no manifest, no goal, no sibling (assertion 18) — so a fragment cannot
 * be "generated against" `hr_demo` any more than against `hr_demo_alt`.
 *
 * The conclusion survives, and lands somewhere more useful. Schema coupling did
 * not disappear in Phase 4; it MOVED, out of the fragment and into two places
 * that are tenant-local by construction:
 *
 *   the named QUERY   — reviewed SQL, per tenant. This is where `presence_rate`
 *                       becoming a 0–1 fraction is supposed to be absorbed.
 *   the CONTRACT      — authored by a drafter that did see the manifest, so its
 *                       field descriptions carry units the fragment then obeys.
 *
 * Which yields the honest statement of what an import can and cannot promise, and
 * both halves are load-bearing:
 *
 *   CAN   every ref exists in the importing tenant, and its call signature
 *         matches what the flow sends. Mechanical and complete.
 *   CANNOT tell whether the importing tenant's query returns the same COLUMNS in
 *         the same UNITS. A query matching signatures and returning rates as
 *         0–1 where the origin returned 0–100 imports clean and computes a
 *         confidently wrong answer.
 *
 * The second is measured rather than hand-waved: `kestra:phase6` imports the
 * screening flow into the rehearsal tenant twice, once against a query that
 * leaves rates as fractions and once against one that normalises them, and only
 * the second scores the alt oracle. **Import is a structural check, not a
 * correctness check.** Only the importing tenant's oracle is the latter.
 */

export const BUNDLE_FORMAT = 1;

// ── The bundle ───────────────────────────────────────────────────────────────

/**
 * A ref as the EXPORTING tenant saw it: its name and its call signature at the
 * moment of export. `signature` is for the message; `params` is what the
 * comparison runs on (see `manifestBuilderService.refInterfaces`).
 *
 * `kind` mirrors the manifest's three ref kinds: `tool` (tools), `query`
 * (named queries) and `operation` (DB operations — compiled read-only SELECTs).
 * An operation ref travels structurally, exactly like a query: the importing
 * tenant revalidates that `<datasource>.<operation>` exists there, and nothing
 * needs regenerating (operations are not code).
 */
const bundledRefSchema = z.object({
  ref: z.string().min(1).max(128),
  kind: z.enum(["tool", "query", "operation"]),
  signature: z.string().max(2000),
  params: z
    .array(z.object({ name: z.string().max(63), type: z.string().max(32), required: z.boolean() }))
    .max(64),
});

/**
 * Bundle-side step schemas.
 *
 * These are ALLOWLISTS of the fields that travel, per kind, and that direction is
 * deliberate. Deleting `code` from a step object is a deny-list: the next field
 * added to `CodeStep` would travel by default, and the first time that mattered
 * would be the first time something sensitive was added. Here a new field does
 * not travel until someone writes it down.
 */
/**
 * Retry travels. It describes how the recipe behaves, not what any tenant's data
 * looks like: "this call may be re-attempted twice" is as true in the importing
 * workspace as it was in the exporting one, and dropping it would silently make
 * an imported flow LESS resilient than the one it was copied from — a difference
 * nobody would notice until the first transient failure in production.
 *
 * Nothing sensitive can ride along: four numbers and an enum, all range-bounded
 * here and again by the compiler.
 */
const bundledRetrySchema = z.object({
  maxAttempts: z.number().int().min(2).max(5),
  backoff: z.enum(["constant", "exponential"]).optional(),
  intervalSeconds: z.number().int().min(1).max(300).optional(),
  maxDurationSeconds: z.number().int().min(10).max(3600).optional(),
});

const bundledStepSchema = z.discriminatedUnion("kind", [
  /**
   * The three calling kinds share one shape — a ref plus the expression that
   * produces its params — so a `query` step travels exactly as a `tool` or
   * `datasource` step does. The ref is revalidated on import; the params
   * expression travels because it is the recipe's own text.
   */
  z.object({
    kind: z.enum(["tool", "datasource", "query"]),
    id: z.string().min(1).max(63),
    name: z.string().max(120).optional(),
    description: z.string().max(2000).optional(),
    ref: z.string().min(1).max(128),
    paramsExpr: z.string().min(1).max(8000),
    dependsOn: z.array(z.string().max(63)).max(32).optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    retry: bundledRetrySchema.optional(),
  }),
  z.object({
    kind: z.literal("transform"),
    id: z.string().min(1).max(63),
    name: z.string().max(120).optional(),
    description: z.string().max(2000).optional(),
    expr: z.string().min(1).max(8000),
    fields: z.array(z.string().min(1).max(128)).max(64).optional(),
    dependsOn: z.array(z.string().max(63)).max(32).optional(),
  }),
  z.object({
    kind: z.literal("code"),
    id: z.string().min(1).max(63),
    name: z.string().max(120).optional(),
    description: z.string().max(2000).optional(),
    inputExpr: z.string().min(1).max(8000),
    /**
     * Note what is absent: `code`, and also `outputKeys`. The keys are DERIVED
     * from the contract at import for the same reason the drafter is not allowed
     * to send them (see `flow-generation.service.ts`) — carrying both lets a
     * bundle declare one contract and enforce another, and the mismatch then
     * surfaces as a `contract_violation` blaming the freshly generated fragment
     * for obeying the contract it was handed.
     */
    contract: stepContractSchema.omit({ stepId: true }),
    dependsOn: z.array(z.string().max(63)).max(32).optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    retry: bundledRetrySchema.optional(),
  }),
  z.object({
    kind: z.literal("approval"),
    id: z.string().min(1).max(63),
    name: z.string().max(120).optional(),
    description: z.string().max(2000).optional(),
    summaryExpr: z.string().min(1).max(4000),
    contextExpr: z.string().min(1).max(8000).optional(),
    dependsOn: z.array(z.string().max(63)).max(32).optional(),
    awaitSeconds: z.number().int().min(60).max(604_800).optional(),
  }),
  /**
   * A conditional guard — foundations Phase 3.
   *
   * ⚠ **Added in the SAME commit as the kind**, because D-24 is explicit about
   * what happens otherwise: `bundleStep` is an allowlist per kind, so a kind with
   * no arm here exports as **nothing** and the import is silently a different
   * flow — one whose guard has vanished and whose guarded steps now always run.
   */
  z.object({
    kind: z.literal("branch"),
    id: z.string().min(1).max(63),
    name: z.string().max(120).optional(),
    description: z.string().max(2000).optional(),
    /** Absent only on an `else` — see `BranchStep`. `validateModel` refuses a
     *  conditionless branch that is not one, so an import cannot smuggle a
     *  guard that tests nothing. */
    conditionExpr: z.string().min(1).max(8000).optional(),
    /** The branch this one continues. Local to the flow, exactly as `dependsOn`
     *  is — a bundle that dropped it would import an if/elif chain as unrelated
     *  guards that ALL run, which is a different flow that still compiles. */
    elseOf: z.string().min(1).max(63).optional(),
    dependsOn: z.array(z.string().max(63)).max(32).optional(),
  }),
  /**
   * A merge — the shared tail after a branch. See `MergeStep` in the compiler.
   *
   * ⚠ **`sources` is the whole step, and dropping it would be the exact failure
   * the docblock above warns about, one kind over.** A merge with no sources is
   * not a degraded merge, it is a step that coalesces nothing — and because
   * `armOf` stops at a merge regardless, the import would produce a flow whose
   * tail runs unconditionally reading a value that is always the `"null"`
   * fallback. That compiles, deploys, and is a different flow.
   *
   * The ids inside are local to the flow, exactly as `dependsOn` and `elseOf`
   * are, so they travel verbatim and `refInterfaces()` has nothing to say about
   * them — it checks refs, which name a tenant's capabilities. `validateModel`
   * re-checks on import that every source exists and is a kind that produces a
   * JSON result, so a bundle cannot smuggle a merge over a step that has no
   * output.
   */
  z.object({
    kind: z.literal("merge"),
    id: z.string().min(1).max(63),
    name: z.string().max(120).optional(),
    description: z.string().max(2000).optional(),
    sources: z.array(z.string().min(1).max(63)).min(2).max(32),
    dependsOn: z.array(z.string().max(63)).max(32).optional(),
  }),
]);

export const flowBundleSchema = z.object({
  formatVersion: z.literal(BUNDLE_FORMAT),
  /**
   * Provenance, for a human deciding whether to trust the thing. Recorded, never
   * acted on: nothing in `importFlow` branches on where a bundle came from, so a
   * hand-written bundle and an exported one take identical paths.
   */
  source: z.object({
    workspaceName: z.string().max(255).optional(),
    flowName: z.string().max(255),
    kestraFlowId: z.string().max(255),
    revision: z.number().int().min(0),
    manifestVersion: z.number().int().min(0).optional(),
    exportedAt: z.string().max(64).optional(),
  }),
  flow: z.object({
    name: z.string().min(1).max(255),
    description: z.string().max(2000).optional(),
  }),
  /** The model, minus every `code` body. Reassembled into a `FlowModel` on import. */
  model: z.object({
    id: z.string().min(1).max(63),
    name: z.string().max(120).optional(),
    description: z.string().max(2000).optional(),
    inputs: z
      .array(
        z.object({
          id: z.string().min(1).max(63),
          type: z.enum(["STRING", "INT", "FLOAT", "BOOLEAN", "DATE", "DATETIME"]),
          defaults: z.string().max(512).optional(),
          required: z.boolean().optional(),
        }),
      )
      .max(32)
      .optional(),
    steps: z.array(bundledStepSchema).min(1).max(64),
    /**
     * The cron travels, and it is inert on arrival. A Kestra Schedule trigger is
     * only ever emitted into the LIVE namespace for an APPROVED revision (§6.5),
     * approval is per (flow, revision) in the importing tenant, and an imported
     * flow has neither. So "this is meant to run weekly" survives as part of the
     * recipe without a bundle being able to arm anything.
     */
    schedule: z
      .object({ cron: z.string().min(1).max(128), timezone: z.string().max(64).optional() })
      .optional(),
    /**
     * Trigger declarations — Phase 6. They travel for the same reason the
     * schedule does: the trigger surface is part of the recipe. Names follow
     * the trigger API's rule (1..255 chars — `createTriggerSchema`), and on
     * import the model is revalidated by `validateModel`, which enforces the
     * same bound; materialisation as `triggers` rows happens on the importing
     * tenant's save, exactly as it does for a fresh declaration.
     */
    webhook: z.object({ name: z.string().min(1).max(255) }).optional(),
    api: z.object({ name: z.string().min(1).max(255) }).optional(),
    concurrencyLimit: z.number().int().min(1).max(64).optional(),
    /**
     * What the flow claims about its own output (archive/GAPS.md §2.3, D-68).
     *
     * ⚠ **It travels, and the import says what it cannot verify.** The
     * temptation is to strip it, on §5.2's reasoning that a thing generated
     * against one schema is wrong against another — and half of that is true
     * here in a way it was NOT true for fragments (D-24): `rowCount eq 11` is a
     * claim about one tenant's rows and is very likely wrong in the next
     * workspace, while "every row has an email" and "no call failed" travel
     * perfectly.
     *
     * Stripping would drop both halves and, worse, silently: the flow would
     * arrive looking checked and be checking nothing. Keeping both and reporting
     * the fact is the same posture Phase 6 already takes on the whole import —
     * a STRUCTURAL check, never a correctness one. Gate 1 then holds the
     * imported flow until its claims pass HERE, which is exactly the behaviour
     * wanted: the numbers get corrected against the importing tenant's data, by
     * someone who can see both.
     */
    expectations: z.array(expectationSchema).max(MAX_EXPECTATIONS).optional(),
  }),
  /** The refs this flow calls, with the signature they had where it was written. */
  refs: z.array(bundledRefSchema).max(64),
  /**
   * Secret env-var NAMES the flow's tools need. Names only — a value has never
   * left `workspace_secrets` and there is no field here one could travel in.
   * Reported at import as a configuration list, not as a blocker: a missing
   * secret fails loudly at execution, and refusing the import would stop anyone
   * staging a flow before configuring it.
   */
  secretNames: z.array(z.string().max(255)).max(64),
  notes: z.string().max(4000).optional(),
});

export type FlowBundle = z.infer<typeof flowBundleSchema>;

export function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = statusCode;
  return e;
}

// ── Export ───────────────────────────────────────────────────────────────────

/**
 * Project one live step onto its portable form.
 *
 * The `code` case is the only interesting one and it is a rebuild, not a filter:
 * the returned object is constructed field by field, so `code` cannot survive by
 * being forgotten.
 */
function bundleStep(
  step: FlowStep,
  /** All of the model's steps — display rendering resolves `over` references. */
  steps: FlowStep[],
  contracts: Record<string, StepContract>,
): z.infer<typeof bundledStepSchema> {
  /**
   * ⚠ **The label and the description TRAVEL, and the code still does not.**
   * D-24's rule is about what an import must not be asked to trust — a fragment
   * body written against one tenant's data. Prose describing what a step is for
   * is the opposite: it is the part of the author's intent that survives the
   * move, and it is what makes an imported flow readable rather than a graph of
   * ids. ⚠ It is still **allowlisted per kind** below, so a new field does not
   * travel until someone writes it down.
   */
  const label = {
    ...(step.name ? { name: step.name } : {}),
    ...(step.description ? { description: step.description } : {}),
  };
  switch (step.kind) {
    case "tool":
    case "datasource":
    case "query":
      // A `query` step travels identically to the other two calling kinds: its
      // ref (revalidated on import) and its params expression. The operation's
      // SQL is NOT in the bundle — it is compiled server-side per tenant, and
      // carrying a compiled SELECT would be carrying code the import must not
      // trust any more than it trusts a fragment (D-24).
      // Bundles stay in the v1 display lingua franca: the params expression
      // travels because it is the recipe's own text, revalidated on import —
      // and a bundle carrying display strings imports into a tenant that has
      // not upgraded yet. A converted step (display dropped) renders from its
      // typed fields; an unreadable one kept its display and travels verbatim.
      // Nothing renderable and nothing kept means there is no recipe to carry,
      // refused the same way a contractless `code` step is below.
      const paramsExpr = displayParams(step, steps);
      if (!paramsExpr) {
        throw httpError(
          `step "${step.id}" has neither params nor renderable typed inputs, so it cannot travel`,
          409,
        );
      }
      return {
        kind: step.kind,
        id: step.id,
        ...label,
        ref: step.ref,
        paramsExpr,
        ...(step.extraInputs ? { extraInputs: step.extraInputs } : {}),
        ...(step.dependsOn ? { dependsOn: step.dependsOn } : {}),
        ...(step.timeoutSeconds ? { timeoutSeconds: step.timeoutSeconds } : {}),
        ...(step.retry ? { retry: step.retry } : {}),
      };
    case "transform": {
      // Converted steps travel rendered, legacy steps verbatim — the same
      // dual-read rule the emitter runs, so a bundle carries the recipe as
      // text and imports into tenants that never upgraded.
      const expr = displayTransform(step, steps);
      if (!expr) {
        throw httpError(
          `step "${step.id}" has neither expression nor renderable typed columns, so it cannot travel`,
          409,
        );
      }
      return {
        kind: "transform",
        id: step.id,
        ...label,
        expr,
        // A drafted reshape's declared output (phase 3 step 2) travels with the
        // program it declares — it names fields of this flow, not the tenant's.
        ...(step.fields?.length ? { fields: step.fields } : {}),
        ...(step.dependsOn ? { dependsOn: step.dependsOn } : {}),
      };
    }
    case "branch":
      // The condition travels verbatim. It names step ids and fields, both of
      // which are local to a flow rather than to a tenant — unlike a `ref`,
      // which is why `refInterfaces()` checks those and not this.
      // ⚠ `elseOf` travels too, and it MUST: it names a step id inside this same
      // flow, so it is local exactly as `dependsOn` is — and a bundle that
      // dropped it would import an if/elif chain as a set of unrelated guards
      // that all run, which is a different flow that still compiles.
      // A converted branch renders its `test`; an `else` (and an unknown test
      // with no display, which has nothing to travel) omits the key — and an
      // import of that omission is refused by `validateModel`, not silently a
      // different flow, because a conditionless non-`else` never validates.
      const conditionExpr = displayCondition(step, steps);
      return {
        kind: "branch",
        id: step.id,
        ...label,
        ...(conditionExpr ? { conditionExpr } : {}),
        ...(step.elseOf ? { elseOf: step.elseOf } : {}),
        ...(step.dependsOn ? { dependsOn: step.dependsOn } : {}),
      };
    case "merge":
      // `sources` travels UNCONDITIONALLY — not `...(step.sources ? … : {})`
      // like the optional fields around it. It is required, and spreading it
      // conditionally is how a required field quietly becomes an absent one on
      // the day something hands this an empty array.
      return {
        kind: "merge",
        id: step.id,
        ...label,
        sources: step.sources,
        ...(step.dependsOn ? { dependsOn: step.dependsOn } : {}),
      };
    case "approval":
      // The gate travels; the DECISIONS do not. `flow_step_approvals` rows are
      // per execution and belong to the origin tenant's audit trail, and an
      // import that carried them would arrive claiming somebody in another
      // organisation had already approved a run that never happened here.
      //
      // The same reason a bundle carries no approvals, no history and no armed
      // revision (§5.2): an imported flow has never run and nobody has agreed to
      // anything about it.
      // As the call kinds above: the question travels as display text (a
      // converted approval renders its typed summary), while the evidence
      // omits when there is none — matching what the old exporter wrote for a
      // missing `contextExpr`.
      const summaryExpr = displaySummary(step, steps);
      if (!summaryExpr) {
        throw httpError(`step "${step.id}" has neither a summary nor a renderable typed question`, 409);
      }
      const contextExpr = displayContext(step, steps);
      return {
        kind: "approval",
        id: step.id,
        ...label,
        summaryExpr,
        ...(contextExpr ? { contextExpr } : {}),
        ...(step.dependsOn ? { dependsOn: step.dependsOn } : {}),
        ...(step.awaitSeconds ? { awaitSeconds: step.awaitSeconds } : {}),
      };
    case "code": {
      const contract = contracts[step.id];
      if (!contract) {
        // A hand-written fragment has no contract, so there is nothing to
        // regenerate it from in the importing tenant. Exporting it anyway would
        // produce a bundle that imports to a permanently ungenerated step — and
        // `flowCompiler` rejects the placeholder by name (assertion 30), so it
        // could never even be deployed. Refusing here names the actual problem.
        throw httpError(
          `step "${step.id}" is a hand-written \`code\` step with no stored contract, so it cannot ` +
            `travel: the importing workspace would have nothing to regenerate it from. Give the ` +
            `step a contract, or replace it with a tool or datasource step.`,
          409,
        );
      }
      const { stepId: _drop, ...portable } = contract;
      // As the call kinds: the input expression travels as display text (a
      // converted step renders its typed bindings), revalidated on import.
      const inputExpr = displayCodeInput(step, steps);
      if (!inputExpr) {
        throw httpError(`step "${step.id}" has neither an input expression nor renderable typed inputs`, 409);
      }
      return {
        kind: "code",
        id: step.id,
        ...label,
        inputExpr,
        contract: portable,
        ...(step.dependsOn ? { dependsOn: step.dependsOn } : {}),
        ...(step.timeoutSeconds ? { timeoutSeconds: step.timeoutSeconds } : {}),
        ...(step.retry ? { retry: step.retry } : {}),
      };
    }
    case "llm":
    case "http":
      // Declared but unemitted: no revision this deployment writes can hold
      // one of these (`validateModel` refuses them by name), so there is
      // nothing to project. Refusing names the kind — the same posture as the
      // contractless `code` refusal above, and for the same reason: a bundle
      // that carried one would import to a step no workspace can deploy.
      throw httpError(
        `step "${step.id}" is a \`${step.kind}\` step, which is declared but has no emitter yet, ` +
          `so it cannot travel`,
        409,
      );
    case "for_each":
    case "collect":
      // For each (D-361): the bundle's step schema has no shape for a loop yet, so it does not travel — refused by name
      // rather than dropped, since a bundle missing its loop would import as a different flow.
      throw httpError(`step "${step.id}" is part of a loop, and a flow with a loop cannot be exported yet`, 409);
  }
}

/**
 * Export a flow revision as a bundle.
 *
 * Defaults to the DRAFT revision, not the armed one, because export is an
 * authoring operation: you share what you are working on. Pass `revision` to
 * capture a specific one.
 */
export async function exportFlow(
  workspaceId: string,
  flowId: string,
  opts: { revision?: number; workspaceName?: string; exportedAt?: string } = {},
): Promise<FlowBundle> {
  const flow = await flowRepo.get(workspaceId, flowId);
  if (!flow) throw httpError("flow not found", 404);

  const revision = opts.revision ?? flow.draftRevision;
  const row = await flowRepo.getRevision(flow.id, revision);
  if (!row) throw httpError(`flow has no revision ${revision}`, 404);

  // The one normalise on the bundle read path: a v1 row upgrades here, so
  // `bundleStep` below always projects v2 — display strings verbatim where the
  // upgrade kept them, rendered from typed fields where it converted. History
  // rows are never rewritten; only what the bundle carries is normalised.
  const model = normaliseModel(row.modelJson) as unknown as FlowModel;
  const contracts = await flowService.contractsFor(flow.id, revision);

  const steps = model.steps.map((s) => bundleStep(s, model.steps, contracts));

  // Ref signatures AS OF NOW, from the exporting workspace. Captured rather than
  // looked up at import for the obvious reason: at import time the origin
  // workspace is not reachable, and on a cross-tenant transfer it never was.
  const interfaces = await manifestBuilderService.refInterfaces(workspaceId);
  const usedRefs = [
    ...new Set(
      model.steps
        .filter(
          (s): s is Extract<FlowStep, { ref: string }> =>
            s.kind === "tool" || s.kind === "datasource" || s.kind === "query",
        )
        .map((s) => s.ref),
    ),
  ].sort();

  const refs = usedRefs.map((ref) => {
    const iface: RefInterface | undefined = interfaces[ref];
    if (!iface) {
      // The flow calls something that no longer exists here. Exporting it as an
      // unknown would hand the importer a bundle whose refs cannot be checked
      // against anything — the check would pass by having no baseline.
      throw httpError(
        `cannot export: step ref "${ref}" no longer exists in this workspace, so its call ` +
          `signature cannot be recorded. Fix or remove the step first.`,
        409,
      );
    }
    return { ref, kind: iface.kind, signature: iface.signature, params: iface.params };
  });

  // Secret NAMES, from the tools this flow actually calls — not every secret in
  // the workspace. A bundle listing secrets the flow does not need reads as a
  // demand for credentials it has no business asking for.
  const toolNames = new Set(refs.filter((r) => r.kind === "tool").map((r) => r.ref));
  const secretNames = [
    ...new Set(
      (await toolRepo.listByWorkspace(workspaceId))
        .filter((t) => toolNames.has(t.name) && t.secretEnvName)
        .map((t) => t.secretEnvName as string),
    ),
  ].sort();

  const bundle: FlowBundle = {
    formatVersion: BUNDLE_FORMAT,
    source: {
      ...(opts.workspaceName ? { workspaceName: opts.workspaceName } : {}),
      flowName: flow.name,
      kestraFlowId: flow.kestraFlowId,
      revision,
      ...(opts.exportedAt ? { exportedAt: opts.exportedAt } : {}),
    },
    flow: { name: flow.name, ...(flow.description ? { description: flow.description } : {}) },
    model: {
      id: model.id,
      ...(model.inputs ? { inputs: model.inputs } : {}),
      steps,
      ...(model.schedule ? { schedule: model.schedule } : {}),
      // ⚠ `webhook` retired 2026-09-08 and is no longer bundled. It is also no
      // longer accepted by `flowModelSchema`, so an import carrying one would
      // have the key stripped on write — exporting it would promise a
      // portability that the import side cannot honour.
      ...(model.api ? { api: model.api } : {}),
      ...(model.concurrencyLimit ? { concurrencyLimit: model.concurrencyLimit } : {}),
      ...(model.expectations?.length ? { expectations: model.expectations } : {}),
    },
    refs,
    secretNames,
  };

  // Parse our own output. A bundle that does not satisfy the schema an importer
  // will apply is a bug worth finding on the way out, not on the way in — and it
  // is the check that keeps `bundleStep`'s allowlists honest as steps gain fields.
  return flowBundleSchema.parse(bundle);
}

// ── Import ───────────────────────────────────────────────────────────────────

export type ImportFindingCode =
  | "unknown_ref"
  | "param_removed"
  | "param_added"
  | "signature_reordered"
  | "missing_secret"
  | "expression_rejected"
  | "expectation_imported"
  | "invalid_model"
  | "flow_id_taken";

export interface ImportFinding {
  code: ImportFindingCode;
  /** Blocking findings refuse the import; the rest are reported and proceed. */
  blocking: boolean;
  stepId?: string;
  ref?: string;
  /**
   * Written for a MODEL to act on, per §5.2's validator requirement: the
   * offending thing, the rule, and the facts needed to fix it. "unknown tool" on
   * its own wastes a redraft cycle.
   */
  message: string;
}

export interface ImportPlan {
  /** The model as it would be created, refs remapped. `code` bodies still absent. */
  model: FlowModel;
  contracts: Record<string, StepContract>;
  findings: ImportFinding[];
  warnings: ImportFinding[];
  /** Refs the caller's `refMap` rewrote — echoed so a UI can show the remapping. */
  remapped: Array<{ from: string; to: string }>;
}

/**
 * Rebuild a `FlowModel` from a bundle, with `code` steps carrying the placeholder
 * and their `outputKeys` DERIVED from the travelled contract.
 */
function modelFromBundle(
  bundle: FlowBundle,
  refMap: Record<string, string>,
): { model: FlowModel; contracts: Record<string, StepContract>; remapped: Array<{ from: string; to: string }> } {
  const contracts: Record<string, StepContract> = {};
  const remapped: Array<{ from: string; to: string }> = [];

  const steps: FlowStep[] = bundle.model.steps.map((s) => {
    if (s.kind === "code") {
      const contract: StepContract = { stepId: s.id, ...s.contract };
      contracts[s.id] = contract;
      return {
        id: s.id,
        kind: "code",
        code: UNGENERATED,
        inputExpr: s.inputExpr,
        outputKeys: contract.output.map((f) => f.name),
        ...(s.dependsOn ? { dependsOn: s.dependsOn } : {}),
        ...(s.timeoutSeconds ? { timeoutSeconds: s.timeoutSeconds } : {}),
        // Rebuilt field by field (that is how `code` gets stripped), so anything
        // that should survive the round trip has to be named here as well as in
        // `bundleStep`. `tool`/`datasource` below spread, and do not.
        ...(s.retry ? { retry: s.retry } : {}),
      };
    }
    if (s.kind === "tool" || s.kind === "datasource" || s.kind === "query") {
      // The ref travels by name and is remapped the same way for all three
      // calling kinds — an operation ref (`<datasource>.<operation>`) is
      // revalidated against the importing tenant exactly like a query ref.
      const to = refMap[s.ref];
      if (to && to !== s.ref) remapped.push({ from: s.ref, to });
      return { ...s, ref: to ?? s.ref };
    }
    return s as FlowStep;
  });

  return {
    model: {
      id: bundle.model.id,
      ...(bundle.model.inputs ? { inputs: bundle.model.inputs } : {}),
      steps,
      ...(bundle.model.schedule ? { schedule: bundle.model.schedule } : {}),
      ...(bundle.model.webhook ? { webhook: bundle.model.webhook } : {}),
      ...(bundle.model.api ? { api: bundle.model.api } : {}),
      ...(bundle.model.concurrencyLimit ? { concurrencyLimit: bundle.model.concurrencyLimit } : {}),
      ...(bundle.model.expectations?.length ? { expectations: bundle.model.expectations } : {}),
    },
    contracts,
    remapped,
  };
}

function describeAvailable(
  interfaces: Record<string, RefInterface>,
  kind: "tool" | "query" | "operation",
): string {
  const names = Object.entries(interfaces)
    .filter(([, i]) => i.kind === kind)
    .map(([n, i]) => `${n} ${i.signature}`)
    .sort();
  return names.length ? names.join(" | ") : `(none registered in this workspace)`;
}

/**
 * Everything that can be checked WITHOUT an inference call, so a caller can see
 * the findings before spending one.
 *
 * `refMap` is applied verbatim and there is deliberately **no fuzzy matching**.
 * `attendance_below_threshold` → `presence_below_policy` is a guess a machine
 * should not make: the two names are similar, the two queries return different
 * units, and a silently-accepted guess is the exact failure class this whole
 * migration exists to remove. An unmapped ref that does not exist locally is a
 * blocking finding that names the alternatives, and a human picks.
 */
export async function planImport(
  workspaceId: string,
  bundle: FlowBundle,
  refMap: Record<string, string> = {},
): Promise<ImportPlan> {
  const findings: ImportFinding[] = [];
  const warnings: ImportFinding[] = [];

  const { model, contracts, remapped } = modelFromBundle(bundle, refMap);
  const interfaces = await manifestBuilderService.refInterfaces(workspaceId);
  const bundledByRef = new Map(bundle.refs.map((r) => [r.ref, r]));

  for (const step of model.steps) {
    if (step.kind !== "tool" && step.kind !== "datasource" && step.kind !== "query") continue;
    const localRef = step.ref;
    const originRef = remapped.find((r) => r.to === localRef)?.from ?? localRef;
    const local = interfaces[localRef];

    if (!local) {
      // The ref kind a `query` step names is an OPERATION, not a query — the
      // manifest keeps the two distinct, and the finding names the right shelf.
      const kind: "tool" | "query" | "operation" =
        step.kind === "tool" ? "tool" : step.kind === "datasource" ? "query" : "operation";
      findings.push({
        code: "unknown_ref",
        blocking: true,
        stepId: step.id,
        ref: localRef,
        message:
          `step "${step.id}" references ${kind} "${localRef}", which does not exist in this ` +
          `workspace. Available: ${describeAvailable(interfaces, kind)}. ` +
          `Supply a refMap entry to point it at one of these.`,
      });
      continue;
    }

    const origin = bundledByRef.get(originRef);
    if (!origin) continue; // Nothing recorded to compare against; the name check stands alone.

    const localNames = new Set(local.params.map((p) => p.name));
    const originNames = new Set(origin.params.map((p) => p.name));

    for (const p of origin.params) {
      if (!localNames.has(p.name)) {
        findings.push({
          code: "param_removed",
          blocking: true,
          stepId: step.id,
          ref: localRef,
          message:
            `step "${step.id}" sends parameter "${p.name}" to "${localRef}", which does not ` +
            `accept it. Origin signature was \`${origin.signature}\`; this workspace's is ` +
            `\`${local.signature}\`. Adjust the step's paramsExpr, or point it at a ref that ` +
            `takes "${p.name}".`,
        });
      }
    }

    for (const p of local.params) {
      if (p.required && !originNames.has(p.name)) {
        findings.push({
          code: "param_added",
          blocking: true,
          stepId: step.id,
          ref: localRef,
          message:
            `"${localRef}" in this workspace requires parameter "${p.name}", and step ` +
            `"${step.id}" was written against a version that had no such parameter ` +
            `(\`${origin.signature}\` → \`${local.signature}\`). Its paramsExpr must supply ` +
            `"${p.name}".`,
        });
      }
    }

    // Same names, different order. Only meaningful for a positional ref, and
    // only a warning: the step API binds by NAME out of the params object, so
    // order is the ref's business — for an operation the local SQL was compiled
    // from the local filter order, so the binding is internally consistent.
    // Reported because a reordered param list in a hand-edited ref is usually a
    // mistake worth a look.
    if (
      (local.kind === "query" || local.kind === "operation") &&
      local.params.length === origin.params.length &&
      local.params.every((p) => originNames.has(p.name)) &&
      local.params.map((p) => p.name).join(",") !== origin.params.map((p) => p.name).join(",")
    ) {
      warnings.push({
        code: "signature_reordered",
        blocking: false,
        stepId: step.id,
        ref: localRef,
        message:
          `"${localRef}" takes the same parameters in a different order here ` +
          `(\`${origin.signature}\` → \`${local.signature}\`). Parameters bind by name, so this ` +
          `is safe — but check the SQL is the one you meant.`,
      });
    }
  }

  // Secrets: NAMES compared against what is configured. A missing one is
  // reported, never blocking — see `secretNames` on the schema.
  if (bundle.secretNames.length) {
    const configured = new Set(
      (await workspaceSecretRepo.listByWorkspace(workspaceId)).map((s) => s.name),
    );
    for (const name of bundle.secretNames) {
      if (!configured.has(name)) {
        warnings.push({
          code: "missing_secret",
          blocking: false,
          message:
            `this flow's tools expect a secret named "${name}", which is not configured in this ` +
            `workspace. The flow will import and can be reviewed, but a step needing it will ` +
            `fail at execution until it is set.`,
        });
      }
    }
  }

  // D-22 again, on a path the drafter never touched. A bundle is client-supplied
  // input by definition — that is what importing MEANS — so its expressions get
  // the same allowlist a generated model gets. `writeRevision` would catch this
  // too; catching it here turns a 400 at the end of an import into a finding
  // before any inference is spent.
  // `ExpressionFinding` carries only a message, and the message already opens
  // with `step "<id>".<field>` — so the step is named without this having to
  // re-derive it and risk disagreeing with the check that produced it.
  for (const f of validateModelExpressions(model.steps as unknown as Array<Record<string, unknown>>)) {
    findings.push({ code: "expression_rejected", blocking: true, message: f.message });
  }

  // ── The claims travelled, and this is the sentence that keeps them honest ──
  //
  // archive/GAPS.md §2.3. Non-blocking, and worded so nobody reads an imported
  // expectation as a verified one: `refInterfaces()` proves every ref exists and
  // every signature matches, and it cannot tell whether this tenant's query
  // returns the same rows in the same units (D-25). An expectation written over
  // there is a claim about over there.
  //
  // ⚠ Reported even though gate 1 will enforce it anyway. Discovering "3 of 4
  // expectations fail here" by trying to arm the flow next week is the same
  // information arriving after the person who could explain it has gone.
  if (model.expectations?.length) {
    warnings.push({
      code: "expectation_imported",
      blocking: false,
      message:
        `this flow carries ${model.expectations.length} expectation(s) about its own output ` +
        `(${model.expectations.map((e) => `"${e.id}"`).join(", ")}), written against the data of ` +
        `the workspace it came from. Structural claims travel; counts usually do not — ` +
        `"11 rows" there may be a different number here. They are enforced: gate 1 will not arm ` +
        `this flow until each one passes on a run in THIS workspace.`,
    });
  }

  try {
    validateModel({
      ...model,
      steps: model.steps.map((s) =>
        s.kind === "code" && s.code === UNGENERATED
          ? { ...s, code: "def run(payload):\n    return {}" }
          : s,
      ),
    });
  } catch (e) {
    findings.push({
      code: "invalid_model",
      blocking: true,
      ...((e as FlowCompileError).stepId ? { stepId: (e as FlowCompileError).stepId! } : {}),
      message: (e as Error).message,
    });
  }

  const taken = await flowRepo.getByKestraFlowId(workspaceId, model.id);
  if (taken) {
    findings.push({
      code: "flow_id_taken",
      blocking: true,
      message:
        `a flow with id "${model.id}" already exists in this workspace ("${taken.name}"). ` +
        `Import with an explicit modelId to give this one a different id — it is not renamed ` +
        `automatically, because two automations differing only by a suffix is how the wrong one ` +
        `gets approved.`,
    });
  }

  return { model, contracts, findings, warnings, remapped };
}

export interface ImportResult {
  status: "ok" | "insufficient_contract";
  flow?: Flow;
  revision?: number;
  /** Present when a travelled contract could not be satisfied here. */
  refusals?: FragmentOutcome[];
  findings: ImportFinding[];
  warnings: ImportFinding[];
  remapped: Array<{ from: string; to: string }>;
  /** One per `code` step. Zero for a flow that needs no generation at all. */
  inferenceCalls: number;
}

/**
 * Import a bundle into a workspace: revalidate, **then generate, then create.**
 *
 * That order is 04 §5.3.1's Consequence 2, and it is not negotiable —
 * *"a flow must never reach Kestra with an empty `script:` block. That would
 * require Kestra to trigger generation, inverting the entire model."*
 * `flowService.create` deploys to the draft namespace as its last act, so
 * generation has to have already happened when it is called. It has: fragments
 * are generated here, and `flowCompiler` rejects the placeholder by name if they
 * were not (assertion 30).
 *
 * A refusal is returned as a **successful** outcome with `status:
 * "insufficient_contract"`, exactly as `POST …/flows/generate` does. The flow is
 * NOT created. A travelled contract that cannot be satisfied in this tenant is
 * the most useful thing an import can tell you — it names the field the recipe
 * assumes and this workspace does not supply — and filing it under "error" is how
 * a client renders it as a failure and retries.
 *
 * Nothing here can reach the live namespace. `flowService.create` has no live
 * branch (see its header), so an imported flow arrives as revision 1, unarmed,
 * unapproved, with no execution history — the importing tenant's own gate 1 and
 * gate 2 both still to satisfy. An import cannot inherit trust.
 */
export async function importFlow(
  workspaceId: string,
  input: unknown,
  opts: {
    refMap?: Record<string, string>;
    /** Override the flow id, e.g. on a collision. */
    modelId?: string;
    name?: string;
    description?: string;
    /**
     * Who is importing — archive/GAPS.md §1.2. **Required**, and it is the importer, not
     * the bundle's origin author.
     *
     * A bundle carries no authorship and must not: `bundleStep` is an allowlist
     * per kind (D-24), and an origin name travelling into `created_by` here
     * would let one tenant write the other tenant's author field. The revision
     * created by an import is authored by whoever ran the import — a person if
     * one was signed in, `system` if a harness did it — because that is exactly
     * who gate 2 must refuse if they then approve it.
     *
     * ⚠ There is deliberately no `import` author kind; see
     * `services/revision-author.ts` for why the column is one axis and not two.
     */
    author: RevisionAuthor;
  },
  client: InferenceClient = inference,
): Promise<ImportResult> {
  const parsed = flowBundleSchema.safeParse(input);
  if (!parsed.success) {
    throw httpError(
      `not a valid flow bundle: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`,
      400,
    );
  }
  const bundle: FlowBundle = opts.modelId
    ? { ...parsed.data, model: { ...parsed.data.model, id: opts.modelId } }
    : parsed.data;

  const plan = await planImport(workspaceId, bundle, opts.refMap ?? {});
  const blocking = plan.findings.filter((f) => f.blocking);
  if (blocking.length) {
    throw Object.assign(httpError(`import refused: ${blocking.length} finding(s)`, 422), {
      findings: plan.findings,
      warnings: plan.warnings,
    });
  }

  // ⚠ F1 — enriched from the TARGET workspace's own projections, which is what
  // the generated code will actually read. Same prompt-time-only rule: the
  // stored bundle keeps its declared contracts.
  const generated = await generateFragments(
    { model: plan.model, contracts: plan.contracts },
    client,
    undefined,
    await manifestBuilderService.refInterfaces(workspaceId),
  );

  if (generated.refusals.length) {
    return {
      status: "insufficient_contract",
      refusals: generated.refusals,
      findings: plan.findings,
      warnings: plan.warnings,
      remapped: plan.remapped,
      inferenceCalls: generated.inferenceCalls,
    };
  }

  const { flow, revision } = await flowService.create(
    workspaceId,
    {
      name: opts.name ?? bundle.flow.name,
      ...(opts.description ?? bundle.flow.description
        ? { description: opts.description ?? bundle.flow.description! }
        : {}),
      model: generated.model,
      author: opts.author,
    },
    generated.contracts,
  );

  return {
    status: "ok",
    flow,
    revision: revision.revision,
    findings: plan.findings,
    warnings: plan.warnings,
    remapped: plan.remapped,
    inferenceCalls: generated.inferenceCalls,
  };
}

export const flowPortabilityService = {
  exportFlow,
  planImport,
  importFlow,
  flowBundleSchema,
  BUNDLE_FORMAT,
};
