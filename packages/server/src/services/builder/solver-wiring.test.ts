/**
 * Phase Y — the wiring: paths (if / otherwise), what each action takes, values per action, approvals — placed by the solver through
 * the engine's own moves, on the neutral synthetic catalogue. The report's goal (flow `18870d77`) in neutral words: a condition on a
 * list, a post and a summary on it, the summary emailed, and an "otherwise" post of fixed words to another channel (I-310, I-313,
 * I-314). And the controls: no recency choice when unsaid; a wiring claim that points forwards or at nothing is dropped.
 */
import { describe, expect, it } from "vitest";
import { checkState, errorsOf, SYNTHETIC, emptyFlow, type CatalogueSnapshot, type EFlow } from "@foundry/flow-edit";
import { solve } from "./solver.js";
import { checkSpec, readback, type BuilderCatalogue, type GoalSpec } from "./goal-spec.js";
import { checkWiring, wiringFindings, wiringSchema, type Wiring } from "./wiring.js";
import { describeFlow } from "./chat-answers.js";

const cat = SYNTHETIC;
const fieldsOf = (r: CatalogueSnapshot["refs"][string]) => (r.kind === "tool" ? [] : Object.keys((r.payload as { of: { fields: Record<string, unknown> } }).of.fields).map((name) => ({ name, ty: "" })));
const ITEMS: BuilderCatalogue = { items: Object.entries(cat.refs).map(([ref, r]) => ({ ref, kind: r.kind === "tool" ? ("tool" as const) : ("reader" as const), about: ref, params: r.params.map((p) => ({ name: p.name, about: "" })), fields: fieldsOf(r), ...(r.modelText ? { modelText: true } : {}) })) };

const GOAL = `Every day at 9, check the widgets as of today. If there are any, post them to #alerts, write a summary of them and email the summary to ops@acme-corp.com with subject Widgets. If there are none, post "all clear" to #ops.`;
const BASE: GoalSpec = {
  sources: [{ ref: "store.widgets", quote: "check the widgets as of today" }],
  sinks: [
    { ref: "chat_post", quote: "post them to #alerts" },
    { ref: "llm_complete", quote: "write a summary of them" },
    { ref: "mail_send", quote: "email the summary to ops@acme-corp.com" },
    { ref: "chat_post", quote: `post "all clear" to #ops` },
  ],
  values: [
    { role: "date", from: "flow_input", quote: "today", fills: "store.widgets.as_of", relative: "today" },
    { role: "channel", from: "goal", quote: "#alerts", fills: "chat_post.channel" },
    { role: "channel", from: "goal", quote: "#ops", fills: "chat_post.channel" },
    { role: "text", from: "goal", quote: "all clear", fills: "chat_post.text" },
    { role: "recipient", from: "goal", quote: "ops@acme-corp.com", fills: "mail_send.to" },
    { role: "subject", from: "goal", quote: "Widgets", fills: "mail_send.subject" },
  ],
  conditions: [],
  schedule: { cron: "0 9 * * *", quote: "Every day at 9" },
  missing: null,
};
const WIRED: Wiring = {
  paths: [{ quote: "If there are any", subject: "reader:0", test: "any" }],
  actions: [
    { takes: "reader:0", path: 0, approve: null },
    { takes: "reader:0", path: 0, approve: null },
    { takes: "action:1", path: 0, approve: null },
    { takes: "nothing", path: "otherwise", approve: null },
  ],
  valueAction: { 1: 0, 2: 3, 3: 3 },
};
const build = (w?: Wiring, s: GoalSpec = BASE) => {
  const checked = checkSpec({ ...s, ...(w ? { wiring: w } : {}) }, [GOAL], ITEMS);
  return { checked, r: solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [] }) };
};
type S = EFlow["steps"][number];
const src = (f: EFlow, id: string, port: string) => (f.steps.find((s) => s.id === id) as Extract<S, { kind: "tool" }>).inputs.find((b) => b.name === port)?.source;
const calls = (f: EFlow, ref: string) => f.steps.filter((s): s is Extract<S, { kind: "tool" }> => s.kind === "tool" && s.ref === ref);

