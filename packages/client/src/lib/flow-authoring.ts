/**
 * Re-export of `@foundry/flow-edit`.
 *
 * The implementation moved out of this package in foundations Phase 2.1 (D-121),
 * unchanged. Chat mode edits a flow with the same operations the canvas does,
 * server-side, and the alternative was a server-side COPY of `spliceApproval`:
 * a copy cannot be pinned against this one — server tests cannot resolve this
 * package's `@/` alias — so it would drift silently, each half passing its own
 * tests. `spliceApproval` is deliberately the SINGLE gate-placement
 * implementation, because an appended gate compiles, deploys and stops nothing.
 *
 * This file stays as a re-export rather than being deleted so the call sites in
 * this package keep their local import path, and so the reason lives where
 * someone following an import will find it. The tests live with the
 * implementation, in `packages/flow-edit`.
 *
 * ⚠ `scripts/ui-honesty-check.sh`'s two assertions about this module were
 * repointed at `packages/flow-edit/src/index.ts` in the same commit — over a
 * re-export shim the "no `code:` field" grep finds nothing and passes
 * vacuously, which is a check that cannot fail (I-38).
 */

// The local addition below (`authoredToStoredFlow`) names these types, so they
// need a LOCAL binding — an `export … from` re-export does not bring a name
// into this module's scope.
import { addStep, NODE_TYPES, toEscapedInputSpelling, toLegacyInputSpelling, uniqueStepId, type AuthoredFlow, type AuthoredStep, type StepKind, type StoredFlow, type StoredStep } from "@foundry/flow-edit";

export {
  authoredFromModel,
  RESERVED_STEP_IDS,
  isValidStepId,
  isValidFlowId,
  slugify,
  uniqueStepId,
  dependenciesOf,
  reaches,
  candidateUpstream,
  addStep,
  removeStep,
  connect,
  disconnect,
  replaceStep,
  spliceApproval,
  localFindings,
  EXPECTABLE_KINDS,
  NULLARY_EXPECT_OPS,
  addExpectation,
  removeExpectation,
  describeExpectation,
} from "@foundry/flow-edit";

export type {
  AuthoredFromModel,
  FromModelOptions,
  FromModelResult,
  StoredContract,
  StoredFlow,
  StoredStep,
  StepKind,
  ContractFieldType,
  ContractField,
  NamedParam,
  StepContract,
  AuthoredStep,
  FlowInput,
  AuthoredFlow,
  EditResult,
  LocalFinding,
  ExpectOp,
  ExpectationAssert,
  FlowExpectation,
  ExpectationEdit,
} from "@foundry/flow-edit";

/**
 * The inverse of `authoredFromModel` for the DRAFT-EDIT path (Phase 6) — write
 * an `AuthoredFlow` back into the STORED model shape a revision saves.
 *
 * ── Why this is NOT `splitDraft` ─────────────────────────────────────────────
 *
 * The server's `splitDraft` turns an authored flow into a stored one the way
 * creation needs: it GENERATES the `code` bodies from their contracts (one
 * inference call per fragment). `POST /:flowId/revisions` does no such thing —
 * it validates the model it is given and stores it — so an edit on the flow
 * page must produce a model whose `code` bytes already exist. This is that
 * conversion, and it is only honest because of what it CARRIES:
 *
 *   * a `code` step's fragment body (`code`) is carried from the previous
 *     revision — a canvas edit never regenerates it;
 *   * `outputKeys` is re-derived from the step's contract the same way
 *     `splitDraft` derives it on the way in, so the declared shape and the
 *     enforced one cannot disagree;
 *   * ⚠ `retry` is now EDITABLE, so the authored value wins and the carried one
 *     is only the fallback — the old unconditional carry would have made the
 *     form appear to save while the previous value came straight back;
 *   * the fields the authored shape still cannot express — the flow's
 *     `concurrencyLimit` and its `expectations` — are carried from the previous
 *     model, so an edit on this page loses none of them (unlike the copy path,
 *     whose `dropped` list exists precisely because it cannot);
 *   * the trigger declarations (`inputs`, `schedule`, `webhook`, `api`) ride
 *     on `AuthoredFlow` and come straight through.
 *
 * ⚠ **The contract itself is NOT written here.** The stored model carries no
 * contract (it lives in `flow_steps.contract_json`, inherited by the revision
 * route), so a changed contract would silently fail to persist. The flow page
 * refuses a contract change at the inspector before this function ever sees it.
 *
 * `renamed` maps old step id → new step id for renames applied through
 * `replaceStep` (D-150(c)): the carried fields have to be found under the OLD
 * id, or a renamed `code` step would come back without its fragment.
 */
