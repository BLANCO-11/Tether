// ⚠ `./index.js`, not `./index` — this package is NodeNext, where a relative
// import without an extension does not resolve. It degrades silently rather than
// erroring: every imported symbol becomes `any`, so the suite still passes and
// `tsconfig.typecheck.json` reports seventeen `implicitly has an 'any' type`
// errors somewhere else entirely. Same form `@foundry/redact`'s suite uses.
import { describe, it, expect } from "vitest";
import {
  addStep,
  connect,
  disconnect,
  localFindings,
  removeStep,
  replaceStep,
  reaches,
  spliceApproval,
  uniqueStepId,
  candidateUpstream,
  slugify,
  upstreamOf,
  connectionRefusal,
  isValidStepId,
  addExpectation,
  removeExpectation,
  describeExpectation,
  EXPECTABLE_KINDS,
  type AuthoredFlow,
  type AuthoredStep,
  type FlowExpectation,
  type StepKind,
} from "./index.js";

/**
 * These are the rules the editable canvas rests on. Every one of them is a
 * property of a pure function precisely so it can be asserted without rendering
 * anything — a cycle refused inside a `onConnect` handler is a rule only a
 * browser can check.
 */

const fetchStep: AuthoredStep = {
  kind: "datasource",
  id: "fetch",
  ref: "finance_demo.invoices_overdue",
  paramsExpr: '[{ "period": "{{ inputs.period }}" }]',
};
const shapeStep: AuthoredStep = { kind: "transform", id: "shape", expr: "{{ 1 }}", dependsOn: ["fetch"] };
const sendStep: AuthoredStep = {
  kind: "tool",
  id: "send",
  ref: "mail_send",
  paramsExpr: "[{}]",
  dependsOn: ["shape"],
};

const flow: AuthoredFlow = { id: "chase", steps: [fetchStep, shapeStep, sendStep] };

describe("ids", () => {
  it("refuses the two ids the compiler emits itself", () => {
    expect(isValidStepId("begin")).toBe(false);
    expect(isValidStepId("complete")).toBe(false);
  });

  it("refuses a shape the compiler's regex would", () => {
    expect(isValidStepId("Send-Mail")).toBe(false);
    expect(isValidStepId("2fetch")).toBe(false);
    expect(isValidStepId("send_mail")).toBe(true);
  });

  it("slugify never produces something the compiler rejects", () => {
    for (const raw of ["Email the vendor", "2026 report", "  ", "—", "ALL CAPS!!"]) {
      expect(isValidStepId(slugify(raw))).toBe(true);
    }
  });

  it("uniqueStepId avoids taken ids AND reserved ones", () => {
    expect(uniqueStepId(flow, "fetch")).toBe("fetch_2");
    // ⚠ The reserved case: without it, "add a step called complete" builds a
    // flow that fails to compile naming a task the person never wrote.
    expect(uniqueStepId(flow, "complete")).toBe("complete_2");
  });
});

describe("connect refuses what would not compile", () => {
  it("refuses a self-link", () => {
    expect(connect(flow, "fetch", "fetch")).toMatchObject({ ok: false });
  });

  it("refuses a duplicate link", () => {
    expect(connect(flow, "fetch", "shape")).toMatchObject({ ok: false });
  });

  /**
   * The one that matters. Two arrows that look fine on a canvas close a loop,
   * and the server's message is a compile error rather than the link that did
   * it.
   */
  it("refuses a link that would close a cycle", () => {
    const r = connect(flow, "send", "fetch");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/loop/);
  });

  it("allows a legal second parent", () => {
    const r = connect(flow, "fetch", "send");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.flow.steps.find((s) => s.id === "send")?.dependsOn).toEqual(["shape", "fetch"]);
  });

  it("does not mutate the flow it was given", () => {
    connect(flow, "fetch", "send");
    expect(flow.steps.find((s) => s.id === "send")?.dependsOn).toEqual(["shape"]);
  });
});

