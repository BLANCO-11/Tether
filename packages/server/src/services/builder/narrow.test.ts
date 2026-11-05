/**
 * M12 (E5.12): a catalogue too large for the understanding call is narrowed by one small call first — and only then. Name-free.
 */
import { describe, expect, it } from "vitest";
import type { Chooser } from "./build.js";
import { goalSpecPrompt, goalSpecSchema, type BuilderCatalogue } from "./goal-spec.js";
import { enumCount, GATEWAY_ENUM_LIMIT, narrowCatalogue, needsNarrowing } from "./narrow.js";

/** n readers (each with 2 params and 3 fields, like a real workspace's) and n/3 actions (2 params), in groups of ten by prefix. */
const catalogue = (n: number): BuilderCatalogue => ({ items: [
  ...Array.from({ length: n }, (_, i) => ({ ref: `ds${Math.floor(i / 10)}.reader_${i}`, kind: "reader" as const, about: `reader ${i}`, params: [{ name: "a", about: "" }, { name: "b", about: "" }], fields: [{ name: "x", ty: "Text" }, { name: "y", ty: "Int" }, { name: "z", ty: "Date" }] })),
  ...Array.from({ length: Math.ceil(n / 3) }, (_, i) => ({ ref: `tool${Math.floor(i / 10)}_act_${i}`, kind: "tool" as const, about: `action ${i}`, params: [{ name: "to", about: "" }, { name: "text", about: "" }] })),
] });

/** A model that picks the first two parts, then the first two readers and one action — recording every schema it was sent. */
const fake = () => {
  const sent: Array<{ name: string; enums: number }> = [];
  const f = (async (p: string, s: { name: string; schema: { properties: Record<string, { items: { enum: string[] } }> } }) => {
    sent.push({ name: s.name, enums: enumCount(s.schema) });
    // The first part, and the first part of actions (the prompt lists parts by kind; the fake reads the labels from it).
    if (s.name === "goal_parts") { const ids = s.schema.properties.parts!.items.enum; const act = /- (p\d+): actions/.exec(p)?.[1]; return JSON.stringify({ parts: [ids[0], act] }); }
    return JSON.stringify({ readers: s.schema.properties.readers!.items.enum.slice(0, 2), actions: s.schema.properties.actions!.items.enum.slice(0, 1) });
  }) as unknown as Chooser;
  return { f, sent };
};

describe("narrowing a large catalogue", () => {
  it("CONTROL: a catalogue the size of today's workspaces is not narrowed — no call, the same items", async () => {
    const cat = catalogue(24);
    expect(needsNarrowing(cat)).toBe(false);
    const m = fake();
    const r = await narrowCatalogue("goal", cat, m.f);
    expect([r.calls, r.items, m.sent]).toEqual([0, cat, []]);
  });
  it("S1: the trigger is the LIVE plan schema — a catalogue the old schema admits but the plan schema refuses IS narrowed", async () => {
    // 100 readers + 34 tools: old schema under NARROW_AT, plan schema over the gateway limit (P1 measured).
    const cat = catalogue(100);
    expect(needsNarrowing(cat)).toBe(true);
    const m = fake();
    const r = await narrowCatalogue("count the invoices", cat, m.f);
    expect(r.calls).toBeGreaterThanOrEqual(1);
    const { planSchema, clauses: planClauses } = await import("./plan.js");
    const { enumCount: strictCount } = await import("./strict-schema.js");
    expect(strictCount(planSchema(r.items, planClauses("count the invoices")))).toBeLessThanOrEqual(800);
  });
  it("10×: one small call picks the components; every schema sent, and the spec schema after, fits the gateway", async () => {
    const cat = catalogue(240);
    expect(enumCount(goalSpecSchema(cat))).toBeGreaterThan(GATEWAY_ENUM_LIMIT); // the failure being fixed
    const m = fake();
    const r = await narrowCatalogue("goal", cat, m.f);
    expect(r.calls).toBe(1);
    // The two picked readers, their datasource's other readers (kept by code, within budget), and the one action.
    expect(r.items.items.map((i) => i.ref)).toEqual([...Array.from({ length: 10 }, (_, i) => `ds0.reader_${i}`), "tool0_act_0"]);
    expect(m.sent.every((x) => x.enums <= GATEWAY_ENUM_LIMIT)).toBe(true);
    expect(enumCount(goalSpecSchema(r.items))).toBeLessThan(GATEWAY_ENUM_LIMIT);
    expect(r.narrowed).toEqual({ from: 320, to: 11 });
  });
  it("100×: a part first, then components within it — two calls, each under the limit", async () => {
    const cat = catalogue(2400);
    const m = fake();
    const r = await narrowCatalogue("goal", cat, m.f);
    expect(m.sent.map((x) => x.name)).toEqual(["goal_parts", "goal_components"]);
    expect(m.sent.every((x) => x.enums <= GATEWAY_ENUM_LIMIT)).toBe(true);
    expect(r.calls).toBe(2);
    expect(r.items.items.length).toBe(11);
    expect(enumCount(goalSpecSchema(r.items))).toBeLessThanOrEqual(800);
  });
  it("siblings are added only within the spec schema's budget", async () => {
    // One datasource with 400 readers: the pick keeps two; code adds siblings until the budget, never past it.
    const cat: BuilderCatalogue = { items: Array.from({ length: 400 }, (_, i) => ({ ref: `one.reader_${i}`, kind: "reader" as const, about: `r ${i}`, params: [{ name: "a", about: "" }], fields: [{ name: "x", ty: "Text" }] })) };
    const r = await narrowCatalogue("goal", cat, fake().f);
    expect(r.items.items.length).toBeGreaterThan(2);
    expect(r.items.items.length).toBeLessThan(400);
    expect(enumCount(goalSpecSchema(r.items))).toBeLessThanOrEqual(800);
    expect(goalSpecPrompt("goal", r.items).length).toBeLessThanOrEqual(40_000);
  });
  it("the goal's OWN area keeps a component the pick missed — within budget, no extra call (P2, RC-3, 2026-10-07)", async () => {
    // A component absent from the view is absent from the plan schema, so the plan's `none_fit` shortlist could never name it.
    // Structured, never word overlap: the goal names the datasource AREA (`ds5`), so its readers stay together.
    const base = catalogue(240);
    const cat: BuilderCatalogue = { items: base.items.map((i, idx) => (idx === 57 ? { ...i, ref: "ds5.reader_57" } : i)) };
    const m = fake();
    const r = await narrowCatalogue("count the ds5 records", cat, m.f);
    expect(m.sent).toHaveLength(1); // recall is CODE — (d): no model call beyond the pick's
    expect(r.items.items.map((i) => i.ref)).toContain("ds5.reader_57");
    expect(r.items.items.length).toBeLessThan(240);
    expect(enumCount(goalSpecSchema(r.items))).toBeLessThanOrEqual(800);
    expect(goalSpecPrompt("count the ds5 records", r.items).length).toBeLessThanOrEqual(40_000);
  });
});