export function authoredToStoredFlow(
  authored: AuthoredFlow,
  prev: StoredFlow,
  renamed: Record<string, string> = {},
): StoredFlow {
  const prior = new Map(prev.steps.map((s) => [s.id, s]));
  // A renamed step's carried fields live under the old id (D-150(c)).
  const carried = (id: string): StoredStep | undefined => {
    const direct = prior.get(id);
    if (direct) return direct;
    for (const [oldId, newId] of Object.entries(renamed)) {
      if (newId === id) return prior.get(oldId);
    }
    return undefined;
  };

  const steps: StoredStep[] = authored.steps.map((s): StoredStep => {
    const old = carried(s.id);
    const dependsOn = s.dependsOn !== undefined ? { dependsOn: s.dependsOn } : {};
    /**
     * ⚠ **The label is written back on EVERY kind.** A field the inspector can
     * edit and this function drops is a form that appears to save and reverts —
     * which is precisely the bug the `retry` carry had until it was made to
     * prefer the edited value. Omitting the key entirely when empty keeps a
     * blank field out of the stored model rather than storing `""`.
     */
    const label = {
      ...(s.name ? { name: s.name } : {}),
      ...(s.description ? { description: s.description } : {}),
    };
    switch (s.kind) {
      case "tool":
      case "datasource":
      case "query": {
        const next: StoredStep = {
          kind: s.kind,
          id: s.id,
          ...label,
          ref: s.ref,
          paramsExpr: s.paramsExpr,
          ...dependsOn,
        };
        // The rows' forward-model mirror beside `paramsExpr` (MERGE POINT: the
        // shared `params` member lands on the call variant via the Catalogue
        // slice; the server's save schema accepts it additively — CompilerCarry).
        // Read through the local `ToolCallStep` alias, which declares the
        // optional member — checked, not cast. The spread carries it without an
        // excess key, the same way `dependsOn` travels above.
        const callStep: ToolCallStep = s;
        const withParams: StoredStep =
          callStep.params !== undefined ? { ...next, params: callStep.params } : next;
        // Frozen step SQL (mock-data programme): the model drafts from the
        // schema, the person approves/edits inline, and the text freezes into
        // the revision. Edited value wins, carried fallback — the same rule as
        // `retry` above. `datasource`/`query` kinds only; a `tool` never
        // carries either (SliceC reads `step.sql` + `step.datasourceRef ?? ref`
        // prefix and runs exactly that text through `checkSqlShape`).
        // Read through a local alias — checked, not cast blindly — and spread
        // without an excess key, the way `params` travels above.
        //
        // ⚠ **`sqlParamOrder`/`sqlParamsSchema` TRAVEL WITH THEM, and used to
        // not — 2026-09-16.** The pair above is what the executor needs to
        // decide it is running the step's own text; these two are what it needs
        // to BIND that text's placeholders. Carrying one pair and not the other
        // saves a statement whose `$1` resolves to nothing, which fails at
        // execution rather than here. Same carried-fallback rule as `retry`.
        const frozen = s as unknown as {
          sql?: string;
          datasourceRef?: string;
          sqlParamOrder?: string[];
          sqlParamsSchema?: Record<string, unknown>;
        };
        const withFrozen: StoredStep = { ...withParams };
        if (s.kind === "datasource" || s.kind === "query") {
          for (const field of ["sql", "datasourceRef", "sqlParamOrder", "sqlParamsSchema"] as const) {
            const edited = frozen[field];
            if (edited !== undefined) (withFrozen as unknown as Record<string, unknown>)[field] = edited;
            else if (old && field in old)
              (withFrozen as unknown as Record<string, unknown>)[field] = (
                old as unknown as Record<string, unknown>
              )[field];
          }
        }
        // Edited value wins, carried fallback — the retry rule above. A form
        // that edits extra inputs must see them survive the save.
        if (s.extraInputs !== undefined) withFrozen.extraInputs = s.extraInputs;
        else if (old?.extraInputs !== undefined) withFrozen.extraInputs = old.extraInputs;
        if (s.timeoutSeconds !== undefined) withFrozen.timeoutSeconds = s.timeoutSeconds;
        if (s.retry !== undefined) withFrozen.retry = s.retry;
        else if (old?.retry !== undefined) withFrozen.retry = old.retry;
        return withFrozen;
      }
      case "transform":
        return { kind: s.kind, id: s.id, ...label, expr: s.expr, ...dependsOn };
      case "code": {
        const next: StoredStep = {
          kind: "code",
          id: s.id,
          ...label,
          code: old?.code,
          inputExpr: s.inputExpr,
          outputKeys: s.contract.output.map((f) => f.name),
          ...dependsOn,
        };
        if (s.timeoutSeconds !== undefined) next.timeoutSeconds = s.timeoutSeconds;
        // ⚠ The EDITED value wins; the carried one is the fallback. It used to
        // be `old?.retry` unconditionally, which was right while nothing could
        // edit a retry and is silent data loss the moment something can — the
        // form would appear to save and the old value would come straight back.
        if (s.retry !== undefined) next.retry = s.retry;
        else if (old?.retry !== undefined) next.retry = old.retry;
        return next;
      }
      case "branch":
        return {
          kind: s.kind,
          id: s.id,
          ...label,
          // ⚠ Both written back, both omitted when absent. A dropped `elseOf`
          // turns an if/elif/else chain into three unrelated always-run guards
          // on the first save, and the model still validates — so nothing says so.
          ...(s.conditionExpr !== undefined ? { conditionExpr: s.conditionExpr } : {}),
          ...(s.elseOf ? { elseOf: s.elseOf } : {}),
          ...dependsOn,
        };
      case "merge":
        return {
          kind: "merge",
          id: s.id,
          ...label,
          // ⚠ Written back UNCONDITIONALLY, unlike the optional fields around
          // it. `sources` is the entire step — a merge that loses it is not a
          // degraded merge, it is a join that joins nothing, and because the
          // server's `armOf` stops at a merge regardless, the flow would still
          // compile with a tail that always reads the "nothing ran" fallback.
          // That saves, deploys, and is a different flow.
          sources: s.sources,
          ...dependsOn,
        };
      case "approval": {
        const next: StoredStep = {
          kind: "approval",
          id: s.id,
          ...label,
          summaryExpr: s.summaryExpr,
          ...dependsOn,
        };
        if (s.contextExpr !== undefined) next.contextExpr = s.contextExpr;
        if (s.awaitSeconds !== undefined) next.awaitSeconds = s.awaitSeconds;
        return next;
      }
      case "llm": {
        const next: StoredStep = {
          kind: s.kind,
          id: s.id,
          ...label,
          model: s.model,
          tempPreset: s.tempPreset,
          temperature: s.temperature,
          topP: s.topP,
          frequencyPenalty: s.frequencyPenalty,
          presencePenalty: s.presencePenalty,
          promptBlocks: s.promptBlocks,
          outputFields: s.outputFields,
          memoryEnabled: s.memoryEnabled,
          visionDetail: s.visionDetail,
          reasoningSeparated: s.reasoningSeparated,
          ...dependsOn,
        };
        if (s.contextStepId !== undefined) next.contextStepId = s.contextStepId;
        if (s.retry !== undefined) next.retry = s.retry;
        else if (old?.retry !== undefined) next.retry = old.retry;
        return next;
      }
      case "http": {
        const next: StoredStep = {
          kind: s.kind,
          id: s.id,
          ...label,
          method: s.method,
          url: s.url,
          headers: s.headers,
          queryParams: s.queryParams,
          body: s.body,
          auth: s.auth,
          sslVerify: s.sslVerify,
          ...dependsOn,
        };
        if (s.timeouts !== undefined) next.timeouts = s.timeouts;
        if (s.retry !== undefined) next.retry = s.retry;
        else if (old?.retry !== undefined) next.retry = old.retry;
        return next;
      }
      case "classifier":
      case "extract":
      case "listop":
      case "iteration":
      case "loop":
        // Declared in the registry with no emitter yet — offered nowhere, and a
        // blank of one would be a step that cannot compile.
        throw new Error(`"${s.kind}" is declared but not runnable yet`);
      case "for_each":
      case "collect":
        // For each (D-361): built and saved only by the engine canvas, whose moves keep its rules — this legacy path never
        // opens a flow the engine can read, so reaching here is a bug, refused by name rather than written back half-kept.
        throw new Error(`"${s.kind}" is built on the engine canvas only`);
    }
  });

  const model: StoredFlow = {
    id: authored.id,
    steps,
    ...(authored.inputs !== undefined ? { inputs: authored.inputs } : {}),
    ...(authored.schedule !== undefined ? { schedule: authored.schedule } : {}),
    ...(authored.webhook !== undefined ? { webhook: authored.webhook } : {}),
    ...(authored.api !== undefined ? { api: authored.api } : {}),
    // The End boundary's rows — edited in the End panel, owned by no step.
    // Absent (not empty) when undeclared: an empty `rows` still declares "this
    // automation returns nothing shaped", which is not the same as not saying.
    ...(authored.output !== undefined ? { output: authored.output } : {}),
    // Fields the authored shape cannot carry — carried from the previous model.
    ...(prev.concurrencyLimit !== undefined ? { concurrencyLimit: prev.concurrencyLimit } : {}),
    ...(prev.expectations !== undefined ? { expectations: prev.expectations } : {}),
  };
  return model;
}

