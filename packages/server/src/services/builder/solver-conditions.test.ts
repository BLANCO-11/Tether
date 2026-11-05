/**
 * Phase C, C5 — a goal's condition on ONE value becomes a Decide, and "these go here, the rest go there" becomes a Split, placed by
 * the solver through the engine's own moves (`decideOps` / `splitOps`, the canvas's same functions) on the neutral synthetic
 * catalogue. And the controls: a value the goal does not state is dropped by name; `rest:` exists only for a split; a split's other
 * rows are its rest, never an `otherwise`.
 */
import { describe, expect, it } from "vitest";
import { checkState, decideTest, emptyFlow, errorsOf, renderType, splitSide, SYNTHETIC, type CatalogueSnapshot, type EFlow, type Ty } from "@foundry/flow-edit";
import { solve } from "./solver.js";
import { checkSpec, readback, type BuilderCatalogue, type GoalSpec } from "./goal-spec.js";
import type { Wiring } from "./wiring.js";

const cat = SYNTHETIC;
const fieldsOf = (r: CatalogueSnapshot["refs"][string]) => (r.kind === "tool" ? [] : Object.entries((r.payload as { of: { fields: Record<string, Ty> } }).of.fields).map(([name, t]) => ({ name, ty: renderType(t) })));
const ITEMS: BuilderCatalogue = { items: Object.entries(cat.refs).map(([ref, r]) => ({ ref, kind: r.kind === "tool" ? ("tool" as const) : ("reader" as const), about: ref, params: r.params.map((p) => ({ name: p.name, about: "" })), fields: fieldsOf(r), ...(r.modelText ? { modelText: true } : {}) })) };
type S = EFlow["steps"][number];

const spec = (goal: string, sinks: GoalSpec["sinks"], values: GoalSpec["values"]): GoalSpec => ({
  sources: [{ ref: "store.widgets", quote: "check the widgets as of today" }], sinks,
  values: [{ role: "date", from: "flow_input", quote: "today", fills: "store.widgets.as_of" }, ...values],
  conditions: [], schedule: { cron: "0 9 * * *", quote: "Every day at 9" }, missing: null,
});
const build = (goal: string, s: GoalSpec, w: Wiring) => {
  const checked = checkSpec({ ...s, wiring: w }, [goal], ITEMS);
  return { checked, r: solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [] }) };
};
const calls = (f: EFlow) => f.steps.filter((s): s is Extract<S, { kind: "tool" }> => s.kind === "tool");
const reads = (f: EFlow, id: string) => JSON.stringify((f.steps.find((s) => s.id === id) as Extract<S, { kind: "tool" }>).inputs.map((b) => b.source));

const DECIDE_GOAL = `Every day at 9, check the widgets as of today. If more than 5 are late, post them to #alerts; otherwise post "all clear" to #ops.`;
const DECIDE = spec(DECIDE_GOAL, [{ ref: "chat_post", quote: "post them to #alerts" }, { ref: "chat_post", quote: `post "all clear" to #ops` }], [
  { role: "channel", from: "goal", quote: "#alerts", fills: "chat_post.channel" },
  { role: "channel", from: "goal", quote: "#ops", fills: "chat_post.channel" },
  { role: "text", from: "goal", quote: "all clear", fills: "chat_post.text" },
]);
const DECIDE_W: Wiring = {
  paths: [{ quote: "If more than 5 are late", subject: "reader:0", test: "compare", measure: "count", cmp: "gt", value: "5" }],
  actions: [{ takes: "reader:0", path: 0, approve: null }, { takes: "nothing", path: "otherwise", approve: null }],
  valueAction: { 1: 0, 2: 1, 3: 1 },
};

