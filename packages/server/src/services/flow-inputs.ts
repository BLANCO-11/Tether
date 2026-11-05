/**
 * Where an automation's input VALUES come from.
 * platform-coherence Phase 4 · I-107 · D-113
 *
 * ── ⚠ THE ONE RULE ──────────────────────────────────────────────────────────
 *
 * **A value comes from the person, from a step's output, or it does not exist.**
 * Never from a model's judgement about what would be reasonable.
 *
 * That sentence is §6.7, D-38 and D-107 said once more, and the measured failure
 * behind all three is the same: a generated script that hardcoded
 * `period="2023-10"`, emailed 0 of 11 people, and exited 0 with
 * `tests_passed=true` and audit `clean`. Nothing about it looked wrong. The
 * whole Kestra migration exists because of that run.
 *
 * ── What was actually happening here, before Phase 4 ────────────────────────
 *
 * `draftResponseSchema` lets the drafter return `defaults` on a declared input,
 * and `splitDraft` passed it straight into the model. `flow-compiler.service.ts`
 * emits it as `defaults:` in the Kestra YAML — so a scheduled or triggered run
 * with nothing supplied used **the model's guess**, silently, for ever.
 *
 * That is `period="2023-10"` with a different file around it. It is not
 * hypothetical and it is not mitigated by the drafter usually being right:
 * nothing downstream can tell a default the goal stated ("for June 2026") from
 * one the model chose because a date was needed and none was given.
 *
 * ── So a drafted default is a SUGGESTION, and suggestions do not run ─────────
 *
 * `splitDraft` strips `defaults` off every drafted input and carries it out
 * separately. The flow is created with the inputs DECLARED and no values, and a
 * person confirms them — at which point the value came from a person and may be
 * written into the model as a real default.
 *
 * ⚠ **Confirming is a REVISION**, and has to be: `defaults` is part of what a
 * scheduled run does, so changing one changes behaviour, and behaviour changes
 * are what approval binds to (§6.5). Storing values beside the model instead
 * would create a second source for one fact, and the two would disagree.
 *
 * ⚠ **This is not a retry channel** (4.4). Confirming an input carries values
 * for DECLARED inputs and nothing else — no goal, no instruction, no redraft.
 * A question about the goal is a resubmission, and re-asking a refusal is
 * precisely how a correct `insufficient_contract` becomes an invention on
 * attempt two. The protection is structural: `confirmInputsSchema` has no field
 * for one, and `applyInputValues` refuses an id the model did not declare.
 */
import { z } from "zod";
import type { ComputedInputFn, FlowInput, FlowModel } from "./flow-compiler.service.js";

/**
 * A value the drafter proposed for an input, carried OUT of the model.
 *
 * ⚠ It is shown for confirmation and never applied. The distinction it exists to
 * preserve is the one nothing downstream can make: whether "2026-06" came from
 * the goal saying *for June 2026* or from a model needing a date and having
 * none.
 */
export interface InputSuggestion {
  id: string;
  value: string;
}

/** Input semantics shared by generation, approval, validation, and triggers. */
export function isFlowInputRequired(input: Pick<FlowInput, "required">): boolean {
  return input.required !== false;
}

/**
 * An explicitly supplied empty string is still a default value — and a
 * derivation is a decided value. `computed` names how the engine supplies the
 * input at run creation, so an input carrying it is answered for every gate
 * that asks "does this input have a value" (`unresolvedRequiredInputs`,
 * `unresolvedInputs`, the approval gate): decided-by-derivation is decided.
 */
export function hasFlowInputDefault(input: Pick<FlowInput, "defaults" | "computed">): boolean {
  return input.defaults !== undefined || input.computed !== undefined;
}

export function unresolvedRequiredInputs(model: Pick<FlowModel, "inputs">): FlowInput[] {
  return (model.inputs ?? []).filter(
    (input) => isFlowInputRequired(input) && !hasFlowInputDefault(input),
  );
}

/**
 * Take the drafter's proposed defaults out of the model.
 *
 * ⚠ Applied to DRAFTED inputs only. A model authored on the canvas or posted by
 * a harness carries defaults its author chose, which already satisfies the rule
 * — stripping those would be removing a person's own value in the name of not
 * inventing one.
 */
