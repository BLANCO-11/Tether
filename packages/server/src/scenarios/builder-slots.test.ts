import { describe, expect, it } from "vitest";
import { replyFor, roleOfPort, slotOf, statusOf } from "./builder-slots.js";
import { scoreBuild, type Goal } from "./goalset-score.js";

const goal = (slots: Goal["label"]["slots"], stated: string[] = []): Goal => ({ id: "T1", workspace: "W", goal: "g", label: { outcome: "asks", stated, slots, expect: {} } });

describe("matching the builder's structured questions to label slots (task 5)", () => {
  it("a spec question is matched by its role, preferring the label's own slot name in the role's family", () => {
    const g = goal({ owner_recipient: { accept: ["ask"], answer: "the cost-centre owner" } });
    expect(slotOf(g, { holeId: "spec:0:recipient", ask: "Who should receive it?" })).toBe("owner_recipient");
    expect(slotOf(g, { holeId: "spec:1:period", ask: "Which period?" })).toBe("period");
  });

  it("a hole question is matched by its port; an exact slot name wins over the family", () => {
    const g = goal({ as_of: { accept: ["input", "ask"], answer: "2026-06-30" }, recipient: { accept: ["ask"] } });
    expect(slotOf(g, { holeId: "h_read_1_as_of", ask: "What should `read_1` use for `as_of` (Date)?" })).toBe("as_of");
    expect(slotOf(g, { holeId: "h_call_1_to", ask: "What should `call_1` use for `to` (Address)?" })).toBe("recipient");
    expect(roleOfPort("owner_email")).toBe("recipient");
  });

  it("a question with no counterpart in the label is NAMED, never null — so it scores as unneeded, not as a harness gap", () => {
    const g = goal({ period: { accept: ["input", "ask"], answer: "2026-06" } });
    const subject = slotOf(g, { holeId: "h_call_1_subject", ask: "What should `call_1` use for `subject` (Text)?" });
    const result = slotOf(g, { holeId: "h_result", ask: "No step is the flow's result yet — what should it be?" });
    expect(subject).toBe("subject");
    expect(result).toBe("structure:h_result");
    const s = scoreBuild(g, { status: "incomplete", questions: [{ text: "s", slot: subject }, { text: "r", slot: result }] });
    expect(s.failures.map((f) => f.kind)).toEqual(expect.arrayContaining(["unneeded_question"]));
    expect(s.failures.map((f) => f.kind)).not.toContain("unmatched_question");
  });

  it("E5.9: a DIFFERENT hole in the same family takes the next free slot; the SAME hole again is still a loop", () => {
    const g = goal({ bad: { accept: ["ask"], answer: "below 3" }, low_response: { accept: ["ask"], answer: "under 5 responses" } });
    const taken = new Map<string, string>();
    const a = slotOf(g, { holeId: "shape:0:1:threshold", ask: "What counts as “bad”?" }, taken);
    const b = slotOf(g, { holeId: "shape:0:2:threshold", ask: "What counts as “hardly anyone”?" }, taken);
    expect([a, b]).toEqual(["bad", "low_response"]);
    expect(replyFor(g, b)).toBe("under 5 responses");
    // Control: the same hole asked twice keeps its slot, so the scorer still sees the repeat.
    const again = slotOf(g, { holeId: "shape:0:1:threshold", ask: "What counts as “bad”?" }, taken);
    expect(again).toBe("bad");
    expect(scoreBuild(g, { status: "incomplete", questions: [{ text: "a", slot: a }, { text: "b", slot: b }, { text: "c", slot: again }] }).failures.map((f) => f.kind)).toContain("loop");
    // A third distinct question with the family exhausted is the same decision asked again — a loop, never a fresh slot.
    expect(slotOf(g, { holeId: "h_read_1_max_score", ask: "What should `read_1` use for `max_score` (Number)?" }, taken)).toBe("bad");
  });

  it("a stated slot is matched by name, so asking it scores as redundant", () => {
    const g = goal({}, ["period(relative: this month)"]);
    const slot = slotOf(g, { holeId: "spec:0:period", ask: "Which period?" });
    expect(scoreBuild(g, { status: "ok", questions: [{ text: "p", slot }] }).failures.map((f) => f.kind)).toContain("redundant_question");
  });

  it("the reply is the label's answer, or none", () => {
    const g = goal({ period: { accept: ["input", "ask"], answer: "2026-06" } });
    expect(replyFor(g, "period")).toBe("2026-06");
    expect(replyFor(g, "subject")).toBe("Automated update"); // D-324: the neutral subject gets a generic person's answer
    expect(replyFor(g, "tone")).toBeNull();
  });

  it("build states map onto scoreBuild's vocabulary; a malformed reply is its own state", () => {
    expect(statusOf({ status: "complete" })).toBe("ok");
    expect(statusOf({ status: "cannot" })).toBe("insufficient_catalogue");
    expect(statusOf({ status: "incomplete" })).toBe("incomplete");
    expect(statusOf({ error: Object.assign(new Error("x"), { name: "GatewayDefect" }) })).toBe("gateway_defect");
    expect(statusOf({ error: new Error("boom") })).toBe("failed");
  });
});
