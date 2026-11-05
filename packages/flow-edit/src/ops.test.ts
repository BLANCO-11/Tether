/**
 * The seven ops. foundations Phase 2.3 · D-118.
 *
 * The two REFUSALS below are the reason this file matters more than its length
 * suggests: `add_step` refusing an `approval`, and `replace_step` refusing a
 * rename or a kind change. Each is a capability that was deliberately deleted,
 * and a deleted capability with no test is one somebody adds back in a fortnight
 * because it would obviously be convenient.
 */
import { describe, expect, it } from "vitest";
import {
  applyDesyncRepair,
  applyOp,
  assertOnlyTouched,
  bindingDesync,
  checkCodeInputExpr,
  describeOp,
  inputsReadBy,
  touchedBy,
  FLOW_EDIT_OPS,
  type BindingDesync,
  type FlowEditOp,
} from "./ops.js";
import type { AuthoredFlow, AuthoredStep, ContractField, FlowOutputRow, Source } from "./index.js";

const flow: AuthoredFlow = {
  id: "chase_overdue",
  steps: [
    { kind: "datasource", id: "overdue", ref: "q.overdue", paramsExpr: "[{}]" },
    { kind: "transform", id: "shape", expr: "{{ 1 }}", dependsOn: ["overdue"] },
    { kind: "tool", id: "send", ref: "mail_send", paramsExpr: "[{}]", dependsOn: ["shape"] },
  ],
};

function ok(r: ReturnType<typeof applyOp>): AuthoredFlow {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.flow;
}
function refusal(r: ReturnType<typeof applyOp>): string {
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
}

describe("the op vocabulary", () => {
  /**
   * ⚠ Seven when the plan was written; **eight** since Phase 3 (`set_condition`),
   * **thirteen** since chat-can-configure-everything (the granular editors,
   * `add_io`, `remove_io`, `set_retry`, `remove_input`), **fourteen** since the
   * E2E-found mid-chain gap (`insert_step`), and **sixteen** since the
   * bare-branch refusal (`add_arm`/`remove_arm` — an elif/otherwise link plus
   * its first guarded step, atomically, so the compiler never sees a bare
   * branch).
   *
   * ⚠ **NINETEEN since `set_output`** (2026-09-08) — which step's value is the
   * automation's answer. It existed because a person had NO WAY to declare one
   * at all: the builder's exit-point panel reports and does not edit (a form
   * there would be a second author of `model.output`, D-197) and it points at
   * chat, which had no op to point at.
   *
   * ⚠ **Seventeen since `set_schedule`, and eighteen since `add_guarded_step`**
   * — the branch AND the first step it guards, together. That last one closed a
   * gap found by running a conversation: with sixteen ops there was no way to
   * START a condition on a step that did not exist yet, so asking for "post to
   * the channel if any are enterprise" produced an UNGUARDED post. `add_arm`
   * had already been made atomic for exactly this reason, one case over.
  * ⚠ **TWENTY-ONE since the registry vocabulary** (Stage 6.1): the old
  * thirteen-name field op became `set_property` (any declared property),
  * `set_binding` (one typed input) and `set_output_rows` (the End rows) —
  * untyped names could not name `model`, `temperature` or `url`, so chat
  * could not configure a component at all.
  *
  * ⚠ **TWENTY-TWO since `replace_input`**: renaming a parameter had no
  * atomic op — `remove_input` refuses while anything still reads it, so a
  * rename was two visible turns through a state where nothing reads the
  * parameter at all. One op declares the new id, rebinds every reader
  * (expression templates AND structured bindings), and removes the old.
  */
  it("is exactly twenty-two ops", () => {
    expect([...FLOW_EDIT_OPS]).toEqual([
      "add_step",
      "insert_step",
      "remove_step",
      "replace_step",
      "connect",
      "disconnect",
      "add_gate",
      "declare_input",
      "set_condition",
      "set_property",
      "set_binding",
      "set_output_rows",
      "add_io",
      "remove_io",
      "set_retry",
      "remove_input",
      "replace_input",
      "add_arm",
      "remove_arm",
      "set_schedule",
      "add_guarded_step",
      "set_output",
    ]);
  });

  it("never mutates the flow it was given", () => {
    const snapshot = JSON.stringify(flow);
    applyOp(flow, { op: "remove_step", stepId: "shape" });
    applyOp(flow, { op: "connect", from: "overdue", to: "send" });
    expect(JSON.stringify(flow)).toBe(snapshot);
  });
});

describe("add_step", () => {
  it("adds a step with its edges", () => {
    const next = ok(
      applyOp(flow, {
        op: "add_step",
        step: { kind: "transform", id: "rollup", expr: "{{ 2 }}", dependsOn: ["shape"] },
      }),
    );
    expect(next.steps.map((s) => s.id)).toEqual(["overdue", "shape", "send", "rollup"]);
  });

  /**
   * ⚠ **The refusal that stops a gate being useless.** `addStep` APPENDS, and an
   * appended gate compiles, deploys and stops nothing — Kestra runs tasks in
   * emission order, so the email has already gone by the time anyone is asked.
   * The message has to name `add_gate`, because a refusal that does not say what
   * to do instead is one the next turn works around.
   */
  it("refuses an approval step and names add_gate", () => {
    const e = refusal(
      applyOp(flow, {
        op: "add_step",
        step: { kind: "approval", id: "gate", summaryExpr: '"ok?"' },
      }),
    );
    expect(e).toContain("add_gate");
    expect(e).toContain("BEFORE");
  });

  it("refuses a duplicate id", () => {
    expect(
      refusal(
        applyOp(flow, {
          op: "add_step",
          step: { kind: "transform", id: "shape", expr: "{{ 1 }}" },
        }),
      ),
    ).toContain("already has a step");
  });
});

describe("remove_step", () => {
  it("takes the step and every edge that named it", () => {
    const next = ok(applyOp(flow, { op: "remove_step", stepId: "shape" }));
    expect(next.steps.map((s) => s.id)).toEqual(["overdue", "send"]);
    expect(next.steps.find((s) => s.id === "send")?.dependsOn).toEqual([]);
  });
});

describe("replace_step — the two deleted capabilities", () => {
  it("replaces a step in place", () => {
    const next = ok(
      applyOp(flow, {
        op: "replace_step",
        stepId: "send",
        step: {
          kind: "tool",
          id: "send",
          ref: "mail_send",
          paramsExpr: '[{"to":"x"}]',
          dependsOn: ["shape"],
        },
      }),
    );
    expect(next.steps.find((s) => s.id === "send")).toMatchObject({ paramsExpr: '[{"to":"x"}]' });
  });

  /**
   * ⚠ There is no rename op, so this is the one place a rename could arrive.
   * `buildRefinePrompt` only WARNS that a rename discards generated code — a
   * warning is not a control, so the capability is removed rather than
   * cautioned about.
   */
  it("refuses a rename, and says what a rename costs", () => {
    const e = refusal(
      applyOp(flow, {
        op: "replace_step",
        stepId: "send",
        step: { kind: "tool", id: "send_mail", ref: "mail_send", paramsExpr: "[{}]" },
      }),
    );
    expect(e).toContain("cannot be renamed");
    expect(e).toContain("generated code");
  });

  /** A kind change rewrites every field — from one ambiguous sentence, that is the whole risk. */
  it("refuses a kind change, and names the two-turn alternative", () => {
    const e = refusal(
      applyOp(flow, {
        op: "replace_step",
        stepId: "send",
        step: { kind: "transform", id: "send", expr: "{{ 1 }}" },
      }),
    );
    expect(e).toContain("cannot become");
    expect(e).toContain("remove it and add");
  });

  it("refuses a step that is not in the flow", () => {
    expect(
      refusal(
        applyOp(flow, {
          op: "replace_step",
          stepId: "nope",
          step: { kind: "transform", id: "nope", expr: "{{ 1 }}" },
        }),
      ),
    ).toContain("not in this flow");
  });
});

describe("connect / disconnect", () => {
  it("adds and removes an edge", () => {
    const linked = ok(applyOp(flow, { op: "connect", from: "overdue", to: "send" }));
    expect(linked.steps.find((s) => s.id === "send")?.dependsOn).toEqual(["shape", "overdue"]);
    const unlinked = ok(applyOp(linked, { op: "disconnect", from: "shape", to: "send" }));
    expect(unlinked.steps.find((s) => s.id === "send")?.dependsOn).toEqual(["overdue"]);
  });

  /** The cycle refusal comes from `connect` itself — one implementation, both callers. */
  it("refuses a link that would close a cycle", () => {
    expect(refusal(applyOp(flow, { op: "connect", from: "send", to: "overdue" }))).toMatch(
      /cycle|loop|already runs/i,
    );
  });
});

describe("add_gate", () => {
  /**
   * ⚠ **BEFORE, never after.** The gate takes the target's dependencies and the
   * target is repointed to depend on the gate alone — so the send is genuinely
   * unreachable until a person decides.
   */
  it("splices the gate in front of its target", () => {
    const next = ok(applyOp(flow, { op: "add_gate", beforeStepId: "send" }));
    expect(next.steps.map((s) => s.id)).toEqual(["overdue", "shape", "send_gate", "send"]);
    expect(next.steps.find((s) => s.id === "send_gate")?.dependsOn).toEqual(["shape"]);
    expect(next.steps.find((s) => s.id === "send")?.dependsOn).toEqual(["send_gate"]);
  });

  it("refuses a gate in front of a gate", () => {
    const once = ok(applyOp(flow, { op: "add_gate", beforeStepId: "send" }));
    expect(refusal(applyOp(once, { op: "add_gate", beforeStepId: "send_gate" }))).toContain(
      "does not need a gate",
    );
  });
});

describe("declare_input", () => {
  it("declares an input", () => {
    const next = ok(
      applyOp(flow, { op: "declare_input", input: { id: "period", type: "STRING", required: true } }),
    );
    expect(next.inputs).toEqual([{ id: "period", type: "STRING", required: true }]);
  });

  it("carries a derivation onto the model", () => {
    const next = ok(
      applyOp(
        flow,
        { op: "declare_input", input: { id: "period", type: "STRING", required: true, computed: "priorMonth" } },
      ),
    );
    expect(next.inputs).toEqual([{ id: "period", type: "STRING", required: true, computed: "priorMonth" }]);
  });

  it("refuses a second input with the same id", () => {
    const once = ok(applyOp(flow, { op: "declare_input", input: { id: "period", type: "STRING" } }));
    expect(
      refusal(applyOp(once, { op: "declare_input", input: { id: "period", type: "DATE" } })),
    ).toContain("already declares");
  });

  /**
   * ⚠ The type has no `defaults` field, so this is a compile-time refusal here —
   * the RUNTIME one is `chatFlowInputSchema.strict()` on the server, tested in
   * `flow-chat-op.test.ts`. Both halves are wanted: without `.strict()` zod would
   * strip the key silently, and a stripped field is a request that looked like it
   * worked.
   */
  it("has no defaults field to set", () => {
    const op = { op: "declare_input", input: { id: "period", type: "STRING" } } as const;
    expect(Object.keys(op.input)).toEqual(["id", "type"]);
  });
});

// ── touchedBy and assertOnlyTouched ─────────────────────────────────────────

describe("touchedBy — computed, never taken from the model", () => {
  it("names only the added step", () => {
    expect(
      touchedBy(flow, {
        op: "add_step",
        step: { kind: "transform", id: "rollup", expr: "{{ 1 }}" },
      }),
    ).toEqual(["rollup"]);
  });

  /**
   * ⚠ It is NOT "the step the op names". `removeStep` strips the edge from every
   * step that ran after it, and an over-tight set would refuse a correct turn —
   * which is how a control gets widened until it permits the defect (I-62).
   */
  it("includes the steps a removal legitimately rewrites", () => {
    expect(touchedBy(flow, { op: "remove_step", stepId: "shape" }).sort()).toEqual([
      "send",
      "shape",
    ]);
  });

  it("names the downstream end of an edge, because that is where dependsOn lives", () => {
    expect(touchedBy(flow, { op: "connect", from: "overdue", to: "send" })).toEqual(["send"]);
  });

  it("names the gate and its target", () => {
    expect(touchedBy(flow, { op: "add_gate", beforeStepId: "send" }).sort()).toEqual([
      "send",
      "send_gate",
    ]);
  });

  it("names no step for an input declaration", () => {
    expect(touchedBy(flow, { op: "declare_input", input: { id: "p", type: "STRING" } })).toEqual([]);
  });
});

describe("assertOnlyTouched", () => {
  /** Every op, applied for real, must stay inside its own footprint. */
  const cases: FlowEditOp[] = [
    { op: "add_step", step: { kind: "transform", id: "rollup", expr: "{{ 1 }}" } },
    { op: "remove_step", stepId: "shape" },
    {
      op: "replace_step",
      stepId: "send",
      step: { kind: "tool", id: "send", ref: "mail_send", paramsExpr: '[{"to":"x"}]', dependsOn: ["shape"] },
    },
    { op: "connect", from: "overdue", to: "send" },
    { op: "disconnect", from: "shape", to: "send" },
    { op: "add_gate", beforeStepId: "send" },
    { op: "declare_input", input: { id: "period", type: "STRING" } },
  ];

  it.each(cases.map((c) => [c.op, c] as const))("%s stays inside its footprint", (_name, op) => {
    const after = ok(applyOp(flow, op));
    expect(assertOnlyTouched(flow, after, touchedBy(flow, op))).toBeNull();
  });

  /**
   * ⚠ **The control.** An assertion that only ever returns `null` is one that
   * cannot fail (I-38), so here is an edit that really does change a step nobody
   * asked about — the exact class of bug this exists to convert into a refusal.
   */
  it("catches a step that changed outside the permitted set", () => {
    const after = ok(applyOp(flow, { op: "connect", from: "overdue", to: "send" }));
    const sabotaged: AuthoredFlow = {
      ...after,
      steps: after.steps.map((s) => (s.id === "shape" ? { ...s, expr: "{{ 999 }}" } : s)),
    };
    const finding = assertOnlyTouched(flow, sabotaged, ["send"]);
    expect(finding).toContain("shape");
    expect(finding).toContain("Refusing the turn");
  });

  it("catches a step that vanished, and one that appeared", () => {
    const fewer: AuthoredFlow = { ...flow, steps: flow.steps.filter((s) => s.id !== "shape") };
    expect(assertOnlyTouched(flow, fewer, ["send"])).toContain("shape (removed)");
    const more: AuthoredFlow = {
      ...flow,
      steps: [...flow.steps, { kind: "transform", id: "sneak", expr: "{{ 1 }}" }],
    };
    expect(assertOnlyTouched(flow, more, ["send"])).toContain("sneak (added)");
  });

  /** Splicing reorders; an order-sensitive comparison would fire on every gate. */
  it("does not fire on step order alone", () => {
    const reordered: AuthoredFlow = { ...flow, steps: [...flow.steps].reverse() };
    expect(assertOnlyTouched(flow, reordered, [])).toBeNull();
  });
});

