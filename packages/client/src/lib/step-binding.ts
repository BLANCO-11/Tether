// src/lib/step-binding.ts — the ONE writer for a call step's inputs.
//
// ── ⚠ WHY THIS EXISTS: THE FORM WAS WRITE-ONLY ───────────────────────────────
//
// `CallForm`/`OperationForm` initialised their mappings to `{}` and never read
// `step.paramsExpr`, so editing one binding rebuilt the WHOLE expression from
// the in-memory map and silently dropped every other one. Every write here
// starts from `parseParams`' read-back of the CURRENT expression, applies one
// change, and re-emits — a single-input edit cannot destroy bindings nobody
// could see. `flow-field-drop.connectToField` delegates here, so a drop and a
// picker cannot drift.
//
// ── ⚠ NO SILENT REBUILDS ─────────────────────────────────────────────────────
//
// Any write path that cannot re-emit the current expression refuses with
// `EXPRESSION_REFUSAL` and touches nothing. Rebuilding from a blank map would
// discard a hand-written expression that worked; the panel offers the explicit
// `toSimpleBindings` convert action instead.

import type { AuthoredFlow, AuthoredStep } from "@/lib/flow-authoring";
import type { InputBinding, Source as TypedSource } from "@foundry/flow-edit";
// ⚠ Stage 3.2: the builders render from `@foundry/flow-edit` (`render.ts`) —
// the one module the panel, the server compiler and the stored-model upgrade
// share. The picker's narrow `Source`/`Mapping` still come from `flow-expr`
// (narrow assigns to wide); only the string assembly moved.
import { buildCodeInput, buildFanOutParams, buildSingleParams } from "@foundry/flow-edit";
import {
  soleStepRead,
  type CodeInputValue,
  type ItemPredicate,
  type Mapping,
  type OutputShapes,
  type Source,
} from "@/lib/flow-expr";
import { parseParams, type ParsedParams } from "@/lib/flow-params";
import { codeInputEditable, codeInputSources, type InputSource, type IoCatalogue } from "@/lib/step-io";

/** One parameter write, applied or refused — never half-applied. */
export type InputEdit = { ok: true; step: AuthoredStep } | { ok: false; error: string };

/**
 * The refusal every writer returns when the current expression is not one the
 * builder can re-emit. The panel renders the convert action beside it; the
 * card lands the edge and skips the binding.
 */
export const EXPRESSION_REFUSAL =
  "this step's inputs are set by an expression — edit the expression, or replace it with simple bindings";

type CallStep = Extract<AuthoredStep, { ref: string }>;

function isCallStep(step: AuthoredStep): step is CallStep {
  return "paramsExpr" in step && "ref" in step && typeof step.ref === "string";
}

function shapesOf(catalogue: IoCatalogue): OutputShapes {
  return catalogue.outputs as unknown as OutputShapes;
}

/** The over step the current expression names, falling back to the head dependency. */
function resolveOver(flow: AuthoredFlow, overStepId: string | null, step: AuthoredStep): AuthoredStep | null {
  const id = overStepId ?? step.dependsOn?.[0] ?? null;
  if (!id) return null;
  return flow.steps.find((s) => s.id === id) ?? null;
}

/**
 * The picker's `Source` as the STORED typed binding. The client source is a
 * structural superset of the registry's (it also carries the column
 * `transform` a projection was written with), so this is a narrowing
 * projection, never a guess — and the runtime value keeps the transform the
 * display string was rendered with.
 */
function toTypedSource(source: Source): TypedSource {
  if (source.from === "step" && source.transform) {
    const { transform, ...rest } = source;
    return { ...rest, transform } as TypedSource;
  }
  return source;
}

 function emit(
   step: CallStep,
   shapes: OutputShapes,
   over: AuthoredStep | null,
   list: Mapping[],
   predicate: ItemPredicate | undefined,
   steps: readonly AuthoredStep[],
 ): InputEdit {
   const expr = over ? buildFanOutParams(shapes, over, list, predicate) : buildSingleParams(list, { shapes, steps });
   if (expr === null) return { ok: false, error: EXPRESSION_REFUSAL };
  // ⚠ DUAL REPRESENTATION (Stage 3): the typed bindings are the stored truth
  // the panel will read; the display string is rendered beside them for the
  // Stage-4 panel, which still reads expressions. Both come from the one
  // `list`, so they cannot disagree about what was MEANT — the single-call
  // form builds step reads from ONE upstream in jq and refuses two (see
  // `buildSingleParams`); only `self` still has no single-call spelling.
  const inputs: InputBinding[] = list.map((m) => ({ name: m.param, source: toTypedSource(m.source) }));
  return { ok: true, step: { ...step, paramsExpr: expr, inputs } };
 }

