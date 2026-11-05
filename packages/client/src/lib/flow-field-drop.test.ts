import { describe, it, expect } from "vitest";
import { connectToField, inputHandlesFor, type FieldCatalogue } from "./flow-field-drop";
import { buildCodeInput, buildFanOutParams, type OutputShapes } from "./flow-expr";
import { stepIo } from "./step-io";
import type { AuthoredFlow } from "./flow-authoring";

/**
 * Per-field target ports — the canvas equivalent of the inspector's picker.
 *
 * Every binding below is asserted BYTE-IDENTICAL to the expression the
 * picker's own code path builds (`CallForm.push` / `CodeForm.rowsFrom` in
 * `StepInspector.tsx`): same builders, same inputs, same onChange shapes
 * (`{...step, paramsExpr}` / `{...step, inputExpr}`). The canvas only supplies
 * the source; the expression is never a second implementation.
 */

const SHAPES: OutputShapes = {
  datasource: { template: "json(outputs.<id>.body)", describes: null, caution: null },
  query: { template: "json(outputs.<id>.body)", describes: null, caution: null },
  tool: { template: "json(outputs.<id>.body)", describes: null, caution: null },
  // A merge emits the same task type a transform does, so it shares that
  // spelling — see `OUTPUT_SHAPES.merge` server-side for why that holds
  // whichever arm actually ran.
  merge: { template: "json(outputs.<id>.value)", describes: null, caution: null },
  transform: { template: "json(outputs.<id>.value)", describes: null, caution: null },
  code: { template: "outputs.<id>.vars.result", describes: null, caution: null },
  approval: { template: null, describes: null, caution: null },
  branch: { template: null, describes: null, caution: null },
};

const CATALOGUE: FieldCatalogue = {
  entries: [
    {
      ref: "finance_demo.invoices_overdue",
      stepKind: "datasource",
      params: [{ name: "as_of" }],
    },
    {
      ref: "mail_send",
      stepKind: "tool",
      params: [{ name: "to_email" }, { name: "subject" }],
    },
  ],
  outputs: SHAPES,
};

const FLOW: AuthoredFlow = {
  id: "chase_overdue",
  steps: [
    { kind: "datasource", id: "overdue", ref: "finance_demo.invoices_overdue", paramsExpr: "[{}]" },
    {
      kind: "code",
      id: "rank",
      inputExpr: "{}",
      contract: {
        purpose: "rank invoices by age",
        input: [{ name: "rows", type: "array" }],
        output: [{ name: "ranked", type: "array" }],
      },
    },
    { kind: "tool", id: "send", ref: "mail_send", paramsExpr: "[{}]", dependsOn: ["rank"] },
    { kind: "transform", id: "shaped", expr: "{{ 1 }}" },
  ],
};