describe("a goal's condition on ONE value is a Decide (phase C, D-371)", () => {
  it("“if more than 5 …, otherwise …”: a count test ahead of its condition, the otherwise after it — checks clean", () => {
    const { checked, r } = build(DECIDE_GOAL, DECIDE, DECIDE_W);
    expect(checked.dropped).toEqual([]);
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
    const cond = r.flow.steps.find((s) => s.kind === "branch" && !s.elseOf)!;
    const test = decideTest(r.flow, (cond as Extract<S, { kind: "branch" }>).conditions![0]!.left.stepId)!;
    expect(test).toMatchObject({ subject: "read_1", before: [{ op: "count", as: "n" }], where: { cmp: "gt", left: { field: "n" }, right: { lit: { value: 5, from: "goal", quote: "5" } } } });
    expect(r.flow.steps.some((s) => s.kind === "branch" && s.elseOf === cond.id && !s.conditions?.length)).toBe(true);
    // Each post is on its own path.
    const [alerts, ops] = calls(r.flow);
    expect(alerts!.dependsOn).toContain(cond.id);
    expect(ops!.dependsOn.some((d) => r.flow.steps.find((s) => s.id === d)?.kind === "branch" && d !== cond.id)).toBe(true);
    expect(readback(checked, ITEMS)).toContain("When: the number of store.widgets is more than 5 — for “If more than 5 are late”");
  });
  it("the same build again finds its Decide rather than doubling it", () => {
    const { checked, r } = build(DECIDE_GOAL, DECIDE, DECIDE_W);
    const again = solve(r.flow, { spec: checked, cat, answers: new Map(), base: [] });
    expect(again.flow.steps.filter((s) => s.kind === "branch").length).toBe(r.flow.steps.filter((s) => s.kind === "branch").length);
    expect(again.flow.steps.filter((s) => s.kind === "transform").length).toBe(r.flow.steps.filter((s) => s.kind === "transform").length);
  });
  it("CONTROL: a value the goal does not state is dropped by name, never placed", () => {
    const { checked, r } = build(DECIDE_GOAL, DECIDE, { ...DECIDE_W, paths: [{ ...DECIDE_W.paths[0]!, value: "50" }] });
    expect(checked.dropped.map((d) => d.why)).toContain("the value “50” is not in the goal");
    expect(r.flow.steps.some((s) => s.kind === "transform" && s.pipeline.some((c) => c.op === "keep_if"))).toBe(false);
  });
});

const SPLIT_GOAL = `Every day at 9, check the widgets as of today. Post the widgets with a qty over 30 to #alerts, and the rest to #ops.`;
const SPLIT = spec(SPLIT_GOAL, [{ ref: "chat_post", quote: "Post the widgets with a qty over 30 to #alerts" }, { ref: "chat_post", quote: "the rest to #ops" }], [
  { role: "channel", from: "goal", quote: "#alerts", fills: "chat_post.channel" },
  { role: "channel", from: "goal", quote: "#ops", fills: "chat_post.channel" },
]);
const SPLIT_W: Wiring = {
  paths: [{ quote: "the widgets with a qty over 30", subject: "reader:0", test: "split", measure: "qty", cmp: "gt", value: "30" }],
  actions: [{ takes: "reader:0", path: 0, approve: null }, { takes: "unsaid", path: "rest:0", approve: null }],
  valueAction: { 1: 0, 2: 1 },
};

describe("“these go here, the rest go there” is a Split (phase C, D-373)", () => {
  it("one split: each post on its own side, each taking ITS side's rows — no hand-written complement", () => {
    const { checked, r } = build(SPLIT_GOAL, SPLIT, SPLIT_W);
    expect(checked.dropped).toEqual([]);
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
    const m = splitSide(r.flow, "matched_1")!, rest = splitSide(r.flow, "rest_1")!;
    expect(m).toMatchObject({ side: "matched", pair: "rest_1", subject: "read_1" });
    expect(rest.side).toBe("rest");
    const [alerts, ops] = calls(r.flow);
    expect(alerts!.dependsOn).toContain(m.branchId);
    expect(ops!.dependsOn).toContain(rest.branchId);
    expect(reads(r.flow, alerts!.id)).toContain('"stepId":"matched_1"');
    expect(reads(r.flow, ops!.id)).toContain('"stepId":"rest_1"');
    expect(reads(r.flow, ops!.id)).not.toContain('"stepId":"matched_1"');
    expect(readback(checked, ITEMS)).toContain("“the rest to #ops” — the rest (not “the widgets with a qty over 30”)");
  });
  it("a nullable field states its null rule, so a row with no value goes to the rest (D-372, D-374)", () => {
    const goal = SPLIT_GOAL.replace("qty", "weight");
    const s = { ...SPLIT, sinks: SPLIT.sinks.map((x, i) => (i ? x : { ...x, quote: x.quote.replace("qty", "weight") })) };
    const { r } = build(goal, s, { ...SPLIT_W, paths: [{ ...SPLIT_W.paths[0]!, quote: "the widgets with a weight over 30", measure: "weight" }] });
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
    expect(splitSide(r.flow, "matched_1")!.where).toMatchObject({ and: [{ notNull: "weight" }, { cmp: "gt" }] });
  });
  it("CONTROLS: `rest:` names only a split; a split's other rows are its rest, never an otherwise", () => {
    const a = build(DECIDE_GOAL, DECIDE, { ...DECIDE_W, actions: [DECIDE_W.actions[0]!, { takes: "nothing", path: "rest:0", approve: null }] });
    expect(a.checked.dropped.map((d) => d.why)).toContain("that is not a split that was kept — only a split has a rest");
    const b = build(SPLIT_GOAL, SPLIT, { ...SPLIT_W, actions: [SPLIT_W.actions[0]!, { takes: "unsaid", path: "otherwise", approve: null }] });
    expect(b.checked.dropped.map((d) => d.why)).toContain("a split's other rows are its rest (`rest:`), not an otherwise");
  });
});