/**
 * A newly placed step, with every field present and none of them guessed.
 *
 * Shared by every surface that adds a step from the canvas (the builder, the
 * flow page and the chat workbench) so there is ONE blank step builder rather
 * than three copies that can drift. `ref` is empty for a blank call step and
 * the catalogue ref for a palette insert — the two are the same step with the
 * ref pre-filled.
 *
 * ⚠ A `code` step gets an empty CONTRACT and no code, and that asymmetry is the
 * design: a fragment is a function of its contract, so the contract is the thing
 * a person authors and the code is generated from it. There is no field here for
 * a body and there must not be one (the server's `flowModelSchema` requires a
 * body, so a blank `code` step is refused at save — it is completed in the
 * inspector on the builder, whose generation route writes the body).
 *
 * `after` names the step the new one should depend on — "add step after" — and
 * is null when the step is placed unconnected at a canvas position.
 */
/**
 * The kinds that are INVALID until they name a ref — exactly the kinds whose
 * blank below carries `ref: ""`.
 *
 * ⚠ **It lives here, beside the function it describes, because it is a property
 * of `blankStep` and not of any screen.** Reported from use: right-clicking the
 * chat builder's canvas and picking a step "throws some error". That surface
 * writes a revision per gesture, so a blank callable is not staged — it is a
 * refused save and an error message, for eight of the seventeen kinds the menu
 * offered. The canvas now asks which ref, and needs to know which kinds to ask
 * about.
 *
 * ⚠ A kind added to the first `case` group below and not to this set is offered
 * as complete when it is not, and the pick fails the old way.
 * `flow-authoring.test.ts` derives the set from `blankStep` itself and compares,
 * so the two cannot drift.
 */
export const NEEDS_REF: ReadonlySet<StepKind> = new Set<StepKind>([
  "datasource",
  "tool",
  "query",
]);

export function blankStep(
  kind: StepKind,
  id: string,
  after: string | null,
  ref = "",
  opts?: { persistable?: boolean },
): AuthoredStep {
  const dependsOn = after ? { dependsOn: [after] } : {};
  switch (kind) {
    case "datasource":
    case "tool":
    case "query":
      return { kind, id, ref, paramsExpr: "[{}]", ...dependsOn };
    case "transform":
      return { kind, id, expr: "{{ 1 }}", mode: "expression", templateText: "", ...dependsOn };
    case "code":
      return {
        kind,
        id,
        inputExpr: "{}",
        contract: { purpose: "", input: [], output: [{ name: "result", type: "object" }] },
        ...dependsOn,
      };
    case "approval":
      return {
        kind,
        id,
        summaryExpr: JSON.stringify("Approve this?"),
        // `summary` is the question as TEXT — `buildApprovalSummary` JSON-encodes
        // it when rendering, so a quoted default here would double-encode once
        // the display strings are dropped (Stage 4).
        summary: "Approve this?",
        awaitSeconds: 86_400,
        ...dependsOn,
      };
    /**
     * ⚠ An EMPTY condition, not a default one. `buildCondition` returns "" until
     * an upstream step is picked, and the compiler refuses an empty condition —
     * so a guard nobody configured is a refused save rather than a guard that is
     * silently always true, which would let every guarded step run and look
     * correct.
     *
     * The exception is `persistable`: surfaces that write a revision on EVERY
     * op (chat workbench, flow page) cannot stage an intentionally-invalid
     * blank — the server refuses the save and nothing is added at all. There
     * the guard starts always-true (`{{ 1 }}`, the same neutral default as a
     * blank transform's expr) and visibly unconfigured: the fresh step is
     * selected on add so its condition is the first thing seen. Staged
     * surfaces (manual builder) keep "" — the refused save is the control.
     */
    case "branch":
      return { kind, id, conditionExpr: opts?.persistable ? "{{ 1 }}" : "", test: null, ...dependsOn };
    /**
     * ⚠ **NO SOURCES, and unlike a condition there is no `persistable` escape.**
     *
     * A blank guard can start always-true (`{{ 1 }}`) because "always" is a real
     * condition that a person can then narrow. A merge has no such neutral
     * value: every source is the id of a step that must already exist, so there
     * is nothing safe to invent. Prefilling with a guess — the last two steps,
     * say — would silently wire the flow to steps nobody chose, and it would
     * compile.
     *
     * So an unconfigured merge is a REFUSED save on both kinds of surface, and
     * the server's refusal names the step and says a merge combines two or more.
     * That is the same argument the condition's docblock makes for staged
     * surfaces, applied here to both because the alternative is worse.
     */
    case "merge":
      return { kind, id, sources: [], ...dependsOn };
    case "llm":
    case "http": {
      // Runnable since Stage 4 — and the blank comes from the same fallbacks
      // the panel edits, so a placed step opens with every required key
      // present. Cloned: the fallbacks are shared registry values, and a
      // placed step's `promptBlocks` push must not rewrite the next blank.
      const spec = NODE_TYPES[kind];
      const props = Object.fromEntries(
        spec.properties.map((p) => [p.name, structuredClone(p.fallback)]),
      );
      return { kind, id, ...props, ...dependsOn } as AuthoredStep;
    }
    case "classifier":
    case "extract":
    case "listop":
    case "iteration":
    case "loop":
      // Declared in the registry with no emitter yet — offered nowhere, and a
      // blank of one would be a step that cannot compile.
      throw new Error(`"${kind}" is declared but not runnable yet`);
    case "for_each":
    case "collect":
      throw new Error(`"${kind}" is built on the engine canvas only`);
  }
}
/**
 * The kinds a merge may combine — quoted from the server's refusal
 * (`flow.service.ts`): *"a merge can only combine steps that produce a JSON
 * result — tool, datasource, query, transform"*. Branch, approval, merge
 * itself and the rest produce control flow, not combinable results.
 */
export const MERGEABLE_KINDS: ReadonlySet<string> = new Set(["tool", "datasource", "query", "transform"]);

/**
 * Which steps a fresh merge combines when it is added after `anchor` — the
 * contextual guess `blankStep` refuses to make (see its `merge` docblock: a
 * BLANK has no context, so any prefill would be invention). A gesture DOES
 * have context: the anchor is one input, and the other is read off its
 * neighbourhood — siblings first (steps sharing an upstream: the other arms
 * of the fork being joined), then the anchor's own upstreams, then the most
 * recent combinable step anywhere. Downstream of the anchor is never offered
 * (a merge cannot combine what runs after it). Fewer than two candidates ⇒
 * `[]`, and the caller says so instead of writing a step the server refuses.
 * The panel's sources picker stays the place to correct the guess.
 */
