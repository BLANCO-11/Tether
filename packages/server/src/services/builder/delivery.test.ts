/**
 * Slice 5f — delivery (where the result goes, who gets it) is the person's decision, settled before building. NAME-FREE: the
 * synthetic catalogue's tools are told apart only by their declared port types.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SYNTHETIC as cat } from "@foundry/flow-edit";

vi.mock("../flow.service.js", () => ({ flowService: {} }));
vi.mock("../../repositories/flow.repo.js", () => ({ flowRepo: {} }));
vi.mock("../flow-catalogue.service.js", () => ({ flowCatalogueService: {} }));
vi.mock("../flow-typecheck.js", () => ({ buildCatalogueSnapshot: vi.fn() }));
vi.mock("../../repositories/datasource.repo.js", () => ({ datasourceRepo: {} }));

const { deliveryFindings, DELIVERY_ASK } = await import("./delivery.js");
const { recheck, run } = await import("./builder.service.js");
const { checkSpec, specOutcome, UNSAID, NONE_FIT } = await import("./goal-spec.js");
import type { BuilderCatalogue, GoalSpec } from "./goal-spec.js";
import type { BuildQuestion, Chooser } from "./build.js";

const ITEMS: BuilderCatalogue = { items: [
  { ref: "store.people", kind: "reader", about: "people", fields: [{ name: "name", ty: "Text" }, { name: "email", ty: "Address" }] },
  { ref: "mail_send", kind: "tool", about: "send an email", params: [{ name: "to", about: "" }, { name: "subject", about: "" }, { name: "body", about: "" }, { name: "cc", about: "" }] },
  { ref: "chat_post", kind: "tool", about: "post to a channel", params: [{ name: "channel", about: "" }, { name: "text", about: "" }] },
  { ref: "notify_me", kind: "tool", about: "notify", params: [{ name: "to", about: "" }, { name: "text", about: "" }] },
  { ref: "llm_complete", kind: "tool", about: "write text", params: [{ name: "input", about: "" }, { name: "instruction", about: "" }] },
] };
const GOAL = "a daily list of the people in store people";
const spec = (over: Partial<GoalSpec> = {}): GoalSpec => ({ sources: [{ ref: "store.people", quote: "the people in store people" }], sinks: [], values: [], conditions: [], schedule: null, missing: null, ...over });

describe("deliveryFindings — from declared port types only", () => {
  it("a goal that only reads (or only has a model write text) is NOT asked: its result is the data — delivery is offered, never added", () => {
    expect(deliveryFindings(spec(), cat)).toMatchObject({ ask: false, notes: [] });
    expect(deliveryFindings(spec({ sinks: [{ ref: "llm_complete", quote: "summarised" }] }), cat)).toMatchObject({ ask: false, notes: [] });
  });
  it("⚠ except on a schedule: a scheduled run has no caller, so a flow that only reads is ASKED where its result goes", () => {
    const d = deliveryFindings(spec({ schedule: { cron: "0 9 * * *", quote: "daily" } }), cat);
    expect(d.ask).toBe(true);
    // CONTROL: the same goal with no schedule is complete as it is.
    expect(deliveryFindings(spec(), cat).ask).toBe(false);
  });
  it("a vague action (`unsaid`): asked, once, with the actions that DO something as the choices (not model-written text)", () => {
    const d = deliveryFindings(spec({ sinks: [{ ref: UNSAID, quote: "" }] }), cat);
    expect(d.ask).toBe(true);
    expect(d.options).toEqual(expect.arrayContaining(["mail_send", "chat_post", "notify_me"]));
    expect(d.options).not.toContain("llm_complete");
  });
  it("an action to a listed place, and nothing says which: asked; a stated channel settles it", () => {
    expect(deliveryFindings(spec({ sinks: [{ ref: "chat_post", quote: "post" }] }), cat).ask).toBe(true);
    expect(deliveryFindings(spec({ sinks: [{ ref: "chat_post", quote: "post" }], values: [{ role: "channel", from: "goal", quote: "the ops room", fills: "chat_post.channel" }] }), cat).ask).toBe(false);
  });
  it("a PERSON — or “me” — for an action that only posts to a listed place: a code finding for the re-understanding, not a question", () => {
    const me = deliveryFindings(spec({ sinks: [{ ref: "chat_post", quote: "flag it" }], values: [{ role: "recipient", from: "requester", quote: "me", fills: "none" }] }), cat);
    expect(me.ask).toBe(false);
    expect(me.notes[0]).toMatch(/cannot reach the person who runs it \(“me”\)/);
    const them = deliveryFindings(spec({ sinks: [{ ref: "chat_post", quote: "remind" }], values: [{ role: "recipient", from: "goal", quote: "each owner", fills: "none" }] }), cat);
    expect(them.notes[0]).toMatch(/cannot reach “each owner”/);
  });
  it("an action that reaches a person is settled by the solver as today; a refusal or a goal reading nothing has nothing to settle", () => {
    expect(deliveryFindings(spec({ sinks: [{ ref: "mail_send", quote: "email" }] }), cat)).toMatchObject({ ask: false, notes: [] });
    expect(deliveryFindings(spec({ sinks: [{ ref: NONE_FIT, quote: "text me" }], missing: "an SMS action" }), cat).ask).toBe(false);
    expect(deliveryFindings(spec({ sources: [] }), cat).ask).toBe(false);
  });
});

describe("the spec: `unsaid` is a question, never a refusal", () => {
  it("kept with an empty quote, outcome `asks`, and read back as a question", () => {
    const c = checkSpec(spec({ sinks: [{ ref: UNSAID, quote: "" }] }), [GOAL], ITEMS);
    expect(c.spec.sinks).toEqual([{ ref: UNSAID, quote: "" }]);
    expect(specOutcome(c.spec)).toBe("asks");
    expect(recheck({ goal: GOAL, texts: [GOAL], spec: c.spec }, ITEMS).readback.join("\n")).toMatch(/Does: not said — I will ask you what should happen/);
  });
  it("a `missing` beside `unsaid` alone is dropped — nothing was found absent", () => {
    const c = checkSpec(spec({ sinks: [{ ref: UNSAID, quote: "" }], missing: "a way to flag" }), [GOAL], ITEMS);
    expect(c.spec.missing).toBeNull();
    expect(specOutcome(c.spec)).toBe("asks");
  });
});

describe("run — the answer fills its slot; the goal is not re-read", () => {
  /** The model, scripted: answers only the one-slot delivery call, and records every call it was asked to make. */
  const model = (slot: { action: string; receives_it: string; who?: string } | null) => {
    const seen: Array<{ name: string; prompt: string }> = [];
    const f = (async (p: string, schema: { name: string }) => {
      seen.push({ name: schema.name, prompt: p });
      if (schema.name === "delivery_slot" && slot) return JSON.stringify(slot);
      throw new Error(`unexpected call ${schema.name}`);
    }) as unknown as Chooser;
    return { f, seen };
  };
  const answering = (reply: string | null) => { const asked: BuildQuestion[] = []; return { asked, a: async (qs: BuildQuestion[]) => { asked.push(...qs); return qs.map(() => reply); } }; };
  const u0 = (s: GoalSpec, goal = GOAL) => recheck({ goal, texts: [goal], spec: s }, ITEMS);

  it("a listed value settles it BY TYPE: no model call at all, the flow posts there", async () => {
    const m = model(null);
    const p = answering("#ops");
    const r = await run(u0(spec({ sinks: [{ ref: UNSAID, quote: "" }] })), ITEMS, cat, m.f, p.a);
    expect(p.asked.filter((q) => q.holeId.startsWith("delivery:"))).toHaveLength(1);
    expect(p.asked[0]!.ask).toBe(DELIVERY_ASK);
    expect(m.seen).toEqual([]);
    const call = r.flow.steps.find((x) => x.kind === "tool") as { ref: string; inputs: Array<{ name: string; source: { value?: string } }> } | undefined;
    expect(call?.ref).toBe("chat_post");
    expect(call?.inputs.find((b) => b.name === "channel")?.source.value).toBe("#ops");
    expect(r.loopProblems).toEqual([]);
  });

  it("an ADDRESS answer names who by type: the call is offered no “who” to choose, and the address reaches the port", async () => {
    const schemas: unknown[] = [];
    const f = (async (_p: string, schema: { name: string; schema: unknown }) => { schemas.push(schema.schema); return JSON.stringify({ action: "notify_me", receives_it: "notify_me.to" }); }) as unknown as Chooser;
    const r = await run(u0(spec({ sinks: [{ ref: UNSAID, quote: "" }] })), ITEMS, cat, f, answering("pat@acme.example").a);
    expect(JSON.stringify(schemas[0])).not.toMatch(/who/);
    expect(r.flow.steps.find((x) => x.kind === "tool")).toMatchObject({ ref: "notify_me" });
    // The answer is who, from the person's words, for the port — never "the person who runs it".
    expect(r.understood?.checked.spec.values).toContainEqual(expect.objectContaining({ role: "recipient", from: "goal", quote: "pat@acme.example", fills: "notify_me.to" }));
  });
  it("words: ONE call whose schema is only the slot; nothing else of the spec is re-decided", async () => {
    const m = model({ action: "notify_me", receives_it: "notify_me.to", who: "the person who runs it" });
    const p = answering("just tell me");
    const r = await run(u0(spec({ sinks: [{ ref: UNSAID, quote: "" }] })), ITEMS, cat, m.f, p.a);
    expect(m.seen.map((x) => x.name)).toEqual(["delivery_slot"]);
    expect(m.seen[0]!.prompt).toMatch(/THEY ANSWERED: just tell me/);
    expect(r.understood?.checked.spec.sources).toEqual(spec().sources);
    expect(r.understood?.checked.spec.sinks.map((x) => x.ref)).toEqual(["notify_me"]);
    expect(r.flow.steps.some((x) => x.kind === "tool" && x.ref === "notify_me")).toBe(true);
    expect(r.trace.unmet ?? []).toEqual([]);
  });

  it("unanswered: stated unmet, never a guess, never asked again, no call", async () => {
    const m = model(null);
    const p = answering(null);
    const r = await run(u0(spec({ sinks: [{ ref: UNSAID, quote: "" }] })), ITEMS, cat, m.f, p.a);
    expect(m.seen).toEqual([]);
    expect(r.status).toBe("incomplete");
    expect(r.trace.unmet).toContain("the goal asks for something to be done, and what was not settled");
    expect(p.asked.filter((q) => q.holeId.startsWith("delivery:"))).toHaveLength(1);
  });

  it("an action that cannot reach who the goal names: swapped among those that CAN, no person asked, their words kept", async () => {
    const goal = "a daily list of the people in store people for me";
    const s = spec({ sinks: [{ ref: "chat_post", quote: "a daily list" }], values: [{ role: "recipient", from: "requester", quote: "me", fills: "none" }] });
    const m = model({ action: "notify_me", receives_it: "notify_me.to" });
    const p = answering("x");
    const r = await run(u0(s, goal), ITEMS, cat, m.f, p.a);
    expect(p.asked).toHaveLength(0);
    // Only the actions that reach a person are offered — never the one that could not, never `none_fit`.
    expect(m.seen[0]!.prompt).not.toMatch(/- chat_post:/);
    expect(r.understood?.texts).toEqual([goal]);
    expect(r.understood?.checked.spec.values.find((v) => v.role === "recipient")).toMatchObject({ from: "requester", fills: "notify_me.to" });
    expect(r.flow.steps.some((x) => x.kind === "tool" && x.ref === "notify_me")).toBe(true);
  });

  it("no action but the goal names who (“me”): not asked — settled from the goal's own words", async () => {
    const goal = "the people in store people, flagged to me";
    const s = spec({ sinks: [{ ref: UNSAID, quote: "flagged" }], values: [{ role: "recipient", from: "requester", quote: "me", fills: "none" }] });
    const m = model({ action: "notify_me", receives_it: "notify_me.to" });
    const p = answering("x");
    const r = await run(u0(s, goal), ITEMS, cat, m.f, p.a);
    expect(p.asked).toHaveLength(0);
    expect(r.understood?.checked.spec.sinks.map((x) => x.ref)).toEqual(["notify_me"]);
  });

  it("an edit of a flow that already acts is not asked where results go", async () => {
    const start = { id: "f", steps: [{ id: "call_1", kind: "tool", ref: "notify_me", inputs: [], dependsOn: [] }], inputs: [], holes: [] } as never;
    const p = answering("x");
    await run(u0(spec()), ITEMS, cat, model(null).f, p.a, start).catch(() => {});
    expect(p.asked.filter((q) => q.holeId.startsWith("delivery:"))).toHaveLength(0);
  });
});

describe("agnostic", () => {
  it("delivery.ts names no tool, field or workspace", () => {
    const src = readFileSync(fileURLToPath(new URL("./delivery.ts", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src.length).toBeGreaterThan(1500);
    expect(src).not.toMatch(/"(?:[a-z]+_demo|mail|email|chat|slack|ticket|page|oncall|llm)[^"]*"/i);
  });
});
