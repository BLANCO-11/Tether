/**
 * The Start node — the flow's entry point, derived from `model.inputs`.
 *
 * ⚠ Every assertion here is about a fact that ALREADY EXISTED and was invisible.
 * The node adds no claim, which is what makes it safe on a canvas whose rule is
 * that it draws only what the server sent.
 */
import { describe, expect, it } from "vitest";
import {
  START_ID,
  describeStartInput,
  startInputsFrom,
  startNodeCollides,
  withStart,
  type CanvasGraph,
  type CanvasNode,
} from "@/lib/canvas-model";

const step = (id: string, over: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  kind: "query",
  ref: null,
  status: null,
  seam: null,
  meta: null,
  attempt: null,
  generated: false,
  platform: false,
  ...over,
});

const graph = (nodes: CanvasNode[], edges: CanvasGraph["edges"] = []): CanvasGraph => ({
  nodes,
  edges,
  hasSeam: false,
  hasUnknownSeam: false,
});

describe("withStart wires the entry point ahead of every root", () => {
  it("adds one node and one edge to the single root", () => {
    const g = withStart(graph([step("a"), step("b")], [{ source: "a", target: "b" }]), [
      { id: "as_of", type: "DATE", required: true },
    ]);
    expect(g.nodes[0].id).toBe(START_ID);
    expect(g.nodes[0].boundary).toBe("start");
    expect(g.edges).toEqual([
      { source: "a", target: "b" },
      { source: START_ID, target: "a" },
    ]);
  });

  /**
   * ⚠ The load-bearing one. Roots come from the EDGES: on a branching flow an
   * ordinal version attaches the entry point to whichever step was written
   * first, which on an if/elif/else chain is one arm — so the picture would
   * claim the flow starts inside a branch.
   */
  it("feeds EVERY unfed step, not just the first", () => {
    const g = withStart(
      graph([step("a"), step("b"), step("c")], [{ source: "a", target: "c" }]),
      [],
    );
    const from = g.edges.filter((e) => e.source === START_ID).map((e) => e.target).sort();
    expect(from).toEqual(["a", "b"]);
  });

  it("is added even when the flow declares NO inputs, and says so", () => {
    const g = withStart(graph([step("a")]), []);
    const n = g.nodes[0];
    expect(n.boundary).toBe("start");
    expect(n.meta).toBe("no inputs");
    expect(n.facts).toEqual([
      { label: "inputs", value: "none — this automation takes no parameters" },
    ]);
  });

  /**
   * ⚠ I-66: React Flow compares nodes by identity, and a rebuilt array resets
   * `measured`, which discards the handle bounds `parseHandles` needs — every
   * edge then unmounts with nothing to say why.
   */
  it("returns the SAME object when there is nothing to add", () => {
    const empty = graph([]);
    expect(withStart(empty, [{ id: "x", type: "DATE", required: false }])).toBe(empty);
    const already = graph([step(START_ID, { boundary: "start" }), step("a")]);
    expect(withStart(already, [])).toBe(already);
    // A cycle has no root; drawing an entry point into nothing would claim a
    // shape that is not there.
    const cycle = graph([step("a"), step("b")], [
      { source: "a", target: "b" },
      { source: "b", target: "a" },
    ]);
    expect(withStart(cycle, [])).toBe(cycle);
  });

  it("never carries a status, a kind or the platform flag", () => {
    const n = withStart(graph([step("a")]), []).nodes[0];
    // Not a taskrun: a status would put a state on a thing that never runs, and
    // `platform: true` would count it in the legend's "N platform tasks".
    expect(n.status).toBeNull();
    expect(n.kind).toBeNull();
    expect(n.platform).toBe(false);
    expect(n.ref).toBeNull();
  });

  it("does not mutate the graph it was handed", () => {
    const g = graph([step("a")], []);
    const before = { nodes: g.nodes.length, edges: g.edges.length };
    withStart(g, [{ id: "as_of", type: "DATE", required: true }]);
    expect({ nodes: g.nodes.length, edges: g.edges.length }).toEqual(before);
  });
});

