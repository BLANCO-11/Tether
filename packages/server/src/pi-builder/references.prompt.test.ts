/**
 * What Forge is told about referenced workflows: the rules (Workflow Builder only, worded from the person's decision —
 * never assume, ask when unsure, say what was reused) and, each turn, the cards.
 */
import { describe, expect, it } from "vitest";
import { systemPromptFor } from "./instructions.js";
import { cardsBlock } from "./references.js";
import { buildPrompt } from "./service.js";

describe("Forge's instructions", () => {
  const workflow = systemPromptFor("workflow");

  it("carry the reference rules in Workflow Builder, and none in Forge Agent", () => {
    expect(workflow).toContain("## Referenced workflows — `references/`");
    expect(systemPromptFor("agent")).not.toContain("references/");
  });

  it("say never assume, ask when unsure, and override the 'sensible assumption' rule for references", () => {
    expect(workflow).toContain("**Never assume.**");
    expect(workflow).toContain("**When you are not sure whether or how something in a reference applies, ask the person**");
    expect(workflow).toContain('this replaces "do not ask them to confirm what you can sensibly assume": ask.');
  });

  it("say references are read-only, data files are not copied, and what was reused is stated", () => {
    expect(workflow).toContain("**They are read-only examples.**");
    expect(workflow).toContain("**A reference's data files are not copied.**");
    expect(workflow).toContain("**Say what you reused**");
  });
});

describe("the turn's prompt", () => {
  const refs = cardsBlock(
    [{ slug: "attendance", name: "Attendance", label: "saved 2 · not approved", cardMd: "# Attendance\nSaved version 2.\n", bundle: { workflow: { steps: [] }, files: {} }, deleted: false }],
    ["Reference updated: \"Attendance\", saved 1 → saved 2."],
  );

  it("carries the cards before the person's message", () => {
    const p = buildPrompt("build the weekly absentee alert", "", undefined, "workflow", false, refs);
    expect(p).toContain("- references/attendance/ — Attendance, saved 2 · not approved");
    expect(p).toContain("  # Attendance");
    expect(p).toContain('Reference updated: "Attendance", saved 1 → saved 2.');
    expect(p.indexOf("references/attendance/")).toBeLessThan(p.indexOf("User message:"));
  });

  it("has no references section when there are none", () => {
    expect(buildPrompt("hi", "", undefined, "workflow")).not.toContain("Referenced workflows");
  });
});