describe("a shape the condition makes is the condition's, not built twice (phase C)", () => {
  it("a split's halves written by hand as shapes are not built — the split's generated rest is the only complement", () => {
    const s: GoalSpec = { ...SPLIT, shapes: [
      { over: "store.widgets", stages: [{ op: "filter", quote: "the widgets with a qty over 30", field: "store.widgets.qty", test: "above", value: "30" }] },
      { over: "store.widgets", stages: [{ op: "filter", quote: "the rest", field: "store.widgets.qty", test: "at_most", value: "30" }] },
    ] } as GoalSpec;
    const { checked, r } = build(SPLIT_GOAL, s, { ...SPLIT_W, actions: [{ takes: "list:0", path: 0, approve: null }, { takes: "list:1", path: "rest:0", approve: null }] });
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
    expect(r.flow.steps.filter((x) => x.kind === "transform").map((x) => x.id).sort()).toEqual(["matched_1", "rest_1"]);
    const [alerts, ops] = calls(r.flow);
    expect(reads(r.flow, alerts!.id)).toContain('"stepId":"matched_1"');
    expect(reads(r.flow, ops!.id)).toContain('"stepId":"rest_1"');
    expect(r.unmet).toEqual([]);
    expect(checked.dropped).toEqual([]);
  });
  it("a total compared by its value: the stages after the total (the comparison, restated) are cut; the Decide tests the total", () => {
    const goal = `Every day at 9, check the widgets as of today. If the total qty is over 20, post "busy" to #ops.`;
    const s = spec(goal, [{ ref: "chat_post", quote: `post "busy" to #ops` }], [
      { role: "channel", from: "goal", quote: "#ops", fills: "chat_post.channel" }, { role: "text", from: "goal", quote: "busy", fills: "chat_post.text" }]);
    const shaped = { ...s, shapes: [{ over: "store.widgets", stages: [
      { op: "group", quote: "the total qty", by: [], measures: [{ fn: "sum", field: "store.widgets.qty" }] },
      { op: "filter", quote: "over 20", field: null, test: "above", value: "20" },
    ] }] } as unknown as GoalSpec;
    const { r } = build(goal, shaped, { paths: [{ quote: "If the total qty is over 20", subject: "list:0", test: "compare", measure: "value", cmp: "gt", value: "20" }], actions: [{ takes: "nothing", path: 0, approve: null }] });
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
    expect(r.unmet).toEqual([]);
    const list = r.flow.steps.find((x) => x.kind === "transform" && x.pipeline.some((c) => c.op === "summarize"))!;
    expect((list as Extract<S, { kind: "transform" }>).pipeline.map((c) => c.op)).toEqual(["summarize"]);
    const cond = r.flow.steps.find((x) => x.kind === "branch")! as Extract<S, { kind: "branch" }>;
    expect(decideTest(r.flow, cond.conditions![0]!.left.stepId)).toMatchObject({ subject: list.id });
  });
});

