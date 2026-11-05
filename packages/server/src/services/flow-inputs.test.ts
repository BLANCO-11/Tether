/**
 * Where an automation's input values come from.
 * platform-coherence Phase 4 · I-107
 *
 * ⚠ Every assertion here is a restatement of one rule: **a value comes from the
 * person, from a step's output, or it does not exist.** The measured failure
 * behind it is a generated script that hardcoded `period="2023-10"`, emailed 0
 * of 11 people, and exited 0 with `tests_passed=true` and audit `clean`.
 */
import { describe, expect, it } from "vitest";
import {
  applyInputValues,
  confirmInputsSchema,
  hasFlowInputDefault,
  isFlowInputRequired,
  stripSuggestedDefaults,
  UnknownInputError,
  unresolvedRequiredInputs,
  unresolvedInputs,
} from "./flow-inputs.js";
import { inputsReadBy } from "./flow-input-refs.js";
import type { FlowInput, FlowModel } from "./flow-compiler.service.js";
import { flowModelSchema } from "./flow.service.js";

const PERIOD: FlowInput = { id: "period", type: "STRING", required: true };
const model = (inputs: FlowInput[]): FlowModel => ({ id: "f", inputs, steps: [] });

describe("platform-coherence 4 — a drafted default is a suggestion", () => {
  it("takes the drafter's proposed default OUT of the model", () => {
    // ⚠ The whole defect. `flow-compiler.service.ts` emits `defaults:` into the
    // Kestra YAML, so a scheduled run with nothing supplied used the model's
    // guess, for ever — and nothing downstream could tell that from a value the
    // goal actually stated.
    const out = stripSuggestedDefaults([{ ...PERIOD, defaults: "2026-06" }]);
    expect(out.inputs).toEqual([PERIOD]);
    expect(out.suggestions).toEqual([{ id: "period", value: "2026-06" }]);
  });

  it("leaves an input that proposed nothing exactly as it was", () => {
    const out = stripSuggestedDefaults([PERIOD]);
    expect(out.inputs).toEqual([PERIOD]);
    expect(out.suggestions).toEqual([]);
  });

  it("does nothing to a flow with no inputs", () => {
    expect(stripSuggestedDefaults(undefined)).toEqual({ inputs: undefined, suggestions: [] });
    expect(stripSuggestedDefaults([])).toEqual({ inputs: [], suggestions: [] });
  });
});

describe("platform-coherence 4 — which inputs still need an answer", () => {
  it("names the ones with no value", () => {
    expect(unresolvedInputs(model([PERIOD, { id: "to", type: "STRING", defaults: "ops@x.example" }])))
      .toEqual([PERIOD]);
  });

  it('counts an EMPTY STRING as answered', () => {
    // ⚠ An empty string is a value somebody can legitimately mean. Treating it
    // as missing makes a confirmed answer un-confirmable — the same question
    // asked for ever with no way to end it.
    expect(unresolvedInputs(model([{ ...PERIOD, defaults: "" }]))).toEqual([]);
  });
});

describe("canonical input semantics", () => {
  it("treats omitted required as required and only explicit false as optional", () => {
    expect(isFlowInputRequired({})).toBe(true);
    expect(isFlowInputRequired({ required: true })).toBe(true);
    expect(isFlowInputRequired({ required: false })).toBe(false);
  });

  it("detects default presence structurally, including an empty string", () => {
    expect(hasFlowInputDefault({})).toBe(false);
    expect(hasFlowInputDefault({ defaults: "" })).toBe(true);
    expect(unresolvedRequiredInputs(model([{ id: "implicit", type: "STRING" }]))).toHaveLength(1);
    expect(
      unresolvedRequiredInputs(model([{ id: "empty", type: "STRING", defaults: "" }])),
    ).toEqual([]);
  });
});

describe("platform-coherence 4 — confirming is not a retry channel", () => {
  it("has nowhere to put a goal", () => {
    // ⚠ 4.4, and the protection is STRUCTURAL rather than a check. Re-asking a
    // refusal is precisely how a correct `insufficient_contract` becomes an
    // invented `period="2023-10"` on attempt two — so the schema simply has no
    // field for one, exactly as `refineFlowSchema` has none (D-112).
    const parsed = confirmInputsSchema.parse({
      values: { period: "2026-06" },
      goal: "design it again but different",
      instruction: "redraft",
    });
    expect(parsed).toEqual({ values: { period: "2026-06" } });
    expect(parsed).not.toHaveProperty("goal");
    expect(parsed).not.toHaveProperty("instruction");
  });

  it("writes exactly what it was handed, and nothing else", () => {
    const out = applyInputValues(model([PERIOD, { id: "to", type: "STRING" }]), { period: "2026-06" });
    // ⚠ `to` is untouched — no "fill in the rest", no carrying a suggestion
    // through unconfirmed. That absence IS the rule.
    expect(out.inputs).toEqual([{ ...PERIOD, defaults: "2026-06" }, { id: "to", type: "STRING" }]);
  });

  it("REFUSES an input the model does not declare, rather than ignoring it", () => {
    // An ignored key is a value a person believes they supplied and which
    // nothing uses — the silent half of the same defect, from the other side.
    expect(() => applyInputValues(model([PERIOD]), { periodd: "2026-06" })).toThrow(UnknownInputError);
    try {
      applyInputValues(model([PERIOD]), { periodd: "x" });
    } catch (e) {
      // It names both halves, because "unknown input" without the declared list
      // leaves someone guessing at a typo they cannot see.
      expect((e as Error).message).toContain('"periodd"');
      expect((e as Error).message).toContain('"period"');
    }
  });

  it("says so plainly when the flow declares no inputs at all", () => {
    try {
      applyInputValues(model([]), { period: "x" });
    } catch (e) {
      expect((e as Error).message).toContain("no inputs at all");
    }
  });

  it("overwrites a value that was already confirmed", () => {
    // Correcting an answer is the same act as giving one. Refusing would make
    // the first value permanent, which nothing about it earned.
    const out = applyInputValues(model([{ ...PERIOD, defaults: "2026-05" }]), { period: "2026-06" });
    expect(out.inputs?.[0]!.defaults).toBe("2026-06");
  });
});