export function mergeSources(
  steps: Array<{ id: string; kind: string; dependsOn?: string[] }>,
  anchor: string | null,
): string[] {
  if (!anchor) return [];
  const byId = new Map(steps.map((s) => [s.id, s]));
  const anchorStep = byId.get(anchor);
  if (!anchorStep) return [];
  // Everything at or below the anchor — combining one of these would join a
  // step with its own downstream.
  const below = new Set<string>([anchor]);
  for (let grew = true; grew;) {
    grew = false;
    for (const s of steps) {
      if (!below.has(s.id) && (s.dependsOn ?? []).some((d) => below.has(d))) {
        below.add(s.id);
        grew = true;
      }
    }
  }
  const anchorDeps = new Set(anchorStep.dependsOn ?? []);
  const siblings = steps
    .filter((s) => s.id !== anchor && (s.dependsOn ?? []).some((d) => anchorDeps.has(d)))
    .map((s) => s.id);
  const pool = [anchor, ...siblings, ...(anchorStep.dependsOn ?? []), ...[...steps].reverse().map((s) => s.id)];
  const eligible = (id: string) =>
    (id === anchor || !below.has(id)) && MERGEABLE_KINDS.has(byId.get(id)?.kind ?? "");
  return [...new Set(pool.filter(eligible))].slice(0, 2);
}

export type DuplicateResult = { ok: true; flow: AuthoredFlow; id: string } | { ok: false; error: string };

/**
 * Copy a step under a NEW id (the canvas's Duplicate).
 *
 * The copy keeps every field of the original — kind, ref, expressions, params,
 * `dependsOn` — so it is exactly as complete as the step it was copied from.
 * Downstream steps are NOT rewired: they keep depending on the original, so a
 * duplicate is a copy of the step, never a silent re-parenting of its
 * successors (which would be a topology change wearing a copy's clothes).
 */
export function duplicateStep(flow: AuthoredFlow, stepId: string): DuplicateResult {
  const src = flow.steps.find((s) => s.id === stepId);
  if (!src) return { ok: false, error: `"${stepId}" is not in this flow` };
  const id = uniqueStepId(flow, stepId);
  const copy: AuthoredStep = { ...src, id };
  const r = addStep(flow, copy);
  if (!r.ok) return r;
  return { ok: true, flow: r.flow, id };
}

// ── The if / elif / else chain ───────────────────────────────────────────────
//
// ⚠ **A CHAIN IS A LINKED LIST ON `elseOf`, AND NOTHING ELSE CHANGES.**
// `if` → `elif` → `elif` → `else` are separate `branch` steps, each naming the
// one it continues. Arm MEMBERSHIP — which steps run inside an arm — is plain
// `dependsOn`, which is D-123, and is why not one of the edit functions above
// needed touching.
//
// ⚠ These are here rather than in the form because the canvas and the inspector
// both report intents and neither decides (Law 5). A rule that lives in a
// component is a rule that has no test.

export type ArmResult = { ok: true; flow: AuthoredFlow; id: string } | { ok: false; error: string };

type BranchLike = { id: string; kind: string; conditionExpr?: string; elseOf?: string };

const isBranch = (s: { kind: string }) => s.kind === "branch";

/**
 * The chain a branch belongs to, head first.
 *
 * Accepts ANY member and walks back to the head first, so a caller holding the
 * `else` gets the same answer as one holding the `if` — a function that only
 * worked from the head would silently return a one-element chain for every
 * other arm.
 */
export function chainOf(flow: AuthoredFlow, branchId: string): BranchLike[] {
  const branches = flow.steps.filter(isBranch) as unknown as BranchLike[];
  const byId = new Map(branches.map((b) => [b.id, b]));
  let head = byId.get(branchId);
  if (!head) return [];
  const back = new Set<string>();
  while (head?.elseOf && byId.has(head.elseOf) && !back.has(head.id)) {
    back.add(head.id);
    head = byId.get(head.elseOf)!;
  }
  const next = new Map<string, BranchLike>();
  for (const b of branches) if (b.elseOf) next.set(b.elseOf, b);
  const out: BranchLike[] = [];
  const seen = new Set<string>();
  let cur: BranchLike | undefined = head;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur);
    cur = next.get(cur.id);
  }
  return out;
}

/**
 * Append an arm to a chain: another `else if`, or the terminal `otherwise`.
 *
 * ⚠ **A terminal `otherwise` stays LAST.** Adding an `else if` after it would
 * put a test behind a catch-all, which is dead configuration that compiles —
 * the server never sees a problem, and the arm simply never runs. So a new
 * `else if` splices in ahead of the terminal arm when one exists.
 */
export function addArm(flow: AuthoredFlow, branchId: string, terminal: boolean): ArmResult {
  const chain = chainOf(flow, branchId);
  if (chain.length === 0) return { ok: false, error: `"${branchId}" is not a condition in this flow` };
  const last = chain[chain.length - 1]!;
  /**
   * ⚠ **TERMINAL MEANS THE KEY IS ABSENT, NOT THAT IT IS FALSY.** A freshly
   * added `else if` carries `conditionExpr: ""` until somebody configures it,
   * and `!""` is true — so a falsy check reads an unconfigured test as the
   * catch-all, refuses the next `otherwise` as a duplicate, and splices later
   * arms into the wrong place. Caught by the round-trip test, not by review.
   */
  const hasElse = last.conditionExpr === undefined;
  // ⚠ Refused rather than silently replaced: the server refuses two
  // continuations of one branch, and a second catch-all is a decision somebody
  // has already made once.
  if (terminal && hasElse) return { ok: false, error: "This condition already has an “otherwise”." };

  const head = chain[0]!;
  const id = uniqueStepId(flow, terminal ? `${head.id}_else` : `${head.id}_elif`);
  // ⚠ A new arm carries NO `dependsOn`. `elseOf` and `dependsOn` together are
  // refused by the compiler — an arm cannot sit inside the arm it is the
  // alternative to — and this is the one place that could produce both.
  const arm = {
    kind: "branch" as const,
    id,
    ...(terminal ? {} : { conditionExpr: "" }),
    elseOf: terminal || !hasElse ? last.id : chain[chain.length - 2]!.id,
  } as unknown as AuthoredStep;

  const steps = flow.steps.map((s) =>
    // Splicing an `else if` in ahead of the terminal arm: the terminal arm now
    // continues the new one.
    !terminal && hasElse && s.id === last.id ? ({ ...s, elseOf: id } as AuthoredStep) : s,
  );
  return { ok: true, flow: { ...flow, steps: [...steps, arm] }, id };
}

/**
 * Remove one arm and relink the chain around it.
 *
 * ⚠ **REFUSED WHEN THE ARM GUARDS ANYTHING**, and that is the whole safety of
 * it. The steps inside an arm depend on that arm's id; dropping the arm would
 * leave them depending on a step that is gone, and the repair a caller reaches
 * for — deleting them too — silently discards work somebody built. Naming them
 * puts the decision back where it belongs.
 */