describe("describeOp", () => {
  it("says what each op did, in one sentence", () => {
    expect(
      describeOp(flow, {
        op: "add_step",
        step: { kind: "tool", id: "notify", ref: "mail_send", paramsExpr: "[{}]", dependsOn: ["send"] },
      }),
    ).toBe('added a tool step "notify", running after send');
    expect(describeOp(flow, { op: "remove_step", stepId: "shape" })).toContain(
      "send no longer run after it",
    );
    expect(describeOp(flow, { op: "connect", from: "overdue", to: "send" })).toBe(
      'made "send" run after "overdue"',
    );
    expect(describeOp(flow, { op: "add_gate", beforeStepId: "send" })).toContain(
      "waits for a person",
    );
    expect(describeOp(flow, { op: "declare_input", input: { id: "period", type: "DATE" } })).toBe(
      'declared an input "period" (DATE)',
    );
  });

  it("uses the right article for an approval step", () => {
    expect(
      describeOp(flow, {
        op: "add_step",
        step: { kind: "approval", id: "ask", summaryExpr: '"why?"' },
      }),
    ).toContain("added an approval step");
  });
});


// ── The branch guard (Phase 3) ───────────────────────────────────────────────

describe("set_condition", () => {
  const guarded: AuthoredFlow = {
    id: "chase_overdue",
    steps: [
      { kind: "datasource", id: "overdue", ref: "q.overdue", paramsExpr: "[{}]" },
      { kind: "branch", id: "any_rows", conditionExpr: "{{ 1 }}", dependsOn: ["overdue"] },
      { kind: "tool", id: "send", ref: "mail_send", paramsExpr: "[{}]", dependsOn: ["any_rows"] },
      { kind: "transform", id: "log", expr: "{{ 2 }}", dependsOn: ["send"] },
    ],
  };

  it("changes the condition and nothing else", () => {
    const next = ok(applyOp(guarded, { op: "set_condition", stepId: "any_rows", conditionExpr: "{{ 2 }}" }));
    expect(next.steps.find((s) => s.id === "any_rows")).toEqual({
      kind: "branch",
      id: "any_rows",
      conditionExpr: "{{ 2 }}",
      dependsOn: ["overdue"],
    });
    expect(assertOnlyTouched(guarded, next, touchedBy(guarded, { op: "set_condition", stepId: "any_rows", conditionExpr: "{{ 2 }}" }))).toBeNull();
  });

  it("refuses a step that has no condition", () => {
    expect(refusal(applyOp(guarded, { op: "set_condition", stepId: "send", conditionExpr: "{{ 2 }}" }))).toContain(
      "not a condition",
    );
  });

  /**
   * ⚠ **The refusal that keeps the vocabulary honest.** `replace_step` carries a
   * whole step, so without this a condition change could arrive as a settings
   * edit — and the transcript would describe "always email" as *"changed the
   * settings of any_rows"*, for ever.
   */
  it("replace_step refuses to move a condition", () => {
    const e = refusal(
      applyOp(guarded, {
        op: "replace_step",
        stepId: "any_rows",
        step: { kind: "branch", id: "any_rows", conditionExpr: "{{ 9 }}", dependsOn: ["overdue"] },
      }),
    );
    expect(e).toContain("set_condition");
    expect(e).toContain("changes which steps run");
  });

  it("replace_step still allows an edge change on a branch", () => {
    const next = ok(
      applyOp(guarded, {
        op: "replace_step",
        stepId: "any_rows",
        step: { kind: "branch", id: "any_rows", conditionExpr: "{{ 1 }}", dependsOn: [] },
      }),
    );
    expect(next.steps.find((s) => s.id === "any_rows")?.dependsOn).toEqual([]);
  });

  /**
   * ⚠ Removing a branch un-guards its whole arm, transitively. A `touchedBy`
   * naming only the immediate dependants would make `assertOnlyTouched` fire on
   * a correct edit — and a control that refuses correct work gets widened until
   * it permits the defect (I-62).
   */
  it("removing a branch permits the whole arm to move", () => {
    const op = { op: "remove_step", stepId: "any_rows" } as const;
    expect(touchedBy(guarded, op).sort()).toEqual(["any_rows", "log", "send"]);
    const next = ok(applyOp(guarded, op));
    expect(assertOnlyTouched(guarded, next, touchedBy(guarded, op))).toBeNull();
  });

  it("describes what a condition change means in terms of what runs", () => {
    expect(describeOp(guarded, { op: "set_condition", stepId: "any_rows", conditionExpr: "{{ 2 }}" })).toBe(
      'changed when "any_rows" lets send, log run',
    );
  });
});

// ── The granular editors (chat-can-configure-everything) ─────────────────────

const rich: AuthoredFlow = {
  id: "rich",
  inputs: [{ id: "period", type: "STRING", required: true }],
  steps: [
    { kind: "tool", id: "fetch", ref: "q.fetch", paramsExpr: '[{"period": "{{ inputs.period }}"}]' },
    {
      kind: "code",
      id: "rank",
      inputExpr: "{{ 1 }}",
      contract: { purpose: "rank them", input: [], output: [{ name: "ranked", type: "array" }] },
      dependsOn: ["fetch"],
    },
    { kind: "approval", id: "ask", summaryExpr: '"why?"', dependsOn: ["rank"] },
    { kind: "approval", id: "gate", summaryExpr: '"ok?"', dependsOn: ["ask"] },
    { kind: "branch", id: "guard", conditionExpr: "{{ 1 }}", dependsOn: ["fetch"] },
  ],
};

const typed: AuthoredFlow = {
  id: "typed",
  inputs: [{ id: "period", type: "STRING", required: true }],
  steps: [
    { kind: "datasource", id: "overdue", ref: "q.overdue", paramsExpr: "[{}]" },
    { kind: "tool", id: "fetch", ref: "q.fetch", paramsExpr: "[{}]", dependsOn: ["overdue"] },
    {
      kind: "code",
      id: "rank",
      inputExpr: "{{ 1 }}",
      contract: {
        purpose: "rank them",
        input: [{ name: "rows", type: "array" }],
        output: [{ name: "ranked", type: "array" }],
      },
      dependsOn: ["fetch"],
    },
    { kind: "approval", id: "ask", summaryExpr: '"why?"', dependsOn: ["rank"] },
    { kind: "branch", id: "guard", conditionExpr: "{{ 1 }}", dependsOn: ["fetch"] },
    { kind: "transform", id: "shape", expr: "{{ 1 }}", dependsOn: ["fetch"] },
    {
      kind: "llm",
      id: "judge",
      model: "test-model",
      tempPreset: "balanced",
      temperature: 0.7,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      promptBlocks: [{ role: "user", text: "pick the urgent ones" }],
      outputFields: [],
      memoryEnabled: false,
      visionDetail: "low",
      reasoningSeparated: false,
      dependsOn: ["fetch"],
    },
    {
      kind: "http",
      id: "post",
      method: "POST",
      url: "https://hooks.example.internal/shortlist",
      headers: [],
      queryParams: [],
      body: { kind: "none", content: "" },
      auth: { kind: "none" },
      sslVerify: true,
      dependsOn: ["judge"],
    },
    { kind: "merge", id: "either", sources: ["rank", "shape"], dependsOn: ["rank", "shape"] },
  ],
};

describe("set_property — one registry property, kind-checked", () => {
  it("sets a registry property without re-emitting the step", () => {
    const next = ok(
      applyOp(typed, { op: "set_property", stepId: "fetch", property: "ref", value: "q.other" }),
    );
    expect(next.steps.find((s) => s.id === "fetch")).toMatchObject({ ref: "q.other" });
    expect(
      assertOnlyTouched(
        typed,
        next,
        touchedBy(typed, { op: "set_property", stepId: "fetch", property: "ref", value: "x" }),
      ),
    ).toBeNull();
  });

  it("sets typed scalars by spec kind", () => {
    const judge = (property: string, value: unknown) =>
      ok(applyOp(typed, { op: "set_property", stepId: "judge", property, value })).steps.find(
        (s) => s.id === "judge",
      );
    expect(judge("model", "other-model")).toMatchObject({ model: "other-model" });
    expect(judge("temperature", 0.2)).toMatchObject({ temperature: 0.2 });
    expect(judge("tempPreset", "creative")).toMatchObject({ tempPreset: "creative" });
    expect(judge("memoryEnabled", true)).toMatchObject({ memoryEnabled: true });
    expect(
      ok(applyOp(typed, { op: "set_property", stepId: "post", property: "method", value: "PUT" })).steps.find(
        (s) => s.id === "post",
      ),
    ).toMatchObject({ method: "PUT" });
    expect(
      ok(
        applyOp(typed, { op: "set_property", stepId: "post", property: "sslVerify", value: false }),
      ).steps.find((s) => s.id === "post"),
    ).toMatchObject({ sslVerify: false });
    expect(
      ok(
        applyOp(typed, { op: "set_property", stepId: "shape", property: "mode", value: "template" }),
      ).steps.find((s) => s.id === "shape"),
    ).toMatchObject({ mode: "template" });
    expect(
      ok(
        applyOp(typed, { op: "set_property", stepId: "ask", property: "summary", value: "Approve?" }),
      ).steps.find((s) => s.id === "ask"),
    ).toMatchObject({ summary: "Approve?" });
    expect(
      ok(
        applyOp(typed, { op: "set_property", stepId: "ask", property: "awaitSeconds", value: 120 }),
      ).steps.find((s) => s.id === "ask"),
    ).toMatchObject({ awaitSeconds: 120 });
  });

  it("sets collections and groups by spec kind", () => {
    expect(
      ok(
        applyOp(typed, {
          op: "set_property",
          stepId: "post",
          property: "headers",
          value: [{ name: "X-Team", value: "ap" }],
        }),
      ).steps.find((s) => s.id === "post"),
    ).toMatchObject({ headers: [{ name: "X-Team", value: "ap" }] });
    expect(
      ok(
        applyOp(typed, {
          op: "set_property",
          stepId: "judge",
          property: "outputFields",
          value: [{ name: "summary", type: "string" }],
        }),
      ).steps.find((s) => s.id === "judge"),
    ).toMatchObject({ outputFields: [{ name: "summary", type: "string" }] });
    expect(
      ok(
        applyOp(typed, {
          op: "set_property",
          stepId: "judge",
          property: "promptBlocks",
          value: [{ role: "system", text: "be terse" }],
        }),
      ).steps.find((s) => s.id === "judge"),
    ).toMatchObject({ promptBlocks: [{ role: "system", text: "be terse" }] });
    expect(
      ok(
        applyOp(typed, {
          op: "set_property",
          stepId: "either",
          property: "sources",
          value: ["shape", "rank"],
        }),
      ).steps.find((s) => s.id === "either"),
    ).toMatchObject({ sources: ["shape", "rank"] });
    expect(
      ok(
        applyOp(typed, {
          op: "set_property",
          stepId: "guard",
          property: "test",
          value: {
            left: { from: "step", stepId: "fetch", field: "total" },
            operator: "field_gt",
            right: "100",
          },
        }),
      ).steps.find((s) => s.id === "guard"),
    ).toMatchObject({ test: { operator: "field_gt" } });
    // A step-field takes a bare step id as well as a Source.
    expect(
      ok(
        applyOp(typed, {
          op: "set_property",
          stepId: "judge",
          property: "contextStepId",
          value: "fetch",
        }),
      ).steps.find((s) => s.id === "judge"),
    ).toMatchObject({ contextStepId: "fetch" });
  });

  it("refuses a property the kind does not declare, naming kind and property", () => {
    const e = refusal(
      applyOp(typed, { op: "set_property", stepId: "fetch", property: "model", value: "m" }),
    );
    expect(e).toContain('a tool step has no "model" property');
    expect(
      refusal(
        applyOp(typed, { op: "set_property", stepId: "shape", property: "frobnicate", value: 1 }),
      ),
    ).toContain('a transform step has no "frobnicate" property');
  });

  it("refuses a value of the wrong shape for the spec kind", () => {
    const judge = (property: string, value: unknown) =>
      refusal(applyOp(typed, { op: "set_property", stepId: "judge", property, value }));
    expect(judge("temperature", "hot")).toContain("must be a number");
    expect(judge("temperature", 2)).toContain("0..1");
    expect(judge("tempPreset", "volcanic")).toContain('"precise"');
    expect(judge("memoryEnabled", "yes")).toContain("true or false");
    expect(judge("model", "")).toContain("model id");
    expect(judge("promptBlocks", [{ role: "user", text: "" }])).toContain("carries text");
    expect(judge("promptBlocks", [{ role: "boss", text: "x" }])).toContain("role");
    expect(
      refusal(
        applyOp(typed, { op: "set_property", stepId: "post", property: "headers", value: [{ name: "X" }] }),
      ),
    ).toContain("string value");
    expect(judge("outputFields", [{ name: "9lives", type: "string" }])).toContain(
      "not a valid field name",
    );
    expect(judge("outputFields", [{ name: "ok", type: "int" }])).toContain("not a contract type");
    expect(
      refusal(
        applyOp(typed, { op: "set_property", stepId: "either", property: "sources", value: ["nope"] }),
      ),
    ).toContain("not in this flow");
    expect(
      refusal(
        applyOp(typed, {
          op: "set_property",
          stepId: "guard",
          property: "test",
          value: { left: { from: "step", stepId: "fetch", field: "total" }, operator: "matches" },
        }),
      ),
    ).toContain("operator");
  });

  it("sets free labels on any kind", () => {
    const next = ok(
      applyOp(typed, { op: "set_property", stepId: "fetch", property: "name", value: "Fetch" }),
    );
    expect(next.steps.find((s) => s.id === "fetch")).toMatchObject({ name: "Fetch" });
    const desc = ok(
      applyOp(typed, { op: "set_property", stepId: "shape", property: "description", value: "why" }),
    );
    expect(desc.steps.find((s) => s.id === "shape")).toMatchObject({ description: "why" });
    expect(
      refusal(applyOp(typed, { op: "set_property", stepId: "fetch", property: "name", value: 7 })),
    ).toContain("must be a string");
  });

  it("refuses structural keys with their owners' pointers", () => {
    expect(
      refusal(applyOp(typed, { op: "set_property", stepId: "fetch", property: "id", value: "fetch2" })),
    ).toContain("cannot be renamed");
    expect(
      refusal(
        applyOp(typed, { op: "set_property", stepId: "fetch", property: "kind", value: "transform" }),
      ),
    ).toContain("remove it and add");
    expect(
      refusal(
        applyOp(typed, { op: "set_property", stepId: "fetch", property: "dependsOn", value: ["shape"] }),
      ),
    ).toContain("connect and disconnect");
  });

  /**
   * ⚠ The condition refusal that keeps the vocabulary honest, in its new
   * spelling: a condition change is `set_condition`, never a property edit —
   * and `paramsExpr`/`inputExpr`/`summaryExpr`/`contextExpr` name the op that
   * owns each successor rather than failing parse with no pointer.
   */
  it("refuses retired display strings with the op that owns the successor", () => {
    const cond = refusal(
      applyOp(typed, { op: "set_property", stepId: "guard", property: "conditionExpr", value: "{{ 2 }}" }),
    );
    expect(cond).toContain("set_condition");
    expect(cond).toContain("changes which steps run");
    // Blob steps (no granular bindings) accept the blob write — refusing it
    // while replace_step took the same blob is what failed UAT turns, so the
    // refusal now applies only once bindings exist.
    const boundFetch = ok(
      applyOp(typed, {
        op: "set_binding",
        stepId: "fetch",
        name: "q",
        source: { from: "literal", value: "x" },
      }),
    );
    expect(
      refusal(
        applyOp(boundFetch, { op: "set_property", stepId: "fetch", property: "paramsExpr", value: "[{}]" }),
      ),
    ).toContain("set_binding");
    const boundRank = ok(
      applyOp(typed, {
        op: "set_binding",
        stepId: "rank",
        name: "rows",
        source: { from: "literal", value: "x" },
      }),
    );
    expect(
      refusal(
        applyOp(boundRank, { op: "set_property", stepId: "rank", property: "inputExpr", value: "{{ 1 }}" }),
      ),
    ).toContain("set_binding");
    expect(
      refusal(
        applyOp(typed, { op: "set_property", stepId: "ask", property: "summaryExpr", value: '"q"' }),
      ),
    ).toContain('property "summary"');
    expect(
      refusal(
        applyOp(typed, { op: "set_property", stepId: "ask", property: "contextExpr", value: "{{ 1 }}" }),
      ),
    ).toContain('property "context"');
  });

  it("refuses an unknown step with the same message as replace_step", () => {
    expect(
      refusal(applyOp(typed, { op: "set_property", stepId: "nope", property: "ref", value: "q.x" })),
    ).toContain("not in this flow");
  });
});

