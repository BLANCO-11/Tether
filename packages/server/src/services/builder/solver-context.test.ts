/**
 * Phase Z part 2 — the conversation remembers (I-322…I-326), on the neutral synthetic catalogue.
 * Z9 (I-325): "me" is the signed-in person — a requester value on an address port whose receiver does NOT send to the run's
 * requester itself binds the verified address; the control asks when no address is known; a port that falls back is left alone.
 */
import { describe, expect, it } from "vitest";
import { SYNTHETIC, emptyFlow, TypeOf, type CatalogueSnapshot, type EFlow } from "@foundry/flow-edit";
import { solve } from "./solver.js";
import { checkSpec, readback, specOutcome, type BuilderCatalogue, type GoalSpec } from "./goal-spec.js";
import { emptyTrace, questionsFor } from "./build.js";
import { existingParts, wiringSchema } from "./wiring.js";

const cat = SYNTHETIC;
const fieldsOf = (r: CatalogueSnapshot["refs"][string]) => (r.kind === "tool" ? [] : Object.keys((r.payload as { of: { fields: Record<string, unknown> } }).of.fields).map((name) => ({ name, ty: "" })));
// The ports people read — declared per tool, as `tool-declarations.ts` does for the product's tools.
const MESSAGE = new Set(["chat_post.text", "mail_send.body", "ticket_open.title"]);
const HEADING = new Set(["mail_send.subject", "ticket_open.title"]);
const ITEMS: BuilderCatalogue = { items: Object.entries(cat.refs).map(([ref, r]) => ({ ref, kind: r.kind === "tool" ? ("tool" as const) : ("reader" as const), about: ref, params: r.params.map((p) => ({ name: p.name, about: "", ...(MESSAGE.has(`${ref}.${p.name}`) ? { message: true } : {}), ...(HEADING.has(`${ref}.${p.name}`) ? { heading: true } : {}) })), fields: fieldsOf(r), ...(r.modelText ? { modelText: true } : {}) })) };
type S = EFlow["steps"][number];
const src = (f: EFlow, ref: string, port: string) => (f.steps.find((s) => s.kind === "tool" && s.ref === ref) as Extract<S, { kind: "tool" }>).inputs.find((b) => b.name === port)?.source;

const GOAL = "Check the people and email the list to me with subject People.";
const spec = (tool: string, port: string): GoalSpec => ({
  sources: [{ ref: "store.people", quote: "Check the people" }],
  sinks: [{ ref: tool, quote: "email the list to me" }],
  values: [{ role: "recipient", from: "requester", quote: "me", fills: `${tool}.${port}` }, ...(tool === "mail_send" ? [{ role: "subject" as const, from: "goal" as const, quote: "People", fills: "mail_send.subject" }] : [])],
  conditions: [], schedule: null, missing: null,
});
const run = (tool: string, port: string, requester?: string) =>
  solve(emptyFlow("t"), { spec: checkSpec(spec(tool, port), [GOAL], ITEMS), cat, answers: new Map(), base: [], ...(requester ? { requester } : {}) }).flow;

