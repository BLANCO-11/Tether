/**
 * The goal as the person MEANT it (2026-10-03, beta-2.6.11): spelling slips held to spelling, a reply applied with what it removes
 * gone, a restated goal held to the person's words, and a read held to naming every word it is for. Pure rules — the model's part
 * is measured, not tested here.
 */
import { describe, expect, it } from "vitest";
import { planPrompt, planSchema, clauses, PLAN_SYSTEM } from "./plan.js";
import { stillNamed, accountingGaps } from "./builder.service.js";
import type { BuilderCatalogue } from "./goal-spec.js";



describe("what a reply removes is gone from the restated goal", () => {
  const goal = "get the average attendance for each department. this is to check how managers manage attendance for their sub-ordinates";
  it("an instruction copied into the goal still names what it removed", () => {
    expect(stillNamed(goal, ["their sub-ordinates"], "Get the average attendance for each department. Ignore the reference to subordinates.")).toEqual(["subordinat"]);
    expect(stillNamed(goal, ["their sub-ordinates"], "Get the average attendance for each department. This is to check how managers manage attendance for employees.")).toEqual([]);
  });
  it("CONTROL: a word the goal keeps elsewhere is not a leftover", () => {
    expect(stillNamed(goal, ["how managers manage attendance"], "get the average attendance for each department")).toEqual([]);
    expect(stillNamed("email me the overdue invoices", ["email me"], "post the overdue invoices on chat")).toEqual([]);
  });
  it("a removed part that is not in the goal is ignored, never trusted", () => {
    expect(stillNamed("email me the invoices", ["managers"], "email me the invoices of managers")).toEqual([]);
  });
});

describe("a read accounts for every word it is for", () => {
  it("words of 4+ letters no accounted phrase holds", () => {
    expect(accountingGaps(["managers and their employees' average attendance"], ["average attendance", "employees"])).toEqual(["managers", "their"]);
  });
});

describe("how something is delivered chooses the action, never a value", () => {
  const cat: BuilderCatalogue = { items: [{ kind: "tool", ref: "mail", about: "send an email", params: [{ name: "body", about: "the message" }] }] } as never;
  const cs = clauses("send me the report by email");
  it("the plan is told so, and `channel` is a destination the goal names", () => {
    expect(PLAN_SYSTEM).toMatch(/\("by email", "on chat", "as a ticket"\) choose the action/);
    expect(JSON.stringify(planSchema(cat, cs))).toContain("`channel`: a destination the goal names");
  });
});