export function removeArm(flow: AuthoredFlow, armId: string): { ok: true; flow: AuthoredFlow } | { ok: false; error: string } {
  const chain = chainOf(flow, armId);
  const idx = chain.findIndex((b) => b.id === armId);
  if (idx < 0) return { ok: false, error: `"${armId}" is not a condition in this flow` };
  if (idx === 0)
    return {
      ok: false,
      error: "The first condition is the step itself — delete the step to remove the whole chain.",
    };
  const guarded = flow.steps.filter((s) => (s.dependsOn ?? []).includes(armId)).map((s) => s.id);
  if (guarded.length > 0)
    return { ok: false, error: `${guarded.join(", ")} run inside this branch. Move or delete them first.` };

  const removed = chain[idx]!;
  const steps = flow.steps
    .filter((s) => s.id !== armId)
    // The arm after it now continues whatever this one continued.
    .map((s) => ((s as BranchLike).elseOf === armId ? ({ ...s, elseOf: removed.elseOf } as AuthoredStep) : s));
  return { ok: true, flow: { ...flow, steps } };
}
// ── Tool / query / datasource param rows ───────────────────────────────────────
//
// Typed property rows (NAME · SOURCE · type) for the call kinds. The read
// decomposes a step's `paramsExpr` per catalogue param; a value the builder did
// not write (chase's jq-concatenated title) stays an opaque `expression` row —
// shown as-is, never fake-decomposed. The write patches ONE pair's text and
// preserves every other byte, so editing priority cannot destroy a
// hand-written title. Both directions refuse rather than guess.
//
// ── MERGE POINT (Catalogue slice owns `packages/flow-edit/src/index.ts`) ──────
// `ToolParamSource` is the local shape of the shared row-edit contract (also
// declared as `RowValue["source"]` in `rows/ApprovalSection.tsx`). When the
// shared `params: Record<string, { source }>` member lands on the call variant
// of `AuthoredStep`, alias this to it and delete the local. Same for the
// `params` carry in `authoredToStoredFlow` and the `StoredStep` member the
// server's save schema accepts additively (CompilerCarry slice).
//
// `paramsExpr` stays the source of truth: it wins verbatim when present, and
// every write here keeps it in sync with the `params` mirror beside it.

import type { CatalogueParam } from "@foundry/flow-edit";
import { buildFanOutParams, rowsExpr, type Mapping, type OutputShapes } from "@/lib/flow-expr";
import { parseParams } from "@/lib/flow-params";

/** One parameter's feed: a fixed value, an upstream step field, or an opaque template. */
export type ToolParamSource =
  | { kind: "fixed"; value: string }
  | { kind: "step"; stepId: string; field: string }
  | { kind: "expression"; template: string };

/** The forward-model value for one parameter — the `params` record element. */
export type ToolParamValue = { source: ToolParamSource };

/** One catalogue parameter with its current feed. `null` = unset, never "empty". */
export type ToolParamRow = {
  name: string;
  type: string;
  required: boolean;
  description: string | null;
  value: ToolParamSource | null;
};

/** A call step with the forward-model `params` mirror beside `paramsExpr`. */
export type ToolCallStep = Extract<AuthoredStep, { kind: "tool" | "datasource" | "query" }> & {
  params?: Record<string, ToolParamValue>;
};

export type ToolParamRead = {
  rows: ToolParamRow[];
  overStepId: string | null;
  /**
   * True when the form is opaque: rows show their templates but offer no
   * picker — a picker there would rebuild from a blank map and discard the
   * hand-written logic the row just showed (component-panel.md §2).
   */
  readOnly: boolean;
};
export type ToolParamWrite = { ok: true; step: ToolCallStep } | { ok: false; error: string };

/** The refusal every writer below returns instead of rebuilding what it cannot read. */
export const TOOL_EXPRESSION_REFUSAL =
  "this parameter is set by an expression the rows cannot rebuild — edit it in the raw step, or replace the whole expression";

// ── Span-preserving pair scan ─────────────────────────────────────────────────
// Nothing existing does this: `parseParams` reads VALUES into the picker's
// vocabulary and fails closed on the rest, while a rows write must keep the
// unreadable bytes exactly where they are. So this scans the container text
// (`{…}` inside `[{…}]` or inside a fan-out jq program) and records each pair's
// spans; the writer splices one pair's replacement into those spans.

type PairSpan = {
  name: string;
  /** Offset of the key's opening quote — removal of a first pair starts here. */
  keyStart: number;
  /**
   * The value's text (trimmed) at the level the pair was split: raw text for
   * the single form, jq-program text (with `~` splices as sentinels) for a
   * fan-out. The writer's spans below are always in the patched container.
   */
  raw: string;
  valueStart: number;
  valueEnd: number;
};

type ObjectPairs = {
  pairs: PairSpan[];
  /** Offset of the closing `}` — the insertion point for a new pair. */
  braceClose: number;
};

/** Skip a Pebble `'chunk'` starting at `at` (the opening quote). -1 when unterminated. */
function skipChunk(s: string, at: number): number {
  const end = s.indexOf("'", at + 1);
  return end < 0 ? -1 : end + 1;
}

/** Skip a `"json string"` starting at `at` (the opening quote). -1 when unterminated. */
function skipJsonString(s: string, at: number): number {
  let i = at + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i += 1;
  }
  return -1;
}

/**
 * Split the `{…}` object starting at `open` (the `{` itself) into pairs.
 * Null when the braces do not balance — the caller then treats the form as opaque.
 *
 * Quote-blind to Pebble `'chunks'`: the single form never has them and a
 * fan-out program is scanned after `buildProgram` unwraps them, so a `'`
 * here is always literal text (an apostrophe in a fixed value).
 */
function splitPairs(container: string, open: number): ObjectPairs | null {
  const pairs: PairSpan[] = [];
  let i = open + 1;
  const n = container.length;
  // The pair currently being scanned, tracked as offsets (never substrings).
  let pairStart = -1;
  let depth = 0;
  const flush = (end: number): boolean => {
    if (pairStart < 0) return true;
    const text = container.slice(pairStart, end).trim();
    if (!text) {
      pairStart = -1;
      return true;
    }
    // `"name" : <value>` — quoted always; hand-written jq also allows a bare
    // identifier key (`title: …`), which the rows read but never emit.
    const keyMatch = /^(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_][A-Za-z0-9_]*))\s*:/.exec(text);
    if (!keyMatch) return false;
    let name: string;
    try {
      name = keyMatch[1] !== undefined ? (JSON.parse(`"${keyMatch[1]}"`) as string) : keyMatch[2]!;
    } catch {
      return false;
    }
    const valueText = text.slice(keyMatch[0].length).trim();
    if (!valueText) return false;
    const valueStart = pairStart + text.indexOf(valueText, keyMatch[0].length);
    pairs.push({ name, keyStart: pairStart, raw: valueText, valueStart, valueEnd: valueStart + valueText.length });
    pairStart = -1;
    return true;
  };
  while (i < n) {
    const c = container[i];
    if (c === '"') {
      if (pairStart < 0) pairStart = i;
      const next = skipJsonString(container, i);
      if (next < 0) return null;
      i = next;
      continue;
    }
    if (c === "{") {
      if (pairStart < 0) pairStart = i;
      depth += 1;
      i += 1;
      continue;
    }
    if (c === "}") {
      if (depth === 0) {
        if (!flush(i)) return null;
        return { pairs, braceClose: i };
      }
      depth -= 1;
      i += 1;
      continue;
    }
    if ((c === "[" || c === "(") && pairStart >= 0) {
      depth += 1;
      i += 1;
      continue;
    }
    if ((c === "]" || c === ")") && pairStart >= 0) {
      depth -= 1;
      i += 1;
      continue;
    }
    if (c === "," && depth === 0) {
      if (!flush(i)) return null;
      i += 1;
      continue;
    }
    if (pairStart < 0 && !/[\s,]/.test(c)) pairStart = i;
    i += 1;
  }
  return null;
}

