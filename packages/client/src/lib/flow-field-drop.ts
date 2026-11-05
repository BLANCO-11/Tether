// src/lib/flow-field-drop.ts — what a drop onto a NAMED target handle means.
//
// A card with known bindable inputs draws one target port per input (see
// `CanvasNode.inputHandles`). Dropping a link onto one of those ports binds
// that input to the link's source step — the canvas equivalent of picking
// "a field from the rows" for that parameter in the inspector.
//
// ── No new builders, no new rules ────────────────────────────────────────────
//
// The binding goes through the SAME builders the picker's `push` uses
// (`CallForm`/`OperationForm` in `StepInspector.tsx`):
//
//   * catalogue-param steps: the binding half delegates to `setBinding`
//     (`lib/step-binding.ts`) — the SAME writer the picker's rows use — with
//     `{ from: "step", stepId: from, field: "" }`, byte-identical to the
//     picker's first-pick default. A refused binding still lands the edge;
//   * `code` steps: the dropped contract input is bound through `setBinding`
//     too (→ `setCodeInputSource`), so every other input keeps its binding
//     and the typed bindings ride beside the re-rendered payload — unlike
//     the old `CodeForm.rowsFrom` reset, which rebuilt every other input
//     from null.
//
// The structural edge lands through the same `connect` op as a plain drop,
// so cycles, self-links and duplicates are refused the same way. A drop onto
// a card with no known fields never reaches here — the card draws its single
// unnamed target and the plain `onConnectSteps` path runs.
//
// Single-expression inputs (`transform`/`calculate` `expr`, `agent`
// `inputExpr`, approvals, branch guards) get no handles: there is no named
// parameter to bind, so they keep the single target and a drop only links.
import { connect, replaceStep, type AuthoredFlow, type AuthoredStep, type EditResult } from "@/lib/flow-authoring";
import type { FieldPort } from "@/lib/canvas-model";
import { soleStepRead, type OutputShapes } from "@/lib/flow-expr";
import { setBinding } from "@/lib/step-binding";
import { stepIo } from "@/lib/step-io";

/**
 * The catalogue surface a field drop needs: entry params by ref, and the
 * output shapes the fan-out builder resolves rows through. Every catalogue
 * mirror in the client (`StepInspector`'s, the palette's) satisfies this
 * structurally — no UI import required.
 */
export type FieldCatalogue = {
  entries: Array<{ ref: string; stepKind: string; params: Array<{ name: string }> }>;
  outputs: OutputShapes;
};

/**
 * The bindable inputs of one step, in handle order: every catalogue param of
 * the entry the step's ref names, or every `code` contract input. Empty when
 * the step has nothing a field drop can name — the card keeps its single
 * unnamed target.
 */
function bindableInputs(step: AuthoredStep, catalogue: FieldCatalogue): string[] {
  if (step.kind === "code") return step.contract.input.map((f) => f.name);
  if (!("paramsExpr" in step)) return [];
  if (typeof step.ref !== "string" || !step.ref) return [];
  const entry = catalogue.entries.find((e) => e.stepKind === step.kind && e.ref === step.ref);
  return entry ? entry.params.map((p) => p.name) : [];
}

/** What the card needs to draw one step's parameters honestly. */
export type StepPorts = {
  fields: FieldPort[];
  /**
   * The upstream step whose WHOLE output feeds every parameter.
   *
   * ⚠ Set exactly when the step has a non-blank `paramsExpr` naming a single
   * upstream step — which is the common, correct shape
   * (`{{ json(outputs.shape.value) }}`) and the reported bug's cause. Without
   * it the card has nowhere honest to land the edge.
   */
  wholeFrom: string | null;
  /**
   * False when the step's inputs are set by an expression no writer may
   * re-emit. The card then draws the inlet only — a drop on a param row would
   * rebuild the expression from a blank map and destroy it.
   */
  bindable: boolean;
};

/**
 * Which upstream step a whole-object `paramsExpr` reads, or null.
 *
 * ⚠ **Read from the EXPRESSION, not from `dependsOn`.** A step may depend on
 * several others (a merge tail, a guard's neighbour) while its params read one;
 * naming a dependency would attach the card's params handle to a step whose
 * value never reaches the call. Exactly one match counts — two `outputs.…`
 * reads mean the object is assembled from more than one place, and there is no
 * single step to point at.
 */
function wholeObjectSource(step: AuthoredStep, flow: AuthoredFlow): string | null {
  if (!("paramsExpr" in step) || typeof step.paramsExpr !== "string" || !step.paramsExpr.trim()) return null;
  // ⚠ ONE reader (D-197): `soleStepRead`, shared with the panel. Two copies of
  // "which step does this expression read" would drift in the direction where
  // the card's ports and its params handle name different steps.
  return soleStepRead(step.paramsExpr, flow);
}

