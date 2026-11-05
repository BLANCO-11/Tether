/**
 * Grounded assistant voice — Strategy B Phase 4b.
 */
import { describe, expect, it } from "vitest";
import { assistantReply, factCardFromLines, phraseFromFacts } from "./assistant-voice.js";

describe("assistant-voice", () => {
  it("phrases only from the fact card", () => {
    const text = phraseFromFacts({
      summary: "This emails overdue invoices each Monday.",
      steps: ["Read past-due invoices", "Email you"],
      gaps: ["which channel for chat"],
      schedule: "Mondays at 9",
    });
    expect(text).toMatch(/overdue invoices/i);
    expect(text).toMatch(/Still open/);
    expect(text).toMatch(/here to help/i);
  });

  it("falls back when the model invents a dotted catalogue ref", async () => {
    const card = factCardFromLines({
      summary: "A short flow",
      inventory: ["Read loans", "Email member"],
      gaps: [],
      catalogueHints: ["lib.loans", "mail_send"],
    });
    const chooser = async () => JSON.stringify({ text: "It also uses hr_demo.secret_table somehow." });
    const { text, calls } = await assistantReply(card, chooser);
    expect(calls).toBe(1);
    expect(text).not.toMatch(/hr_demo\.secret_table/);
    expect(text).toMatch(/A short flow|Read loans/);
  });

  it("CONTROL: honest model phrasing is kept", async () => {
    const card = factCardFromLines({ summary: "Emails you the list", inventory: ["Read loans"], gaps: [] });
    const chooser = async () => JSON.stringify({ text: "I’ll email you the list from the read." });
    const { text } = await assistantReply(card, chooser);
    expect(text).toMatch(/email you the list/i);
  });
});