describe("Z9 — \"me\" is the person building (I-325)", () => {
  it("binds the verified address to a port whose receiver does not send to the requester itself", () => {
    expect(src(run("mail_send", "to", "me@acme-corp.com"), "mail_send", "to")).toEqual({ from: "literal", value: "me@acme-corp.com" });
  });
  it("CONTROL: with no address known, it is not bound — asked, never invented", () => {
    expect(src(run("mail_send", "to"), "mail_send", "to")).toBeUndefined();
  });
  it("a port whose receiver already sends to the run's requester is left to it", () => {
    expect(src(run("notify_me", "to", "me@acme-corp.com"), "notify_me", "to")).toBeUndefined();
  });
  // Flow d3c79698 ("Every Monday, email me …"): the receiver would send to whoever starts the run, a schedule starts it, so the port
  // was asked — although the person had said "me" and their address was known.
  const scheduled = (requester?: string) => {
    const sp = { ...spec("notify_me", "to"), schedule: { cron: "0 0 * * 1", quote: "Every Monday" } };
    return solve(emptyFlow("t"), { spec: checkSpec(sp, [`Every Monday, ${GOAL}`], ITEMS), cat, answers: new Map(), base: [], ...(requester ? { requester } : {}) }).flow;
  };
  it("on a SCHEDULE that fallback has nobody, so \"me\" binds the person's address — and the question is gone", () => {
    const f = scheduled("me@acme-corp.com");
    expect(src(f, "notify_me", "to")).toEqual({ from: "literal", value: "me@acme-corp.com" });
    expect(f.holes.some((h) => h.why === "scheduled_recipient")).toBe(false);
  });
  it("CONTROL: on a schedule with no address known it stays a question", () => {
    expect(scheduled().holes.some((h) => h.why === "scheduled_recipient")).toBe(true);
  });
});

describe("Z7 — a quoted phrase lands or is stated (I-324)", () => {
  const G = `Check the widgets. If there are any, post them to #alerts. If there are none, post "all clear today" to #ops.`;
  const S7: GoalSpec = {
    sources: [{ ref: "store.widgets", quote: "Check the widgets" }],
    sinks: [{ ref: "chat_post", quote: "post them to #alerts" }, { ref: "chat_post", quote: `post "all clear today" to #ops` }],
    // The report: the channels were claimed, the quoted words were not.
    values: [{ role: "channel", from: "goal", quote: "#alerts", fills: "chat_post.channel" }, { role: "channel", from: "goal", quote: "#ops", fills: "chat_post.channel" }],
    conditions: [], schedule: null, missing: null,
    wiring: { paths: [{ quote: "If there are any", subject: "reader:0", test: "any" }], actions: [{ takes: "reader:0", path: 0, approve: null }, { takes: "nothing", path: "otherwise", approve: null }], valueAction: { 0: 0, 1: 1 } },
  };
  it("a quote inside one action's clause fills that action's open message port — the right one of two calls of one tool", () => {
    const checked = checkSpec(S7, [G], ITEMS);
    expect(checked.spec.values).toContainEqual({ role: "text", from: "goal", quote: "all clear today", fills: "chat_post.text" });
    const f = solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [] }).flow;
    const posts = f.steps.filter((s): s is Extract<S, { kind: "tool" }> => s.kind === "tool" && s.ref === "chat_post");
    const ops = posts.find((p) => p.inputs.some((b) => b.name === "channel" && b.source?.from === "literal" && b.source.value === "#ops"))!;
    expect(ops.inputs.find((b) => b.name === "text")!.source).toEqual({ from: "literal", value: "all clear today" });
    const alerts = posts.find((p) => p !== ops)!;
    expect(alerts.inputs.find((b) => b.name === "text")?.source).not.toEqual({ from: "literal", value: "all clear today" });
  });
  it("a quote no action's words contain is STATED, never dropped in silence", () => {
    const g = `Check the widgets and post them to #alerts. Call it "Project Falcon".`;
    const checked = checkSpec({ ...S7, sinks: [S7.sinks[0]!], values: [S7.values[0]!], wiring: undefined }, [g], ITEMS);
    expect(checked.dropped).toContainEqual({ what: "“Project Falcon”", why: "quoted in the goal, but no one action's words contain it — nothing uses it" });
  });
  it("a shared tool's value belongs to the action whose clause holds its words — over a wrong wiring", () => {
    const checked = checkSpec({ ...S7, wiring: { ...S7.wiring!, valueAction: { 0: 0, 1: 0 } } }, [G], ITEMS);
    expect(checked.spec.wiring?.valueAction?.[1]).toBe(1);
    expect(checked.spec.wiring?.valueAction?.[0]).toBe(0);
  });
  it("CONTROL: a quote a value already holds is not added twice", () => {
    const checked = checkSpec({ ...S7, values: [...S7.values, { role: "text", from: "goal", quote: "all clear today", fills: "chat_post.text" }], wiring: { ...S7.wiring!, valueAction: { 0: 0, 1: 1, 2: 1 } } }, [G], ITEMS);
    expect(checked.spec.values.filter((v) => v.quote === "all clear today")).toHaveLength(1);
  });
});