/** A blank expression carries no mappings yet — the only readable empty state. */
function readableOrBlank(
  shapes: OutputShapes,
  steps: AuthoredStep[],
  raw: string,
): { blank: boolean; parsed: ParsedParams | null } {
  const blank = !raw.trim();
  const parsed = parseParams(shapes, steps, raw);
  return { blank, parsed };
}

/**
 * Set ONE parameter's source; every other binding is preserved exactly.
 *
 * `source: null` removes the parameter from the mappings. Refuses when the
 * current expression is non-blank and the builder cannot re-emit it
 * (`parseParams` → null, an unreadable filter, or skipped pairs a rebuild
 * would drop) — the step is returned untouched.
 */
export function setInputSource(
  step: AuthoredStep,
  catalogue: IoCatalogue,
  flow: AuthoredFlow,
  param: string,
  source: Source | null,
): InputEdit {
  if (!isCallStep(step)) return { ok: false, error: EXPRESSION_REFUSAL };
  const shapes = shapesOf(catalogue);
  const { blank, parsed } = readableOrBlank(shapes, flow.steps, step.paramsExpr);
  if (!blank && (!parsed || parsed.filterUnreadable || parsed.skipped.length > 0))
    return { ok: false, error: EXPRESSION_REFUSAL };
  const next = new Map((parsed?.mappings ?? []).map((m) => [m.param, m.source]));
  if (source === null) next.delete(param);
  else next.set(param, source);
  const list: Mapping[] = [...next.entries()].map(([p, s]) => ({ param: p, source: s }));
  return emit(step, shapes, resolveOver(flow, parsed?.overStepId ?? null, step), list, parsed?.predicate ?? undefined, flow.steps);
}

/**
 * Which upstream step's rows the call fans out over (`null` = called once).
 * The mappings and the row filter carry over unchanged; refuses on an
 * expression the builder cannot re-emit, like `setInputSource`.
 */
export function setOverStep(
  step: AuthoredStep,
  catalogue: IoCatalogue,
  flow: AuthoredFlow,
  overStepId: string | null,
): InputEdit {
  if (!isCallStep(step)) return { ok: false, error: EXPRESSION_REFUSAL };
  const shapes = shapesOf(catalogue);
  const { blank, parsed } = readableOrBlank(shapes, flow.steps, step.paramsExpr);
  if (!blank && (!parsed || parsed.filterUnreadable || parsed.skipped.length > 0))
    return { ok: false, error: EXPRESSION_REFUSAL };
  const list: Mapping[] = (parsed?.mappings ?? []).map((m) => ({ ...m }));
  const over = overStepId ? (flow.steps.find((s) => s.id === overStepId) ?? null) : null;
  return emit(step, shapes, over, list, parsed?.predicate ?? undefined, flow.steps);
}
/**
 * Set the per-item row filter (`where`), re-emitting the expression with the
 * `select(…)` — the same emit discipline as every other writer, so the
 * display and the typed filter cannot disagree about which rows become calls.
 * `null` clears the filter AND drops the stored `where` (absent = unfiltered).
 * Refuses without an over step: a filter with no rows filters nothing, and a
 * stored `where` beside a display that never named rows is exactly the
 * disagreement above wearing patience.
 */