/**
 * Per-step parameter ports for the canvas's `inputHandles` prop.
 *
 * `null` (or otherwise unreadable) catalogue ⇒ `undefined`: no prop, no
 * behaviour change. Steps with no known fields are absent from the map, and an
 * empty map likewise collapses to `undefined` — nothing to draw ports for is
 * the same picture as no catalogue.
 */
export function inputHandlesFor(
  flow: AuthoredFlow,
  catalogue: FieldCatalogue | null | undefined,
): Map<string, StepPorts> | undefined {
  if (!catalogue || !Array.isArray(catalogue.entries)) return undefined;
  const out = new Map<string, StepPorts>();
  for (const step of flow.steps) {
    const names = bindableInputs(step, catalogue);
    if (!names.length) continue;
    // ⚠ ONE reader: `stepIo` reports every input's source and whether the
    // step is re-emittable; this only projects the bindable names onto it.
    // `code` is covered by the same call — the `code` branch inside `stepIo`
    // already reads `inputExpr`.
    const io = stepIo(step, catalogue, flow.steps);
    const byName = new Map(io.inputs.map((i) => [i.name, i.source]));
    out.set(step.id, {
      fields: names.map((name) => ({ name, source: byName.get(name) ?? { kind: "unset" } })),
      wholeFrom: wholeObjectSource(step, flow),
      bindable: io.editable,
    });
  }
  return out.size ? out : undefined;
}

/**
 * Bind `field` of step `to` to step `from`, and land the structural edge.
 *
 * The edge goes through `connect` first: a refused link (cycle, self-link,
 * unknown step) binds nothing. An already-present edge is not a refusal here
 * — the binding still applies. When the field names nothing bindable (a stale
 * handle, a catalogue that moved) the edge still lands and the binding is
 * skipped: the drawn link is never lost to a naming disagreement.
 */
export function connectToField(
  flow: AuthoredFlow,
  catalogue: FieldCatalogue | null | undefined,
  from: string,
  to: string,
  field: string,
): EditResult {
  const target = flow.steps.find((s) => s.id === to);
  if (!target || !flow.steps.some((s) => s.id === from)) {
    return { ok: false, error: "both ends of a link must be steps in this flow" };
  }
  // `connect` refuses a duplicate edge; for a field drop the edge already
  // being there just means the binding is the only thing left to do.
  const alreadyLinked = (target.dependsOn ?? []).includes(from);
  const linked = alreadyLinked ? { ok: true as const, flow } : connect(flow, from, to);
  if (!linked.ok) return linked;
  if (!catalogue || !Array.isArray(catalogue.entries)) return linked;

  const on = linked.flow.steps.find((s) => s.id === to)!;

  // `code`: the dropped input is bound through the SAME writer the picker's
  // rows use (`setBinding` → `setCodeInputSource`) — every other input keeps
  // its binding (unlike the old `rowsFrom` reset, which rebuilt from nulls),
  // and the typed bindings ride beside the re-rendered payload. A refused
  // binding (a hand-shaped payload no writer may re-emit) still lands the
  // edge and keeps the payload: the drawn link is never lost to an
  // expression no writer may re-emit.
  if (on.kind === "code") {
    if (!on.contract.input.some((f) => f.name === field)) return linked;
    const onStep = linked.flow.steps.find((s) => s.id === to)!;
    const bound = setBinding(onStep, catalogue, linked.flow, field, { from: "step", stepId: from, field: "" });
    if (!bound.ok) return linked;
    return replaceStep(linked.flow, to, bound.step);
  }
  // A stale handle or a catalogue that moved names nothing bindable — the edge
  // still lands and the binding is skipped.
  if (!("paramsExpr" in on) || typeof on.ref !== "string" || !on.ref) return linked;
  const entry = catalogue.entries.find((e) => e.stepKind === on.kind && e.ref === on.ref);
  if (!entry || !entry.params.some((p) => p.name === field)) return linked;
  // The binding half delegates to `setBinding` — the same writer the
  // picker's rows use — so a drop and a picker cannot drift. A refused binding
  // still lands the edge (today's rule): the drawn link is never lost to an
  // expression no writer may re-emit.
  const onStep = linked.flow.steps.find((s) => s.id === to)!;
  const bound = setBinding(onStep, catalogue, linked.flow, field, { from: "step", stepId: from, field: "" });
  if (!bound.ok) return linked;
  return replaceStep(linked.flow, to, bound.step);
}
