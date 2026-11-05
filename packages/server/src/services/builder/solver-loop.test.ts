/**
 * Phase F, F5 (D-381) — a goal's "for each … then …" becomes a loop, placed by the solver through the engine's own moves on the
 * neutral synthetic catalogue: the loop's own bounded list (D-325's skip when an address may be empty, the per-item message on it),
 * a Decide chain on the item inside, the per-item actions under it, and the loop's output for an action after it. And the
 * controls: one send per item and nothing else is today's fan-out (no loop); one message for all of them is no loop; a for-each
 * the goal does not say, or a condition on an item with no for-each, is dropped by name.
 */
import { describe, expect, it } from "vitest";
import { checkState, collectOf, decideTest, emptyFlow, errorsOf, holesOf, loopMembers, loopOfStep, renderType, SYNTHETIC, type CatalogueSnapshot, type EFlow, type Ty } from "@foundry/flow-edit";
import { solve } from "./solver.js";
import { aboutFlow, describeFlow } from "./chat-answers.js";
import { checkSpec, readback, type BuilderCatalogue, type GoalSpec } from "./goal-spec.js";
import type { Wiring } from "./wiring.js";
import { batchedCall, flowCompiler, validateModel, type FlowModel } from "../flow-compiler.service.js";
import { namespaceFor } from "../kestra-client.service.js";
import { lowerPipelinesWith } from "../flow-pipeline.js";
import { compilerRenderInputs } from "../flow-typecheck.js";
import { specMatch } from "./spec-match.js";

// The synthetic mail tool, with its body declared a message — as the real email tools declare theirs (D-324's per-item draft).
const MAIL = SYNTHETIC.refs.mail_send!;
const cat: CatalogueSnapshot = { ...SYNTHETIC, refs: { ...SYNTHETIC.refs, mail_send: { ...MAIL, params: MAIL.params.map((p) => (p.name === "body" ? { ...p, message: true } : p)) } } };
const fieldsOf = (r: CatalogueSnapshot["refs"][string]) => (r.kind === "tool" ? [] : Object.entries((r.payload as { of: { fields: Record<string, Ty> } }).of.fields).map(([name, t]) => ({ name, ty: renderType(t) })));
const ITEMS: BuilderCatalogue = { items: Object.entries(cat.refs).map(([ref, r]) => ({ ref, kind: r.kind === "tool" ? ("tool" as const) : ("reader" as const), about: ref, params: r.params.map((p) => ({ name: p.name, about: "", ...(p.message ? { message: true } : {}), ...(p.heading ? { heading: true } : {}) })), fields: fieldsOf(r), ...(r.modelText ? { modelText: true } : {}) })) };
type S = EFlow["steps"][number];

const spec = (sinks: GoalSpec["sinks"], values: GoalSpec["values"]): GoalSpec => ({
  sources: [{ ref: "store.widgets", quote: "check the widgets as of today" }], sinks,
  values: [{ role: "date", from: "flow_input", quote: "today", fills: "store.widgets.as_of", relative: "today" }, ...values],
  conditions: [], schedule: { cron: "0 9 * * *", quote: "Every day at 9" }, missing: null,
});
const build = (goal: string, s: GoalSpec, w: Wiring) => {
  const checked = checkSpec({ ...s, wiring: w }, [goal], ITEMS);
  return { checked, r: solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [], drafts: "propose" }) };
};
const loops = (f: EFlow) => f.steps.filter((s): s is Extract<S, { kind: "for_each" }> => s.kind === "for_each");
const tool = (f: EFlow, ref: string) => f.steps.find((s): s is Extract<S, { kind: "tool" }> => s.kind === "tool" && s.ref === ref)!;

const BRANCH_GOAL = `Every day at 9, check the widgets as of today. For each widget, if its qty is over 30 open a high priority ticket "Big order"; otherwise email its owner "Your widget". Then post a summary to #ops.`;
const BRANCH = spec(
  [{ ref: "ticket_open", quote: `open a high priority ticket "Big order"` }, { ref: "mail_send", quote: `email its owner "Your widget"` }, { ref: "chat_post", quote: "post a summary to #ops" }],
  [
    { role: "other", from: "goal", quote: "high", fills: "ticket_open.priority" },
    { role: "subject", from: "goal", quote: "Big order", fills: "ticket_open.title" },
    { role: "recipient", from: "goal", quote: "its owner", fills: "mail_send.to" },
    { role: "subject", from: "goal", quote: "Your widget", fills: "mail_send.subject" },
    { role: "channel", from: "goal", quote: "#ops", fills: "chat_post.channel" },
  ],
);
const BRANCH_W: Wiring = {
  each: { quote: "For each widget", over: "reader:0" },
  paths: [{ quote: "if its qty is over 30", subject: "item", test: "compare", measure: "qty", cmp: "gt", value: "30" }],
  actions: [{ takes: "item", path: 0, approve: null, per: "item" }, { takes: "item", path: "otherwise", approve: null, per: "item" }, { takes: "each", path: null, approve: null }],
};

