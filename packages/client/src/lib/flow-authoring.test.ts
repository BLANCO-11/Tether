// @vitest-environment node
//
// src/lib/flow-authoring.test.ts — the two pure ops this package adds on top
// of `@foundry/flow-edit`: `blankStep` (the shared blank-step builder every
// surface's canvas add uses) and `duplicateStep` (the context menu's
// Duplicate). Both are new observable contracts — the canvas reports the
// intent, and these functions decide — so each earns its own pin.
import { describe, expect, it } from "vitest";
import { STEP_KINDS } from "@/lib/canvas-model";
import {
  addStep,
  blankStep,
  mergeSources,
  NEEDS_REF,
  duplicateStep,
  addArm,
  chainOf,
  removeArm,
  authoredToStoredFlow,
  type AuthoredFlow,
} from "@/lib/flow-authoring";
import { NODE_TYPES, authoredFromModel } from "@foundry/flow-edit";

const FLOW: AuthoredFlow = {
  id: "f",
  steps: [
    { kind: "datasource", id: "read", ref: "q1", paramsExpr: "[{}]" },
    { kind: "tool", id: "send", ref: "mail_send", paramsExpr: "[{}]", dependsOn: ["read"] },
  ],
};

describe("blankStep", () => {
  it("builds every kind with every field present and none guessed", () => {
    const byKind = (kind: AuthoredFlow["steps"][number]["kind"]) =>
      blankStep(kind, `${kind}_1`, null);
    expect(byKind("datasource")).toEqual({ kind: "datasource", id: "datasource_1", ref: "", paramsExpr: "[{}]" });
    expect(byKind("tool")).toEqual({ kind: "tool", id: "tool_1", ref: "", paramsExpr: "[{}]" });
    expect(byKind("query")).toEqual({ kind: "query", id: "query_1", ref: "", paramsExpr: "[{}]" });
    expect(byKind("transform")).toEqual({
      kind: "transform",
      id: "transform_1",
      expr: "{{ 1 }}",
      mode: "expression",
      templateText: "",
    });
    expect(byKind("approval")).toEqual({
      kind: "approval",
      id: "approval_1",
      summaryExpr: JSON.stringify("Approve this?"),
      summary: "Approve this?",
      awaitSeconds: 86_400,
    });
    // ⚠ The branch guard is EMPTY, never defaulted — a guard nobody
    // configured is a refused save, not a silently-always-true one.
    expect(byKind("branch")).toEqual({ kind: "branch", id: "branch_1", conditionExpr: "", test: null });
    expect(byKind("merge")).toEqual({ kind: "merge", id: "merge_1", sources: [] });
    expect(byKind("code")).toMatchObject({
      kind: "code",
      id: "code_1",
      inputExpr: "{}",
      contract: { purpose: "", input: [], output: [{ name: "result", type: "object" }] },
    });
  });
  it("staged surfaces keep an EMPTY guard; immediate-save surfaces get a neutral always-true one", () => {
    // The refused save is the control on the manual builder: a guard nobody
    // configured must never persist as silently-always-true.
    expect(blankStep("branch", "b", null)).toEqual({ kind: "branch", id: "b", conditionExpr: "", test: null });
    // Chat workbench / flow page write a revision per op and cannot stage an
    // invalid blank — there the guard starts always-true, visibly selected
    // for configuration, like a blank transform's `{{ 1 }}` expr.
    expect(blankStep("branch", "b", null, "", { persistable: true })).toEqual({
      kind: "branch",
      id: "b",
      conditionExpr: "{{ 1 }}",
      test: null,
    });
    // Every other kind is identical either way — only the guard branches.
    expect(blankStep("transform", "t", null, "", { persistable: true })).toEqual({
      kind: "transform",
      id: "t",
      expr: "{{ 1 }}",
      mode: "expression",
      templateText: "",
    });
  });

  it("wires `after` as the new step's dependency — the add-after intent", () => {
    expect(blankStep("transform", "t", "read").dependsOn).toEqual(["read"]);
    expect(blankStep("transform", "t", null).dependsOn).toBeUndefined();
  });
});

