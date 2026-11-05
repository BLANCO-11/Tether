/** A for-each's own words decide its list — by code (2026-10-01). Name-free: `r`, `t1`. */
import { describe, expect, it } from "vitest";
import { checkWiring, loopOverItsWords, restatedCuts } from "./wiring.js";
import { inDomain, type BuilderCatalogue, type GoalSpec } from "./goal-spec.js";

const filter = (quote: string, field: string) => ({ op: "filter" as const, quote, field, test: "equals" as const, value: "x" });
const spec = (each: string, over: string, shapes: GoalSpec["shapes"], takes = "item"): GoalSpec => ({
  sources: [{ ref: "r", quote: "rows" }], sinks: [{ ref: "t1", quote: "send" }], values: [], conditions: [], schedule: null, missing: null,
  shapes, wiring: { paths: [], each: { quote: each, over: over as never }, actions: [{ takes: takes as never, path: null, approve: null, per: "item" }] },
});

describe("loopOverItsWords", () => {
  const EACH = "for each open widget that was due before the first and has not shipped";
  const three = [{ over: "r", stages: [filter("open widget", "r.s")] }, { over: "r", stages: [filter("due before the first", "r.d")] }, { over: "r", stages: [filter("has not shipped", "r.p")] }];
  it("a loop over the raw rows whose words carry three one-filter lists runs over ONE list of all three, in order", () => {
    const out = loopOverItsWords(spec(EACH, "reader:0", three));
    expect(out.shapes).toEqual([{ over: "r", stages: three.flatMap((s) => s.stages) }]);
    expect(out.wiring!.each!.over).toBe("list:0");
  });
  it("a list an action already reads is not taken, and later list keys move down to stay pointed at their list", () => {
    const shapes = [three[0]!, { over: "r", stages: [filter("the late ones", "r.l")] }, three[2]!];
    const out = loopOverItsWords({ ...spec(EACH, "reader:0", shapes), wiring: { paths: [], each: { quote: EACH, over: "reader:0" }, actions: [{ takes: "list:1", path: null, approve: null }] } });
    expect(out.shapes!.map((s) => s.stages.map((x) => x.quote))).toEqual([["open widget", "has not shipped"], ["the late ones"]]);
    expect(out.wiring!.each!.over).toBe("list:0");
    expect(out.wiring!.actions[0]!.takes).toBe("list:1");
  });
  it("CONTROL: a list whose words the loop does not say, or one that totals, is left alone", () => {
    const other = [{ over: "r", stages: [filter("the blue ones", "r.c")] }, { over: "r", stages: [{ op: "group" as const, quote: "open widget", by: [], measures: [] }] }];
    const s = spec(EACH, "reader:0", other as never);
    expect(loopOverItsWords(s)).toBe(s);
  });
});

describe("a word that is a FORM of one known value names it — the same reading as a port's (2026-10-01)", () => {
  const CAT: BuilderCatalogue = { items: [{ ref: "r", kind: "reader", about: "", fields: [{ name: "kind", ty: "Text", values: ["Intern", "Contractor", "Annual Leave", "Leave"] }] }] };
  it("CONTROL: words that name no value are outside, with the real values to ask with", () => {
    expect(inDomain(CAT, "r.kind", "volunteers")).toEqual({ outside: ["Intern", "Contractor", "Annual Leave", "Leave"] });
  });
});

describe("a has-rows / has-none condition tests the ROWS — a trailing count of that list is cut (P5-I7)", () => {
  const rows = (paths: Array<{ test: "any" | "none" | "compare"; subject: `list:${number}` }>, last: object): GoalSpec => ({
    sources: [{ ref: "r", quote: "rows" }], sinks: [], values: [], conditions: [], schedule: null, missing: null,
    shapes: [{ over: "r", stages: [filter("open urgent", "r.s"), last as never] }],
    wiring: { paths: paths.map((p) => ({ quote: "if any", ...p })), actions: [] },
  });
  const COUNT = { op: "count", quote: "any" };
  const GROUPED = { op: "group", quote: "any", by: [], measures: [{ fn: "count", as: "n" }] };
  it("“if any … has an open urgent ticket” keeps the list: a count after it is the condition's own question", () => {
    expect(restatedCuts(rows([{ test: "any", subject: "list:0" }], COUNT)).get(0)).toBe(1);
    expect(restatedCuts(rows([{ test: "none", subject: "list:0" }], GROUPED)).get(0)).toBe(1);
  });
  it("CONTROL: a count compared to a number stays — that condition asks the count, not the rows", () => {
    expect(restatedCuts(rows([{ test: "compare", subject: "list:0" }], COUNT)).has(0)).toBe(false);
  });
  it("CONTROL: a has-rows test of another list, or a grouped count with keys, cuts nothing", () => {
    expect(restatedCuts(rows([{ test: "any", subject: "list:1" }], COUNT)).has(0)).toBe(false);
    expect(restatedCuts(rows([{ test: "any", subject: "list:0" }], { ...GROUPED, by: ["r.s"] })).has(0)).toBe(false);
  });
});

