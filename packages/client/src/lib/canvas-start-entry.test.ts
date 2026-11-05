// src/lib/canvas-start-entry.test.ts — the Start boundary can say what makes a
// flow run, and it never claims to know something it did not read.
//
// ⚠ The three-state rule is the subject of most of this file. A trigger list
// that could not be read must render as neither "none" nor "has triggers", and
// a surface that never looked must render as neither of those either. Both
// wrong answers are one `?? []` away, which is why they are pinned.
import { describe, expect, it } from "vitest";
import {
  describeStartEntry,
  startEntryFacts,
  startEntryFrom,
  withStart,
  START_ID,
  type CanvasGraph,
  type CanvasNode,
  type StartEntry,
} from "./canvas-model";

/**
 * ⚠ Fully typed rather than cast. A loose fixture here would let this file
 * assert against a node shape the adapters never produce — the trap this repo
 * already hit with `flow({ armedRevision: 3 })`, a state the server cannot
 * write.
 */
const node = (id: string, kind: CanvasNode["kind"]): CanvasNode => ({
  id,
  label: id,
  kind,
  ref: null,
  status: null,
  seam: null,
  meta: null,
  attempt: null,
  generated: false,
  platform: false,
});

const graph = (): CanvasGraph => ({
  nodes: [node("read", "query"), node("send", "tool")],
  edges: [{ source: "read", target: "send" }],
  hasSeam: false,
  hasUnknownSeam: false,
});

describe("describeStartEntry", () => {
  it("reads a schedule back in describeCron's own words", () => {
    expect(describeStartEntry({ schedule: { cron: "0 15 * * 2" } })).toBe("Every Tuesday at 15:00");
    expect(describeStartEntry({ schedule: { cron: "0 */6 * * *" } })).toBe("Every 6 hours");
  });

  it("⚠ says 'a custom schedule' rather than guessing at an expression it cannot read", () => {
    // Kestra owns cron. A wrong plain-English reading of when something fires
    // is the sentence somebody quotes back after the batch went out at the
    // wrong hour.
    expect(describeStartEntry({ schedule: { cron: "0 9 L * *" } })).toBe("a custom schedule");
  });

  it("names an enabled trigger when there is no timer", () => {
    expect(describeStartEntry({ triggers: [{ kind: "api", enabled: true }] })).toBe("api trigger");
    expect(
      describeStartEntry({
        triggers: [
          { kind: "api", enabled: true },
          { kind: "webhook", enabled: true },
        ],
      }),
    ).toBe("2 triggers");
  });

  it("⚠ a DISABLED trigger is not a way in, so it does not become the caption", () => {
    // Every trigger defaults to off, and gate 1 wants a successful run before
    // one can be enabled. A caption naming a disabled trigger would claim the
    // automation can be reached when it cannot.
    expect(describeStartEntry({ triggers: [{ kind: "api", enabled: false }] })).toBe("Manual only");
  });

  it("says 'Manual only' — a fact, not an empty state", () => {
    expect(describeStartEntry({})).toBe("Manual only");
    expect(describeStartEntry(null)).toBe("Manual only");
  });

  it("⚠ an UNREADABLE trigger list is neither 'Manual only' nor a trigger", () => {
    // Degrading it to `[]` claims nothing fires this flow, on a flow an enabled
    // API trigger may be firing — an absence of findings nobody obtained.
    expect(describeStartEntry({ triggersUnreadable: true })).toBe(
      "No timer · triggers unreadable",
    );
  });

  it("⚠ a real schedule outranks an unreadable trigger list", () => {
    // The schedule is a fact we hold; not knowing about triggers does not put
    // it in doubt. Ordering is the whole of this.
    expect(describeStartEntry({ schedule: { cron: "0 7 * * *" }, triggersUnreadable: true })).toBe(
      "Every day at 07:00",
    );
  });
});

