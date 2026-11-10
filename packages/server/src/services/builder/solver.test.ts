/**
 * The solver (phase 5, D-322) on the synthetic catalogue, where each goal's right flow is known by construction. No model: the spec
 * is written here as a confirmed spec would be. Every move must be code's, every state valid, and what the solver could not decide
 * must be a question (a port) or a stated gap — never a guess.
 */
import { describe, expect, it } from "vitest";
import { apply, checkState, emptyFlow, errorsOf, SYNTHETIC, type CatalogueSnapshot, type EFlow } from "@foundry/flow-edit";
import { checkSpec, type BuilderCatalogue, type GoalSpec } from "./goal-spec.js";
import { solve, type Draft } from "./solver.js";
import { emptyTrace, keyHole, questionsFor } from "./build.js";
import { partQuestion } from "./conversation.js";

const cat = SYNTHETIC;
const T_TEXT = { t: "Text" } as never;
const T_LIST_ADDR = { t: "List", of: { t: "Address" } } as never;
const fieldsOf = (r: CatalogueSnapshot["refs"][string]) => (r.kind === "tool" ? [] : Object.keys((r.payload as { of: { fields: Record<string, unknown> } }).of.fields).map((name) => ({ name, ty: "" })));
const ITEMS: BuilderCatalogue = { items: Object.entries(cat.refs).map(([ref, r]) => ({ ref, kind: r.kind === "tool" ? ("tool" as const) : ("reader" as const), about: ref, params: r.params.map((p) => ({ name: p.name, about: "" })), fields: fieldsOf(r) })) };
const spec = (goal: string, s: Partial<GoalSpec>, c: CatalogueSnapshot = cat) =>
  checkSpec({ sources: [], sinks: [], values: [], conditions: [], schedule: null, missing: null, ...s }, [goal], c === cat ? ITEMS : { items: Object.entries(c.refs).map(([ref, r]) => ({ ref, kind: r.kind === "tool" ? ("tool" as const) : ("reader" as const), about: ref, params: r.params.map((p) => ({ name: p.name, about: "" })), fields: fieldsOf(r) })) });
const run = (goal: string, s: Partial<GoalSpec>, answers = new Map<number, string>(), c: CatalogueSnapshot = cat) => {
  const r = solve(emptyFlow("t"), { spec: spec(goal, s, c), cat: c, answers, base: [] });
  expect(errorsOf(checkState(r.flow, c))).toEqual([]); // valid at every end state, whatever was left open
  expect(r.moves.every((m) => m.chooser === "code")).toBe(true);
  return r;
};
const step = (f: EFlow, id: string) => f.steps.find((s) => s.id === id) as unknown as { ref?: string; over?: { stepId: string }; inputs: Array<{ name: string; source: unknown }> };
// Bindings in their STORED shape: `{from: "step"|"whole"|"literal"|"input"}`, a literal's provenance beside it.
const binding = (f: EFlow, id: string, port: string) => step(f, id)?.inputs.find((b) => b.name === port) as { source: unknown; provenance?: { from: string } } | undefined;
const input = (f: EFlow, id: string, port: string) => binding(f, id, port)?.source;