describe("an input reads as required-or-optional AND default-or-not", () => {
  /**
   * ⚠ The distinction the product actually needs. A required input with a
   * default and one without behave completely differently on a SCHEDULE — the
   * second cannot fire unattended — so collapsing them into one chip is how a
   * flow that works when a person clicks Test fails silently at 09:00.
   */
  it("says a required input with no default cannot be supplied by a schedule", () => {
    expect(describeStartInput({ id: "as_of", type: "DATE", required: true })).toEqual({
      label: "as_of",
      value: "date · required · no default — a scheduled run cannot supply it",
    });
  });

  it("states the default when there is one", () => {
    expect(
      describeStartInput({ id: "period", type: "STRING", required: true, defaults: "2026-06" }),
    ).toEqual({ label: "period", value: "string · required · default 2026-06" });
  });

  it("does not warn about a schedule for an OPTIONAL input", () => {
    const v = describeStartInput({ id: "note", type: "STRING", required: false }).value;
    expect(v).toContain("optional");
    expect(v).not.toContain("schedule");
  });

  /** An empty string is not a default — it is an empty declaration. */
  it("treats an empty default as none", () => {
    expect(describeStartInput({ id: "x", type: "DATE", required: false, defaults: "" }).value)
      .toContain("no default");
  });
});

describe("startInputsFrom narrows a stored model's inputs", () => {
  it("reads id, type, required and defaults", () => {
    expect(
      startInputsFrom([{ id: "as_of", type: "DATE", required: true, defaults: "2026-01-01" }]),
    ).toEqual([{ id: "as_of", type: "DATE", required: true, defaults: "2026-01-01" }]);
  });

  /**
   * ⚠ Absent `required` is OPTIONAL — matching `FlowInput.required?: boolean`
   * and the compiler. Defaulting to required would put "a scheduled run cannot
   * supply it" on an input that is fine.
   */
  it("treats an absent required flag as optional, and only `true` as required", () => {
    expect(startInputsFrom([{ id: "a", type: "DATE" }])[0].required).toBe(false);
    expect(startInputsFrom([{ id: "b", type: "DATE", required: "yes" }])[0].required).toBe(false);
    expect(startInputsFrom([{ id: "c", type: "DATE", required: true }])[0].required).toBe(true);
  });

  /**
   * ⚠ Never defaulted to a plausible type. An unreadable declaration rendering
   * as "string" is a claim nobody checked.
   */
  it("says the type is unknown rather than guessing one", () => {
    expect(startInputsFrom([{ id: "a" }])[0].type).toBe("unknown type");
  });

  it("drops entries with no usable id, and answers empty for a non-array", () => {
    expect(startInputsFrom([{ type: "DATE" }, null, "x", { id: "" }])).toEqual([]);
    expect(startInputsFrom(undefined)).toEqual([]);
    expect(startInputsFrom({ id: "a" })).toEqual([]);
  });
});

describe("the boundary id cannot be authored", () => {
  /**
   * The property, not the spelling: `isValidStepId` requires a lower-case
   * letter first, so no step a person or a model can write may collide — which
   * is what stops a real step being hidden by the boundary, or the boundary
   * being deleted as a step.
   */
  it("is rejected by the step-id rule the product enforces", () => {
    expect(START_ID).toMatch(/^__/);
    expect(/^[a-z][a-z0-9_]*$/.test(START_ID)).toBe(false);
  });

  it("detects a collision if stored data ever holds one", () => {
    expect(startNodeCollides(["a", "b"])).toBe(false);
    expect(startNodeCollides(["a", START_ID])).toBe(true);
  });
});

describe("an input says what to give, or that nobody gives it (2026-09-29: \"period — no indication of what type or format\")", () => {
  it("a declared format is named with its shape; a computed input says it is worked out when it runs", () => {
    const [month, computed, offset] = startInputsFrom([
      { id: "period_1", type: "STRING", format: "month" },
      { id: "period_2", type: "STRING", format: "month", computed: "priorMonth" },
      { id: "cutoff", type: "DATE", computed: "currentDate", offsetDays: -7 },
    ]);
    expect(describeStartInput(month!).value).toBe("a month, e.g. 2026-09 · optional · no default");
    expect(describeStartInput(computed!).value).toBe("the month before it runs · worked out when it runs");
    expect(describeStartInput(offset!).value).toBe("7 days before the day it runs · worked out when it runs");
  });
  it("CONTROL: an input with no format still reads as its declared type", () => {
    expect(describeStartInput(startInputsFrom([{ id: "q", type: "STRING", required: true }])[0]!).value).toBe("string · required · no default — a scheduled run cannot supply it");
  });
});