/**
 * ⚠ **`inputsReadBy` — the mirror of `checkDeclaredInputs`, added 2026-09-06.**
 *
 * `add_step` may carry the inputs its step reads, and this is what stops that
 * becoming a general side channel: a declaration the step does not read is an
 * input a person is asked for at run time that nothing consumes.
 *
 * Built from the same `inputNamesRead` as the checker above, because the two
 * are opposite halves of one question and a disagreement between them would
 * reach a person as a refusal naming an input they can see in the step.
 */
describe("inputsReadBy", () => {
  const FIELDS = ["paramsExpr", "expr", "conditionExpr"];

  it("finds an input read from a params expression", () => {
    expect([
      ...inputsReadBy({ id: "s", paramsExpr: '[{"as_of": "{{ inputs.as_of }}"}]' }, FIELDS),
    ]).toEqual(["as_of"]);
  });

  it("finds inputs across several fields, without duplicates", () => {
    const got = inputsReadBy(
      {
        id: "s",
        paramsExpr: '[{"a": "{{ inputs.period }}", "b": "{{ inputs.period }}"}]',
        conditionExpr: "{{ inputs.threshold }}",
      },
      FIELDS,
    );
    expect([...got].sort()).toEqual(["period", "threshold"]);
  });

  it("is empty for a step that reads none — the case that must not be a free pass", () => {
    // If this returned everything, an unread declaration would sail through.
    expect([...inputsReadBy({ id: "s", expr: "{{ outputs.a.value }}" }, FIELDS)]).toEqual([]);
  });

  it("ignores fields that are not strings, and fields it was not given", () => {
    expect([...inputsReadBy({ id: "s", paramsExpr: 7, expr: null }, FIELDS)]).toEqual([]);
    // `fields` is required for the I-127 reason: a caller that passes none must
    // see nothing rather than silently permit every declaration.
    expect([...inputsReadBy({ id: "s", paramsExpr: "{{ inputs.x }}" }, [])]).toEqual([]);
  });
});

describe("a derivation is a decided value", () => {
  const DERIVED: FlowInput = { ...PERIOD, computed: "priorMonth" };

  it("counts computed as answered everywhere defaults counts", () => {
    expect(hasFlowInputDefault({ computed: "priorMonth" })).toBe(true);
    expect(unresolvedInputs(model([DERIVED]))).toEqual([]);
    expect(unresolvedRequiredInputs(model([DERIVED]))).toEqual([]);
  });

  it("a drafted computed is an intent, not a suggestion — stripping leaves it", () => {
    // `stripSuggestedDefaults` takes the drafter's VALUE guesses out of the
    // model. A derivation is not a guess at a value, so stripping it would
    // silently turn the monthly case back into a required input.
    const out = stripSuggestedDefaults([DERIVED]);
    expect(out.inputs).toEqual([DERIVED]);
    expect(out.suggestions).toEqual([]);
  });

  it("writing a derivation clears the literal, and a literal clears the derivation", () => {
    const withLiteral = applyInputValues(model([{ ...PERIOD, defaults: "2026-06" }]), {}, { period: "priorMonth" });
    expect(withLiteral.inputs).toEqual([{ ...PERIOD, computed: "priorMonth" }]);
    const withValue = applyInputValues(model([DERIVED]), { period: "2026-06" });
    expect(withValue.inputs).toEqual([{ ...PERIOD, defaults: "2026-06" }]);
  });

  it("REFUSES a derivation for an input the model does not declare", () => {
    expect(() => applyInputValues(model([PERIOD]), {}, { periodd: "priorMonth" })).toThrow(
      UnknownInputError,
    );
  });

  it("the confirm route carries derivations beside values", () => {
    const parsed = confirmInputsSchema.parse({ values: {}, computed: { period: "priorMonth" } });
    expect(parsed).toEqual({ values: {}, computed: { period: "priorMonth" } });
  });
});

describe("an input has one answer — a value, or a derivation", () => {
  const parse = (input: Record<string, unknown>) =>
    flowModelSchema.safeParse({
      id: "f",
      inputs: [{ id: "period", type: "STRING", ...input }],
      steps: [{ kind: "tool", id: "t1", ref: "demo.tool", paramsExpr: "[{}]" }],
    });

  it("refuses defaults AND computed on one input", () => {
    const r = parse({ defaults: "2026-06", computed: "priorMonth" });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => i.message.includes("either defaults or computed"))).toBe(true);
  });

  it("accepts a derivation alone", () => {
    expect(parse({ computed: "priorMonth" }).success).toBe(true);
  });

  it("accepts a literal alone, as before", () => {
    expect(parse({ defaults: "2026-06" }).success).toBe(true);
  });
});