describe("Z5 — values already in the automation are reused, not asked again (I-322)", () => {
  const G = "Also email the list with subject Weekly.";
  const mailSpec = (values: GoalSpec["values"]): GoalSpec => ({ sources: [{ ref: "store.by_month", quote: "the list" }], sinks: [{ ref: "mail_send", quote: "email the list" }], values, conditions: [], schedule: null, missing: null });
  it("`from: earlier` holds only a value that IS in the automation", () => {
    const v = { role: "recipient" as const, from: "earlier" as const, quote: "ops@acme-corp.com", fills: "mail_send.to" };
    expect(checkSpec(mailSpec([v]), [G], ITEMS, ["ops@acme-corp.com"]).spec.values).toContainEqual(v);
    const none = checkSpec(mailSpec([v]), [G], ITEMS, []);
    expect(none.spec.values).toEqual([]);
    expect(none.dropped).toContainEqual({ what: "recipient “ops@acme-corp.com”", why: "not a value already in this automation" });
  });
  it("an earlier value binds the port, provenance the person's", () => {
    const checked = checkSpec(mailSpec([{ role: "recipient", from: "earlier", quote: "ops@acme-corp.com", fills: "mail_send.to" }]), [G], ITEMS, ["ops@acme-corp.com"]);
    expect(src(solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [] }).flow, "mail_send", "to")).toEqual({ from: "literal", value: "ops@acme-corp.com" });
  });
  it("the same component's same input, filled once elsewhere, is reused; two different values stay a question", () => {
    const checked = checkSpec(mailSpec([{ role: "subject", from: "goal", quote: "Weekly", fills: "mail_send.subject" }]), [G], ITEMS);
    const one = solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [], known: [{ stepId: "old_1", ref: "mail_send", port: "to", value: "ops@acme-corp.com" }] }).flow;
    expect(src(one, "mail_send", "to")).toEqual({ from: "literal", value: "ops@acme-corp.com" });
    const two = solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [], known: [
      { stepId: "old_1", ref: "mail_send", port: "to", value: "ops@acme-corp.com" }, { stepId: "old_2", ref: "mail_send", port: "to", value: "hr@acme-corp.com" }] }).flow;
    expect(src(two, "mail_send", "to")?.from).not.toBe("literal");
  });
});

