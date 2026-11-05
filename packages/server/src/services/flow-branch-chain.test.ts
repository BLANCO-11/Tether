import { describe, it, expect } from "vitest";
import { flowCompiler, validateModel, FlowCompileError } from "./flow-compiler.service.js";

/**
 * if / elif / else — foundations, replacing the single-arm guard.
 *
 * ⚠ **`elseOf` is NOT what D-123 refused.** D-123 refused a per-step arm marker
 * — every step carrying which arm it is in, which `touchedBy`,
 * `assertOnlyTouched`, `downstreamOf` and the canvas would all have to learn.
 * This is one field on the BRANCH naming another branch by id, exactly the
 * shape `dependsOn` already has, and `armOf` is untouched: an arm is still
 * everything transitively downstream via `dependsOn`.
 *
 * Every refusal below exists because the alternative COMPILES and quietly does
 * something else — an unnested arm runs unconditionally, a second continuation
 * silently replaces the first, a cycle never terminates.
 */

/**  returns a CompiledFlow; every assertion here is about its yaml. */
const compileYaml = (m: unknown, opts: { namespace: string; flowId: string }) =>
  flowCompiler.compile(m as never, opts as never).yaml;

const call = (id: string, dependsOn?: string[]) => ({
  kind: "tool" as const,
  id,
  ref: "mail_send",
  paramsExpr: "{{ json(outputs.a.body) }}",
  ...(dependsOn ? { dependsOn } : {}),
});

const chain = () => ({
  id: "f",
  steps: [
    { kind: "datasource" as const, id: "a", ref: "d.q", paramsExpr: "[{}]" },
    { kind: "branch" as const, id: "big", conditionExpr: "{{ true }}" },
    call("email_big", ["big"]),
    { kind: "branch" as const, id: "small", conditionExpr: "{{ false }}", elseOf: "big" },
    call("email_small", ["small"]),
    { kind: "branch" as const, id: "otherwise", elseOf: "small" },
    call("email_none", ["otherwise"]),
  ],
});

describe("a valid if / elif / else", () => {
  it("validates", () => {
    expect(() => validateModel(chain() as never)).not.toThrow();
  });

  it("emits ONE top-level If, with the rest nested through else", () => {
    const yaml = compileYaml(chain() as never, { namespace: "n", flowId: "f" });
    // Two conditions, so two If tasks — the third arm is an else with no test.
    expect(yaml.match(/type: io\.kestra\.plugin\.core\.flow\.If/g)).toHaveLength(2);
    expect(yaml.match(/^\s*else:/gm)).toHaveLength(2);
  });

  it("⚠ nests each link one level deeper, never a second top-level task", () => {
    const yaml = compileYaml(chain() as never, { namespace: "n", flowId: "f" });
    const lines = yaml.split("\n");
    const at = (id: string) => lines.find((l) => l.includes(`- id: ${id}`))!;
    expect(at("big").indexOf("-")).toBeLessThan(at("small").indexOf("-"));
    expect(at("email_big").indexOf("-")).toBeLessThan(at("email_small").indexOf("-"));
  });

  it("emits no If for the conditionless otherwise, only its arm", () => {
    const yaml = compileYaml(chain() as never, { namespace: "n", flowId: "f" });
    expect(yaml).not.toContain("- id: otherwise");
    expect(yaml).toContain("- id: email_none");
  });

  it("⚠ puts elseOf in the structure hash, or moving an arm keeps its approval", () => {
    const a = flowCompiler.structureHash(chain() as never);
    const moved = chain();
    (moved.steps[5] as { elseOf?: string }).elseOf = "big";
    (moved.steps[3] as { elseOf?: string }).elseOf = undefined;
    (moved.steps[3] as { conditionExpr?: string }).conditionExpr = "{{ false }}";
    expect(flowCompiler.structureHash(moved as never)).not.toBe(a);
  });
});

describe("what is refused, and why each would otherwise compile", () => {
  const bad = (mutate: (m: ReturnType<typeof chain>) => void) => {
    const m = chain();
    mutate(m);
    return () => validateModel(m as never);
  };

  it("a continuation of a step that is not in the flow", () => {
    expect(bad((m) => ((m.steps[3] as { elseOf?: string }).elseOf = "ghost"))).toThrow(/not a step in this flow/);
  });

  it("a continuation of something that is not a condition", () => {
    expect(bad((m) => ((m.steps[3] as { elseOf?: string }).elseOf = "a"))).toThrow(/only a condition can have an "otherwise"/);
  });

  it("a continuation of an otherwise — there is nothing left to be false", () => {
    expect(bad((m) => ((m.steps[3] as { elseOf?: string }).elseOf = "otherwise"))).toThrow(/tests\s+nothing/);
  });

  it("⚠ TWO branches continuing one — the second silently replaces the first", () => {
    expect(bad((m) => ((m.steps[5] as { elseOf?: string }).elseOf = "big"))).toThrow(/one "otherwise", not two/);
  });

  it("⚠ a continuation that also depends on something — it would sit INSIDE the arm it replaces", () => {
    expect(bad((m) => ((m.steps[3] as { dependsOn?: string[] }).dependsOn = ["big"]))).toThrow(
      /cannot do both/,
    );
  });

  /**
   * ⚠ Built as a clean two-link cycle. The first version pointed `big` at
   * `small` while `otherwise` still continued `small`, which is a DOUBLE CLAIM
   * and is caught by the earlier refusal — so the test passed on the wrong
   * check and would have stayed green with the cycle guard deleted.
   */
  it("a chain that loops back on itself", () => {
    const m = {
      id: "f",
      steps: [
        { kind: "datasource" as const, id: "a", ref: "d.q", paramsExpr: "[{}]" },
        { kind: "branch" as const, id: "x", conditionExpr: "{{ true }}", elseOf: "y" },
        call("ex", ["x"]),
        { kind: "branch" as const, id: "y", conditionExpr: "{{ false }}", elseOf: "x" },
        call("ey", ["y"]),
      ],
    };
    expect(() => validateModel(m as never)).toThrow(/loops back/);
  });

  it("a branch that neither tests nor continues anything", () => {
    expect(
      bad((m) => {
        (m.steps[1] as { conditionExpr?: string }).conditionExpr = undefined;
      }),
    ).toThrow(/has no condition/);
  });

  it("every refusal names the offending step", () => {
    try {
      validateModel({ ...chain(), steps: chain().steps.map((s) => (s.id === "small" ? { ...s, elseOf: "ghost" } : s)) } as never);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FlowCompileError);
      expect((e as FlowCompileError).message).toContain("small");
    }
  });
});

describe("the single-arm guard still works exactly as before", () => {
  it("compiles a lone if with no continuation", () => {
    const m = {
      id: "f",
      steps: [
        { kind: "datasource" as const, id: "a", ref: "d.q", paramsExpr: "[{}]" },
        { kind: "branch" as const, id: "g", conditionExpr: "{{ true }}" },
        call("send", ["g"]),
      ],
    };
    const yaml = compileYaml(m as never, { namespace: "n", flowId: "f" });
    expect(yaml.match(/core\.flow\.If/g)).toHaveLength(1);
    expect(yaml).not.toMatch(/^\s*else:/m);
  });
});