/**
 * Find the params `{…}` object in a container (a `[{…}]` single form or an
 * unwrapped fan-out jq program) and split it. Null when the shape is not one
 * the rows patch.
 */
function objectPairsOf(container: string): (ObjectPairs & { braceOpen: number }) | null {
  let paren = 0;
  let i = 0;
  while (i < container.length) {
    const c = container[i];
    if (c === '"') {
      const next = skipJsonString(container, i);
      if (next < 0) return null;
      i = next;
      continue;
    }
    if (c === "(") paren += 1;
    else if (c === ")") paren -= 1;
    else if (c === "{" && paren === 0) {
      const split = splitPairs(container, i);
      if (!split) return null;
      if (!/^\]\s*$/.test(container.slice(split.braceClose + 1))) return null;
      return { ...split, braceOpen: i };
    }
    i += 1;
  }
  return null;
}

/**
 * Unwrap a fan-out `jq(…)` argument into its program, the way `parseFanOut`
 * does: `'chunks'` contribute their content and `~ ref ~` splices become
 * sentinel tokens. Every program character remembers the src span it came
 * from, so pair spans found at program level map back to patchable offsets.
 * Null when the argument is not chunked text the rows can read.
 */
type ProgramBuild = {
  program: string;
  pebble: string[];
  srcOf: Array<{ start: number; end: number }>;
};
/** A character no jq program here emits — the splice sentinel (same idea as `lib/flow-params`). */
const SPLICE_MARK = String.fromCharCode(0);
/** A splice token back to its `{{ref}}` for display and classification. */
const SPLICE_RE = new RegExp(`${SPLICE_MARK}(\\d+)${SPLICE_MARK}`, "g");

function buildProgram(src: string): ProgramBuild | null {
  let program = "";
  const pebble: string[] = [];
  const srcOf: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === "'") {
      const end = skipChunk(src, i);
      if (end < 0) return null;
      for (let k = i + 1; k < end - 1; k += 1) {
        program += src[k];
        srcOf.push({ start: k, end: k + 1 });
      }
      i = end;
      continue;
    }
    if (src[i] === "~" || /\s/.test(src[i]!)) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < src.length && src[j] !== "~") j += 1;
    const ref = src.slice(i, j).trim();
    if (!ref) return null;
    pebble.push(ref);
    const token = `${SPLICE_MARK}${pebble.length - 1}${SPLICE_MARK}`;
    for (const ch of token) {
      program += ch;
      srcOf.push({ start: i, end: j });
    }
    i = j;
  }
  return { program, pebble, srcOf };
}

/** A spliced program back to display text: each sentinel reads as its `{{ref}}`. */
function renderProgram(prog: string, pebble: string[]): string {
  return prog.replace(SPLICE_RE, (_, i: string) => `{{${pebble[Number(i)] ?? ""}}}`);
}
const FAN_OUT_ENVELOPE = /^\{\{\s*([\s\S]*?)\s*\|\s*jq\(([\s\S]*)\)\s*\|\s*first\s*\}\}$/;
const INPUT_TEMPLATE = /^\{\{\s*inputs\.([A-Za-z0-9_]+)\s*\}\}$/;

/** The rows address (`json(outputs.shape.value)`) back to its step, or null. */
function overStepOf(rows: string, steps: AuthoredStep[], shapes: OutputShapes): string | null {
  const want = rows.trim();
  for (const s of steps) if (rowsExpr(shapes, s)?.trim() === want) return s.id;
  return null;
}

/** Whether offset `at` sits inside a Pebble `'chunk'` — splice emitted differently there. */
function inChunk(src: string, at: number): boolean {
  let i = 0;
  while (i < at && i < src.length) {
    if (src[i] === "'") {
      const end = skipChunk(src, i);
      if (end < 0 || end > at) return true;
      i = end;
      continue;
    }
    i += 1;
  }
  return false;
}
/**
 * One pair's program-level value to its row feed. Bare `.field` / `.` name
 * the fan-out step's column; anything the rows cannot re-emit (a jq
 * concatenation, a transform wrapper, an input template) is an opaque
 * expression row. `pebble` renders splice sentinels for fan-out programs and
 * is empty for the single form, which never splices.
 */
function classifyValue(prog: string, overStepId: string | null, pebble: string[]): ToolParamSource | null {
  const spliced = prog.includes(SPLICE_MARK);
  const trimmed = renderProgram(prog, pebble).trim();
  if (spliced || INPUT_TEMPLATE.test(trimmed.replace(/^"|"$/g, "")) || (trimmed.startsWith("{{") && trimmed.endsWith("}}"))) {
    const inner = trimmed.replace(/^"|"$/g, "");
    return { kind: "expression", template: inner };
  }
  if (trimmed === '""') return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "string") {
      const inline = INPUT_TEMPLATE.exec(parsed);
      if (inline) return { kind: "expression", template: `{{inputs.${inline[1]}}}` };
      return { kind: "fixed", value: parsed };
    }
    return { kind: "fixed", value: trimmed };
  } catch {
    // Not JSON — a step-column reference or an opaque program.
  }
  const field = /^\.([A-Za-z0-9_]+)$/.exec(trimmed);
  if (field) return overStepId ? { kind: "step", stepId: overStepId, field: field[1]! } : { kind: "expression", template: trimmed };
  if (trimmed === ".") return overStepId ? { kind: "step", stepId: overStepId, field: "" } : { kind: "expression", template: trimmed };
  return { kind: "expression", template: trimmed };
}

type ReadForm =
  | {
      kind: "fanout";
      overStepId: string | null;
      src: string;
      srcStart: number;
      srcEnd: number;
      pebble: string[];
      obj: ObjectPairs & { braceOpen: number };
    }
  | { kind: "single"; obj: ObjectPairs & { braceOpen: number } }
  | { kind: "blank" }
  | { kind: "opaque" };

