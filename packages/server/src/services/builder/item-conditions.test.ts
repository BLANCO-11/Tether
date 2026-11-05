/**
 * builder-behaviour P1 (R10, R6, R5): a condition on EACH item states every test the plan gives — several tests all holding, a yes/no
 * test, a test against another field or a run input — lowered by the list filters' own lowering into ONE test on the item; an action
 * whose condition was not kept is unmet, never run for every item; a per-item fact the written read must return is a column of its
 * contract. Real solver, real engine, the neutral synthetic catalogue. Every rule has a control (the switch off, or the old form).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkState, emptyFlow, errorsOf, renderType, SYNTHETIC, TypeOf as T, type CatalogueSnapshot, type EFlow, type Ty } from "@foundry/flow-edit";
import { itemTestOf, solve } from "./solver.js";
import { checkSpec, readback, type BuilderCatalogue, type GoalSpec } from "./goal-spec.js";
import type { Wiring } from "./wiring.js";
import { readContract } from "./read-contract.js";
import { lowerPipelinesWith } from "../flow-pipeline.js";
import { fieldTyIn, specMatch } from "./spec-match.js";
import { clauses, planToSpec, type Plan } from "./plan.js";

const on = () => { process.env.BUILDER_INPUTS = "1"; };
const off = () => { delete process.env.BUILDER_INPUTS; };

const MAIL = SYNTHETIC.refs.mail_send!;
const cat: CatalogueSnapshot = { ...SYNTHETIC, refs: { ...SYNTHETIC.refs, mail_send: { ...MAIL, params: MAIL.params.map((p) => (p.name === "body" ? { ...p, message: true } : p)) } } };
const fieldsOf = (r: CatalogueSnapshot["refs"][string]) => (r.kind === "tool" ? [] : Object.entries((r.payload as { of: { fields: Record<string, Ty> } }).of.fields).map(([name, t]) => ({ name, ty: renderType(t) })));
const ITEMS: BuilderCatalogue = { items: Object.entries(cat.refs).map(([ref, r]) => ({ ref, kind: r.kind === "tool" ? ("tool" as const) : ("reader" as const), about: ref, params: r.params.map((p) => ({ name: p.name, about: "", ...(p.message ? { message: true } : {}) })), fields: fieldsOf(r) })) };
type S = EFlow["steps"][number];

const GOAL = `Every day at 9, check the widgets as of today. For each widget, if its qty is over 30 and it is active open a high priority ticket "Big order"; otherwise email its owner "Your widget".`;
const SPEC: GoalSpec = {
  sources: [{ ref: "store.widgets", quote: "check the widgets as of today" }],
  sinks: [{ ref: "ticket_open", quote: `open a high priority ticket "Big order"` }, { ref: "mail_send", quote: `email its owner "Your widget"` }],
  values: [
    { role: "date", from: "flow_input", quote: "today", fills: "store.widgets.as_of" },
    { role: "other", from: "goal", quote: "high", fills: "ticket_open.priority" },
    { role: "subject", from: "goal", quote: "Big order", fills: "ticket_open.title" },
    { role: "recipient", from: "goal", quote: "its owner", fills: "mail_send.to" },
    { role: "subject", from: "goal", quote: "Your widget", fills: "mail_send.subject" },
  ],
  conditions: [], schedule: { cron: "0 9 * * *", quote: "Every day at 9" }, missing: null,
};
const wiring = (path: Wiring["paths"][number]): Wiring => ({
  each: { quote: "For each widget", over: "reader:0" },
  paths: [path],
  actions: [{ takes: "item", path: 0, approve: null, per: "item" }, { takes: "item", path: "otherwise", approve: null, per: "item" }],
});
const build = (w: Wiring, spec: GoalSpec = SPEC, goal = GOAL) => {
  const checked = checkSpec({ ...spec, wiring: w }, [goal], ITEMS);
  return { checked, r: solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [], drafts: "propose" }) };
};
const itemTestStep = (f: EFlow) => {
  const cond = f.steps.find((s): s is Extract<S, { kind: "branch" }> => s.kind === "branch" && !s.elseOf);
  return cond ? f.steps.find((s): s is Extract<S, { kind: "transform" }> => s.id === cond.conditions![0]!.left.stepId) : undefined;
};
const BOTH = { quote: "if its qty is over 30 and it is active", subject: "item" as const, test: "compare" as const, measure: "qty", cmp: "gt" as const, value: "30",
  where: [{ field: "qty", test: "above", value: "30" }, { field: "active", test: "is_true" }] };

describe("every test of the item, held together (R10)", () => {
  beforeEach(on); afterEach(off);
  it("two tests are ONE test on the item, both holding; CONTROL: the one-compare form keeps the first only", () => {
    const { checked, r } = build(wiring(BOTH));
    expect(checked.dropped).toEqual([]);
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
    expect(itemTestStep(r.flow)?.pipeline).toEqual([{ op: "keep_if", where: { and: [
      { cmp: "gt", left: { field: "qty" }, right: { lit: expect.objectContaining({ value: 30 }) } },
      { cmp: "eq", left: { field: "active" }, right: { lit: expect.objectContaining({ value: true }) } },
    ] } }]);
    expect(readback(checked, ITEMS)).toContain("When, for each item: its qty is above 30 and its active is true — for “if its qty is over 30 and it is active”");
    const { where: _, ...one } = BOTH;
    const old = build(wiring(one));
    expect(JSON.stringify(itemTestStep(old.r.flow)?.pipeline)).not.toContain("active");
  });
  it("a yes/no test has no value and is kept; CONTROL: in the one-compare form it is dropped", () => {
    const yes = { quote: "if it is active", subject: "item" as const, test: "compare" as const, measure: "active", where: [{ field: "active", test: "is_true" }] };
    const goal = GOAL.replace("if its qty is over 30 and it is active", "if it is active");
    const { checked, r } = build(wiring(yes), SPEC, goal);
    expect(checked.dropped).toEqual([]);
    expect(itemTestStep(r.flow)?.pipeline).toEqual([{ op: "keep_if", where: { cmp: "eq", left: { field: "active" }, right: { lit: expect.objectContaining({ value: true }) } } }]);
    const { where: _, ...one } = yes;
    expect(build(wiring(one), SPEC, goal).checked.dropped.map((d) => d.why).join(" ")).toMatch(/does not say what (the value is compared with|is compared)|how the value is compared/);
  });
  it("against another field of the item, narrowed when it may be empty", () => {
    const vs = { quote: "if its weight is above its qty", subject: "item" as const, test: "compare" as const, where: [{ field: "weight", test: "above", against: "qty" }] };
    const { checked, r } = build(wiring(vs), SPEC, GOAL.replace("if its qty is over 30 and it is active", "if its weight is above its qty"));
    expect(checked.dropped).toEqual([]);
    expect(itemTestStep(r.flow)?.pipeline).toEqual([{ op: "keep_if", where: { and: [{ notNull: "weight" }, { cmp: "gt", left: { field: "weight" }, right: { field: "qty" } }] } }]);
  });
  it("against a run input given each time: declared, and read by the item's test", () => {
    const spec: GoalSpec = { ...SPEC, schedule: null, inputs: [{ id: "in_a", kind: "number", words: "a number I give", fill: "each_run", at: "flow" }] };
    const vs = { quote: "if its qty is below a number I give", subject: "item" as const, test: "compare" as const, where: [{ field: "qty", test: "below", input: "in_a" }] };
    const goal = `For each widget, if its qty is below a number I give open a high priority ticket "Big order"; otherwise email its owner "Your widget". check the widgets as of today`;
    const { checked, r } = build(wiring(vs), spec, goal);
    expect(checked.dropped).toEqual([]);
    expect(r.flow.inputs.filter((i) => !i.computed).map((i) => [i.id, i.type])).toEqual(expect.arrayContaining([["number", "FLOAT"]]));
    expect(JSON.stringify(itemTestStep(r.flow)?.pipeline)).toContain(`"input":"number"`);
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
  });
});

describe("the translation check reads an item's tests from what runs (R10)", () => {
  beforeEach(on); afterEach(off);
  it("every test is wanted and found; NEGATIVE CONTROL: a lowering comparing with another value is refused", () => {
    const { checked, r } = build(wiring(BOTH));
    const model = lowerPipelinesWith(r.flow as never, cat) as never as Parameters<typeof specMatch>[0];
    const stored = { goalSpec: { spec: checked.spec }, trace: { base: [] } };
    expect(specMatch(model, stored, undefined, fieldTyIn(cat.refs))).toEqual([]);
    const perturbed = { ...model, steps: model.steps.map((s) => (s.expr ? { ...s, expr: s.expr.replace("(.qty > 30)", "(.qty > 31)") } : s)) };
    expect(JSON.stringify(perturbed)).toContain("(.qty > 31)");
    expect(specMatch(perturbed, stored, undefined, fieldTyIn(cat.refs)).join(" ")).toMatch(/`qty` > 30 .* no step of the flow applies that/);
  });
});

describe("an action whose condition was not kept is unmet — never run for every item (R6, B15)", () => {
  it("switch on: the action is not placed and the build says why; CONTROL: off, it ran for every item in silence", () => {
    const bad = { quote: "if it is shiny", subject: "item" as const, test: "compare" as const, where: [{ field: "shiny", test: "is_true" }] };
    const goal = GOAL.replace("if its qty is over 30 and it is active", "if it is shiny");
    on();
    const a = build(wiring(bad), SPEC, goal);
    expect(a.checked.dropped.some((d) => /shiny/.test(d.why))).toBe(true);
    expect(a.r.unmet.join(" ")).toMatch(/should happen only when “if it is shiny”, and that condition was not built/);
    expect(a.r.flow.steps.some((s) => s.kind === "tool" && s.ref === "ticket_open")).toBe(false);
  });
});

describe("one item's test, by code (itemTestOf)", () => {
  it("a yes/no test of a COUNT: yes is more than none, no is none — an empty count is none; CONTROL: a missing field is said", () => {
    const fields = { interviews: T.option(T.int()) };
    expect(itemTestOf([{ field: "interviews", test: "is_true" }], fields, "q")).toEqual([{ op: "keep_if", where: { and: [{ notNull: "interviews" }, { cmp: "gt", left: { field: "interviews" }, right: { lit: expect.objectContaining({ value: 0 }) } }] } }]);
    expect(itemTestOf([{ field: "interviews", test: "is_false" }], fields, "q")).toEqual([{ op: "keep_if", where: { or: [{ isNull: "interviews" }, { and: [{ notNull: "interviews" }, { cmp: "le", left: { field: "interviews" }, right: { lit: expect.objectContaining({ value: 0 }) } }] }] } }]);
    expect(itemTestOf([{ field: "nope", test: "is_true" }], fields, "q")).toMatch(/no field `nope`/);
  });
});

describe("a fact about each item the written read must return (R5)", () => {
  beforeEach(on); afterEach(off);
  const CAT: BuilderCatalogue = { items: [
    { ref: "ds.new_read", kind: "reader", about: "a new read" },
    { ref: "foundry_email_send", kind: "tool", about: "email", params: [{ name: "to", about: "" }] },
  ] };
  const G = "for each offer, if the candidate has an interview scheduled email me, otherwise email me too";
  const CS = clauses(G);
  const plan: Plan = {
    sources: [{ ref: "ds.new_read", clauses: ["C1"] }], each: { over: 0, clauses: ["C1"] }, rows: [], schedule: null,
    conditions: [{ clauses: [CS[1]?.id ?? "C1"], over: "each_item", where: [{ field: "new_read", about: "whether the candidate has an interview scheduled", test: "is_true", value: "" }], count: null }],
    actions: [{ ref: "foundry_email_send", clauses: ["C1"], on: "if:0", per_item: true, approve_first: null, recipient: { from: "requester", words: "me" } }],
    values: [], missing: "", joining: [],
  };
  it("is named by code and is a column of the read's contract; CONTROL: off, it is stated unbuilt and the contract has no such column", () => {
    const { spec } = planToSpec(plan, CS, CAT, G);
    const item = spec.wiring?.paths.find((p) => p.subject === "item");
    expect(item?.where).toEqual([{ field: "whether_the_candidate_has_an_interview_s", test: "is_true", about: "whether the candidate has an interview scheduled" }]);
    expect(spec.planGaps ?? []).toEqual([]);
    const c = readContract(spec, "ds.new_read", [G]);
    expect(c.fields?.map((f) => f.name)).toContain("whether_the_candidate_has_an_interview_s");
    expect(c.fields?.find((f) => f.name.startsWith("whether"))?.words).toMatch(/interview scheduled — for each row; a count of the related rows/);
  });
});

describe("a test on a table field of the written read's datasource is the read's own test (R20, B10)", () => {
  afterEach(off);
  const CAT: BuilderCatalogue = { items: [
    { ref: "ds.new_read", kind: "reader", about: "a new read" },
    { ref: "ds.table.main.days", kind: "reader", about: "days", fields: [{ name: "hours", ty: "Number" }, { name: "on", ty: "Date" }] },
  ] };
  const G = "the days with less than 8 hours";
  const CS = clauses(G);
  const plan: Plan = {
    sources: [{ ref: "ds.new_read", clauses: ["C1"] }], each: null, schedule: null, conditions: [], actions: [], values: [], missing: "", joining: [],
    rows: [{ clauses: ["C1"], field: "ds.table.main.days.hours", about: "", test: "below", value: "8" }],
  };
  it("its value is a parameter of the read; CONTROL: off, the test VANISHED — no filter, no parameter (the root cause, measured)", () => {
    on();
    const { spec } = planToSpec(plan, CS, CAT, G);
    expect(spec.shapes ?? []).toEqual([]);
    expect(readContract(spec, "ds.new_read", [G]).params.map((p) => [p.name, p.type])).toEqual([["threshold", "number"]]);
  });
});

describe("the read accounts for ITS words — never another part's (R7, B15/B17)", () => {
  afterEach(off);
  const G = "for each contract ending soon, if it auto renews email the owner a heads up, otherwise raise a ticket for legal";
  const spec: GoalSpec = {
    sources: [{ ref: "ds.new_read", quote: G }], sinks: [{ ref: "mail", quote: "email the owner a heads up" }, { ref: "ticket", quote: "raise a ticket for legal" }],
    values: [], conditions: [], schedule: null, missing: null,
    wiring: { each: { quote: "for each contract", over: "reader:0" }, paths: [{ quote: "if it auto renews", subject: "item", test: "compare", where: [{ field: "auto_renew", test: "is_true" }] }], actions: [] },
  };
  it("words an action, or a test the flow applies, carries are not in its list; CONTROL: off, they are", async () => {
    const { readNeed } = await import("./builder.service.js");
    on();
    const c = readContract(spec, "ds.new_read", [G]);
    expect(c.owned).toEqual(expect.arrayContaining(["email the owner a heads up", "raise a ticket for legal", "if it auto renews"]));
    const need = readNeed([G], [G], c);
    const list = /Account for EACH of these words[^:]*: (.*)\./.exec(need)![1]!;
    expect(list).toContain("contract");
    expect(list).not.toMatch(/“(email|ticket|legal|heads|owner|renews)”/);
  });
});

describe("a chain of conditions on a written read's rows is tested by the flow, each its own (R21, B17)", () => {
  afterEach(off);
  const CAT: BuilderCatalogue = { items: [
    { ref: "ds.new_read", kind: "reader", about: "a new read" },
    { ref: "ds.table.main.readings", kind: "reader", about: "readings", fields: [{ name: "temperature", ty: "Number" }, { name: "battery", ty: "Number" }] },
    { ref: "ticket", kind: "tool", about: "ticket", params: [{ name: "title", about: "" }] },
    { ref: "mail", kind: "tool", about: "mail", params: [{ name: "to", about: "" }] },
  ] };
  const G = "look at the readings: if any device was above 80 degrees raise a ticket, else if any battery was under 20% email me";
  const CS = clauses(G);
  const plan: Plan = {
    sources: [{ ref: "ds.new_read", clauses: [CS[0]!.id] }], each: null, rows: [], schedule: null, values: [], missing: "", joining: [],
    conditions: [
      { quote: "if any device was above 80 degrees", clauses: [CS[1]?.id ?? "C1"], over: "any_row", where: [{ field: "ds.table.main.readings.temperature", about: "", test: "above", value: "80" }], count: null },
      { quote: "else if any battery was under 20%", clauses: [CS.at(-1)!.id], over: "any_row", where: [{ field: "ds.table.main.readings.battery", about: "", test: "below", value: "20" }], count: null },
    ],
    actions: [
      { ref: "ticket", clauses: [CS[1]?.id ?? "C1"], on: "if:0", per_item: false, approve_first: null, recipient: { from: "unsaid", words: "" } },
      { ref: "mail", clauses: [CS.at(-1)!.id], on: "if:1", per_item: false, approve_first: null, recipient: { from: "requester", words: "me" } },
    ],
  };
  it("each condition is its own list over the read, and the read returns what they test; CONTROL: off, the read is never told to return them", () => {
    on();
    const { spec } = planToSpec(plan, CS, CAT, G);
    const tested = (spec.shapes ?? []).map((sh) => sh.stages.map((st) => `${st.field} ${st.test} ${st.value}`));
    expect(tested).toEqual([["ds.new_read.temperature above 80"], ["ds.new_read.battery below 20"]]);
    expect(spec.wiring?.paths.map((x) => x.subject)).toEqual(["list:0", "list:1"]);
    const c = readContract(spec, "ds.new_read", [G]);
    expect(c.fields?.map((f) => f.name).sort()).toEqual(["battery", "temperature"]);
    expect(c.params).toEqual([]);
  });
});

describe("a read's parameter is a value the person STATED (B21)", () => {
  afterEach(off);
  const CAT: BuilderCatalogue = { items: [{ ref: "ds.new_read", kind: "reader", about: "a new read" }] };
  const G = "each open requisition with no applications";
  const CS = clauses(G);
  const plan = (value: string): Plan => ({
    sources: [{ ref: "ds.new_read", clauses: ["C1"] }], each: null, schedule: null, conditions: [], actions: [], values: [], missing: "", joining: [],
    rows: [{ clauses: ["C1"], field: "new_read", about: "number of applications", test: "equals", value }],
  });
  it("“no applications” written as 0 is the read's own rule, never asked; CONTROL: a number the goal says is a parameter", () => {
    on();
    expect(readContract(planToSpec(plan("0"), CS, CAT, G).spec, "ds.new_read", [G]).params).toEqual([]);
    const G2 = "each open requisition with 3 applications", CS2 = clauses(G2);
    expect(readContract(planToSpec(plan("3"), CS2, CAT, G2).spec, "ds.new_read", [G2]).params.map((p) => p.type)).toEqual(["text"]);
  });
});

describe("once the read is written, every part that refers to it follows it (B17)", () => {
  it("the flow's lists over it and their fields name the written read; CONTROL: the source alone was renamed before", async () => {
    const { applyContract } = await import("./read-contract.js");
    const spec: GoalSpec = {
      sources: [{ ref: "ds.new_read", quote: "the readings" }], sinks: [], values: [], conditions: [], schedule: null, missing: null,
      shapes: [{ over: "ds.new_read", stages: [{ op: "filter", quote: "above 80", field: "ds.new_read.temperature", test: "above", value: "80" }] }],
    };
    const after = applyContract(spec, "ds.new_read", "ds.query.readings_for_alerts", { params: [], words: [] }, []);
    expect(after.sources[0]!.ref).toBe("ds.query.readings_for_alerts");
    expect(after.shapes).toEqual([{ over: "ds.query.readings_for_alerts", stages: [expect.objectContaining({ field: "ds.query.readings_for_alerts.temperature" })] }]);
  });
});

describe("a test of each item with no for-each is a finding (B22)", () => {
  it("names the forms that fit; CONTROL: with a for-each, none", async () => {
    const { inputFindings } = await import("./plan.js");
    const base: Plan = { sources: [{ ref: "ds.r", clauses: ["C1"] }], each: null, rows: [], schedule: null, actions: [], values: [], missing: "", joining: [],
      conditions: [{ quote: "the departments below 7 hours", clauses: ["C1"], over: "each_item", where: [{ field: "ds.r.h", about: "", test: "below", value: "7" }], count: null }] };
    expect(inputFindings(base).join(" ")).toMatch(/tests each item, and the goal has no for-each — .*`any_row`.*`rest:0`/);
    expect(inputFindings({ ...base, each: { over: 0, clauses: ["C1"] } }).join(" ")).not.toMatch(/no for-each/);
  });
});

describe("a waiting question captures only an ANSWER (R11)", () => {
  it("`answer` is a kind only while a question waits, and the question is in view; CONTROL: with none waiting, no `answer`", async () => {
    const { routeKinds, routePrompt, routeSchema } = await import("./chat-route.js");
    expect(routeKinds(true, true)).toContain("answer");
    expect(routeKinds(true)).not.toContain("answer");
    expect(routeKinds(false, true)).toEqual(["build", "capabilities", "chat", "answer", "accept", "discard"]);
    const prompt = routePrompt("send the email to x@y.example instead", true, "What should the opened at be?");
    expect(prompt).toMatch(/THE BUILDER JUST ASKED\nWhat should the opened at be\?/);
    expect(JSON.stringify(routeSchema(true, true))).toContain('"answer"');
    expect(routePrompt("hi", true)).not.toMatch(/JUST ASKED/);
  });
});

describe("chat never asks a person for an input's internal name (R8, E07)", () => {
  afterEach(off);
  it("“ask for a value each run” is not offered from chat; CONTROL: off, it was", async () => {
    const { editable } = await import("./chat-edit.js");
    const f = emptyFlow("t");
  });
});

describe("a typed reply that is an option's label chooses it (E03)", () => {
  it("“Yes, do it” confirms, “No, leave it” cancels; CONTROL: other words are kept as said", async () => {
    const { choiceOf, CONFIRM, CANCEL } = await import("./chat-edit.service.js");
    const p = { kind: "confirm" as const, message: "remove the chat post", key: { where: { at: "step", stepId: "call_2" } } } as never;
    expect(choiceOf(p, "Yes, do it")).toBe(CONFIRM);
    expect(choiceOf(p, "no, leave it")).toBe(CANCEL);
    expect(choiceOf(p, "maybe later")).toBe("maybe later");
  });
});

describe("an input given in the goal, compared per item, is used (E08)", () => {
  beforeEach(on); afterEach(off);
  it("the build is complete, the item's test reads its value; CONTROL: an input nothing reads is still unmet", () => {
    const spec: GoalSpec = { ...SPEC, schedule: null, inputs: [{ id: "in_a", kind: "number", words: "30", fill: "given", at: "flow" }] };
    const goal = `For each widget, if its qty is below 30 open a high priority ticket "Big order"; otherwise email its owner "Your widget". check the widgets as of today`;
    const vs = { quote: "if its qty is below 30", subject: "item" as const, test: "compare" as const, where: [{ field: "qty", test: "below", input: "in_a" }] };
    const { r } = build(wiring(vs), spec, goal);
    expect(r.unmet.filter((u) => /used by nothing/.test(u))).toEqual([]);
    expect(JSON.stringify(itemTestStep(r.flow)?.pipeline)).toContain('"value":30');
    const unused = build(wiring({ ...vs, where: [{ field: "qty", test: "below", value: "30" }] }), { ...spec, inputs: [{ id: "in_b", kind: "number", words: "7", fill: "given", at: "flow" }] }, goal);
    expect(unused.r.unmet.join(" ")).toMatch(/the input “7” is used by nothing built/);
  });
});

describe("an `otherwise` with nothing to be the alternative to is unmet — never run always (R6, B22)", () => {
  afterEach(off);
  it("not placed, and said; CONTROL: off, it was placed to run every time", () => {
    const w: Wiring = { paths: [], actions: [{ takes: "item", path: "otherwise", approve: null }, { takes: "item", path: "otherwise", approve: null }] };
    on();
    const a = build(w);
    expect(a.r.unmet.join(" ")).toMatch(/should happen otherwise \(when none of the conditions holds\), and no condition was built/);
    expect(a.r.flow.steps.some((s) => s.kind === "tool")).toBe(false);
  });
});