describe("a total written with its condition as a shape (phase C): cut to the total, built once, the Decide on it", () => {
  it("“more than 20 …” and its “otherwise” as two lists ending in a filter after a total: one total, one Decide, no unbuilt stage", () => {
    const goal = `Every day at 9, check the widgets as of today. If more than 20 widgets are heavy, post "busy" to #ops; otherwise post "quiet" to #ops.`;
    const s = spec(goal, [{ ref: "chat_post", quote: `post "busy" to #ops` }, { ref: "chat_post", quote: `otherwise post "quiet" to #ops` }], [
      { role: "channel", from: "goal", quote: "#ops", fills: "chat_post.channel" }, { role: "text", from: "goal", quote: "busy", fills: "chat_post.text" }, { role: "text", from: "goal", quote: "quiet", fills: "chat_post.text" }]);
    const total = (test: string, quote: string) => ({ over: "store.widgets", stages: [
      { op: "filter", quote: "heavy", field: "store.widgets.qty", test: "above", value: "20" },
      { op: "group", quote: "widgets", by: [], measures: [{ fn: "count", field: null }] },
      { op: "filter", quote, field: "stage:1:0", test, value: "20" },
    ] });
    const shaped = { ...s, shapes: [total("above", "more than 20 widgets"), total("at_most", "otherwise")] } as unknown as GoalSpec;
    const { checked, r } = build(goal, shaped, { paths: [{ quote: "If more than 20 widgets are heavy", subject: "list:0", test: "compare", measure: "count", cmp: "gt", value: "20" }],
      actions: [{ takes: "nothing", path: 0, approve: null }, { takes: "nothing", path: "otherwise", approve: null }], valueAction: { 0: 0, 1: 0, 2: 1 } });
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
    expect(r.unmet).toEqual([]);
    const totals = r.flow.steps.filter((x) => x.kind === "transform" && x.pipeline.some((c) => c.op === "summarize"));
    expect(totals).toHaveLength(1);
    const cond = r.flow.steps.find((x) => x.kind === "branch" && !x.elseOf)! as Extract<S, { kind: "branch" }>;
    const test = decideTest(r.flow, cond.conditions![0]!.left.stepId)!;
    expect(test.subject).toBe(totals[0]!.id);
    expect(test.before).toEqual([]); // the number itself, not a count of the one-record total
    expect(readback(checked, ITEMS).filter((l) => l.startsWith("Then")).length).toBe(2); // the filter and the total — said once, no restated stage
  });
});

describe("a value compared on a reader's rows is the one total made over them; a Decide's value is a value used (phase C)", () => {
  it("“the total qty is over 20” named on the reader resolves to its total, and the stated threshold is not left unmet", () => {
    const goal = `Every day at 9, check the widgets as of today. If the total qty is over 20, post "busy" to #ops.`;
    const s = spec(goal, [{ ref: "chat_post", quote: `post "busy" to #ops` }], [
      { role: "channel", from: "goal", quote: "#ops", fills: "chat_post.channel" }, { role: "text", from: "goal", quote: "busy", fills: "chat_post.text" },
      { role: "threshold", from: "goal", quote: "over 20", fills: "none" }]);
    const shaped = { ...s, shapes: [{ over: "store.widgets", stages: [{ op: "group", quote: "the total qty", by: [], measures: [{ fn: "sum", field: "store.widgets.qty" }] }] }] } as unknown as GoalSpec;
    const { checked, r } = build(goal, shaped, { paths: [{ quote: "If the total qty is over 20", subject: "reader:0", test: "compare", measure: "value", cmp: "gt", value: "20" }], actions: [{ takes: "nothing", path: 0, approve: null }] });
    expect(checked.dropped.map((d) => d.why)).toContain("those rows have no one value to compare — the total over them is list:0");
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
    expect(r.unmet).toEqual([]);
    expect(r.flow.steps.some((x) => x.kind === "branch")).toBe(true);
  });
});