describe("Z6 — a change reaches the automation's existing steps (I-323)", () => {
  // The reported shape: a reader, an if on it with an otherwise-when-empty, a post on the empty path; then "if nothing is outstanding
  // then an email saying all dues are clear".
  const START: EFlow = { id: "f", inputs: [], holes: [], steps: [
    { id: "read_1", kind: "datasource", ref: "store.widgets", inputs: [{ name: "as_of", source: { from: "literal", value: "2026-06-01" } }], dependsOn: [] },
    { id: "when_1", kind: "branch", conditions: [{ op: "any", left: { stepId: "read_1", field: "" } }], dependsOn: ["read_1"] },
    { id: "when_2", kind: "branch", elseOf: "when_1", conditions: [{ op: "none", left: { stepId: "read_1", field: "" } }], dependsOn: [] },
    { id: "call_1", kind: "tool", ref: "chat_post", inputs: [{ name: "channel", source: { from: "literal", value: "#ops" } }, { name: "text", source: { from: "literal", value: "none" } }], dependsOn: ["when_2"] },
  ], output: { stepId: "read_1" } };
  const G = "if nothing is outstanding then an email to ops@acme-corp.com saying all dues are clear, subject Clear";
  const change: GoalSpec = {
    sources: [], sinks: [{ ref: "mail_send", quote: "an email to ops@acme-corp.com saying all dues are clear" }],
    values: [{ role: "recipient", from: "goal", quote: "ops@acme-corp.com", fills: "mail_send.to" }, { role: "subject", from: "goal", quote: "Clear", fills: "mail_send.subject" }],
    conditions: [{ quote: "if nothing is outstanding", by: "flow", field: "none" }], schedule: null, missing: null,
    wiring: { paths: [{ quote: "if nothing is outstanding", subject: "in:when_2", test: "any" }], actions: [{ takes: "nothing", path: 0, approve: null }] },
  };
  const existing = existingParts(START as never, (ref) => !!cat.refs[ref]?.modelText);
  const base = START.steps.map((x) => ({ kind: x.kind, ...("ref" in x && x.ref ? { ref: x.ref } : {}) }));

  it("the goal's condition that IS an existing path puts the new action on it — no condition unmet, nothing top-level", () => {
    const checked = checkSpec(change, [G], ITEMS, [], existing);
    expect(checked.spec.wiring?.paths).toEqual([{ quote: "if nothing is outstanding", subject: "in:when_2", test: "any" }]);
    const r = solve(START, { spec: checked, cat, answers: new Map(), base });
    const mail = r.flow.steps.find((s) => s.kind === "tool" && s.ref === "mail_send")!;
    expect(mail.dependsOn).toContain("when_2");
    expect(r.unmet.filter((u) => u.includes("nothing is outstanding"))).toEqual([]);
    expect(r.flow.steps.filter((s) => s.kind === "branch")).toHaveLength(2); // no new condition
  });

  it("CONTROL: without the automation's parts, that path is dropped and the condition is unmet — never guessed", () => {
    const checked = checkSpec(change, [G], ITEMS);
    expect(checked.dropped).toContainEqual({ what: "condition “if nothing is outstanding”", why: "it tests a list this goal does not have" });
    expect(solve(START, { spec: checked, cat, answers: new Map(), base }).unmet.some((u) => u.includes("nothing is outstanding"))).toBe(true);
  });

  it("the existing parts are the automation's own: its lists and its condition paths", () => {
    expect(existing.lists.map((x) => x.key)).toEqual(["step:read_1"]);
    expect(existing.paths.map((x) => x.key)).toEqual(["in:when_1", "in:when_2"]);
  });
});

