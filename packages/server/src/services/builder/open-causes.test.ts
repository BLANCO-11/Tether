/**
 * builder-behaviour P7 — the root causes left open after phase 1–4. Real solver, real engine, the neutral synthetic catalogue; every
 * rule has a control (the switch off, or the old form) that shows the behaviour it replaces.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkState, emptyFlow, errorsOf, renderType, SYNTHETIC, type CatalogueSnapshot, type EFlow, type Ty } from "@foundry/flow-edit";
import { solve } from "./solver.js";
import { emptyTrace, questionsFor } from "./build.js";
import { partQuestion } from "./conversation.js";
import { checkSpec, type BuilderCatalogue, type GoalSpec } from "./goal-spec.js";
import type { Wiring } from "./wiring.js";
import { clauses, planFindings, planToSpec, type Plan } from "./plan.js";
import { oneGapPerPhrase } from "./builder.service.js";

const on = () => { process.env.BUILDER_INPUTS = "1"; };
const off = () => { delete process.env.BUILDER_INPUTS; };

const cat: CatalogueSnapshot = SYNTHETIC;
const fieldsOf = (r: CatalogueSnapshot["refs"][string]) => (r.kind === "tool" ? [] : Object.entries((r.payload as { of: { fields: Record<string, Ty> } }).of.fields).map(([name, t]) => ({ name, ty: renderType(t) })));
const ITEMS: BuilderCatalogue = { items: Object.entries(cat.refs).map(([ref, r]) => ({ ref, kind: r.kind === "tool" ? ("tool" as const) : ("reader" as const), about: ref, params: r.params.map((p) => ({ name: p.name, about: "" })), fields: fieldsOf(r) })) };
type S = EFlow["steps"][number];

describe("R15 · whose address: the plan chooses the field, never the nearest name", () => {
  beforeEach(on); afterEach(off);
  const GOAL = "For each widget, email its owner's manager";
  const spec = (field?: string): GoalSpec => ({
    sources: [{ ref: "store.widgets", quote: "For each widget" }],
    sinks: [{ ref: "mail_send", quote: "email its owner's manager" }],
    values: [{ role: "recipient", from: "goal", quote: "its owner's manager", fills: "mail_send.to", ...(field ? { field } : {}) }],
    conditions: [], schedule: null, missing: null,
  });
  const wiring: Wiring = { each: { quote: "For each widget", over: "reader:0" }, paths: [], actions: [{ takes: "item", path: null, approve: null, per: "item" }] };
  const build = (field?: string) => {
    const checked = checkSpec({ ...spec(field), wiring }, [GOAL], ITEMS);
    return solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [], drafts: "propose" });
  };
  const toOf = (f: EFlow) => (f.steps.find((s): s is Extract<S, { kind: "tool" }> => s.kind === "tool" && s.ref === "mail_send")?.inputs ?? []).find((i) => i.name === "to")?.source;

  it("`none`: no field is theirs — the build says so and sends to nobody's address", () => {
    const r = build("none");
    expect(toOf(r.flow)).toBeUndefined();
    expect(r.unmet.join(" ")).toMatch(/who receives .*its owner's manager.*no row here carries an address/);
  });
  it("a chosen field is the one bound", () => {
    const r = build("owner_email");
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
    expect(toOf(r.flow)).toMatchObject({ field: "owner_email" });
  });
  it("a call whose people no data holds is BLOCKED: its ports are never asked; CONTROL: the same holes without the block are asked", () => {
    const r = build("none");
    const call = r.flow.steps.find((s) => s.kind === "tool")!.id;
    expect(r.blocked).toEqual([call]);
    const ports = r.flow.holes.filter((h) => h.site.at === "port" && h.site.stepId === call).map((h) => h.id);
    expect(ports.length).toBeGreaterThan(0);
    expect(questionsFor(r.flow, ports, { ...emptyTrace(), blocked: r.blocked }, 1, cat)).toEqual([]);
    expect(questionsFor(r.flow, ports, emptyTrace(), 1, cat).length).toBeGreaterThan(0);
  });
  it("P1 (RC-2/RC-6): the blocked address becomes an ASK offering an email address — and the port keeps its hole, never a terminal", () => {
    const r = build("none");
    const item = r.unmet.find((u) => u.includes("no row here carries"));
    expect(item).toBeDefined();
    // Producer (the solver's finding, its exact string) and matcher (partQuestion) agree — this is the question the person gets.
    expect(partQuestion(item!)).toMatchObject({ key: "part:address:its owner's manager", quote: "its owner's manager", ask: expect.stringMatching(/give an email address to send to/) });
    // The key is the goal's words, never a step id: a rebuild re-ids its steps and askedParts must still converge (P4-I1).
    expect(partQuestion(item!.replace(/`[^`]+\.to`/, "`call_7.to`"))?.key).toBe("part:address:its owner's manager");
    // …and the flow itself says the recipient is not set: a hole on the address port, never the requester fallback.
    const call = r.flow.steps.find((s) => s.kind === "tool")!.id;
    expect(r.flow.holes.some((h) => h.site.at === "port" && h.site.stepId === call && h.site.port === "to")).toBe(true);
  });
  it("an action not yet chosen (`unsaid`) keeps the people the goal named — loose, with the plan's field", () => {
    const cs = clauses("forward every widget to its owner's manager");
    const p: Plan = { sources: [{ ref: "store.widgets", clauses: ["C1"] }], each: { over: 0, clauses: ["C1"] }, rows: [], schedule: null, conditions: [],
      actions: [{ ref: "unsaid", clauses: ["C1"], on: "always", per_item: true, approve_first: null, recipient: { from: "rows", words: "its owner's manager", field: "none" } }],
      values: [], missing: "", joining: [] };
    expect(planToSpec(p, cs, ITEMS).spec.values.filter((v) => v.role === "recipient")).toEqual([{ role: "recipient", from: "goal", quote: "its owner's manager", fills: "none", field: "none" }]);
  });
  it("a written read that is all the data returns the chosen address column BY NAME; CONTROL: no chosen field, no such column", async () => {
    const { readContract } = await import("./read-contract.js");
    const ws: GoalSpec = { sources: [{ ref: "fin.new_read", quote: "each overdue invoice" }], sinks: [{ ref: "mail_send", quote: "email the vendor contact" }],
      values: [{ role: "recipient", from: "goal", quote: "the vendor contact", fills: "mail_send.to", field: "vendors_contact_email" }], conditions: [], schedule: null, missing: null };
    expect(readContract(ws, "fin.new_read", ["x"]).fields).toEqual([{ name: "vendors_contact_email", words: "the address of “the vendor contact”" }]);
    const { field: _f, ...plain } = ws.values[0]!;
    expect(readContract({ ...ws, values: [plain] }, "fin.new_read", ["x"]).fields).toBeUndefined();
  });
  it("an OPTIONAL address nothing holds: the call is still made, without it, and the person is told — never unmet", () => {
    const goal = "For each widget, open a ticket for the owner's manager";
    const sp: GoalSpec = { sources: [{ ref: "store.widgets", quote: "For each widget" }], sinks: [{ ref: "ticket_open", quote: "open a ticket for the owner's manager" }],
      values: [{ role: "recipient", from: "goal", quote: "the owner's manager", fills: "ticket_open.assignee", field: "none" }], conditions: [], schedule: null, missing: null };
    const r = solve(emptyFlow("t"), { spec: checkSpec({ ...sp, wiring }, [goal], ITEMS), cat, answers: new Map(), base: [], drafts: "propose" });
    expect(r.flow.steps.some((s) => s.kind === "tool" && (s as { ref: string }).ref === "ticket_open")).toBe(true);
    expect(r.unmet.join(" ")).not.toMatch(/holds their address/);
    expect(r.without.join(" ")).toMatch(/the owner's manager.*goes without its assignee/);
    expect(r.blocked).toEqual([]);
  });
  it("an address that, left out, goes to WHOEVER RUNS IT is never gone without: the call is not done, and stated (cp3 B24)", () => {
    // `notify_me` is `foundry_email_send`'s shape: an unset `to` delivers to the person who started the run. "Without" it, the
    // owner's manager's message would reach someone else — the silent fallback R15 removes, come back through an optional port.
    const goal = "For each widget, notify the owner's manager";
    const sp: GoalSpec = { sources: [{ ref: "store.widgets", quote: "For each widget" }], sinks: [{ ref: "notify_me", quote: "notify the owner's manager" }],
      values: [{ role: "recipient", from: "goal", quote: "the owner's manager", fills: "notify_me.to", field: "none" }], conditions: [], schedule: null, missing: null };
    const r = solve(emptyFlow("t"), { spec: checkSpec({ ...sp, wiring }, [goal], ITEMS), cat, answers: new Map(), base: [], drafts: "propose" });
    expect(r.unmet.join(" ")).toMatch(/who receives .*the owner's manager.*no row here carries an address/);
    expect(r.without).toEqual([]);
    expect(r.blocked.length).toBe(1);
  });
  it("CONTROL: with no choice the nearest name is still taken (the behaviour R15 replaces)", () => {
    expect(toOf(build().flow)).toMatchObject({ field: "owner_email" });
  });
  it("the plan's field must be a chosen source's address field; `n/a` for a rows recipient is refused", () => {
    const cs = clauses(GOAL);
    const plan = (field: string): Plan => ({ sources: [{ ref: "store.widgets", clauses: ["C1"] }], each: { over: 0, clauses: ["C1"] }, rows: [], schedule: null, conditions: [],
      actions: [{ ref: "mail_send", clauses: cs.map((c) => c.id), on: "always", per_item: true, approve_first: null, heading: "x", recipient: { from: "rows", words: "its owner's manager", field } }],
      values: [], missing: "", joining: [] });
    expect(planFindings(plan("store.people.email"), cs, ITEMS).join(" ")).toMatch(/not a field of a chosen source/);
    expect(planFindings(plan("n/a"), cs, ITEMS).join(" ")).toMatch(/recipient\.field/);
    expect(planFindings(plan("none"), cs, ITEMS).join(" ")).not.toMatch(/address/);
    expect(planFindings(plan("store.widgets.owner_email"), cs, ITEMS).join(" ")).not.toMatch(/address/);
    // Lowered: the field travels with the recipient, its reader prefix removed.
    expect(planToSpec(plan("store.widgets.owner_email"), cs, ITEMS).spec.values.find((v) => v.role === "recipient")).toMatchObject({ field: "owner_email" });
  });
});

describe("R17 · a call about ONE row: its identity comes from that row", () => {
  beforeEach(on); afterEach(off);
  // A reader whose rows declare their identity (a `key` column), and an action that pages about one row (a Key port).
  const KCAT: CatalogueSnapshot = { ...SYNTHETIC, refs: { ...SYNTHETIC.refs,
    "store.incidents": { kind: "operation", params: [], payload: { t: "Rows", of: { t: "Record", fields: { code: { t: "Key" }, prio: { t: "Text" }, owner_email: { t: "Address" } } } } },
    page: { kind: "tool", params: [{ name: "to", ty: { t: "Address" }, required: true }, { name: "key", ty: { t: "Key" }, required: true }], payload: { t: "Record", fields: { ok: { t: "Bool" } } } },
  } } as CatalogueSnapshot;
  const KITEMS: BuilderCatalogue = { items: Object.entries(KCAT.refs).map(([ref, r]) => ({ ref, kind: r.kind === "tool" ? ("tool" as const) : ("reader" as const), about: ref, params: r.params.map((p) => ({ name: p.name, about: "" })), fields: fieldsOf(r) })) };
  const GOAL = "if there are any P1 incidents page their owner";
  it("“if any P1 … page”: one page per P1 row, its key bound to that row's identity — nothing left open", () => {
    const cs = clauses(GOAL);
    const p: Plan = { sources: [{ ref: "store.incidents", clauses: cs.map((c) => c.id) }], each: null, rows: [], schedule: null,
      conditions: [{ quote: "if there are any P1 incidents", clauses: cs.map((c) => c.id), over: "any_row", where: [{ field: "store.incidents.prio", about: "", test: "equals", value: "P1" }], count: null }],
      actions: [{ ref: "page", quote: "page their owner", clauses: cs.map((c) => c.id), on: "if:0", per_item: false, approve_first: null, recipient: { from: "rows", words: "their owner", field: "store.incidents.owner_email" } }],
      values: [], missing: "", joining: [] };
    const { spec } = planToSpec(p, cs, KITEMS);
    const checked = checkSpec(spec, [GOAL], KITEMS);
    const r = solve(emptyFlow("t"), { spec: checked, cat: KCAT, answers: new Map(), base: [], drafts: "propose" });
    const call = r.flow.steps.find((s): s is Extract<S, { kind: "tool" }> => s.kind === "tool" && s.ref === "page")!;
    expect(call.over?.stepId).toBeTruthy();
    expect(call.inputs.find((i) => i.name === "key")?.source).toMatchObject({ field: "code" });
    expect(r.unmet.join(" ")).not.toMatch(/identity/);
    expect(errorsOf(checkState(r.flow, KCAT))).toEqual([]);
  });
  it("…and when the person WRITES the address: still one call per row (its identity from the row), sent to that address", () => {
    const goal = "if there are any P1 incidents page ops@acme-corp.com";
    const cs = clauses(goal);
    const p: Plan = { sources: [{ ref: "store.incidents", clauses: cs.map((c) => c.id) }], each: null, rows: [], schedule: null,
      conditions: [{ quote: "if there are any P1 incidents", clauses: cs.map((c) => c.id), over: "any_row", where: [{ field: "store.incidents.prio", about: "", test: "equals", value: "P1" }], count: null }],
      actions: [{ ref: "page", quote: "page ops@acme-corp.com", clauses: cs.map((c) => c.id), on: "if:0", per_item: false, approve_first: null, recipient: { from: "goal", words: "ops@acme-corp.com", field: "n/a" } }],
      values: [], missing: "", joining: [] };
    // (the neutral tool declares no address port, so the recipient the plan lowers onto one is written here as the plan would)
    const lowered = planToSpec(p, cs, KITEMS).spec;
    const checked = checkSpec({ ...lowered, values: [...lowered.values, { role: "recipient", from: "goal", quote: "ops@acme-corp.com", fills: "page.to" }] }, [goal], KITEMS);
    const r = solve(emptyFlow("t"), { spec: checked, cat: KCAT, answers: new Map(), base: [], drafts: "propose" });
    const call = r.flow.steps.find((s): s is Extract<S, { kind: "tool" }> => s.kind === "tool" && s.ref === "page")!;
    expect(call.over?.stepId).toBeTruthy();
    expect(call.inputs.find((i) => i.name === "key")?.source).toMatchObject({ field: "code" });
    expect(call.inputs.find((i) => i.name === "to")?.source).toMatchObject({ from: "literal", value: "ops@acme-corp.com" });
    expect(r.flow.holes).toEqual([]);
  });
});


describe("R24 · for each GROUP: the loop goes through the groups, each carrying its own address and rows", () => {
  beforeEach(on); afterEach(off);
  const GCAT: CatalogueSnapshot = { ...SYNTHETIC, refs: { ...SYNTHETIC.refs,
    mail_send: { ...SYNTHETIC.refs.mail_send!, params: SYNTHETIC.refs.mail_send!.params.map((p) => (p.name === "body" ? { ...p, message: true } : p.name === "subject" ? { ...p, heading: true } : p)) },
    chat_post: { ...SYNTHETIC.refs.chat_post!, params: SYNTHETIC.refs.chat_post!.params.map((p) => (p.name === "text" ? { ...p, message: true } : p)) },
    "store.tickets": { kind: "operation", params: [], payload: { t: "Rows", of: { t: "Record", fields: { code: { t: "Text" }, team: { t: "Text" }, team_email: { t: "Address" }, subject: { t: "Text" } } } } },
  } } as CatalogueSnapshot;
  const GITEMS: BuilderCatalogue = { items: Object.entries(GCAT.refs).map(([ref, r]) => ({ ref, kind: r.kind === "tool" ? ("tool" as const) : ("reader" as const), about: ref, params: r.params.map((p) => ({ name: p.name, about: "", ...(p.message ? { message: true } : {}), ...(p.heading ? { heading: true } : {}) })), fields: fieldsOf(r) })) };
  const GOAL = "for each team count the tickets; if a team has more than 5 email its contact the list, otherwise post the team's count in #ops";
  const plan = (groups: boolean): Plan => {
    const cs = clauses(GOAL), all = cs.map((c) => c.id);
    return { sources: [{ ref: "store.tickets", clauses: all }], each: { over: 0, clauses: all, groups }, rows: [], schedule: null,
      summary: { quote: "count the tickets", clauses: all, over: 0, by: [{ field: "store.tickets.team", words: "each team" }], measures: [{ fn: "count", field: "new_read", words: "count" }], sort: null, limit: "" },
      conditions: [{ quote: "if a team has more than 5", clauses: all, over: "each_item", where: [{ field: "summary:0", about: "", test: "above", value: "5" }], count: null }],
      actions: [
        { ref: "mail_send", quote: "email its contact the list", clauses: all, on: "if:0", per_item: true, approve_first: null, heading: "Team tickets", recipient: { from: "rows", words: "its contact", field: "store.tickets.team_email" }, sends: "rows" },
        { ref: "chat_post", quote: "post the team's count in #ops", clauses: all, on: "otherwise", per_item: true, approve_first: null, recipient: { from: "goal", words: "#ops", field: "n/a" }, sends: "computed" },
      ],
      values: [{ role: "channel", from: "goal", quote: "#ops", fills: "chat_post.channel", clauses: all }], missing: "", joining: [] };
  };
  const build = (groups: boolean) => {
    const cs = clauses(GOAL);
    const checked = checkSpec(planToSpec(plan(groups), cs, GITEMS).spec, [GOAL], GITEMS);
    return { checked, r: solve(emptyFlow("t"), { spec: checked, cat: GCAT, answers: new Map(), base: [], drafts: "propose" }) };
  };
  it("the loop is over the groups; the email goes to the group's own address with the group's own rows; the post shows the count", () => {
    const { checked, r } = build(true);
    expect(checked.dropped).toEqual([]);
    expect(errorsOf(checkState(r.flow, GCAT))).toEqual([]);
    const loop = r.flow.steps.find((s): s is Extract<S, { kind: "for_each" }> => s.kind === "for_each")!;
    // the list the loop goes through holds the group — keyed by team, its count, the team's address and its rows
    const lists = r.flow.steps.filter((s): s is Extract<S, { kind: "transform" }> => s.kind === "transform");
    const grouped = lists.find((s) => s.pipeline.some((c) => c.op === "group"))!;
    const g = grouped.pipeline.find((c) => c.op === "group") as { by: string[]; aggs: Array<{ as: string; fn: string; field?: string }> };
    expect(g.by).toEqual(["team"]);
    expect(g.aggs.map((a) => `${a.fn}:${a.as}`)).toEqual(expect.arrayContaining(["count:count", "first:team_email", "join:group_rows"]));
    const over = lists.find((s) => s.id === loop.over.stepId)!;
    expect(over.id === grouped.id || over.from === grouped.id).toBe(true);
    const mail = r.flow.steps.find((s): s is Extract<S, { kind: "tool" }> => s.kind === "tool" && s.ref === "mail_send")!;
    expect(mail.inputs.find((i) => i.name === "to")?.source).toMatchObject({ field: "team_email" });
    expect(mail.inputs.find((i) => i.name === "body")?.source).toMatchObject({ field: "group_rows" });
    // the post's message is the group's own fields — its team and its count — never the rows another action sends
    const post = r.flow.steps.find((s): s is Extract<S, { kind: "tool" }> => s.kind === "tool" && s.ref === "chat_post")!;
    const textField = (post.inputs.find((i) => i.name === "text")?.source as { field?: string } | undefined)?.field;
    const tmpl = lists.flatMap((s) => s.pipeline).find((c) => c.op === "template" && (c as { as: string }).as === textField) as { parts: Array<{ field?: string; opt?: string }> } | undefined;
    const shown = (tmpl?.parts ?? []).map((x) => x.field ?? x.opt).filter(Boolean);
    expect(shown).toEqual(expect.arrayContaining(["team", "count"]));
    expect(shown).not.toContain("group_rows");
    expect(r.unmet).toEqual([]);
  });
  it("CONTROL: without `groups` the loop goes through the rows themselves (the behaviour B20 showed)", () => {
    const { r } = build(false);
    const loop = r.flow.steps.find((s): s is Extract<S, { kind: "for_each" }> => s.kind === "for_each");
    const over = r.flow.steps.find((s) => s.id === loop?.over.stepId) as { pipeline?: Array<{ op: string }> } | undefined;
    expect(over?.pipeline?.some((c) => c.op === "group")).toBeFalsy();
  });
  it("`sends: computed` with no summary, and a for-each over groups with nothing grouped, are refused by the plan check", () => {
    const cs = clauses(GOAL);
    const p = plan(true);
    const f = planFindings({ ...p, summary: null }, cs, GITEMS).join(" ");
    expect(f).toMatch(/sends a number computed from the rows/);
    expect(f).toMatch(/groups by nothing/);
    // a right plan raises nothing: a summary measure IS a field of the condition (it re-asked a right plan, and the re-ask lost the test)
    expect(planFindings(p, cs, GITEMS)).toEqual([]);
    expect(planFindings({ ...p, conditions: [{ ...p.conditions[0]!, where: [{ field: "summary:3", about: "", test: "above", value: "5" }] }] }, cs, GITEMS).join(" ")).toMatch(/no such measure/);
  });
});

describe("R23 · units: a length of time is compared in the unit the number counts in", () => {
  it("“older than 3 days” on a count of MINUTES keeps rows above 4320 — never above 3; CONTROL: a number declaring no unit takes 3", async () => {
    const { condStages } = await import("./solver.js");
    const { TypeOf } = await import("@foundry/flow-edit");
    const mins = TypeOf.timeIn(TypeOf.int(), "minutes");
    expect(condStages("age_mins", mins, "above", "3 days", "older than 3 days")).toEqual([{ op: "filter", where: { cmp: "gt", left: { field: "age_mins" }, right: { lit: { value: 4320, from: "goal", quote: "older than 3 days" } } } }]);
    expect(condStages("age_mins", TypeOf.int(), "above", "3 days", "older than 3 days")).toEqual([{ op: "filter", where: { cmp: "gt", left: { field: "age_mins" }, right: { lit: { value: 3, from: "goal", quote: "older than 3 days" } } } }]);
    // a days-ago test on an AGE (a number counting minutes) is the age above the days in minutes; CONTROL: on a plain number it is no date
    expect(condStages("age_mins", mins, "older_than_days", "3", "older than 3 days")).toEqual([{ op: "filter", where: { cmp: "gt", left: { field: "age_mins" }, right: { lit: { value: 4320, from: "goal", quote: "older than 3 days" } } } }]);
    expect(condStages("age_mins", mins, "within_days", "7 days", "q")).toEqual([{ op: "filter", where: { cmp: "le", left: { field: "age_mins" }, right: { lit: { value: 10080, from: "goal", quote: "q" } } } }]);
    expect(condStages("age_mins", TypeOf.int(), "older_than_days", "3", "q")).toMatch(/not a date/);
    // working minutes cannot be read from calendar days: refused with why, never guessed
    expect(condStages("biz_mins", TypeOf.timeIn(TypeOf.int(), "business_minutes"), "above", "3 days", "q")).toMatch(/working minutes/);
  });
  it("a computed difference declares its own unit (minutes, working minutes, days); nothing else does", async () => {
    const { timeUnitOfCompute } = await import("../db-operation.service.js");
    expect(timeUnitOfCompute({ diffMinutes: { start: {}, end: {} } })).toBe("minutes");
    expect(timeUnitOfCompute({ businessMinutes: { start: {}, end: {} } })).toBe("business_minutes");
    expect(timeUnitOfCompute({ diffDays: {} })).toBe("days");
    expect(timeUnitOfCompute({ arith: {} })).toBeUndefined();
    const { operationFields } = await import("../flow-typecheck.js");
    const { renderType } = await import("@foundry/flow-edit");
    const f = operationFields([{ alias: "age_mins", source: "age_mins", type: "integer", nullable: false, unit: "minutes" }, { alias: "n", source: "count(t.id)", type: "bigint", nullable: false }], []);
    expect(renderType(f.age_mins!)).toBe("Int<minutes>");
    expect(renderType(f.n!)).toBe("Int");
  });
});

describe("P4-I4 · approving per item is NOT built yet: one approval, before the loop (builder-behaviour P5)", () => {
  const GOAL = "For each widget, if its qty is over 30 ask me to approve first and email its owner, otherwise post it to #ops";
  const spec: GoalSpec = {
    sources: [{ ref: "store.widgets", quote: "For each widget" }],
    sinks: [{ ref: "mail_send", quote: "email its owner" }, { ref: "chat_post", quote: "post it to #ops" }],
    values: [{ role: "recipient", from: "goal", quote: "its owner", fills: "mail_send.to", field: "owner_email" }, { role: "channel", from: "goal", quote: "#ops", fills: "chat_post.channel" }],
    conditions: [], schedule: null, missing: null,
  };
  const wiring: Wiring = {
    each: { quote: "For each widget", over: "reader:0" },
    paths: [{ quote: "if its qty is over 30", subject: "item", test: "compare", measure: "qty", cmp: "gt", value: "30", where: [{ field: "qty", test: "above", value: "30" }] }],
    actions: [{ takes: "item", path: 0, approve: "ask me to approve first", per: "item" }, { takes: "item", path: "otherwise", approve: null, per: "item" }],
  };
  const build = () => solve(emptyFlow("t"), { spec: checkSpec({ ...spec, wiring }, [GOAL], ITEMS), cat, answers: new Map(), base: [], drafts: "propose" });
  // Kestra v1.3.29 resumes an execution's FIRST paused task (its resume takes no taskrun id — measured 2026-10-04), so an item's
  // decision cannot be delivered to that item. Until it can, the approval stands before the loop and the readback says so.
  it("the gate stands before the loop, valid, and the readback says one decision covers all the items", async () => {
    const r = build();
    const { loopOfStep } = await import("@foundry/flow-edit");
    const gate = r.flow.steps.find((s) => s.kind === "approval")!;
    expect(loopOfStep(r.flow).get(gate.id)).toBeUndefined();
    expect(r.flow.steps.find((s) => s.kind === "for_each")!.dependsOn).toContain(gate.id);
    expect(errorsOf(checkState(r.flow, cat))).toEqual([]);
    const { wiringReadback } = await import("./wiring.js");
    const sp = checkSpec({ ...spec, wiring }, [GOAL], ITEMS).spec;
    expect(wiringReadback(sp.wiring, sp, ITEMS).join("\n")).toMatch(/once for all the items: a person approves them together, before any is done/);
  });
});

describe("E06 · a test of each item belongs to the loop's own read", () => {
  beforeEach(on); afterEach(off);
  const GOAL = "page the on call for every unresolved P1 incident, and open a ticket for every unresolved P2 incident";
  const cs = clauses(GOAL), all = cs.map((c) => c.id);
  const DS: BuilderCatalogue = { items: [...ITEMS.items, { ref: "ops.new_read", kind: "reader", about: "a new read of ops" }] };
  const plan = (about: string): Plan => ({ sources: [{ ref: "ops.new_read", clauses: all }, { ref: "ops.new_read", clauses: all }], each: { over: 0, clauses: all }, rows: [], schedule: null,
    conditions: [
      { quote: "for every unresolved P1 incident", clauses: all, over: "each_item", where: [{ field: "new_read", about, test: "equals", value: "P1" }], count: null },
      { quote: "for every unresolved P2 incident", clauses: all, over: "each_item", where: [{ field: "new_read", about, test: "equals", value: "P2" }], count: null },
    ],
    actions: [{ ref: "chat_post", clauses: all, on: "if:0", per_item: true, approve_first: null, recipient: { from: "goal", words: "#ops", field: "n/a" } }, { ref: "ticket_open", clauses: all, on: "if:1", per_item: true, approve_first: null, recipient: { from: "goal", words: "x", field: "n/a" } }],
    values: [], missing: "", joining: [] });
  it("with two new reads, the item's fact is a column of the LOOP's read — the conditions are kept", () => {
    const { spec } = planToSpec(plan("the incident priority"), cs, DS);
    const where = (spec.wiring?.paths ?? []).flatMap((p) => p.where ?? []);
    expect(where).toHaveLength(2);
    expect(where.every((t) => t.field !== "new_read")).toBe(true);
  });
  it("a test of a new read's field that says nothing of what it holds is refused by the plan check", () => {
    expect(planFindings(plan(""), cs, DS).join(" ")).toMatch(/says nothing of what the field holds/);
    expect(planFindings(plan("the incident priority"), cs, DS).join(" ")).not.toMatch(/says nothing of what/);
  });
});

describe("E06 · a read that 'covers' one alternative does not delete it", () => {
  beforeEach(on); afterEach(off);
  const GOAL = "For each widget, if its state is P1 post it to #ops, if its state is P2 open a ticket";
  const base: GoalSpec = {
    sources: [{ ref: "store.widgets", quote: "For each widget" }],
    sinks: [{ ref: "chat_post", quote: "post it to #ops" }, { ref: "ticket_open", quote: "open a ticket" }],
    values: [{ role: "channel", from: "goal", quote: "#ops", fills: "chat_post.channel" }], conditions: [], schedule: null, missing: null,
    covered: [{ quote: "if its state is P1", by: "store.widgets" }],
  } as GoalSpec;
  const path = (v: string) => ({ quote: `if its state is ${v}`, subject: "item" as const, test: "compare" as const, measure: "state", cmp: "eq" as const, value: v, where: [{ field: "state", test: "equals", value: v }] });
  it("two alternatives on the item: both kept; CONTROL: a single condition the read covers is dropped as before", () => {
    const two: Wiring = { each: { quote: "For each widget", over: "reader:0" }, paths: [path("P1"), path("P2")], actions: [{ takes: "item", path: 0, approve: null, per: "item" }, { takes: "item", path: 1, approve: null, per: "item" }] };
    expect(checkSpec({ ...base, wiring: two }, [GOAL], ITEMS).spec.wiring?.paths).toHaveLength(2);
    const one: Wiring = { ...two, paths: [path("P1")], actions: [{ takes: "item", path: 0, approve: null, per: "item" }, { takes: "item", path: null, approve: null, per: "item" }] };
    expect(checkSpec({ ...base, wiring: one }, [GOAL], ITEMS).dropped.map((d) => d.why).join(" ")).toMatch(/already gives only those rows/);
  });
});

describe("R17 · a read whose rows feed a call about one row returns the row's identity", () => {
  it("the contract says so, by the schema owner's word; CONTROL: no such call, no such line", async () => {
    const { readContract, contractText } = await import("./read-contract.js");
    const s: GoalSpec = { sources: [{ ref: "ops.new_read", quote: "every unresolved incident" }], sinks: [], values: [], conditions: [], schedule: null, missing: null };
    expect(contractText(readContract(s, "ops.new_read", ["x"], undefined, true))).toMatch(/IDENTITY.*declared: key/);
    expect(contractText(readContract(s, "ops.new_read", ["x"]))).not.toMatch(/IDENTITY/);
  });
});

describe("E04/E06 · an edit does not ask again about words its automation already implements", () => {
  it("settledWords: every quote a revision's spec placed, never one it left unclear", async () => {
    const { settledWords } = await import("./builder.service.js");
    const spec = { sources: [{ ref: "r", quote: "every unresolved P1 incident" }], sinks: [{ ref: "t", quote: "page the on call" }], values: [], conditions: [], schedule: null, missing: null,
      wiring: { each: { quote: "for each one", over: "reader:0" }, paths: [], actions: [] }, unclear: [{ quote: "the usual report", about: "value" }] };
    expect(settledWords({ spec }).sort()).toEqual(["every unresolved P1 incident", "for each one", "page the on call"]);
    expect(settledWords(null)).toEqual([]);
  });
  it("understand: a plain unclear word inside a settled quote is dropped, stated; CONTROL: with nothing settled it is asked", async () => {
    process.env.BUILDER_INPUTS = "1";
    try {
      const { understand } = await import("./builder.service.js");
      const goal = "page the on call for every unresolved P1 incident";
      const plan = { sources: [{ ref: "store.widgets", quote: "every unresolved P1 incident", clauses: ["C1"] }], each: null, rows: [], schedule: null, conditions: [],
        actions: [{ ref: "chat_post", quote: "page the on call", clauses: ["C1"], on: "always", per_item: false, approve_first: null, heading: "x", message: "", recipient: { from: "goal", words: "#ops", field: "n/a" }, sends: "words" }],
        values: [], unclear: [{ quote: "unresolved", about: "value" }], missing: "", joining: [], inputs: [], spelling: [], summary: null };
      const chooser = async (_p: string, s: { name: string }) => (s.name === "goal_plan" ? JSON.stringify(plan) : "{}");
      const asked = await understand(goal, ITEMS, chooser as never);
      expect(asked.checked.spec.unclear?.map((u) => u.quote)).toContain("unresolved");
      const quiet = await understand(goal, ITEMS, chooser as never, undefined, undefined, undefined, undefined, undefined, ["for every unresolved P1 incident"]);
      expect((quiet.checked.spec.unclear ?? []).map((u) => u.quote)).not.toContain("unresolved");
      expect(quiet.readback.join(" ")).toMatch(/“unresolved” — as the automation already has it/);
    } finally { delete process.env.BUILDER_INPUTS; }
  });
});

describe("B23 · the read's own words stay the read's", () => {
  it("an action phrase that repeats the read's quote owns only its own words", async () => {
    const { readContract } = await import("./read-contract.js");
    const s: GoalSpec = { sources: [{ ref: "o.new_read", quote: "each customer their loyalty points balance" }], sinks: [{ ref: "mail_send", quote: "email each customer their loyalty points balance" }], values: [], conditions: [], schedule: null, missing: null };
    expect(readContract(s, "o.new_read", ["x"]).owned).toEqual(["email"]);
  });
});

describe("E01 · a change planned again whole keeps every action it did not remove", () => {
  it("an action the restatement left out — and did not say it removes — is reported; one it removes may go", async () => {
    const { lostActions, actionsOf } = await import("./conversation.js");
    const start = { id: "t", inputs: [], holes: [], steps: [
      { id: "post", kind: "tool", ref: "chat_post", inputs: [], dependsOn: [] },
      { id: "mail", kind: "tool", ref: "mail_send", inputs: [], dependsOn: [] },
    ] } as unknown as EFlow;
    const prev = { sinks: [{ ref: "chat_post", quote: "post the open urgent tickets to #support-escalations" }, { ref: "mail_send", quote: "also email me the same list" }] } as GoalSpec;
    expect(actionsOf(start, prev)).toEqual([{ key: "A1", ref: "chat_post", words: "post the open urgent tickets to #support-escalations" }, { key: "A2", ref: "mail_send", words: "also email me the same list" }]);
    const now = { sources: [], sinks: [{ ref: "mail_send", quote: "email me the list" }], values: [], conditions: [], schedule: null, missing: null } as GoalSpec;
    expect(lostActions(start, now, prev, [])).toEqual(["post the open urgent tickets to #support-escalations"]);
    expect(lostActions(start, now, prev, ["chat_post"])).toEqual([]);
    // CONTROL: nothing lost, nothing reported
    expect(lostActions(start, { ...now, sinks: prev.sinks }, prev, [])).toEqual([]);
  });
});

describe("P7 (B23): words a read cannot give, standing together in the text, are ONE missing thing", () => {
  const gap = (words: string) => ({ words, why: `no ${words}` });
  it("three adjacent words are one entry, in the person's own words, with each reason", () => {
    const got = oneGapPerPhrase([gap("points"), gap("loyalty"), gap("balance")], ["email each member their Loyalty points balance"]);
    expect(got).toEqual([{ words: "Loyalty points balance", why: "no loyalty; no points; no balance" }]);
  });
  it("CONTROL: words separated by a comma, `and` or another word stay apart (a list is several things)", () => {
    expect(oneGapPerPhrase([gap("name"), gap("address")], ["send them their name, address"])).toHaveLength(2);
    expect(oneGapPerPhrase([gap("fines"), gap("holds")], ["tell them their fines and holds"])).toHaveLength(2);
    expect(oneGapPerPhrase([gap("fines"), gap("holds")], ["fines for overdue holds"])).toHaveLength(2);
  });
  it("CONTROL: a word is matched whole (\"points\" is not inside \"appointments\"), and one the text lacks is kept as it is", () => {
    expect(oneGapPerPhrase([gap("points"), gap("balance")], ["appointments balance"])).toHaveLength(2);
    expect(oneGapPerPhrase([gap("tier")], ["email each member"])).toEqual([gap("tier")]);
  });
});

describe("P7 (B20, cp3): an age tested against a GIVEN input is judged as the solver lowers it", () => {
  // The goal states "3 days" as an input (given): the solver lowers its words exactly as a literal — `age_mins` above 4320 minutes —
  // and the spec match must want the same, or a right build is thrown out as "a builder bug" (cp3 B20 ended `error`).
  it("the spec match wants the age above N days IN ITS UNIT; CONTROL: an age in the wrong unit is still refused", async () => {
    const { specMatch } = await import("./spec-match.js");
    const { TypeOf } = await import("@foundry/flow-edit");
    const spec = {
      sources: [{ ref: "store.ages", quote: "the tickets" }], sinks: [], values: [], conditions: [], covered: [],
      inputs: [{ id: "in_age", kind: "number", words: "3 days", fill: "given", clauses: [] }],
      shapes: [{ over: "store.ages", quote: "older than 3 days", stages: [{ op: "filter", field: "store.ages.age_mins", test: "older_than_days", value: "input:in_age", quote: "older than 3 days" }] }],
    } as unknown as GoalSpec;
    const model = (n: number) => ({ steps: [{ id: "read", kind: "datasource", ref: "store.ages" }, { id: "where_1", kind: "transform", expr: `{{ outputs.read | jq('[.[] | select((.age_mins > ${n}))]') }}` }] });
    const ty = (f: string) => (f.endsWith("age_mins") ? TypeOf.timeIn(TypeOf.int(), "minutes") : undefined);
    const stored = { goalSpec: { spec }, trace: { base: [] } };
    expect(specMatch(model(4320), stored, undefined, ty as never)).toEqual([]);
    expect(specMatch(model(3), stored, undefined, ty as never).join(" ")).toMatch(/age_mins/);
  });
});
