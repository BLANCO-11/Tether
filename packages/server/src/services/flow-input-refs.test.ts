// src/services/flow-input-refs.test.ts
//
// WARNING The regression for execution `1ygllnw0XWjPHWo04qarqk`: a step reading
// `{{ inputs.as_of }}` in a flow whose six revisions all carry `inputs: null`.
// Every static check passed it; Kestra refused it 0.4s into the run, and gate 1
// then made the flow permanently unarmable.
import { describe, expect, it } from "vitest";
import {
  checkDeclaredInputs,
  checkStepRefs,
  inputNamesRead,
  stepNamesRead,
} from "./flow-input-refs.js";
import { EXPRESSION_FIELDS } from "./flow-expression.service.js";

const FIELDS = EXPRESSION_FIELDS;

describe("inputNamesRead", () => {
  it("finds the name in the reported expression", () => {
    expect(inputNamesRead('[{"as_of":"{{ inputs.as_of }}"}]')).toEqual(["as_of"]);
  });

  it("finds the bracket form too", () => {
    expect(inputNamesRead(`{{ inputs['as_of'] }}`)).toEqual(["as_of"]);
  });

  it("reports a name once however many times it is read", () => {
    expect(inputNamesRead("{{ inputs.p }} and {{ inputs.p }}")).toEqual(["p"]);
  });

  /**
   * WARNING **Only inside `{{ }}`, and this is the false-positive guard.** A
   * `paramsExpr` is mostly JSON with template islands in it, so a regex over the
   * raw field would flag the literal text `inputs.foo` in a prose value. I-62 is
   * the record of what a crying-wolf guard costs: three false positives, zero
   * real ones, and a widening that permits the defect.
   */
  it("ignores the same text OUTSIDE a template", () => {
    expect(inputNamesRead('[{"note":"read inputs.as_of from the form"}]')).toEqual([]);
  });

  it("is not confused by a field called inputs on something else", () => {
    expect(inputNamesRead("{{ outputs.step.inputs.x }}")).toEqual([]);
  });
});

describe("checkDeclaredInputs", () => {
  const REPORTED = [
    {
      id: "fetch_csat_by_team",
      kind: "datasource",
      ref: "support_demo.csat_by_team",
      paramsExpr: '[{"as_of":"{{ inputs.as_of }}"}]',
    },
  ];

  it("WARNING refuses the reported flow, which declared nothing", () => {
    const f = checkDeclaredInputs(REPORTED, [], FIELDS);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain("as_of");
    expect(f[0]).toContain("declares none at all");
  });

  it("accepts it once the input is declared - the control", () => {
    expect(checkDeclaredInputs(REPORTED, ["as_of"], FIELDS)).toEqual([]);
  });

  /**
   * WARNING The message names BOTH remedies, because a person genuinely has two
   * and guessing wrong costs another round trip. It also states the runtime
   * consequence: an undeclared input is not empty, the whole `inputs` variable
   * is absent, so the step fails before it runs. A model told only "undeclared"
   * may reasonably conclude the value defaults to blank.
   */
  it("says what to do about it, and what actually happens if you do not", () => {
    const m = checkDeclaredInputs(REPORTED, [], FIELDS)[0]!;
    expect(m).toContain("declare it as an input");
    expect(m).toContain("outputs.<step>");
    expect(m).toContain("fails before it runs");
  });

  it("lists what IS declared, so a typo is obvious", () => {
    const m = checkDeclaredInputs(REPORTED, ["as_off", "period"], FIELDS)[0]!;
    expect(m).toContain("as_off, period");
  });

  it("one finding per step and input, not per occurrence", () => {
    expect(
      checkDeclaredInputs(
        [{ id: "s", kind: "tool", paramsExpr: '[{"a":"{{ inputs.x }}","b":"{{ inputs.x }}"}]' }],
        [],
        FIELDS,
      ),
    ).toHaveLength(1);
  });

  it("checks every expression field a step can carry, not just paramsExpr", () => {
    const f = checkDeclaredInputs(
      [
        { id: "t", kind: "transform", expr: "{{ inputs.a }}" },
        { id: "g", kind: "approval", summaryExpr: '"{{ inputs.b }}"' },
      ],
      [],
      FIELDS,
    );
    expect(f).toHaveLength(2);
  });

  /**
   * WARNING An input DECLARED and never read is not an error, and must not become
   * one. A person may add the field before the step that uses it, and a flow
   * whose input is supplied entirely by a trigger's configured values reads it
   * nowhere at all.
   */
  it("says nothing about an input that is declared and unused", () => {
    expect(
      checkDeclaredInputs([{ id: "s", kind: "tool", paramsExpr: "[{}]" }], ["period"], FIELDS),
    ).toEqual([]);
  });
});