describe("Z8 — wording is drafted, exact values are not (I-326)", () => {
  // The catalogue declares `subject` a heading, as tool-declarations.ts does for the product's mail tools.
  const cat8: CatalogueSnapshot = { ...cat, refs: { ...cat.refs, mail_send: { ...cat.refs.mail_send!, params: cat.refs.mail_send!.params.map((p) => (p.name === "subject" ? { ...p, heading: true } : p)) } } };
  const G = "Check the monthly totals for 2026-06 and email them to ops@acme-corp.com.";
  const spec8 = (drafts: Record<string, string>, takes: "reader:0" | "nothing" = "reader:0"): GoalSpec => ({
    sources: [{ ref: "store.by_month", quote: "Check the monthly totals" }], sinks: [{ ref: "mail_send", quote: "email them to ops@acme-corp.com" }],
    values: [{ role: "recipient", from: "goal", quote: "ops@acme-corp.com", fills: "mail_send.to" }, { role: "period", from: "goal", quote: "2026-06", fills: "store.by_month.period" }],
    conditions: [], schedule: null, missing: null,
    wiring: { paths: [], actions: [{ takes, path: null, approve: null, drafts }] },
  });
  const heading = (f: EFlow) => (f.steps.find((s) => s.kind === "tool") as Extract<S, { kind: "tool" }>).inputs.find((b) => b.name === "subject");
  it("a subject the goal makes plain is drafted, bound with provenance `drafted`, and read back as drafted", () => {
    const checked = checkSpec(spec8({ subject: "Monthly totals for 2026-06" }), [G], ITEMS);
    const f = solve(emptyFlow("t"), { spec: checked, cat: cat8, answers: new Map(), base: [] }).flow;
    expect(heading(f)).toEqual({ name: "subject", source: { from: "literal", value: "Monthly totals for 2026-06" }, provenance: { from: "drafted" } });
  });
  it("a draft that states a fact the goal does not (a number) is dropped, named — the input stays a question", () => {
    const checked = checkSpec(spec8({ subject: "Totals: 42 accounts" }), [G], ITEMS);
    expect(checked.dropped).toContainEqual({ what: "draft for mail_send.subject (“Totals: 42 accounts”)", why: "it states “42”, which the goal does not" });
    expect(heading(solve(emptyFlow("t"), { spec: checked, cat: cat8, answers: new Map(), base: [] }).flow)).toBeUndefined();
  });
  it("CONTROL: the engine refuses `drafted` on an input not declared as words (the undeclared catalogue)", () => {
    const checked = checkSpec(spec8({ subject: "Monthly totals for 2026-06" }), [G], ITEMS);
    expect(heading(solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [] }).flow)).toBeUndefined();
  });
  it("CONTROL: a message draft on an action that carries data is its content, not a draft", () => {
    const checked = checkSpec(spec8({ body: "All good" }), [G], ITEMS);
    expect(checked.dropped.some((d) => d.what.startsWith("draft for mail_send.body") && d.why.includes("carries data"))).toBe(true);
  });
  it("a subject is always drafted: the schema REQUIRES words for a heading, and leaves a message optional", () => {
    const ITEMS8: BuilderCatalogue = { items: ITEMS.items.map((it) => (it.ref === "mail_send" ? { ...it, params: it.params!.map((p) => (p.name === "subject" ? { ...p, heading: true } : p)) } : it)) };
    const sc = wiringSchema(spec8({}), ITEMS8) as unknown as { properties: { actions: { properties: Record<string, { properties: { drafts: { properties: Record<string, { type?: string; anyOf?: unknown }> } } }> } } };
    const drafts = Object.values(sc.properties.actions.properties)[0]!.properties.drafts.properties;
    expect(drafts.subject!.type).toBe("string");
    // CONTROL: a message (the body) may still be null — only an action carrying nothing but words has its message drafted
    expect(drafts.body!.anyOf).toBeDefined();
  });
  it("the person's answer beats a draft: an answered subject is never filled by the drafted words", () => {
    const checked = checkSpec(spec8({ subject: "Monthly totals for 2026-06" }), [G], ITEMS);
    const open = solve(emptyFlow("t"), { spec: checkSpec(spec8({}), [G], ITEMS), cat: cat8, answers: new Map(), base: [] }).flow;
    const hole = open.holes.find((h) => h.site.at === "port" && h.site.port === "subject")!.id;
    const f = solve(emptyFlow("t"), { spec: checked, cat: cat8, answers: new Map(), base: [], answered: new Set([hole]) }).flow;
    expect(heading(f)).toBeUndefined();
    expect(f.holes.some((h) => h.id === hole)).toBe(true);
    // CONTROL: an answer to a different hole does not stop the draft
    expect(heading(solve(emptyFlow("t"), { spec: checked, cat: cat8, answers: new Map(), base: [], answered: new Set(["h_other"]) }).flow)?.provenance).toEqual({ from: "drafted" });
  });
  it("only a recipient can be the person who runs it — a wording 'from the requester' is dropped, named", () => {
    const c = checkSpec({ ...spec8({}), values: [...spec8({}).values, { role: "text", from: "requester", quote: "the status", fills: "mail_send.body" }] }, [G], ITEMS);
    expect(c.spec.values.some((v) => v.role === "text")).toBe(false);
    expect(c.dropped.some((d) => d.what === "text “the status”" && d.why.startsWith("only a recipient"))).toBe(true);
    // CONTROL: "me" as a recipient is kept
    expect(checkSpec(spec("mail_send", "to"), [GOAL], ITEMS).spec.values.some((v) => v.from === "requester" && v.role === "recipient")).toBe(true);
  });
});

