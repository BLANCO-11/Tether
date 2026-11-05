/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MERGE — where the arms come back together
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `flow-branch.test.ts` proves a step can be made conditional. This proves the
 * other half, which was **unexpressible** until this kind existed: something
 * that happens after a condition *regardless of which way it went*.
 *
 * ⚠ **The reason it was unexpressible is worth stating, because it looks like a
 * missing feature and is actually a consequence of how arms are computed.**
 * `armOf` is a blind transitive closure over `dependsOn`, so a step reading an
 * arm member's output BECOMES an arm member and runs only on that path. A
 * `transform` does not escape it — it is swallowed identically. So a shared tail
 * had to be duplicated into every arm, and the copies drift: one gets the fix,
 * the other keeps the bug, and both look right on the canvas.
 *
 * The whole mechanism is one line in `armOf` — the closure stops at a merge. The
 * tests below are mostly about the edges that one line leaves open.
 */
import { describe, expect, it } from "vitest";
import { armOf, flowCompiler, mergeExpr, validateModel, FlowCompileError, MERGE_SOURCE_KINDS as SERVER_MERGE_SOURCE_KINDS, type FlowModel } from "./flow-compiler.service.js";
import { FOUNDRY_EMITS } from "./engine-plugin.service.js";
import { validateGeneratedExpr } from "./flow-expression.service.js";
import { OUTPUT_SHAPES } from "./flow-output-shape.js";
import { namespaceFor } from "./kestra-client.service.js";
import { MERGE_SOURCE_KINDS } from "@foundry/flow-edit";

const draft = namespaceFor("acme", "hr", "draft");

