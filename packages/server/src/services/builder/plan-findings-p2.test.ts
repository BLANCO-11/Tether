/**
 * P2 — three plan rules enforced in code: quote fidelity (fragment-wise), always-gating, clause→on linkage.
 */
import { describe, expect, it } from "vitest";
import { clauses, planFindings, type Plan } from "./plan.js";
import type { BuilderCatalogue } from "./goal-spec.js";

const CAT: BuilderCatalogue = { items: [
  { ref: "ds.items", kind: "reader", about: "items", fields: [{ name: "amount", ty: "number" }] },
  { ref: "tether_email_send", kind: "tool", about: "email", params: [{ name: "to", about: "" }] },
  { ref: "chat_post_message", kind: "tool", about: "post", params: [{ name: "text", about: "" }] },
] };
const GOAL = "for each overdue item: if the amount is over 100 email a@b.example, otherwise post it";
const CS = clauses(GOAL);
const email = (on: Plan["actions"][number]["on"], extra: Partial<Plan["actions"][number]> = {}): Plan["actions"][number] =>
  ({ ref: "tether_email_send", clauses: ["C2"], on, per_item: true, approve_first: null, heading: "Overdue", message: "", recipient: { from: "goal", words: "a@b.example" }, ...extra });
const post = (on: Plan["actions"][number]["on"]): Plan["actions"][number] =>
  ({ ref: "chat_post_message", clauses: ["C3"], on, per_item: true, approve_first: null, heading: "All clear", message: "", recipient: { from: "goal", words: "" } });
const base = (p: Partial<Plan>): Plan => ({ sources: [{ ref: "ds.items", clauses: ["C1"], quote: "for each overdue item", also: [] }], each: { over: 0, clauses: ["C1"] }, rows: [], schedule: null, conditions: [], actions: [], values: [], missing: "", joining: [], ...p });
const clean = (): Plan => base({
  conditions: [{ quote: "if the amount is over 100", clauses: ["C2"], over: "each_item", where: [{ field: "ds.items.amount", about: "", test: "above", value: "100" }], count: null }],
  actions: [email("if:0", { quote: "email a@b.example" }), post("otherwise")],
});

describe("P2 — plan rules enforced in code", () => {
  it("a fabricated quote is flagged", () => {
    const p = clean();
    p.sources[0]!.quote = "the borrower contact list";
    expect(planFindings(p, CS, CAT).join(" ")).toMatch(/source 0 quote.*not the goal's words verbatim/);
  });

  it("`always` with no schedule/regardless words is flagged", () => {
    const p = clean();
    p.actions[0] = email("always", { quote: "email a@b.example" });
    expect(planFindings(p, CS, CAT).join(" ")).toMatch(/runs `always` but the goal states no regardless\/schedule words/);
  });

  it("an action on a nonexistent condition is flagged; an earlier-clause action on a later condition is flagged", () => {
    const p = clean();
    p.actions[0] = email("if:3" as Plan["actions"][number]["on"], { quote: "email a@b.example" });
    expect(planFindings(p, CS, CAT).join(" ")).toMatch(/runs on condition 3, which does not exist/);
    const q = clean();
    q.conditions[0]!.clauses = ["C3"];
    q.actions[0] = email("if:0", { quote: "email a@b.example", clauses: ["C1"] });
    expect(planFindings(q, CS, CAT).join(" ")).toMatch(/earlier clause than condition 0/);
  });


  it("CONTROL: the clean plan raises none of the three", () => {
    const f = planFindings(clean(), CS, CAT).join(" ");
    expect(f).not.toMatch(/not the goal's words verbatim/);
    expect(f).not.toMatch(/runs `always`/);
    expect(f).not.toMatch(/earlier clause/);
  });

  it("a fused goal+answer quote passes with the answer words in scope (the live iteration)", () => {
    const p = clean();
    p.sources[0]!.quote = "for each overdue item past its due date";
    expect(planFindings(p, CS, CAT).join(" ")).toMatch(/not the goal's words verbatim/);
    expect(planFindings(p, CS, CAT, ["past its due date and unpaid"]).join(" ")).not.toMatch(/not the goal's words verbatim/);
  });
  it("2026-10-06: a whole-goal quote with sentence-final dots passes — clause-splitting eats them, the words are the goal's", () => {
    const goal = "calculate absence days for each employee. half day absence equals atleast 4.75 hours worked. return halfday absence and total absences.";
    const cs = clauses(goal);
    const p = base({ sources: [{ ref: "ds.items", clauses: ["C1"], quote: goal, also: [] }] });
    expect(planFindings(p, cs, CAT).join(" ")).not.toMatch(/not the goal's words verbatim/);
  });
  it("S3: a genuinely loose paraphrase still fails — anchoring forgives form, never rewording", () => {
    const p = clean();
    p.sources[0]!.quote = "staff with low attendance";
    expect(planFindings(p, CS, CAT).join(" ")).toMatch(/source 0 quote.*not the goal's words verbatim/);
  });
});
