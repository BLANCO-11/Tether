/**
 * Staged plan merge — Strategy B Phase 2 (pure; no model).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mergeStages, planStagesEnabled, type PlanSkeleton, type PlanBind } from "./plan-stages.js";

afterEach(() => {
  delete process.env.BUILDER_INTENT_IR;
  delete process.env.BUILDER_PLAN_STAGES;
});

describe("mergeStages", () => {
  it("attaches recipients by action index", () => {
    const skeleton: PlanSkeleton = {
      sources: [{ ref: "lib.loans", quote: "overdue loans" }],
      conditions: [{ quote: "high risk", on: "if:0" }],
      actions: [
        { ref: "mail_send", quote: "email the member", on: "if:0" },
        { ref: "chat_post", quote: "post otherwise", on: "otherwise" },
      ],
      unclear: [],
    };
    const bind: PlanBind = {
      recipients: [{ action: 0, from: "rows", words: "the member" }],
      schedule: { cron: "0 8 * * *", quote: "every morning" },
      inputs: [],
    };
    const m = mergeStages(skeleton, bind);
    expect(m.actions[0]!.recipient?.words).toBe("the member");
    expect(m.actions[1]!.recipient).toBeUndefined();
    expect(m.schedule?.cron).toBe("0 8 * * *");
  });
});

describe("planStagesEnabled", () => {
  it("stays off when only Intent IR is on — additive stages must not tax every turn", () => {
    process.env.BUILDER_INTENT_IR = "1";
    expect(planStagesEnabled()).toBe(false);
  });
  it("requires both flags", () => {
    process.env.BUILDER_INTENT_IR = "1";
    process.env.BUILDER_PLAN_STAGES = "1";
    expect(planStagesEnabled()).toBe(true);
  });
});
describe("assembleStagedPlan (S2)", () => {
  const skeleton: PlanSkeleton = {
    sources: [{ ref: "lib.loans", quote: "overdue loans" }],
    conditions: [],
    actions: [{ ref: "mail_send", quote: "email the member", on: "always" }],
    unclear: [],
  };
  const bind: PlanBind = {
    recipients: [{ action: 0, from: "rows", words: "the member" }],
    schedule: null,
    inputs: [{ name: "x", words: "the fine" }],
  };
  const cs = [{ id: "C1", text: "email the member about overdue loans" }];

  it("S2: binds skeleton refs to catalogue refs the full schema admits", async () => {
    const { assembleStagedPlan } = await import("./plan-stages.js");
    const cat = { items: [{ kind: "reader", ref: "lib.loans", about: "loans", params: [], fields: [] }, { kind: "tool", ref: "mail_send", about: "send mail", params: [] }] } as never;
    const p = assembleStagedPlan(skeleton, bind, cat, cs as never, { inputIds: ["in_a", "in_b", "in_c", "in_d"] });
    expect(p.sources[0]!.ref).toBe("lib.loans");
    expect(p.actions[0]!.ref).toBe("mail_send");
  });

  it("S2: a skeleton ref no catalogue holds becomes none_fit, never invented", async () => {
    const { assembleStagedPlan } = await import("./plan-stages.js");
    const cat = { items: [{ kind: "reader", ref: "lib.loans", about: "loans", params: [], fields: [] }] } as never;
    const bad = { ...skeleton, actions: [{ ref: "pigeon_post", quote: "send a pigeon", on: "always" }] };
    const p = assembleStagedPlan(bad, bind, cat, cs as never, { inputIds: ["in_a", "in_b", "in_c", "in_d"] });
    expect(p.actions[0]!.ref).toBe("none_fit");
  });

  it("S2: bind inputs land on full input rows with the catalogue's own ids", async () => {
    const { assembleStagedPlan } = await import("./plan-stages.js");
    const cat = { items: [] } as never;
    const p = assembleStagedPlan({ ...skeleton, sources: [], actions: [] }, bind, cat, cs as never, { inputIds: ["in_a", "in_b", "in_c", "in_d"] });
    expect(p.inputs?.[0]?.id).toBe("in_a");
  });
});
describe("staged plan through the normal pipeline (S2)", () => {
  it("S2: an assembled plan normalises and its coverage reads like a modelled plan", async () => {
    const { assembleStagedPlan } = await import("./plan-stages.js");
    const { normalisePlan, planFindings, clauses } = await import("./plan.js");
    const cat = { items: [{ kind: "reader", ref: "lib.loans", about: "loans", params: [], fields: [] }, { kind: "tool", ref: "mail_send", about: "send mail", params: [] }] } as never;
    const cs = clauses("email the member about overdue loans");
    const p = assembleStagedPlan(
      { sources: [{ ref: "lib.loans", quote: "overdue loans" }], conditions: [], actions: [{ ref: "mail_send", quote: "email the member", on: "always" }], unclear: [] },
      { recipients: [{ action: 0, from: "rows", words: "the member" }], schedule: null, inputs: [] },
      cat, cs, { inputIds: ["in_a", "in_b", "in_c", "in_d"] },
    );
    const norm = normalisePlan(p);
    expect(norm.sources[0]!.ref).toBe("lib.loans");
    // Coverage names the only clause the skeleton left out — same gate the re-ask reads.
    const findings = planFindings(norm, cs, cat);
    expect(findings.some((f) => f.includes("implemented by nothing") || f.includes("recipient") || f.includes("address"))).toBe(true);
  });
});