describe("phase Y — the report's goal, wired", () => {
  it("builds the if / otherwise, each action on its own path, taking what the goal says, and checks clean", () => {
    const { checked, r } = build(WIRED);
    expect(checked.dropped).toEqual([]);
    expect(checked.unaccounted ?? []).toEqual([]); // "If there are any" is the wiring's — not a clause nothing touched
    const f = r.flow;
    expect(errorsOf(checkState(f, cat))).toEqual([]);
    const branches = f.steps.filter((s): s is Extract<S, { kind: "branch" }> => s.kind === "branch");
    expect(branches).toHaveLength(2); // the condition, and its otherwise
    const [cond, otherwise] = branches;
    expect(cond!.conditions).toEqual([expect.objectContaining({ op: "any" })]);
    expect(otherwise!.elseOf).toBe(cond!.id);
    const [alerts, ops] = calls(f, "chat_post");
    // Values per action (I-310): each post has its own channel; the fixed words go to the "otherwise" post only.
    expect(src(f, alerts!.id, "channel")).toEqual({ from: "literal", value: "#alerts" });
    expect(src(f, ops!.id, "channel")).toEqual({ from: "literal", value: "#ops" });
    expect(src(f, ops!.id, "text")).toEqual({ from: "literal", value: "all clear" });
    expect(alerts!.dependsOn).toContain(cond!.id);
    expect(ops!.dependsOn).toContain(otherwise!.id);
    // Data flow (I-313, I-314): the post and the summary take the widgets; the email carries the SUMMARY — never "the latest step".
    const readId = f.steps.find((s) => s.kind === "datasource")!.id;
    expect(src(f, alerts!.id, "text")).toMatchObject({ stepId: readId });
    const [llm] = calls(f, "llm_complete");
    expect(src(f, llm!.id, "input")).toMatchObject({ stepId: readId });
    const [mail] = calls(f, "mail_send");
    expect(src(f, mail!.id, "body")).toMatchObject({ stepId: llm!.id });
    expect(r.unmet.filter((u) => /If there are|otherwise/.test(u))).toEqual([]);
  });

  it("chat's summary says each path's actions on that path, and the email's recipient is who it goes to (I-316)", () => {
    const text = describeFlow(build(WIRED).r.flow, ITEMS, cat);
    expect(text).toBe("It reads store.widgets. If there are rows, it posts it to #alerts, writes a summary of it and emails it to ops@acme-corp.com. Otherwise, it posts “all clear” to #ops. Runs every day at 09:00.");
  });

  it("reads the connections back, so the person confirms them", () => {
    const lines = readback(build(WIRED).checked, ITEMS);
    expect(lines).toContain("When: the rows of store.widgets has rows — for “If there are any”");
    expect(lines).toContain("“email the summary to ops@acme-corp.com” takes the output of “write a summary of them” — only when “If there are any”");
    expect(lines).toContain(`“post "all clear" to #ops” takes only the words the goal gives — otherwise`);
  });

  it("an approval the goal asks for is spliced before its action", () => {
    const goal = GOAL.replace("email the summary", "have a person approve it, then email the summary");
    const w: Wiring = { ...WIRED, actions: WIRED.actions.map((a, i) => (i === 2 ? { ...a, approve: "have a person approve it" } : a)) };
    const checked = checkSpec({ ...BASE, sinks: BASE.sinks.map((x, i) => (i === 2 ? { ...x, quote: "email the summary to ops@acme-corp.com" } : x)), wiring: w }, [goal], ITEMS);
    const f = solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [] }).flow;
    const gate = f.steps.find((s) => s.kind === "approval")!;
    expect(calls(f, "mail_send")[0]!.dependsOn).toContain(gate.id);
    expect(errorsOf(checkState(f, cat))).toEqual([]);
  });
});

