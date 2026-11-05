/**
 * **Why a schedule cannot be armed yet — and it is TWO reasons, not one.**
 * 2026-09-17
 *
 * ── The gate this belongs to ────────────────────────────────────────────────
 *
 * An armed schedule fires with NO caller. A required input with no default and
 * no derivation therefore has no value source at 09:00: Kestra refuses to
 * create the run, which is a guaranteed failure deployed in advance. So
 * `flowApprovalService.approve` refuses first, naming the inputs.
 *
 * ── ⚠ THE DEFECT: ONE REFUSAL, TWO SITUATIONS, AND ONLY ONE REMEDY ──────────
 *
 * The refusal offered three remedies — give it a default, derive it from the
 * firing time, compute it in a step — and every one of them assumes the input
 * is WANTED. Measured on the running deployment: of the flows declaring an
 * unresolvable required input, **two declared one that no expression in the
 * flow reads at all.** The drafter declared it and the step that would have
 * used it was later rewritten; the declaration stayed behind.
 *
 * For those, all three remedies are wrong. Writing a default invents a value
 * nothing consumes — §6.7's own failure with the blame moved onto the person —
 * and the honest fix, removing the declaration (`remove_input`, which exists
 * and is refused while anything still reads the input), was not mentioned. So a
 * tested workflow was unschedulable and the refusal pointed away from the one
 * action that would have unblocked it.
 *
 * ⚠ **It still REFUSES, and that is deliberate.** The compiler emits every
 * declared input with its `required:` flag, so Kestra demands a value for a
 * dead input exactly as it does for a live one. Letting an unread input through
 * here would move a refusal a person can act on at authoring time into a run
 * that dies at 09:00 with nobody watching — the trade D-52 refuses everywhere
 * else. Two refusals, two actions (D-66's rule): this changes which action is
 * named, never whether one is needed.
 */
import { inputsReadBy } from "./flow-input-refs.js";
import { EXPRESSION_FIELDS } from "./flow-expression.service.js";
import { unresolvedRequiredInputs } from "./flow-inputs.js";
import type { FlowModel } from "./flow-compiler.service.js";

export interface ScheduleInputBlock {
  /** Declared, required, no value source — and something reads it. */
  wanted: string[];
  /** Declared, required, no value source — and NOTHING in the flow reads it. */
  unread: string[];
}

/**
 * Split the unresolvable required inputs by whether the flow actually reads them.
 *
 * ⚠ **`inputsReadBy` over `EXPRESSION_FIELDS`, never a fresh scan.** That pair
 * is how `checkDeclaredInputs` asks the opposite half of the same question
 * ("does a step read something nobody declared?"), and two readers of
 * `inputs.<name>` that disagree would land on a person as a refusal naming an
 * input they can see being used. D-197.
 */
export function scheduleInputBlock(model: FlowModel): ScheduleInputBlock {
  const unresolvable = unresolvedRequiredInputs(model);
  if (!unresolvable.length) return { wanted: [], unread: [] };
  const read = new Set<string>();
  for (const step of (model.steps ?? []) as unknown as Array<Record<string, unknown>>) {
    for (const name of inputsReadBy(step, EXPRESSION_FIELDS)) read.add(name);
  }
  return {
    wanted: unresolvable.filter((i) => read.has(i.id)).map((i) => i.id),
    unread: unresolvable.filter((i) => !read.has(i.id)).map((i) => i.id),
  };
}

const quote = (ids: string[]) => ids.map((i) => `"${i}"`).join(", ");

/**
 * The refusal, or `null` when the schedule may be armed.
 *
 * ⚠ Both halves are named when both are present, because fixing one and being
 * refused again over the other is the round trip this exists to remove.
 */
export function scheduleInputRefusal(model: FlowModel): string | null {
  if (!model.schedule) return null;
  const { wanted, unread } = scheduleInputBlock(model);
  if (!wanted.length && !unread.length) return null;

  const parts = [
    `this flow runs on a schedule, and a schedule fires with no caller, so every required ` +
      `input needs a value source before it can be armed.`,
  ];
  if (wanted.length) {
    parts.push(
      `${wanted.length} required input(s) are read by a step but have no default: ` +
        `${quote(wanted)}. Give each one a default expression (e.g. ` +
        `{{ execution.startDate | date('yyyy-MM') }} for the current month), derive it from ` +
        `the run's firing time, or compute the value in a step instead of declaring it.`,
    );
  }
  if (unread.length) {
    parts.push(
      `${unread.length} required input(s) have no default AND are read by no step in this ` +
        `automation: ${quote(unread)}. Kestra still demands a value for a declared required ` +
        `input, so a schedule cannot start — but a default here would be a value nothing uses. ` +
        `Remove the declaration instead (ask in chat: "remove the ${unread[0]} input"), or wire ` +
        `it into the step that was meant to read it.`,
    );
  }
  return parts.join(" ");
}
