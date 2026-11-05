import { afterAll, describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { workspaces } from "../db/schema.js";
import { flowService } from "./flow.service.js";
import {
  FLOW_CAPS,
  checkFlowShape,
  checkFlowRefs,
  checkFlowInputResolution,
  checkUnknownBindingSteps,
  flowValidator,
  FlowValidationError,
} from "./flow-validator.service.js";
import { stepBatchSchema } from "./step-execution.service.js";
import type { FlowModel, FlowStep } from "./flow-compiler.service.js";
import { systemAuthor } from "./revision-author.js";

/**
 * The caps, and the two that are deliberately elsewhere.
 *
 * Every cap gets a pair: one model AT the cap that must pass, one over it that
 * must fire. The at-cap half is the discriminating control — a check written as
 * `>=` by accident refuses a legitimate flow, and a suite that only ever tests
 * the failing side scores that bug as green.
 */

function tool(id: string, ref = "send_email"): FlowStep {
  return { kind: "tool", id, ref, paramsExpr: "{{ 1 }}" } as FlowStep;
}
function approval(id: string, awaitSeconds?: number): FlowStep {
  return {
    kind: "approval",
    id,
    summaryExpr: '"go?"',
    ...(awaitSeconds === undefined ? {} : { awaitSeconds }),
  } as FlowStep;
}
function gate(id: string, awaitSeconds?: number): FlowStep {
  return {
    kind: "approval",
    id,
    summaryExpr: '"ok?"',
    ...(awaitSeconds === undefined ? {} : { awaitSeconds }),
  } as FlowStep;
}
function code(id: string): FlowStep {
  return {
    kind: "code",
    id,
    code: "def run(payload):\n    return {}\n",
    inputExpr: "{{ 1 }}",
    outputKeys: ["out"],
  } as FlowStep;
}
function model(steps: FlowStep[]): FlowModel {
  return { id: "a-flow", steps } as FlowModel;
}
function series(n: number, make: (i: number) => FlowStep): FlowStep[] {
  return Array.from({ length: n }, (_, i) => make(i));
}
function rules(findings: { rule: string }[]): string[] {
  return findings.map((f) => f.rule);
}

describe("flow shape caps", () => {
  it("passes a flow AT every cap", () => {
    expect(rules(checkFlowShape(model(series(FLOW_CAPS.steps, (i) => tool(`s${i}`)))))).toEqual([]);
    expect(rules(checkFlowShape(model(series(FLOW_CAPS.codeSteps, (i) => code(`c${i}`)))))).toEqual(
      [],
    );
    expect(
      rules(checkFlowShape(model(series(FLOW_CAPS.approvalSteps, (i) => gate(`a${i}`, 60))))),
    ).toEqual([]);
    expect(
      rules(checkFlowShape(model(series(FLOW_CAPS.approvalSteps, (i) => approval(`p${i}`, 60))))),
    ).toEqual([]);
  });

  it("refuses more steps than the cap, and says how many", () => {
    const findings = checkFlowShape(model(series(FLOW_CAPS.steps + 1, (i) => tool(`s${i}`))));
    expect(rules(findings)).toContain("too_many_steps");
    expect(findings[0]?.facts).toMatchObject({ declared: FLOW_CAPS.steps + 1, cap: FLOW_CAPS.steps });
    expect(findings[0]?.blocking).toBe(true);
  });

  it("counts container starts and gates separately from total steps", () => {
    // Under the step cap, over the per-kind ones. A single total would let a
    // flow declare 40 approval steps and pass.
    const over = model([
      ...series(FLOW_CAPS.codeSteps + 1, (i) => code(`c${i}`)),
      ...series(FLOW_CAPS.approvalSteps + 1, (i) => gate(`a${i}`, 60)),
    ]);
    expect(over.steps.length).toBeLessThanOrEqual(FLOW_CAPS.steps);
    expect(rules(checkFlowShape(over))).toEqual([
      "too_many_code_steps",
      "too_many_approval_steps",
    ]);
  });

  it("names the offending steps, because a count alone is not actionable", () => {
    const findings = checkFlowShape(model(series(FLOW_CAPS.approvalSteps + 1, (i) => gate(`a${i}`, 60))));
    expect(findings[0]?.facts?.stepIds).toEqual(
      Array.from({ length: FLOW_CAPS.approvalSteps + 1 }, (_, i) => `a${i}`),
    );
  });
});

describe("the pause budget", () => {
  it("sums the waits across steps — per-step ceilings do not compose", () => {
    // Two approvals, each individually legal at the 7-day per-step maximum.
    const findings = checkFlowShape(
      model([approval("p0", 604_800), approval("p1", 604_800)]),
    );
    expect(rules(findings)).toEqual(["pause_budget_exceeded"]);
    expect(findings[0]?.facts?.totalSeconds).toBe(1_209_600);
  });

  it("counts an OMITTED awaitSeconds at the compiler's default, not at zero", () => {
    // Eight defaulted approvals = 8 × 86400 = 691200s, over the 604800 cap.
    // Counting an absent field as zero would make the cap avoidable by leaving
    // it out, which is the shape every flow the drafter writes actually has.
    const findings = checkFlowShape(model(series(8, (i) => approval(`p${i}`))));
    expect(rules(findings)).toEqual(["pause_budget_exceeded"]);
    expect(findings[0]?.facts?.totalSeconds).toBe(8 * 86_400);
    const waits = findings[0]?.facts?.waits as Array<{ defaulted: boolean; seconds: number }>;
    expect(waits.every((w) => w.defaulted && w.seconds === 86_400)).toBe(true);
  });

  it("ignores steps that cannot pause", () => {
    expect(rules(checkFlowShape(model(series(FLOW_CAPS.steps, (i) => tool(`s${i}`)))))).toEqual([]);
  });
});

describe("the model size cap", () => {
  it("fires on the product of per-field caps, which no per-field cap can see", () => {
    const fat = model(
      series(40, (i) => ({ kind: "transform", id: `t${i}`, expr: "x".repeat(8000) }) as FlowStep),
    );
    expect(rules(checkFlowShape(fat))).toEqual(["model_too_large"]);
  });
});

describe("tenant-scoped refs", () => {
  const available = ["send_email", "hr.flagged_for_period", "post_message"];

  it("accepts refs registered in this workspace", () => {
    const m = model([tool("a", "send_email"), { kind: "datasource", id: "b", ref: "hr.flagged_for_period", paramsExpr: "{{ 1 }}" } as FlowStep]);
    expect(checkFlowRefs(m, available)).toEqual([]);
  });

  it("refuses an unknown ref and attaches the list that makes a fix possible", () => {
    const findings = checkFlowRefs(model([tool("send", "list-approved-leave")]), available);
    expect(rules(findings)).toEqual(["unknown_ref"]);
    expect(findings[0]?.stepId).toBe("send");
    // The list IS the finding. Without it a redraft is a guess at a name.
    expect(findings[0]?.facts?.available).toEqual([
      "hr.flagged_for_period",
      "post_message",
      "send_email",
    ]);
  });

  it("says nothing about kinds that name no ref", () => {
    // `transform` and `code` reach nothing callable — R9. A validator
    // that invented a ref for them would refuse every generated flow.
    const m = model([code("c"), gate("a", 60), { kind: "transform", id: "t", expr: "{{ 1 }}" } as FlowStep]);
    expect(checkFlowRefs(m, [])).toEqual([]);
  });
});

describe("assertValid", () => {
  it("throws a 400 carrying every finding, not just the first", () => {
    const bad = model([
      ...series(FLOW_CAPS.approvalSteps + 1, (i) => gate(`a${i}`, 60)),
      tool("t", "nope"),
    ]);
    try {
      flowValidator.assertValid(bad, ["send_email"]);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FlowValidationError);
      expect((e as FlowValidationError).statusCode).toBe(400);
      expect(rules((e as FlowValidationError).findings)).toEqual([
        "too_many_approval_steps",
        "unknown_ref",
      ]);
    }
  });

  it("passes a flow that is within every cap and names only known refs", () => {
    expect(() =>
      flowValidator.assertValid(model([tool("a", "send_email"), code("c")]), ["send_email"]),
    ).not.toThrow();
  });
});

