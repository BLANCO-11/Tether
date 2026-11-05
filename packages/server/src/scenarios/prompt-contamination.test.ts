import { describe, expect, it } from "vitest";
import { contamination, promptExamples } from "./prompt-contamination.js";
import { goalSpecPrompt } from "../services/builder/goal-spec.js";

describe("prompt contamination", () => {
  const goals = [{ id: "G1", goal: "Chase the tickets that waited too long, every Monday morning" }, { id: "G2", goal: "email me the list" }];
  it("finds an example copied from a goal, as whole words, and ignores pronouns and short words", () => {
    const prompt = 'Vague words ("too long", "soon") … a requester ("me") … schedule ("every monday morning") … ("longest")';
    expect(contamination(promptExamples(prompt), goals)).toEqual([{ example: "too long", goals: ["G1"] }, { example: "every monday morning", goals: ["G1"] }]);
  });
  it("the spec prompt as shipped carries no example of these goals (CONTROL: the scan reads the real prompt's examples)", () => {
    const ex = promptExamples(goalSpecPrompt("x", { items: [] }));
    expect(ex.length).toBeGreaterThan(10);
    expect(contamination(ex, goals)).toEqual([]);
  });
});