describe("a condition's words are not a shape (live run, 2026-09-29)", () => {
  it("a path testing a list made only of its own words tests the rows that list reads", () => {
    const G = `Check the widgets. If there are any, post them to #alerts. If nothing is left, post "all clear" to #ops.`;
    const spec: GoalSpec = {
      sources: [{ ref: "store.widgets", quote: "Check the widgets" }],
      sinks: [{ ref: "chat_post", quote: "post them to #alerts" }, { ref: "chat_post", quote: `post "all clear" to #ops` }],
      values: [{ role: "channel", from: "goal", quote: "#alerts", fills: "chat_post.channel" }, { role: "channel", from: "goal", quote: "#ops", fills: "chat_post.channel" }],
      conditions: [], schedule: null, missing: null,
      shapes: [{ over: "store.widgets", stages: [{ op: "filter", quote: "If nothing is left", field: "store.widgets.due", test: "is_empty" }] } as never],
      wiring: { paths: [{ quote: "If there are any", subject: "reader:0", test: "any" }, { quote: "If nothing is left", subject: "list:0", test: "none" }],
        actions: [{ takes: "reader:0", path: 0, approve: null }, { takes: "nothing", path: 1, approve: null }], valueAction: { 0: 0, 1: 1 } },
    };
    const checked = checkSpec(spec, [G], ITEMS);
    expect(checked.spec.wiring?.paths[1]).toEqual({ quote: "If nothing is left", subject: "reader:0", test: "none" });
    const r = solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [] });
    expect(r.unmet.filter((u) => u.includes("If nothing is left"))).toEqual([]);
  });
});

describe("Z5 — a question that could be an earlier value offers those values; the readback follows what is built", () => {
  it("an address question offers the automation's addresses as choices; a text question offers none", () => {
    const f = solve(emptyFlow("t"), { spec: checkSpec({ sources: [{ ref: "store.by_month", quote: "the totals" }], sinks: [{ ref: "mail_send", quote: "email the totals" }], values: [], conditions: [], schedule: null, missing: null }, ["email the totals"], ITEMS), cat, answers: new Map(), base: [] }).flow;
    const trace = { ...emptyTrace(), known: [{ stepId: "old", ref: "x", port: "to", value: "ops@acme-corp.com" }, { stepId: "old", ref: "x", port: "sender", value: "me@acme-corp.com" }, { stepId: "old", ref: "x", port: "subject", value: "Weekly" }] };
    const toQ = f.holes.find((h) => h.site.at === "port" && h.site.port === "to")!;
    const subQ = f.holes.find((h) => h.site.at === "port" && h.site.port === "subject")!;
    const qs = questionsFor(f, [toQ.id, subQ.id], trace, 1, cat);
    expect(qs.find((q) => q.holeId === toQ.id)!.options).toEqual(["ops@acme-corp.com", "me@acme-corp.com"]);
    expect(qs.find((q) => q.holeId === subQ.id)!.options).toBeUndefined();
  });
  it("a fieldless condition whose words are a stated path is not read back as 'not built'", () => {
    const spec: GoalSpec = { sources: [{ ref: "store.widgets", quote: "the widgets" }], sinks: [{ ref: "chat_post", quote: "post it" }], values: [], conditions: [{ quote: "if nothing is left", by: "flow", field: "none" }], schedule: null, missing: null,
      wiring: { paths: [{ quote: "if nothing is left", subject: "reader:0", test: "none" }], actions: [{ takes: "nothing", path: 0, approve: null }] } };
    const lines = readback(checkSpec(spec, ["the widgets: if nothing is left post it"], ITEMS), ITEMS);
    expect(lines.some((l) => l.includes("not built"))).toBe(false);
    expect(lines.some((l) => l.startsWith("When:") && l.includes("if nothing is left"))).toBe(true);
  });
});