describe("inputHandlesFor", () => {
  it("names every catalogue param and every code contract input, by step id", () => {
    // ⚠ Ports carry BINDING STATE, not just names — one `InputSource` per
    // port, the same type the panel reads. This fixture binds nothing, so
    // every port is honestly `unset` — which is exactly the state that used
    // to render as four identical stubs on a working email step.
    expect(inputHandlesFor(FLOW, CATALOGUE)).toEqual(
      new Map([
        ["overdue", { fields: [{ name: "as_of", source: { kind: "unset" } }], wholeFrom: null, bindable: true }],
        ["rank", { fields: [{ name: "rows", source: { kind: "unset" } }], wholeFrom: null, bindable: true }],
        [
          "send",
          {
            fields: [
              { name: "to_email", source: { kind: "unset" } },
              { name: "subject", source: { kind: "unset" } },
            ],
            wholeFrom: null,
            bindable: true,
          },
        ],
      ]),
    );
  });

  // ── ⚠ The three states, which is the whole of the reported defect ─────────

  it("⚠ a step-bound param says WHICH step, and a literal is not an empty input", () => {
    /**
     * The report: *"I see empty node connections … for stuff like email tool
     * which has 4 inputs."* Every port rendered identically whether it was fed
     * by a step, held a fixed value, or held nothing — so three of four read
     * as broken wires on a step that worked.
     */
    const flow: AuthoredFlow = {
      ...FLOW,
      steps: FLOW.steps.map((st) =>
        st.id === "send"
          ? {
              ...st,
              paramsExpr:
                '[{"to_email":"{{ json(outputs.overdue.body).results[0].data }}","subject":"Overdue invoices"}]',
            }
          : st,
      ),
    };
    const send = inputHandlesFor(flow, CATALOGUE)!.get("send")!;
    expect(send.bindable).toBe(true);
    expect(send.fields).toEqual([
      { name: "to_email", source: { kind: "step", stepId: "overdue", field: "" } },
      { name: "subject", source: { kind: "literal", value: "Overdue invoices" } },
    ]);
  });

  it("⚠ reports `wholeFrom` for a WHOLE-OBJECT binding — the case that caused the report", () => {
    /**
     * `{{ json(outputs.shaped.value) }}` binds every parameter at once, so
     * `parseParams` answers `null` and NO field is individually bound. The
     * card needs to know that: without it, four hollow ports on a correctly
     * configured step look like four missing connections, and the one real
     * edge lands on whichever named port React Flow picks.
     */
    const flow: AuthoredFlow = {
      ...FLOW,
      steps: FLOW.steps.map((st) =>
        st.id === "send"
          ? { ...st, paramsExpr: "{{ json(outputs.shaped.value) }}", dependsOn: ["shaped"] }
          : st,
      ),
    };
    const send = inputHandlesFor(flow, CATALOGUE)!.get("send")!;
    expect(send.wholeFrom).toBe("shaped");
    expect(send.bindable).toBe(false);
    expect(send.fields).toEqual([
      { name: "to_email", source: { kind: "whole", stepId: "shaped" } },
      { name: "subject", source: { kind: "whole", stepId: "shaped" } },
    ]);
  });

  it("⚠ `wholeFrom` is read from the EXPRESSION, never from `dependsOn`", () => {
    // A step may depend on several others while its params read one. Naming a
    // dependency would point the card's params handle at a step whose value
    // never reaches the call.
    const flow: AuthoredFlow = {
      ...FLOW,
      steps: FLOW.steps.map((st) =>
        st.id === "send"
          ? {
              ...st,
              paramsExpr: "{{ json(outputs.shaped.value) }}",
              dependsOn: ["rank", "shaped", "overdue"],
            }
          : st,
      ),
    };
    expect(inputHandlesFor(flow, CATALOGUE)!.get("send")!.wholeFrom).toBe("shaped");
  });

  it("⚠ two upstream reads mean NO single source to point at", () => {
    // There is no one step feeding the object, so claiming one would be a
    // wire nobody made.
    const flow: AuthoredFlow = {
      ...FLOW,
      steps: FLOW.steps.map((st) =>
        st.id === "send"
          ? {
              ...st,
              paramsExpr:
                '[{"to_email":"{{ outputs.rank.vars.result }}","subject":"{{ json(outputs.shaped.value) }}"}]',
            }
          : st,
      ),
    };
    expect(inputHandlesFor(flow, CATALOGUE)!.get("send")!.wholeFrom).toBeNull();
  });

  it("⚠ a FAN-OUT binding names its step, which needs the flow's steps to resolve", () => {
    /**
     * ⚠ Found by perturbation: reverting `parseParams(…, flow.steps, …)` to
     * `[]` turned nothing red, because the single-form branch reads the step
     * out of the template text itself. The fan-out form is the one that
     * genuinely needs candidates — `parseParams` recognises which step a
     * fan-out reads by rebuilding each candidate's `rowsExpr`, so with no
     * candidates it resolves nothing and reports a step-bound parameter as
     * bound-to-a-step-with-no-name.
     *
     * The expression is the exact string `buildFanOutParams` emits.
     */
    const flow: AuthoredFlow = {
      ...FLOW,
      steps: FLOW.steps.map((st) =>
        st.id === "send"
          ? {
              ...st,
              dependsOn: ["overdue"],
              paramsExpr:
                '{{ json(outputs.overdue.body).results[0].data | jq(\'[.[] | {"to_email": .email, "subject": "Overdue invoices"}]\') | first }}',
            }
          : st,
      ),
    };
    const send = inputHandlesFor(flow, CATALOGUE)!.get("send")!;
    expect(send.bindable).toBe(true);
    expect(send.fields).toEqual([
      { name: "to_email", source: { kind: "step", stepId: "overdue", field: "email" } },
      { name: "subject", source: { kind: "literal", value: "Overdue invoices" } },
    ]);
  });

  it("⚠ a `code` input's binding lives in `inputExpr`, NOT on the contract field", () => {
    // `ContractField` has no `from` — reading the contract looks right,
    // compiles, and reports every input as unset for ever.
    const flow: AuthoredFlow = {
      ...FLOW,
      steps: FLOW.steps.map((st) =>
        st.id === "rank"
          ? { ...st, inputExpr: '{"rows": {{ json(outputs.overdue.body).results[0].data }}}' }
          : st,
      ),
    };
    expect(inputHandlesFor(flow, CATALOGUE)!.get("rank")!.fields).toEqual([
      { name: "rows", source: { kind: "whole", stepId: "overdue" } },
    ]);
  });

  it("a `code` input explicitly set to null reads as unset", () => {
    const flow: AuthoredFlow = {
      ...FLOW,
      steps: FLOW.steps.map((st) => (st.id === "rank" ? { ...st, inputExpr: '{"rows": null}' } : st)),
    };
    expect(inputHandlesFor(flow, CATALOGUE)!.get("rank")!.fields).toEqual([
      { name: "rows", source: { kind: "unset" } },
    ]);
  });

  it("a null or unreadable catalogue means no ports — the single target stays", () => {
    expect(inputHandlesFor(FLOW, null)).toBeUndefined();
    expect(inputHandlesFor(FLOW, undefined)).toBeUndefined();
    expect(inputHandlesFor(FLOW, { entries: "nope", outputs: SHAPES } as unknown as FieldCatalogue)).toBeUndefined();
  });

  it("steps with nothing bindable are absent — uncatalogued refs and single-expression inputs", () => {
    const flow: AuthoredFlow = {
      id: "x",
      steps: [
        { kind: "tool", id: "mystery", ref: "no_such_tool", paramsExpr: "[{}]" },
        { kind: "transform", id: "t", expr: "{{ 1 }}" },
        { kind: "approval", id: "a", summaryExpr: '"hi?"' },
      ],
    };
    expect(inputHandlesFor(flow, CATALOGUE)).toBeUndefined();
  });
});

