/**
 * For each (compiled-builder phase F, D-361): the loop box's ops, one test per clause. The plan's example flow is built by ops
 * alone — overdue rows → for each: IF qty > 30 → ticket, ELSE → mail the owner; merge → the loop's output → a summary — and every
 * refusal the exit gate names fires with its sentence.
 */
import { describe, expect, it } from "vitest";
import { checkState, collectOf, emissionOrder, emptyFlow, errorsOf, holesOf, loopMembers, loopOfStep, type EFlow } from "./model.js";
import { apply, readableTy, type EngineOp } from "./ops.js";
import { legalMoves } from "./legal.js";
import { fuzzFlow } from "./fuzz.js";
import { decideOps } from "./value-tests.js";
import { decideTest } from "./shape.js";
import { SYNTHETIC as cat } from "./synthetic.js";
import { render } from "../typecheck/types.js";
import { checkFlow } from "../typecheck/check.js";
import type { CheckModel } from "../typecheck/signature.js";

const run = (ops: EngineOp[], start: EFlow = emptyFlow("t")): EFlow => ops.reduce((f, op) => { const r = apply(f, op, cat); if (!r.ok) throw new Error(`${op.op}: ${r.error}`); return r.flow; }, start);
const refuse = (f: EFlow, op: EngineOp) => { const r = apply(f, op, cat); expect(r.ok).toBe(false); return r.ok ? "" : r.error; };
const valid = (f: EFlow) => expect(errorsOf(checkState(f, cat))).toEqual([]);
const lit = (value: string | number) => ({ value, from: "goal" as const });

const ROWS: EngineOp[] = [
  { op: "declare_input", id: "as_of", type: "DATE", defaults: "2026-06-30" },
  { op: "add_reader", id: "read", ref: "store.widgets" },
  { op: "bind", stepId: "read", port: "as_of", source: { from: "input", inputId: "as_of" } },
  { op: "add_transform", id: "owned", from: "read", pipeline: [{ op: "filter", where: { notNull: "owner_email" } }, { op: "limit", n: { value: 200, from: "goal" } }] },
];
const OPEN: EngineOp[] = [...ROWS, { op: "add_loop", id: "each", over: "owned" }];
const BODY: EngineOp[] = [
  ...OPEN,
  { op: "add_transform", id: "big", from: "each", pipeline: [{ op: "keep_if", where: { cmp: "gt", left: { field: "qty" }, right: { lit: lit(30) } } }] },
  { op: "add_branch", id: "when_big", when: [{ stepId: "big", test: "any" }] },
  { op: "add_call", id: "ticket", ref: "ticket_open", under: "when_big" },
  { op: "bind", stepId: "ticket", port: "title", source: { from: "literal", value: "A large widget order", provenance: "goal" } },
  { op: "bind", stepId: "ticket", port: "priority", source: { from: "literal", value: "high", provenance: "goal" } },
  { op: "add_transform", id: "line_big", from: "each", pipeline: [{ op: "project", fields: [{ name: "code", from: "code" }] }], under: "when_big" },
  { op: "add_otherwise", id: "else_small", of: "when_big" },
  { op: "add_call", id: "mail", ref: "mail_send", under: "else_small" },
  { op: "bind", stepId: "mail", port: "to", source: { from: "field", stepId: "each", field: "owner_email" } },
  { op: "bind", stepId: "mail", port: "subject", source: { from: "literal", value: "Your widget", provenance: "goal" } },
  { op: "bind", stepId: "mail", port: "body", source: { from: "field", stepId: "each", field: "state" } },
  { op: "add_transform", id: "line_small", from: "each", pipeline: [{ op: "project", fields: [{ name: "code", from: "code" }] }], under: "else_small" },
  { op: "add_merge", id: "what_happened", sources: ["line_big", "line_small"] },
];
const CLOSED: EngineOp[] = [
  ...BODY,
  { op: "close_loop", id: "results", loop: "each", result: "what_happened" },
  { op: "add_transform", id: "summary", from: "results", pipeline: [{ op: "join_text", as: "text", parts: [{ field: "code" }, { text: " · " }, { field: "state" }], sep: "\n", empty: "Nothing." }] },
  { op: "set_output", stepId: "summary" },
];