function readForm(raw: string, steps: AuthoredStep[], shapes: OutputShapes): ReadForm {
  if (!raw || !raw.trim() || raw.trim() === "[{}]") return { kind: "blank" };
  const fan = FAN_OUT_ENVELOPE.exec(raw.trim());
  if (fan) {
    const src = fan[2]!;
    const srcStart = raw.indexOf(src);
    const built = buildProgram(src);
    if (!built) return { kind: "opaque" };
    const scanned = objectPairsOf(built.program);
    if (!scanned) return { kind: "opaque" };
    // Program offsets back to patchable src spans. `raw` holds program text;
    // the spans below locate the same pair in the chunked src.
    const at = (pIdx: number): number => built.srcOf[pIdx]?.start ?? src.length;
    const through = (pIdx: number): number => built.srcOf[pIdx]?.end ?? src.length;
    const pairs: PairSpan[] = scanned.pairs.map((p) => ({
      name: p.name,
      keyStart: at(p.keyStart),
      raw: built.program.slice(p.valueStart, p.valueEnd),
      valueStart: at(p.valueStart),
      valueEnd: through(p.valueEnd - 1),
    }));
    const obj = { pairs, braceOpen: at(scanned.braceOpen), braceClose: at(scanned.braceClose) };
    return {
      kind: "fanout",
      overStepId: overStepOf(fan[1]!, steps, shapes),
      src,
      srcStart,
      srcEnd: srcStart + src.length,
      pebble: built.pebble,
      obj,
    };
  }
  const single = /^\[\s*\{[\s\S]*\}\s*\]$/.test(raw.trim());
  if (single) {
    const obj = objectPairsOf(raw);
    if (!obj) return { kind: "opaque" };
    return { kind: "single", obj };
  }
  return { kind: "opaque" };
}

/**
 * Every catalogue parameter with its current feed, in catalogue order, plus
 * any stored pair the catalogue no longer declares (kept as an expression
 * row so a renamed parameter stays visible instead of silently vanishing).
 */
export function readToolParamRows(
  step: ToolCallStep,
  params: CatalogueParam[],
  ctx: { steps: AuthoredStep[]; shapes: OutputShapes },
): ToolParamRead {
  // Read in the legacy input spelling the reader was built for (I-288) — see `writeToolParam`.
  const raw = toLegacyInputSpelling(step.paramsExpr);
  const form = readForm(raw, ctx.steps, ctx.shapes);
  if (form.kind === "opaque") {
    return {
      overStepId: null,
      readOnly: true,
      rows: params.map((p) => ({
        name: p.name,
        type: p.type,
        required: p.required,
        description: p.description,
        value: { kind: "expression", template: raw.trim() } as ToolParamSource,
      })),
    };
  }
  if (form.kind === "blank") {
    const record = step.params ?? {};
    return {
      overStepId: null,
      readOnly: false,
      rows: params.map((p) => ({
        name: p.name,
        type: p.type,
        required: p.required,
        description: p.description,
        value: record[p.name]?.source ?? null,
      })),
    };
  }
  const over = form.kind === "fanout" ? form.overStepId : null;
  const byName = new Map(form.obj.pairs.map((p) => [p.name, p]));
  const rows: ToolParamRow[] = params.map((p) => {
    const pair = byName.get(p.name);
    return {
      name: p.name,
      type: p.type,
      required: p.required,
      description: p.description,
      value: pair ? classifyValue(pair.raw, over, form.kind === "fanout" ? form.pebble : []) : null,
    };
  });
  for (const pair of form.obj.pairs) {
    if (params.some((p) => p.name === pair.name)) continue;
    rows.push({
      name: pair.name,
      type: "any",
      required: false,
      description: "Not declared by this ref — kept as-is.",
      value: { kind: "expression", template: renderProgram(pair.raw, form.kind === "fanout" ? form.pebble : []).trim() },
    });
  }
  return { rows, overStepId: over, readOnly: false };
}

/** A fixed row value to the pair text for its form. String params quote; the rest stays valid JSON or quotes. */
function encodeFixed(value: string, type: string): string {
  if (type === "string") return JSON.stringify(value);
  try {
    JSON.parse(value);
    return value.trim();
  } catch {
    return JSON.stringify(value);
  }
}

/**
 * A fixed string to a fan-out src fragment. A `'` inside the value would end
 * the Pebble chunk early, so the encoded text is split there and the quote
 * rejoined with `~ "'" ~` — the program jq sees is unchanged.
 */
function emitFixedSrc(encoded: string): string {
  if (!encoded.includes("'")) return encoded;
  return encoded
    .split("'")
    .map((part, i, all) => (i === 0 ? `'${part}` : i === all.length - 1 ? `${part}'` : `${part}`))
    .join(`' ~ "'" ~ '`);
}

/** An expression template to a fan-out src fragment. Only input templates and `{{`-free programs have one. */
function emitExpressionSrc(template: string): string | null {
  const input = INPUT_TEMPLATE.exec(template.trim());
  if (input) return `' ~ inputs.${input[1]} ~ '`;
  if (template.includes("{{")) return null;
  return template.trim();
}

function splicePair(container: string, pair: PairSpan | undefined, braceClose: number, name: string, emit: string | null): string {
  if (emit === null) return container;
  if (pair) return `${container.slice(0, pair.valueStart)}${emit}${container.slice(pair.valueEnd)}`;
  const sep = container.slice(0, braceClose).trimEnd().endsWith("{") ? "" : ", ";
  return `${container.slice(0, braceClose)}${sep}${JSON.stringify(name)}: ${emit}${container.slice(braceClose)}`;
}

/**
 * Set ONE parameter's feed; every other pair is preserved byte-for-byte.
 * A step pick fans the call out over that step when the form is not already a
 * fan-out over it; anything that would drop what the rows cannot say is refused.
 */
/**
 * ⚠ The TEXT editor below (`readForm` / `splicePair` / `removePair`) reads and writes the LEGACY input spelling it was built
 * for (`"{{ inputs.x }}"`, `"' ~ inputs.x ~ '"`). Since I-288 an input is stored as an escaped JSON literal — so the edit is
 * done in the legacy spelling and the result written back escaped. Without this the pair spans misread the escaped form and
 * an edit CORRUPTED the program (a lost `~ '`, measured by `StepInspector.data-kinds.test.tsx`).
 */
export function writeToolParam(
  step: ToolCallStep,
  name: string,
  spec: Pick<CatalogueParam, "type">,
  value: ToolParamSource | null,
  ctx: { steps: AuthoredStep[]; shapes: OutputShapes },
): ToolParamWrite {
  const r = writeToolParamLegacy({ ...step, paramsExpr: toLegacyInputSpelling(step.paramsExpr) }, name, spec, value, ctx);
  return r.ok ? { ...r, step: { ...r.step, paramsExpr: toEscapedInputSpelling(r.step.paramsExpr) } } : r;
}

