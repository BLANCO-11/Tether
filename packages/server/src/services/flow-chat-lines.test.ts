import { describe, expect, it } from "vitest";
import { chatLines } from "./flow-chat-builder.js";

/** The readback as chat shows it (2026-09-28): the lines of the report, tidied — never the person's own words. */
describe("chatLines", () => {
  const rb = [
    "Reads: Budget versus actual per cost centre (finance_demo.spend_by_cost_centre) — for “budget versus actual spending by cost centre”",
    "Then (finance_demo.spend_by_cost_centre): Groups the rows by `cost_centre_name`, with the total of `budget_cents` (as `sum_budget_cents`) — for “budget versus actual spending by cost centre”",
    "Skipped: rows of finance_demo.spend_by_cost_centre with no cost_centre_name are left out of the result — the run lists them separately",
  ];
  it("drops refs, backticks, aliases and a repeated quote", () => {
    expect(chatLines(rb)).toEqual([
      "Reads: Budget versus actual per cost centre — for “budget versus actual spending by cost centre”",
      "Then: Groups the rows by cost centre name, with the total of budget cents",
      "Skipped: rows of spend by cost centre with no cost centre name are left out of the result — the run lists them separately",
    ]);
  });
  it("never rewrites the person's quoted words, an address, or a number", () => {
    expect(chatLines(["Who receives it: “ops@acme-corp.com”, from your goal", "The threshold: “2.5”, from your goal", "Does: mail (mail.send_now) — for “email ops@acme-corp.com”"]))
      .toEqual(["Who receives it: “ops@acme-corp.com”, from your goal", "The threshold: “2.5”, from your goal", "Does: mail — for “email ops@acme-corp.com”"]);
  });
});
