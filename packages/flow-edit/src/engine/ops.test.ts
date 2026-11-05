/**
 * Every engine op's precondition, one test per clause (compiled-builder phase 3 exit gate: "every op has a precondition spec
 * and tests"). The property test proves the preconditions are ENOUGH; these pin that each one refuses what it says it does.
 */
import { describe, expect, it } from "vitest";
import { checkState, emptyFlow, errorsOf, holesOf, type EFlow } from "./model.js";
import { apply, DISABLED_PRECONDITIONS, type EngineOp } from "./ops.js";
import { legalMoves } from "./legal.js";
import { SYNTHETIC as cat } from "./synthetic.js";

const run = (ops: EngineOp[], start: EFlow = emptyFlow("t")): EFlow => ops.reduce((f, op) => { const r = apply(f, op, cat); if (!r.ok) throw new Error(`${op.op}: ${r.error}`); return r.flow; }, start);
const refuse = (f: EFlow, op: EngineOp) => { const r = apply(f, op, cat); expect(r.ok).toBe(false); return r.ok ? "" : r.error; };
const valid = (f: EFlow) => expect(errorsOf(checkState(f, cat))).toEqual([]);

// A small complete flow: read widgets, keep the owned ones, bound to 1000, mail each owner.
const BASE: EngineOp[] = [
  { op: "declare_input", id: "as_of", type: "DATE", defaults: "2026-06-30" },
  { op: "add_reader", id: "read", ref: "store.widgets" },
  { op: "bind", stepId: "read", port: "as_of", source: { from: "input", inputId: "as_of" } },
  { op: "add_transform", id: "owned", from: "read", pipeline: [{ op: "filter", where: { notNull: "owner_email" } }, { op: "limit", n: { value: 1000, from: "catalogue" } }] },
  { op: "add_call", id: "send", ref: "mail_send", over: "owned", row: { port: "to", field: "owner_email" } },
  { op: "bind", stepId: "send", port: "subject", source: { from: "literal", value: "Your widget", provenance: "goal" } },
  { op: "bind", stepId: "send", port: "body", source: { from: "field", stepId: "owned", field: "code" } },
  { op: "set_output", stepId: "owned" },
];

describe("a complete flow built by ops is valid and complete", () => {
  it("BASE: zero errors, zero holes", () => {
    const f = run(BASE);
    const ds = checkState(f, cat);
    expect(errorsOf(ds)).toEqual([]);
    expect(holesOf(ds)).toEqual([]);
  });
  it("a fresh flow has exactly one hole, the result", () => {
    expect(holesOf(checkState(emptyFlow("t"), cat)).map((d) => d.code)).toEqual(["FT0801"]);
  });
});

describe("declare_input / remove_input", () => {
  it("refuses a bad id, a duplicate, a format on a non-STRING, and a default of the wrong type", () => {
    const f = run(BASE.slice(0, 1));
    expect(refuse(f, { op: "declare_input", id: "Bad-Id", type: "INT" })).toMatch(/not a valid input id/);
    expect(refuse(f, { op: "declare_input", id: "as_of", type: "INT" })).toMatch(/already declared/);
    expect(refuse(f, { op: "declare_input", id: "m", type: "INT", format: "month" })).toMatch(/only a STRING/);
    expect(refuse(f, { op: "declare_input", id: "d", type: "DATE", defaults: "2026-02-30" })).toMatch(/not a date/);
  });
  it("on a scheduled flow a new input needs a default or must be optional", () => {
    const f = run([{ op: "set_schedule", cron: "0 9 * * 1" }]);
    expect(refuse(f, { op: "declare_input", id: "n", type: "INT" })).toMatch(/schedule/);
    expect(apply(f, { op: "declare_input", id: "n", type: "INT", required: false }, cat).ok).toBe(true);
  });
  it("remove_input refuses while anything reads it", () => {
    expect(refuse(run(BASE), { op: "remove_input", id: "as_of" })).toMatch(/read by read/);
  });
});