function writeToolParamLegacy(
  step: ToolCallStep,
  name: string,
  spec: Pick<CatalogueParam, "type">,
  value: ToolParamSource | null,
  ctx: { steps: AuthoredStep[]; shapes: OutputShapes },
): ToolParamWrite {
  const raw = step.paramsExpr;
  const form = readForm(raw, ctx.steps, ctx.shapes);
  const withRecord = (paramsExpr: string): ToolParamWrite => {
    const record = { ...(step.params ?? {}) };
    if (value === null) delete record[name];
    else record[name] = { source: value };
    return { ok: true, step: { ...step, paramsExpr, params: record } };
  };
  // Dropping a pair the form never names only touches the mirror.
  if (value === null && (form.kind === "blank" || form.kind === "opaque")) {
    if (form.kind === "opaque") return { ok: false, error: TOOL_EXPRESSION_REFUSAL };
    return withRecord(raw);
  }
  if (form.kind === "opaque") return { ok: false, error: TOOL_EXPRESSION_REFUSAL };
  if (form.kind === "blank") {
    if (value === null) return withRecord(raw);
    if (value.kind === "fixed") return withRecord(`[{ ${JSON.stringify(name)}: ${encodeFixed(value.value, spec.type)} }]`);
    if (value.kind === "expression") {
      const emit = emitExpressionSrc(value.template);
      // A blank single form is JSON: only input templates and JSON survive it.
      if (emit === null || emit.includes("~")) {
        const input = INPUT_TEMPLATE.exec(value.template.trim());
        if (!input) return { ok: false, error: TOOL_EXPRESSION_REFUSAL };
        return withRecord(`[{ ${JSON.stringify(name)}: "{{ inputs.${input[1]} }}" }]`);
      }
      try {
        JSON.parse(emit);
      } catch {
        return { ok: false, error: TOOL_EXPRESSION_REFUSAL };
      }
      return withRecord(`[{ ${JSON.stringify(name)}: ${emit} }]`);
    }
    const over = ctx.steps.find((s) => s.id === value.stepId);
    if (!over) return { ok: false, error: `"${value.stepId}" is not a step in this flow.` };
    const built = buildFanOutParams(ctx.shapes, over, [{ param: name, source: { from: "step", stepId: value.stepId, field: value.field } }]);
    if (!built) return { ok: false, error: TOOL_EXPRESSION_REFUSAL };
    return withRecord(built);
  }
  if (form.kind === "single") {
    if (value?.kind === "step") {
      // A step field has no address in a call the step runs once with — fan
      // out over that step instead, rebuilt only when every other pair is
      // decomposable. Anything opaque stays untouched via refusal.
      const parsed = parseParams(ctx.shapes, ctx.steps, raw);
      if (!parsed || parsed.skipped.length > 0 || parsed.filterUnreadable || parsed.predicate) {
        return { ok: false, error: TOOL_EXPRESSION_REFUSAL };
      }
      const mappings: Mapping[] = parsed.mappings.filter((m) => m.param !== name);
      for (const m of mappings) if (m.source.from === "step" && !m.source.stepId) return { ok: false, error: TOOL_EXPRESSION_REFUSAL };
      const over = ctx.steps.find((s) => s.id === value.stepId);
      if (!over) return { ok: false, error: `"${value.stepId}" is not a step in this flow.` };
      mappings.push({ param: name, source: { from: "step", stepId: value.stepId, field: value.field } });
      const built = buildFanOutParams(ctx.shapes, over, mappings);
      if (!built) return { ok: false, error: TOOL_EXPRESSION_REFUSAL };
      return withRecord(built);
    }
    const container = raw;
    const pair = form.obj.pairs.find((p) => p.name === name);
    if (value === null) {
      if (!pair) return withRecord(raw);
      return withRecord(removePair(container, form.obj, pair));
    }
    let emit: string;
    if (value.kind === "fixed") emit = encodeFixed(value.value, spec.type);
    else {
      const asInput = INPUT_TEMPLATE.exec(value.template.trim());
      if (asInput) emit = `"{{ inputs.${asInput[1]} }}"`;
      else {
        try {
          JSON.parse(value.template.trim());
          emit = value.template.trim();
        } catch {
          return { ok: false, error: TOOL_EXPRESSION_REFUSAL };
        }
      }
    }
    return withRecord(splicePair(container, pair, form.obj.braceClose, name, emit));
  }
  // Fan-out: every `.field` reads the over step's row, so a step pick naming
  // another step is refused — writing it would silently repoint the field.
  if (value?.kind === "step") {
    if (!form.overStepId) return { ok: false, error: TOOL_EXPRESSION_REFUSAL };
    if (form.overStepId !== value.stepId) {
      return { ok: false, error: `this call runs once per row from ${form.overStepId} — pick a field from ${form.overStepId}.` };
    }
    const emit = value.field ? `.${value.field}` : ".";
    const next = splicePair(form.src, form.obj.pairs.find((p) => p.name === name), form.obj.braceClose, name, emit);
    return withRecord(raw.slice(0, form.srcStart) + next + raw.slice(form.srcEnd));
  }
  const pair = form.obj.pairs.find((p) => p.name === name);
  if (value === null) {
    if (!pair) return withRecord(raw);
    return withRecord(raw.slice(0, form.srcStart) + removePair(form.src, form.obj, pair) + raw.slice(form.srcEnd));
  }
  let emit: string;
  if (value.kind === "fixed") {
    emit = emitFixedSrc(encodeFixed(value.value, spec.type));
  } else {
    const asSrc = emitExpressionSrc(value.template);
    if (asSrc === null) return { ok: false, error: TOOL_EXPRESSION_REFUSAL };
    // An input splice is only spliceable inside a quoted chunk; anywhere else
    // the `~` would be Pebble syntax in the wrong place.
    if (asSrc.includes("~")) {
      const at = pair ? pair.valueStart : form.obj.braceClose;
      if (!inChunk(form.src, at)) return { ok: false, error: TOOL_EXPRESSION_REFUSAL };
    }
    emit = asSrc;
  }
  const next = splicePair(form.src, pair, form.obj.braceClose, name, emit);
  return withRecord(raw.slice(0, form.srcStart) + next + raw.slice(form.srcEnd));
}

/** Drop one pair, keeping the surrounding separators valid. */
function removePair(container: string, obj: { pairs: PairSpan[]; braceOpen: number; braceClose: number }, pair: PairSpan): string {
  const idx = obj.pairs.indexOf(pair);
  if (obj.pairs.length === 1) return `${container.slice(0, obj.braceOpen + 1)}${container.slice(obj.braceClose)}`;
  if (idx === 0) {
    const next = obj.pairs[1]!;
    return container.slice(0, obj.braceOpen + 1) + container.slice(next.keyStart);
  }
  const prev = obj.pairs[idx - 1]!;
  return container.slice(0, prev.valueEnd) + container.slice(pair.valueEnd);
}