describe("connectToField onto a catalogue param", () => {
  it("lands the edge AND binds through the picker's fan-out builder, byte-identical", () => {
    const r = connectToField(FLOW, CATALOGUE, "overdue", "send", "to_email");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The structural half: the edge the drop drew.
    expect(r.flow.steps.find((s) => s.id === "send")?.dependsOn).toEqual(["rank", "overdue"]);
    // The binding half: exactly what `CallForm.push` builds for a first pick
    // of this param — `{ from: "step", stepId, field: "" }`, the picker's
    // first-pick default — fanned out over the upstream head (`rank`), which
    // is what a fresh inspector session defaults its "call it" select to.
    // (Like the picker, the row context comes from the over step, never from
    // the picked source: `jqValue` emits `.field` against the row.)
    const over = r.flow.steps.find((s) => s.id === "rank")!;
    const pickerMade = buildFanOutParams(SHAPES, over, [
      { param: "to_email", source: { from: "step", stepId: "overdue", field: "" } },
    ])!;
    expect(r.flow.steps.find((s) => s.id === "send")).toMatchObject({ paramsExpr: pickerMade });
  });

  it("keeps the existing over step and the untouched params", () => {
    const withOver: AuthoredFlow = {
      id: "x",
      steps: [
        { kind: "datasource", id: "a", ref: "finance_demo.invoices_overdue", paramsExpr: "[{}]" },
        { kind: "datasource", id: "b", ref: "finance_demo.invoices_overdue", paramsExpr: "[{}]" },
        {
          kind: "tool",
          id: "t",
          ref: "mail_send",
          // Already fanned out over `a`, with `subject` bound.
          paramsExpr: buildFanOutParams(SHAPES, { kind: "datasource", id: "a", ref: "finance_demo.invoices_overdue", paramsExpr: "[{}]" }, [
            { param: "subject", source: { from: "step", stepId: "a", field: "title" } },
          ])!,
          dependsOn: ["a"],
        },
      ],
    };
    const r = connectToField(withOver, CATALOGUE, "b", "t", "to_email");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pickerMade = buildFanOutParams(
      SHAPES,
      withOver.steps.find((s) => s.id === "a")!,
      [
        { param: "subject", source: { from: "step", stepId: "a", field: "title" } },
        { param: "to_email", source: { from: "step", stepId: "b", field: "" } },
      ],
    )!;
    expect(r.flow.steps.find((s) => s.id === "t")).toMatchObject({ paramsExpr: pickerMade });
    expect(r.flow.steps.find((s) => s.id === "t")?.dependsOn).toEqual(["a", "b"]);
  });

  it("an unparseable expression is refused: the edge lands, paramsExpr is unchanged", () => {
    // A custom expression no writer may re-emit: `setInputSource` refuses
    // with EXPRESSION_REFUSAL, so the drop lands the structural edge and the
    // expression stays byte-identical — never rebuilt from a blank map.
    const custom: AuthoredFlow = {
      id: "x",
      steps: [
        { kind: "datasource", id: "a", ref: "finance_demo.invoices_overdue", paramsExpr: "[{}]" },
        { kind: "tool", id: "t", ref: "mail_send", paramsExpr: `{{ a_custom_thing }}` },
      ],
    };
    const r = connectToField(custom, CATALOGUE, "a", "t", "to_email");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flow.steps.find((s) => s.id === "t")?.dependsOn).toEqual(["a"]);
    expect(r.flow.steps.find((s) => s.id === "t")).toMatchObject({ paramsExpr: `{{ a_custom_thing }}` });
  });
  it("an over step with no rows shape keeps the edge and skips the binding", () => {
    // `buildFanOutParams` returns null when the over step's kind serves no
    // rows template — the picker's `push` skips its onChange there, and the
    // drop likewise binds nothing while still landing the drawn edge.
    const shapes = { ...SHAPES, datasource: { template: null, describes: null, caution: null } };
    const catalogue = { ...CATALOGUE, outputs: shapes };
    const solo: AuthoredFlow = {
      id: "x",
      steps: [
        { kind: "datasource", id: "a", ref: "finance_demo.invoices_overdue", paramsExpr: "[{}]" },
        { kind: "tool", id: "t", ref: "mail_send", paramsExpr: "[{}]" },
      ],
    };
    const r = connectToField(solo, catalogue, "a", "t", "to_email");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flow.steps.find((s) => s.id === "t")?.dependsOn).toEqual(["a"]);
    expect(r.flow.steps.find((s) => s.id === "t")).toMatchObject({ paramsExpr: "[{}]" });
  });
  it("a dangling over id on an unparseable expression keeps the edge and the expression", () => {
    // The head dependency names a step that is not in the flow — but the
    // expression is hand-written, so no writer may re-emit it regardless of
    // which over step would resolve: the edge lands, the expression stays.
    const dangling: AuthoredFlow = {
      id: "x",
      steps: [
        { kind: "datasource", id: "a", ref: "finance_demo.invoices_overdue", paramsExpr: "[{}]" },
        {
          kind: "tool",
          id: "t",
          ref: "mail_send",
          paramsExpr: `{{ a_custom_thing }}`,
          dependsOn: ["ghost"],
        },
      ],
    };
    const r = connectToField(dangling, CATALOGUE, "a", "t", "to_email");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flow.steps.find((s) => s.id === "t")?.dependsOn).toEqual(["ghost", "a"]);
    expect(r.flow.steps.find((s) => s.id === "t")).toMatchObject({ paramsExpr: `{{ a_custom_thing }}` });
  });
});