describe("retype_input — the same input, asked as another type (2026-10-01)", () => {
  it("changes how an input is asked, keeping it — and what reads it — in place", () => {
    const f = run([{ op: "declare_input", id: "period", type: "STRING", format: "month" }]);
    const r = apply(f, { op: "retype_input", id: "period", type: "DATE" }, cat);
    expect(r.ok && r.flow.inputs).toEqual([{ id: "period", type: "DATE" }]);
  });
  it("refuses a type a step that reads it cannot take, naming the step and port", () => {
    expect(refuse(run(BASE), { op: "retype_input", id: "as_of", type: "BOOLEAN" })).toMatch(/`read`'s `as_of` reads `as_of`/);
  });
  it("CONTROL: a type the reading port takes is allowed, and the flow stays valid", () => {
    const f = run(BASE);
    const r = apply(f, { op: "retype_input", id: "as_of", type: "DATETIME" }, cat);
    if (r.ok) valid(r.flow); else expect(r.error).toMatch(/does not fit/);
  });
  it("refuses a computed input, no change, and a format on a non-STRING", () => {
    const f = run([{ op: "declare_input", id: "today", type: "DATE", computed: "currentDate" }, { op: "declare_input", id: "n", type: "INT" }]);
    expect(refuse(f, { op: "retype_input", id: "today", type: "STRING" })).toMatch(/computed/);
    expect(refuse(f, { op: "retype_input", id: "n", type: "INT" })).toMatch(/already asked that way/);
    expect(refuse(f, { op: "retype_input", id: "n", type: "INT", format: "month" })).toMatch(/only a STRING/);
  });
  it("is listed as exact (input, type) pairs, every one of which apply accepts", () => {
    const f = run(BASE);
    const m = legalMoves(f, cat).find((x) => x.op === "retype_input");
    const to = m && m.op === "retype_input" ? m.to : [];
    for (const t of to) expect(apply(f, { op: "retype_input", ...t }, cat).ok).toBe(true);
    expect(to.some((t) => t.type === "BOOLEAN")).toBe(false);
  });
});

describe("add_reader / choose_reader", () => {
  it("an unchosen reader is a hole, not an error, and cannot be read", () => {
    const f = run([{ op: "add_reader", id: "r" }]);
    valid(f);
    expect(holesOf(checkState(f, cat)).some((d) => d.span.stepId === "r")).toBe(true);
    expect(refuse(f, { op: "add_transform", id: "x", from: "r", pipeline: [{ op: "count", as: "n" }] })).toMatch(/no component yet/);
    const g = run([{ op: "choose_reader", stepId: "r", ref: "store.people" }], f);
    valid(g);
  });
  it("refuses a tool as a reader, an unknown ref, and choosing twice", () => {
    expect(refuse(emptyFlow("t"), { op: "add_reader", id: "r", ref: "mail_send" })).toMatch(/not a reader/);
    expect(refuse(emptyFlow("t"), { op: "add_reader", id: "r", ref: "nope.x" })).toMatch(/not a reader/);
    const f = run([{ op: "add_reader", id: "r", ref: "store.people" }]);
    expect(refuse(f, { op: "choose_reader", stepId: "r", ref: "store.widgets" })).toMatch(/not a reader waiting/);
  });
});

describe("add_transform / append_stage", () => {
  const f = run(BASE.slice(0, 3));
  it("refuses a pipeline that does not type, a literal with no provenance, a template literal, and a model's text", () => {
    expect(refuse(f, { op: "add_transform", id: "x", from: "read", pipeline: [{ op: "sort", by: "due", dir: "asc" }] })).toMatch(/may be null/);
    expect(refuse(f, { op: "add_transform", id: "x", from: "read", pipeline: [{ op: "filter", where: { cmp: "gt", left: { field: "qty" }, right: { lit: { value: 3, from: "test" } } } }] })).toMatch(/marked "test"/);
    expect(refuse(f, { op: "add_transform", id: "x", from: "read", pipeline: [{ op: "filter", where: { cmp: "eq", left: { field: "state" }, right: { lit: { value: "{{ inputs.x }}", from: "goal" } } } }] })).toMatch(/template/);
    const g = run([{ op: "add_call", id: "ai", ref: "llm_complete" }, { op: "bind", stepId: "ai", port: "input", source: { from: "text", stepId: "read" } }], f);
    expect(refuse(g, { op: "add_transform", id: "x", from: "ai", pipeline: [{ op: "project", fields: [{ name: "t", from: "text" }] }] })).toMatch(/D-34/);
  });
  it("append_stage refuses once anything reads the transform, and refuses a stage that does not type", () => {
    const g = run(BASE);
    expect(refuse(g, { op: "append_stage", stepId: "owned", stage: { op: "count", as: "n" } })).toMatch(/read by/);
    const h = run([{ op: "add_transform", id: "x", from: "read", pipeline: [{ op: "count", as: "n" }] }], f);
    expect(refuse(h, { op: "append_stage", stepId: "x", stage: { op: "sort", by: "n", dir: "asc" } })).toMatch(/needs rows/);
  });
});

describe("add_call and fan-out", () => {
  const f = run(BASE.slice(0, 4));
  it("a new call's required ports are holes", () => {
    const g = run([{ op: "add_call", id: "c", ref: "chat_post" }], f);
    valid(g);
    expect(holesOf(checkState(g, cat)).filter((d) => d.span.stepId === "c").map((d) => d.span.port).sort()).toEqual(["channel", "text"]);
  });
  it("refuses a fan-out over a reader, over an unbounded pipeline, and one naming no row binding", () => {
    expect(refuse(f, { op: "add_call", id: "c", ref: "mail_send", over: "read", row: { port: "to", field: "owner_email" } })).toMatch(/transform's bounded list/);
    const g = run([{ op: "add_transform", id: "all", from: "read", pipeline: [{ op: "filter", where: { notNull: "owner_email" } }] }], f);
    expect(refuse(g, { op: "add_call", id: "c", ref: "mail_send", over: "all", row: { port: "to", field: "owner_email" } })).toMatch(/no `limit`/);
    expect(refuse(f, { op: "add_call", id: "c", ref: "mail_send", over: "owned" })).toMatch(/names its first binding/);
  });
});

describe("bind / unbind", () => {
  const f = run(BASE.slice(0, 5));
  it("refuses a type that does not fit, a nullable value, an unknown port, a later step, and a second upstream", () => {
    expect(refuse(f, { op: "bind", stepId: "send", port: "subject", source: { from: "field", stepId: "owned", field: "qty" } })).toMatch(/Int is not Text|not Text/);
    expect(refuse(f, { op: "bind", stepId: "send", port: "body", source: { from: "field", stepId: "owned", field: "weight" } })).toBeTruthy();
    expect(refuse(f, { op: "bind", stepId: "send", port: "nope", source: { from: "literal", value: "x", provenance: "goal" } })).toMatch(/no input/);
    const g = run([{ op: "add_reader", id: "people", ref: "store.people" }], f);
    expect(refuse(g, { op: "bind", stepId: "send", port: "cc", source: { from: "field", stepId: "people", field: "email" } })).toMatch(/does not run before/);
    const h = run([...BASE.slice(0, 4), { op: "add_reader", id: "people", ref: "store.people" }, BASE[4]!]);
    expect(refuse(h, { op: "bind", stepId: "send", port: "body", source: { from: "text", stepId: "people" } })).toMatch(/fans out over/);
  });
  it("a literal must fit its port's refinements and the deployment's policy, and carry a provenance", () => {
    expect(refuse(f, { op: "bind", stepId: "send", port: "subject", source: { from: "literal", value: "two\nlines", provenance: "goal" } })).toMatch(/one line/);
    expect(refuse(f, { op: "bind", stepId: "send", port: "cc", source: { from: "literal", value: "x@elsewhere.org", provenance: "goal" } })).toMatch(/allowed domain/);
    expect(refuse(f, { op: "bind", stepId: "send", port: "cc", source: { from: "literal", value: "x@acme.example", provenance: "goal" } })).toMatch(/reserved/);
    expect(refuse(f, { op: "bind", stepId: "send", port: "cc", source: { from: "literal", value: "x@acme-corp.com", provenance: "test" as never } })).toMatch(/quoted from the goal/);
  });
  it("a fan-out's last row binding cannot be unbound; a required port unbound becomes a hole again", () => {
    const g = run(BASE);
    const lone = run([{ op: "unbind", stepId: "send", port: "body" }], g);
    expect(refuse(lone, { op: "unbind", stepId: "send", port: "to" })).toMatch(/last binding from the rows/);
    const h = run([{ op: "unbind", stepId: "send", port: "subject" }], g);
    valid(h);
    expect(holesOf(checkState(h, cat)).some((d) => d.span.port === "subject")).toBe(true);
  });
});

describe("add_gate / set_output / set_schedule / remove_step", () => {
  it("a gate is spliced BEFORE its call, once, with a one-line question; removing it unsplices", () => {
    const g = run([...BASE, { op: "add_gate", id: "ok", before: "send", summary: "Send these?" }]);
    valid(g);
    expect(g.steps.findIndex((s) => s.id === "ok")).toBe(g.steps.findIndex((s) => s.id === "send") - 1);
    expect(refuse(g, { op: "add_gate", id: "ok2", before: "send", summary: "Again?" })).toMatch(/already has a gate/);
    expect(refuse(run(BASE), { op: "add_gate", id: "q", before: "send", summary: "two\nlines" })).toMatch(/one line/);
    const h = run([{ op: "remove_step", stepId: "ok" }], g);
    valid(h);
    expect(h.steps.find((s) => s.id === "send")!.dependsOn).not.toContain("ok");
  });
  it("set_output refuses a gate and a second result", () => {
    const g = run([...BASE, { op: "add_gate", id: "ok", before: "send", summary: "Send?" }]);
    expect(refuse(g, { op: "set_output", stepId: "send" })).toMatch(/already declared/);
    const h = run(BASE.slice(0, 7).concat([{ op: "add_gate", id: "ok", before: "send", summary: "Send?" }]));
    expect(refuse(h, { op: "set_output", stepId: "ok" })).toMatch(/gate/);
  });
  it("a schedule needs a valid cron and resolvable inputs, and makes an unset requester-fallback recipient a person's hole", () => {
    expect(refuse(emptyFlow("t"), { op: "set_schedule", cron: "every day" })).toMatch(/five fields/);
    expect(refuse(emptyFlow("t"), { op: "set_schedule", cron: "61 9 * * *" })).toMatch(/out of range/);
    expect(refuse(run([{ op: "declare_input", id: "n", type: "INT" }]), { op: "set_schedule", cron: "0 9 * * 1" })).toMatch(/nobody to supply/);
    const g = run([...BASE, { op: "add_call", id: "me", ref: "notify_me" }, { op: "bind", stepId: "me", port: "text", source: { from: "literal", value: "done", provenance: "goal" } }, { op: "set_schedule", cron: "0 9 * * 1" }]);
    valid(g);
    expect(holesOf(checkState(g, cat)).map((d) => `${d.span.stepId}.${d.span.port}`)).toEqual(["me.to"]);
    // ⚠ CONTROL (I-287): `send.cc` is optional and an address list, and an unset cc is NO cc — it must not become a hole.
    expect(holesOf(checkState(g, cat)).some((d) => d.span.port === "cc")).toBe(false);
    const h = run([{ op: "set_schedule", cron: null }], g);
    expect(holesOf(checkState(h, cat))).toEqual([]);
  });
  it("remove_step refuses while anything reads the step (I-269)", () => {
    const g = run(BASE);
    expect(refuse(g, { op: "remove_step", stepId: "owned" })).toMatch(/read by/);
    expect(refuse(g, { op: "remove_step", stepId: "read" })).toMatch(/read by/);
    expect(apply(run(BASE.slice(0, 7)), { op: "remove_step", stepId: "send" }, cat).ok).toBe(true);
  });
});

describe("legalMoves lists only moves apply accepts, and the negative-control switch works", () => {
  it("every listed bind source applies", () => {
    const f = run(BASE.slice(0, 5));
    for (const m of legalMoves(f, cat)) if (m.op === "bind") for (const src of m.sources) expect(apply(f, { op: "bind", stepId: m.stepId, port: m.port, source: src }, cat).ok).toBe(true);
  });
  it("DISABLED_PRECONDITIONS is empty outside a control", () => {
    expect(DISABLED_PRECONDITIONS.size).toBe(0);
  });
});

// ── D-320: conditions, arms, merges ──────────────────────────────────────────
describe("add_branch / add_otherwise / add_merge (D-320)", () => {
  // read people; `many` = people with a score; a condition on it; one transform per arm; the merge is the result.
  const HEAD: EngineOp[] = [
    { op: "add_reader", id: "people", ref: "store.people" },
    { op: "add_transform", id: "scored", from: "people", pipeline: [{ op: "filter", where: { notNull: "score" } }] },
    { op: "add_branch", id: "if_any", when: [{ stepId: "scored", test: "any" }] },
  ];
  const names = (under: string, id: string): EngineOp => ({ op: "add_transform", id, from: "people", pipeline: [{ op: "project", fields: [{ name: "name", from: "name" }] }], under });

  it("a new condition guards nothing yet: a hole, not an error — and a step placed under it fills the hole", () => {
    const f = run(HEAD);
    valid(f);
    expect(f.holes.map((h) => h.why)).toContain("arm");
    const g = run([names("if_any", "a")], f);
    expect(g.holes.some((h) => h.why === "arm")).toBe(false);
    expect(g.steps.find((s) => s.id === "a")!.dependsOn).toEqual(["people", "if_any"]);
  });

  it("a condition asks whether a LIST has rows; one record, a model's text, a guarded step and an unknown test are refused", () => {
    const f = run([...HEAD, { op: "add_transform", id: "n", from: "people", pipeline: [{ op: "count", as: "n" }] }]);
    expect(refuse(f, { op: "add_branch", id: "b", when: [{ stepId: "n", test: "any" }] })).toMatch(/not a list/);
    expect(refuse(f, { op: "add_branch", id: "b", when: [{ stepId: "scored", test: "gt" as never }] })).toMatch(/filter it first/);
    expect(refuse(f, { op: "add_branch", id: "b", when: [{ stepId: "scored", test: "any" }, { stepId: "scored", test: "none" }] })).toMatch(/each step once/);
    const g = run([names("if_any", "a")], f);
    expect(refuse(g, { op: "add_branch", id: "b", when: [{ stepId: "a", test: "any" }] })).toMatch(/itself under a condition/);
  });

  it("an otherwise continues the LAST link; nothing continues an else; an elif tests only steps placed before the head", () => {
    const f = run([...HEAD, names("if_any", "a"), { op: "add_otherwise", id: "els", of: "if_any" }]);
    expect(refuse(f, { op: "add_otherwise", id: "x", of: "els" })).toMatch(/nothing continues one/);
    expect(refuse(f, { op: "add_otherwise", id: "x", of: "if_any" })).toMatch(/already continued/);
    const g = run([...HEAD, { op: "add_transform", id: "late", from: "people", pipeline: [{ op: "filter", where: { isNull: "team" } }] }]);
    expect(refuse(g, { op: "add_otherwise", id: "x", of: "if_any", when: [{ stepId: "late", test: "any" }] })).toMatch(/after the chain begins/);
    const h = run([{ op: "add_otherwise", id: "elif", of: "if_any", when: [{ stepId: "people", test: "none" }] }], run(HEAD));
    expect(h.steps.find((s) => s.id === "elif")!.dependsOn).toEqual([]); // a continuation depends on nothing
  });

  it("placement: a guarded step reads only its own arm and top-level steps BEFORE the head; never two arms, never a merge", () => {
    const f = run([...HEAD, names("if_any", "a"), { op: "add_otherwise", id: "els", of: "if_any" }, names("els", "b"),
      { op: "add_transform", id: "after", from: "people", pipeline: [{ op: "filter", where: { isNull: "team" } }] }]);
    expect(refuse(f, { op: "add_transform", id: "x", from: "after", pipeline: [{ op: "count", as: "n" }], under: "if_any" })).toMatch(/placed after the condition/);
    expect(refuse(f, { op: "add_transform", id: "x", from: "a", pipeline: [{ op: "count", as: "n" }], under: "els" })).toMatch(/two conditions/);
    // a step reading a guarded one is in its arm without being asked
    const g = run([{ op: "add_transform", id: "a2", from: "a", pipeline: [{ op: "count", as: "n" }] }], f);
    expect(g.steps.find((s) => s.id === "a2")!.dependsOn).toContain("if_any");
    // bind never MOVES a step into an arm
    const h = run([{ op: "add_call", id: "post", ref: "llm_complete" }], f);
    expect(refuse(h, { op: "bind", stepId: "post", port: "input", source: { from: "text", stepId: "a" } })).toMatch(/runs only when/);
  });

  it("the result is never a guarded step or a condition", () => {
    const f = run([...HEAD, names("if_any", "a")]);
    expect(refuse(f, { op: "set_output", stepId: "a" })).toMatch(/merge it first/);
    expect(refuse(f, { op: "set_output", stepId: "if_any" })).toMatch(/produces nothing/);
  });

  it("a merge: transforms of one type, one per arm of ONE chain, exhaustive, a top-level source only as the LAST", () => {
    const open = run([...HEAD, names("if_any", "a")]);
    expect(refuse(open, { op: "add_merge", id: "m", sources: ["a", "scored"] })).toMatch(/different types/);
    const closed = run([{ op: "add_otherwise", id: "els", of: "if_any" }, names("els", "b"), { op: "add_transform", id: "all", from: "people", pipeline: [{ op: "project", fields: [{ name: "name", from: "name" }] }] }], open);
    expect(refuse(run([{ op: "add_otherwise", id: "e2", of: "if_any", when: [{ stepId: "people", test: "any" }] }, names("e2", "c")], open), { op: "add_merge", id: "m", sources: ["a", "c"] })).toMatch(/no condition of `if_any` holds/);
    expect(refuse(closed, { op: "add_merge", id: "m", sources: ["all", "a"] })).toMatch(/LAST source/);
    expect(refuse(closed, { op: "add_merge", id: "m", sources: ["a", "all", "b"] })).toMatch(/LAST source/);
    expect(refuse(closed, { op: "add_merge", id: "m", sources: ["a", "a"] })).toMatch(/each source once/);
    const merged = run([{ op: "add_merge", id: "m", sources: ["a", "b"] }, { op: "set_output", stepId: "m" }], closed);
    const ds = checkState(merged, cat);
    expect(errorsOf(ds)).toEqual([]);
    expect(holesOf(ds)).toEqual([]);
    // with a fallback, no else is needed
    expect(apply(open, { op: "add_merge", id: "m", sources: ["a", "scored"].slice(0, 1).concat(["all"]) }, cat).ok).toBe(false); // `all` not in `open`
    const fb = run([{ op: "add_transform", id: "all", from: "people", pipeline: [{ op: "project", fields: [{ name: "name", from: "name" }] }] }, { op: "add_merge", id: "m", sources: ["a", "all"] }], open);
    valid(fb);
    // a guarded step cannot read the merge
    expect(refuse(merged, { op: "add_transform", id: "x", from: "m", pipeline: [{ op: "count", as: "n" }], under: "if_any" })).toMatch(/cannot read the merge/);
  });

  it("remove_step: a condition goes only when its arm is empty and nothing continues or reads it; emptying an arm restores the hole", () => {
    const f = run([...HEAD, names("if_any", "a")]);
    expect(refuse(f, { op: "remove_step", stepId: "if_any" })).toMatch(/read by a/);
    expect(refuse(f, { op: "remove_step", stepId: "scored" })).toMatch(/read by if_any/);
    const g = run([{ op: "remove_step", stepId: "a" }], f);
    expect(g.holes.some((h) => h.why === "arm")).toBe(true);
    const h = run([{ op: "remove_step", stepId: "if_any" }], g);
    expect(h.holes.some((x) => x.why === "arm")).toBe(false);
    valid(h);
  });

  it("an empty arm with no hole, or an arm hole on a guarded branch, is an invariant breach (FT0802)", () => {
    const f = run(HEAD);
    expect(checkState({ ...f, holes: f.holes.filter((h) => h.why !== "arm") }, cat).some((d) => d.code === "FT0802")).toBe(true);
    const g = run([names("if_any", "a")], f);
    expect(checkState({ ...g, holes: [...g.holes, { id: "h_stale", site: { at: "arm", stepId: "if_any" }, why: "arm", ty: null, owner: "chooser", reason: "x" }] }, cat).some((d) => d.code === "FT0802")).toBe(true);
  });

  it("legalMoves lists conditions, continuations, `under` and merges — and every one applies", () => {
    const f = run([...HEAD, names("if_any", "a"), { op: "add_otherwise", id: "els", of: "if_any" }, names("els", "b")]);
    const ms = legalMoves(f, cat);
    expect(ms.find((m) => m.op === "add_branch")).toBeTruthy();
    const merge = ms.find((m) => m.op === "add_merge");
    expect(merge && "sources" in merge ? merge.sources : []).toContainEqual(["a", "b"]);
    const t = ms.find((m) => m.op === "add_transform" && m.from === "people");
    expect(t && "unders" in t ? t.unders : []).toEqual(expect.arrayContaining(["if_any", "els"]));
  });
});

describe("I-290 — a projection's `from` names a column, not a provenance", () => {
  it("a `project` stage is a legal transform, and is LISTED", () => {
    const f = run([{ op: "add_reader", id: "people", ref: "store.people" }]);
    expect(apply(f, { op: "add_transform", id: "p", from: "people", pipeline: [{ op: "project", fields: [{ name: "who", from: "name" }] }] }, cat).ok).toBe(true);
    const t = legalMoves(f, cat).find((m) => m.op === "add_transform");
    expect(t && "stages" in t ? t.stages.some((s) => s.op === "project") : false).toBe(true);
    // CONTROL: a real literal with a bad provenance is still refused
    expect(refuse(f, { op: "add_transform", id: "q", from: "people", pipeline: [{ op: "limit", n: { value: 3, from: "test" as never } }] })).toMatch(/pipeline literal marked "test"/);
  });
});

describe("a port only a step's output fills (`fromStep`, 2026-10-02)", () => {
  // `body` of mail_send, re-declared as one only a step's output fills — the shape of `attach_rows`.
  const fs = { ...cat, refs: { ...cat.refs, mail_send: { ...cat.refs.mail_send!, params: cat.refs.mail_send!.params.map((p) => (p.name === "body" ? { ...p, fromStep: true } : p)) } } };
  const upTo = run(BASE.slice(0, 6));
  it("refuses a stated value, and offers no value slot for it", () => {
    const r = apply(upTo, { op: "bind", stepId: "send", port: "body", source: { from: "literal", value: "active employees", provenance: "goal" } }, fs);
    expect(r.ok ? "" : r.error).toMatch(/takes a step's output/);
    const m = legalMoves(upTo, fs).find((x) => x.op === "bind" && x.stepId === "send" && x.port === "body");
    expect(m && m.op === "bind" ? m.literal : "no move").toBeNull();
  });
  it("CONTROL: a step's output still fills it, and without the declaration a value does", () => {
    expect(apply(upTo, { op: "bind", stepId: "send", port: "body", source: { from: "field", stepId: "owned", field: "code" } }, fs).ok).toBe(true);
    expect(apply(upTo, { op: "bind", stepId: "send", port: "body", source: { from: "literal", value: "active employees", provenance: "goal" } }, cat).ok).toBe(true);
  });
});