// Live chat build 47d1e01e (2026-10-01): "…if any center is over spending need to send them emails…". The model made the list
// `over_budget is true` (an email takes it) and, in three runs, three different readings of the same words around it — each left the
// build "incomplete" though it was right. One phrase is one claim; these are its three shapes, on the synthetic catalogue.
describe("one phrase, one claim — a flag list an action takes, and the condition that restates it (2026-10-01)", () => {
  const G = "check the widgets for all the widgets, if any widget is active need to send them emails.";
  const base = (paths: NonNullable<GoalSpec["wiring"]>["paths"], values: GoalSpec["values"] = []): GoalSpec => ({
    sources: [{ ref: "store.widgets", quote: "check the widgets for all the widgets" }],
    sinks: [{ ref: "mail_send", quote: "send them emails" }],
    values: [{ role: "recipient", from: "goal", quote: "them", fills: "mail_send.to" }, ...values],
    conditions: [], schedule: null, missing: null,
    shapes: [{ over: "store.widgets", stages: [{ op: "filter", quote: "if any widget is active", field: "store.widgets.active", test: "is_true" }] } as never],
    wiring: { paths, actions: [{ takes: "list:0", path: 0, approve: null, drafts: { subject: "Active widgets" } }], valueAction: { 0: 0 } },
  });
  const build = (s: GoalSpec) => { const checked = checkSpec(s, [G], ITEMS); return { checked, r: solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [] }) }; };

  it("a condition asking whether the flag list has rows keeps that list — an action takes it, so it is never the condition's framing", () => {
    const { checked, r } = build(base([{ quote: "if any widget is active", subject: "list:0", test: "any" }]));
    expect(checked.spec.wiring?.paths[0]).toMatchObject({ subject: "list:0", test: "any" });
    expect(r.unmet).toEqual([]);
    // …and the send runs once per row of that list, to each row's own address, under the condition — its row list placed AHEAD of
    // the condition (a guarded step reads only what runs before it; built after, it fell back to one message to nobody).
    const call = r.flow.steps.find((x) => x.kind === "tool" && x.ref === "mail_send") as Extract<S, { kind: "tool" }>;
    expect(call.over).toBeDefined();
    expect(call.inputs.find((b) => b.name === "to")?.source).toMatchObject({ stepId: call.over!.stepId, field: "owner_email" });
    const idx = (id: string) => r.flow.steps.findIndex((x) => x.id === id);
    const when = r.flow.steps.find((x) => x.kind === "branch")!;
    expect(call.dependsOn).toContain(when.id);
    expect(idx(call.over!.stepId)).toBeLessThan(idx(when.id));
  });
  it("a comparison of the flag with the phrase as its value IS that list having rows — stated, and built", () => {
    const { checked, r } = build(base([{ quote: "if any widget is active", subject: "reader:0", test: "compare", measure: "active", cmp: "eq", value: "active" }]));
    expect(checked.spec.wiring?.paths[0]).toEqual({ quote: "if any widget is active", subject: "list:0", test: "any" });
    expect(checked.dropped.map((d) => d.why)).toContain("its words are list:0's own test of active — it asks whether that list has rows");
    expect(r.unmet).toEqual([]);
  });
  it("a value with no role that fills nothing is asked about before building — never “unused” after (code cannot tell “all of them” from “VIP only”)", () => {
    const { checked } = build(base([{ quote: "if any widget is active", subject: "list:0", test: "any" }], [{ role: "other", from: "goal", quote: "all the widgets", fills: "none" }]));
    expect(checked.spec.values.map((v) => v.quote)).not.toContain("all the widgets");
    expect(checked.spec.unclear).toContainEqual({ quote: "all the widgets", about: "value" });
    expect(specOutcome(checked.spec)).toBe("asks");
  });
  it("CONTROLS: a comparison of a DIFFERENT field stays a comparison; a threshold that fills nothing is still stated unused", () => {
    const other = build(base([{ quote: "if any widget is active", subject: "reader:0", test: "compare", measure: "qty", cmp: "gt", value: "active" }]));
    expect(other.checked.spec.wiring?.paths[0]?.test).not.toBe("any");
    const unused = build(base([{ quote: "if any widget is active", subject: "list:0", test: "any" }], [{ role: "count", from: "goal", quote: "all the widgets", fills: "none" }]));
    expect(unused.r.unmet).toContain("the goal says “all the widgets” (count), and nothing built here uses it");
  });
});