describe("connectToField graceful absence", () => {
  it("no catalogue: the edge lands, nothing binds", () => {
    const r = connectToField(FLOW, null, "overdue", "send", "to_email");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flow.steps.find((s) => s.id === "send")?.dependsOn).toEqual(["rank", "overdue"]);
    expect(r.flow.steps.find((s) => s.id === "send")).toMatchObject({ paramsExpr: "[{}]" });
  });

  it("a stale field name on a catalogued step: the edge lands, nothing binds", () => {
    const r = connectToField(FLOW, CATALOGUE, "overdue", "send", "renamed_away");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flow.steps.find((s) => s.id === "send")?.dependsOn).toContain("overdue");
    expect(r.flow.steps.find((s) => s.id === "send")).toMatchObject({ paramsExpr: "[{}]" });
  });

  it("unknown steps refuse like connect does", () => {
    expect(connectToField(FLOW, CATALOGUE, "ghost", "send", "to_email").ok).toBe(false);
    expect(connectToField(FLOW, CATALOGUE, "overdue", "ghost", "to_email").ok).toBe(false);
    expect(connectToField(FLOW, CATALOGUE, "send", "send", "to_email").ok).toBe(false);
  });
});

describe("connectToField dual-write", () => {
  it("a drop onto a catalogue param stores typed inputs beside paramsExpr", () => {
    const r = connectToField(FLOW, CATALOGUE, "overdue", "send", "to_email");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const send = r.flow.steps.find((s) => s.id === "send")!;
    expect((send as { inputs: unknown }).inputs).toEqual([
      { name: "to_email", source: { from: "step", stepId: "overdue", field: "" } },
    ]);
    // The typed read names the same binding the parsed display does.
    const io = stepIo(send, CATALOGUE, r.flow.steps);
    expect(io.inputs.map((i) => i.source)).toEqual([
      { kind: "step", stepId: "overdue", field: "" },
      { kind: "unset" },
    ]);
    expect(io.editable).toBe(true);
  });

  it("a refused call binding stores no typed inputs — the edge lands alone", () => {
    const custom: AuthoredFlow = {
      id: "x",
      steps: [
        { kind: "datasource", id: "a", ref: "finance_demo.invoices_overdue", paramsExpr: "[{}]" },
        { kind: "tool", id: "t", ref: "mail_send", paramsExpr: `{{ a_custom_thing }}` },
      ],
    };
    const r = connectToField(custom, CATALOGUE, "a", "t", "to_email");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.flow.steps.find((s) => s.id === "t")!;
    expect((t as { paramsExpr: string }).paramsExpr).toBe(`{{ a_custom_thing }}`);
    expect((t as { inputs?: unknown }).inputs).toBeUndefined();
  });

  it("a drop onto a code input preserves the other bindings and stores inputs", () => {
    // Unlike the old `rowsFrom` reset — which rebuilt every other input from
    // null — the drop routes through the code writer, so the untouched rate
    // survives beside the new rows binding.
    const flow: AuthoredFlow = {
      id: "x",
      steps: [
        { kind: "datasource", id: "overdue", ref: "finance_demo.invoices_overdue", paramsExpr: "[{}]" },
        {
          kind: "code",
          id: "rank",
          inputExpr: JSON.stringify({ rows: null, rate: "0.5" }),
          contract: {
            purpose: "rank invoices by age",
            input: [
              { name: "rows", type: "array" },
              { name: "rate", type: "number" },
            ],
            output: [{ name: "ranked", type: "array" }],
          },
        },
      ],
    };
    const r = connectToField(flow, CATALOGUE, "overdue", "rank", "rows");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rank = r.flow.steps.find((s) => s.id === "rank")!;
    expect(rank.dependsOn).toEqual(["overdue"]);
    expect((rank as { inputs: unknown }).inputs).toEqual([
      { name: "rows", source: { from: "whole", stepId: "overdue" } },
      { name: "rate", source: { from: "literal", value: "0.5" } },
    ]);
    expect((rank as { inputExpr: string }).inputExpr).toBe(
      buildCodeInput(SHAPES, [
        { name: "rows", source: { kind: "step", step: r.flow.steps.find((s) => s.id === "overdue")!, field: "" } },
        { name: "rate", source: { kind: "literal", value: "0.5" } },
      ]),
    );
    const io = stepIo(rank, CATALOGUE, r.flow.steps);
    expect(io.inputs.map((i) => i.source)).toEqual([
      { kind: "whole", stepId: "overdue" },
      { kind: "literal", value: "0.5" },
    ]);
  });

  it("a drop onto a code step with a hand-shaped payload lands the edge and keeps the payload", () => {
    // No writer may re-emit this payload, so the binding is refused exactly
    // like the call-kind refusal above: the drawn link lands, the payload
    // stays byte-identical, and no typed inputs are stored.
    const payload = '{"rows": {{ json(outputs.overdue.body).results[0].data[0] }}, "extra": 1}';
    const shaped: AuthoredFlow = {
      id: "x",
      steps: [
        { kind: "datasource", id: "overdue", ref: "finance_demo.invoices_overdue", paramsExpr: "[{}]" },
        {
          kind: "code",
          id: "rank",
          inputExpr: payload,
          contract: {
            purpose: "rank invoices by age",
            input: [{ name: "rows", type: "array" }],
            output: [{ name: "ranked", type: "array" }],
          },
        },
      ],
    };
    const r = connectToField(shaped, CATALOGUE, "overdue", "rank", "rows");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rank = r.flow.steps.find((s) => s.id === "rank")!;
    expect(rank.dependsOn).toEqual(["overdue"]);
    expect((rank as { inputExpr: string }).inputExpr).toBe(payload);
    expect((rank as { inputs?: unknown }).inputs).toBeUndefined();
  });
});