describe("startEntryFacts", () => {
  it("carries the timezone beside the reading when there is one", () => {
    expect(startEntryFacts({ schedule: { cron: "0 7 * * 1", timezone: "Asia/Kolkata" } })).toEqual([
      { label: "timer", value: "Every Monday at 07:00 · Asia/Kolkata" },
    ]);
  });

  it("states the absence of a timer rather than omitting the row", () => {
    expect(startEntryFacts({ triggers: [] })).toEqual([
      { label: "timer", value: "none — nothing runs this on a schedule" },
      { label: "triggers", value: "none" },
    ]);
  });

  it("reports a disabled trigger as disabled instead of hiding it", () => {
    // Hidden, somebody who created one and cannot see it concludes the
    // creation failed. Listed, they read the real state.
    const facts = startEntryFacts({ triggers: [{ kind: "api", enabled: false }] });
    expect(facts).toContainEqual({ label: "api", value: "created, not enabled" });
  });

  it("⚠ an unreadable list says so and does NOT say 'none'", () => {
    const facts = startEntryFacts({ triggersUnreadable: true });
    expect(facts).toContainEqual({ label: "triggers", value: 'could not be read — this is not "none"' });
    expect(facts.some((f) => f.value === "none")).toBe(false);
  });

  it("⚠ says NOTHING about triggers when the caller did not read them", () => {
    // ChatWorkbench does not fetch triggers. Reporting "none" there would be a
    // claim about state nobody looked at — distinct from both other states.
    const facts = startEntryFacts({ schedule: { cron: "0 7 * * *" } });
    expect(facts.map((f) => f.label)).toEqual(["timer"]);
  });
});

describe("startEntryFrom", () => {
  it("narrows a stored schedule and a trigger list", () => {
    expect(
      startEntryFrom({ cron: "0 7 * * 1", timezone: "UTC" }, [{ type: "api", enabled: true }]),
    ).toEqual({
      schedule: { cron: "0 7 * * 1", timezone: "UTC" },
      triggers: [{ kind: "api", enabled: true }],
    });
  });

  it("⚠ null triggers means the READ FAILED; undefined means not supplied", () => {
    // A bare `!Array.isArray` check collapses the two and loses the whole
    // distinction the three states exist for.
    expect(startEntryFrom(null, null).triggersUnreadable).toBe(true);
    expect(startEntryFrom(null, undefined).triggersUnreadable).toBeUndefined();
    expect(startEntryFrom(null, undefined).triggers).toBeUndefined();
  });

  it("⚠ keeps an EMPTY trigger list as [] rather than collapsing it to undefined", () => {
    // `[]` is "checked, there are none"; `undefined` is "did not look".
    expect(startEntryFrom(null, []).triggers).toEqual([]);
  });

  it("drops a schedule with no cron rather than carrying an empty one", () => {
    expect(startEntryFrom({ timezone: "UTC" }, []).schedule).toBeUndefined();
    expect(startEntryFrom("0 7 * * *", []).schedule).toBeUndefined();
  });

  it("keeps an unknown trigger shape out instead of inventing a kind", () => {
    expect(startEntryFrom(null, [{ enabled: true }, null, "api"]).triggers).toEqual([]);
  });
});