describe("reaches / candidateUpstream", () => {
  it("follows dependsOn forwards", () => {
    expect(reaches(flow, "fetch", "send")).toBe(true);
    expect(reaches(flow, "send", "fetch")).toBe(false);
  });

  it("offers only steps that could legally feed a node", () => {
    expect(candidateUpstream(flow, "send").map((s) => s.id)).toEqual(["fetch"]);
    expect(candidateUpstream(flow, "fetch")).toEqual([]);
  });

  it("upstreamOf names what has already run, transitively", () => {
    expect(upstreamOf(flow, "send").map((s) => s.id)).toEqual(["fetch", "shape"]);
    expect(upstreamOf(flow, "fetch")).toEqual([]);
  });

  it("connectionRefusal names each connect refusal before the drop", () => {
    const cases = [
      ["send", "send", "a step cannot depend on itself"],
      ["send", "missing", "both ends of a link must be steps in this flow"],
      ["fetch", "shape", '"shape" already runs after "fetch"'],
      ["send", "fetch", 'that would make a loop — "send" already runs after "fetch"'],
    ] as const;
    for (const [from, to, reason] of cases) {
      expect(connectionRefusal(flow, from, to)).toBe(reason);
      const r = connect(flow, from, to);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe(reason);
    }
    expect(connectionRefusal(flow, "fetch", "send")).toBe(null);
    expect(connect(flow, "fetch", "send").ok).toBe(true);
  });
});

describe("removeStep unlinks", () => {
  it("takes every reference to the deleted step with it", () => {
    const r = removeStep(flow, "shape");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flow.steps.map((s) => s.id)).toEqual(["fetch", "send"]);
    // Left behind, this is `depends on unknown step` — a correct compiler error
    // about a step the person did not touch.
    expect(r.flow.steps.find((s) => s.id === "send")?.dependsOn).toEqual([]);
  });
});

describe("replaceStep", () => {
  it("carries a rename into every dependsOn", () => {
    const r = replaceStep(flow, "shape", { ...shapeStep, id: "project" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flow.steps.find((s) => s.id === "send")?.dependsOn).toEqual(["project"]);
  });

  it("refuses a rename onto an existing id", () => {
    expect(replaceStep(flow, "shape", { ...shapeStep, id: "send" })).toMatchObject({ ok: false });
  });
});

describe("spliceApproval — before, never after", () => {
  const r = spliceApproval(flow, "send");

  it("inserts the gate at the target's position", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flow.steps.map((s) => s.id)).toEqual(["fetch", "shape", "send_gate", "send"]);
  });

  /**
   * ⚠ The property gate 3 lives or dies on. Kestra runs tasks in emission order,
   * so a gate AFTER its target satisfies every assertion about a pause existing
   * and stops not one email.
   */
  it("the gate inherits the target's dependencies and the target depends on the gate alone", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gate = r.flow.steps.find((s) => s.id === "send_gate")!;
    const target = r.flow.steps.find((s) => s.id === "send")!;
    expect(gate.dependsOn).toEqual(["shape"]);
    expect(target.dependsOn).toEqual(["send_gate"]);
  });

  it("the question is a JSON STRING, quotes included (I-11)", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gate = r.flow.steps.find((s) => s.id === "send_gate")!;
    if (gate.kind !== "approval") throw new Error("not a gate");
    expect(gate.summaryExpr!.startsWith('"')).toBe(true);
    expect(() => JSON.parse(gate.summaryExpr!)).not.toThrow();
  });

  it("refuses to gate a gate", () => {
    if (!r.ok) return;
    expect(spliceApproval(r.flow, "send_gate")).toMatchObject({ ok: false });
  });
});