/**
 * Wired into `writeRevision`, which is the only claim that matters.
 *
 * Every test above proves the validator is correct in isolation, and a
 * validator nobody calls passes all of them. `writeRevision` is the one function
 * every revision passes through — a hand-authored `POST /flows`, a generated
 * draft, an imported bundle, a seed — which is exactly why D-22's expression
 * check lives there rather than on the routes, and why this does too.
 *
 * The refusal happens BEFORE the compile and before Kestra is contacted, so this
 * needs a database and no engine.
 */
const dbReachable = await (async () => {
  try {
    await db.select({ id: workspaces.id }).from(workspaces).limit(1);
    return true;
  } catch (e) {
    console.warn(`\n[stage-7] SKIPPING the writeRevision wiring test — DB unreachable: ${(e as Error).message}\n`);
    return false;
  }
})();

describe.skipIf(!dbReachable)("wired into writeRevision", () => {
  let wsId: string;

  afterAll(async () => {
    if (wsId) await db.delete(workspaces).where(eq(workspaces.id, wsId));
    await pool.end();
  });

  it("refuses an unknown ref at creation, before anything is compiled or deployed", async () => {
    const stamp = Date.now();
    const [ws] = await db
      .insert(workspaces)
      .values({
        name: `validator-wiring-${stamp}`,
        // The slug pair is mandatory: `writeRevision` resolves the namespaces
        // before it validates anything, so a workspace without one fails
        // earlier and for an unrelated reason — which would make this test pass
        // while proving nothing about the caps.
        slug: `vw-${stamp}`,
        tenantSlug: "e2etest",
        description: "stage-7 test; safe to delete",
      })
      .returning();
    wsId = ws.id;

    // A brand-new workspace has no tools and no queries, so EVERY ref is
    // unknown — which makes this the cheapest possible probe of the wiring and
    // still the real path: `flowService.create` → `writeRevision`.
    await expect(
      flowService.create(wsId, {
        name: "unwired",
        model: model([tool("send", "mail_send")]) as never,
        author: systemAuthor("flow-validator.test"),
      }),
    ).rejects.toMatchObject({ statusCode: 400, name: "FlowValidationError" });
  });

  it("refuses a flow over the step cap the same way", async () => {
    await expect(
      flowService.create(wsId, {
        name: "too big",
        author: systemAuthor("flow-validator.test"),
        model: model(series(FLOW_CAPS.steps + 1, (i) => ({
          kind: "transform",
          id: `t${i}`,
          expr: "{{ 1 }}",
        }) as FlowStep)) as never,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

/**
 * The fan-out cap is NOT in the validator, and this is the test that says so.
 *
 * A model declares a `paramsExpr`, not an item count, so the number of items
 * does not exist until the expression renders. The cap therefore lives at the
 * only place that can see the number — the route Kestra calls back into. Pinned
 * here so widening it fails a test in the file that explains why it is elsewhere.
 */
describe("where the fan-out cap actually lives", () => {
  it("accepts a batch AT the cap and refuses one over it", () => {
    const item = { to: "a@acme-hr.example" };
    const at = stepBatchSchema.safeParse({ ref: "send_email", params: Array(1000).fill(item) });
    const over = stepBatchSchema.safeParse({ ref: "send_email", params: Array(1001).fill(item) });
    expect(at.success).toBe(true);
    expect(over.success).toBe(false);
  });
});

/**
 * The autonomous-readiness check — D-13.
 *
 * A scheduled flow's required inputs must resolve at run creation (a default
 * expression evaluated by Kestra, or a step that computes the value). A
 * schedule fires with no caller; a required input without a default can never
 * be supplied at 09:00. The approval gate is the blocking authority; this
 * check surfaces the finding in drafts and in the drafter's feedback loop.
 */
describe("checkFlowInputResolution — a scheduled flow's required inputs must resolve at run creation", () => {
  const base = (over: Record<string, unknown> = {}) =>
    ({ steps: [], schedule: { cron: "0 9 * * 1-5", timezone: "UTC" }, ...over }) as never;

  it("refuses a scheduled flow whose required input has no default", () => {
    const f = checkFlowInputResolution(
      base({ inputs: [{ id: "period", type: "string", required: true }] }),
    );
    expect(f).toHaveLength(1);
    expect(f[0].rule).toBe("scheduled_input_unresolvable");
    expect(f[0].blocking).toBe(false);
    expect(f[0].message).toContain('"period"');
  });

  it("treats omitted required as required", () => {
    const f = checkFlowInputResolution(
      base({ inputs: [{ id: "period", type: "string" }] }),
    );
    // ⚠ The PROPERTY is `inputs`, not the whole `facts` object. This asserted
    // deep equality and so went red when `unreadInputs` was added beside it —
    // a test failing over a key it is not about is a test that has to be
    // edited every time the payload grows, which is how the edit that matters
    // gets waved through.
    expect(f[0].facts).toMatchObject({ inputs: ["period"] });
  });

  it("treats an explicitly empty default as present", () => {
    const f = checkFlowInputResolution(
      base({ inputs: [{ id: "period", type: "string", defaults: "" }] }),
    );
    expect(f).toEqual([]);
  });

  it("passes a scheduled flow whose required input has a default", () => {
    const f = checkFlowInputResolution(
      base({
        inputs: [
          { id: "period", type: "string", required: true, defaults: "{{ execution.startDate | date('yyyy-MM') }}" },
        ],
      }),
    );
    expect(f).toHaveLength(0);
  });

  it("passes a scheduled flow whose inputs are optional (caller may or may not supply)", () => {
    const f = checkFlowInputResolution(
      base({ inputs: [{ id: "period", type: "string", required: false }] }),
    );
    expect(f).toHaveLength(0);
  });

  it("passes an on-demand flow — callers supply inputs or the run is refused in the open", () => {
    const f = checkFlowInputResolution({
      steps: [],
      inputs: [{ id: "period", type: "string", required: true }],
    } as never);
    expect(f).toHaveLength(0);
  });

  /**
   * ⚠ **REWRITTEN, NOT DELETED — the rule is retired and this pins that.**
   * It used to require `webhook_input_unresolvable` for a model declaring a
   * webhook with an unresolvable required input. `webhook` was retired on
   * 2026-09-08: it cannot be declared, it cannot be created, and its receiver
   * refuses unconditionally, so the failure that rule described — an
   * unauthenticated endpoint guaranteed to fail on every call — has no subject
   * left. Deleting the test would have been the quiet option and would have
   * left nothing asserting that the rule is gone rather than merely unreached.
   */
  it("⚠ a model still carrying `webhook` gets NO webhook finding — the rule is retired", () => {
    const f = checkFlowInputResolution({
      steps: [],
      webhook: { name: "orders" },
      inputs: [{ id: "tenant", type: "STRING" }],
    } as never);
    // No schedule, so nothing to warn about at all — the declaration is inert.
    expect(f).toHaveLength(0);
    expect(JSON.stringify(f)).not.toContain("webhook_input_unresolvable");
  });

  it("⚠ an `api` flow with an input that has no default is NOT warned about", () => {
    /**
     * The rule deliberately did not follow the webhook arm across to `api`. An
     * api caller carries its inputs in a body type-checked against the declared
     * inputs before anything is written, so "no default" means the caller
     * supplies it — the normal case. Warning here would fire on every correct
     * api flow, and a guard that cries wolf gets widened until the widening
     * permits the defect (I-62).
     */
    const f = checkFlowInputResolution({
      steps: [],
      api: { name: "orders" },
      inputs: [{ id: "tenant", type: "STRING", required: true }],
    } as never);
    expect(f).toHaveLength(0);
  });

  it("CONTROL: the SCHEDULE arm still fires, so the check is not simply off", () => {
    const f = checkFlowInputResolution({
      steps: [],
      schedule: { cron: "0 7 * * 1" },
      inputs: [{ id: "tenant", type: "STRING", required: true }],
    } as never);
    expect(f[0]).toMatchObject({ rule: "scheduled_input_unresolvable", blocking: false });
    expect(f[0]!.message).toContain('"tenant"');
  });

  it("names every unresolvable input, not just the first", () => {
    const f = checkFlowInputResolution(
      base({
        inputs: [
          { id: "period", type: "string", required: true },
          { id: "region", type: "string", required: true },
          { id: "ok", type: "string", required: true, defaults: "{{ 1 }}" },
        ],
      }),
    );
    expect(f[0].message).toContain('"period"');
    expect(f[0].message).toContain('"region"');
    expect(f[0].message).not.toContain('"ok"');
  });
});

describe("checkUnknownBindingSteps — a feed bound to a step that is not in the flow", () => {
  // Rev-2 live shape: `fetch.period → derive_month.month` with no `derive_month`
  // step. The revision saved and deployed with every validator green.
  const rev2 = (): FlowModel =>
    model([
      {
        kind: "tool",
        id: "fetch",
        ref: "send_email",
        paramsExpr: "[{}]",
        inputs: [{ name: "period", source: { from: "step", stepId: "derive_month", field: "month" } }],
      } as FlowStep,
    ]);

  it("refuses with a blocking unknown_binding_step naming reader, step, and declared ids", () => {
    const findings = checkUnknownBindingSteps(rev2());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "unknown_binding_step", blocking: true, stepId: "fetch" });
    expect(findings[0]!.message).toContain('step "fetch".inputs[period]');
    expect(findings[0]!.message).toContain('"derive_month"');
    expect(findings[0]!.message).toContain("steps: fetch");
    expect(findings[0]!.facts).toEqual({
      reader: 'step "fetch".inputs[period]',
      stepId: "derive_month",
      steps: ["fetch"],
    });
  });

  it("covers every structured feed: over, approval context, branch guards, params rows", () => {
    const findings = checkUnknownBindingSteps(
      model([
        { kind: "datasource", id: "fetch", ref: "d.q", paramsExpr: "[{}]" } as FlowStep,
        {
          kind: "tool",
          id: "send",
          ref: "send_email",
          paramsExpr: "[{}]",
          over: { stepId: "gone", field: "rows" },
          params: { period: { source: { kind: "step", stepId: "gone", field: "month" } } },
        } as unknown as FlowStep,
        {
          kind: "approval",
          id: "gate",
          summaryExpr: '"go?"',
          context: { from: "whole", stepId: "gone" },
        } as unknown as FlowStep,
        {
          kind: "branch",
          id: "cond",
          conditionExpr: "{{ true }}",
          test: { left: { from: "step", stepId: "gone", field: "n" }, operator: "field_gt", right: "1" },
          conditions: [{ left: { stepId: "gone", field: "n" }, op: "field_gt", right: { fixed: "1" } }],
        } as unknown as FlowStep,
      ]),
    );
    const readers = findings.map((f) => f.message);
    expect(findings.length).toBeGreaterThanOrEqual(5);
    expect(findings.every((f) => f.rule === "unknown_binding_step" && f.blocking)).toBe(true);
    for (const reader of [
      'step "send".over',
      'step "send".params[period]',
      'step "gate".context',
      'step "cond".test.left',
      'step "cond".conditions[0].left',
    ]) {
      expect(readers.some((m) => m.includes(reader))).toBe(true);
    }
  });

  it("leaves flow output rows to checkFlowOutput — no duplicate rule on one defect", () => {
    const withRow = rev2();
    withRow.output = {
      rows: [{ name: "answer", type: "string", source: { from: "whole", stepId: "gone" } }],
    } as FlowModel["output"];
    expect(checkUnknownBindingSteps(withRow).map((f) => f.message).join("\n")).not.toContain("output row");
  });

  it("passes a flow whose bindings all resolve — the control", () => {
    const fixed = rev2();
    (fixed.steps[0] as unknown as Record<string, unknown>).inputs = [
      { name: "period", source: { from: "step", stepId: "fetch", field: "month" } },
    ];
    expect(checkUnknownBindingSteps(fixed)).toEqual([]);
  });

  it("assertValid throws carrying the finding", () => {
    try {
      flowValidator.assertValid(rev2(), ["send_email"]);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FlowValidationError);
      const rules = (e as FlowValidationError).findings.map((f) => f.rule);
      expect(rules).toContain("unknown_binding_step");
    }
  });
});