/**
 * ⚠ **THE REGISTRY IS THE CONTRACT `blankStep` BUILDS AGAINST.** A blank that
 * misses a `required` property is a step the server refuses at save, and a
 * second list of the runnable kinds beside `offeredKinds()` is how the two
 * drift. So the runnable set is stated once (the eight the compiler emits)
 * and the refusal set is derived: every other registry kind.
 */
describe("blankStep satisfies the registry", () => {
  const RUNNABLE = ["tool", "datasource", "query", "transform", "code", "approval", "branch", "merge", "llm", "http"] as const;
  it("writes every required property for the 10 surviving kinds", () => {
    for (const kind of RUNNABLE) {
      const step = blankStep(kind, `${kind}_1`, null) as unknown as Record<string, unknown>;
      for (const prop of NODE_TYPES[kind].properties) {
        if (prop.required) expect(step[prop.name], `${kind}.${prop.name}`).not.toBeUndefined();
      }
    }
  });
  it("refuses every other registry kind by name", () => {
    const unrunnable = (Object.keys(NODE_TYPES) as Array<keyof typeof NODE_TYPES>).filter(
      (k) => !(RUNNABLE as readonly string[]).includes(k),
    );
    // The control: the scan found the declared-but-unrunnable set, so an empty answer cannot pass.
    expect(unrunnable.length).toBeGreaterThan(0);
    for (const kind of unrunnable) {
      // For each (D-361): runnable, but built only on the engine canvas — refused here with that reason, not the other.
      const why = NODE_TYPES[kind].engineOnly ? `"${kind}" is built on the engine canvas only` : `"${kind}" is declared but not runnable yet`;
      expect(() => blankStep(kind, `${kind}_1`, null)).toThrow(why);
    }
  });
});

describe("duplicateStep", () => {
  it("copies every field under a NEW id, and reports the id", () => {
    const r = duplicateStep(FLOW, "send");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.id).not.toBe("send");
    expect(r.id).toMatch(/^send_/);
    const copy = r.flow.steps.find((s) => s.id === r.id)!;
    expect(copy).toMatchObject({ kind: "tool", ref: "mail_send", paramsExpr: "[{}]", dependsOn: ["read"] });
  });

  it("never rewires downstream steps — a duplicate is a copy, not a re-parent", () => {
    const r = duplicateStep(FLOW, "read");
    if (!r.ok) return;
    // The original's successors keep depending on the ORIGINAL.
    const send = r.flow.steps.find((s) => s.id === "send")!;
    expect(send.dependsOn).toEqual(["read"]);
    expect(r.flow.steps.filter((s) => s.id !== "send" && s.dependsOn?.includes(r.id))).toHaveLength(0);
  });

  it("produces an id the pure addStep accepts — the copy really is addable", () => {
    const r = duplicateStep(FLOW, "send");
    if (!r.ok) return;
    expect(addStep(FLOW, r.flow.steps.find((s) => s.id === r.id)!).ok).toBe(true);
  });

  it("refuses a step that is not in the flow", () => {
    const r = duplicateStep(FLOW, "ghost");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("ghost");
  });
});

/**
 * ⚠ **The carry used to be unconditional**, which was correct while nothing
 * could edit a retry and is silent data loss the moment something can: the form
 * appears to save and the previous value comes straight back. Nothing else
 * would notice — no error, no finding, and the model still validates.
 */
describe("an edited retry WINS over the carried one", () => {
  const prev = {
    id: "f",
    steps: [{ kind: "tool", id: "a", ref: "r", paramsExpr: "{{ x }}", retry: { maxAttempts: 5 } }],
  } as never;

  it("writes the value the inspector produced", () => {
    const authored = {
      id: "f",
      steps: [{ kind: "tool", id: "a", ref: "r", paramsExpr: "{{ x }}", retry: { maxAttempts: 2 } }],
    } as never;
    const out = authoredToStoredFlow(authored, prev);
    expect((out.steps[0] as { retry?: { maxAttempts: number } }).retry).toEqual({ maxAttempts: 2 });
  });

  it("still carries the old one when the inspector supplied none", () => {
    const authored = { id: "f", steps: [{ kind: "tool", id: "a", ref: "r", paramsExpr: "{{ x }}" }] } as never;
    const out = authoredToStoredFlow(authored, prev);
    expect((out.steps[0] as { retry?: { maxAttempts: number } }).retry).toEqual({ maxAttempts: 5 });
  });
});
/**
 * Frozen step SQL (mock-data programme): the editor writes `sql` +
 * `datasourceRef` onto the authored step, and the save must carry both into
 * the revision — a form that appears to freeze and reverts is the retry bug
 * above in a second field. `tool` steps never carry either.
 */