describe("phase Y — controls", () => {
  it("CONTROL (I-314): unwired, two posts of one tool share NO value, and a data port with several candidates is never bound by recency", () => {
    const { r } = build(undefined);
    const f = r.flow;
    for (const p of calls(f, "chat_post")) expect(src(f, p.id, "channel")).toBeUndefined(); // #alerts / #ops: whose is it? asked
    // The widgets as text, or the summary as text? Two whole-list candidates: neither is taken by being the latest (I-314). The one
    // candidate the TYPES force (a single text field — the summary's) is the older structural rule, and is not a choice by order.
    const [mail] = calls(f, "mail_send");
    expect(src(f, mail!.id, "body")).not.toMatchObject({ from: "whole" });
    expect(f.steps.some((s) => s.kind === "branch")).toBe(false);
    expect(r.unmet.some((u) => /If there are any/.test(u))).toBe(true); // stated, never silent (I-299)
  });

  it("CONTROL: a goal with ONE action and one list still binds its data — the only candidate is not a guess", () => {
    const s: GoalSpec = { ...BASE, sinks: [BASE.sinks[0]!], values: BASE.values.filter((v) => v.fills !== "chat_post.channel" || v.quote === "#alerts").filter((v) => v.fills !== "chat_post.text") };
    const { r } = build({ paths: [], actions: [{ takes: "unsaid", path: null, approve: null }] }, s);
    const [post] = calls(r.flow, "chat_post");
    expect(src(r.flow, post!.id, "text")).toMatchObject({ stepId: r.flow.steps.find((x) => x.kind === "datasource")!.id });
    expect(src(r.flow, post!.id, "channel")).toEqual({ from: "literal", value: "#alerts" });
  });

  it("checkWiring drops what points forwards, at nothing, or quotes words the goal does not have — and says so", () => {
    const quoted = (q: string) => GOAL.toLowerCase().includes(q.toLowerCase());
    const bad: Wiring = {
      paths: [{ quote: "if the moon is full", subject: "reader:0", test: "any" }, { quote: "If there are any", subject: "list:5", test: "any" }],
      actions: [{ takes: "action:2", path: 0, approve: null }, { takes: "list:3", path: "otherwise", approve: "sign it off" }, { takes: "nothing", path: null, approve: null }, { takes: "unsaid", path: null, approve: null }],
    };
    const { wiring, dropped } = checkWiring(bad, BASE, quoted, ITEMS);
    expect(wiring!.paths).toEqual([]);
    // an action whose condition was dropped names it (`orphan`): it is unmet, never run for every row (R6)
    expect(wiring!.actions[0]).toEqual({ takes: "unsaid", path: null, approve: null, orphan: "if the moon is full" });
    expect(wiring!.actions[1]).toEqual({ takes: "unsaid", path: null, approve: null, orphan: "otherwise" });
    expect(dropped.map((d) => d.why)).toEqual(expect.arrayContaining(["not in the goal", "it tests a list this goal does not have", "an action takes only an earlier one's output", "not a list this goal has", "there is no condition for it to be the alternative to"]));
  });

  it("the schema offers only THIS spec's parts: earlier actions, its lists, and value owners among the actions of that tool", () => {
    const sc = wiringSchema(BASE, ITEMS) as { properties: Record<string, { properties: Record<string, { properties: Record<string, { enum?: string[]; anyOf?: unknown }> }> }> };
    const acts = sc.properties.actions!.properties;
    // Phase F: with a list, an action may also take the for-each's item, or its output.
    expect(acts.a0!.properties.takes!.enum).toEqual(["reader:0", "nothing", "unsaid", "item", "each"]);
    // Only an action that PREPARES content (the summary, declared `modelText`) can be taken — never a post's reply (a status).
    expect(acts.a2!.properties.takes!.enum).toEqual(["reader:0", "action:1", "nothing", "unsaid", "item", "each"]);
    expect((sc.properties.values as unknown as { properties: Record<string, { enum: string[] }> }).properties.v1!.enum).toEqual(["action:0", "action:3"]);
  });

  it("a later round of the build finds its paths again — solving twice places no second condition", () => {
    const { checked, r } = build(WIRED);
    const again = solve(r.flow, { spec: checked, cat, answers: new Map(), base: [] });
    expect(again.flow.steps.filter((x) => x.kind === "branch")).toHaveLength(2);
    const [mail] = calls(again.flow, "mail_send");
    expect(src(again.flow, mail!.id, "subject")).toEqual({ from: "literal", value: "Widgets" }); // never the summary, in any round
    expect(again.flow.steps.filter((x) => x.kind === "tool")).toHaveLength(4);
  });

  it("a condition with nothing on it is STATED, never placed empty (an empty arm is a hole nobody can settle)", () => {
    const w: Wiring = { ...WIRED, paths: [...WIRED.paths, { quote: "If there are none", subject: "reader:0", test: "none" }] };
    const { r } = build(w);
    expect(r.flow.steps.filter((x) => x.kind === "branch")).toHaveLength(2);
    expect(r.unmet).toContain("the condition “If there are none” has nothing to do on it");
    expect(r.flow.holes.some((h) => /guards nothing/.test(h.reason))).toBe(false);
  });

  it("I-313: what an action takes goes into its declared MESSAGE port — the summary becomes the email, it is not asked", () => {
    const withMessage: CatalogueSnapshot = { ...cat, refs: { ...cat.refs, mail_send: { ...cat.refs.mail_send!, params: cat.refs.mail_send!.params.map((p) => (p.name === "body" ? { ...p, message: true } : p.name === "subject" ? { ...p, ty: { t: "Text" } } : p)) } } };
    const checked = checkSpec({ ...BASE, wiring: WIRED }, [GOAL], ITEMS);
    const f = solve(emptyFlow("t"), { spec: checked, cat: withMessage, answers: new Map(), base: [] }).flow;
    const [llm] = calls(f, "llm_complete"), [mail] = calls(f, "mail_send");
    expect(src(f, mail!.id, "body")).toMatchObject({ stepId: llm!.id });
  });

  it("a condition on the READER's rows tests the reader, never a shaped list over it (the list may filter more)", () => {
    const shapes = [{ over: "store.widgets", stages: [{ op: "filter", quote: "qty over 5", field: "store.widgets.qty", test: "above", value: "5", by: null, fn: null, against: null, measures: null, dir: null }] }] as unknown as GoalSpec["shapes"];
    const goal = GOAL + " Only qty over 5.";
    const checked = checkSpec({ ...BASE, shapes, wiring: { ...WIRED, actions: WIRED.actions.map((a, i) => (i === 0 ? { ...a, takes: "list:0" } : a)) } }, [goal], ITEMS);
    const f = solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [] }).flow;
    const cond = f.steps.find((x): x is Extract<S, { kind: "branch" }> => x.kind === "branch" && !x.elseOf)!;
    expect(cond.conditions![0]!.left.stepId).toBe(f.steps.find((x) => x.kind === "datasource")!.id);
    const list = f.steps.find((x) => x.kind === "transform")!;
    expect(src(f, calls(f, "chat_post")[0]!.id, "text")).toMatchObject({ stepId: list.id });
  });

  it("the content port is the first that can TAKE it — a list goes into a free description, not a one-line title", () => {
    const tk: CatalogueSnapshot = { ...cat, refs: { ...cat.refs, ticket_open: { kind: "tool", payload: cat.refs.ticket_open!.payload, params: [
      { name: "title", ty: { t: "Text", refine: [{ r: "SingleLine" }, { r: "MaxLen", n: 120 }] } as never, required: true, message: true },
      { name: "description", ty: { t: "Text" }, required: false, message: true },
    ] } } };
    const s2: GoalSpec = { ...BASE, sinks: [{ ref: "ticket_open", quote: "open a ticket listing them" }], values: [BASE.values[0]!] };
    const goal = "check the widgets as of today and open a ticket listing them";
    const checked = checkSpec({ ...s2, sources: [{ ref: "store.widgets", quote: "check the widgets as of today" }], wiring: { paths: [], actions: [{ takes: "reader:0", path: null, approve: null }] } }, [goal], ITEMS);
    const f = solve(emptyFlow("t"), { spec: checked, cat: tk, answers: new Map(), base: [] }).flow;
    const t = calls(f, "ticket_open")[0]!;
    expect(src(f, t.id, "description")).toMatchObject({ stepId: f.steps.find((x) => x.kind === "datasource")!.id });
    expect(src(f, t.id, "title")).toBeUndefined(); // the person's words, or asked — never the list
    // …and in a LATER round of the build too (the bound port is no longer a listed move; the next port must not become "the content").
    const again = solve(f, { spec: checked, cat: tk, answers: new Map(), base: [] }).flow;
    expect(src(again, t.id, "title")).toBeUndefined();
  });

  it("the content port is chosen ONCE: a later round does not put the summary into the email's plain subject too", () => {
    const plainSubject: CatalogueSnapshot = { ...cat, refs: { ...cat.refs, mail_send: { ...cat.refs.mail_send!, params: cat.refs.mail_send!.params.map((p) => (p.name === "body" ? { ...p, message: true } : p.name === "subject" ? { ...p, ty: { t: "Text" } } : p)) } } };
    const noSubject = { ...BASE, values: BASE.values.filter((v) => v.role !== "subject") };
    const checked = checkSpec({ ...noSubject, wiring: WIRED }, [GOAL], ITEMS);
    const once = solve(emptyFlow("t"), { spec: checked, cat: plainSubject, answers: new Map(), base: [] }).flow;
    const again = solve(once, { spec: checked, cat: plainSubject, answers: new Map(), base: [] }).flow;
    const [mail] = calls(again, "mail_send");
    expect(src(again, mail!.id, "body")).toMatchObject({ stepId: calls(again, "llm_complete")[0]!.id });
    expect(src(again, mail!.id, "subject")).toBeUndefined(); // asked — never the summary
  });
});