describe("the example flow, built by ops", () => {
  it("is valid and complete, and its body is exactly the per-item steps", () => {
    const f = run(CLOSED);
    const ds = checkState(f, cat);
    expect(errorsOf(ds)).toEqual([]);
    expect(holesOf(ds)).toEqual([]);
    expect(loopMembers(f, "each")).toEqual(["big", "when_big", "ticket", "line_big", "else_small", "mail", "line_small", "what_happened"]);
    // The output and everything after it are outside the box.
    expect(loopOfStep(f).has("results")).toBe(false);
    expect(loopOfStep(f).has("summary")).toBe(false);
    expect(collectOf(f, "each")?.id).toBe("results");
  });
  it("inside, the loop is ONE item; outside, its output is one row per item with ff_i, ff_ok, ff_error and ff_result", () => {
    const f = run(CLOSED);
    expect(render(readableTy(f, cat, "each") as never)).toBe("{code: Text, owner_email: Address, qty: Int, weight: Option<Number>, due: Option<Date>, state: Text, active: Bool}");
    expect(render(readableTy(f, cat, "results") as never)).toMatch(/^List<\{code: Text, .*ff_i: Int, ff_ok: Bool, ff_error: Option<Text>, ff_result: Option<\{code: Text\}>\}>$/);
  });
  it("emits the body right after the loop (the ForEach), the output after it", () => {
    const f = run(CLOSED);
    const order = emissionOrder(f);
    expect(order.slice(order.indexOf("each"), order.indexOf("each") + 10)).toEqual(["each", "big", "when_big", "ticket", "line_big", "else_small", "mail", "line_small", "what_happened", "results"]);
  });
  it("an empty body is a hole, not an error; the first step inside fills it", () => {
    const f = run(OPEN);
    valid(f);
    expect(f.holes.map((h) => h.reason)).toContain("the loop `each` runs nothing yet");
    const g = run([{ op: "add_transform", id: "one", from: "each", pipeline: [{ op: "project", fields: [{ name: "code", from: "code" }] }] }], f);
    expect(g.holes.some((h) => h.site.at === "arm")).toBe(false);
  });
  it("a step `under` the loop with no read of the item is inside it", () => {
    const f = run([...OPEN, { op: "add_call", id: "ping", ref: "chat_post", under: "each" }]);
    expect(loopOfStep(f).get("ping")).toBe("each");
  });
  it("runs per item in the fuzz: identical rows each run once, every item takes its own path", () => {
    const f = run(CLOSED);
    const r = fuzzFlow(f, cat, 40, 7, cat, { trace: true });
    expect(r.errors).toEqual([]);
    const withRows = r.traces!.find((t) => Array.isArray(t.values.owned) && (t.values.owned as unknown[]).length > 1)!;
    expect((withRows.values.results as unknown[]).length).toBe((withRows.values.owned as unknown[]).length);
    expect((withRows.values.results as Array<{ ff_i: number }>).map((x) => x.ff_i)).toEqual((withRows.values.owned as unknown[]).map((_, i) => i));
  });
  it("the listed moves include the loop and its close", () => {
    expect(legalMoves(run(ROWS), cat).find((m) => m.op === "add_loop")).toEqual({ op: "add_loop", overs: ["owned"] });
    const close = legalMoves(run(BODY), cat).find((m) => m.op === "close_loop");
    expect(close).toMatchObject({ op: "close_loop", loop: "each" });
    // A step under one path only runs for some items, so it is never offered as the result.
    expect((close as { results: string[] }).results).toContain("what_happened");
    expect((close as { results: string[] }).results).not.toContain("line_big");
  });
});