export function setWherePredicate(
  step: AuthoredStep,
  catalogue: IoCatalogue,
  flow: AuthoredFlow,
  predicate: ItemPredicate | null,
): InputEdit {
  if (!isCallStep(step)) return { ok: false, error: EXPRESSION_REFUSAL };
  const shapes = shapesOf(catalogue);
  const { blank, parsed } = readableOrBlank(shapes, flow.steps, step.paramsExpr);
  const storedOver = "over" in step && step.over ? step.over.stepId : null;
  // No head-dependency fallback: a dependency is not a fan-out, and the old
  // picker only rendered beside one. `resolveOver`'s fallback belongs to
  // `setOverStep`/`setInputSource`, which need an over object to render with.
  const overId = parsed?.overStepId ?? storedOver;
  const over = overId ? (flow.steps.find((s) => s.id === overId) ?? null) : null;
  if (predicate && !over) {
    return {
      ok: false,
      error: "a row filter needs rows — pick which step's rows this fans out over first",
    };
  }
  if (
    predicate &&
    (predicate.test === "field_gt" ||
      predicate.test === "field_gte" ||
      predicate.test === "field_lt" ||
      predicate.test === "field_lte") &&
    !Number.isFinite(Number(predicate.value))
  ) {
    return {
      ok: false,
      error: `"${predicate.test}" compares numbers — "${predicate.value ?? ""}" is not one, and a filter that matches nothing is a silent no-op`,
    };
  }
  const list: Mapping[] = (parsed?.mappings ?? []).map((m) => ({ ...m }));
  const r = emit(step, shapes, over, list, predicate ?? undefined, flow.steps);
  if (!r.ok) return r;
  // The typed `where` rides beside the re-emitted display: the typed path
  // (inputs non-empty, display dropped) keeps the filter from here, the parse
  // path re-derives it from the `select(…)` — both read the same picks.
  if (!predicate) {
    const next = { ...r.step };
    if ("where" in next) delete next.where;
    return { ok: true, step: next };
  }
  // The display carries the full predicate (its builder speaks `gte`/`lte`);
  // the STORED `where` carries only what the server's `branchTestSchema`
  // accepts. A gapless-band test lives in the re-emitted `select(…)` and the
  // parse path re-derives nothing — same asymmetry as the upgrade's
  // `storableWhere`, which refuses those spellings rather than storing them.
  if (predicate.test === "field_gte" || predicate.test === "field_lte") {
    const next = { ...r.step };
    if ("where" in next) delete next.where;
    return { ok: true, step: next };
  }
  // Impossible when `emit` preserves the kind it was given — and the guard
  // the spread below needs: only the call member carries `where`.
  if (!isCallStep(r.step)) return r;
  const base = r.step;
  return {
    ok: true,
    step: {
      ...base,
      where: {
        field: predicate.field ?? "",
        test: predicate.test,
        ...(predicate.value !== undefined ? { value: predicate.value } : {}),
      },
    },
  };
}

/**
 * Replace a hand-written expression with the builder's simple bindings.
 *
 * The over step is recovered from the parse, else from the one step the
 * expression reads, else from the head dependency; the mappings are whatever
 * the parse recovered (none when it was hand-written). The row filter is
 * dropped — the only loss, and the confirm copy names it. Refuses only when
 * the step has no `paramsExpr` field at all.
 */
export function toSimpleBindings(step: AuthoredStep, catalogue: IoCatalogue, flow: AuthoredFlow): InputEdit {
  if (!isCallStep(step)) return { ok: false, error: "this step has no parameters expression" };
  const shapes = shapesOf(catalogue);

  const blank = !step.paramsExpr.trim();
  const parsed = parseParams(shapes, flow.steps, step.paramsExpr);
  const read = !blank && !parsed ? soleStepRead(step.paramsExpr, flow) : null;
  const list: Mapping[] = (parsed?.mappings ?? []).map((m) => ({ ...m }));
  return emit(step, shapes, resolveOver(flow, parsed?.overStepId ?? read, step), list, undefined, flow.steps);
}
/**
 * A read-back `InputSource` as the STORED typed binding. `unset`/`unknown`
 * are the absence of a binding, so they store as `null` — the panel's third
 * state survives only on the display side, for steps the upgrade could not
 * read (see `step-io.ts`).
 */
function inputSourceToTyped(source: InputSource): TypedSource | null {
  switch (source.kind) {
    case "step": {
      const out: { from: "step"; stepId: string; field: string; transform?: "date" | "text" | "number" } = {
        from: "step",
        stepId: source.stepId,
        field: source.field,
      };
      if (source.transform) out.transform = source.transform;
      return out;
    }
    case "whole":
      return { from: "whole", stepId: source.stepId };
    case "input":
      return { from: "input", inputId: source.inputId };
    case "literal":
      return { from: "literal", value: source.value };
    case "self":
      return { from: "self" };
    case "unset":
    case "unknown":
    case "tokens":
      return null;
  }
}

/**
 * The picker's `Source` as the payload reader's `InputSource`: the step id
 * travels unresolved (resolution happens below, against this flow), and
 * `self` — the bare per-row element — becomes unbound, having no address in a
 * payload the step runs once with.
 */