describe("the chat says a condition as it is built — never “if the list has rows” for a comparison (phase C)", () => {
  it("a Decide reads as its comparison; its test step is not work on the rows", async () => {
    const { describeFlow, aboutFlow } = await import("./chat-answers.js");
    const { r } = build(DECIDE_GOAL, DECIDE, DECIDE_W);
    const said = describeFlow(r.flow, ITEMS, cat);
    expect(said).toContain("If the number of rows is more than 5, it posts it to #alerts. Otherwise, it posts “all clear” to #ops.");
    expect(said).not.toMatch(/counts the rows|the list has rows/);
    expect(aboutFlow(r.flow, ITEMS, cat).join("\n")).toContain("Works out what the next condition tests (the number of rows is more than 5)");
  });
  it("a Split reads as its rows and the rest", async () => {
    const { describeFlow } = await import("./chat-answers.js");
    const { r } = build(SPLIT_GOAL, SPLIT, SPLIT_W);
    const said = describeFlow(r.flow, ITEMS, cat);
    expect(said).toContain("For the rows where qty is more than 30, it posts it to #alerts. For the rest, it posts it to #ops.");
    expect(said).not.toMatch(/filters the rows|the list has rows/);
  });
});

describe("a count spelled as a key-less group of one count is the same count (phase C)", () => {
  it("superseded like a `count` stage — no stray total beside the Decide", () => {
    const s = { ...DECIDE, shapes: [{ over: "store.widgets", stages: [{ op: "group", quote: "more than 5 are late", by: [], measures: [{ fn: "count", field: null }] }] }] } as unknown as GoalSpec;
    const { r } = build(DECIDE_GOAL, s, DECIDE_W);
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
    expect(r.flow.steps.filter((x) => x.kind === "transform").map((x) => x.id)).toEqual(["test_1"]);
  });
});

describe("a shape's stages after its total ARE a comparison, and the comparison is a condition's (phase C)", () => {
  // "count them, then keep the count above 5" — the model's other way of writing “more than 5”. Cut after the total, it is a count.
  const tailed = (field: string | null) => ({ ...DECIDE, shapes: [{ over: "store.widgets", stages: [
    { op: "group", quote: "more than 5 are late", by: [], measures: [{ fn: "count", field }] },
    { op: "filter", quote: "more than 5 are late", field: "stage:0:0", test: "above", value: "5" },
  ] }] }) as unknown as GoalSpec;
  const counted = (field: string, quote: string) => ({ ...DECIDE, shapes: [{ over: "store.widgets", stages: [
    { op: "group", quote, by: [], measures: [{ fn: "count", field }] },
  ] }] }) as unknown as GoalSpec;
  const W = (paths: Wiring["paths"], takes = "list:0"): Wiring => ({ ...DECIDE_W, paths, actions: [{ takes: takes as never, path: 0, approve: null }, DECIDE_W.actions[1]!] });
  const post = (f: EFlow) => calls(f)[0]!.id;

  it("a count of a field that is never null is the count of the rows: superseded AS CUT, so “post them” posts the rows, not the number", () => {
    const { r } = build(DECIDE_GOAL, tailed("store.widgets.code"), W(DECIDE_W.paths));
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
    expect(r.flow.steps.filter((x) => x.kind === "transform").map((x) => x.id)).toEqual(["test_1"]);
    expect(reads(r.flow, post(r.flow))).toContain("read_1");
  });
  it("a count of a field that may be null, in the condition's OWN words, is the condition's count — no stray total (2026-09-30)", () => {
    const { r } = build(DECIDE_GOAL, counted("store.widgets.owner_email", "more than 5 are late"), W(DECIDE_W.paths, "reader:0"));
    expect(r.flow.steps.filter((x) => x.kind === "transform").map((x) => x.id)).toEqual(["test_1"]);
  });
  it("CONTROL: a count of a field that may be null, in OTHER words of the goal, is its own total — not the condition's", () => {
    const { r } = build(DECIDE_GOAL, counted("store.widgets.owner_email", "check the widgets"), W(DECIDE_W.paths, "reader:0"));
    // Its own total, which nothing here reads: not built as a dead step (2026-10-01), and — unlike the condition's own count above,
    // which is silently the condition's — STATED, because the goal's words for it are then done by nothing.
    expect(r.flow.steps.filter((x) => x.kind === "transform").map((x) => x.id)).toEqual(["test_1"]);
    expect(r.unmet).toContain("the list “check the widgets” is read by no action, so nothing built does it");
    expect(build(DECIDE_GOAL, counted("store.widgets.owner_email", "more than 5 are late"), W(DECIDE_W.paths, "reader:0")).r.unmet.filter((u) => u.includes("read by no action"))).toEqual([]);
  });
  it("words a BUILT read carries out (`covered`) are done by that read — its list is not stated unbuilt (2026-10-02, H07)", () => {
    const s = { ...counted("store.widgets.owner_email", "check the widgets"), covered: [{ quote: "check the widgets as of today", by: "store.widgets" }] };
    expect(build(DECIDE_GOAL, s, W(DECIDE_W.paths, "reader:0")).r.unmet.filter((u) => u.includes("read by no action"))).toEqual([]);
    // CONTROL: words covered by a read that was NOT built are still stated.
    const t = { ...counted("store.widgets.owner_email", "check the widgets"), covered: [{ quote: "check the widgets as of today", by: "store.other" }] };
    expect(build(DECIDE_GOAL, t, W(DECIDE_W.paths, "reader:0")).r.unmet).toContain("the list “check the widgets” is read by no action, so nothing built does it");
  });
  it("a condition that only asks “has rows” over those rows takes the tail's comparison — a Decide, never the threshold dropped", () => {
    const { checked, r } = build(DECIDE_GOAL, tailed(null), W([{ quote: "If more than 5 are late", subject: "reader:0", test: "any" }], "reader:0"));
    expect(checked.dropped.map((d) => d.why).join(" ")).toContain("states the comparison");
    const cond = r.flow.steps.find((s) => s.kind === "branch" && !s.elseOf) as Extract<S, { kind: "branch" }>;
    expect(decideTest(r.flow, cond.conditions![0]!.left.stepId)).toMatchObject({ subject: "read_1", before: [{ op: "count", as: "n" }], where: { cmp: "gt", right: { lit: { value: 5 } } } });
    expect(r.unmet ?? []).toEqual([]);
  });
  it("“has none” of the tail's comparison is its opposite", () => {
    const { r } = build(DECIDE_GOAL, tailed(null), W([{ quote: "If more than 5 are late", subject: "reader:0", test: "none" }], "reader:0"));
    const cond = r.flow.steps.find((s) => s.kind === "branch" && !s.elseOf) as Extract<S, { kind: "branch" }>;
    expect(decideTest(r.flow, cond.conditions![0]!.left.stepId)?.where).toMatchObject({ cmp: "le" });
  });
  it("CONTROL: a condition that states its own comparison keeps it — the tail changes nothing", () => {
    const { checked } = build(DECIDE_GOAL, tailed(null), W(DECIDE_W.paths));
    expect(checked.dropped.map((d) => d.why).join(" ")).not.toContain("states the comparison");
  });
});