describe("a per-item test a reader ALREADY applies is not built again (2026-10-01, F02)", () => {
  const C: BuilderCatalogue = { items: [{ ref: "r", kind: "reader", about: "", fields: [{ name: "spend", ty: "Int" }, { name: "budget", ty: "Int" }] }, { ref: "t1", kind: "tool", about: "", params: [] }] };
  const s = (byReader: boolean): GoalSpec => ({
    sources: [{ ref: "r", quote: "each cost centre" }], sinks: [{ ref: "t1", quote: "email its owner" }], values: [], schedule: null, missing: null,
    conditions: byReader ? [{ quote: "if a cost centre is over budget", by: "r" }] : [],
    wiring: { paths: [{ quote: "if a cost centre is over budget", subject: "item", test: "compare", measure: "spend", cmp: "gt", value: "budget" }], each: { quote: "each cost centre", over: "reader:0" }, actions: [{ takes: "item", path: 0, approve: null, per: "item" }] },
  });
  it("dropped, stated — the action runs for every item the reader gives", () => {
    const r = checkWiring(s(true).wiring, s(true), () => true, C);
    expect(r.wiring!.paths).toEqual([]);
    expect(r.wiring!.actions[0]!.path).toBeNull();
    expect(r.dropped.map((d) => d.why)).toContain("the reader already gives only those rows — every item holds it");
  });
  it("CONTROL: a per-item test no reader applies is the flow's to build", () => {
    const r = checkWiring(s(false).wiring, s(false), () => true, C);
    expect(r.dropped.map((d) => d.why)).not.toContain("the reader already gives only those rows — every item holds it");
  });
});

describe("a message beside a FILE that carries the data is kept (2026-10-04: the rows went in the body, 379 KB, refused)", () => {
  const C: BuilderCatalogue = { items: [{ ref: "r", kind: "reader", about: "", fields: [{ name: "n", ty: "Int" }] }, { ref: "t1", kind: "tool", about: "", params: [
    { name: "subject", about: "", heading: true }, { name: "body", about: "", message: true },
    { name: "rows", about: "", fromStep: true }, { name: "format", about: "", needs: "rows" },
  ] }] };
  const s = (file: boolean): GoalSpec => ({
    sources: [{ ref: "r", quote: "the loans" }], sinks: [{ ref: "t1", quote: "email me the loans" }], schedule: null, missing: null, conditions: [],
    values: file ? [{ role: "other", from: "goal", quote: "csv", fills: "t1.format" }] : [],
    wiring: { paths: [], actions: [{ takes: "reader:0", path: null, approve: null, drafts: { subject: "Loans", body: "The loans are attached." } }] },
  });
  it("a stated file: the message line is drafted", () => {
    expect(checkWiring(s(true).wiring, s(true), () => true, C).wiring!.actions[0]!.drafts).toEqual({ subject: "Loans", body: "The loans are attached." });
  });
  it("CONTROL: no file — the rows are the message, so a drafted message is dropped", () => {
    const r = checkWiring(s(false).wiring, s(false), () => true, C);
    expect(r.wiring!.actions[0]!.drafts).toEqual({ subject: "Loans" });
    expect(r.dropped.map((d) => d.why)).toContain("this action carries data, so that is its content, not a draft");
  });
});

describe("a read applies a condition only when its words HOLD the condition's (2026-10-04)", () => {
  const C: BuilderCatalogue = { items: [{ ref: "r", kind: "reader", about: "", fields: [{ name: "n", ty: "Int" }] }, { ref: "t1", kind: "tool", about: "", params: [] }] };
  const s = (covered: string): GoalSpec => ({
    sources: [{ ref: "r", quote: covered }], sinks: [{ ref: "t1", quote: "email the branch" }], values: [], schedule: null, missing: null, conditions: [], covered: [{ quote: covered, by: "r" }],
    wiring: { paths: [{ quote: "if a branch has more than 2 late loans", subject: "item", test: "compare", measure: "n", cmp: "gt", value: "2" }], each: { quote: "for each branch", over: "reader:0" }, actions: [{ takes: "item", path: 0, approve: null, per: "item" }] },
  });
  const why = "the reader already gives only those rows — every item holds it";
  it("a read of “loans” does not apply “if a branch has more than 2 late loans”", () => {
    expect(checkWiring(s("loans").wiring, s("loans"), () => true, C).dropped.map((d) => d.why)).not.toContain(why);
  });
  it("CONTROL: a read whose words hold the condition does", () => {
    const sp = s("branches if a branch has more than 2 late loans");
    expect(checkWiring(sp.wiring, sp, () => true, C).dropped.map((d) => d.why)).toContain(why);
  });
});