describe("set_binding — one typed input", () => {
  const rows = { from: "step", stepId: "overdue", field: "body" } as const;

  it("binds one input and stays inside its footprint", () => {
    const op = { op: "set_binding", stepId: "fetch", name: "rows", source: rows } as const;
    const next = ok(applyOp(typed, op));
    expect(next.steps.find((s) => s.id === "fetch")).toMatchObject({
      inputs: [{ name: "rows", source: rows }],
    });
    expect(assertOnlyTouched(typed, next, touchedBy(typed, op))).toBeNull();
  });

  it("replaces a binding with the same name, and removes it with null", () => {
    const bound = ok(
      applyOp(typed, { op: "set_binding", stepId: "fetch", name: "rows", source: rows }),
    );
    const rebound = ok(
      applyOp(bound, {
        op: "set_binding",
        stepId: "fetch",
        name: "rows",
        source: { from: "input", inputId: "period" },
      }),
    );
    expect(rebound.steps.find((s) => s.id === "fetch")).toMatchObject({
      inputs: [{ name: "rows", source: { from: "input", inputId: "period" } }],
    });
    const unbound = ok(
      applyOp(rebound, { op: "set_binding", stepId: "fetch", name: "rows", source: null }),
    );
    expect(unbound.steps.find((s) => s.id === "fetch")).toMatchObject({ inputs: [] });
  });

  it("refuses a kind with no named inputs", () => {
    const e = refusal(
      applyOp(typed, {
        op: "set_binding",
        stepId: "shape",
        name: "rows",
        source: { from: "input", inputId: "period" },
      }),
    );
    expect(e).toContain("has no named inputs");
    expect(e).toContain("tool, datasource, query and code");
  });

  it("holds a code name to its contract", () => {
    const next = ok(
      applyOp(typed, {
        op: "set_binding",
        stepId: "rank",
        name: "rows",
        source: { from: "step", stepId: "fetch", field: "body" },
      }),
    );
    expect(next.steps.find((s) => s.id === "rank")).toMatchObject({
      inputs: [{ name: "rows" }],
    });
    const e = refusal(
      applyOp(typed, {
        op: "set_binding",
        stepId: "rank",
        name: "nope",
        source: { from: "input", inputId: "period" },
      }),
    );
    expect(e).toContain('has no contract input called "nope"');
    expect(e).toContain("add_io");
  });

  it("refuses a source that is not a Source", () => {
    const badSource = (s: unknown): Source => s as Source;
    expect(
      refusal(
        applyOp(typed, { op: "set_binding", stepId: "fetch", name: "rows", source: badSource({ from: "step" }) }),
      ),
    ).toContain("must be a Source");
    expect(
      refusal(
        applyOp(typed, {
          op: "set_binding",
          stepId: "fetch",
          name: "rows",
          source: badSource({ from: "nowhere" }),
        }),
      ),
    ).toContain('"from" must be one of');
  });

  /**
   * Measured 2026-09-14: a from-model step carries BOTH typed bindings and a
   * rendered `paramsExpr` display, and every validator reads the display.
   * Rebinding the typed half while the display still named the old input left
   * a dangling ref the next turn correctly refused.
   */
  it("drops a derived display once the bindings carry every pair (I-204)", () => {
    const shown: AuthoredFlow = {
      id: "shown",
      inputs: [
        { id: "period", type: "STRING" },
        { id: "month", type: "STRING" },
      ],
      steps: [
        {
          kind: "tool",
          id: "send",
          ref: "mail.send",
          paramsExpr: '[{"subject": "for {{ inputs.period }}", "body": ""}]',
          inputs: [
            { name: "subject", source: { from: "literal", value: "for {{ inputs.period }}" } },
            { name: "body", source: { from: "whole", stepId: "fetch" } },
          ],
        },
      ],
    };
    const next = ok(
      applyOp(shown, {
        op: "set_binding",
        stepId: "send",
        name: "subject",
        source: { from: "literal", value: "for {{ inputs.month }}" },
      }),
    );
    const sent = next.steps.find((s) => s.id === "send")!;
      // I-204: a binding op writes BINDINGS ONLY and drops the blob when it carries nothing the
      // bindings do not — the old re-render kept two representations (FT0206) and wrote "" for step reads.
    expect(sent).not.toHaveProperty("paramsExpr");
    expect(sent).toMatchObject({ inputs: [{ name: "body" }, { name: "subject", source: { from: "literal", value: "for {{ inputs.month }}" } }] });
    expect(assertOnlyTouched(shown, next, touchedBy(shown, {
      op: "set_binding",
      stepId: "send",
      name: "subject",
      source: { from: "literal", value: "for {{ inputs.month }}" },
    }))).toBeNull();
  });

  /**
   * Measured 2026-09-14: leaving a blob display alone while adding a binding
   * filed success for an edit the compiler never saw — `paramsExpr` wins
   * verbatim, so the new binding compiled to nothing. The merge keeps the
   * blob's pairs and appends the edited one, so both halves stay honest.
   */
  it("lifts a chat-born blob's plain pairs into bindings and drops it (I-204)", () => {
    const blob: AuthoredFlow = {
      id: "blob",
      inputs: [{ id: "month", type: "STRING" }],
      steps: [
        {
          kind: "tool",
          id: "send",
          ref: "mail.send",
          paramsExpr: '[{"to": "ops@example.com", "body": "hi"}]',
        },
      ],
    };
    const op = {
      op: "set_binding",
      stepId: "send",
      name: "subject",
      source: { from: "literal", value: "for {{ inputs.month }}" },
    } as const;
    const next = ok(applyOp(blob, op));
    const sent = next.steps.find((s) => s.id === "send")!;
      // I-204: a binding op writes BINDINGS ONLY and drops the blob when it carries nothing the
      // bindings do not — the old re-render kept two representations (FT0206) and wrote "" for step reads.
    expect(sent).not.toHaveProperty("paramsExpr");
    expect(sent).toMatchObject({
      inputs: [
        { name: "to", source: { from: "literal", value: "ops@example.com" } },
        { name: "body", source: { from: "literal", value: "hi" } },
        { name: "subject", source: { from: "literal", value: "for {{ inputs.month }}" } },
      ],
    });
    expect(assertOnlyTouched(blob, next, touchedBy(blob, op))).toBeNull();
  });
  it("rebind-then-read agrees — the display carries the new feed, not the old", () => {
    const shown: AuthoredFlow = {
      id: "shown",
      inputs: [
        { id: "period", type: "STRING" },
        { id: "month", type: "STRING" },
      ],
      steps: [
        {
          kind: "tool",
          id: "send",
          ref: "mail.send",
          paramsExpr: '[{"subject": "for {{ inputs.period }}", "body": ""}]',
          inputs: [
            { name: "subject", source: { from: "literal", value: "for {{ inputs.period }}" } },
            { name: "body", source: { from: "whole", stepId: "fetch" } },
          ],
        },
      ],
    };
    const op = {
      op: "set_binding",
      stepId: "send",
      name: "subject",
      source: { from: "input", inputId: "month" },
    } as const;
    const result = applyOp(shown, op);
    const next = ok(result);
    // The bug was filing success while the display still named `period`.
    expect("desync" in result).toBe(false);
    expect(bindingDesync(next, "send", op.op)).toBeNull();
    expect(next.steps.find((s) => s.id === "send")).toMatchObject({
      // `set_binding` appends the edited binding last; the display keeps pre-op
      // pair order, so the two halves order differently and agree regardless.
      inputs: [
        { name: "body", source: { from: "whole", stepId: "fetch" } },
        { name: "subject", source: { from: "input", inputId: "month" } },
      ],
    });
    expect(next.steps.find((s) => s.id === "send")).not.toHaveProperty("paramsExpr");
    expect(JSON.stringify(next)).not.toContain("inputs.period");
    expect(assertOnlyTouched(shown, next, touchedBy(shown, op))).toBeNull();
  });

  it("unbinding drops the pair instead of stranding a stale value", () => {
    const shown: AuthoredFlow = {
      id: "shown",
      inputs: [{ id: "period", type: "STRING" }],
      steps: [
        {
          kind: "tool",
          id: "send",
          ref: "mail.send",
          paramsExpr: '[{"subject": "for {{ inputs.period }}", "body": ""}]',
          inputs: [
            { name: "subject", source: { from: "literal", value: "for {{ inputs.period }}" } },
            { name: "body", source: { from: "whole", stepId: "fetch" } },
          ],
        },
      ],
    };
    const op = { op: "set_binding", stepId: "send", name: "subject", source: null } as const;
    const result = applyOp(shown, op);
    const next = ok(result);
    expect("desync" in result).toBe(false);
    expect(next.steps.find((s) => s.id === "send")).toMatchObject({
      inputs: [{ name: "body", source: { from: "whole", stepId: "fetch" } }],
    });
    // The unbound pair is NOT lifted back out of the blob, and the blob goes (I-204).
    expect(next.steps.find((s) => s.id === "send")).not.toHaveProperty("paramsExpr");
  });

  it("a null-source binding drops its pair — unbound passes no feed", () => {
    const shown: AuthoredFlow = {
      id: "shown",
      inputs: [{ id: "period", type: "STRING" }],
      steps: [
        { kind: "datasource", id: "fetch", ref: "q.fetch", paramsExpr: "[{}]" },
        {
          kind: "tool",
          id: "send",
          ref: "mail.send",
          paramsExpr: '[{"subject": "stale", "body": ""}]',
          inputs: [
            { name: "subject", source: null },
            { name: "body", source: { from: "whole", stepId: "fetch" } },
          ],
        },
      ],
    };
    const op = {
      op: "set_binding",
      stepId: "send",
      name: "body",
      source: { from: "whole", stepId: "fetch" },
    } as const;
    const result = applyOp(shown, op);
    const next = ok(result);
    expect("desync" in result).toBe(false);
    const sent = next.steps.find((s) => s.id === "send")!;
    expect(sent).not.toHaveProperty("paramsExpr");
    expect(sent).toMatchObject({ inputs: [{ name: "subject", source: null }, { name: "body" }] });
  });
});

/**
 * The desync signal — `applyOp` never files a bare `ok` while structured
 * bindings and the compiled display disagree (measured 2026-09-14). Where the
 * display re-renders it does (the merge above); the cases below cannot render
 * and carry a machine-readable `BindingDesync` instead, with an exact
 * suggestion when one exists. The chat loop repairs in-turn, never files them.
 */
