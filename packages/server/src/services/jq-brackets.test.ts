/**
 * Two jq programs the engine refuses with the same misleading sentence —
 * "Unable to parse jq value '[…]' with type java.util.ArrayList" — both
 * probed on Kestra v1.3.29 and both refused at lowering instead.
 *  - I-233 (r10 R10): an unclosed bracket.
 *  - r11 R07: a bare `|` inside an object value, which standard jq accepts
 *    and the engine's dialect does not.
 */
import { describe, expect, it } from "vitest";
import { jqBracketProblem, jqObjectPipeProblem, lowerTransformProgram, FlowCompileError } from "./flow-compiler.service.js";

describe("jqBracketProblem", () => {
  it("R10's program: an object never closed", () => {
    const p = jqBracketProblem('[.[] | {to: [.e], body: ("x" + .p + "%.")] ]');
    expect(p).toContain('"]" at position');
    expect(p).toContain('the "{" at position');
    expect(p).toContain('needs "}"');
  });
  it("an unclosed bracket and an unclosed string", () => {
    expect(jqBracketProblem("[.[] | .a")).toContain('unclosed "["');
    expect(jqBracketProblem('"abc')).toContain("unclosed string");
  });
  it("CONTROL: valid programs pass — brackets inside strings, escapes, interpolation", () => {
    for (const ok of [
      "[.[] | select(.a > 1) | {b: .a}]",
      'map({t: ("a)" + "]}" + .x)})',
      '[.[] | "Hi \\(.name), you owe \\(.amt | tostring) (\\("x"))"]',
      '"say \\"hi\\" (then)"',
      "group_by(.v) | map({v: .[0].v, n: length})",
    ]) expect(jqBracketProblem(ok), ok).toBeNull();
  });
});

describe("jqObjectPipeProblem", () => {
  it("R07's program: a bare pipe in an object value", () => {
    expect(jqObjectPipeProblem('{text: (["h"] + map(.n)) | join("\\n")}')).toContain('inside the value of "text"');
  });
  it("CONTROL: the wrapped form, pipes outside objects, pipes in strings, shorthand keys", () => {
    for (const ok of [
      '{text: ((["h"] + map(.n)) | join("\\n"))}',
      "[.[] | {to: .email, n: .name}] | sort_by(.n)",
      '{text: "a | b"}',
      "{name, email}",
      "map({v: (.a | tostring), w: .b})",
    ]) expect(jqObjectPipeProblem(ok), ok).toBeNull();
  });
  it("lowering refuses it, naming the step", () => {
    const steps = [{ id: "read", kind: "transform", expr: "{{ 1 }}", fields: ["n"] }] as never;
    expect(() => lowerTransformProgram(steps, "msg", "read", "{text: map(.n) | join(\",\")}")).toThrow(FlowCompileError);
  });
});