export function stripSuggestedDefaults(inputs: FlowInput[] | undefined): {
  inputs: FlowInput[] | undefined;
  suggestions: InputSuggestion[];
} {
  if (!inputs?.length) return { inputs, suggestions: [] };
  const suggestions: InputSuggestion[] = [];
  const stripped = inputs.map((i) => {
    if (i.defaults === undefined) return i;
    suggestions.push({ id: i.id, value: i.defaults });
    const { defaults: _dropped, ...rest } = i;
    return rest;
  });
  return { inputs: stripped, suggestions };
}

/**
 * Which declared inputs still have no value.
 *
 * ⚠ An input with `defaults: ""` counts as ANSWERED. An empty string is a value
 * somebody can legitimately mean, and treating it as missing would make a
 * confirmed answer un-confirmable — the person would be asked the same question
 * for ever with no way to end it.
 */
export function unresolvedInputs(model: Pick<FlowModel, "inputs">): FlowInput[] {
  return (model.inputs ?? []).filter((i) => !hasFlowInputDefault(i));
}

/**
 * What a person may send: values for declared inputs, and nothing else.
 *
 * ⚠ **There is deliberately no `goal`, no `instruction` and no `regenerate`.**
 * The whole risk of a clarification exchange is that it becomes a retry with a
 * friendlier interface, and the protection is that the route has nowhere to put
 * one — the same structural protection `refineFlowSchema` uses (D-112).
 */
export const confirmInputsSchema = z.object({
  values: z.record(z.string().max(2000)),
  /**
   * "Derive it when the run starts" — one of the six closed derivations, per
   * input. Same unknown-id refusal as `values` (via `applyInputValues`).
   */
  computed: z
    .record(z.enum(["priorMonth", "currentMonth", "priorDate", "currentDate", "currentYear", "runTimestamp", "currentMonthStart", "priorMonthStart"]))
    .optional(),
  /** Raw and untrusted, exactly as on `createFlowSchema`. */
  createdBy: z.string().min(1).max(255).optional(),
});

export class UnknownInputError extends Error {
  constructor(public readonly ids: string[], declared: string[]) {
    super(
      `this automation does not declare ${ids.map((i) => `"${i}"`).join(", ")}. ` +
        `It declares: ${declared.length ? declared.map((d) => `"${d}"`).join(", ") : "no inputs at all"}.`,
    );
    this.name = "UnknownInputError";
  }
}

/**
 * Write confirmed values into the model as real defaults.
 *
 * ⚠ **Refuses an id the model did not declare**, rather than ignoring it. An
 * ignored key is a value a person believes they supplied and which nothing uses
 * — the silent half of the same defect this module is about, arriving from the
 * person's side instead of the model's.
 *
 * ⚠ It writes NOTHING but what it was handed. There is no "fill in the rest",
 * no carrying a suggestion through unconfirmed, and an input left out of
 * `values` keeps whatever it had. That absence is the rule. A `computed` entry
 * writes a derivation the same way a value writes a default — and clears the
 * other side, so one input never carries both answers.
 */
export function applyInputValues(
  model: FlowModel,
  values: Record<string, string>,
  computed?: Record<string, ComputedInputFn>,
): FlowModel {
  const declared = (model.inputs ?? []).map((i) => i.id);
  const unknown = [...Object.keys(values), ...Object.keys(computed ?? {})].filter(
    (k) => !declared.includes(k),
  );
  if (unknown.length) throw new UnknownInputError(unknown, declared);
  if (!model.inputs?.length) return model;
  return {
    ...model,
    inputs: model.inputs.map((i) => {
      // One answer per input: a literal clears a derivation, a derivation
      // clears a literal — the same exclusivity `flowModelSchema` enforces.
      if (computed?.[i.id] !== undefined) {
        const { defaults: _cleared, ...rest } = i;
        return { ...rest, computed: computed[i.id]! };
      }
      if (i.id in values) {
        const { computed: _cleared, ...rest } = i;
        return { ...rest, defaults: values[i.id]! };
      }
      return i;
    }),
  };
}