describe("the solver (phase 5 task 1, D-322)", () => {
  it("send ME the widgets as of a date: the date from the person's words, the data as the text, the recipient left to the requester", () => {
    const g = "send me the widget codes as of 2026-06-30";
    const r = run(g, {
      sources: [{ ref: "store.widgets", quote: "the widget codes" }], sinks: [{ ref: "notify_me", quote: "send me" }],
      values: [{ role: "date", from: "goal", quote: "2026-06-30", fills: "store.widgets.as_of" }, { role: "recipient", from: "requester", quote: "me", fills: "notify_me.to" }],
    });
    expect(r.flow.holes).toEqual([]);
    expect(binding(r.flow, "read_1", "as_of")).toMatchObject({ source: { from: "literal", value: "2026-06-30" }, provenance: { from: "goal" } });
    expect(input(r.flow, "call_1", "text")).toMatchObject({ from: "whole", stepId: "read_1" });
    expect(input(r.flow, "call_1", "to")).toBeUndefined(); // the receiver sends it to whoever ran it
    expect(r.flow.output).toEqual({ stepId: "read_1" });
  });

  it("email EVERYONE in a list: the address comes from the data, one email per row, over the smallest bound the engine needs", () => {
    const g = "email everyone in store people their note with subject Weekly note";
    const r = run(g, {
      sources: [{ ref: "store.people", quote: "everyone in store people" }], sinks: [{ ref: "mail_send", quote: "email" }],
      values: [{ role: "recipient", from: "goal", quote: "everyone", fills: "mail_send.to" }, { role: "subject", from: "goal", quote: "Weekly note", fills: "mail_send.subject" }],
    });
    expect(step(r.flow, "shape_1")).toMatchObject({ from: "read_1" });
    expect(step(r.flow, "call_1").over).toEqual({ stepId: "shape_1", field: "" });
    expect(input(r.flow, "call_1", "to")).toMatchObject({ from: "step", stepId: "shape_1", field: "email" });
    expect(input(r.flow, "call_1", "subject")).toMatchObject({ from: "literal", value: "Weekly note" });
    // The body of a PER-ROW email is not the whole list as text: nobody said what it says, so it is the person's question.
    expect(r.flow.holes.map((h) => h.id)).toEqual(["h_call_1_body"]);
  });

  it("a model summary: the data as its input, and its model-written output is the result (the deliverable)", () => {
    const r = run("summarise the totals for 2026-05", {
      sources: [{ ref: "store.by_month", quote: "the totals" }], sinks: [{ ref: "llm_complete", quote: "summarise" }],
      values: [{ role: "period", from: "goal", quote: "2026-05", fills: "store.by_month.period" }],
    });
    expect(input(r.flow, "read_1", "period")).toMatchObject({ from: "literal", value: "2026-05" });
    expect(input(r.flow, "call_1", "input")).toMatchObject({ from: "whole", stepId: "read_1" });
    expect(r.flow.output).toEqual({ stepId: "call_1" });
    expect(r.flow.holes).toEqual([]);
  });

  it("a value asked each run becomes a run input of the port's own type", () => {
    const r = run("summarise the totals for a month I pick each time", {
      sources: [{ ref: "store.by_month", quote: "the totals" }], sinks: [{ ref: "llm_complete", quote: "summarise" }],
      values: [{ role: "period", from: "flow_input", quote: "a month I pick each time", fills: "store.by_month.period" }],
    });
    expect(r.flow.inputs).toEqual([expect.objectContaining({ id: "period_1", type: "STRING", format: "month" })]);
    expect(input(r.flow, "read_1", "period")).toMatchObject({ from: "input", inputId: "period_1" });
  });


  it("NEGATIVE CONTROL: take away the column the address would come from, and the same goal is a stated gap naming it", () => {
    const noEmail: CatalogueSnapshot = { ...cat, refs: { ...cat.refs, "store.people": { ...cat.refs["store.people"]!, payload: { t: "Rows", of: { t: "Record", fields: { name: { t: "Text" }, team: { t: "Option", of: { t: "Text" } } } } } as never } } };
    const r = run("email everyone in store people", {
      sources: [{ ref: "store.people", quote: "everyone in store people" }], sinks: [{ ref: "mail_send", quote: "email" }],
      values: [{ role: "recipient", from: "goal", quote: "everyone", fills: "mail_send.to" }],
    }, new Map(), noEmail);
    expect(r.gaps.join(" ")).toMatch(/`mail_send`'s `to` should come from the data \(“everyone”\), but no row here carries an address/);
    expect(step(r.flow, "call_1").over).toBeUndefined();
  });

  it("D-325: a NULLABLE address — the rows with none are SKIPPED, stated, and kept in a step of their own; never forced, never dropped unseen", () => {
    const r = run("email the widgets to their owners as of 2026-06-30", {
      sources: [{ ref: "store.widgets", quote: "the widgets" }], sinks: [{ ref: "mail_send", quote: "email" }],
      values: [{ role: "date", from: "goal", quote: "2026-06-30", fills: "store.widgets.as_of" }, { role: "recipient", from: "goal", quote: "their owners", fills: "mail_send.to" }],
    });
    const shape = r.flow.steps.find((x) => x.id === "shape_1") as unknown as { from: string; pipeline: Array<{ op: string; where?: unknown }> };
    expect(shape.pipeline[0]).toEqual({ op: "filter", where: { notNull: "owner_email" } });
    expect(step(r.flow, "call_1").over).toEqual({ stepId: "shape_1", field: "" });
    expect(input(r.flow, "call_1", "to")).toMatchObject({ from: "step", stepId: "shape_1", field: "owner_email" });
    const unreached = r.flow.steps.find((x) => x.id === "unreached_1") as unknown as { from: string; pipeline: unknown[] };
    expect(unreached).toMatchObject({ from: "read_1", pipeline: [{ op: "filter", where: { isNull: "owner_email" } }] });
    expect(r.skips).toEqual([{ reader: "read_1", field: "owner_email" }]);
    expect(r.unmet).toEqual([]);
    // An ALWAYS-present address (store.people.email) skips nothing.
    const people = run("email everyone in store people with subject Weekly note", { sources: [{ ref: "store.people", quote: "everyone in store people" }], sinks: [{ ref: "mail_send", quote: "email" }], values: [{ role: "recipient", from: "goal", quote: "everyone", fills: "mail_send.to" }] });
    expect(people.skips).toEqual([]);
    expect(people.flow.steps.some((x) => x.id.startsWith("unreached"))).toBe(false);
  });

  it("continuable: run again on its own result, it adds nothing (the spec is met) — the question rounds never rebuild", () => {
    const s = spec("send me the widget codes as of 2026-06-30", { sources: [{ ref: "store.widgets", quote: "the widget codes" }], sinks: [{ ref: "notify_me", quote: "send me" }], values: [{ role: "date", from: "goal", quote: "2026-06-30", fills: "store.widgets.as_of" }] });
    const first = solve(emptyFlow("t"), { spec: s, cat, answers: new Map(), base: [] });
    const again = solve(first.flow, { spec: s, cat, answers: new Map(), base: [] });
    expect(again.moves).toEqual([]);
    expect(again.flow).toEqual(first.flow);
  });

  // D-323: a constant the catalogue STATES ("Use 'staff'") is bound from the catalogue — never asked, never guessed.
  const withDefault = (ty = T_TEXT, dflt = "staff"): CatalogueSnapshot => ({ ...cat, refs: { ...cat.refs, "store.people": { ...cat.refs["store.people"]!, params: [{ name: "kind", ty, required: true, default: dflt }] } } });
  const PEOPLE = { sources: [{ ref: "store.people", quote: "the people" }], sinks: [{ ref: "llm_complete", quote: "summarise" }] };

  it("a parameter nobody mentioned with a catalogue-STATED value is bound to it, provenance `catalogue` — not asked", () => {
    const r = run("summarise the people", PEOPLE, new Map(), withDefault());
    expect(binding(r.flow, "read_1", "kind")).toMatchObject({ source: { from: "literal", value: "staff" }, provenance: { from: "catalogue" } });
    expect(r.flow.holes).toEqual([]);
  });

  it("the person's words win over the catalogue's value; a default that does not fit the port is a question, never forced", () => {
    const said = run("summarise the people of kind contractor", { ...PEOPLE, values: [{ role: "other", from: "goal", quote: "contractor", fills: "store.people.kind" }] }, new Map(), withDefault());
    expect(binding(said.flow, "read_1", "kind")).toMatchObject({ source: { from: "literal", value: "contractor" }, provenance: { from: "goal" } });
    const stale = run("summarise the people", PEOPLE, new Map(), withDefault({ t: "Int" } as never, "staff"));
    expect(input(stale.flow, "read_1", "kind")).toBeUndefined();
    expect(stale.flow.holes.map((h) => h.id)).toContain("h_read_1_kind");
  });

  it("the ENGINE refuses a `catalogue` literal the catalogue does not state — the provenance is checked, not trusted", () => {
    const c = withDefault();
    const read = apply(emptyFlow("t"), { op: "add_reader", id: "read_1", ref: "store.people" }, c);
    if (!read.ok) throw new Error(read.error);
    const bind = (value: string) => apply(read.flow, { op: "bind", stepId: "read_1", port: "kind", source: { from: "literal", value, provenance: "catalogue" } }, c);
    expect(bind("staff").ok).toBe(true);
    expect(bind("contractor")).toMatchObject({ ok: false, error: expect.stringMatching(/catalogue's value for `kind` is `staff`/) });
    const none = apply(emptyFlow("t"), { op: "add_reader", id: "read_1", ref: "store.by_month" }, cat);
    if (!none.ok) throw new Error(none.error);
    expect(apply(none.flow, { op: "bind", stepId: "read_1", port: "period", source: { from: "literal", value: "2026-05", provenance: "catalogue" } }, cat)).toMatchObject({ ok: false, error: expect.stringMatching(/states no value/) });
  });

  it("a tool's DECLARED data port takes the data; its instruction takes the person's words — nothing asked (2026-09-27)", () => {
    const writer = { kind: "tool" as const, modelText: true, params: [{ name: "input", ty: { t: "Text" } as never, required: true, data: true }, { name: "instruction", ty: { t: "Text" } as never, required: true }], payload: { t: "Record", fields: { text: { t: "Text" } } } as never };
    const c: CatalogueSnapshot = { ...cat, refs: { ...cat.refs, writer } };
    const goal = "the people in store people, as a well structured report";
    const r = run(goal, { sources: [{ ref: "store.people", quote: "the people in store people" }], sinks: [{ ref: "writer", quote: "a well structured report" }], values: [{ role: "text", from: "goal", quote: "a well structured report", fills: "writer.instruction" }] }, new Map(), c);
    const call = r.flow.steps.find((s) => s.kind === "tool") as unknown as { inputs: Array<{ name: string; source: { from: string; value?: string } }> };
    expect(call.inputs.find((b) => b.name === "input")?.source.from).toBe("whole");
    expect(call.inputs.find((b) => b.name === "instruction")?.source).toMatchObject({ from: "literal", value: "a well structured report" });
    expect(r.flow.holes.filter((h) => h.site.at === "port")).toEqual([]);
  });

  it("a reader parameter named for the column the goal's words filter on takes those words — never asked (2026-09-27)", () => {
    const c: CatalogueSnapshot = { ...cat, refs: { ...cat.refs, "store.by_state": { kind: "operation", params: [{ name: "state", ty: { t: "Text" } as never, required: true }], payload: { t: "Rows", of: { t: "Record", fields: { state: { t: "Text" }, code: { t: "Text" } } } } as never } } };
    const goal = "the done ones in store by state";
    const r = run(goal, { sources: [{ ref: "store.by_state", quote: "store by state" }], shapes: [{ over: "store.by_state", stages: [{ op: "filter", quote: "the done ones", field: "store.by_state.state", test: "equals", value: "done" } as never] }] }, new Map(), c);
    expect(step(r.flow, "read_1").inputs).toEqual([{ name: "state", source: { from: "literal", value: "done" }, provenance: { from: "goal" } }]);
    expect(r.flow.holes.filter((h) => h.site.at === "port")).toEqual([]);
  });

  it("a goal that only READS is complete — its result is the data (2026-09-27); a condition the solver does not build is unmet", () => {
    const readOnly = run("the widget codes as of 2026-06-30", { sources: [{ ref: "store.widgets", quote: "the widget codes" }], values: [{ role: "date", from: "goal", quote: "2026-06-30", fills: "store.widgets.as_of" }] });
    expect(readOnly.flow.holes).toEqual([]);
    expect(readOnly.unmet).toEqual([]);
    expect(readOnly.flow.steps.some((s) => s.kind === "tool")).toBe(false); // nothing added that the goal did not ask for
    const cond = run("send me the widget codes as of 2026-06-30 if any are overdue", {
      sources: [{ ref: "store.widgets", quote: "the widget codes" }], sinks: [{ ref: "notify_me", quote: "send me" }],
      values: [{ role: "date", from: "goal", quote: "2026-06-30", fills: "store.widgets.as_of" }], conditions: [{ quote: "if any are overdue" } as never],
    });
    expect(cond.unmet).toEqual([expect.stringMatching(/condition “if any are overdue” is not built/)]);
    // A condition the chosen reader ALREADY applies (its rows are exactly those) is met by reading it — nothing to build.
    const byReader = run("send me the widget codes as of 2026-06-30 if any are overdue", {
      sources: [{ ref: "store.widgets", quote: "the widget codes" }], sinks: [{ ref: "notify_me", quote: "send me" }],
      values: [{ role: "date", from: "goal", quote: "2026-06-30", fills: "store.widgets.as_of" }], conditions: [{ quote: "if any are overdue", by: "store.widgets" }],
    });
    expect(byReader.unmet).toEqual([]);
    // Claimed for a reader the goal does NOT read: the claim is dropped, stated, and the flow must apply it.
    const elsewhere = spec("send me the widget codes as of 2026-06-30 if any are overdue", {
      sources: [{ ref: "store.widgets", quote: "the widget codes" }], sinks: [{ ref: "notify_me", quote: "send me" }], conditions: [{ quote: "if any are overdue", by: "store.people" }],
    });
    expect(elsewhere.spec.conditions).toEqual([{ quote: "if any are overdue", by: "the_flow" }]);
    expect(elsewhere.dropped).toContainEqual(expect.objectContaining({ what: "condition “if any are overdue” → store.people" }));
    const done = run("send me the widget codes as of 2026-06-30", { sources: [{ ref: "store.widgets", quote: "the widget codes" }], sinks: [{ ref: "notify_me", quote: "send me" }], values: [{ role: "date", from: "goal", quote: "2026-06-30", fills: "store.widgets.as_of" }] });
    expect(done.unmet).toEqual([]);
  });

  // D-324: a per-row message nobody stated is a TEMPLATE of the row's own fields, drafted by code and confirmed in the readback.
  const withMessage: CatalogueSnapshot = { ...cat, refs: { ...cat.refs, mail_send: { ...cat.refs.mail_send!, params: cat.refs.mail_send!.params.map((p) => (p.name === "body" ? { ...p, message: true } : p)) } } };
  const EMAIL_ALL = { sources: [{ ref: "store.people", quote: "everyone in store people" }], sinks: [{ ref: "mail_send", quote: "email" }], values: [{ role: "recipient" as const, from: "goal" as const, quote: "everyone", fills: "mail_send.to" }, { role: "subject" as const, from: "goal" as const, quote: "Weekly note", fills: "mail_send.subject" }] };
  const G = "email everyone in store people with subject Weekly note";
  const solveWith = (drafts?: "propose" | Draft[]) => {
    const r = solve(emptyFlow("t"), { spec: spec(G, EMAIL_ALL, withMessage), cat: withMessage, answers: new Map(), base: [], ...(drafts ? { drafts } : {}) });
    expect(errorsOf(checkState(r.flow, withMessage))).toEqual([]);
    return r;
  };

  it("D-324: a per-row message nobody stated is drafted from the row's fields — never the address — and bound, not asked", () => {
    const r = solveWith("propose");
    expect(r.drafts).toEqual([expect.objectContaining({ ref: "mail_send", port: "body", text: "Name: {name} · Team: {team} · Score: {score}" })]);
    expect(r.drafts[0]!.text).not.toMatch(/email/);
    expect(input(r.flow, "call_1", "body")).toMatchObject({ from: "step", stepId: "shape_1", field: "body_text" });
    expect(r.flow.holes).toEqual([]);
  });

  it("D-324: the address the message is SENT to is never in its text — even when that column is typed as plain text", async () => {
    const { draftParts, partsText } = await import("./solver.js");
    const text = partsText(draftParts({ name: { t: "Text" }, contact: { t: "Text" }, amount: { t: "Number" } } as never, "contact"));
    expect(text).toBe("Name: {name} · Amount: {amount}");
  });

  it("D-324: the build places EXACTLY the confirmed template; with none confirmed, the message is the person's question", () => {
    const mine: Draft = { ref: "mail_send", port: "body", parts: [{ text: "Hello " }, { field: "name" }], text: "Hello {name}" };
    const r = solveWith([mine]);
    expect(r.drafts).toEqual([{ ...mine, sink: 0 }]); // each draft is its action's (two actions on one tool have their own)
    const shape = r.flow.steps.find((x) => x.id === "shape_1") as unknown as { pipeline: Array<{ op: string; parts?: unknown }> };
    expect(shape.pipeline.find((st) => st.op === "template")).toMatchObject({ parts: mine.parts });
    const none = solveWith([]);
    expect(none.drafts).toEqual([]);
    expect(none.flow.holes.map((h) => h.id)).toEqual(["h_call_1_body"]);
  });

  it("I-300: a recipient the person NAMED is never quietly the requester — from the data, or unmet", () => {
    const NOTIFY = { sources: [{ ref: "store.people", quote: "everyone in store people" }], sinks: [{ ref: "notify_me", quote: "tell" }] };
    // Named in the goal's words: from the data.
    const named = run("tell everyone in store people", { ...NOTIFY, values: [{ role: "recipient", from: "goal", quote: "everyone", fills: "notify_me.to" }] });
    expect(step(named.flow, "call_1").over).toBeDefined();
    expect(input(named.flow, "call_1", "to")).toMatchObject({ from: "step", field: "email" });
    expect(named.unmet).toEqual([]);
    // No row carries an address: unmet, never sent to whoever runs it.
    const noEmail: CatalogueSnapshot = { ...cat, refs: { ...cat.refs, "store.people": { ...cat.refs["store.people"]!, payload: { t: "Rows", of: { t: "Record", fields: { name: { t: "Text" } } } } as never } } };
    const none = run("tell everyone in store people", { ...NOTIFY, values: [{ role: "recipient", from: "goal", quote: "everyone", fills: "notify_me.to" }] }, new Map(), noEmail);
    expect(none.unmet).toEqual([expect.stringMatching(/says who receives `call_1.to` \(“everyone”\), but no row here carries an address/)]);
    // …and STILL unmet when the solver runs again on its own result (a later question round places nothing — D04, 2026-09-27).
    const s2 = spec("tell everyone in store people", { ...NOTIFY, values: [{ role: "recipient", from: "goal", quote: "everyone", fills: "notify_me.to" }] }, noEmail);
    const again = solve(none.flow, { spec: s2, cat: noEmail, answers: new Map(), base: [] });
    expect(again.moves).toEqual([]);
    expect(again.unmet).toEqual([expect.stringMatching(/says who receives `call_1.to` \(“everyone”\)/)]);
    // Confirmed as the recipient but mapped to no parameter: still this action's recipient (the one action that sends).
    const loose = run("tell everyone in store people", { ...NOTIFY, values: [{ role: "recipient", from: "goal", quote: "everyone", fills: "none" }] });
    expect(step(loose.flow, "call_1").over).toBeDefined();
    const looseNone = run("tell everyone in store people", { ...NOTIFY, values: [{ role: "recipient", from: "goal", quote: "everyone", fills: "none" }] }, new Map(), noEmail);
    expect(looseNone.unmet).toEqual([expect.stringMatching(/says who receives `call_1.to`/)]);
    // The tether_email_send shape: `to` falls back to the requester AND an optional `cc` exists. A recipient the spec maps to `to`
    // is looked for on `to` — not on `cc` because `cc` does not fall back.
    const withCc: CatalogueSnapshot = { ...cat, refs: { ...cat.refs, notify_me: { ...cat.refs.notify_me!, params: [...cat.refs.notify_me!.params, { name: "cc", ty: T_LIST_ADDR, required: false, liftsScalar: true }] } } };
    const toNotCc = run("tell everyone in store people", { ...NOTIFY, values: [{ role: "recipient", from: "goal", quote: "everyone", fills: "notify_me.to" }] }, new Map(), withCc);
    expect(input(toNotCc.flow, "call_1", "to")).toMatchObject({ from: "step", field: "email" });
    // "me" is still the requester — nothing unmet.
    const me = run("tell me about everyone in store people", { ...NOTIFY, values: [{ role: "recipient", from: "requester", quote: "me", fills: "notify_me.to" }] });
    expect(me.unmet).toEqual([]);
  });

  describe("D-326: a condition the FLOW applies — a filter over the reader, from the goal's own words or none", () => {
    const W = { sources: [{ ref: "store.widgets", quote: "the widgets" }], sinks: [{ ref: "notify_me", quote: "send me" }], values: [{ role: "date" as const, from: "goal" as const, quote: "2026-06-30", fills: "store.widgets.as_of" }, { role: "recipient" as const, from: "requester" as const, quote: "me", fills: "notify_me.to" }] };
    const where = (f: EFlow) => f.steps.find((x) => x.id === "where_1") as unknown as { from: string; pipeline: Array<{ op: string; where: unknown }> } | undefined;
    it("a flag: rows where it is true; the action reads the FILTERED rows, never the raw ones", () => {
      const r = run("send me the widgets as of 2026-06-30 that are active", { ...W, conditions: [{ quote: "that are active", by: "the_flow", field: "store.widgets.active", test: "is_true", value: "" }] });
      expect(where(r.flow)).toMatchObject({ from: "read_1", pipeline: [{ op: "filter", where: { cmp: "eq", left: { field: "active" }, right: { lit: { value: true, from: "goal" } } } }] });
      expect(input(r.flow, "call_1", "text")).toMatchObject({ from: "whole", stepId: "where_1" });
      expect(r.unmet).toEqual([]);
    });
    it("a value the goal QUOTES, and a number on a maybe-empty field (narrowed first — ordering a null is a type error)", () => {
      const eq = run("send me the widgets as of 2026-06-30 in state open", { ...W, conditions: [{ quote: "in state open", by: "the_flow", field: "store.widgets.state", test: "equals", value: "open" }] });
      expect(where(eq.flow)!.pipeline).toEqual([{ op: "filter", where: { cmp: "eq", left: { field: "state" }, right: { lit: { value: "open", from: "goal", quote: "in state open" } } } }]);
      const gt = run("send me the widgets as of 2026-06-30 heavier than 5kg", { ...W, conditions: [{ quote: "heavier than 5kg", by: "the_flow", field: "store.widgets.weight", test: "above", value: "5kg" }] });
      expect(where(gt.flow)!.pipeline).toEqual([{ op: "filter", where: { notNull: "weight" } }, { op: "filter", where: { cmp: "gt", left: { field: "weight" }, right: { lit: { value: 5, from: "goal", quote: "heavier than 5kg" } } } }]);
      expect(gt.unmet).toEqual([]);
    });
    it("a value the goal does NOT say is never supplied: the test is dropped, stated, and the condition is unmet", () => {
      const s = spec("send me the widgets as of 2026-06-30 that are running late", { ...W, conditions: [{ quote: "that are running late", by: "the_flow", field: "store.widgets.qty", test: "above", value: "0" }] });
      expect(s.spec.conditions[0]).toMatchObject({ field: "none" });
      expect(s.dropped).toContainEqual(expect.objectContaining({ why: "its value “0” is not the goal's words" }));
      const r = run("send me the widgets as of 2026-06-30 that are running late", { ...W, conditions: [{ quote: "that are running late", by: "the_flow", field: "store.widgets.qty", test: "above", value: "0" }] });
      expect(where(r.flow)).toBeUndefined();
      expect(r.unmet).toEqual([expect.stringMatching(/“that are running late” is not built: nothing here states how to test it/)]);
    });
    it("the readback says what the filter keeps — or that nothing states how to test it", async () => {
      const { readback } = await import("./goal-spec.js");
      const ok = readback(spec("send me the widgets as of 2026-06-30 in state open", { ...W, conditions: [{ quote: "in state open", by: "the_flow", field: "store.widgets.state", test: "equals", value: "open" }] }), ITEMS);
      expect(ok).toContain("Only when: “in state open” — keeps rows where `state` is “open”");
      const no = readback(spec("send me the widgets as of 2026-06-30 that are running late", { ...W, conditions: [{ quote: "that are running late", by: "the_flow", field: "none", test: "above", value: "" }] }), ITEMS);
      expect(no).toContain("Only when: “that are running late” — not built: nothing here states how to test it");
    });
    it("slice 5d: a date against the DAY IT RUNS — a computed input, never asked, never a value anyone typed", () => {
      const r = run("send me the widgets as of 2026-06-30 whose due date is gone", { ...W, conditions: [{ quote: "whose due date is gone", by: "the_flow", field: "store.widgets.due", test: "date_passed", value: "" }] });
      expect(r.flow.inputs).toContainEqual({ id: "run_day", type: "DATE", computed: "currentDate" });
      expect(where(r.flow)!.pipeline).toEqual([{ op: "filter", where: { notNull: "due" } }, { op: "filter", where: { cmp: "lt", left: { field: "due" }, right: { input: "run_day" } } }]);
      expect(r.flow.holes).toEqual([]);
      expect(r.unmet).toEqual([]);
      // Its complement keeps the day itself: "not passed" is today or later.
      const n = run("send me the widgets as of 2026-06-30 still due", { ...W, conditions: [{ quote: "still due", by: "the_flow", field: "store.widgets.due", test: "date_not_passed", value: "" }] });
      expect(where(n.flow)!.pipeline[1]).toMatchObject({ where: { cmp: "ge" } });
      // A field that is not a date is refused by name, not coerced.
      const bad = run("send me the widgets as of 2026-06-30 whose state is gone", { ...W, conditions: [{ quote: "whose state is gone", by: "the_flow", field: "store.widgets.state", test: "date_passed", value: "" }] });
      expect(where(bad.flow)).toBeUndefined();
      expect(bad.gaps.join(" ")).toMatch(/`state` is not a date/);
    });
    it("slice 5d: N days before the day it runs — the goal's number, a computed input with that offset", () => {
      const r = run("send me the widgets as of 2026-06-30 due over 3 days ago", { ...W, conditions: [{ quote: "due over 3 days ago", by: "the_flow", field: "store.widgets.due", test: "older_than_days", value: "3" }] });
      expect(r.flow.inputs).toContainEqual({ id: "days_before_3", type: "DATE", computed: "currentDate", offsetDays: -3 });
      expect(where(r.flow)!.pipeline[1]).toMatchObject({ where: { cmp: "lt", left: { field: "due" }, right: { input: "days_before_3" } } });
      expect(r.unmet).toEqual([]);
      // A number the goal does not SAY is never supplied: nothing is filtered, and it is stated.
      const vague = run("send me the widgets as of 2026-06-30 due a while ago", { ...W, conditions: [{ quote: "due a while ago", by: "the_flow", field: "store.widgets.due", test: "older_than_days", value: "" }] });
      expect(where(vague.flow)).toBeUndefined();
      expect(vague.flow.inputs.some((i) => i.id.startsWith("days_before"))).toBe(false);
    });
    it("a per-row send goes THROUGH the filter (the fan-out's list is built from where_1)", () => {
      const r = run("email the owners of active widgets as of 2026-06-30", {
        sources: [{ ref: "store.widgets", quote: "widgets" }], sinks: [{ ref: "mail_send", quote: "email" }],
        values: [{ role: "date", from: "goal", quote: "2026-06-30", fills: "store.widgets.as_of" }, { role: "recipient", from: "goal", quote: "the owners", fills: "mail_send.to" }],
        conditions: [{ quote: "active", by: "the_flow", field: "store.widgets.active", test: "is_true", value: "" }],
      });
      expect((r.flow.steps.find((x) => x.id === "shape_1") as unknown as { from: string }).from).toBe("where_1");
      expect(r.unmet).toEqual([]);
    });
  });

  describe("slice 5e: the spec's SHAPE — the engine's combinators, lowered into the one filter step the actions read", () => {
    const W = { sources: [{ ref: "store.widgets", quote: "the widgets" }], sinks: [{ ref: "notify_me", quote: "send me" }], values: [{ role: "date" as const, from: "goal" as const, quote: "2026-06-30", fills: "store.widgets.as_of" }, { role: "recipient" as const, from: "requester" as const, quote: "me", fills: "notify_me.to" }] };
    const g = "send me the widgets as of 2026-06-30 per state with their total qty, largest first, top 3";
    const shapes = [{ over: "store.widgets", stages: [
      { op: "group" as const, quote: "per state", by: ["store.widgets.state"], measures: [{ fn: "sum" as const, field: "store.widgets.qty" }] },
      { op: "sort" as const, quote: "largest first", field: "stage:0:0", dir: "desc" as const },
      { op: "limit" as const, quote: "top 3", value: "3" },
    ] }];
    it("built, typed, read by the action, and the person's words all used", () => {
      const r = run(g, { ...W, shapes });
      const where = r.flow.steps.find((x) => x.id === "where_1") as unknown as { pipeline: Array<{ op: string }> };
      expect(where.pipeline.map((c) => c.op)).toEqual(["group", "sort", "limit"]);
      expect(input(r.flow, "call_1", "text")).toMatchObject({ from: "whole", stepId: "where_1" });
      expect(r.unmet).toEqual([]);
      expect(r.flow.holes).toEqual([]);
    });
    it("an unsaid count is the person's question; unanswered, the step and its successors are stated unmet, never guessed", () => {
      const s2 = [{ ...shapes[0]!, stages: [shapes[0]!.stages[0]!, shapes[0]!.stages[1]!, { op: "limit" as const, quote: "top 3", value: "" }] }];
      const r = run(g, { ...W, shapes: s2 });
      expect(r.unmet.join(" ")).toMatch(/“top 3” needs how many — asked, and not answered/);
      const a = solve(emptyFlow("t"), { spec: spec(g, { ...W, shapes: s2 }), cat, answers: new Map(), base: [], shapeAnswers: new Map([["0:2", "2"]]) });
      expect(a.unmet).toEqual([]);
    });
  });

  it("a reader's date nobody mentioned is a RUN input — deferred to each run, never guessed; another unmentioned filter is asked", () => {
    const r = run("summarise the widget codes", {
      sources: [{ ref: "store.widgets", quote: "the widget codes" }], sinks: [{ ref: "llm_complete", quote: "summarise" }],
    });
    expect(r.flow.inputs).toEqual([expect.objectContaining({ id: "as_of_1", type: "DATE" })]);
    expect(input(r.flow, "read_1", "as_of")).toMatchObject({ from: "input", inputId: "as_of_1" });
    expect(r.flow.holes).toEqual([]);
  });
});

describe("a row's identity — a dedupe key is never typed words (Key)", () => {
  const withPager: CatalogueSnapshot = { ...cat, refs: { ...cat.refs,
    pager: { ...cat.refs.mail_send!, params: [
      { name: "target", ty: { t: "Address" } as never, required: true },
      { name: "dedupe_key", ty: { t: "Key" } as never, required: true },
      { name: "summary", ty: T_TEXT, required: true, message: true },
    ] },
    "ops.incidents": { ...cat.refs["store.people"]!, params: [], payload: { t: "Rows", of: { t: "Record", fields: { code: { t: "Key" }, summary: { t: "Text" }, notify: { t: "Address" } } } } as never },
  } };
  const PAGE = { sources: [{ ref: "ops.incidents", quote: "incidents" }], sinks: [{ ref: "pager", quote: "page" }] };

  it("“don't page the same incident twice” is not bound as one key for every incident: the row's own identity is bound instead", () => {
    const g = "page the owner of each of the incidents but dont spam the same incident";
    const r = run(g, { ...PAGE, values: [{ role: "other", from: "goal", quote: "same incident", fills: "pager.dedupe_key" }] }, new Map(), withPager);
    expect(r.moves.map((m) => m.label).join(" | ")).not.toMatch(/dedupe_key ← “same incident”/);
    // The words are refused as a key; the row's declared identity is what the types leave, so that is what it binds.
    expect(input(r.flow, "call_1", "dedupe_key")).toMatchObject({ from: "step", field: "code" });
  });

  it("per incident, the key is the row's own declared identity — the only binding the types allow", () => {
    const g = "page the owner of each of the incidents";
    const r = run(g, { ...PAGE, values: [{ role: "recipient", from: "goal", quote: "the owner of each", fills: "pager.target" }] }, new Map(), withPager);
    const call = step(r.flow, "call_1");
    expect(call.over).toBeDefined();
    expect(input(r.flow, "call_1", "target")).toMatchObject({ from: "step", field: "notify" });
    expect(input(r.flow, "call_1", "dedupe_key")).toMatchObject({ from: "step", field: "code" });
    expect(r.unmet.join(" ")).not.toMatch(/identity/);
  });

  it("rows whose key and address may be empty (as a query reports them): only rows with both are paged, the rest stated", () => {
    const opt: CatalogueSnapshot = { ...withPager, refs: { ...withPager.refs, "ops.incidents": { ...withPager.refs["ops.incidents"]!, payload: { t: "Rows", of: { t: "Record", fields: { code: { t: "Option", of: { t: "Key" } }, summary: { t: "Option", of: { t: "Text" } }, notify: { t: "Option", of: { t: "Address" } } } } } as never } } };
    const r = run("page the owner of each of the incidents", { ...PAGE, values: [{ role: "recipient", from: "goal", quote: "the owner of each", fills: "pager.target" }] }, new Map(), opt);
    expect(r.skips).toEqual([{ reader: "read_1", field: "notify" }, { reader: "read_1", field: "code" }]);
    // The page's words are never the one field that fits by type (here the address): the person's question, or a confirmed template.
    expect(input(r.flow, "call_1", "summary")).toBeUndefined();
    expect(r.flow.holes.map((h) => h.id)).toEqual(["h_call_1_summary"]);
    expect(input(r.flow, "call_1", "target")).toMatchObject({ from: "step", field: "notify" });
    expect(input(r.flow, "call_1", "dedupe_key")).toMatchObject({ from: "step", field: "code" });
  });

  it("a message port is never filled by the ONE field that fits its type — here the address itself", () => {
    const one: CatalogueSnapshot = { ...cat, refs: { ...cat.refs,
      pager: { ...withPager.refs.pager!, params: withPager.refs.pager!.params.filter((p) => p.name !== "dedupe_key") },
      "ops.incidents": { ...withPager.refs["ops.incidents"]!, payload: { t: "Rows", of: { t: "Record", fields: { notify: { t: "Option", of: { t: "Address" } } } } } as never },
    } };
    const r = run("page the owner of each of the incidents", { ...PAGE, values: [{ role: "recipient", from: "goal", quote: "the owner of each", fills: "pager.target" }] }, new Map(), one);
    expect(input(r.flow, "call_1", "target")).toMatchObject({ from: "step", field: "notify" });
    expect(input(r.flow, "call_1", "summary")).toBeUndefined();
  });

  it("only the list the page is sent over is bounded: a second reader gets no skip nobody would send to", () => {
    const two: CatalogueSnapshot = { ...withPager, refs: { ...withPager.refs,
      "ops.incidents": { ...withPager.refs["ops.incidents"]!, payload: { t: "Rows", of: { t: "Record", fields: { code: { t: "Key" }, notify: { t: "Option", of: { t: "Address" } } } } } as never },
      "ops.oncall": { ...withPager.refs["ops.incidents"]!, payload: { t: "Rows", of: { t: "Record", fields: { contact: { t: "Option", of: { t: "Address" } } } } } as never },
    } };
    const r = run("page the owner of each of the incidents and the oncall", { sources: [{ ref: "ops.incidents", quote: "incidents" }, { ref: "ops.oncall", quote: "the oncall" }], sinks: PAGE.sinks, values: [{ role: "recipient", from: "goal", quote: "the owner of each", fills: "pager.target" }] }, new Map(), two);
    expect(r.skips).toEqual([{ reader: "read_1", field: "notify" }]);
    expect(r.flow.steps.filter((x) => x.kind === "transform" && "from" in x && x.from === "read_2")).toEqual([]);
  });

  it("with no declared identity in the rows, a key port is unmet and is not a question", () => {
    const noKey: CatalogueSnapshot = { ...withPager, refs: { ...withPager.refs, "ops.incidents": { ...withPager.refs["ops.incidents"]!, payload: { t: "Rows", of: { t: "Record", fields: { code: { t: "Text" }, notify: { t: "Address" } } } } as never } } };
    const r = run("page the owner of each of the incidents", { ...PAGE, values: [{ role: "recipient", from: "goal", quote: "the owner of each", fills: "pager.target" }] }, new Map(), noKey);
    expect(r.unmet.join(" ")).toMatch(/`call_1\.dedupe_key` must be the identity of the row/);
    expect(input(r.flow, "call_1", "dedupe_key")).toBeUndefined();
    const h = r.flow.holes.find((x) => x.site.at === "port" && x.site.port === "dedupe_key")!;
    expect(keyHole(h)).toBe(true);
    expect(questionsFor(r.flow, [h.id], { questions: [] } as never, 1)).toEqual([]); // handed to the person, still not asked
  });
});

describe("E5.5 — the person's words never vanish when the spec stops asking", () => {
  const G = "post the widget codes that waited too long";
  const BASE = { sources: [{ ref: "store.widgets", quote: "the widget codes" }], sinks: [{ ref: "notify_me", quote: "post" }] };
  it("vague words that fill no parameter (R13's “too long”) are stated unmet — the flow is never complete doing less", () => {
    const r = run(G, { ...BASE, values: [{ role: "threshold", from: "goal", quote: "too long", fills: "none" }] });
    expect(r.unmet).toContainEqual("the goal says “too long” (threshold), and nothing built here uses it");
  });
  it("CONTROL: words a placed schedule or a condition carries are not unmet on their own", () => {
    const r = run(G, { ...BASE, values: [{ role: "threshold", from: "goal", quote: "too long", fills: "none" }], conditions: [{ quote: "that waited too long", by: "store.widgets" }] });
    expect(r.unmet.join(" ")).not.toMatch(/“too long”/);
  });
  it("P9: a threshold whose quote sits inside a built read's covered band clause is used, not unmet", () => {
    const goal = "post the widget codes with half day between 4.75 and 9.49 hours counting as 0";
    const base = { sources: [{ ref: "store.widgets", quote: "the widget codes" }], sinks: [{ ref: "notify_me", quote: "post" }] };
    const r = run(goal, {
      ...base,
      values: [
        { role: "threshold", from: "goal", quote: "9.49", fills: "none" },
        { role: "count", from: "goal", quote: "0", fills: "none" },
      ],
      covered: [{ quote: "half day between 4.75 and 9.49 hours counting as 0", by: "store.widgets" }],
    });
    expect(r.unmet.join(" ")).not.toMatch(/“9\.49”/);
    expect(r.unmet.join(" ")).not.toMatch(/“0” \(count\)/);
  });
  it("P9 CONTROL: the same thresholds without covered text stay unmet", () => {
    const goal = "post the widget codes with half day between 4.75 and 9.49 hours counting as 0";
    const base = { sources: [{ ref: "store.widgets", quote: "the widget codes" }], sinks: [{ ref: "notify_me", quote: "post" }] };
    const r = run(goal, {
      ...base,
      values: [{ role: "threshold", from: "goal", quote: "9.49", fills: "none" }],
    });
    expect(r.unmet).toContainEqual("the goal says “9.49” (threshold), and nothing built here uses it");
  });
});

describe("E5.5 — a condition the goal only describes is the person's question, answered or stated", () => {
  const G = "summarise the widget codes where the quantity is too high";
  const COND = { sources: [{ ref: "store.widgets", quote: "the widget codes" }], sinks: [{ ref: "llm_complete", quote: "summarise" }],
    values: [{ role: "date" as const, from: "goal" as const, quote: "2026-06-30", fills: "store.widgets.as_of" }],
    conditions: [{ quote: "where the quantity is too high", by: "the_flow", field: "store.widgets.qty", test: "above" as const, value: "too high" }] };
  it("an answer that is not a value of the field's kind is not applied — the condition stays unmet", () => {
    const r = solve(emptyFlow("t"), { spec: spec(`${G} as of 2026-06-30`, COND), cat, answers: new Map(), base: [], condAnswers: new Map([[0, "quite a lot"]]) });
    expect(r.flow.steps.some((x) => x.id.startsWith("where"))).toBe(false);
    expect(r.unmet.join(" ")).toMatch(/could not be applied to `store.widgets.qty`/);
  });
});

describe("E5.5 — a condition's compared value is used, not unused", () => {
  it("“7 days” as the value of a placed condition is not stated unmet (D19)", () => {
    const g = "summarise the widget codes that are nearly out, 7 days, as of 2026-06-30";
    const r = run(g, { sources: [{ ref: "store.widgets", quote: "the widget codes" }], sinks: [{ ref: "llm_complete", quote: "summarise" }],
      values: [{ role: "date", from: "goal", quote: "2026-06-30", fills: "store.widgets.as_of" }, { role: "threshold", from: "goal", quote: "7 days", fills: "none" }],
      conditions: [{ quote: "that are nearly out", by: "the_flow", field: "store.widgets.qty", test: "at_most", value: "7 days" }] });
    expect(r.flow.steps.some((x) => x.id.startsWith("where"))).toBe(true); // placed — so a later unmet would be the rule's fault
    expect(r.unmet.join(" ")).not.toMatch(/“7 days”/);
  });
});

describe("the shipped model tool declares where its data goes", () => {
  it("llm_complete: `input` is the data port, `instruction` is not (so the builder never asks which is which)", async () => {
    const { DECLARED } = await import("../tool-declarations.js");
    expect(DECLARED.llm_complete).toMatchObject({ modelText: true, ports: { input: { data: true } } });
    expect(DECLARED.llm_complete!.ports?.instruction?.data).toBeUndefined();
  });
});

describe("P1 — every refusal is a question carrying its real reason (RC-1/RC-2/RC-6)", () => {
  // The deployment's MAIL_ALLOWED_RECIPIENT_DOMAINS as .env sets it: nothing off microland.com may be sent to.
  const allowed: CatalogueSnapshot = { ...cat, mailAllowedDomains: ["microland.com"] };
  const GOAL = "email bob@gmail.com the widget codes";
  const EMAIL: Partial<GoalSpec> = {
    sources: [{ ref: "store.widgets", quote: "the widget codes" }],
    sinks: [{ ref: "mail_send", quote: "email" }],
    values: [
      { role: "recipient", from: "goal", quote: "bob@gmail.com", fills: "mail_send.to" },
      { role: "subject", from: "goal", quote: "Weekly note", fills: "mail_send.subject" },
    ],
  };
  const REFUSED = "the address “bob@gmail.com” stated for `call_1.to` was refused: not on an allowed domain (microland.com)";

  it("(a) (b): the reason is stated FOR the port and carried by the port's question — never a generic re-ask, never a wrong cause", () => {
    const r = run(GOAL, EMAIL, new Map(), allowed);
    expect(r.unmet).toContain(REFUSED);
    expect(r.unmet.join("\n")).not.toContain("no row here carries an address"); // the data-gap diagnosis is not this
    const ports = r.flow.holes.filter((h) => h.site.at === "port").map((h) => h.id);
    const asked = questionsFor(r.flow, ports, { ...emptyTrace(), unmet: r.unmet }, 1, allowed).find((q) => q.port === "to")!;
    expect(asked.ask).toContain("What should the to be for mail send?");
    expect(asked.ask).toContain("“bob@gmail.com” was refused: not on an allowed domain (microland.com)");
    // CONTROL: without the finding in the trace the same hole asks plainly — the decoration is the refusal's, not a new default.
    expect(questionsFor(r.flow, ports, emptyTrace(), 1, allowed).find((q) => q.port === "to")!.ask).not.toContain("refused");
  });

  it("(a): the reason survives the REUSE round, where placement is skipped — the field report's third lost layer", () => {
    const first = run(GOAL, EMAIL, new Map(), allowed);
    const again = solve(first.flow, { spec: spec(GOAL, EMAIL, allowed), cat: allowed, answers: new Map(), base: [] });
    expect(again.moves).toEqual([]); // nothing re-placed: the finding is re-derived from the still-open port
    expect(again.unmet).toContain(REFUSED);
    expect(again.unmet.join("\n")).not.toContain("no row here carries an address");
  });

  it("(a): on a port the ENGINE leaves hole-less (optional, unscheduled), the refusal still states its reason and keeps the hole", () => {
    const r = run("tell bob@gmail.com the widget codes", { sources: [{ ref: "store.widgets", quote: "the widget codes" }], sinks: [{ ref: "notify_me", quote: "tell" }], values: [{ role: "recipient", from: "goal", quote: "bob@gmail.com", fills: "notify_me.to" }] }, new Map(), allowed);
    expect(r.unmet).toContain(REFUSED);
    expect(r.flow.holes.some((h) => h.site.at === "port" && h.site.stepId === "call_1" && h.site.port === "to")).toBe(true);
    expect(r.unmet.join("\n")).not.toContain("no row here carries an address");
  });

  it("(b) (RC-6): the data-gap recipient is DIFFERENT text, keeps its port's hole, and is partQuestion's to ask", () => {
    const noEmail: CatalogueSnapshot = { ...cat, refs: { ...cat.refs, "store.people": { ...cat.refs["store.people"]!, payload: { t: "Rows", of: { t: "Record", fields: { name: { t: "Text" } } } as never } } } };
    const r = run("tell everyone in store people", { sources: [{ ref: "store.people", quote: "everyone in store people" }], sinks: [{ ref: "notify_me", quote: "tell" }], values: [{ role: "recipient", from: "goal", quote: "everyone", fills: "notify_me.to" }] }, new Map(), noEmail);
    expect(r.unmet).toContain("the goal says who receives `call_1.to` (“everyone”), but no row here carries an address for them");
    expect(r.unmet.join("\n")).not.toContain("was refused");
    // The optional, unscheduled recipient port keeps a HOLE the engine would not open: the flow says "not set" beside the finding.
    expect(r.flow.holes.some((h) => h.site.at === "port" && h.site.stepId === "call_1" && h.site.port === "to")).toBe(true);
    // The conversation turns this exact wording into the question offering an address to give.
    expect(partQuestion("the goal says who receives `call_1.to` (“everyone”), but no row here carries an address for them")).toMatchObject({ key: "part:address:everyone", ask: expect.stringMatching(/give an email address to send to/) });
    // …and the refused value's finding is NEVER this question (two causes, two texts, two treatments).
    expect(partQuestion(REFUSED)).toBeNull();
  });
});
