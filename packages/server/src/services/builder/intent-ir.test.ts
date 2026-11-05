/**
 * Intent IR pin-by-construction — Strategy B Phase 1.
 */
import { afterEach, describe, expect, it } from "vitest";
import { acceptGaps, intentIrEnabled, irFromSpec, mergeIntent, pinAll, pinSpecByIr, removeNodes, patchIr, specFromIr, touchIdsFromAnswer } from "./intent-ir.js";
import type { GoalSpec } from "./goal-spec.js";

const PREV: GoalSpec = {
  sources: [{ ref: "store.people", quote: "everyone in store people" }],
  sinks: [{ ref: "mail_send", quote: "email them" }],
  values: [],
  conditions: [],
  schedule: null,
  missing: null,
};

afterEach(() => {
  delete process.env.BUILDER_INTENT_IR;
});

describe("intentIrEnabled", () => {
  it("on by default (unset)", () => {
    delete process.env.BUILDER_INTENT_IR;
    expect(intentIrEnabled()).toBe(true);
  });
  it("off with 0 / false / off", () => {
    for (const v of ["0", "false", "off", "FALSE"]) {
      process.env.BUILDER_INTENT_IR = v;
      expect(intentIrEnabled()).toBe(false);
    }
  });
});

describe("intent-ir merge", () => {
  it("restores pinned source when proposal flips it without a touch id", () => {
    const prev = pinAll(irFromSpec("g", PREV));
    const next = irFromSpec("g", { ...PREV, sources: [{ ref: "store.widgets", quote: "everyone in store people" }] });
    const { ir, restored } = mergeIntent(prev, next, []);
    expect(restored).toContain("source:0");
    expect(specFromIr(ir).sources[0]!.ref).toBe("store.people");
  });

  it("allows overwrite when touchIds names the node", () => {
    const prev = pinAll(irFromSpec("g", PREV));
    const next = irFromSpec("g", { ...PREV, sources: [{ ref: "store.widgets", quote: "widgets" }] });
    const { ir, restored } = mergeIntent(prev, next, ["source:0"]);
    expect(restored).toEqual([]);
    expect(specFromIr(ir).sources[0]!.ref).toBe("store.widgets");
  });

  it("acceptGaps pins and records keys", () => {
    const ir = acceptGaps(irFromSpec("g", PREV), ["words:threshold"]);
    expect(ir.acceptedGaps).toContain("words:threshold");
    expect(ir.nodes.every((n) => n.pinned)).toBe(true);
  });

  it("pinSpecByIr freezes schedule flipped without touch", () => {
    const next: GoalSpec = { ...PREV, schedule: { cron: "0 9 * * 1", quote: "every Monday" } };
    const { spec, pinned } = pinSpecByIr(PREV, next, "email everyone in store people");
    expect(pinned.length).toBeGreaterThan(0);
    expect(spec.schedule).toBeNull();
  });

  it("touchIdsFromAnswer names only nodes the answer's words hit", () => {
    const ids = touchIdsFromAnswer(PREV, "change the email step", "email everyone in store people");
    expect(ids.some((id) => id.startsWith("sink:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("source:"))).toBe(false);
  });

  it("pinSpecByIr lets a touched summary change and freezes the rest", () => {
    const withSum: GoalSpec = {
      ...PREV,
      summary: { over: "store.people", quote: "count by hours", by: [], measures: [{ name: "m", fn: "band_count", field: "hours", words: "hours", bands: [{ test: "at_least", value: "4.75", then: 0.5, words: "half" }] }] },
    };
    const next: GoalSpec = {
      ...withSum,
      summary: { ...withSum.summary!, measures: [{ name: "m", fn: "band_count", field: "hours", words: "hours", bands: [{ test: "below", value: "4.75", then: 1, words: "full" }] }] },
      sinks: [{ ref: "other_tool", quote: "do something else" }],
    };
    const touch = touchIdsFromAnswer(withSum, "use less than 4.75 not less than equals", "count by hours at 4.75");
    expect(touch).toContain("summary:0");
    const { spec } = pinSpecByIr(withSum, next, "count by hours at 4.75", touch);
    expect(spec.summary?.measures?.[0]?.bands?.[0]?.test).toBe("below");
    expect(spec.sinks[0]!.ref).toBe("mail_send"); // untouched sink frozen
  });

  it("pinSpecByIr restores sources emptied without a touch id (T13 / e7412613)", () => {
    const next: GoalSpec = { ...PREV, sources: [] };
    const { spec } = pinSpecByIr(PREV, next, "email everyone in store people");
    // mergeIntent keeps omitted pinned nodes; the empty-sources guard is defense if that ever stops.
    expect(spec.sources).toEqual(PREV.sources);
    // CONTROL: an explicit touch may replace the source when the proposal names one.
    const touched = pinSpecByIr(PREV, { ...PREV, sources: [{ ref: "store.widgets", quote: "widgets" }] }, "email everyone in store people", ["source:0"]);
    expect(touched.spec.sources[0]!.ref).toBe("store.widgets");
  });

  it("removeNodes drops only named ids (edit/delete on IR)", () => {
    const ir = pinAll(irFromSpec("g", PREV));
    const next = removeNodes(ir, ["sink:0"]);
    expect(specFromIr(next).sinks).toEqual([]);
    expect(specFromIr(next).sources[0]!.ref).toBe("store.people");
  });

  it("patchIr updates only touchIds", () => {
    const prev = pinAll(irFromSpec("g", PREV));
    const proposal = irFromSpec("g", { ...PREV, sinks: [{ ref: "chat_post", quote: "post instead" }] });
    const ir = patchIr(prev, proposal, ["sink:0"]);
    expect(specFromIr(ir).sinks[0]!.ref).toBe("chat_post");
    expect(specFromIr(ir).sources[0]!.ref).toBe("store.people");
  });
});

describe("irToMemory (S7)", () => {
  it("S7: renders one compact line per pinned node, nothing unpinned", async () => {
    const { irToMemory } = await import("./intent-ir.js");
    const ir = pinAll(irFromSpec("email everyone in store people", PREV));
    const mem = irToMemory(ir);
    expect(mem).toContain("[source:0] source store.people");
    expect(mem).toContain("[sink:0] sink");
    expect(irToMemory(irFromSpec("g", PREV))).toBe("");
  });

  it("S7: accepted gaps ride as memory, never re-asked", async () => {
    const { irToMemory } = await import("./intent-ir.js");
    const ir = acceptGaps(pinAll(irFromSpec("g", PREV)), ["who-receives"]);
    expect(irToMemory(ir)).toContain("[accepted] who-receives");
  });
});