function sourceToInput(source: Source | null): InputSource {
  if (!source) return { kind: "unset" };
  if (source.from === "step") {
    return source.transform
      ? { kind: "step", stepId: source.stepId, field: source.field, transform: source.transform }
      : { kind: "step", stepId: source.stepId, field: source.field };
  }
  if (source.from === "input") return { kind: "input", inputId: source.inputId };
  if (source.from === "literal") return { kind: "literal", value: source.value };
  return { kind: "unset" };
}

/**
 * Set ONE `code` contract input's source; every other contract input keeps its
 * current binding (unbound → null) and the payload is rebuilt with
 * `buildCodeInput` over the whole contract. The FULL picker source travels —
 * a whole-rows bind, a column projection, a flow input, or a fixed string —
 * and reads back through `codeInputSources`, so an edit preserves bindings it
 * cannot see. Refuses when the payload is hand-shaped — blank or builder
 * shapes over exactly the contract names are the only payloads a rebuild
 * preserves. A param name no contract declares is a stale handle: the step is
 * returned unchanged.
 */
export function setCodeInputSource(
  step: AuthoredStep,
  catalogue: IoCatalogue,
  flow: AuthoredFlow,
  param: string,
  source: Source | null,
): InputEdit {
  if (step.kind !== "code") return { ok: false, error: EXPRESSION_REFUSAL };
  const names = step.contract.input.map((f) => f.name);
  if (!names.includes(param)) return { ok: true, step };
  if (!codeInputEditable(step.inputExpr, names)) return { ok: false, error: EXPRESSION_REFUSAL };
  const shapes = shapesOf(catalogue);
  const byId = new Map(flow.steps.map((s) => [s.id, s]));
  const current = new Map(
    codeInputSources(step.inputExpr, names, { steps: flow.steps, shapes }).map((b) => [b.name, b.source]),
  );
  current.set(param, sourceToInput(source));
  const fields: Array<{ name: string; source: CodeInputValue }> = names.map((name) => {
    const from = current.get(name);
    if (!from || from.kind === "unset" || from.kind === "unknown") return { name, source: null };
    if (from.kind === "step") {
      const target = byId.get(from.stepId) ?? null;
      return {
        name,
        source: target ? { kind: "step", step: target, field: from.field, transform: from.transform } : null,
      };
    }
    if (from.kind === "input") return { name, source: { kind: "input", inputId: from.inputId } };
    if (from.kind === "literal") return { name, source: { kind: "literal", value: from.value } };
    // `whole` and `self` have no writer of their own here: a recovered `whole`
    // IS a step's whole rows, so it re-emits as one; `self` names no address
    // in a once-run payload and binds nothing.
    if (from.kind === "whole") {
      const target = byId.get(from.stepId) ?? null;
      return { name, source: target ? { kind: "step", step: target, field: "" } : null };
    }
    return { name, source: null };
  });
  // ⚠ DUAL REPRESENTATION (Stage 3): the typed bindings ride beside the
  // re-rendered payload, read from the same `current` map the payload is
  // built from — so a `whole` stays a `whole` here even though the payload
  // spells it as a field-less step read.
  const inputs: InputBinding[] = names.map((name) => {
    const typed = inputSourceToTyped(current.get(name) ?? { kind: "unset" });
    // A field-less step bind IS the step's whole rows: the payload spells it
    // as a bare rows address and reads back `whole`, so the typed side names
    // it `whole` too — or the two halves disagree about the same binding.
    if (typed && typed.from === "step" && typed.field === "") return { name, source: { from: "whole", stepId: typed.stepId } };
    return { name, source: typed };
  });
  return { ok: true, step: { ...step, inputExpr: buildCodeInput(shapes, fields), inputs } };
}

/**
 * Set ONE named input's source on ANY step — the one writer drops and pickers
 * route through. Dispatches to the call writer or the code writer, so the
 * refusal rules and the dual representation are identical whichever surface
 * the edit came from. A kind with no named bindings (transform, branch,
 * approval, merge) is refused, never half-written.
 */
export function setBinding(
  step: AuthoredStep,
  catalogue: IoCatalogue,
  flow: AuthoredFlow,
  param: string,
  source: Source | null,
): InputEdit {
  if (step.kind === "code") return setCodeInputSource(step, catalogue, flow, param, source);
  return setInputSource(step, catalogue, flow, param, source);
}