describe("a condition with nothing on it is the BUILDER's to fix, never the person's (2026-10-02)", () => {
  const NOTHING_ON_IT: Wiring = { ...WIRED, actions: WIRED.actions.map((a) => ({ ...a, path: null })) };
  it("the wiring check names it, with the actions it could carry — so the wiring call is asked again with it", () => {
    const f = wiringFindings(NOTHING_ON_IT, BASE);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/the condition path:0 \(“If there are any”\) has no action on it/);
    expect(f[0]).toMatch(/a0 \(“/);
    // CONTROL: the wired goal leaves nothing unsaid.
    expect(wiringFindings(WIRED, BASE)).toEqual([]);
  });
  it("the solver states it unmet AND marks it internal — what the conversation never asks the person", () => {
    const { r } = build(NOTHING_ON_IT);
    expect(r.unmet).toContain("the condition “If there are any” has nothing to do on it");
    expect(r.internal).toContain("the condition “If there are any” has nothing to do on it");
    // CONTROL: a wired build has nothing internal.
    expect(build(WIRED).r.internal).toEqual([]);
  });
});

describe("a one-filter list that is a per-item condition's own test is that condition (2026-10-02)", async () => {
  const { supersededShapes } = await import("./wiring.js");
  const spec = (field: string) => ({
    ...BASE,
    shapes: [{ over: "store.widgets", stages: [{ op: "filter", quote: "if heavy", field: "store.widgets.weight", test: "above", value: "5" }] }, { over: "store.widgets", stages: [{ op: "filter", quote: "otherwise", field, test: "at_most", value: "5" }] }],
    wiring: { each: { over: "reader:0", quote: "for each widget" }, paths: [{ quote: "if heavy", subject: "item", test: "compare", measure: "weight", cmp: "gt", value: "5" }], actions: [] },
  }) as never;
  it("both sides of it are superseded — never reported as lists nothing reads", () => {
    expect([...supersededShapes(spec("store.widgets.weight")).keys()]).toEqual([0, 1]);
  });
  it("CONTROL: a list on ANOTHER field is its own list", () => {
    expect([...supersededShapes(spec("store.widgets.qty")).keys()]).toEqual([0]);
  });
});
