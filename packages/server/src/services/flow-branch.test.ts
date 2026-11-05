/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CONDITIONAL GUARD — foundations Phase 3
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * *"If the report is empty, do not email"* was inexpressible in every one of the
 * three authoring modes. It is expressible now, as a **one-armed guard**: the
 * compiler emits `io.kestra.plugin.core.flow.If` and hoists everything
 * transitively downstream into `then:`.
 *
 * ⚠ **Say "a step can be made conditional"; never say the product has if/else.**
 * There is no `else` and the model has no field for one. `BranchStep`'s docblock
 * records what a second arm would cost, which is not effort — it is a second way
 * to say which arm a step belongs to, and every candidate either reintroduces
 * path addressing (which D-123 exists to refuse) or adds a per-step marker that
 * `touchedBy`, `assertOnlyTouched`, `downstreamOf` and the canvas must all learn.
 *
 * The refusals below are the substance of the phase. Each is a refusal to GUESS
 * about the engine, and the reason is always the same: an unverified guess here
 * fails at **render** time — after approval, on a schedule, with an error naming
 * neither step nor field (I-113's shape).
 */
import { describe, expect, it } from "vitest";
import { armOf, flowCompiler, validateModel, FlowCompileError, type FlowModel } from "./flow-compiler.service.js";
import { FOUNDRY_EMITS } from "./engine-plugin.service.js";

import { OUTPUT_SHAPES } from "./flow-output-shape.js";
import { namespaceFor } from "./kestra-client.service.js";

const draft = namespaceFor("acme", "hr", "draft");

/** A guard over a two-step arm, with one step deliberately outside it. */
const model: FlowModel = {
  id: "chase-overdue",
  steps: [
    { id: "overdue", kind: "datasource", ref: "fin.overdue", paramsExpr: "[{}]" },
    { id: "log", kind: "transform", expr: "{{ 1 }}", dependsOn: ["overdue"] },
    {
      id: "any_rows",
      kind: "branch",
      conditionExpr: "{{ json(outputs.overdue.body).results[0].data | jq('length > 0') | first }}",
      dependsOn: ["overdue"],
    },
    { id: "shape", kind: "transform", expr: "{{ 2 }}", dependsOn: ["any_rows"] },
    { id: "send", kind: "tool", ref: "mail_send", paramsExpr: "[{}]", dependsOn: ["shape"] },
  ],
};

function compileErr(m: FlowModel): string {
  try {
    validateModel(m);
  } catch (e) {
    return (e as FlowCompileError).message;
  }
  throw new Error("expected a compile refusal");
}

describe("armOf — computed from dependsOn, never from position", () => {
  it("is the transitive closure downstream of the branch", () => {
    expect(armOf(model, "any_rows").map((s) => s.id)).toEqual(["shape", "send"]);
  });

  /**
   * ⚠ `log` sits between the branch's dependency and the branch in the step
   * list, and it is NOT in the arm. An ordinal implementation would include it,
   * which is the failure `downstreamOf`'s own docblock predicted: *on a
   * branching flow an ordinal version both refuses safe replays and permits
   * hanging ones.*
   */
  it("does not sweep in a step that merely appears nearby", () => {
    expect(armOf(model, "any_rows").map((s) => s.id)).not.toContain("log");
  });
});

describe("emission", () => {
  it("emits an If, with the arm nested under then:", () => {
    const { yaml } = flowCompiler.compile(model, { namespace: draft });
    expect(yaml).toContain("type: io.kestra.plugin.core.flow.If");
    expect(yaml).toContain("    then:");
    // The arm's tasks are indented INSIDE the branch — six spaces where a
    // top-level task has two.
    expect(yaml).toMatch(/then:\n {6}- id: shape/);
    expect(yaml).toContain("      - id: send");
    // …and `log`, which is outside the arm, stays at the top level.
    expect(yaml).toMatch(/\n {2}- id: log\n/);
  });

  it("emits each arm task exactly once", () => {
    const { yaml } = flowCompiler.compile(model, { namespace: draft });
    expect(yaml.match(/- id: send\b/g)).toHaveLength(1);
  });

  /**
   * ⚠ The class is on `FOUNDRY_EMITS`, which `engine-plugin.test.ts` pins
   * against the compiler's own source. Adding an emitted type without adding it
   * there leaves `/apps` reporting a capability count that is a lie about what
   * the product can ask for.
   */
  it("is on the pinned emit list", () => {
    expect([...FOUNDRY_EMITS]).toContain("io.kestra.plugin.core.flow.If");
  });
});

describe("the refusals — each one a refusal to guess about the engine", () => {
  it("refuses a condition that guards nothing", () => {
    const lonely: FlowModel = {
      id: "f",
      steps: [
        { id: "q", kind: "datasource", ref: "a.b", paramsExpr: "[{}]" },
        { id: "cond", kind: "branch", conditionExpr: "{{ 1 }}", dependsOn: ["q"] },
      ],
    };
    expect(compileErr(lonely)).toContain("guards nothing");
  });

  it("refuses an empty condition", () => {
    const blank: FlowModel = {
      id: "f",
      steps: [
        { id: "cond", kind: "branch", conditionExpr: "  " },
        { id: "t", kind: "transform", expr: "{{ 1 }}", dependsOn: ["cond"] },
      ],
    };
    expect(compileErr(blank)).toContain("no condition");
  });

  /**
   * ⚠ **A PAUSE USED TO BE REFUSED HERE AND NOW COMPILES — the
   * assertion is INVERTED, deliberately, and this docblock is why.**
   *
   * The old refusal's stated reason was *"a Pause inside a conditional block is
   * unverified against this engine"*, which was a want of evidence rather than
   * a property. The evidence was taken on 2026-09-04 against v1.3.29: a
   * `core.flow.Pause` inside an `If` arm works end to end — validate 200,
   * execution PAUSED, resume 204, the arm completed and the top-level tail ran.
   * Both kinds are that shape.
   *
   * ⚠ Keeping the old test passing by leaving the refusal in place would have
   * been the quiet option and the wrong one: it would pin a restriction whose
   * only justification had just been withdrawn, and gate 3 inside a branch is
   * precisely what *"if it is over the limit, ask a person"* needs.
   *
   * A nested `branch` stays refused and is asserted separately below, because
   * its reason is DIFFERENT and now survives on its own: the engine allows it
   * (measured in the same pass) and this compiler cannot emit it.
   */
  /**
   * ⚠ This was an `it.each` over the TWO kinds whose `_await` is a Pause. One of
   * them went with the agent runtime; the measurement that admitted both stands
   * unchanged — a `core.flow.Pause` inside an `If` arm works end to end on
   * v1.3.29 — and the loop stays a loop for the day a second pausing kind
   * returns.
   */
  it.each(["approval"] as const)("allows a %s step inside an arm — measured", () => {
    const inner = { id: "x", kind: "approval" as const, summaryExpr: '"ok?"', dependsOn: ["cond"] };
    const nested: FlowModel = {
      id: "f",
      steps: [
        { id: "cond", kind: "branch", conditionExpr: "{{ 1 }}" },
        inner,
        { id: "after", kind: "transform", expr: "{{ 1 }}", dependsOn: ["x"] },
      ],
    };
    expect(() => validateModel(nested)).not.toThrow();
  });

  it("still refuses a nested branch — a COMPILER limit, not an engine one", () => {
    const nested: FlowModel = {
      id: "f",
      steps: [
        { id: "cond", kind: "branch", conditionExpr: "{{ 1 }}" },
        { id: "x", kind: "branch", conditionExpr: "{{ 1 }}", dependsOn: ["cond"] },
        { id: "after", kind: "transform", expr: "{{ 1 }}", dependsOn: ["x"] },
      ],
    };
    const e = compileErr(nested);
    expect(e).toContain("branch");
    // ⚠ The message must not claim the ENGINE refuses this — it does not, and a
    // refusal that misattributes its own cause sends the next person to measure
    // something that was already measured.
    expect(e).toContain("this compiler does not emit one yet");
  });

  /**
   * ⚠ **This test replaced one that could not fail, and the replacement is the
   * finding.** The obvious refusal — *"nothing outside an arm may depend on a
   * step inside it"* — is unreachable: an arm is the transitive closure of
   * `dependsOn`, so a step that depends on an arm member IS an arm member. It
   * was written, and the test written for it is what showed the condition can
   * never be true (I-38).
   *
   * The real hazard is two arms OVERLAPPING. A step reachable from two branches
   * is emitted inside one `then:` block, so the other branch's condition is
   * silently ignored for it — a guard that reads as present on the canvas and
   * does nothing at runtime, the same shape as an appended gate.
   */
  it("refuses a step guarded by two conditions", () => {
    const twice: FlowModel = {
      id: "f",
      steps: [
        { id: "q", kind: "datasource", ref: "a.b", paramsExpr: "[{}]" },
        { id: "c1", kind: "branch", conditionExpr: "{{ 1 }}", dependsOn: ["q"] },
        { id: "c2", kind: "branch", conditionExpr: "{{ 2 }}", dependsOn: ["q"] },
        { id: "send", kind: "tool", ref: "mail_send", paramsExpr: "[{}]", dependsOn: ["c1", "c2"] },
      ],
    };
    const e = compileErr(twice);
    expect(e).toContain('"send"');
    expect(e).toContain("only one condition");
  });

  /** The control: one condition over the same step compiles. */
  it("and one condition over that step is fine", () => {
    expect(() =>
      validateModel({
        id: "f",
        steps: [
          { id: "q", kind: "datasource", ref: "a.b", paramsExpr: "[{}]" },
          { id: "c1", kind: "branch", conditionExpr: "{{ 1 }}", dependsOn: ["q"] },
          { id: "send", kind: "tool", ref: "mail_send", paramsExpr: "[{}]", dependsOn: ["c1"] },
        ],
      }),
    ).not.toThrow();
  });
});

describe("what a branch is NOT", () => {
  /**
   * ⚠ Task 3.4, decided: `approval` keeps no output, and neither does `branch`.
   * A branch kind makes *"if approved do X, if not do Y"* askable for the first
   * time and the answer is still no — rejecting a gate **kills** the execution,
   * so giving `approval` an output would change what a rejection MEANS, and that
   * is a decision about the approval model rather than about branching.
   */
  it("produces no output, and neither does an approval", () => {
    expect(OUTPUT_SHAPES.branch.template).toBeNull();
    expect(OUTPUT_SHAPES.approval.template).toBeNull();
    expect(OUTPUT_SHAPES.branch.caution).toContain("no data");
  });

  /**
   * ⚠ The condition IS structure. Without this line an armed flow reports no
   * structure change when its condition is edited, so *"only email when the
   * report is non-empty"* could quietly become *"always email"* and keep its
   * approval — the §6.5 asymmetry pointed backwards.
   */
  it("puts the condition in the structure hash", () => {
    const before = flowCompiler.structureHash(model);
    const after = flowCompiler.structureHash({
      ...model,
      steps: model.steps.map((s) =>
        s.id === "any_rows" ? { ...s, conditionExpr: "{{ 1 }}" } : s,
      ),
    });
    expect(after).not.toBe(before);
  });
});