describe("a goal's condition on a FIELD of the rows is a row test — some row passes (2026-09-30: `if read1.name == \"blanco\"`)", () => {
  const GOAL = `Every day at 9, check the widgets as of today. If any widget is in state Blanco, post them to #alerts; else if any widget has code ID1, post them to #ops.`;
  const S = spec(GOAL, [{ ref: "chat_post", quote: "post them to #alerts" }, { ref: "chat_post", quote: "post them to #ops" }], [
    { role: "channel", from: "goal", quote: "#alerts", fills: "chat_post.channel" },
    { role: "channel", from: "goal", quote: "#ops", fills: "chat_post.channel" },
  ]);
  const W: Wiring = {
    paths: [
      { quote: "If any widget is in state Blanco", subject: "reader:0", test: "compare", measure: "state", cmp: "eq", value: "Blanco" },
      { quote: "else if any widget has code ID1", subject: "reader:0", test: "compare", measure: "code", cmp: "eq", value: "ID1" },
    ],
    actions: [{ takes: "reader:0", path: 0, approve: null }, { takes: "reader:0", path: 1, approve: null }],
    valueAction: { 1: 0, 2: 1 },
  };
  it("an IF and an ELSE IF, each a filter on its field and the has-rows condition on it; each post takes the whole list", () => {
    const { checked, r } = build(GOAL, S, W);
    expect(checked.dropped).toEqual([]);
    expect(r.unmet ?? []).toEqual([]);
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
    const head = r.flow.steps.find((s) => s.kind === "branch" && !s.elseOf) as Extract<S, { kind: "branch" }>;
    const elif = r.flow.steps.find((s) => s.kind === "branch" && s.elseOf === head.id) as Extract<S, { kind: "branch" }>;
    expect(decideTest(r.flow, head.conditions![0]!.left.stepId)).toMatchObject({ subject: "read_1", anyRow: true, where: { cmp: "eq", left: { field: "state" }, right: { lit: { value: "Blanco", from: "goal" } } } });
    expect(decideTest(r.flow, elif.conditions![0]!.left.stepId)).toMatchObject({ anyRow: true, where: { left: { field: "code" }, right: { lit: { value: "ID1" } } } });
    const [a, o] = calls(r.flow);
    expect(a!.dependsOn).toContain(head.id);
    expect(o!.dependsOn).toContain(elif.id);
    expect(readback(checked, ITEMS)).toContain("When: at least one of the rows of store.widgets passes “state is Blanco” — for “If any widget is in state Blanco”");
  });
});