describe("frozen step SQL round-trips on datasource/query steps", () => {
  const prev = {
    id: "f",
    steps: [{ kind: "datasource", id: "read", ref: "hr_demo.late", paramsExpr: "[{}]" }],
  } as never;

  it("writes both keys the editor produced", () => {
    const authored = {
      id: "f",
      steps: [
        {
          kind: "datasource",
          id: "read",
          ref: "hr_demo.late",
          paramsExpr: "[{}]",
          sql: "SELECT * FROM late",
          datasourceRef: "hr_demo",
        },
      ],
    } as never;
    const out = authoredToStoredFlow(authored, prev);
    expect(out.steps[0]).toMatchObject({ sql: "SELECT * FROM late", datasourceRef: "hr_demo" });
  });

  it("still carries the old freeze when the inspector supplied none", () => {
    const frozenPrev = {
      id: "f",
      steps: [
        {
          kind: "datasource",
          id: "read",
          ref: "hr_demo.late",
          paramsExpr: "[{}]",
          sql: "SELECT * FROM late",
          datasourceRef: "hr_demo",
        },
      ],
    } as never;
    const authored = {
      id: "f",
      steps: [{ kind: "datasource", id: "read", ref: "hr_demo.late", paramsExpr: "[{}]" }],
    } as never;
    const out = authoredToStoredFlow(authored, frozenPrev);
    expect(out.steps[0]).toMatchObject({ sql: "SELECT * FROM late", datasourceRef: "hr_demo" });
  });

  it("a tool step never carries either key", () => {
    const authored = {
      id: "f",
      steps: [
        {
          kind: "tool",
          id: "send",
          ref: "mail_send",
          paramsExpr: "[{}]",
          sql: "SELECT 1",
          datasourceRef: "hr_demo",
        },
      ],
    } as never;
    const out = authoredToStoredFlow(authored, prev);
    expect(out.steps[0]).not.toHaveProperty("sql");
    expect(out.steps[0]).not.toHaveProperty("datasourceRef");
  });
});


/**
 * ⚠ **A FIELD THE CANVAS READS BUT DOES NOT WRITE BACK IS SILENT DATA LOSS**,
 * and this repo has shipped that exact shape before: `authoredToStoredFlow`
 * carried `retry` unconditionally, so once the inspector could edit it the
 * edited value was thrown away and the old one always won — a form that appears
 * to save and reverts, with no error and a model that still validates.
 *
 * `name` and `description` are the next two fields at that risk, so the round
 * trip is pinned in both directions before anything can rely on it.
 */
