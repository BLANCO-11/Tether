/** A written read's contract is fixed by code from the person's words (phase 1). Name-free: `ds`, `t`. */
import { describe, expect, it } from "vitest";
import { contractText, readContract } from "./read-contract.js";
import type { GoalSpec } from "./goal-spec.js";

const spec = (values: GoalSpec["values"], sources: GoalSpec["sources"] = [{ ref: "ds.new_read", quote: "the rows" }]): GoalSpec =>
  ({ sources, sinks: [], values, conditions: [], schedule: null, missing: null });
const v = (role: GoalSpec["values"][number]["role"], quote: string, fills = "none"): GoalSpec["values"][number] => ({ role, from: "goal", quote, fills });

describe("readContract — the parameters are code's, from the person's words", () => {
  it("a calendar month is ONE month parameter; a day is a date", () => {
    expect(readContract(spec([v("period", "august 2026")]), "ds.new_read", []).params).toEqual([{ name: "period", type: "month", words: "august 2026", value: 0 }]);
    expect(readContract(spec([v("date", "30 june 2026")]), "ds.new_read", []).params[0]).toMatchObject({ name: "as_of", type: "date" });
  });
  it("numbers and text take their role's name, numbered when repeated; each keeps its words and its value index", () => {
    const c = readContract(spec([v("threshold", "more than 10"), v("threshold", "less than 2"), v("other", "sick leave")]), "ds.new_read", []);
    expect(c.params.map((p) => [p.name, p.type, p.value])).toEqual([["threshold", "number", 0], ["threshold_2", "number", 1], ["value", "text", 2]]);
    expect(c.words).toEqual(["the rows", "more than 10", "less than 2", "sick leave"]);
  });
  it("CONTROL: an action's values (recipient, channel, subject, text) and values filling another component are never parameters", () => {
    const c = readContract(spec([v("recipient", "them"), v("channel", "#ops"), v("text", "hello"), v("threshold", "5", "other.reader.min")]), "ds.new_read", []);
    expect(c.params).toEqual([]);
  });
  it("CONTROL: a requester or asked value is not the person's stated words — no parameter is made from it", () => {
    expect(readContract(spec([{ role: "period", from: "flow_input", quote: "each month", fills: "none" }]), "ds.new_read", []).params).toEqual([]);
  });
  it("names are stable across a revision: the same words give the same names", () => {
    const a = readContract(spec([v("period", "august 2026"), v("threshold", "3")]), "ds.new_read", []);
    const b = readContract(spec([v("period", "august 2026"), v("threshold", "3")]), "ds.new_read", ["by days I mean working days"]);
    expect(a.params.map((p) => p.name)).toEqual(b.params.map((p) => p.name));
  });
  it("the contract text states every parameter, its type, and the address when one is required", () => {
    const t = contractText(readContract(spec([v("period", "august 2026")]), "ds.new_read", [], "their managers"));
    expect(t).toMatch(/"period": a MONTH/);
    expect(t).toMatch(/ADDRESS.*“their managers”/);
    expect(contractText(readContract(spec([]), "ds.new_read", []))).toMatch(/NO parameters/);
  });
});

describe("contractFindings — a proposal is held to its contract", async () => {
  const { contractFindings } = await import("./read-contract.js");
  const c = readContract(spec([v("period", "august 2026"), v("threshold", "3")]), "ds.new_read", []);
  it("the contract's parameters, of the right types, pass", () => {
    expect(contractFindings(c, { period: { type: "string", format: "date", per: "month" }, threshold: { type: "number" } })).toEqual([]);
  });
  it("a parameter left out, one invented, and one of the wrong type are each refused by name", () => {
    const f = contractFindings(c, { period: { type: "string", format: "date" }, min_days: { type: "integer" } });
    expect(f.join("\n")).toMatch(/"period".*is a MONTH/);
    expect(f.join("\n")).toMatch(/"threshold".*is not used/);
    expect(f.join("\n")).toMatch(/"min_days" is not a parameter of the contract/);
  });
  it("CONTROL: a contract with no parameters refuses any parameter, and accepts none", () => {
    const none = readContract(spec([]), "ds.new_read", []);
    expect(contractFindings(none, {})).toEqual([]);
    expect(contractFindings(none, { x: { type: "string" } })).toHaveLength(1);
  });
});

describe("applyContract — the spec after the read is written, by code", async () => {
  const { applyContract } = await import("./read-contract.js");
  const s: GoalSpec = { ...spec([v("period", "august 2026"), v("recipient", "them")]), conditions: [{ quote: "who took sick leave", by: "ds.new_read" }], unclear: [{ quote: "sick leave", about: "data" }, { quote: "the usual way", about: "data" }] };
  s.sources = [{ ref: "ds.new_read", quote: "the rows of people who took sick leave" }];
  const c = readContract(s, "ds.new_read", []);
  const out = applyContract(s, "ds.new_read", "ds.query.leave", c, []);
  it("the choice becomes the read; each parameter's value fills it", () => {
    expect(out.sources[0]!.ref).toBe("ds.query.leave");
    expect(out.values.filter((x) => x.quote === "august 2026").map((x) => x.fills)).toEqual(["ds.query.leave.period"]);
    expect(out.values.find((x) => x.role === "recipient")!.fills).toBe("none");
    expect(out.conditions[0]!.by).toBe("ds.query.leave");
  });
  it("the read's words are covered; words it owns are no longer asked — words it does not own still are", () => {
    expect(out.covered!.map((x) => x.quote)).toContain("the rows of people who took sick leave");
    expect(out.unclear!.map((u) => u.quote)).toEqual(["the usual way"]);
  });
  it("CONTROL: what the read reports it could not give is not covered", () => {
    const left = applyContract(s, "ds.new_read", "ds.query.leave", c, ["the rows of people who took sick leave"]);
    expect(left.covered!.map((x) => x.quote)).not.toContain("the rows of people who took sick leave");
  });
});

describe("readContract — the columns the rest of the spec reads (2026-10-02)", () => {
  it("the columns the rest of the spec names on the read are the contract's, and a read without one is refused by name", async () => {
    const { contractFindings } = await import("./read-contract.js");
    const s: GoalSpec = { ...spec([]), conditions: [{ quote: "if over budget", by: "the_flow", field: "ds.new_read.spend", test: "above", value: "its budget" }] };
    const c = readContract(s, "ds.new_read", []);
    expect(c.fields).toEqual([{ name: "spend", words: "if over budget" }]);
    expect(contractText(c)).toMatch(/RETURNS these columns[\s\S]*"spend" — for “if over budget”/);
    expect(contractFindings(c, {}, ["spend", "name"])).toEqual([]);
    expect(contractFindings(c, {}, ["total"])).toEqual([expect.stringMatching(/column "spend".*is not returned/)]);
  });
});

describe("readContract — a parameter is a value its words can BE (2026-10-02, H05, L02)", () => {
  it("a threshold or count with no number in its words is not a parameter; with one it is", () => {
    const c = readContract(spec([v("count", "every"), v("threshold", "high risk"), v("threshold", "less than 2 days")]), "ds.new_read", []);
    expect(c.params.map((p) => [p.name, p.words])).toEqual([["threshold", "less than 2 days"]]);
  });
});
