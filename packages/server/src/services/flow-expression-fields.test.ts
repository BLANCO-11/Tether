/**
 * ⚠ **THE FIELD UNDER AN ALLOWED ROOT, and the live failure it caused.**
 *
 * A chat-built flow shipped `[{"as_of":"{{ execution.startedAt }}"}]`. `execution`
 * is on D-22's allowlist, so the expression passed every static check,
 * compiled, deployed and armed — then died at runtime:
 *
 *     Unable to find `startedAt` used in the expression … at line 6
 *
 * A message that names a field and not a cause, on a flow a person had already
 * approved. D-22 has always governed ROOTS and FUNCTIONS; the vocabulary one
 * level down was unchecked, which is I-118's shape exactly.
 *
 * ⚠ Every name in `ROOT_FIELDS` was MEASURED against this engine — a probe flow
 * of one `core.log.Log` per candidate under `allowFailure`, in `foundry.system`.
 * These tests pin the measurement's *result*; they cannot re-take it. Changing
 * the list means running the probe again.
 */
import { describe, expect, it } from "vitest";
import { validateGeneratedExpr } from "./flow-expression.service.js";

const check = (expr: string) => validateGeneratedExpr(expr, "step \"s\".paramsExpr");
const messages = (expr: string) => check(expr).map((f) => f.message).join(" ");

describe("execution.* fields", () => {
  it("REFUSES the spelling that actually shipped, and names the replacement", () => {
    const m = messages('[{"as_of":"{{ execution.startedAt }}"}]');
    expect(m).toContain("execution.startedAt` does not exist");
    // ⚠ A refusal naming no alternative is how a correct rejection becomes
    // three more attempts at the same idea — UNREACHABLE_ROOTS' argument, one
    // level down.
    expect(m).toContain("execution.startDate");
  });

  it("accepts every field the engine really carries", () => {
    for (const f of ["id", "startDate", "originalId", "state"]) {
      expect(check(`{{ execution.${f} }}`), `execution.${f} was refused`).toEqual([]);
    }
  });

  it("accepts every flow field the engine really carries", () => {
    for (const f of ["id", "namespace", "revision", "tenantId"]) {
      expect(check(`{{ flow.${f} }}`), `flow.${f} was refused`).toEqual([]);
    }
  });

  it("refuses a flow field that measured as absent", () => {
    expect(messages("{{ flow.name }}")).toContain("flow.name` does not exist");
  });
});

/**
 * ⚠ **THE CONTROL, and it is the half that keeps this from breaking the
 * product.** `inputs` and `outputs` have vocabularies the AUTHOR defines — an
 * input is whatever the flow declares, an output whatever a step returns. A
 * fixed list for either would refuse correct expressions everywhere. If this
 * check ever widens to them, these go red before anything ships.
 */
describe("author-defined roots are NOT field-checked", () => {
  it("leaves any input name alone", () => {
    expect(check("{{ inputs.as_of }}")).toEqual([]);
    expect(check("{{ inputs.anything_at_all }}")).toEqual([]);
  });

  it("leaves any step output alone", () => {
    expect(check("{{ json(outputs.fetch.body).results[0].data }}")).toEqual([]);
    expect(check("{{ outputs.some_step.vars.result }}")).toEqual([]);
  });

  /**
   * The real expression from the flow that shipped the bug, minus the bad
   * field. It must pass whole — a check that refuses this refuses the product.
   */
  it("accepts a real working expression end to end", () => {
    expect(check('[{"as_of":"{{ execution.startDate }}"}]')).toEqual([]);
  });
});