// 2026-10-01 (47d1e01e): an email body read "Budget cents: 120000" — the reader's amounts are minor units and nothing could say so.
// Its owner declares it now (`minor_units`, a type the engine carries), and a drafted message shows the amount converted.
describe("an amount declared in minor units is shown converted, never as raw cents", () => {
  const W = SYNTHETIC.refs["store.widgets"]!;
  const fieldsOf = (r: typeof W) => (r.payload as { of: { fields: Record<string, unknown> } }).of.fields;
  const withUnits = (unit: boolean): CatalogueSnapshot => {
    const fields = { ...fieldsOf(W) } as Record<string, never>;
    if (unit) { fields.qty = TypeOf.minor(fields.qty) as never; fields.weight = { t: "Option", of: TypeOf.minor({ t: "Number" } as never) } as never; }
    const MAIL = SYNTHETIC.refs.mail_send!;
    return { ...SYNTHETIC, refs: { ...SYNTHETIC.refs, "store.widgets": { ...W, payload: { ...(W.payload as object), of: { ...(W.payload as { of: object }).of, fields } } } as never,
      mail_send: { ...MAIL, params: MAIL.params.map((p) => (p.name === "body" ? { ...p, message: true } : p)) } } };
  };
  const G = "check the widgets and email their owners about them.";
  const spec: GoalSpec = { sources: [{ ref: "store.widgets", quote: "check the widgets" }], sinks: [{ ref: "mail_send", quote: "email their owners about them" }],
    values: [{ role: "recipient", from: "goal", quote: "their owners", fills: "mail_send.to" }, { role: "subject", from: "goal", quote: "about them", fills: "mail_send.subject" }],
    conditions: [], schedule: null, missing: null };
  const build = (c: CatalogueSnapshot) => solve(emptyFlow("t"), { spec: checkSpec(spec, [G], ITEMS), cat: c, answers: new Map(), base: [], drafts: "propose" });
  const body = (r: ReturnType<typeof build>) => r.drafts.find((d) => d.port === "body")?.text ?? "";
  const list = (r: ReturnType<typeof build>) => r.flow.steps.find((x) => x.kind === "transform" && x.pipeline.some((st) => st.op === "template")) as Extract<S, { kind: "transform" }>;

  it("the message reads the converted field, labelled as whole units — the conversion placed on the list before the template", () => {
    const r = build(withUnits(true));
    expect(body(r)).toContain("Qty (whole units): {qty_whole}");
    const ops = list(r).pipeline.map((st) => st.op);
    expect(ops.indexOf("convert")).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf("convert")).toBeLessThan(ops.indexOf("template"));
    expect(list(r).pipeline).toContainEqual({ op: "convert", field: "qty", as: "qty_whole", to: "minor_to_major" });
  });
  it("an amount in minor units that may be empty is converted too — shown when present, never as raw cents", () => {
    const r = build(withUnits(true));
    expect(body(r)).toContain("Weight (whole units): {weight_whole}");
    expect(list(r).pipeline).toContainEqual({ op: "convert", field: "weight", as: "weight_whole", to: "minor_to_major" });
  });
  it("CONTROL: with no unit declared the same fields are shown as they are, and nothing is converted", () => {
    const r = build(withUnits(false));
    expect(body(r)).toContain("Qty: {qty}");
    expect(list(r).pipeline.some((st) => st.op === "convert")).toBe(false);
  });
});