describe("localFindings", () => {
  it("is empty for a complete flow", () => {
    const findings = localFindings(flow, { refs: new Set(["finance_demo.invoices_overdue", "mail_send"]) });
    expect(findings.filter((f) => f.blocking)).toEqual([]);
  });

  it("names an unregistered ref against the workspace's actual list", () => {
    const findings = localFindings(flow, { refs: new Set(["mail_send"]) });
    expect(findings.some((f) => f.stepId === "fetch" && f.blocking)).toBe(true);
  });

  /**
   * ⚠ platform-coherence Phase 5.1, I-106. Before this, "no parameters set" was
   * the ONLY thing ever said about a call's arguments — so a tool with three
   * required parameters and one of them mapped read as finished, and the first
   * anyone heard was the call failing at runtime. The catalogue has carried
   * `required` per parameter since Stage 5 and nothing looked at it.
   */
  it("names a required parameter it cannot see in the expression", () => {
    const required = new Map([["mail_send", ["to_email", "subject"]]]);
    const f = localFindings(flow, { requiredParams: required }).find((x) => x.stepId === "send");
    expect(f).toBeTruthy();
    expect(f!.message).toContain("to_email");
    expect(f!.message).toContain("subject");
  });

  /**
   * ⚠ NEVER blocking, and this is the assertion that keeps it honest.
   *
   * D-50 leaves a raw escape hatch — a person may type an expression — and there
   * a parameter name can be built by concatenation and be perfectly correct
   * while invisible to a regex. A guard with false positives gets widened, and
   * the widening is what permits the defect (I-62). So it reports what it can
   * and cannot see, in those words, and refuses nothing.
   */
  it("does NOT block on a parameter it cannot see", () => {
    const required = new Map([["mail_send", ["to_email"]]]);
    const f = localFindings(flow, { requiredParams: required }).find((x) => x.stepId === "send");
    expect(f!.blocking).toBe(false);
    expect(f!.message).toContain("only reads the ones the form writes");
  });

  it("says nothing when every required parameter is visible", () => {
    // The control. Without it, "reports a missing parameter" also passes against
    // a check that fires on every call in the product.
    const required = new Map([["finance_demo.invoices_overdue", ["period"]]]);
    expect(localFindings(flow, { requiredParams: required }).some((x) => x.stepId === "fetch")).toBe(
      false,
    );
  });

  /**
   * ⚠ Non-blocking, same reasoning as the trailing gate below. A step with no
   * `dependsOn` runs at the START, in parallel with the first — legal, and
   * sometimes exactly right for two independent queries, but almost never what
   * somebody meant when they placed a tool call fourth on the canvas.
   */
  it("warns about a step nothing feeds, WITHOUT blocking", () => {
    const orphaned = addStep(flow, { kind: "transform", id: "loose", expr: "{{ 1 }}" });
    expect(orphaned.ok).toBe(true);
    if (!orphaned.ok) return;
    const f = localFindings(orphaned.flow).find((x) => x.stepId === "loose");
    expect(f!.blocking).toBe(false);
    expect(f!.message).toContain("runs at the very start");
  });

  it("does not call the FIRST step orphaned — something has to start the flow", () => {
    expect(localFindings(flow).some((x) => x.stepId === "fetch" && /nothing feeds/.test(x.message)))
      .toBe(false);
  });

  it("reports a dangling dependsOn", () => {
    const broken: AuthoredFlow = { id: "x", steps: [{ ...sendStep, dependsOn: ["ghost"] }] };
    expect(localFindings(broken).some((f) => f.message.includes("ghost"))).toBe(true);
  });

  /**
   * ⚠ Non-blocking on purpose. A trailing gate compiles perfectly and stops
   * nothing; that is a judgement about intent, so the canvas says it rather than
   * refusing it.
   */
  it("warns about a gate nothing runs after, WITHOUT blocking", () => {
    const withGate = spliceApproval(flow, "send");
    expect(withGate.ok).toBe(true);
    if (!withGate.ok) return;
    const appended = addStep(withGate.flow, {
      kind: "approval",
      id: "trailing",
      summaryExpr: '"ok?"',
      dependsOn: ["send"],
    });
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    const f = localFindings(appended.flow).find((x) => x.stepId === "trailing");
    expect(f).toBeDefined();
    expect(f!.blocking).toBe(false);
    expect(f!.message).toMatch(/stops nothing/);
    // and the spliced one is NOT warned about
    expect(localFindings(appended.flow).some((x) => x.stepId === "send_gate")).toBe(false);
  });

  it("counts against the caps it was handed, not against a hardcoded copy", () => {
    const many: AuthoredFlow = {
      id: "many",
      steps: Array.from({ length: 3 }, (_, i) => ({
        kind: "approval" as const,
        id: `a${i}`,
        summaryExpr: '"go?"',
      })),
    };
    // ⚠ A cap the PRODUCT does not use, on purpose: the point is that the number
    // comes from the argument and not from a copy inside the module.
    const caps = { steps: 64, codeSteps: 16, approvalSteps: 2 };
    expect(localFindings(many, { caps }).some((f) => f.message.includes("the cap is 2"))).toBe(true);
  });
});

