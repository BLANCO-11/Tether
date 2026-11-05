/** The corpus scorer answers only as the conversation and the shared defaults say — never for the person (P5-I1). */
import { describe, expect, it } from "vitest";
import { answerFor, goalMonth, modelParts, runInputsFor, verdict, type Conversation, type Outcome } from "./score.js";

const conv = (x: Partial<Conversation> = {}): Conversation => ({ id: "T", workspace: "W", kinds: [], goal: "check august 2026 sick leave", replies: [], expect: { outcome: "complete", maxQuestions: 2 }, ...x });
const outcome = (x: Partial<Outcome> = {}): Outcome => ({ id: "T", workspace: "W", status: "complete", questions: 0, calls: 1, seconds: 1, asked: [], unmet: [], readback: [], ...x });

describe("the scripted person", () => {
  it("answers from its own replies first, each reply once while another matches", () => {
    const c = conv({ replies: [{ when: "who", say: "a@x.example" }, { when: "who", say: "b@x.example" }] });
    const used = new Set<number>();
    expect(answerFor({ holeId: "h", ask: "Who should get it?" }, c, used).say).toBe("a@x.example");
    expect(answerFor({ holeId: "h", ask: "Who should get it?" }, c, used).say).toBe("b@x.example");
  });
  it("the shared defaults: assumptions → yes, a recipient → the ops address, a month → the goal's month", () => {
    const used = new Set<number>();
    expect(answerFor({ holeId: "a", ask: "By “x” I took y. Is that what you mean?" }, conv(), used)).toEqual({ say: "yes", by: "default:assumptions" });
    expect(answerFor({ holeId: "r", ask: "Who should receive the email?" }, conv(), used).by).toBe("default:recipient");
    expect(answerFor({ holeId: "m", ask: "Which month should it read?", options: ["the month it runs"] }, conv(), used).say).toBe("august 2026");
    expect(answerFor({ holeId: "m", ask: "Which month?", options: ["the month it runs (worked out when it runs)"] }, conv({ goal: "sick leave" }), used).say).toMatch(/^the month it runs/);
  });
  it("CONTROL: anything else is unanswered — never the first option, never a guess", () => {
    const r = answerFor({ holeId: "s", ask: "What should the start date be?", options: ["the day it runs (worked out when it runs)"] }, conv(), new Set());
    expect(r).toEqual({ say: "leave it", by: "unanswered" });
    expect(goalMonth("for the month")).toBeNull();
  });
});

describe("the verdict", () => {
  it("an unanswered question fails the conversation, whatever the build did", () => {
    const o = outcome({ questions: 1, asked: [{ holeId: "s", ask: "What should the start date be?", answer: { say: "leave it", by: "unanswered" } }] });
    expect(verdict(conv(), o).join()).toMatch(/asked what nobody answers/);
  });
  it("expected kinds are read from the saved model — inside arms and loops too", () => {
    const parts = modelParts({ steps: [{ id: "b", kind: "branch", arms: [{ steps: [{ id: "m", kind: "tool", ref: "mail_send" }] }] }, { id: "l", kind: "for_each", body: [{ id: "t", kind: "tool", ref: "ticket_create" }] }] });
    expect(verdict(conv({ expect: { outcome: "complete", maxQuestions: 2, has: ["branch", "email", "loop", "ticket"] } }), outcome({ parts }))).toEqual([]);
    // CONTROL: a kind that is not there is a failure.
    expect(verdict(conv({ expect: { outcome: "complete", maxQuestions: 2, has: ["approval"] } }), outcome({ parts }))).toEqual(["no approval in the flow"]);
  });
  it("a gap must be STATED: built is wrong, and silent is wrong", () => {
    const gap = conv({ expect: { outcome: "gap", maxQuestions: 1 } });
    expect(verdict(gap, outcome({ status: "complete" })).join()).toMatch(/must be a stated gap/);
    expect(verdict(gap, outcome({ status: "cannot" })).join()).toMatch(/without stating the gap/);
    expect(verdict(gap, outcome({ status: "cannot", unmet: ["no salary column"] }))).toEqual([]);
  });
  it("a failed draft run fails; a skipped one (a tool that leaves the stack) does not", () => {
    expect(verdict(conv(), outcome({ run: { state: "FAILED", note: "read=FAILED" } })).join()).toMatch(/draft run FAILED/);
    expect(verdict(conv(), outcome({ run: { state: "skipped", note: "calls foundry_email_send" } }))).toEqual([]);
  });
});

