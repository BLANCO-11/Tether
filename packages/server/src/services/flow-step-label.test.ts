// src/services/flow-step-label.test.ts — a label is not an address, and it is
// not structure. `CX` canvas chain rule, Stage 2.3 (canvas programme, closed; record removed 2026-09-11).
import { describe, it, expect } from "vitest";
import { flowCompiler, type FlowModel } from "./flow-compiler.service.js";

const base = (): FlowModel => ({
  id: "labels",
  inputs: [],
  steps: [
    { kind: "datasource", id: "read", ref: "hr.staff", paramsExpr: "[{}]" },
    { kind: "tool", id: "send", ref: "mail_send", paramsExpr: "[{}]", dependsOn: ["read"] },
  ],
});

describe("a step's label is not part of its structure", () => {
  /**
   * ⚠ **THE WHOLE POINT OF THE FIELD, AND THE ONE WAY IT COULD GO WRONG.**
   *
   * §6.5's asymmetry compares `structureHash` across revisions: a structure
   * change needs human re-approval. If a label were hashed, renaming a step —
   * or fixing a typo in its description — would report a structure change on
   * every armed flow in the workspace and the staleness sweep would suspend
   * them, giving a reason that is not true.
   *
   * `structureHash` builds an explicit shape per kind precisely so that a new
   * field has to be argued onto one side of that line. This is the argument
   * made executable.
   */
  it("⚠ renaming and re-describing move NOTHING", () => {
    const before = flowCompiler.structureHash(base());
    const after = base();
    after.steps[0]!.name = "Everyone on the payroll";
    after.steps[0]!.description = "Reads the staff table. Nothing is filtered here.";
    after.steps[1]!.name = "Email them";
    expect(flowCompiler.structureHash(after)).toBe(before);
  });

  /**
   * ⚠ **THE CONTROL.** Without it a `structureHash` that returned a constant —
   * or threw and was caught somewhere — would satisfy the test above perfectly.
   * A real structure change must still move it.
   */
  it("but a real structure change still does", () => {
    const before = flowCompiler.structureHash(base());
    const after = base();
    after.steps[1]!.dependsOn = [];
    expect(flowCompiler.structureHash(after)).not.toBe(before);
  });

  /**
   * ⚠ **AND NEITHER FIELD REACHES THE ENGINE.** A task id in the compiled flow
   * is the step id. A person's prose rendered in beside it would appear in the
   * engine's own operator UI, which has no tenant isolation — the same reason
   * D-70 sends a pointer label to the engine rather than a person's name.
   */
  it("⚠ the compiled YAML carries neither", () => {
    const m = base();
    m.steps[0]!.name = "UNIQUE_LABEL_TOKEN";
    m.steps[0]!.description = "UNIQUE_PROSE_TOKEN";
    const { yaml } = flowCompiler.compile(m, { namespace: "foundry.t.ws" as never });
    expect(yaml).not.toContain("UNIQUE_LABEL_TOKEN");
    expect(yaml).not.toContain("UNIQUE_PROSE_TOKEN");
    // The control: the step really is in there, so the absence is an absence.
    expect(yaml).toContain("id: read");
  });
});