describe("the label round-trips", () => {
  it("writes both fields back out", () => {
    const authored = {
      id: "f",
      steps: [
        {
          kind: "tool",
          id: "a",
          ref: "r",
          paramsExpr: "{{ x }}",
          name: "Email the team",
          description: "Sends the digest once the report is non-empty.",
        },
      ],
    } as never;
    const out = authoredToStoredFlow(authored, { id: "f", steps: [] } as never);
    expect(out.steps[0]).toMatchObject({
      name: "Email the team",
      description: "Sends the digest once the report is non-empty.",
    });
  });

  /**
   * ⚠ **An empty field stores NO KEY, not `""`.** A stored empty string is a
   * value somebody set, and it would travel through export, appear in a bundle,
   * and render as a blank label where the id would otherwise show.
   */
  it("omits the key entirely when the field is blank", () => {
    const authored = {
      id: "f",
      steps: [{ kind: "tool", id: "a", ref: "r", paramsExpr: "{{ x }}", name: "", description: "" }],
    } as never;
    const out = authoredToStoredFlow(authored, { id: "f", steps: [] } as never);
    expect(out.steps[0]).not.toHaveProperty("name");
    expect(out.steps[0]).not.toHaveProperty("description");
  });

  /**
   * ⚠ **THE CONTROL, and it is the half that catches the real bug.** Writing
   * out is useless if reading in drops the field: the model would come back
   * from the server with a label, the canvas would open without it, and the
   * first save would erase it.
   */
  it("survives model → authored → model", () => {
    const stored = {
      id: "f",
      steps: [
        { kind: "tool", id: "a", ref: "r", paramsExpr: "{{ x }}", name: "N", description: "D" },
        { kind: "transform", id: "t", expr: "{{ 1 }}", name: "T", dependsOn: ["a"] },
      ],
    } as never;
    const r = authoredFromModel(stored, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flow.steps[0]).toMatchObject({ name: "N", description: "D" });
    expect(r.flow.steps[1]).toMatchObject({ name: "T" });
    const back = authoredToStoredFlow(r.flow as never, { id: "f", steps: [] } as never);
    expect(back.steps[0]).toMatchObject({ name: "N", description: "D" });
    expect(back.steps[1]).toMatchObject({ name: "T" });
  });
});
/**
 * ⚠ **THE END ROWS HAD NO WRITE PATH AND NO READ PATH.** The End panel wrote
 * `flow.output` into the authored model, `authoredToStoredFlow` dropped it on
 * save, and `authoredFromModel` dropped it on load — a form that appears to
 * save and reverts, twice over. Both directions are pinned here.
 */
describe("the output rows round-trip", () => {
  const rows = [{ name: "escalations", type: "string", source: { from: "step", stepId: "ask", field: "text" } }];
  it("writes the declaration back out", () => {
    const authored = {
      id: "f",
      steps: [{ kind: "transform", id: "t", expr: "{{ 1 }}" }],
      output: { description: "the shortlist", rows },
    } as never;
    const out = authoredToStoredFlow(authored, { id: "f", steps: [] } as never);
    expect(out.output).toEqual({ description: "the shortlist", rows });
  });
  it("survives model → authored → model", () => {
    const stored = {
      id: "f",
      steps: [{ kind: "transform", id: "t", expr: "{{ 1 }}" }],
      output: { description: "the shortlist", rows },
    } as never;
    const r = authoredFromModel(stored, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flow.output).toEqual({ description: "the shortlist", rows });
    const back = authoredToStoredFlow(r.flow as never, { id: "f", steps: [] } as never);
    expect(back.output).toEqual({ description: "the shortlist", rows });
  });
});

/**
 * ⚠ **THE CHAIN IS A LINKED LIST ON `elseOf`, AND NOTHING ELSE CHANGES.**
 * Arm membership stays plain `dependsOn` (D-123), so these three functions are
 * the entire client-side vocabulary for an if/elif/else chain.
 */