describe("refusals, each with its sentence", () => {
  it("a loop over something unbounded", () => {
    const f = run([...ROWS, { op: "add_transform", id: "all", from: "read", pipeline: [{ op: "filter", where: { notNull: "owner_email" } }] }]);
    expect(refuse(f, { op: "add_loop", id: "each", over: "all" })).toMatch(/cannot be looped over: it has no `limit`/);
  });
  it("a loop inside a loop", () => {
    const f = run([...OPEN, { op: "add_transform", id: "inner", from: "each", pipeline: [{ op: "take", field: "code" }] }]);
    expect(refuse(f, { op: "add_loop", id: "again", over: "inner" })).toMatch(/inside a loop; a loop runs over a top-level list — a loop inside a loop is not emitted/);
  });
  it("an approval inside a loop", () => {
    const f = run(BODY);
    expect(refuse(f, { op: "add_gate", id: "ok_first", before: "mail", summary: "Send it?" })).toMatch(/an approval inside a loop cannot be delivered to its own item/);
  });
  it("a step outside reading a step inside", () => {
    const f = run([...BODY, { op: "add_call", id: "after", ref: "chat_post" }]);
    expect(loopOfStep(f).has("after")).toBe(false);
    expect(refuse(f, { op: "bind", stepId: "after", port: "text", source: { from: "field", stepId: "each", field: "code" } })).toMatch(/runs once per item of `each`; a step outside the loop cannot read it — read the loop's output/);
  });
  it("a step inside reading the loop's own output, or a step placed after the loop began", () => {
    const f = run([...CLOSED, { op: "add_transform", id: "late", from: "read", pipeline: [{ op: "limit", n: lit(3) }] }]);
    expect(refuse(f, { op: "add_transform", id: "x", from: "results", pipeline: [{ op: "count", as: "n" }], under: "each" })).toMatch(/runs after the loop/);
    expect(refuse(f, { op: "add_transform", id: "y", from: "late", pipeline: [{ op: "count", as: "n" }], under: "each" })).toMatch(/placed after the loop `each` begins/);
  });
  it("a result that runs for only some items, or is not inside", () => {
    const f = run(BODY);
    expect(refuse(f, { op: "close_loop", id: "results", loop: "each", result: "line_big" })).toMatch(/runs only for items where `when_big` holds — merge the paths first/);
    expect(refuse(f, { op: "close_loop", id: "results", loop: "each", result: "owned" })).toMatch(/is not a step inside `each`/);
  });
  it("the flow's result is never an inside step or the loop", () => {
    const f = run(BODY);
    expect(refuse(f, { op: "set_output", stepId: "what_happened" })).toMatch(/runs once per item of `each` — the flow's result is the loop's output/);
    expect(refuse(f, { op: "set_output", stepId: "each" })).toMatch(/runs once per item/);
  });
  it("settings out of range, and items that already carry a field the output adds", () => {
    expect(refuse(run(ROWS), { op: "add_loop", id: "each", over: "owned", concurrency: 21 })).toMatch(/1 to 20 items at once/);
    // An item's OWN `ok`/`result` no longer collides (the loop's fields are `ff_`-prefixed, D-363 amended) — closes, and both survive.
    const own = (name: string) => run([...ROWS, { op: "add_transform", id: "flagged", from: "owned", pipeline: [{ op: "project", fields: [{ name, from: "active" }, { name: "code", from: "code" }] }, { op: "limit", n: lit(10) }] }, { op: "add_loop", id: "each", over: "flagged" }, { op: "add_transform", id: "c", from: "each", pipeline: [{ op: "project", fields: [{ name: "code", from: "code" }] }] }]);
    const closed = run([{ op: "close_loop", id: "results", loop: "each", result: "c" }], own("ok"));
    expect(render(readableTy(closed, cat, "results") as never)).toMatch(/ok: Bool.*ff_ok: Bool/);
    // Only an item that already carries a Foundry field is refused, by name.
    expect(refuse(own("ff_ok"), { op: "close_loop", id: "results", loop: "each", result: "c" })).toMatch(/already have a field `ff_ok`.*Foundry's/);
  });
  it("a loop is removed only once its body and its output are gone", () => {
    const f = run(OPEN.concat([{ op: "add_transform", id: "one", from: "each", pipeline: [{ op: "project", fields: [{ name: "code", from: "code" }] }] }]));
    expect(refuse(f, { op: "remove_step", stepId: "each" })).toMatch(/read by one/);
    const g = run([{ op: "remove_step", stepId: "one" }, { op: "remove_step", stepId: "each" }], f);
    valid(g);
    expect(g.holes.some((h) => h.site.at === "arm")).toBe(false);
  });
});

describe("the checker (the property test's oracle) states the loop rules on its own", () => {
  it("an outside read of the body is FT0704, an approval inside is FT0703", () => {
    const f = run(BODY);
    const outside: CheckModel = { ...(f as unknown as CheckModel), steps: [...f.steps, { id: "after", kind: "transform", from: "big", pipeline: [{ op: "count", as: "n" }], expr: "", dependsOn: ["big"] }] as never };
    // `after` depends on `big`, so by the closure it is INSIDE — the oracle needs a real cross-edge read: a step reading the
    // body but not depending on it (a binding without the dependency).
    const cross: CheckModel = { ...(f as unknown as CheckModel), steps: [...f.steps, { id: "after", kind: "tool", ref: "chat_post", inputs: [{ name: "text", source: { from: "step", stepId: "each", field: "code" } }, { name: "channel", source: { from: "literal", value: "#ops" } }], dependsOn: [] }] as never };
    expect(checkFlow(outside, cat).filter((d) => d.code === "FT0704")).toEqual([]);
    expect(checkFlow(cross, cat).map((d) => d.code)).toContain("FT0704");
    const gated: CheckModel = { ...(f as unknown as CheckModel), steps: [...f.steps, { id: "gate", kind: "approval", summary: "x", dependsOn: ["each"] }] as never };
    expect(checkFlow(gated, cat).map((d) => d.code)).toContain("FT0703");
  });
});

describe("an else-if inside a loop (D-382): its test runs ahead of its chain there, as at the top level", () => {
  it("decideOps builds IF / ELSE IF / ELSE on the item — the canvas's and the builder's one function — and the chain checks clean", () => {
    let f = run([...OPEN]);
    const d1 = decideOps(f, cat, { subject: "each", measure: "qty", cmp: "gt", value: "30", from: "goal" });
    if (typeof d1 === "string") throw new Error(d1);
    f = run(d1.ops, f);
    const d2 = decideOps(f, cat, { subject: "each", measure: "qty", cmp: "gt", value: "10", from: "goal", of: d1.branch });
    if (typeof d2 === "string") throw new Error(d2);
    f = run([...d2.ops, { op: "add_otherwise", id: "small", of: d2.branch }, { op: "add_call", id: "big", ref: "chat_post", under: d1.branch }, { op: "add_call", id: "mid", ref: "chat_post", under: d2.branch }, { op: "add_call", id: "rest", ref: "chat_post", under: "small" }], f);
    valid(f);
    // Every link and its test is inside the loop; the else-if's test runs ahead of the chain's head.
    expect(loopMembers(f, "each")).toEqual(expect.arrayContaining([d1.test, d1.branch, d2.test, d2.branch, "small", "big", "mid", "rest"]));
    const order = emissionOrder(f);
    expect(order.indexOf(d2.test)).toBeLessThan(order.indexOf(d1.branch));
    expect(decideTest(f, d2.test)).toMatchObject({ subject: "each" });
  });
  it("CONTROL: a step is placed ahead of another only in the same place — never from outside a loop to inside it", () => {
    const f = run([...BODY]);
    const r = apply(f, { op: "add_transform", id: "ahead", from: "read", pipeline: [{ op: "limit", n: { value: 5, from: "goal" } }], before: "big" }, cat);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/runs inside the loop `each`.*same place/);
  });
});