describe("binding-desync — a binding success never files over stale compiled text", () => {
  function desyncOf(r: ReturnType<typeof applyOp>): BindingDesync {
    if (!r.ok) throw new Error(`expected ok-with-signal, got refusal: ${r.error}`);
    if (!("desync" in r)) throw new Error("expected a desync signal, got a bare ok");
    return r.desync;
  }

  it("a fan-out display signals with no suggestion — shapes live server-side", () => {
    const fanned: AuthoredFlow = {
      id: "fanned",
      inputs: [{ id: "month", type: "STRING" }],
      steps: [
        { kind: "datasource", id: "fetch", ref: "q.fetch", paramsExpr: "[{}]" },
        {
          kind: "tool",
          id: "send",
          ref: "mail.send",
          over: { stepId: "fetch", field: "body" },
          paramsExpr: '"{{ outputs.fetch.body | jq(.) }}"',
          inputs: [{ name: "subject", source: { from: "literal", value: "hi" } }],
          dependsOn: ["fetch"],
        },
      ],
    };
    const op = {
      op: "set_binding",
      stepId: "send",
      name: "subject",
      source: { from: "literal", value: "for {{ inputs.month }}" },
    } as const;
    const result = applyOp(fanned, op);
    const flow = ok(result);
    const signal = desyncOf(result);
    expect(signal).toMatchObject({
      kind: "binding-desync",
      stepId: "send",
      op: "set_binding",
      display: "paramsExpr",
      suggestedParamsExpr: null,
    });
    expect(signal.bindings).toEqual([
      { name: "subject", source: { from: "literal", value: "for {{ inputs.month }}" } },
    ]);
    expect(signal.reason).toContain('"send"');
    expect(applyDesyncRepair(flow, signal)).toBeNull();
  });

  it("an unparseable blob beside bindings signals with no suggestion", () => {
    const blob: AuthoredFlow = {
      id: "blob",
      inputs: [{ id: "month", type: "STRING" }],
      steps: [
        {
          kind: "tool",
          id: "send",
          ref: "mail.send",
          paramsExpr: '"{{ outputs.fetch.body }}"',
          inputs: [{ name: "subject", source: { from: "literal", value: "hi" } }],
        },
      ],
    };
    const op = {
      op: "set_binding",
      stepId: "send",
      name: "subject",
      source: { from: "literal", value: "for {{ inputs.month }}" },
    } as const;
    const result = applyOp(blob, op);
    ok(result);
    const signal = desyncOf(result);
    expect(signal.suggestedParamsExpr).toBeNull();
    expect(signal.paramsExpr).toBe('"{{ outputs.fetch.body }}"');
    expect(signal.reason).toContain('"send"');
  });

  it("a parseable stale display repairs in-turn: signal, patch, clean", () => {
    // A display the merge COULD have flushed still verifies through the same
    // gate when it arrives stale on another path (e.g. a model-built step):
    // `bindingDesync` spots it and `applyDesyncRepair` closes it, purely.
    const stale: AuthoredFlow = {
      id: "stale",
      inputs: [{ id: "month", type: "STRING" }],
      steps: [
        {
          kind: "tool",
          id: "send",
          ref: "mail.send",
          paramsExpr: '[{"subject": "old", "body": ""}]',
          inputs: [
            { name: "subject", source: { from: "literal", value: "for {{ inputs.month }}" } },
            { name: "body", source: { from: "whole", stepId: "fetch" } },
          ],
        },
      ],
    };
    const signal = bindingDesync(stale, "send", "replace_step");
    expect(signal).not.toBeNull();
    expect(signal!).toMatchObject({ kind: "binding-desync", stepId: "send", op: "replace_step" });
    // I-204: the repair is DROPPING the display (`""`), never a re-render.
    expect(signal!.suggestedParamsExpr).toBe("");
    const repaired = applyDesyncRepair(stale, signal!);
    expect(repaired).not.toBeNull();
    expect(bindingDesync(repaired!, "send", "replace_step")).toBeNull();
    expect(repaired!.steps.find((s) => s.id === "send")).not.toHaveProperty("paramsExpr");
    // The repair touches nothing but the display — bindings byte-identical.
    expect(repaired!.steps.find((s) => s.id === "send")).toMatchObject({
      inputs: [
        { name: "subject", source: { from: "literal", value: "for {{ inputs.month }}" } },
        { name: "body", source: { from: "whole", stepId: "fetch" } },
      ],
    });
  });

  it("a desync outside the footprint never gates an unrelated op", () => {
    const flow: AuthoredFlow = {
      id: "scoped",
      inputs: [{ id: "month", type: "STRING" }],
      steps: [
        {
          kind: "tool",
          id: "stale",
          ref: "mail.send",
          paramsExpr: '"{{ outputs.fetch.body }}"',
          inputs: [{ name: "subject", source: { from: "literal", value: "hi" } }],
        },
        { kind: "tool", id: "fresh", ref: "mail.send", paramsExpr: "[{}]", dependsOn: ["stale"] },
      ],
    };
    // Sanity: the stale step DOES disagree.
    expect(bindingDesync(flow, "stale", "set_binding")).not.toBeNull();
    // But binding on the fresh step files clean — someone else's template is
    // not this turn's blocker.
    const op = {
      op: "set_binding",
      stepId: "fresh",
      name: "subject",
      source: { from: "literal", value: "for {{ inputs.month }}" },
    } as const;
    const result = applyOp(flow, op);
    const next = ok(result);
    expect("desync" in result).toBe(false);
    // The canonical blank is not a display to keep — normalisation drops it
    // and the bindings rule — so the edit files clean with `"[{}]"` intact.
    expect(next.steps.find((s) => s.id === "fresh")).toMatchObject({
      inputs: [{ name: "subject", source: { from: "literal", value: "for {{ inputs.month }}" } }],
      paramsExpr: "[{}]",
    });
    expect(assertOnlyTouched(flow, next, touchedBy(flow, op))).toBeNull();
  });

  it("replace_input rebinds display and bindings together — no signal", () => {
    // A consistent dual-write: the display pair renders the binding, so the
    // rename's string rewrite lands on both halves and nothing disagrees.
    const renamed: AuthoredFlow = {
      id: "renamed",
      inputs: [{ id: "period", type: "STRING", required: true }],
      steps: [
        {
          kind: "tool",
          id: "send",
          ref: "mail.send",
          paramsExpr: '[{"subject": "{{ inputs.period }}"}]',
          inputs: [{ name: "subject", source: { from: "input", inputId: "period" } }],
        },
      ],
    };
    const op = {
      op: "replace_input",
      inputId: "period",
      input: { id: "month", type: "STRING", required: true },
    } as const;
    const result = applyOp(renamed, op);
    const next = ok(result);
    expect("desync" in result).toBe(false);
    expect(next.steps.find((s) => s.id === "send")).toMatchObject({
      paramsExpr: '[{"subject": "{{ inputs.month }}"}]',
      inputs: [{ name: "subject", source: { from: "input", inputId: "month" } }],
    });
    expect(bindingDesync(next, "send", op.op)).toBeNull();
  });
  it("a code inputExpr is dropped once the bindings carry every input (I-204)", () => {
    const coded: AuthoredFlow = {
      id: "coded",
      inputs: [{ id: "month", type: "STRING" }],
      steps: [
        {
          kind: "code",
          id: "rank",
          contract: {
            purpose: "rank them",
            input: [{ name: "rows", type: "array" }],
            output: [{ name: "ranked", type: "array" }],
          },
          inputExpr: '{"rows": "{{ inputs.period }}"}',
          inputs: [{ name: "rows", source: { from: "input", inputId: "period" } }],
        },
      ],
      // `period` deliberately undeclared: the rename path is not under test,
      // only that the edited display tracks the edited binding.
    };
    const op = {
      op: "set_binding",
      stepId: "rank",
      name: "rows",
      source: { from: "input", inputId: "month" },
    } as const;
    const result = applyOp(coded, op);
    const next = ok(result);
    expect("desync" in result).toBe(false);
    expect(next.steps.find((s) => s.id === "rank")).not.toHaveProperty("inputExpr");
    expect(next.steps.find((s) => s.id === "rank")).toMatchObject({ inputs: [{ name: "rows", source: { from: "input", inputId: "month" } }] });
    expect(bindingDesync(next, "rank", op.op)).toBeNull();
  });

  it("a code catalogue-shape bind signals explicitly — raw text is not a render", () => {
    const coded: AuthoredFlow = {
      id: "coded",
      inputs: [{ id: "month", type: "STRING" }],
      steps: [
        { kind: "datasource", id: "fetch", ref: "q.fetch", paramsExpr: "[{}]" },
        {
          kind: "code",
          id: "rank",
          contract: {
            purpose: "rank them",
            input: [{ name: "rows", type: "array" }],
            output: [{ name: "ranked", type: "array" }],
          },
          inputExpr: '{"rows": "{{ inputs.month }}"}',
          inputs: [{ name: "rows", source: { from: "input", inputId: "month" } }],
        },
      ],
    };
    const op = {
      op: "set_binding",
      stepId: "rank",
      name: "rows",
      source: { from: "whole", stepId: "fetch" },
    } as const;
    // I-204: the display carried only `rows`, which is now bound — so it is
    // DROPPED and the bindings compile. No signal: nothing is left to disagree.
    const result = applyOp(coded, op);
    const flow = ok(result);
    expect("desync" in result).toBe(false);
    expect(flow.steps.find((s) => s.id === "rank")).not.toHaveProperty("inputExpr");
    expect(flow.steps.find((s) => s.id === "rank")).toMatchObject({
      inputs: [{ name: "rows", source: { from: "whole", stepId: "fetch" } }],
    });

    // CONTROL: a display this module cannot read (a `{{ … }}` program) is never
    // dropped or rewritten — it signals, with no suggestion.
    const opaque: AuthoredFlow = {
      ...coded,
      steps: coded.steps.map((st) => (st.id === "rank" ? ({ ...st, inputExpr: "{{ outputs.fetch.body }}" } as typeof st) : st)),
    };
    const held = applyOp(opaque, op);
    expect(desyncOf(held)).toMatchObject({
      kind: "binding-desync",
      stepId: "rank",
      op: "set_binding",
      display: "inputExpr",
      suggestedParamsExpr: null,
    });
    expect(ok(held).steps.find((s) => s.id === "rank")).toMatchObject({ inputExpr: "{{ outputs.fetch.body }}" });
  });

  it("a desync the op did not introduce does not veto the turn", () => {
    // The drafter's blob-plus-bindings shape on an unrelated step: a retype
    // touching that step must proceed (staleness persists, status quo ante),
    // not strand behind a mess it did not make.
    const stale: AuthoredFlow = {
      id: "stale",
      inputs: [{ id: "month", type: "STRING" }],
      steps: [
        {
          kind: "tool",
          id: "send",
          ref: "mail.send",
          paramsExpr: '[{"subject": "old", "body": ""}]',
          inputs: [
            { name: "subject", source: { from: "literal", value: "for {{ inputs.month }}" } },
            { name: "body", source: { from: "whole", stepId: "fetch" } },
          ],
        },
      ],
    };
    expect(bindingDesync(stale, "send", "replace_input")).not.toBeNull();
    const result = applyOp(stale, {
      op: "replace_input",
      inputId: "month",
      input: { id: "month", type: "DATE" },
    });
    expect(result.ok).toBe(true);
    expect("desync" in result).toBe(false);
    expect((result as { flow: AuthoredFlow }).flow.inputs).toEqual([{ id: "month", type: "DATE" }]);
  });
});

describe("set_output_rows — the End rows", () => {
  const rows: FlowOutputRow[] = [
    { name: "shortlist", type: "array[object]", source: { from: "whole", stepId: "rank" } },
    { name: "posted", type: "boolean", source: { from: "step", stepId: "post", field: "status_code" } },
  ];

  it("declares rows and keeps the flow's other output keys", () => {
    const withDesc: AuthoredFlow = { ...typed, output: { description: "the chase result" } };
    const op: FlowEditOp = { op: "set_output_rows", rows: [...rows] };
    const next = ok(applyOp(withDesc, op));
    expect(next.output).toMatchObject({
      description: "the chase result",
      rows: [{ name: "shortlist" }, { name: "posted" }],
    });
    expect(assertOnlyTouched(withDesc, next, touchedBy(withDesc, op))).toBeNull();
    expect(touchedBy(withDesc, op)).toEqual([]);
  });

  it("accepts an unbound (null) source — the panel's unset state", () => {
    const next = ok(
      applyOp(typed, { op: "set_output_rows", rows: [{ name: "later", type: "string", source: null }] }),
    );
    expect(next.output?.rows).toEqual([{ name: "later", type: "string", source: null }]);
  });

  it("refuses a bad name, a bad type and an unknown step", () => {
    expect(
      refusal(
        applyOp(typed, { op: "set_output_rows", rows: [{ name: "", type: "string", source: null }] }),
      ),
    ).toContain("1..63");
    expect(
      refusal(
        applyOp(typed, {
          op: "set_output_rows",
          rows: [{ name: "x", type: "int", source: null } as unknown as FlowOutputRow],
        }),
      ),
    ).toContain('"int"');
    expect(
      refusal(
        applyOp(typed, {
          op: "set_output_rows",
          rows: [{ name: "x", type: "string", source: { from: "whole", stepId: "nope" } }],
        }),
      ),
    ).toContain('"nope"');
  });
});