describe("an if / else-if whose words are each a value filter tests THAT filter's rows, not the reader (UAT 2026-09-30)", () => {
  // The model's own wiring, 3 of 3 rounds: two filters, each email taking its filter's rows — and both links asking "has rows" of
  // the READER, so the IF always held and the ELSE IF never ran.
  const GOAL = `Every day at 9, check the widgets as of today. If any of them is in state Blanco, post them to #alerts; else if any of them has code ID1, post them to #ops.`;
  const S: GoalSpec = {
    ...spec(GOAL, [{ ref: "chat_post", quote: "post them to #alerts" }, { ref: "chat_post", quote: "post them to #ops" }], [
      { role: "channel", from: "goal", quote: "#alerts", fills: "chat_post.channel" },
      { role: "channel", from: "goal", quote: "#ops", fills: "chat_post.channel" },
    ]),
    shapes: [
      { over: "store.widgets", stages: [{ op: "filter", quote: "is in state Blanco", field: "store.widgets.state", test: "equals", value: "Blanco" }] },
      { over: "store.widgets", stages: [{ op: "filter", quote: "has code ID1", field: "store.widgets.code", test: "equals", value: "ID1" }] },
    ] as never,
  };
  const W: Wiring = {
    paths: [{ quote: "If any of them is in state Blanco", subject: "reader:0", test: "any" }, { quote: "else if any of them has code ID1", subject: "reader:0", test: "any" }],
    actions: [{ takes: "list:0", path: 0, approve: null }, { takes: "list:1", path: 1, approve: null }],
    valueAction: { 1: 0, 2: 1 },
  };
  it("each link tests its own filter, stated; each post takes that filter's rows on its own path", () => {
    const { checked, r } = build(GOAL, S, W);
    expect(checked.spec.wiring!.paths.map((p) => p.subject)).toEqual(["list:0", "list:1"]);
    expect(checked.dropped.filter((d) => d.why.includes("it tests those rows"))).toHaveLength(2);
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
    const head = r.flow.steps.find((s) => s.kind === "branch" && !s.elseOf) as Extract<S, { kind: "branch" }>;
    const elif = r.flow.steps.find((s) => s.kind === "branch" && s.elseOf === head.id) as Extract<S, { kind: "branch" }>;
    const where = (id: string) => JSON.stringify((r.flow.steps.find((s) => s.id === id) as Extract<S, { kind: "transform" }>).pipeline);
    expect(where(head.conditions![0]!.left.stepId)).toContain("Blanco");
    expect(where(elif.conditions![0]!.left.stepId)).toContain("ID1");
    const [a, o] = calls(r.flow);
    expect(a!.dependsOn).toContain(head.id);
    expect(o!.dependsOn).toContain(elif.id);
  });
  it("chat says which rows each link asks about — never \"the list has rows\" twice in one chain", async () => {
    const { describeFlow } = await import("./chat-answers.js");
    const said = describeFlow(build(GOAL, S, W).r.flow, ITEMS, cat);
    // RC-5 (2026-10-05): the flow carries the goal's own words beside each test — they are preferred over the structure.
    expect(said).toContain("If there are rows where “is in state Blanco”,");
    expect(said).toContain("Otherwise, if there are rows where “has code ID1”,");
    expect(said).not.toContain("the list has rows");
  });
  it("CONTROL: words that hold no one filter's words stay on the reader (\"If there are any\")", () => {
    const { checked } = build(`${GOAL} If there are any, say so.`, S, { ...W, paths: [{ quote: "If there are any", subject: "reader:0", test: "any" }, W.paths[1]!] });
    expect(checked.spec.wiring!.paths[0]!.subject).toBe("reader:0");
  });
});