// ── Expectations — GAPS §2.3 ─────────────────────────────────────────────────

describe("addExpectation — the form refuses before the server has to", () => {
  const STEPS: Array<{ id: string; kind: StepKind }> = [
    { id: "screen", kind: "datasource" },
    { id: "ask", kind: "approval" },
  ];
  const claim = (over: Partial<FlowExpectation> = {}): FlowExpectation => ({
    id: "eleven",
    stepId: "screen",
    assert: { type: "rowCount", op: "eq", value: 11 },
    ...over,
  });

  it("accepts a well-formed claim on a readable step — the positive control", () => {
    const r = addExpectation([], STEPS, claim());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.expectations).toHaveLength(1);
  });

  it("refuses a duplicate name — the verdict row is keyed on it", () => {
    const r = addExpectation([claim()], STEPS, claim());
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/already an expectation/);
  });

  it("refuses a step this flow does not have, and one whose kind produces nothing readable", () => {
    expect(addExpectation([], STEPS, claim({ stepId: "nope" })).ok).toBe(false);
    const onAgent = addExpectation([], STEPS, claim({ stepId: "ask" }));
    expect(onAgent).toMatchObject({ ok: false });
    if (!onAgent.ok) expect(onAgent.error).toMatch(/`approval` step produces no output/);
  });

  it("⚠ refuses a dotted field — a path is the first inch of an expression language", () => {
    const r = addExpectation([], STEPS, {
      id: "nested",
      stepId: "screen",
      assert: { type: "field", field: "a.b", op: "eq", value: 1 },
    });
    expect(r).toMatchObject({ ok: false });
  });

  it("⚠ refuses a value-taking op with no value — otherwise `neq` passes over anything", () => {
    const r = addExpectation([], STEPS, {
      id: "no_value",
      stepId: "screen",
      assert: { type: "field", field: "sent", op: "neq" },
    });
    expect(r).toMatchObject({ ok: false });
    // …and the reverse: `present` with a value is also refused, so the pairing
    // is enforced in both directions rather than only the one that bites.
    expect(
      addExpectation([], STEPS, {
        id: "extra_value",
        stepId: "screen",
        assert: { type: "field", field: "sent", op: "present", value: 1 },
      }).ok,
    ).toBe(false);
  });

  it("removeExpectation drops exactly one, by name", () => {
    const two = [claim(), claim({ id: "twelve" })];
    expect(removeExpectation(two, "eleven").map((e) => e.id)).toEqual(["twelve"]);
  });

  it("EXPECTABLE_KINDS matches the server's list", () => {
    // Two copies, and this is the test that stops them drifting into a form
    // that offers a step the server will refuse (or hides one it would accept).
    expect([...EXPECTABLE_KINDS].sort()).toEqual(["code", "datasource", "query", "tool", "transform"]);
  });

  it("describeExpectation renders each shape once, in English", () => {
    expect(describeExpectation(claim())).toBe("screen produces exactly 11 row(s)");
    expect(
      describeExpectation({
        id: "x",
        stepId: "screen",
        select: "flagged",
        assert: { type: "rows", quantifier: "none", field: "email", op: "absent" },
      }),
    ).toBe("no row of screen.flagged has email absent");
  });
});
