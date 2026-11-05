import { describe, expect, it } from "vitest";
import { MULTI_NONE, checkAnswer, multiChoices, normaliseQuestion, toStored } from "./question-kinds.js";
import type { PiQuestion } from "./types.js";

describe("a question without a kind is what it always was", () => {
  it("keeps prompt, choices and pick exactly", () => {
    const q = { id: "q1", prompt: "Which?", choices: ["a", "b"] };
    expect(normaliseQuestion(q)).toEqual(q);
    const f: PiQuestion = { id: "q2", prompt: "Which file?", pick: "file", choices: ["x.csv"] };
    expect(normaliseQuestion(f)).toEqual(f);
    expect(checkAnswer(q, "something typed")).toEqual({ ok: true });
  });
});

describe("normalising falls back, never renders blank", () => {
  it("drops an unknown kind", () => {
    expect(normaliseQuestion({ id: "q", prompt: "p", kind: "slider" as never }).kind).toBeUndefined();
  });
  it("a multi with nothing to tick is plain text", () => {
    expect(normaliseQuestion({ id: "q", prompt: "p", kind: "multi", choices: [] }).kind).toBeUndefined();
  });
  it("a pick wins over a kind", () => {
    expect(normaliseQuestion({ id: "q", prompt: "p", kind: "multi", choices: ["a"], pick: "files" }).kind).toBeUndefined();
  });
  it("drops bounds that do not belong or do not make sense", () => {
    expect(normaliseQuestion({ id: "q", prompt: "p", kind: "text", min: 1 }).min).toBeUndefined();
    const n = normaliseQuestion({ id: "q", prompt: "p", kind: "number", min: 5, max: 1 });
    expect([n.min, n.max]).toEqual([undefined, undefined]);
  });
});

describe("an answer is checked against its question", () => {
  const multi: PiQuestion = { id: "m", prompt: "Which?", kind: "multi", choices: ["Remarks", "Absent"] };
  it("multi: listed options, one per line, or none", () => {
    expect(checkAnswer(multi, "Remarks\nAbsent")).toEqual({ ok: true });
    expect(checkAnswer(multi, MULTI_NONE)).toEqual({ ok: true });
    expect(checkAnswer(multi, "Remarks\nSalary")).toMatchObject({ ok: false, reason: expect.stringMatching(/"Salary" is not one of/) });
    expect(multiChoices(MULTI_NONE)).toEqual([]);
    expect(toStored(multi, "Remarks\nAbsent")).toEqual(["Remarks", "Absent"]);
  });
  it("number: a number inside its bounds", () => {
    const q: PiQuestion = { id: "n", prompt: "Threshold?", kind: "number", min: 0, max: 24 };
    expect(checkAnswer(q, "9.5")).toEqual({ ok: true });
    expect(checkAnswer(q, "nine")).toMatchObject({ ok: false });
    expect(checkAnswer(q, "25")).toMatchObject({ ok: false, reason: expect.stringMatching(/at most 24/) });
    expect(toStored(q, "1,000")).toBe(1000);
  });
  it("date and period: real ones only", () => {
    expect(checkAnswer({ id: "d", prompt: "p", kind: "date" }, "2026-02-28")).toEqual({ ok: true });
    expect(checkAnswer({ id: "d", prompt: "p", kind: "date" }, "2026-02-30")).toMatchObject({ ok: false });
    expect(checkAnswer({ id: "m", prompt: "p", kind: "period" }, "2026-08")).toEqual({ ok: true });
    expect(checkAnswer({ id: "m", prompt: "p", kind: "period" }, "2026-13")).toMatchObject({ ok: false });
  });
  it("an empty answer is refused for every kind", () => {
    expect(checkAnswer({ id: "q", prompt: "p" }, "  ")).toMatchObject({ ok: false });
  });
});