describe("add_io / remove_io — code steps only", () => {
  it("adds a contract field and stays inside its footprint", () => {
    const op = {
      op: "add_io",
      stepId: "rank",
      which: "input",
      field: { name: "rows", type: "array" },
    } as const;
    const next = ok(applyOp(rich, op));
    expect(next.steps.find((s): s is Extract<AuthoredFlow["steps"][number], { kind: "code" }> => s.id === "rank" && s.kind === "code")?.contract.input).toEqual([
      { name: "rows", type: "array" },
    ]);
    expect(assertOnlyTouched(rich, next, touchedBy(rich, op))).toBeNull();
  });

  it("removes a contract field, but never the last output", () => {
    const withInput = ok(
      applyOp(rich, {
        op: "add_io",
        stepId: "rank",
        which: "input",
        field: { name: "rows", type: "array" },
      }),
    );
    const next = ok(applyOp(withInput, { op: "remove_io", stepId: "rank", which: "input", name: "rows" }));
    expect(next.steps.find((s): s is Extract<AuthoredFlow["steps"][number], { kind: "code" }> => s.id === "rank" && s.kind === "code")?.contract.input).toEqual([]);
    expect(
      refusal(applyOp(rich, { op: "remove_io", stepId: "rank", which: "output", name: "ranked" })),
    ).toContain("at least one output");
    expect(
      refusal(applyOp(rich, { op: "remove_io", stepId: "rank", which: "input", name: "nope" })),
    ).toContain('has no input called "nope"');
  });

  /**
   * ⚠ The canvas handler's own sentence. Every other kind's I/O is owned by
   * its endpoint, query, runtime or model — a chat turn adding a port to a
   * tool would be describing a contract nobody generates from.
   */
  it("refuses a non-code step with the canvas handler's message", () => {
    const e = refusal(
      applyOp(rich, {
        op: "add_io",
        stepId: "fetch",
        which: "input",
        field: { name: "rows", type: "array" },
      }),
    );
    expect(e).toContain("only a code step's inputs and outputs are editable");
    expect(e).toContain("inspector's Behavior section");
    expect(
      refusal(applyOp(rich, { op: "remove_io", stepId: "ask", which: "output", name: "text" })),
    ).toContain("only a code step's inputs and outputs are editable");
  });

  it("refuses a duplicate, a bad name and a bad type", () => {
    const withInput = ok(
      applyOp(rich, {
        op: "add_io",
        stepId: "rank",
        which: "input",
        field: { name: "rows", type: "array" },
      }),
    );
    expect(
      refusal(
        applyOp(withInput, {
          op: "add_io",
          stepId: "rank",
          which: "input",
          field: { name: "rows", type: "array" },
        }),
      ),
    ).toContain('already has an input called "rows"');
    expect(
      refusal(
        applyOp(rich, {
          op: "add_io",
          stepId: "rank",
          which: "input",
          field: { name: "9lives", type: "string" },
        }),
      ),
    ).toContain("not a valid field name");
    expect(
      refusal(
        applyOp(rich, {
          op: "add_io",
          stepId: "rank",
          which: "input",
          field: { name: "rows", type: "int" as never },
        }),
      ),
    ).toContain("not a contract type");
  });
});

describe("set_retry — the inspector's flag, kind-checked and capped", () => {
  it("sets and clears a retry on a retryable step", () => {
    const next = ok(applyOp(rich, { op: "set_retry", stepId: "fetch", retry: { maxAttempts: 3 } }));
    expect(next.steps.find((s) => s.id === "fetch")).toMatchObject({ retry: { maxAttempts: 3 } });
    expect(assertOnlyTouched(rich, next, touchedBy(rich, { op: "set_retry", stepId: "fetch", retry: { maxAttempts: 3 } }))).toBeNull();
    const cleared = ok(applyOp(next, { op: "set_retry", stepId: "fetch", retry: null }));
    expect(cleared.steps.find((s) => s.id === "fetch")).not.toHaveProperty("retry");
  });

  it("refuses a kind the compiler would refuse, naming the Retry section", () => {
    const e = refusal(applyOp(rich, { op: "set_retry", stepId: "ask", retry: { maxAttempts: 3 } }));
    expect(e).toContain("cannot declare retry");
    expect(e).toContain("inspector's Retry section");
    expect(
      refusal(applyOp(rich, { op: "set_retry", stepId: "gate", retry: { maxAttempts: 3 } })),
    ).toContain("cannot declare retry");
  });

  /** The compiler's caps, mirrored so a chat turn hears them before a save. */
  it("enforces maxAttempts, backoff, interval and duration caps", () => {
    expect(
      refusal(applyOp(rich, { op: "set_retry", stepId: "fetch", retry: { maxAttempts: 1 } })),
    ).toContain("2..5");
    expect(
      refusal(
        applyOp(rich, { op: "set_retry", stepId: "fetch", retry: { maxAttempts: 3, backoff: "jitter" as never } }),
      ),
    ).toContain('"constant" or "exponential"');
    expect(
      refusal(
        applyOp(rich, { op: "set_retry", stepId: "fetch", retry: { maxAttempts: 3, intervalSeconds: 0 } }),
      ),
    ).toContain("1..300");
    expect(
      refusal(
        applyOp(rich, {
          op: "set_retry",
          stepId: "fetch",
          retry: { maxAttempts: 3, maxDurationSeconds: 9 },
        }),
      ),
    ).toContain("10..3600");
  });
});

describe("remove_input — lifecycle without defaults", () => {
  it("removes an input nothing reads", () => {
    const unread: AuthoredFlow = { ...rich, inputs: [{ id: "theme", type: "STRING" }] };
    const next = ok(applyOp(unread, { op: "remove_input", inputId: "theme" }));
    expect(next.inputs).toEqual([]);
    expect(assertOnlyTouched(unread, next, touchedBy(unread, { op: "remove_input", inputId: "theme" }))).toBeNull();
  });

  /** Rewiring is a separate, visible edit — removal must not orphan a reader. */
  it("refuses while a step still reads inputs.<id>, and names the steps", () => {
    const e = refusal(applyOp(rich, { op: "remove_input", inputId: "period" }));
    expect(e).toContain('"fetch"');
    expect(e).toContain("inputs.period");
    expect(e).toContain("rewire those steps first");
  });

  it("refuses an input the flow never declared", () => {
    expect(refusal(applyOp(rich, { op: "remove_input", inputId: "nope" }))).toContain("declares no input");
  });
});

/**
 * `replace_input` — rename (or retype) a parameter without orphaning a reader.
 * `remove_input` refuses while anything still reads the id, so without this op
 * a rename was two turns through a state where nothing reads the parameter.
 */
describe("replace_input — one atomic rename", () => {
  const renameFlow: AuthoredFlow = {
    id: "rename",
    inputs: [
      { id: "month", type: "STRING", required: true },
      { id: "period_format", type: "STRING" },
    ],
    steps: [
      {
        kind: "tool",
        id: "fetch",
        ref: "q.fetch",
        paramsExpr: '[{"month": "{{ inputs.month }}", "fmt": "{{ inputs.period_format }}"}]',
      },
      {
        kind: "tool",
        id: "send",
        ref: "mail.send",
        paramsExpr: "[{}]",
        inputs: [{ name: "month", source: { from: "input", inputId: "month" } }],
        dependsOn: ["fetch"],
      },
    ],
  };
  const rename = {
    op: "replace_input",
    inputId: "month",
    input: { id: "period", type: "STRING", required: true },
  } as const;

  it("enumerates readers through both binding shapes", () => {
    // Expression template AND structured binding — one reader each.
    expect(inputsReadBy(renameFlow, "month")).toEqual(["fetch", "send"]);
    expect(inputsReadBy(renameFlow, "period_format")).toEqual(["fetch"]);
    expect(inputsReadBy(renameFlow, "nope")).toEqual([]);
  });

  it("never mistakes inputs.period_format for inputs.period", () => {
    const fmtOnly: AuthoredFlow = {
      ...renameFlow,
      steps: [renameFlow.steps[0]!],
      inputs: [{ id: "period_format", type: "STRING" }],
    };
    // A substring match would report "fetch" here — the boundary must not.
    expect(inputsReadBy(fmtOnly, "period")).toEqual([]);
  });

  it("converges a month→period rename across both shapes", () => {
    const next = ok(applyOp(renameFlow, { ...rename, input: { ...rename.input } }));
    expect(next.inputs).toEqual([
      { id: "period_format", type: "STRING" },
      { id: "period", type: "STRING", required: true },
    ]);
    expect(next.steps.find((s) => s.id === "fetch")).toMatchObject({
      // Rebound — while the LOOKALIKE template is byte-identical.
      paramsExpr: '[{"month": "{{ inputs.period }}", "fmt": "{{ inputs.period_format }}"}]',
    });
    expect(next.steps.find((s) => s.id === "send")).toMatchObject({
      inputs: [{ name: "month", source: { from: "input", inputId: "period" } }],
    });
    expect(touchedBy(renameFlow, rename)).toEqual(["fetch", "send"]);
    expect(assertOnlyTouched(renameFlow, next, touchedBy(renameFlow, rename))).toBeNull();
    expect(describeOp(renameFlow, rename)).toBe('renamed input "month" to "period"');
  });

  it("refuses a new id a third input already holds with a different type, leaving the flow byte-identical", () => {
    const snapshot = JSON.stringify(renameFlow);
    const e = refusal(
      applyOp(renameFlow, {
        op: "replace_input",
        inputId: "month",
        input: { id: "period_format", type: "INT" },
      }),
    );
    expect(e).toContain('already declares an input called "period_format"');
    expect(JSON.stringify(renameFlow)).toBe(snapshot);
  });

  it("merges a rename onto an identical twin instead of refusing", () => {
    const next = ok(
      applyOp(renameFlow, {
        op: "replace_input",
        inputId: "month",
        input: { id: "period_format", type: "STRING" },
      }),
    );
    expect(next.inputs).toEqual([{ id: "period_format", type: "STRING" }]);
    expect(JSON.stringify(next.steps)).toContain("inputs.period_format");
    expect(JSON.stringify(next.steps)).not.toContain("inputs.month");
  });

  it("refuses an old id the flow never declared", () => {
    expect(
      refusal(applyOp(renameFlow, { op: "replace_input", inputId: "nope", input: { id: "x", type: "STRING" } })),
    ).toContain("declares no input");
  });

  it("retypes in place and enumerates every reader for re-validation", () => {
    const retype = { op: "replace_input", inputId: "month", input: { id: "month", type: "INT", required: true } } as const;
    const next = ok(applyOp(renameFlow, retype));
    expect(next.inputs).toEqual([
      { id: "month", type: "INT", required: true },
      { id: "period_format", type: "STRING" },
    ]);
    expect(next.steps).toEqual(renameFlow.steps);
    // The retype rewrites no step — the ids readers name are unchanged — but
    // the footprint names every reader so downstream re-validation sees them.
    expect(touchedBy(renameFlow, retype)).toEqual(["fetch", "send"]);
    expect(assertOnlyTouched(renameFlow, next, touchedBy(renameFlow, retype))).toBeNull();
    expect(describeOp(renameFlow, retype)).toBe('changed input "month"');
  });

  it("retype touches all three reader shapes — template, binding, and prose", () => {
    const three: AuthoredFlow = {
      id: "three",
      inputs: [{ id: "period", type: "STRING", required: true }],
      steps: [
        { kind: "tool", id: "expr", ref: "q.fetch", paramsExpr: '"{{ inputs.period }}"' },
        {
          kind: "tool",
          id: "struct",
          ref: "q.fetch",
          paramsExpr: "[{}]",
          inputs: [{ name: "period", source: { from: "input", inputId: "period" } }],
        },
        {
          kind: "tool",
          id: "prose",
          ref: "mail.send",
          paramsExpr: "[{}]",
          inputs: [
            { name: "subject", source: { from: "literal", value: "Attendance report for {{ inputs.period }}" } },
          ],
        },
      ],
    };
    expect(inputsReadBy(three, "period")).toEqual(["expr", "struct", "prose"]);
    const retype = { op: "replace_input", inputId: "period", input: { id: "period", type: "DATE", required: true } } as const;
    const next = ok(applyOp(three, retype));
    expect(next.inputs).toEqual([{ id: "period", type: "DATE", required: true }]);
    expect(next.steps).toEqual(three.steps);
    expect(touchedBy(three, retype)).toEqual(["expr", "struct", "prose"]);
    expect(assertOnlyTouched(three, next, touchedBy(three, retype))).toBeNull();
    expect(describeOp(three, retype)).toBe('changed input "period"');
  });

  /** A structured reader orphans just as dead as an expression one. */
  it("remove_input still refuses while a structured binding reads the id", () => {
    const e = refusal(applyOp(renameFlow, { op: "remove_input", inputId: "month" }));
    expect(e).toContain('"fetch"');
    expect(e).toContain('"send"');
    expect(e).toContain("rewire those steps first");
  });

  it("carries the default across a rename — and keeps it on a retype", () => {
    const def: AuthoredFlow = {
      id: "def",
      inputs: [{ id: "month", type: "STRING", defaults: "2026-08" }],
      steps: [
        { kind: "tool", id: "fetch", ref: "q.fetch", paramsExpr: '"{{ inputs.month }}"' },
      ],
    };
    const renamed = ok(
      applyOp(def, { op: "replace_input", inputId: "month", input: { id: "period", type: "STRING" } }),
    );
    expect(renamed.inputs).toEqual([{ id: "period", type: "STRING", defaults: "2026-08" }]);
    const retyped = ok(
      applyOp(def, { op: "replace_input", inputId: "month", input: { id: "month", type: "INT" } }),
    );
    expect(retyped.inputs).toEqual([{ id: "month", type: "INT", defaults: "2026-08" }]);
  });

  /**
   * Measured 2026-09-14: a mail step's subject rode as a literal
   * `"… for {{ inputs.period }}"`. The rename rebound every binding and
   * template yet left that prose untouched — the next turn's validator
   * correctly refused the dangling ref. A literal embedding IS a read.
   */
  it("enumerates and rebinds a ref embedded in literal prose", () => {
    const prose: AuthoredFlow = {
      id: "prose",
      inputs: [{ id: "period", type: "STRING", required: true }],
      steps: [
        {
          kind: "tool",
          id: "send",
          ref: "mail.send",
          paramsExpr: "[{}]",
          inputs: [
            { name: "subject", source: { from: "literal", value: "Attendance report for {{ inputs.period }}" } },
            { name: "body", source: { from: "whole", stepId: "fetch" } },
          ],
        },
      ],
    };
    expect(inputsReadBy(prose, "period")).toEqual(["send"]);
    const next = ok(applyOp(prose, { op: "replace_input", inputId: "period", input: { id: "month", type: "STRING" } }));
    expect(next.steps.find((s) => s.id === "send")).toMatchObject({
      inputs: [
        { name: "subject", source: { from: "literal", value: "Attendance report for {{ inputs.month }}" } },
        { name: "body", source: { from: "whole", stepId: "fetch" } },
      ],
    });
    expect(touchedBy(prose, { op: "replace_input", inputId: "period", input: { id: "month", type: "STRING" } })).toEqual(["send"]);
    expect(assertOnlyTouched(prose, next, ["send"])).toBeNull();
  });

  it("remove_input refuses while literal prose embeds the id", () => {
    const prose: AuthoredFlow = {
      id: "prose",
      inputs: [{ id: "period", type: "STRING", required: true }],
      steps: [
        {
          kind: "tool",
          id: "send",
          ref: "mail.send",
          paramsExpr: "[{}]",
          inputs: [{ name: "subject", source: { from: "literal", value: "for {{ inputs.period }}" } }],
        },
      ],
    };
    const e = refusal(applyOp(prose, { op: "remove_input", inputId: "period" }));
    expect(e).toContain('"send"');
    expect(e).toContain("rewire those steps first");
  });
});