/** if / else over one query, each arm sending, then a shared tail after both. */
const MERGED: FlowModel = {
  id: "f",
  steps: [
    { id: "rows", kind: "datasource", ref: "hr.headcount", paramsExpr: "[{}]" },
    {
      id: "many",
      kind: "branch",
      conditionExpr: "{{ json(outputs.rows.body).results[0].data | jq('length > 10') | first }}",
      dependsOn: ["rows"],
    },
    { id: "page", kind: "tool", ref: "page_oncall", paramsExpr: "[{}]", dependsOn: ["many"] },
    // ⚠ NO `dependsOn` — a continuation that also depends on the upstream step
    // would sit inside the arm it is the alternative to, and the compiler
    // refuses exactly that. The `elseOf` link is what places it.
    { id: "few", kind: "branch", elseOf: "many" },
    { id: "mail", kind: "tool", ref: "mail_send", paramsExpr: "[{}]", dependsOn: ["few"] },
    { id: "outcome", kind: "merge", sources: ["page", "mail"] },
    { id: "log", kind: "tool", ref: "mail_send", paramsExpr: "[{}]", dependsOn: ["outcome"] },
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

describe("the mechanism — armOf stops at a merge", () => {
  it("a merge is in NO arm, so it runs whichever way the branch went", () => {
    expect(armOf(MERGED, "many").map((s) => s.id)).not.toContain("outcome");
    expect(armOf(MERGED, "few").map((s) => s.id)).not.toContain("outcome");
  });

  /**
   * ⚠ **The half that would be missed by testing only the merge itself.** The
   * exemption has to stop the walk, not merely exclude one node — otherwise the
   * tail beyond the merge is still pulled in through it, and the shared step is
   * conditional again with nothing to show for the new kind.
   */
  it("nothing DOWNSTREAM of the merge is in an arm either", () => {
    expect(armOf(MERGED, "many").map((s) => s.id)).not.toContain("log");
    expect(armOf(MERGED, "few").map((s) => s.id)).not.toContain("log");
  });

  /** The control: without it, the two assertions above pass over empty arms. */
  it("the arms are not empty — each still holds its own send", () => {
    expect(armOf(MERGED, "many").map((s) => s.id)).toEqual(["page"]);
    expect(armOf(MERGED, "few").map((s) => s.id)).toEqual(["mail"]);
  });

  it("a merged flow compiles", () => {
    expect(() => validateModel(MERGED)).not.toThrow();
  });
});

describe("the emitted expression", () => {
  const expr = mergeExpr(MERGED, MERGED.steps.find((s) => s.id === "outcome") as never);

  /**
   * ⚠ **`??`, never `default(…)` — and this test is the reason it is safe.**
   * Both coalesce on the engine (measured 2026-09-04 against v1.3.29, with a
   * positive control proving they discriminate rather than always falling
   * back). `??` is an OPERATOR, and D-22's allowlist governs which FUNCTIONS may
   * be called — so `??` passes the scanner unchanged while `default` would need
   * a new entry on the one list standing between a drafted expression and a
   * runtime failure. Adding a name to that list from memory is I-118 exactly.
   */
  it("passes D-22's allowlist with NO new entry", () => {
    expect(validateGeneratedExpr(expr, "merge")).toEqual([]);
  });

  /** The control: the alternative spelling really is refused, so the test above
   *  is a statement about `??` and not about the checker being permissive. */
  it("the `default(…)` spelling would NOT pass — so this was a real choice", () => {
    const withDefault = `{{ outputs.page.body | default("null") }}`;
    expect(validateGeneratedExpr(withDefault, "merge").length).toBeGreaterThan(0);
  });

  /**
   * ⚠ **The RAW path, never `outputExprFor`'s.** That helper returns
   * `json(outputs.<id>.body)` for an HTTP kind — and calling `json` on a task
   * that did not run fails at render before `??` can choose. The coalesce must
   * happen on the bare path, with one `json(…)` applied by the reader.
   */
  it("coalesces raw paths, not json(...) calls", () => {
    expect(expr).toBe(`{{ outputs.page.body ?? outputs.mail.body ?? "null" }}`);
    expect(expr).not.toContain("json(");
  });

  /** A transform's raw value is `.value`, not `.body`. Mixing them is I-44's shape. */
  it("uses each source kind's own raw path", () => {
    const m: FlowModel = {
      id: "f",
      steps: [
        { id: "a", kind: "transform", expr: "{{ 1 }}" },
        { id: "b", kind: "tool", ref: "mail_send", paramsExpr: "[{}]" },
        { id: "j", kind: "merge", sources: ["a", "b"] },
      ],
    };
    expect(mergeExpr(m, m.steps[2] as never)).toBe(`{{ outputs.a.value ?? outputs.b.body ?? "null" }}`);
  });

  /**
   * ⚠ A branch chain with no `else` can leave EVERY source unexecuted. Without a
   * terminal literal the whole expression renders to nothing and the merge fails
   * — precisely when the interesting thing happened, which is that no arm
   * matched. `"null"` parses back through `json(…)` as null.
   */
  it("ends in a literal, so 'no arm matched' is a value and not a failure", () => {
    expect(expr.endsWith(`?? "null" }}`)).toBe(true);
  });
});

describe("the YAML", () => {
  const yaml = flowCompiler.compile(MERGED, { namespace: draft, withSchedule: false }).yaml;

  it("emits a class the compiler was already allowed to emit", () => {
    expect(FOUNDRY_EMITS).toContain("io.kestra.plugin.core.debug.Return");
  });

  /**
   * ⚠ **Order is the mechanism here exactly as it is for gate 3.** Kestra runs
   * tasks in emission order, so a merge emitted before the `If` would read tasks
   * that have not run — and `??` would hand back the fallback rather than
   * failing, which is the silent direction.
   */
  it("emits the merge at TOP level, after the whole condition", () => {
    const ifAt = yaml.indexOf("io.kestra.plugin.core.flow.If");
    const mergeAt = yaml.indexOf("  - id: outcome");
    expect(ifAt).toBeGreaterThan(-1);
    expect(mergeAt).toBeGreaterThan(ifAt);
    // Two spaces of indent is top level; an arm member is indented further.
    expect(yaml).toContain("\n  - id: outcome\n");
  });

  it("keeps each arm's own step INSIDE its arm", () => {
    expect(yaml).not.toContain("\n  - id: page\n");
    expect(yaml).not.toContain("\n  - id: mail\n");
  });

  it("emits the shared tail at top level too", () => {
    expect(yaml).toContain("\n  - id: log\n");
  });
});

describe("the refusals", () => {
  const withMerge = (sources: string[], extra: FlowModel["steps"] = []): FlowModel => ({
    id: "f",
    steps: [
      { id: "a", kind: "transform", expr: "{{ 1 }}" },
      { id: "b", kind: "transform", expr: "{{ 2 }}" },
      ...extra,
      { id: "j", kind: "merge", sources },
    ],
  });

  it("refuses a source that is not in the flow", () => {
    expect(compileErr(withMerge(["a", "nope"]))).toContain(`"nope"`);
  });

  /** A merge of one is a rename with a coalesce bolted on — it reads on the
   *  canvas as a join that joins nothing. */
  it("refuses fewer than two sources", () => {
    expect(compileErr(withMerge(["a"]))).toContain("two or more");
  });

  it("refuses the same source twice — the second can never be reached", () => {
    expect(compileErr(withMerge(["a", "a"]))).toContain("twice");
  });

  /**
   * ⚠ The four allowed kinds are the ones whose raw output is a JSON STRING, so
   * that ONE spelling — `json(outputs.<merge>.value)` — reads the result
   * whichever arm won. A `code` step's `vars.result` is an object and would
   * render as a Java map; an `approval` produces nothing at all.
   */
  it.each(["code", "approval"] as const)("refuses a %s source, by name", (kind) => {
    // ⚠ The `code` step is given a REAL fragment on purpose. Left empty it trips
    // "has no generated fragment" first, and the test would pass while asserting
    // nothing about merge sources at all — a green test over the wrong refusal.
    const inner =
      kind === "code"
        ? {
            id: "c",
            kind: "code" as const,
            inputExpr: "{}",
            outputKeys: ["r"],
            code: "def run(payload):\n    return {'r': 1}\n",
          }
        : kind === "approval"
          ? { id: "c", kind: "approval" as const, summaryExpr: '"ok?"' }
          : { id: "c", kind: "approval" as const, summaryExpr: '"why?"' };
    const e = compileErr(withMerge(["a", "c"], [inner as never]));
    expect(e).toContain(kind);
    expect(e).toContain("JSON result");
  });

  /**
   * ⚠ **The one hole the `armOf` exemption leaves open.** A step depending on a
   * merge AND on an arm member directly is still reached by that second edge, so
   * it IS an arm member — emitted inside `then:`, reading a task that has not
   * run. It renders as a failure mid-arm, after approval.
   */
  it("refuses a step that is inside an arm AND reads a merge", () => {
    const bad: FlowModel = {
      id: "f",
      steps: [
        ...MERGED.steps,
        { id: "oops", kind: "transform", expr: "{{ 1 }}", dependsOn: ["page", "outcome"] },
      ],
    };
    const e = compileErr(bad);
    expect(e).toContain("oops");
    expect(e).toContain("outcome");
  });

  /** Order is checked because order is the mechanism — see the YAML test above. */
  it("refuses a merge placed before one of its sources", () => {
    const backwards: FlowModel = {
      id: "f",
      steps: [
        { id: "a", kind: "transform", expr: "{{ 1 }}" },
        { id: "j", kind: "merge", sources: ["a", "b"] },
        { id: "b", kind: "transform", expr: "{{ 2 }}" },
      ],
    };
    expect(compileErr(backwards)).toContain("after every step it combines");
  });
});

/**
 * ⚠ **The client carries its OWN `MERGE_SOURCE_KINDS`, and this is what holds
 * the two in agreement.** It has to: the inspector must offer a correct pick
 * list rather than let somebody choose a step and discover at save time that it
 * produces nothing. A duplicated list drifts in the direction where the copy
 * says yes — the client offers a source the server then refuses, and the
 * refusal lands on a person who did exactly what the screen invited.
 *
 * The client's list is the DISPLAY kinds, so it is longer: six spellings
 * collapse to `tool` and two to `transform`. The mapping is what is asserted,
 * not the lists.
 */
describe("the client's mirror agrees", () => {
  /** Display kind → the real kind the server sees. */
  const REAL: Record<string, string> = {
    trigger: "tool", action: "tool", notify: "tool", report: "tool", end: "tool", tool: "tool",
    transform: "transform", calculate: "transform",
    datasource: "datasource", query: "query",
  };

  it("every kind the client offers maps to one the server accepts", () => {
    for (const k of MERGE_SOURCE_KINDS) {
      expect(REAL[k], `client offers "${k}" — which real kind is that?`).toBeDefined();
      expect(SERVER_MERGE_SOURCE_KINDS).toContain(REAL[k]);
    }
  });

  it("every kind the server accepts is reachable from the client", () => {
    const reachable = new Set(MERGE_SOURCE_KINDS.map((k) => REAL[k]));
    for (const k of SERVER_MERGE_SOURCE_KINDS) expect(reachable).toContain(k);
  });

  /**
   * The control. Without it both assertions above pass over lists that happen
   * to agree by being permissive — this states the kinds that must NOT be
   * offered are genuinely absent from the client's list.
   */
  it.each(["code", "approval", "branch", "condition", "merge"])(
    "does not offer %s as a source",
    (k) => {
      expect(MERGE_SOURCE_KINDS).not.toContain(k);
    },
  );
});

describe("the shape table", () => {
  /**
   * ⚠ A merge shares `transform`'s spelling BY CONSTRUCTION, not by
   * coincidence: it emits the same task type, and its sources are restricted to
   * the four JSON-bodied kinds precisely so this stays true whichever arm ran.
   * If a `code` source were ever admitted, this entry would silently stop being
   * true for some merges and not others.
   */
  it("reads like a transform", () => {
    expect(OUTPUT_SHAPES.merge.template).toBe("json(outputs.<id>.value)");
    expect(OUTPUT_SHAPES.merge.template).toBe(OUTPUT_SHAPES.transform.template);
  });

  it("warns that nothing having run is a null, not an error", () => {
    expect(OUTPUT_SHAPES.merge.caution).toMatch(/null/);
  });
});
