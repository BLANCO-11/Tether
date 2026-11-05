import { describe, expect, it } from "vitest";
import { understand } from "./builder.service.js";
import { planReplyFor } from "./__fixtures__/plan-reply.js";
import type { Chooser } from "./build.js";
import type { BuilderCatalogue } from "./goal-spec.js";
import { clauses, planSchema } from "./plan.js";
import type { Plan } from "./plan.js";
import { validatePlan } from "./validate.js";
const CAT: BuilderCatalogue = {
  items: [
    {
      ref: "ds.r",
      kind: "reader",
      about: "rows",
      fields: [{ name: "hours", ty: "Number" }],
    },
    {
      ref: "mail_send",
      kind: "tool",
      about: "sends mail",
      params: [{ name: "to", about: "" }],
    },
  ],
};

const base = (over: Partial<Plan>): Plan => ({
  sources: [{ ref: "ds.r", quote: "show rows under 5", clauses: ["C1"] }],
  each: null,
  summary: null,
  inputs: [],
  rows: [],
  schedule: null,
  conditions: [],
  actions: [],
  values: [],
  unclear: [],
  missing: "",
  joining: [],
  spelling: [],
  ...over,
});

describe("validatePlan", () => {
  it("a bad field ref yields a Finding and never mutates the plan", () => {
    const p = base({
      rows: [
        {
          clauses: ["C1"],
          field: "ds.r.nope",
          about: "",
          test: "below",
          value: "5",
        },
      ],
    });
    const before = JSON.parse(JSON.stringify(p));
    const findings = validatePlan(p, CAT, clauses("show rows under 5"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      where: "rows 0",
      message: expect.stringContaining("ds.r.nope"),
    });
    expect(p).toEqual(before);
  });

  it("a second identical failure returns findings as readback with the plan deep-equal before/after", async () => {
    // End-to-end through `understand`: a bad ref can never reach validatePlan via makePlan (the strict
    // schema enum rejects unknown refs at parse), so force findings with a class that survives strict
    // parse — an unused input (`in_a`, free-form INPUT_IDS enum, nothing references it). The scripted
    // spec carries it; the plan parses fine under the passed catalogue, then validatePlan flags it.
    // One `builder:plan:repair` re-prompt; the repeated failure returns findings as readback, plan untouched.
    const goal = "show rows under 5";
    const seen: string[] = [];
    const seenPrompts: string[] = [];
    const raw = (async (prompt: string, schema: { name: string; schema: unknown }, label: string) => {
      seen.push(label);
      seenPrompts.push(prompt);
      const reply = planReplyFor(prompt, { sources: [{ ref: "ds.r", quote: goal }], sinks: [], values: [], conditions: [], schedule: null, missing: null, inputs: [{ id: "in_a", kind: "text", words: "the nickname", fill: "each_run", at: "none" }] });
      void schema;
      return JSON.stringify({ ...reply, inputs: [{ id: "in_a", words: "the nickname", kind: "text", fill: "each_run", relative: "none", days: 0, fills: "none", clauses: ["C1"] }] });
    }) as unknown as Chooser;
    const u = await understand(goal, CAT, raw);
    expect(seen.filter((l) => l === "builder:plan:repair")).toHaveLength(1);
    expect(seen[0]).toBe("builder:plan");
    const repairPrompt = seenPrompts[seen.indexOf("builder:plan:repair")]!;
    expect(repairPrompt).toContain("the plan does not satisfy the workspace: input in_a:");
    expect(u.outcome).toBe("cannot");
    expect(u.readback).toHaveLength(1);
    expect(u.readback[0]).toContain("input in_a:");
    expect(u.checked.spec.planGaps).toHaveLength(1);
    // The plan was never mutated: validatePlan leaves its input deep-equal before/after.
    const frozen = base({ inputs: [{ id: "in_a", words: "the nickname", kind: "text", fill: "each_run", relative: "none", days: 0, fills: "none", clauses: ["C1"] }] });
    const frozenBefore = JSON.parse(JSON.stringify(frozen));
    const findings = validatePlan(frozen, CAT, clauses(goal));
    expect(findings).toHaveLength(1);
    expect(frozen).toEqual(frozenBefore);
  });

  it("a clean plan yields no findings", () => {
    const p = base({
      rows: [
        {
          clauses: ["C1"],
          field: "ds.r.hours",
          about: "",
          test: "below",
          value: "5",
        },
      ],
    });
    expect(validatePlan(p, CAT, clauses("show rows under 5"))).toEqual([]);
  });
});