describe("the guard kinds", () => {
  it("set_condition works on a branch step", () => {
    const next = ok(applyOp(rich, { op: "set_condition", stepId: "guard", conditionExpr: "{{ 2 }}" }));
    expect(next.steps.find((s) => s.id === "guard")).toMatchObject({ conditionExpr: "{{ 2 }}" });
  });

  it("replace_step still refuses to move a condition on a branch step", () => {
    const e = refusal(
      applyOp(rich, {
        op: "replace_step",
        stepId: "guard",
        step: { kind: "branch", id: "guard", conditionExpr: "{{ 9 }}", dependsOn: ["fetch"] },
      }),
    );
    expect(e).toContain("set_condition");
    expect(e).toContain("changes which steps run");
  });
});

describe("touchedBy and describeOp for the granular ops", () => {
  it("names the edited step — and no step for an input removal", () => {
    expect(
      touchedBy(rich, { op: "set_property", stepId: "fetch", property: "ref", value: "q.x" }),
    ).toEqual(["fetch"]);
    expect(
      touchedBy(rich, {
        op: "set_binding",
        stepId: "fetch",
        name: "rows",
        source: { from: "input", inputId: "period" },
      }),
    ).toEqual(["fetch"]);
    expect(touchedBy(rich, { op: "set_output_rows", rows: [] })).toEqual([]);
    expect(
      touchedBy(rich, {
        op: "add_io",
        stepId: "rank",
        which: "input",
        field: { name: "rows", type: "array" },
      }),
    ).toEqual(["rank"]);
    expect(touchedBy(rich, { op: "remove_io", stepId: "rank", which: "input", name: "rows" })).toEqual([
      "rank",
    ]);
    expect(touchedBy(rich, { op: "set_retry", stepId: "fetch", retry: { maxAttempts: 3 } })).toEqual([
      "fetch",
    ]);
    expect(touchedBy(rich, { op: "remove_input", inputId: "period" })).toEqual([]);
  });

  it("says what each granular op did, in one sentence", () => {
    // The registry's own label for the property — the panel's word, not the key.
    expect(
      describeOp(rich, { op: "set_property", stepId: "fetch", property: "ref", value: "q.x" }),
    ).toBe('set Tool on "fetch"');
    expect(
      describeOp(rich, {
        op: "set_binding",
        stepId: "fetch",
        name: "rows",
        source: { from: "input", inputId: "period" },
      }),
    ).toBe('bound "rows" on "fetch"');
    expect(
      describeOp(rich, { op: "set_binding", stepId: "fetch", name: "rows", source: null }),
    ).toBe('unbound "rows" on "fetch"');
    expect(
      describeOp(rich, {
        op: "set_output_rows",
        rows: [{ name: "shortlist", type: "array[object]", source: null }],
      }),
    ).toBe("declared 1 returned values");
    expect(
      describeOp(rich, {
        op: "add_io",
        stepId: "rank",
        which: "input",
        field: { name: "rows", type: "array" },
      }),
    ).toBe('added an input called "rows" to "rank"');
    expect(describeOp(rich, { op: "remove_io", stepId: "rank", which: "output", name: "ranked" })).toBe(
      'removed the output "ranked" from "rank"',
    );
    expect(
      describeOp(rich, { op: "set_retry", stepId: "fetch", retry: { maxAttempts: 3 } }),
    ).toBe('set retry on "fetch"');
    expect(describeOp(rich, { op: "set_retry", stepId: "fetch", retry: null })).toBe(
      'turned off retry on "fetch"',
    );
    expect(describeOp(rich, { op: "remove_input", inputId: "period" })).toBe('removed input "period"');
  });
});
 describe("add_arm / remove_arm — elif arms, never a bare branch", () => {
   const chained: AuthoredFlow = {
     id: "chase_overdue",
     steps: [
       { kind: "datasource", id: "overdue", ref: "q.overdue", paramsExpr: "[{}]" },
       { kind: "branch", id: "any_rows", conditionExpr: "{{ 1 }}", dependsOn: ["overdue"] },
       { kind: "tool", id: "send", ref: "mail_send", paramsExpr: "[{}]", dependsOn: ["any_rows"] },
     ],
   };
   const mail = {
     kind: "tool",
     id: "escalate",
     ref: "mail_send",
     paramsExpr: "[{}]",
   } as const;

   it("appends an elif link plus its first guarded step, atomically", () => {
     const op = {
       op: "add_arm",
       elseOf: "any_rows",
       armId: "big_debt",
       conditionExpr: "{{ 2 }}",
       step: mail,
     } as const;
     const next = ok(applyOp(chained, op));
     expect(next.steps.find((s) => s.id === "big_debt")).toEqual({
       kind: "branch",
       id: "big_debt",
       elseOf: "any_rows",
       conditionExpr: "{{ 2 }}",
     });
     expect(next.steps.find((s) => s.id === "escalate")).toMatchObject({ dependsOn: ["big_debt"] });
     expect(assertOnlyTouched(chained, next, touchedBy(chained, op))).toBeNull();
     expect(describeOp(chained, op)).toContain('elif arm "big_debt"');
   });

   it("an omitted condition makes an otherwise arm", () => {
     const next = ok(
       applyOp(chained, { op: "add_arm", elseOf: "any_rows", armId: "rest", step: mail }),
     );
     expect(next.steps.find((s) => s.id === "rest")).toEqual({
       kind: "branch",
       id: "rest",
       elseOf: "any_rows",
     });
   });

   it("refuses to continue past an otherwise arm", () => {
     const withElse = ok(applyOp(chained, { op: "add_arm", elseOf: "any_rows", armId: "rest", step: mail }));
     expect(
       refusal(
         applyOp(withElse, { op: "add_arm", elseOf: "any_rows", armId: "more", conditionExpr: "{{ 3 }}", step: mail }),
       ),
     ).toContain("otherwise");
   });
  it("continues a chain whose guard is typed (test), not a conditionExpr", () => {
    const typed: AuthoredFlow = {
      id: "typed_guard",
      steps: [
        { kind: "datasource", id: "overdue", ref: "q.overdue", paramsExpr: "[{}]" },
        {
          kind: "branch",
          id: "big",
          test: { left: { from: "step", stepId: "overdue", field: "score" }, operator: "field_lt", right: "2" },
          dependsOn: ["overdue"],
        },
        { kind: "tool", id: "send", ref: "mail_send", paramsExpr: "[{}]", dependsOn: ["big"] },
      ],
    };
    const next = ok(applyOp(typed, { op: "add_arm", elseOf: "big", armId: "rest", step: mail }));
    expect(next.steps.find((s) => s.id === "rest")).toMatchObject({ elseOf: "big" });
  });

   it("refuses a guarded approval or branch — the compiler would", () => {
     for (const step of [
       { kind: "approval", id: "gate", summaryExpr: "{{ 1 }}" },
       { kind: "branch", id: "nested", conditionExpr: "{{ 1 }}" },
     ]) {
       expect(
         refusal(applyOp(chained, { op: "add_arm", elseOf: "any_rows", armId: "x", conditionExpr: "{{ 1 }}", step: step as never })),
       ).toContain("cannot guard");
     }
   });

   it("remove_arm refuses a guarded arm, then lets it go once empty", () => {
     const withArm = ok(
       applyOp(chained, { op: "add_arm", elseOf: "any_rows", armId: "big_debt", conditionExpr: "{{ 2 }}", step: mail }),
     );
     expect(refusal(applyOp(withArm, { op: "remove_arm", stepId: "big_debt" }))).toContain("still guards");
     const emptied = ok(applyOp(withArm, { op: "remove_step", stepId: "escalate" }));
     const next = ok(applyOp(emptied, { op: "remove_arm", stepId: "big_debt" }));
     expect(next.steps.some((s) => s.id === "big_debt")).toBe(false);
     expect(describeOp(emptied, { op: "remove_arm", stepId: "big_debt" })).toBe('removed the arm "big_debt"');
   });

   it("remove_arm refuses the head of a chain", () => {
     expect(refusal(applyOp(chained, { op: "remove_arm", stepId: "any_rows" }))).toContain("head of its chain");
   });

   it("add_step refuses an appended branch and names the two ways", () => {
     const e = refusal(
       applyOp(chained, {
         op: "add_step",
         step: { kind: "branch", id: "late", conditionExpr: "{{ 1 }}" },
       }),
     );
     expect(e).toContain("guards nothing");
     expect(e).toContain("insert_step");
     expect(e).toContain("add_arm");
   });
 });

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MERGE — added through `add_step`, and why that is not an oversight
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `add_step` refuses a bare appended BRANCH: a branch acts on what comes after
 * it, so appended it guards nothing. A merge is the mirror — it acts on what
 * came BEFORE it — so appending is not merely safe, it is the only placement
 * that can be correct. That makes `add_step` the right op with no new op needed,
 * and these tests are what stops someone "fixing" the asymmetry by refusing
 * both.
 */