/**
 * WARNING **Found by running the flow the check above had just unblocked** -
 * execution `3rQ3IOg3sBW70KjsJFvNoD`, "Unable to find `csat_summary_input`".
 * A chat turn removed a transform step and left the step reading its output
 * pointing at nothing. `dependsOn` had been rewired; the EXPRESSION had not,
 * and only one of those two references was ever checked.
 */
describe("checkStepRefs", () => {
  const REPORTED = [
    { id: "fetch_csat_by_team", kind: "datasource", ref: "d.q", paramsExpr: "[{}]" },
    {
      id: "csat_summary_report",
      kind: "tool",
      ref: "llm_complete",
      dependsOn: ["fetch_csat_by_team"],
      paramsExpr: '[{"input": {{ json(outputs.csat_summary_input.value) }} }]',
    },
  ];

  it("finds the step an expression reads", () => {
    expect(stepNamesRead("{{ json(outputs.fetch.body) }}")).toEqual(["fetch"]);
  });

  it("WARNING refuses a read of a step that was removed", () => {
    const f = checkStepRefs(REPORTED, FIELDS);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain("csat_summary_input");
    expect(f[0]).toContain("no step called");
  });

  /**
   * WARNING **The control that matters**: `dependsOn` is already correct in that
   * fixture - it names a step that exists. So a version of this check written
   * against `dependsOn` would pass, which is exactly why the defect shipped.
   */
  it("is about the EXPRESSION, not dependsOn - which was already valid", () => {
    const depends = REPORTED[1]!.dependsOn as string[];
    expect(depends).toEqual(["fetch_csat_by_team"]);
    expect(checkStepRefs(REPORTED, FIELDS)).toHaveLength(1);
  });

  it("accepts it once the name points at a real step - the control", () => {
    const fixed = REPORTED.map((s) =>
      s.id === "csat_summary_report"
        ? { ...s, paramsExpr: '[{"input": {{ json(outputs.fetch_csat_by_team.body) }} }]' }
        : s,
    );
    expect(checkStepRefs(fixed, FIELDS)).toEqual([]);
  });

  it("lists the steps that DO exist, so a typo is obvious", () => {
    expect(checkStepRefs(REPORTED, FIELDS)[0]!).toContain("fetch_csat_by_team, csat_summary_report");
  });

  it("ignores the same text outside a template", () => {
    expect(stepNamesRead('[{"note":"see outputs.gone for details"}]')).toEqual([]);
  });
});

describe("inputsReadBy counts typed bindings (phase 3 step 3)", () => {
  it("a {from:input} binding and a literal's {{ inputs.x }} placeholder are reads", async () => {
    const { inputsReadBy } = await import("./flow-input-refs.js");
    const { EXPRESSION_FIELDS } = await import("./flow-expression.service.js");
    const step = {
      id: "s", kind: "tool", ref: "t", paramsExpr: "",
      inputs: [
        { name: "as_of", source: { from: "input", inputId: "as_of" } },
        { name: "subject", source: { from: "literal", value: "Report for {{ inputs.period }}" } },
        { name: "plain", source: { from: "literal", value: "no inputs here" } },
        { name: "unbound", source: null },
      ],
    };
    expect([...inputsReadBy(step, EXPRESSION_FIELDS)].sort()).toEqual(["as_of", "period"]);
  });
});

describe("checkDeclaredInputs reads typed bindings too", () => {
  it("a binding to an undeclared input is the same finding, named by its binding", () => {
    const steps = [{ id: "s", kind: "tool", inputs: [{ name: "period", source: { from: "input", inputId: "month" } }] }];
    const f = checkDeclaredInputs(steps, ["period"], EXPRESSION_FIELDS);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/step "s"\.inputs\["period"\]: reads `inputs\.month`/);
  });
  it("CONTROL: a binding to a declared input is silent", () => {
    const steps = [{ id: "s", kind: "tool", inputs: [{ name: "period", source: { from: "input", inputId: "period" } }] }];
    expect(checkDeclaredInputs(steps, ["period"], EXPRESSION_FIELDS)).toEqual([]);
  });
});