describe("a draft run's open inputs", () => {
  it("take what a real run would have TODAY — never the goal's values — and anything else is named, not guessed", () => {
    const r = runInputsFor([{ id: "as_of", type: "DATE" }, { id: "period", type: "STRING", format: "month" }, { id: "region", type: "STRING" }, { id: "day", type: "DATE", computed: "currentDate" }, { id: "x", type: "INT", defaults: "3" }], {}, new Date("2026-10-01T12:00:00Z"));
    expect(r.inputs).toEqual({ as_of: "2026-10-01", period: "2026-10" });
    expect(r.missing).toEqual(["region"]);
    // CONTROL: a value the conversation gives wins.
    expect(runInputsFor([{ id: "region", type: "STRING" }], { region: "eu" }, new Date()).missing).toEqual([]);
  });
  it("CONTROL: a month default fires only on a month question — not on any question mentioning a month", () => {
    expect(answerFor({ holeId: "u", ask: "I cannot give “x” from this data — it counts every row in the month. What do you mean by it?" }, conv(), new Set()).by).toBe("unanswered");
  });
});

describe("testedText — what a flow tests, wherever it is (2026-10-02)", async () => {
  const { testedText } = await import("./score.js");
  it("comparisons in a filter step, a branch, a written read's filters, a reader's literal input, a saved reader's rule", () => {
    const t = testedText({ steps: [
      { id: "f", kind: "transform", expr: "map(select((.risk == \"high\")))" },
      { id: "b", kind: "branch", conditionExpr: "{{ x }}", test: { left: {}, operator: "gt", right: "5" } },
      { id: "r", kind: "query", ref: "ds.query.w", sqlSpec: { columns: [{ column: "shown_only" }], filters: [{ column: "budget_amount", op: "lt", param: "p" }] } },
      { id: "s", kind: "datasource", ref: "ds.saved", inputs: [{ name: "status", source: { from: "literal", value: "Open" } }] },
    ] }, { "ds.saved": "WHERE plan = 'enterprise'" });
    for (const w of ["risk", "high", "budget", "status=open", "enterprise"]) expect(t).toContain(w);
  });
  it("CONTROL: a field only SHOWN is not tested, and the verdict names the word nobody tests", async () => {
    const { verdict } = await import("./score.js");
    const t = testedText({ steps: [{ id: "r", kind: "query", ref: "ds.query.w", sqlSpec: { columns: [{ column: "budget" }], filters: [] } }] });
    expect(t).not.toContain("budget");
    const c = { id: "x", workspace: "w", goal: "g", replies: [], expect: { outcome: "complete" as const, maxQuestions: 1, tests: ["budget"] } };
    const o = { id: "x", workspace: "w", status: "complete", questions: 0, calls: 1, seconds: 1, asked: [], unmet: [], readback: [], parts: { kinds: [], refs: [], scheduled: false }, tested: t };
    expect(verdict(c as never, o as never)).toEqual(["no step tests “budget”"]);
  });
});

describe("testedText counts only what removes rows (2026-10-02, H07)", async () => {
  const { testedText } = await import("./score.js");
  it("a left join and an action's subject line test nothing; an inner join, a summary's filter and a read's literal do", () => {
    const loose = testedText({ steps: [
      { id: "r", kind: "query", ref: "ds.query.w", sqlSpec: { filters: [], joins: [{ kind: "left", table: "project" }] } },
      { id: "m", kind: "tool", ref: "mail", inputs: [{ name: "subject", source: { from: "literal", value: "Employees not on any project" } }] },
    ] });
    expect(loose).not.toContain("project");
    const tight = testedText({ steps: [
      { id: "r", kind: "query", ref: "ds.query.w", sqlSpec: { filters: [], joins: [{ kind: "inner", table: "project" }], aggregateJoins: [{ table: "absence", filters: [{ column: "type", op: "eq", value: "Sick" }] }] } },
      { id: "q", kind: "datasource", ref: "ds.q", inputs: [{ name: "status", source: { from: "literal", value: "Active" } }] },
    ] });
    // CONTROL: the same words, placed where they choose rows, are counted.
    expect(tight).toContain("project");
    expect(tight).toContain("sick");
    expect(tight).toContain("status=active");
  });

  it("band CASE edges and weights on a written read are tested (not only filters)", () => {
    const t = testedText({ steps: [{
      id: "r", kind: "query", ref: "ds.query.banded",
      sqlSpec: {
        filters: [],
        aggregateJoins: [{
          table: "attendance_day",
          filters: [],
          aggregates: [{
            alias: "half",
            compute: {
              caseWhen: {
                arms: [
                  { op: "gte", right: { number: 9.5 }, then: { number: 0 } },
                  { op: "gte", right: { number: 4.75 }, then: { number: 0.5 } },
                ],
                else: { number: 1 },
              },
            },
          }],
        }],
      },
    }] });
    for (const w of ["9.5", "4.75", "0.5"]) expect(t).toContain(w);
  });
});