describe("withStart, given an entry", () => {
  it("puts what starts the flow first in the caption, with the input count after", () => {
    const g = withStart(graph(), [{ id: "as_of", type: "DATE", required: true }], {
      schedule: { cron: "0 15 * * 2" },
      triggers: [],
    });
    const start = g.nodes.find((n) => n.id === START_ID)!;
    expect(start.meta).toBe("Every Tuesday at 15:00 · 1 input");
  });

  it("⚠ is UNCHANGED when no entry is supplied, so no existing surface moves", () => {
    // Every call site that has not opted in keeps exactly today's card. This is
    // what makes the addition unable to break a surface it was not added to.
    const before = withStart(graph(), [{ id: "as_of", type: "DATE", required: true }]);
    const start = before.nodes.find((n) => n.id === START_ID)!;
    expect(start.meta).toBe("1 input");
    expect(start.facts?.map((f) => f.label)).toEqual(["as_of"]);
  });

  it("shows the entry facts ahead of the declarations", () => {
    const g = withStart(graph(), [{ id: "as_of", type: "DATE", required: true }], {
      schedule: { cron: "0 7 * * *" },
      triggers: [{ kind: "api", enabled: false }],
    });
    const start = g.nodes.find((n) => n.id === START_ID)!;
    expect(start.facts?.map((f) => f.label)).toEqual(["timer", "api", "as_of"]);
  });

  it("⚠ adds NO node and NO edge of its own — the graph shape is untouched", () => {
    /**
     * The load-bearing property. A schedule node before Start would mean an
     * EDGE into Start, and `armOf` is a blind transitive closure over
     * `dependsOn` — the trap that forced the `merge` kind into existence.
     * `depths()`, `orderedStepIds` and the strip all read this graph.
     */
    const withoutEntry = withStart(graph(), []);
    const withEntry = withStart(graph(), [], { schedule: { cron: "0 7 * * *" }, triggers: [] });
    expect(withEntry.nodes.length).toBe(withoutEntry.nodes.length);
    expect(withEntry.edges).toEqual(withoutEntry.edges);
    expect(withEntry.nodes.map((n) => n.id)).toEqual(withoutEntry.nodes.map((n) => n.id));
  });

  it("⚠ keeps the entry OFF the sizing rows the card is measured by", () => {
    /**
     * ⚠ `bodyHeight` counts `meta` on a row it already adds, and the boundary
     * card SCROLLS `facts` rather than growing by them. So the entry costs no
     * sizing change and I-66's quieter successor — a card outgrowing its
     * declared size attaches every edge to the wrong place with nothing
     * flickering to say so — cannot be reached from here.
     *
     * This asserts the mechanism: the entry lands in `meta` and `facts` and in
     * no other field. Moving it to a new row without adding that row to
     * `bodyHeight` turns this red.
     */
    const plain = withStart(graph(), [], { triggers: [] });
    const scheduled = withStart(graph(), [], { schedule: { cron: "0 7 * * *" }, triggers: [] });
    const a = plain.nodes.find((n) => n.id === START_ID)!;
    const b = scheduled.nodes.find((n) => n.id === START_ID)!;
    const differing = (Object.keys(b) as Array<keyof typeof b>).filter(
      (k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]),
    );
    expect(differing.sort()).toEqual(["facts", "meta"]);
    // And specifically NOT the two fields `bodyHeight` grows a card by.
    expect(b.ref).toBeNull();
    expect((b as { question?: unknown }).question).toBeUndefined();
  });

  it("returns the SAME object when there is nothing to add, entry or not", () => {
    // I-66: a rebuilt array resets `measured` and every edge unmounts.
    const empty: CanvasGraph = { nodes: [], edges: [], hasSeam: false, hasUnknownSeam: false };
    expect(withStart(empty, [], { schedule: { cron: "0 7 * * *" } })).toBe(empty);
  });
});

describe("the entry a real deployment flow is in", () => {
  it("⚠ says a required input with no default cannot be scheduled", () => {
    // `Chase overdue invoices` on this deployment: one required DATE input with
    // no default, and no schedule. It CANNOT be armed on a timer, and before
    // this the canvas said nothing about either half.
    const entry: StartEntry = startEntryFrom(undefined, []);
    expect(describeStartEntry(entry)).toBe("Manual only");
    const g = withStart(graph(), [{ id: "as_of", type: "DATE", required: true }], entry);
    const start = g.nodes.find((n) => n.id === START_ID)!;
    expect(start.facts).toContainEqual({
      label: "as_of",
      value: "date · required · no default — a scheduled run cannot supply it",
    });
  });
});