describe("“for each …, if … otherwise …, then …” is a loop with a Decide inside and its output after it (phase F, D-381)", () => {
  it("builds valid: a bounded list of the rows with an owner, the loop over it, the test on the item, each action on its own path", () => {
    const { checked, r } = build(BRANCH_GOAL, BRANCH, BRANCH_W);
    expect(checked.dropped).toEqual([]);
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
    const [loop] = loops(r.flow);
    expect(loop).toBeDefined();
    const list = r.flow.steps.find((s) => s.id === loop!.over.stepId) as Extract<S, { kind: "transform" }>;
    // The owner's address may be empty: those rows are skipped by a filter on the loop's list, and kept to be seen (D-325).
    expect(list.pipeline).toEqual(expect.arrayContaining([{ op: "filter", where: { notNull: "owner_email" } }, expect.objectContaining({ op: "limit" })]));
    expect(r.skips).toEqual([{ reader: "read_1", field: "owner_email" }]);
    const members = loopMembers(r.flow, loop!.id);
    const ticket = tool(r.flow, "ticket_open"), mail = tool(r.flow, "mail_send"), post = tool(r.flow, "chat_post");
    expect(members).toEqual(expect.arrayContaining([ticket.id, mail.id]));
    expect(loopOfStep(r.flow).has(post.id)).toBe(false);
    // The condition is a Decide on the item: its test reads the loop, and the ticket runs on it, the mail on its otherwise.
    const cond = r.flow.steps.find((s): s is Extract<S, { kind: "branch" }> => s.kind === "branch" && !s.elseOf)!;
    expect(members).toContain(cond.id);
    expect(decideTest(r.flow, cond.conditions![0]!.left.stepId)).toMatchObject({ subject: loop!.id, where: { cmp: "gt", left: { field: "qty" }, right: { lit: { value: 30 } } } });
    expect(ticket.dependsOn).toContain(cond.id);
    const other = r.flow.steps.find((s) => s.kind === "branch" && s.elseOf === cond.id)!;
    expect(mail.dependsOn).toContain(other.id);
    // The mail goes to the ITEM's own address, with its per-item message from the row's fields.
    expect(mail.inputs.find((b) => b.name === "to")?.source).toMatchObject({ from: "step", stepId: loop!.id, field: "owner_email" });
    expect(r.drafts.map((d) => d.port)).toContain("body");
    // …and the body IS that message — never the whole item as text, which would send every field of the row (internal addresses
    // included) to the person it goes to (2026-10-01).
    expect(mail.inputs.find((b) => b.name === "body")?.source).toMatchObject({ from: "step", stepId: loop!.id, field: expect.stringMatching(/^body_text/) });
    // The summary after it reads the loop's output — one row per item.
    const out = collectOf(r.flow, loop!.id)!;
    expect(out).toBeDefined();
    expect(JSON.stringify(post.inputs)).toContain(out.id);
    expect(holesOf(checkState(r.flow, cat))).toEqual([]);
  });
  it("reads back as a for each, its condition on the item, and which actions run once per item", () => {
    const { checked } = build(BRANCH_GOAL, BRANCH, BRANCH_W);
    const lines = readback(checked, ITEMS);
    expect(lines).toContain(`For each of the rows of store.widgets — for “For each widget”: “open a high priority ticket "Big order"”, “email its owner "Your widget"”`);
    expect(lines).toContain("When, for each item: its qty is more than 30 — for “if its qty is over 30”");
    expect(lines).toContain(`“email its owner "Your widget"” takes the item — once for each item — otherwise`);
    expect(lines).toContain("“post a summary to #ops” takes what happened to each item (one row per item)");
  });
  it("the chat says it per item: the actions inside ON the loop, the condition decided for each item, the summary after", () => {
    const { r } = build(BRANCH_GOAL, BRANCH, BRANCH_W);
    const said = describeFlow(r.flow, ITEMS, cat);
    expect(said).toMatch(/^It reads store\.widgets\. For each of the rows: if qty is more than 30, it [^.]*\. Otherwise, it emails it to each person in the list\. Then, it posts it to #ops\./);
    expect(aboutFlow(r.flow, ITEMS, cat).some((l) => /For each row, runs the steps below once/.test(l))).toBe(true);
    expect(aboutFlow(r.flow, ITEMS, cat).filter((l) => l.endsWith("(for each item)")).length).toBeGreaterThanOrEqual(2);
  });
  it("the same build again finds its loop, its condition and its output rather than doubling them", () => {
    const { checked, r } = build(BRANCH_GOAL, BRANCH, BRANCH_W);
    const again = solve(r.flow, { spec: checked, cat, answers: new Map(), base: [] });
    expect(errorsOf(checkState(again.flow, cat))).toEqual([]);
    expect(again.flow.steps.length).toBe(r.flow.steps.length);
  });
});

const EACH_GOAL = `Every day at 9, check the widgets as of today and open a high priority ticket "Widget check" for each of them.`;
const EACH = spec([{ ref: "ticket_open", quote: `open a high priority ticket "Widget check"` }], [
  { role: "other", from: "goal", quote: "high", fills: "ticket_open.priority" },
  { role: "subject", from: "goal", quote: "Widget check", fills: "ticket_open.title" },
]);
const EACH_W: Wiring = { each: { quote: "for each of them", over: "reader:0" }, paths: [], actions: [{ takes: "item", path: null, approve: null, per: "item" }] };

describe("a call inside a loop runs once per row: its message is never the whole item as text (2026-10-01)", () => {
  // No template can be drafted for an OPTIONAL message — so what fills it is the rule under test.
  const optBody: CatalogueSnapshot = { ...cat, refs: { ...cat.refs, mail_send: { ...cat.refs.mail_send!, params: cat.refs.mail_send!.params.map((p) => (p.name === "body" ? { ...p, required: false } : p)) } } };
  const bodyOf = (f: EFlow) => tool(f, "mail_send").inputs.find((b) => b.name === "body")?.source;
  it("the item is not put into the email as text — every field of the row would reach its recipient", () => {
    const checked = checkSpec({ ...BRANCH, wiring: BRANCH_W }, [BRANCH_GOAL], ITEMS);
    const f = solve(emptyFlow("t"), { spec: checked, cat: optBody, answers: new Map(), base: [], drafts: "propose" }).flow;
    expect(loopOfStep(f).has(tool(f, "mail_send").id)).toBe(true);
    expect(bodyOf(f)).not.toMatchObject({ from: "whole" });
  });
  it("…but a port declared to take DATA (a model's input) takes its item — that is its row, read by a model", () => {
    const withData: CatalogueSnapshot = { ...cat, refs: { ...cat.refs, llm_complete: { ...cat.refs.llm_complete!, params: cat.refs.llm_complete!.params.map((p) => (p.name === "input" ? { ...p, data: true } : p)) } } };
    const G = "Every day at 9, check the widgets as of today, and for each widget summarise it.";
    const s = spec([{ ref: "llm_complete", quote: "summarise it" }], []);
    const checked = checkSpec({ ...s, wiring: { each: { quote: "for each widget", over: "reader:0" }, paths: [], actions: [{ takes: "item", path: null, approve: null, per: "item" }] } }, [G], ITEMS);
    const f = solve(emptyFlow("t"), { spec: checked, cat: withData, answers: new Map(), base: [], drafts: "propose" }).flow;
    const llm = tool(f, "llm_complete");
    expect(loopOfStep(f).has(llm.id)).toBe(true);
    expect(llm.inputs.find((b) => b.name === "input")?.source).toMatchObject({ from: "whole", stepId: loops(f)[0]!.id, transform: "text" });
  });
  it("CONTROL: a call that runs ONCE and takes the rows still gets them as its content", () => {
    const s = spec([{ ref: "mail_send", quote: "email the list to ops@acme-corp.com" }], [{ role: "recipient", from: "goal", quote: "ops@acme-corp.com", fills: "mail_send.to" }]);
    const checked = checkSpec({ ...s, wiring: { paths: [], actions: [{ takes: "reader:0", path: null, approve: null }] } }, ["Every day at 9, check the widgets as of today and email the list to ops@acme-corp.com."], ITEMS);
    const f = solve(emptyFlow("t"), { spec: checked, cat: optBody, answers: new Map(), base: [], drafts: "propose" }).flow;
    expect(bodyOf(f)).toMatchObject({ from: "whole", transform: "text" });
  });
});

describe("a loop's list is shared: a row one action cannot reach is dropped for all, and it is stated (2026-10-01)", () => {
  // The widgets gain a second address that may be empty: the team's, beside the owner's.
  const W = cat.refs["store.widgets"]!;
  const P = W.payload as { of: { fields: Record<string, Ty> } };
  const cat2: CatalogueSnapshot = { ...cat, refs: { ...cat.refs, "store.widgets": { ...W, payload: { ...P, of: { ...P.of, fields: { ...P.of.fields, team_email: P.of.fields.owner_email! } } } as never } } };
  const ITEMS2: BuilderCatalogue = { items: ITEMS.items.map((it) => (it.ref === "store.widgets" ? { ...it, fields: [...(it.fields ?? []), { name: "team_email", ty: "" }] } : it)) };
  const G = `Every day at 9, check the widgets as of today. For each widget, if its qty is over 30 email its team "Big order"; otherwise email its owner "Your widget".`;
  const two = (team: string) => spec(
    [{ ref: "mail_send", quote: `email ${team} "Big order"` }, { ref: "mail_send", quote: `email its owner "Your widget"` }],
    [{ role: "recipient", from: "goal", quote: team, fills: "mail_send.to" }, { role: "recipient", from: "goal", quote: "its owner", fills: "mail_send.to" }],
  );
  const W2: Wiring = { each: { quote: "For each widget", over: "reader:0" }, paths: [BRANCH_W.paths[0]!], actions: [{ takes: "item", path: 0, approve: null, per: "item" }, { takes: "item", path: "otherwise", approve: null, per: "item" }], valueAction: { 1: 0, 2: 1 } };
  const listOf = (goal: string, sp: GoalSpec) => {
    const r = solve(emptyFlow("t"), { spec: checkSpec({ ...sp, wiring: W2 }, [goal], ITEMS2), cat: cat2, answers: new Map(), base: [], drafts: "propose" });
    const [loop] = loops(r.flow);
    return { r, list: r.flow.steps.find((x) => x.id === loop!.over.stepId) as Extract<S, { kind: "transform" }> };
  };
  it("two sends on different addresses: a row missing either is skipped for BOTH — and that is stated (the engine binds no empty address)", () => {
    const { r, list } = listOf(G, two("its team"));
    expect(errorsOf(checkState(r.flow, cat2))).toEqual([]);
    expect(list.pipeline).toEqual(expect.arrayContaining([{ op: "filter", where: { notNull: "team_email" } }, { op: "filter", where: { notNull: "owner_email" } }]));
    // …stated where the person reads it (the readback's "Skipped:" line): each skip names the action that did not need it.
    expect(r.skips).toEqual(expect.arrayContaining([expect.objectContaining({ field: "team_email", alsoFor: [expect.stringContaining("its owner")] }), expect.objectContaining({ field: "owner_email", alsoFor: [expect.stringContaining("its team")] })]));
  });
  it("CONTROL: when every send needs the same address, a row without it is still skipped and kept to be seen", () => {
    const { r, list } = listOf(G.replace("its team", "its owner"), two("its owner"));
    expect(list.pipeline).toEqual(expect.arrayContaining([{ op: "filter", where: { notNull: "owner_email" } }]));
    expect(r.skips).toEqual([{ reader: "read_1", field: "owner_email" }]);
    // …and nothing else is said to lose it
    expect(r.skips.every((k) => !k.alsoFor)).toBe(true);
  });
});

describe("a list nothing reads is not built — the loop's condition written again as lists (2026-10-01)", () => {
  // The shape call wrote the item's condition as lists too (the pre-loop spelling), and nothing takes them.
  const stage = (quote: string, test: string, value: string, field = "store.widgets.qty") => ({ op: "filter", quote, field, test, value });
  const withShapes = (shapes: unknown[]) => ({ ...BRANCH, shapes } as unknown as GoalSpec);
  it("the condition's own lists — the path and its otherwise — are not built, and nothing is stated missing", () => {
    const { checked, r } = build(BRANCH_GOAL, withShapes([{ over: "store.widgets", stages: [stage("if its qty is over 30", "above", "30")] }, { over: "store.widgets", stages: [stage("otherwise", "at_most", "30")] }]), BRANCH_W);
    expect(r.flow.steps.filter((x) => x.id.startsWith("where"))).toEqual([]);
    expect(r.unmet).toEqual([]);
    // …nor read back as steps it has: the readback says what is BUILT
    expect(readback(checked, ITEMS).filter((l) => l.startsWith("Then ("))).toEqual([]);
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
  });
  it("a filter the loop does NOT run over is stated, even when the loop's own words say it (F01, 2026-10-01)", () => {
    const G = `Every day at 9, check the widgets as of today. For each widget past its due date, email its owner "Your widget".`;
    const s = { ...spec([{ ref: "mail_send", quote: `email its owner "Your widget"` }], [{ role: "recipient", from: "goal", quote: "its owner", fills: "mail_send.to" }, { role: "subject", from: "goal", quote: "Your widget", fills: "mail_send.subject" }]),
      shapes: [{ over: "store.widgets", stages: [stage("past its due date", "date_passed", "", "store.widgets.due")] }] } as unknown as GoalSpec;
    const { r } = build(G, s, { each: { quote: "For each widget past its due date", over: "reader:0" }, paths: [], actions: [{ takes: "item", path: null, approve: null, per: "item" }] });
    expect(r.unmet).toContain("the list “past its due date” is read by no action, so nothing built does it — the for each “For each widget past its due date” runs over every row, not over this list");
    // CONTROL: the same loop over the LIST is built, and nothing is stated missing
    const ok = build(G, s, { each: { quote: "For each widget past its due date", over: "list:0" }, paths: [], actions: [{ takes: "item", path: null, approve: null, per: "item" }] }).r;
    expect(ok.unmet).toEqual([]);
    expect(ok.flow.steps.some((x) => x.id.startsWith("where"))).toBe(true);
  });
  it("CONTROL: a list nothing reads whose words nothing built carries is STATED — the goal asked for it and nothing does it", () => {
    const { r } = build(BRANCH_GOAL, withShapes([{ over: "store.widgets", stages: [stage("check the widgets", "equals", "open", "store.widgets.state")] }]), BRANCH_W);
    expect(r.flow.steps.filter((x) => x.id.startsWith("where"))).toEqual([]);
    expect(r.unmet.some((u) => u.startsWith("the list “check the widgets” is read by no action, so nothing built does it"))).toBe(true);
    // …once, however many unread lists share that stage
    const twice = build(BRANCH_GOAL, withShapes([0, 1].map(() => ({ over: "store.widgets", stages: [stage("check the widgets", "equals", "open", "store.widgets.state")] }))), BRANCH_W).r;
    expect(twice.unmet.filter((u) => u.startsWith("the list “check the widgets”"))).toHaveLength(1);
  });
});

describe("two actions on ONE tool each have their own message (2026-10-01)", () => {
  it("one email's stated words do not leave the other undrafted — each is its action's", () => {
    const G = `Every day at 9, check the widgets as of today. For each widget, if its qty is over 30 email its owner saying "Big order"; otherwise email its owner "Your widget".`;
    const s = spec(
      [{ ref: "mail_send", quote: `email its owner saying "Big order"` }, { ref: "mail_send", quote: `email its owner "Your widget"` }],
      [{ role: "recipient", from: "goal", quote: "its owner", fills: "mail_send.to" }, { role: "text", from: "goal", quote: "Big order", fills: "mail_send.body" }, { role: "subject", from: "goal", quote: "Your widget", fills: "mail_send.subject" }],
    );
    const w: Wiring = { each: { quote: "For each widget", over: "reader:0" }, paths: [BRANCH_W.paths[0]!], actions: [{ takes: "item", path: 0, approve: null, per: "item" }, { takes: "item", path: "otherwise", approve: null, per: "item" }], valueAction: { 1: 0, 2: 0, 3: 1 } };
    const { r } = build(G, s, w);
    const mails = r.flow.steps.filter((x): x is Extract<S, { kind: "tool" }> => x.kind === "tool" && x.ref === "mail_send");
    const body = (m: Extract<S, { kind: "tool" }>) => m.inputs.find((b) => b.name === "body")?.source;
    // The first says the person's words; the second — whose body nobody stated — its row's own message, not a question.
    expect(body(mails[0]!)).toMatchObject({ from: "literal", value: "Big order" });
    expect(body(mails[1]!)).toMatchObject({ from: "step", field: expect.stringMatching(/^body_text/) });
    expect(r.drafts.filter((d) => d.port === "body").map((d) => d.sink)).toEqual([1]);
  });
});

describe("a reader's input that SELECTS rows by a field takes the goal's words for that field (2026-10-01)", () => {
  // The widgets reader gains a `status` input that keeps the rows whose `state` equals it — declared, as a DB operation's filter
  // and projection declare it (`selects`); its name is not the field's.
  const W = cat.refs["store.widgets"]!;
  const withStatus = (selects?: string): CatalogueSnapshot => ({ ...cat, refs: { ...cat.refs, "store.widgets": { ...W, params: [...W.params, { name: "status", ty: { t: "Text" } as never, required: true, ...(selects ? { selects } : {}) }] } } });
  const items = (c: CatalogueSnapshot): BuilderCatalogue => ({ items: ITEMS.items.map((it) => (it.ref === "store.widgets" ? { ...it, params: [...(it.params ?? []), { name: "status", about: "" }] } : it)) });
  const G = `Every day at 9, check the widgets as of today. For each open widget, email its owner "Your widget".`;
  const s = { ...spec([{ ref: "mail_send", quote: `email its owner "Your widget"` }], [{ role: "recipient", from: "goal", quote: "its owner", fills: "mail_send.to" }, { role: "subject", from: "goal", quote: "Your widget", fills: "mail_send.subject" }]),
    shapes: [{ over: "store.widgets", stages: [{ op: "filter", quote: "For each open widget", field: "store.widgets.state", test: "equals", value: "open" }] }] } as unknown as GoalSpec;
  // As the live build had it: the loop runs over the reader, and the "open" filter is a list nothing reads.
  const w: Wiring = { each: { quote: "For each open widget", over: "reader:0" }, paths: [], actions: [{ takes: "item", path: null, approve: null, per: "item" }] };
  const solveOn = (c: CatalogueSnapshot) => solve(emptyFlow("t"), { spec: checkSpec({ ...s, wiring: w }, [G], items(c)), cat: c, answers: new Map(), base: [], drafts: "propose" });
  const statusOf = (f: EFlow) => (f.steps.find((x) => x.kind === "datasource") as { inputs: Array<{ name: string; source?: unknown; provenance?: unknown }> }).inputs.find((b) => b.name === "status");
  it("“open widget” sets `status` to open, and the reader's own filter is what the goal's filter was — nothing asked, nothing unmet", () => {
    const r = solveOn(withStatus("state"));
    expect(statusOf(r.flow)).toMatchObject({ source: { from: "literal", value: "open" }, provenance: { from: "goal" } });
    expect(r.flow.holes.filter((h) => h.site.at === "port" && h.site.port === "status")).toEqual([]);
    expect(r.unmet).toEqual([]);
  });
  it("CONTROL: an input that declares nothing is not matched to a field of another name — asked, and the filter stated", () => {
    const r = solveOn(withStatus());
    expect(statusOf(r.flow)?.source).toBeUndefined();
    expect(r.unmet.some((u) => u.startsWith("the list “For each open widget” is read by no action"))).toBe(true);
  });
});

describe("a call inside a loop that sends to nobody still carries its item (2026-10-01)", () => {
  // The ticket tool with an OPTIONAL description a person reads — as the product's ticket tool declares it.
  const TK = cat.refs.ticket_open!;
  const catT: CatalogueSnapshot = { ...cat, refs: { ...cat.refs, ticket_open: { ...TK, params: [...TK.params, { name: "description", ty: { t: "Text" } as never, required: false, message: true }] } } };
  const itemsT: BuilderCatalogue = { items: ITEMS.items.map((it) => (it.ref === "ticket_open" ? { ...it, params: [...(it.params ?? []), { name: "description", about: "", message: true }] } : it)) };
  const describe_ = (f: EFlow) => tool(f, "ticket_open").inputs.find((b) => b.name === "description")?.source;
  it("each item's ticket names its item: the description is the item's own fields, the title the goal's words", () => {
    const checked = checkSpec({ ...BRANCH, wiring: BRANCH_W }, [BRANCH_GOAL], itemsT);
    const r = solve(emptyFlow("t"), { spec: checked, cat: catT, answers: new Map(), base: [], drafts: "propose" });
    expect(describe_(r.flow)).toMatchObject({ from: "step", stepId: loops(r.flow)[0]!.id, field: expect.stringMatching(/^description_text/) });
    expect(tool(r.flow, "ticket_open").inputs.find((b) => b.name === "title")?.source).toMatchObject({ from: "literal", value: "Big order" });
    expect(r.drafts).toContainEqual(expect.objectContaining({ ref: "ticket_open", port: "description" }));
    expect(errorsOf(checkState(r.flow, catT))).toEqual([]);
  });
  it("CONTROL: a ticket raised ONCE, outside any loop, is not given a drafted description", () => {
    const G = `Every day at 9, check the widgets as of today and open a high priority ticket "Big order".`;
    const s1 = spec([{ ref: "ticket_open", quote: `open a high priority ticket "Big order"` }], [{ role: "other", from: "goal", quote: "high", fills: "ticket_open.priority" }, { role: "subject", from: "goal", quote: "Big order", fills: "ticket_open.title" }]);
    const r = solve(emptyFlow("t"), { spec: checkSpec({ ...s1, wiring: { paths: [], actions: [{ takes: "nothing", path: null, approve: null }] } }, [G], itemsT), cat: catT, answers: new Map(), base: [], drafts: "propose" });
    expect(describe_(r.flow)).toBeUndefined();
  });
});

describe("one call per item that sends to nobody in the rows is a loop of one call (it runs in batches, D-370)", () => {
  it("the ticket is inside the loop, once per item; no output is placed when nothing after it reads one", () => {
    const { checked, r } = build(EACH_GOAL, EACH, EACH_W);
    expect(checked.dropped).toEqual([]);
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
    const [loop] = loops(r.flow);
    expect(loopMembers(r.flow, loop!.id)).toEqual([tool(r.flow, "ticket_open").id]);
    expect(collectOf(r.flow, loop!.id)).toBeUndefined();
    // The flow's result is the list the loop ran over, never a step inside it.
    expect(r.flow.output).toEqual({ stepId: loop!.over.stepId });
  });
});

// What the save funnel does before compiling: each transform's pipeline lowered to its expression — then the one emitter.
const modelOf = (f: EFlow) => lowerPipelinesWith({ ...(f as unknown as FlowModel), id: "loops" }, { ...cat, renderInputs: compilerRenderInputs });
describe("the goal-built loops compile through the one emitter", () => {
  it("the for each with a condition inside is a per-item ForEach; the one-call loop is batched (D-370)", () => {
    const branch = modelOf(build(BRANCH_GOAL, BRANCH, BRANCH_W).r.flow);
    expect(() => validateModel(branch)).not.toThrow();
    const y = flowCompiler.compile(branch, { namespace: namespaceFor("acme", "hr", "draft") }).yaml;
    expect(y).toContain("io.kestra.plugin.core.flow.ForEach");
    expect(y).toContain("io.kestra.plugin.core.flow.If");
    const one = modelOf(build(EACH_GOAL, EACH, EACH_W).r.flow);
    expect(() => validateModel(one)).not.toThrow();
    expect(batchedCall(one, one.steps.find((x) => x.kind === "for_each") as never)).not.toBeNull();
    expect(flowCompiler.compile(one, { namespace: namespaceFor("acme", "hr", "draft") }).yaml).toContain("-chunks");
  });
});

describe("a condition the spec lists with no field is built by the placed test whose words it is (F01, 2026-09-30)", () => {
  const goal = `Every day at 9, check the widgets as of today and open a high priority ticket "Widget check" for each widget with a qty over 30.`;
  const withShape = (quote: string): GoalSpec => ({ ...EACH, conditions: [{ quote: "each widget with a qty over 30", by: "the_flow" }],
    shapes: [{ over: "store.widgets", stages: [{ op: "filter", quote, field: "store.widgets.qty", test: "above", value: "30" }] as never }] });
  const w: Wiring = { each: { quote: "for each widget with a qty over 30", over: "list:0" }, paths: [], actions: [{ takes: "item", path: null, approve: null, per: "item" }] };
  it("a placed filter stage whose words hold the condition's builds it — nothing unmet", () => {
    const { r } = build(goal, withShape("for each widget with a qty over 30"), w);
    expect(r.unmet.filter((u) => u.includes("qty over 30"))).toEqual([]);
  });
  it("CONTROL: the loop's words alone do not — with no filter placed the condition stays unmet", () => {
    const { r } = build(goal, { ...withShape("x"), shapes: [] }, { ...w, each: { quote: "for each widget with a qty over 30", over: "reader:0" } });
    expect(r.unmet).toContain("the condition “each widget with a qty over 30” is not built: nothing here states how to test it");
  });
});

describe("CONTROLS", () => {
  it("ONE rule: one send per item is a loop too — of one call, run in batches (D-370); the same goal with no for each stays a fan-out", () => {
    const goal = `Every day at 9, check the widgets as of today and email each owner "Your widget".`;
    const s = spec([{ ref: "mail_send", quote: `email each owner "Your widget"` }], [
      { role: "recipient", from: "goal", quote: "each owner", fills: "mail_send.to" },
      { role: "subject", from: "goal", quote: "Your widget", fills: "mail_send.subject" },
    ]);
    const looped = build(goal, s, { each: { quote: "each owner", over: "reader:0" }, paths: [], actions: [{ takes: "item", path: null, approve: null, per: "item" }] }).r.flow;
    const [loop] = loops(looped);
    expect(loopMembers(looped, loop!.id)).toEqual([tool(looped, "mail_send").id]);
    expect(errorsOf(checkState(looped, cat))).toEqual([]);
    const m = modelOf(looped);
    expect(batchedCall(m, m.steps.find((x) => x.kind === "for_each") as never)).not.toBeNull();
    // The loop's list and the fan-out's are ONE definition (`rowList`): the same skip of rows with no owner, the same message.
    const fan = build(goal, s, { paths: [], actions: [{ takes: "reader:0", path: null, approve: null }] }).r;
    expect(loops(fan.flow)).toEqual([]);
    expect(tool(fan.flow, "mail_send").over).toBeDefined();
    const listOf = (f: EFlow, id: string) => (f.steps.find((x) => x.id === id) as Extract<S, { kind: "transform" }>).pipeline;
    expect(listOf(looped, loop!.over.stepId)).toEqual(listOf(fan.flow, tool(fan.flow, "mail_send").over!.stepId));
  });
  it("one message for all of them is no loop — and its words for how often are the action's, never “unused” (F06, 2026-09-30)", () => {
    const goal = `Every day at 9, check the widgets as of today and post them to #ops in one message.`;
    const s = spec([{ ref: "chat_post", quote: "post them to #ops in one message" }], [{ role: "channel", from: "goal", quote: "#ops", fills: "chat_post.channel" }, { role: "count", from: "goal", quote: "one message", fills: "none" }]);
    const { checked, r } = build(goal, s, { paths: [], actions: [{ takes: "reader:0", path: null, approve: null, perWords: "in one message" }] });
    expect(loops(r.flow)).toEqual([]);
    expect(r.unmet.filter((u) => u.includes("one message"))).toEqual([]);
    expect(readback(checked, ITEMS)).toContain("“post them to #ops in one message” takes the rows of store.widgets — once, for all of them (“in one message”)");
    // CONTROL: the same words with no how-often claim are unused, stated — the rule that keeps a goal from being silently shortened.
    expect(build(goal, s, { paths: [], actions: [{ takes: "reader:0", path: null, approve: null }] }).r.unmet).toContain("the goal says “one message” (count), and nothing built here uses it");
    // …and words that are not the goal's are dropped by name.
    expect(build(goal, s, { paths: [], actions: [{ takes: "reader:0", path: null, approve: null, perWords: "as a digest" }] }).checked.dropped).toContainEqual({ what: "how often chat_post runs (“as a digest”)", why: "not in the goal" });
  });
  it("a for each the goal does not say is dropped by name, and its actions run once", () => {
    const { checked, r } = build(EACH_GOAL, EACH, { ...EACH_W, each: { quote: "for every widget", over: "reader:0" } });
    expect(checked.dropped).toContainEqual({ what: "for each “for every widget”", why: "not in the goal" });
    expect(checked.dropped).toContainEqual({ what: "ticket_open for each item", why: "the goal has no for each" });
    expect(loops(r.flow)).toEqual([]);
  });
  it("a condition on an item with no for each is dropped; a condition on the run cannot guard an item's action", () => {
    const goal = BRANCH_GOAL;
    const noEach = build(goal, BRANCH, { ...BRANCH_W, each: undefined });
    expect(noEach.checked.dropped).toContainEqual({ what: "condition “if its qty is over 30”", why: "it tests an item, and the goal has no for each" });
    const runLevel = build(goal, BRANCH, { ...BRANCH_W, paths: [{ quote: "if its qty is over 30", subject: "reader:0", test: "compare", measure: "count", cmp: "gt", value: "30" }] });
    expect(runLevel.checked.dropped.map((d) => d.why)).toContain("that condition is decided once for the run, and this action runs for each item — a condition on the item compares one of its fields");
  });
  it("an action after the loop cannot take the item; an action inside cannot take the loop's output", () => {
    const { checked } = build(BRANCH_GOAL, BRANCH, { ...BRANCH_W, actions: [{ takes: "each", path: 0, approve: null, per: "item" }, BRANCH_W.actions[1]!, { takes: "item", path: null, approve: null }] });
    expect(checked.dropped.map((d) => d.why)).toEqual(expect.arrayContaining(["it runs for each item; the output is one row per item, after the for each", "it runs once, not for each item"]));
  });
});

describe("every loop build here is one a save accepts: the spec check agrees with the solver's rules (2026-10-01)", () => {
  // A save runs `specMatch` over the compiled model; a solver rule it does not share (an unread list, a reader input that selects
  // a field) refuses a correct build as "a builder bug" — which a person saw as "That message did not land".
  const agrees = (f: EFlow, spec: GoalSpec, c: CatalogueSnapshot = cat) =>
    specMatch(lowerPipelinesWith({ ...(f as unknown as FlowModel), id: "loops" }, { ...c, renderInputs: compilerRenderInputs }) as never, { goalSpec: { spec } }, (ref, input) => c.refs[ref]?.params.find((p) => p.name === input)?.selects);
  it("the item's condition, with the same condition written again as lists nothing reads", () => {
    const stage = (quote: string, test: string, value: string) => ({ op: "filter", quote, field: "store.widgets.qty", test, value });
    const sp = { ...BRANCH, shapes: [{ over: "store.widgets", stages: [stage("if its qty is over 30", "above", "30")] }, { over: "store.widgets", stages: [stage("otherwise", "at_most", "30")] }] } as unknown as GoalSpec;
    const checked = checkSpec({ ...sp, wiring: BRANCH_W }, [BRANCH_GOAL], ITEMS);
    const r = solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [], drafts: "propose" });
    expect(r.unmet).toEqual([]);
    expect(agrees(r.flow, checked.spec)).toEqual([]);
  });
  it("a reader input that selects the field the goal's filter names", () => {
    const W = cat.refs["store.widgets"]!;
    const c: CatalogueSnapshot = { ...cat, refs: { ...cat.refs, "store.widgets": { ...W, params: [...W.params, { name: "status", ty: { t: "Text" } as never, required: true, selects: "state" }] } } };
    const items: BuilderCatalogue = { items: ITEMS.items.map((it) => (it.ref === "store.widgets" ? { ...it, params: [...(it.params ?? []), { name: "status", about: "" }] } : it)) };
    const G = `Every day at 9, check the widgets as of today. For each open widget, email its owner "Your widget".`;
    const sp = { ...spec([{ ref: "mail_send", quote: `email its owner "Your widget"` }], [{ role: "recipient", from: "goal", quote: "its owner", fills: "mail_send.to" }, { role: "subject", from: "goal", quote: "Your widget", fills: "mail_send.subject" }]),
      shapes: [{ over: "store.widgets", stages: [{ op: "filter", quote: "For each open widget", field: "store.widgets.state", test: "equals", value: "open" }] }] } as unknown as GoalSpec;
    const checked = checkSpec({ ...sp, wiring: { each: { quote: "For each open widget", over: "list:0" }, paths: [], actions: [{ takes: "item", path: null, approve: null, per: "item" }] } }, [G], items);
    const r = solve(emptyFlow("t"), { spec: checked, cat: c, answers: new Map(), base: [], drafts: "propose" });
    expect(agrees(r.flow, checked.spec, c)).toEqual([]);
  });
  it("CONTROL: the check still refuses a flow that does NOT apply the spec's filter", () => {
    const checked = checkSpec({ ...BRANCH, wiring: BRANCH_W }, [BRANCH_GOAL], ITEMS);
    const r = solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [], drafts: "propose" });
    const stripped = { ...r.flow, steps: r.flow.steps.map((x) => (x.kind === "transform" && x.pipeline?.some((st) => st.op === "keep_if") ? { ...x, pipeline: x.pipeline.filter((st) => st.op !== "keep_if") } : x)) } as EFlow;
    expect(agrees(stripped, checked.spec).some((p) => p.includes("qty"))).toBe(true);
  });
});