describe("add_step — a merge", () => {
  const flow: AuthoredFlow = {
    id: "f",
    steps: [
      { kind: "tool", id: "page", ref: "page_oncall", paramsExpr: "[{}]" },
      { kind: "tool", id: "mail", ref: "mail_send", paramsExpr: "[{}]" },
    ],
  };

  it("is appended, unlike a branch", () => {
    const r = applyOp(flow, {
      op: "add_step",
      step: { kind: "merge", id: "outcome", sources: ["page", "mail"] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flow.steps.map((s) => s.id)).toEqual(["page", "mail", "outcome"]);
    const added = r.flow.steps.find((s) => s.id === "outcome");
    expect(added && "sources" in added ? added.sources : null).toEqual(["page", "mail"]);
  });

  /**
   * ⚠ Only EXISTENCE is checked here, deliberately. Whether a source is a kind
   * that produces a JSON result, and whether it comes earlier, are the server's
   * — re-implementing them would be a second definition of the rule, free to
   * drift in the direction where the cheap copy says yes. What this catches is
   * the mistake a turn actually makes: a typo'd or invented step id.
   */
  it("refuses a source that is not in the flow, naming it", () => {
    const r = applyOp(flow, {
      op: "add_step",
      step: { kind: "merge", id: "outcome", sources: ["page", "nope"] },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("nope");
    expect(r.error).not.toContain("page");
  });

  it("the ORDER given is the order stored — it is a priority, not a set", () => {
    const r = applyOp(flow, {
      op: "add_step",
      step: { kind: "merge", id: "outcome", sources: ["mail", "page"] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const added = r.flow.steps.find((s) => s.id === "outcome");
    expect(added && "sources" in added ? added.sources : null).toEqual(["mail", "page"]);
  });
});

/**
 * ⚠ **A step carrying the inputs it reads — the fix for a measured deadlock
 * (2026-09-06).**
 *
 * An automation whose FIRST step reads an input could not be started at all:
 * `declare_input` was refused because no flow existed yet, and the `add_step`
 * was refused because the input it read was undeclared. Neither refusal was
 * wrong — the vocabulary had no legal opening move for an automation that takes
 * a parameter, and on `gpt-5.4-mini` this was invisible only because that model
 * wrote literal dates instead, which is the defect the input exists to prevent.
 */
describe("add_step carrying its own inputs", () => {
  const empty = { id: "f", steps: [] } as unknown as AuthoredFlow;
  const step = {
    id: "overdue",
    kind: "datasource",
    ref: "ds.invoices_overdue",
    paramsExpr: '[{"as_of": "{{ inputs.as_of }}"}]',
  } as unknown as AuthoredStep;

  it("declares them alongside the step, opening a flow that takes a parameter", () => {
    const r = applyOp(empty, { op: "add_step", step, inputs: [{ id: "as_of", type: "DATE", required: true }] });
    expect(r.ok).toBe(true);
    const flow = (r as { flow: AuthoredFlow }).flow;
    expect(flow.steps.map((s) => s.id)).toEqual(["overdue"]);
    expect(flow.inputs).toEqual([{ id: "as_of", type: "DATE", required: true }]);
  });

  it("is unchanged when no inputs are carried — the ordinary case", () => {
    const plain = { id: "t", kind: "transform", expr: "{{ 1 }}" } as unknown as AuthoredStep;
    const r = applyOp(empty, { op: "add_step", step: plain });
    expect(r.ok).toBe(true);

    expect((r as { flow: AuthoredFlow }).flow.inputs).toBeUndefined();
  });

  it("lands the step when the op echoes an identical input — the convert-period shape", () => {
    const withInput = { ...empty, inputs: [{ id: "period", type: "STRING", required: true }] } as unknown as AuthoredFlow;
    const r = applyOp(withInput, {
      op: "add_step",
      step,
      inputs: [{ id: "period", type: "STRING", required: true }],
    });
    expect(r.ok).toBe(true);
    const next = (r as { flow: AuthoredFlow }).flow;
    expect(next.inputs).toEqual([{ id: "period", type: "STRING", required: true }]);
    expect(next.steps.map((s) => s.id)).toContain((step as { id: string }).id);
  });

  it("merges an identical declare_input byte-identically", () => {
    const withInput = { ...empty, inputs: [{ id: "as_of", type: "STRING" }] } as unknown as AuthoredFlow;
    const snapshot = JSON.stringify(withInput);
    const r = applyOp(withInput, { op: "declare_input", input: { id: "as_of", type: "STRING" } });
    expect(r.ok).toBe(true);
    expect(JSON.stringify((r as { flow: AuthoredFlow }).flow)).toBe(snapshot);
  });

  it("refuses a duplicate by the SAME message declare_input gives", () => {
    // One applier, so one message. Two would drift, and the second would be the
    // one nobody reads until it is wrong.
    const withInput = { ...empty, inputs: [{ id: "as_of", type: "STRING" }] } as unknown as AuthoredFlow;
    const r = applyOp(withInput, { op: "add_step", step, inputs: [{ id: "as_of", type: "DATE" }] });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/already declares an input called "as_of"/);
    const viaDeclare = applyOp(withInput, { op: "declare_input", input: { id: "as_of", type: "DATE" } });
    expect((viaDeclare as { error: string }).error).toBe((r as { error: string }).error);
  });

  /**
   * ⚠ **The step lands first, and the order is the assertion.** An input
   * declared beside a step that was itself refused would leave the flow
   * carrying a parameter nothing reads — a question asked of a person at run
   * time on behalf of a step that does not exist.
   */
  it("declares nothing when the step itself is refused", () => {
    const gate = { id: "g", kind: "approval", ...({} as object) } as unknown as AuthoredStep;
    const r = applyOp(empty, { op: "add_step", step: gate, inputs: [{ id: "as_of", type: "DATE" }] });
    expect(r.ok).toBe(false);
    // The refusal is still the gate one — the inputs did not change which
    // rule fired, nor mask it.
    expect((r as { error: string }).error).toMatch(/add_gate/);
  });

  it("says on screen that it declared them", () => {
    // An input appearing without being mentioned is a question from nowhere.
    const line = describeOp(empty, {
      op: "add_step",
      step,
      inputs: [{ id: "as_of", type: "DATE" }],
    });
    expect(line).toMatch(/"as_of"/);
    // And the ordinary case gains no trailing clause.
    expect(describeOp(empty, { op: "add_step", step })).not.toMatch(/declared/);
  });
});

/**
 * ⚠ **`set_schedule` — added 2026-09-06 because the builder was OFFERING to
 * schedule and could not.** Asked "do that every Monday morning" it replied
 * *"to add the Monday schedule trigger, I need the run time and timezone"* — a
 * question with no answer it could act on, because the sixteen ops had no
 * schedule among them. The field has been on `AuthoredFlow` and emitted by the
 * compiler since Phase 6; only the op was missing.
 */
describe("set_schedule", () => {
  const flow = { id: "f", steps: [{ id: "a", kind: "transform", expr: "{{ 1 }}" }] } as unknown as AuthoredFlow;

  it("puts the schedule on the flow, where an approval covers it", () => {
    const r = applyOp(flow, { op: "set_schedule", schedule: { cron: "0 9 * * 1", timezone: "Europe/London" } });
    expect(r.ok).toBe(true);
    expect((r as { flow: AuthoredFlow }).flow.schedule).toEqual({ cron: "0 9 * * 1", timezone: "Europe/London" });
  });

  /**
   * ⚠ `undefined`, not `null`. The field is optional on `AuthoredFlow`, so a
   * literal null serialises into the model as a schedule that is present and
   * empty — which reads to every later consumer as "scheduled", not "not".
   */
  it("removes it cleanly rather than leaving an empty one behind", () => {
    const scheduled = { ...flow, schedule: { cron: "0 9 * * 1" } } as unknown as AuthoredFlow;
    const r = applyOp(scheduled, { op: "set_schedule", schedule: null });
    expect(r.ok).toBe(true);
    expect((r as { flow: AuthoredFlow }).flow.schedule).toBeUndefined();
    expect("schedule" in (r as { flow: AuthoredFlow }).flow).toBe(true);
  });

  it("touches no step, so assertOnlyTouched has nothing to allow", () => {
    // A schedule belongs to the flow. Naming a step here would file the change
    // against a step nobody edited.
    expect(touchedBy(flow, { op: "set_schedule", schedule: { cron: "0 9 * * 1" } })).toEqual([]);
  });

  /**
   * ⚠ **The cron is quoted, never rendered into English**, and this is the
   * assertion that matters. "Every Monday at 9" is far more convincing than the
   * cron it might misdescribe, and a person would be approving the sentence
   * rather than the expression Kestra actually runs.
   */
  it("quotes the cron and says the approval is still owed", () => {
    const line = describeOp(flow, { op: "set_schedule", schedule: { cron: "0 9 * * 1", timezone: "Europe/London" } });
    expect(line).toContain("0 9 * * 1");
    expect(line).toContain("Europe/London");
    expect(line).toMatch(/approv/i);
    // No plain-English day or hour anywhere — that is the whole point.
    expect(line).not.toMatch(/monday|9am|9 ?am/i);
  });

  it("says plainly when the schedule is removed", () => {
    expect(describeOp(flow, { op: "set_schedule", schedule: null })).toMatch(/no longer runs on its own/);
  });
});

/**
 * ⚠ **STARTING A CONDITION HAD NO OP, AND THE GAP WAS MEASURED.**
 *
 * Asked *"if any of them are on the enterprise plan, post to the #escalations
 * channel"* on a flow that ended at a transform, the builder added the post
 * UNGUARDED — the only thing the vocabulary allowed. `add_step` refuses a
 * branch ("guards nothing"), `insert_step` needs a step to insert BEFORE, and
 * `add_arm` continues a condition that already exists. Seventeen ops, and none
 * of them could start one on a step that did not exist yet.
 *
 * ⚠ The two-op workaround is not merely clumsy, it is DANGEROUS: between the
 * two ops the step runs on every execution. A conversation that stops there —
 * or an approval taken there — ships an automation that posts to a channel, or
 * mails a customer, every single run, and nothing on any screen distinguishes
 * that from a finished flow. `add_arm` was made atomic for precisely this
 * reason; starting a condition never got the same treatment.
 */
describe("add_guarded_step", () => {
  const base = (): AuthoredFlow => ({
    name: "f",
    steps: [
      { id: "fetch", kind: "datasource", ref: "q", paramsExpr: "[{}]" },
      { id: "shape", kind: "transform", expr: "{{ outputs.fetch.body }}", dependsOn: ["fetch"] },
    ],
  } as unknown as AuthoredFlow);

  const post = {
    id: "post_escalation", kind: "tool", ref: "chat_post_message", paramsExpr: "[{}]",
  } as unknown as AuthoredStep;

  it("lands the branch AND the guarded step together", () => {
    const r = applyOp(base(), {
      op: "add_guarded_step", afterStepId: "shape", branchId: "any_enterprise",
      conditionExpr: "{{ json(outputs.shape.value) | jq('length > 0') | first }}", step: post,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const guard = r.flow.steps.find((s) => s.id === "any_enterprise")!;
    const guarded = r.flow.steps.find((s) => s.id === "post_escalation")!;
    expect(guard.kind).toBe("branch");
    expect(guard.dependsOn).toEqual(["shape"]);
    // ⚠ THE POINT: the new step hangs off the BRANCH, never off `shape`. If it
    // depended on `shape` it would run on every execution — the exact state
    // this op exists to make unreachable.
    expect(guarded.dependsOn).toEqual(["any_enterprise"]);
  });

  it("refuses to guard a pause or a nested condition, in the SAME words add_arm uses", () => {
    for (const kind of ["approval", "branch"]) {
      const r = applyOp(base(), {
        op: "add_guarded_step", afterStepId: "shape", branchId: "g",
        conditionExpr: "{{ true }}", step: { ...post, id: "x", kind } as unknown as AuthoredStep,
      });
      expect(r.ok, `${kind} was allowed inside a condition`).toBe(false);
      if (!r.ok) expect(r.error).toContain("unverified inside a conditional block");
    }
  });

  it("refuses an unknown anchor, a duplicate id and one id used twice", () => {
    const mk = (over: Record<string, unknown>) =>
      applyOp(base(), {
        op: "add_guarded_step", afterStepId: "shape", branchId: "g",
        conditionExpr: "{{ true }}", step: post, ...over,
      } as never);
    expect(mk({ afterStepId: "nope" }).ok).toBe(false);
    expect(mk({ branchId: "fetch" }).ok).toBe(false);
    expect(mk({ branchId: "post_escalation" }).ok).toBe(false);
  });

  /**
   * The control for the whole feature: the two-op route it replaces really does
   * produce the dangerous intermediate state. Without this, "atomic" is a claim
   * about a problem nobody demonstrated.
   */
  it("the two-op alternative leaves the step running unconditionally in between", () => {
    const mid = applyOp(base(), { op: "add_step", step: post });
    expect(mid.ok).toBe(true);
    if (!mid.ok) return;
    const added = mid.flow.steps.find((s) => s.id === "post_escalation")!;
    // No branch anywhere, and nothing gating it: this flow posts every run.
    expect(mid.flow.steps.some((s) => s.kind === "branch")).toBe(false);
    expect(added.dependsOn ?? []).not.toContain("any_enterprise");
  });

  it("describes itself as CONDITIONAL, so the change line cannot read as unconditional", () => {
    const r = applyOp(base(), {
      op: "add_guarded_step", afterStepId: "shape", branchId: "any_enterprise",
      conditionExpr: "{{ true }}", step: post,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const line = describeOp(base(), {
      op: "add_guarded_step", afterStepId: "shape", branchId: "any_enterprise",
      conditionExpr: "{{ true }}", step: post,
    });
    expect(line).toContain("runs only when");
    expect(line).toContain("post_escalation");
  });
});

/**
 * `set_output` — which step's value is the automation's answer. 2026-09-08
 *
 * ⚠ **It exists because a person had NO WAY to declare a result at all.** The
 * model field, the API projection and the canvas End node all landed first, and
 * the builder's exit-point panel reports and does not edit — a form there would
 * be a second author of `model.output` that can disagree with chat (D-197) — so
 * it points at chat, which had no op to point at. A field only a seed script
 * can set is a field the product does not have.
 */
describe("set_output", () => {
  // The file's own fixture — a datasource → transform → tool chain.
  const f = flow;

  it("declares the result and leaves the steps alone", () => {
    const r = applyOp(f, { op: "set_output", output: { stepId: "shape", description: "the rows" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flow.output).toEqual({ stepId: "shape", description: "the rows" });
    expect(r.flow.steps).toEqual(f.steps);
  });

  it("clears it with null, and stores UNDEFINED rather than a literal null", () => {
    // `set_schedule`'s reason: a literal null serialises into the model as a
    // field that is present and empty.
    const set = applyOp(f, { op: "set_output", output: { stepId: "shape" } });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const cleared = applyOp(set.flow, { op: "set_output", output: null });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.flow.output).toBeUndefined();
    expect("output" in cleared.flow && cleared.flow.output === null).toBe(false);
  });

  it("refuses a step that is not there, and NAMES the ones that are", () => {
    // A redraft without the list is a second guess at a step id.
    const r = applyOp(f, { op: "set_output", output: { stepId: "typo" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("typo");
    for (const s of f.steps) expect(r.error).toContain(s.id);
  });

  it("never mutates the flow it was given", () => {
    const snapshot = JSON.stringify(f);
    applyOp(f, { op: "set_output", output: { stepId: "shape" } });
    expect(JSON.stringify(f)).toBe(snapshot);
  });

  it("touches NO step, even though it names one", () => {
    // Declaring a step the result changes nothing about that step. Naming it
    // here would file the change against a step nobody edited, which is what
    // `resolvedStepId` exists to make measurable.
    expect(touchedBy(f, { op: "set_output", output: { stepId: "shape" } })).toEqual([]);
  });

  it("describes itself in words a person can check, both ways", () => {
    expect(describeOp(f, { op: "set_output", output: { stepId: "shape", description: "the rows" } }))
      .toContain("shape");
    expect(describeOp(f, { op: "set_output", output: { stepId: "shape", description: "the rows" } }))
      .toContain("the rows");
    // ⚠ Clearing it must say what is LOST, not just that something changed.
    expect(describeOp(f, { op: "set_output", output: null })).toMatch(/no value back/i);
  });
});

describe("set_property on a retired blob field (UAT probe)", () => {
  // Chat-built steps are born as blobs — the create path takes them and they
  // run. Refusing a blob edit on a blob step while accepting the same blob on
  // replace_step made "send it to ops@example.com" fail for shape alone.
  it("applies a paramsExpr blob write on a step with no granular bindings", () => {
    const blob =
      "{{ outputs.shape.value | jq('[{subject: \"Big orders\", to: [\"ops@example.com\"]}]') | first }}";
    const next = ok(applyOp(flow, { op: "set_property", stepId: "send", property: "paramsExpr", value: blob }));
    expect(next.steps.find((s) => s.id === "send")).toMatchObject({ paramsExpr: blob });
  });

  it("still refuses a blob write once granular bindings exist", () => {
    // A blob over bindings would silently clobber them — that combination
    // keeps the refusal and its guidance toward set_binding.
    const bound = ok(
      applyOp(flow, {
        op: "set_binding",
        stepId: "send",
        name: "to",
        source: { from: "literal", value: "ops@example.com" },
      }),
    );
    expect(
      refusal(applyOp(bound, { op: "set_property", stepId: "send", property: "paramsExpr", value: "[{}]" })),
    ).toMatch(/one text blob.*set_binding/);
  });
});

describe("bind-guard — a step read names a step that runs first", () => {
  /**
   * Defect 1 (live sweep): a turn bound `fetch.period → derive_month.month`
   * with NO `derive_month` step, and the revision filed. A step-sourced feed
   * is refused here, naming the step and the ids that are there.
   */
  it("refuses a set_binding that names a step that is not there, naming it and the ids", () => {
    const e = refusal(
      applyOp(typed, {
        op: "set_binding",
        stepId: "fetch",
        name: "period",
        source: { from: "step", stepId: "derive_month", field: "month" },
      }),
    );
    expect(e).toContain('"derive_month"');
    expect(e).toContain("overdue");
    expect(e).toContain("fetch");
  });

  it("refuses a whole-rows set_binding to a missing step the same way", () => {
    const e = refusal(
      applyOp(typed, {
        op: "set_binding",
        stepId: "rank",
        name: "rows",
        source: { from: "whole", stepId: "ghost" },
      }),
    );
    expect(e).toContain('"ghost"');
    expect(e).toContain("fetch");
  });

  it("refuses a set_binding that closes a dependency cycle", () => {
    // `overdue` runs first; reading `send` (downstream) would make a loop.
    const e = refusal(
      applyOp(flow, {
        op: "set_binding",
        stepId: "overdue",
        name: "rows",
        source: { from: "whole", stepId: "send" },
      }),
    );
    expect(e).toMatch(/loop/);
    expect(e).toContain('"send"');
  });

  it("a valid bind adds dependsOn; unbinding the last read drops it", () => {
    const bound = ok(
      applyOp(flow, {
        op: "set_binding",
        stepId: "send",
        name: "subject",
        source: { from: "step", stepId: "overdue", field: "body" },
      }),
    );
    expect(bound.steps.find((s) => s.id === "send")?.dependsOn).toEqual(["shape", "overdue"]);
    expect(assertOnlyTouched(flow, bound, touchedBy(flow, {
      op: "set_binding",
      stepId: "send",
      name: "subject",
      source: { from: "step", stepId: "overdue", field: "body" },
    }))).toBeNull();
    const unbound = ok(applyOp(bound, { op: "set_binding", stepId: "send", name: "subject", source: null }));
    expect(unbound.steps.find((s) => s.id === "send")?.dependsOn).toEqual(["shape"]);
  });

  it("refcounts: one unbind keeps an edge a second binding still needs", () => {
    const a = ok(
      applyOp(flow, {
        op: "set_binding",
        stepId: "send",
        name: "a",
        source: { from: "step", stepId: "overdue", field: "body" },
      }),
    );
    const ab = ok(
      applyOp(a, {
        op: "set_binding",
        stepId: "send",
        name: "b",
        source: { from: "whole", stepId: "overdue" },
      }),
    );
    const droppedA = ok(applyOp(ab, { op: "set_binding", stepId: "send", name: "a", source: null }));
    expect(droppedA.steps.find((s) => s.id === "send")?.dependsOn).toContain("overdue");
    const droppedB = ok(applyOp(droppedA, { op: "set_binding", stepId: "send", name: "b", source: null }));
    expect(droppedB.steps.find((s) => s.id === "send")?.dependsOn).toEqual(["shape"]);
  });

  it("rebinding onto a run input drops the step edge", () => {
    const bound = ok(
      applyOp(flow, {
        op: "set_binding",
        stepId: "send",
        name: "subject",
        source: { from: "step", stepId: "overdue", field: "body" },
      }),
    );
    // The edge is really there first — otherwise the drop below proves nothing.
    expect(bound.steps.find((s) => s.id === "send")?.dependsOn).toEqual(["shape", "overdue"]);
    const rebound = ok(
      applyOp(bound, {
        op: "set_binding",
        stepId: "send",
        name: "subject",
        source: { from: "input", inputId: "period" },
      }),
    );
    expect(rebound.steps.find((s) => s.id === "send")?.dependsOn).toEqual(["shape"]);
  });

  it("refuses a phantom approval context, and files a real one as an edge", () => {
    const e = refusal(
      applyOp(typed, {
        op: "set_property",
        stepId: "ask",
        property: "context",
        value: { from: "step", stepId: "ghost", field: "body" },
      }),
    );
    expect(e).toContain('"ghost"');
    expect(e).toContain("fetch");
    const bound = ok(
      applyOp(typed, {
        op: "set_property",
        stepId: "ask",
        property: "context",
        value: { from: "whole", stepId: "fetch" },
      }),
    );
    expect(bound.steps.find((s) => s.id === "ask")?.dependsOn).toEqual(["rank", "fetch"]);
    const cleared = ok(applyOp(bound, { op: "set_property", stepId: "ask", property: "context", value: null }));
    expect(cleared.steps.find((s) => s.id === "ask")?.dependsOn).toEqual(["rank"]);
  });

  it("refuses a phantom branch test left and a looping contextStepId", () => {
    const phantom = refusal(
      applyOp(typed, {
        op: "set_property",
        stepId: "guard",
        property: "test",
        value: { left: { from: "step", stepId: "ghost", field: "total" }, operator: "field_gt", right: "100" },
      }),
    );
    expect(phantom).toContain('"ghost"');
    expect(phantom).toContain("fetch");
    // `post` runs after `judge`; reading it from `judge` would make a loop.
    const loop = refusal(
      applyOp(typed, { op: "set_property", stepId: "judge", property: "contextStepId", value: "post" }),
    );
    expect(loop).toMatch(/loop/);
    expect(loop).toContain('"post"');
  });

  it("refuses a phantom contextStepId, and files a real one as an edge", () => {
    const e = refusal(
      applyOp(typed, { op: "set_property", stepId: "judge", property: "contextStepId", value: "ghost" }),
    );
    expect(e).toContain('"ghost"');
    expect(e).toContain("fetch");
    const bound = ok(
      applyOp(typed, { op: "set_property", stepId: "judge", property: "contextStepId", value: "rank" }),
    );
    expect(bound.steps.find((s) => s.id === "judge")?.dependsOn).toEqual(["fetch", "rank"]);
    const cleared = ok(
      applyOp(bound, { op: "set_property", stepId: "judge", property: "contextStepId", value: null }),
    );
    expect(cleared.steps.find((s) => s.id === "judge")?.dependsOn).toEqual(["fetch"]);
  });
});

describe("contract format — the date-shape hint rides the field", () => {
  it("add_io stores a format and refuses a misspelt one", () => {
    const next = ok(
      applyOp(rich, {
        op: "add_io",
        stepId: "rank",
        which: "input",
        field: { name: "month", type: "string", format: "month" },
      }),
    );
    expect(
      next.steps.find((s): s is Extract<AuthoredFlow["steps"][number], { kind: "code" }> => s.id === "rank" && s.kind === "code")
        ?.contract.input,
    ).toContainEqual({ name: "month", type: "string", format: "month" });
    const e = refusal(
      applyOp(rich, {
        op: "add_io",
        stepId: "rank",
        which: "input",
        field: { name: "bad", type: "string", format: "fortnight" } as unknown as ContractField,
      }),
    );
    expect(e).toContain("contract format");
  });

  it("set_property field-lists preserve a format and refuse a misspelt one", () => {
    const next = ok(
      applyOp(typed, {
        op: "set_property",
        stepId: "judge",
        property: "outputFields",
        value: [{ name: "due", type: "string", format: "date" }],
      }),
    );
    expect(next.steps.find((s) => s.id === "judge")).toMatchObject({
      outputFields: [{ name: "due", type: "string", format: "date" }],
    });
    const e = refusal(
      applyOp(typed, {
        op: "set_property",
        stepId: "judge",
        property: "outputFields",
        value: [{ name: "due", type: "string", format: "quarter" }],
      }),
    );
    expect(e).toContain("contract format");
  });
});

describe("code inputExpr — the feed is an object by construction", () => {
  /**
   * ⚠ Run 4171a39b: `inputExpr: "{{ inputs.period }}"` rendered to the bare
   * value `2026-08-31`, the runner's `json.load` died on it, and the whole run
   * failed — with op validation, model findings and the compiler all green.
   * `buildCodeInput` renders `{...}` BY CONSTRUCTION, so a legacy blob that is
   * not an object is refused at every write point, naming the missing key and
   * the object shape, instead of dying at runtime.
   */
  const codeStep = (inputExpr: string): Extract<AuthoredStep, { kind: "code" }> => ({
    kind: "code",
    id: "calc",
    inputExpr,
    contract: {
      purpose: "derive the start",
      input: [{ name: "period", type: "string" }],
      output: [{ name: "start", type: "string" }],
    },
  });

  it("refuses the measured shape on every whole-step write", () => {
    for (const op of [
      { op: "add_step", step: codeStep("{{ inputs.period }}") },
      { op: "replace_step", stepId: "rank", step: { ...codeStep("{{ inputs.period }}"), id: "rank" } },
    ] as const) {
      const e = refusal(applyOp(typed, op));
      expect(e).toContain('code step');
      expect(e).toContain("must be a JSON object");
    }
    // The blob write names it too — and the flow is untouched by the refusal.
    const before = JSON.stringify(typed);
    const e = refusal(
      applyOp(typed, { op: "set_property", stepId: "rank", property: "inputExpr", value: "{{ inputs.period }}" }),
    );
    expect(e).toContain('code step "rank"');
    expect(e).toContain("must be a JSON object");
    expect(JSON.stringify(typed)).toBe(before);
  });

  it("names the missing contract input when the object does not cover it", () => {
    const e = refusal(
      applyOp(typed, {
        op: "set_property",
        stepId: "rank",
        property: "inputExpr",
        value: '{"period": "{{ inputs.period }}"}',
      }),
    );
    // `typed.rank` contracts `rows`, not `period` — the key that is missing and
    // the object shape are both named, which is what makes this correctable.
    expect(e).toContain('missing contract input "rows"');
    expect(e).toContain("must be a JSON object carrying every contract input");
  });

  it("accepts a covering object, extra keys and quoted spans — and a blank clear", () => {
    const next = ok(
      applyOp(typed, {
        op: "set_property",
        stepId: "rank",
        property: "inputExpr",
        value: '{"rows": "{{ inputs.period }}", "note": "fixed"}',
      }),
    );
    expect(next.steps.find((s) => s.id === "rank")).toMatchObject({
      inputExpr: '{"rows": "{{ inputs.period }}", "note": "fixed"}',
    });
    // Clearing stays writable (clear-then-fill); PRESENCE is the compiler's refusal.
    expect(
      ok(applyOp(typed, { op: "set_property", stepId: "rank", property: "inputExpr", value: "" })),
    ).toBeDefined();
    // Whole-step writes accept it too.
    expect(ok(applyOp(flow, { op: "add_step", step: codeStep('{"period": "{{ inputs.period }}"}') }))).toBeDefined();
  });

  it("unit: the checker blanks spans quote-aware and requires braces", () => {
    // A jq program carrying `}}` inside quotes must not cut the span early (I-57).
    expect(
      checkCodeInputExpr(
        "calc",
        `{"rows": {{ json(outputs.fetch.body).results[0].data | jq('{meta: {asof: .as_of}} | @json') | first }}}`,
        ["rows"],
      ),
    ).toBeNull();
    expect(checkCodeInputExpr("calc", "{{ inputs.period }}", ["period"])).toContain("must be a JSON object");
    expect(checkCodeInputExpr("calc", "[{}]", ["period"])).toContain("must be a JSON object");
    expect(checkCodeInputExpr("calc", '{"a": {{ x }', ["a"])).toContain("must be a JSON object");
    expect(checkCodeInputExpr("calc", '{"other": {{ x }}}', ["period"])).toContain('missing contract input "period"');
    expect(checkCodeInputExpr("calc", "{}", [])).toBeNull();
    expect(checkCodeInputExpr("calc", "  ", ["period"])).toBeNull();
  });
});

describe("branch ops take a typed test (phase 3 step 4)", () => {
  const TEST = { left: { from: "step" as const, stepId: "shape", field: "plan" }, operator: "field_eq" as const, right: "enterprise" };
  const base = (): AuthoredFlow => ({
    id: "f",
    steps: [
      { id: "fetch", kind: "datasource", ref: "q", paramsExpr: "[{}]" },
      { id: "shape", kind: "transform", expr: "{{ outputs.fetch.body }}", dependsOn: ["fetch"] },
    ],
  } as unknown as AuthoredFlow);
  const post = { id: "post", kind: "tool", ref: "chat_post_message", paramsExpr: "[{}]" } as unknown as AuthoredStep;
  const guardedFlow = () => ok(applyOp(base(), { op: "add_guarded_step", afterStepId: "shape", branchId: "is_ent", test: TEST, step: post }));

  it("add_guarded_step lands a branch carrying the test and no expression", () => {
    const g = guardedFlow().steps.find((s) => s.id === "is_ent")!;
    expect(g).toMatchObject({ kind: "branch", test: TEST, dependsOn: ["shape"] });
    expect((g as { conditionExpr?: string }).conditionExpr).toBeUndefined();
  });
  it("add_guarded_step with neither form is refused — a head that tests nothing guards nothing", () => {
    expect(refusal(applyOp(base(), { op: "add_guarded_step", afterStepId: "shape", branchId: "g", step: post }))).toMatch(/needs a "test"/);
  });
  it("both forms at once is refused — the expression would silently win", () => {
    expect(refusal(applyOp(base(), { op: "add_guarded_step", afterStepId: "shape", branchId: "g", test: TEST, conditionExpr: "{{ 1 }}", step: post }))).toMatch(/"test" only/);
  });
  it("add_arm with a test is an elif, and continues a typed head", () => {
    const next = ok(applyOp(guardedFlow(), { op: "add_arm", elseOf: "is_ent", armId: "is_pro", test: { ...TEST, right: "pro" }, step: { ...post, id: "post_pro" } as AuthoredStep }));
    expect(next.steps.find((s) => s.id === "is_pro")).toMatchObject({ elseOf: "is_ent", test: { right: "pro" } });
    expect(describeOp(guardedFlow(), { op: "add_arm", elseOf: "is_ent", armId: "is_pro", test: TEST, step: post })).toContain("elif");
  });
  it("set_condition with a test DROPS a stale conditionExpr, which would otherwise win verbatim", () => {
    const flow = ok(applyOp(base(), { op: "add_guarded_step", afterStepId: "shape", branchId: "is_ent", conditionExpr: "{{ 1 }}", step: post }));
    const next = ok(applyOp(flow, { op: "set_condition", stepId: "is_ent", test: TEST }));
    const g = next.steps.find((s) => s.id === "is_ent") as { conditionExpr?: string; test?: unknown };
    expect(g.test).toEqual(TEST);
    expect(g.conditionExpr).toBeUndefined();
  });
  it("replace_step that moves the typed test is refused — use set_condition", () => {
    const flow = guardedFlow();
    const g = flow.steps.find((s) => s.id === "is_ent")!;
    expect(refusal(applyOp(flow, { op: "replace_step", stepId: "is_ent", step: { ...g, test: { ...TEST, right: "pro" } } as AuthoredStep }))).toContain("set_condition");
  });
});