describe("if / elif / else chain edits", () => {
  const flow = () =>
    ({
      id: "f",
      steps: [
        { kind: "datasource", id: "read", ref: "q", paramsExpr: "[{}]" },
        { kind: "branch", id: "big", conditionExpr: "{{ a }}", dependsOn: ["read"] },
        { kind: "tool", id: "email", ref: "m", paramsExpr: "[{}]", dependsOn: ["big"] },
      ],
    }) as never as AuthoredFlow;

  const ids = (f: AuthoredFlow) => chainOf(f, "big").map((b) => b.id);

  /**
   * ⚠ **`if (!r.ok) return;` IS A VACUOUS PASS AND THIS EXISTS TO STOP IT.**
   * That pattern narrows the union — which TypeScript wants — and it also means
   * a test whose SETUP failed exits green before asserting anything. Two of the
   * tests below were doing exactly that while a real bug sat underneath. This
   * throws instead, so a failed setup fails the test that depended on it.
   */
  const must = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
    if (!r.ok) throw new Error(`setup failed: ${(r as unknown as { error: string }).error}`);
    return r as Extract<T, { ok: true }>;
  };

  it("finds the chain from ANY member, not just the head", () => {
    const a = must(addArm(flow(), "big", false));
    const r = must(addArm(a.flow, "big", true));
    // Asking from the LAST arm gives the same answer as asking from the first.
    expect(chainOf(r.flow, r.id).map((b) => b.id)).toEqual(chainOf(r.flow, "big").map((b) => b.id));
    expect(chainOf(r.flow, "big").map((b) => b.id)).toEqual(["big", a.id, r.id]);
  });

  it("appends an else-if, then a terminal otherwise", () => {
    const a = must(addArm(flow(), "big", false));
    const b = must(addArm(a.flow, "big", true));
    expect(ids(b.flow)).toEqual(["big", a.id, b.id]);
    // The terminal arm has NO condition — that is what makes it the catch-all.
    const term = b.flow.steps.find((s) => s.id === b.id)!;
    expect(term).not.toHaveProperty("conditionExpr");
  });

  /**
   * ⚠ **A TERMINAL `otherwise` STAYS LAST.** An `else if` behind a catch-all is
   * dead configuration that compiles — the server sees nothing wrong and the
   * arm simply never runs.
   */
  it("⚠ splices a later else-if AHEAD of the otherwise", () => {
    const a = must(addArm(flow(), "big", true));
    const b = must(addArm(a.flow, "big", false));
    expect(ids(b.flow)).toEqual(["big", b.id, a.id]);
  });

  it("refuses a second otherwise", () => {
    const a = must(addArm(flow(), "big", true));
    const b = addArm(a.flow, "big", true);
    expect(b.ok).toBe(false);
    if (b.ok) throw new Error("a second otherwise was accepted");
    expect(b.error).toContain("already has");
  });

  /**
   * ⚠ **`elseOf` AND `dependsOn` TOGETHER ARE REFUSED BY THE COMPILER** — an arm
   * cannot sit inside the arm it is the alternative to. This is the one place
   * that could produce both, so a new arm carries no dependency at all.
   */
  it("⚠ a new arm carries no dependsOn", () => {
    const a = must(addArm(flow(), "big", false));
    const arm = a.flow.steps.find((s) => s.id === a.id)!;
    expect(arm.dependsOn).toBeUndefined();
    expect(arm).toHaveProperty("elseOf", "big");
  });

  it("relinks the chain when a middle arm is removed", () => {
    const a = must(addArm(flow(), "big", false));
    const b = must(addArm(a.flow, "big", true));
    const r = must(removeArm(b.flow, a.id));
    expect(ids(r.flow)).toEqual(["big", b.id]);
  });

  /**
   * ⚠ **THE SAFETY OF THE WHOLE THING.** The steps inside an arm depend on that
   * arm's id. Dropping the arm leaves them pointing at a step that is gone, and
   * the repair a caller reaches for — deleting them too — silently discards
   * work somebody built. Naming them puts the decision back with the person.
   */
  it("⚠ refuses to remove an arm that guards steps, and names them", () => {
    const a = must(addArm(flow(), "big", false));
    const withInner = {
      ...a.flow,
      steps: [...a.flow.steps, { kind: "tool", id: "inner", ref: "m", paramsExpr: "[{}]", dependsOn: [a.id] }],
    } as never as AuthoredFlow;
    const r = removeArm(withInner, a.id);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("removing a guarding arm was accepted");
    expect(r.error).toContain("inner");
    // The control: the same arm with nothing inside it does remove.
    expect(removeArm(a.flow, a.id).ok).toBe(true);
  });

  it("refuses to remove the head — that is deleting the step", () => {
    const a = must(addArm(flow(), "big", false));
    const r = removeArm(a.flow, "big");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("removing the head was accepted");
    expect(r.error).toContain("delete the step");
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ THE MENU MUST NOT OFFER WHAT THE SURFACE CANNOT ADD
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Reported from use: right-clicking the chat builder's canvas and picking a
 * step "throws some error". The menu lists all seventeen kinds; that surface
 * writes a revision on every gesture; and `blankStep` produces `ref: ""` for
 * eight of them, which the server refuses. So eight of seventeen entries were
 * guaranteed failures, and the code comments treated the refusal as the design.
 *
 * The fix is a second menu step that picks a real ref. `NEEDS_REF` is what
 * decides which kinds get one, and it is a MIRROR of `blankStep`'s ref-carrying
 * branch — the exact duplication this repo keeps paying for (I-127). A kind
 * added to `blankStep`'s first case group and not to `NEEDS_REF` is offered as
 * complete when it is not, and the pick fails the old way.
 */
describe("NEEDS_REF mirrors blankStep", () => {
  it("is exactly the set of kinds whose blank carries an empty ref", () => {
    const needsRef = STEP_KINDS.filter((k) => {
      try {
        const b = blankStep(k, `${k}_1`, null) as { ref?: string };
        return "ref" in b && b.ref === "";
      } catch {
        // Declared-but-unrunnable kinds refuse by name — they carry no blank at all.
        return false;
      }
    });
    // The control: the scan found something, so an empty answer cannot pass.
    expect(needsRef.length).toBeGreaterThan(0);
    expect([...NEEDS_REF].sort()).toEqual(needsRef.sort());
  });

  it("a ref supplied at creation lands on the step, so the save is complete", () => {
    for (const k of NEEDS_REF) {
      expect((blankStep(k, `${k}_1`, null, "some_db.a_query") as { ref?: string }).ref).toBe(
        "some_db.a_query",
      );
    }
  });
});

describe("mergeSources — a fresh merge's two inputs from its anchor", () => {
  const steps = [
    { id: "read", kind: "datasource" },
    { id: "shape", kind: "transform", dependsOn: ["read"] },
    { id: "gate", kind: "branch", dependsOn: ["read"] },
    { id: "send", kind: "tool", dependsOn: ["gate"] },
    { id: "log", kind: "tool", dependsOn: ["send"] },
  ];
  it("joins the anchor with its upstream when both combine", () => {
    expect(mergeSources(steps, "shape")).toEqual(["shape", "read"]);
  });
  it("never offers a branch upstream — a combinable step behind it wins", () => {
    expect(mergeSources(steps, "send")).toEqual(["send", "shape"]);
  });
  it("never combines what runs after the anchor", () => {
    // Everything is at or below `read`, so only the anchor itself qualifies.
    expect(mergeSources(steps, "read")).toEqual(["read"]);
  });
  it("no anchor, or an unknown one, means nothing to join", () => {
    expect(mergeSources(steps, null)).toEqual([]);
    expect(mergeSources(steps, "missing")).toEqual([]);
  });
});

describe("writeToolParam stores a flow input ESCAPED (I-288)", () => {
  const read = { kind: "datasource", id: "read", ref: "q", paramsExpr: "[{}]" } as never;
  const shapes = { read: { kind: "rows" } } as never;
  const step = (paramsExpr: string) => ({ kind: "tool", id: "send", ref: "mail.send", paramsExpr, dependsOn: [] }) as never;
  const ctx = { steps: [read], shapes };

  it("an input picked into a blank call is the escaped JSON literal, never spliced between quotes", async () => {
    const { writeToolParam } = await import("@/lib/flow-authoring");
    const r = writeToolParam(step("[{}]"), "period", { type: "string" }, { kind: "expression", template: "{{ inputs.period }}" }, ctx);
    expect(r.ok && r.step.paramsExpr).toBe(`[{ "period": {{ (inputs.period ~ '') | toJson }} }]`);
  });

  it("editing one pair of an escaped call keeps the others, still escaped", async () => {
    const { writeToolParam } = await import("@/lib/flow-authoring");
    const start = `[{ "period": {{ (inputs.period ~ '') | toJson }}, "to": "a@b.example" }]`;
    const r = writeToolParam(step(start), "to", { type: "string" }, { kind: "fixed", value: "c@d.example" }, ctx);
    expect(r.ok && r.step.paramsExpr).toBe(`[{ "period": {{ (inputs.period ~ '') | toJson }}, "to": "c@d.example" }]`);
    const gone = writeToolParam(step(start), "to", { type: "string" }, null, ctx);
    expect(gone.ok && gone.step.paramsExpr).toBe(`[{ "period": {{ (inputs.period ~ '') | toJson }} }]`);
  });
});
