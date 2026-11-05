/**
 * `withEnd` — the flow's exit point. 2026-09-08
 *
 * ⚠ **This node exists because a flow had no answer.** Verified at the wire
 * before it was built: `FOUNDRY_EMITS` carries no `core.output.OutputValues`,
 * so the compiled YAML declares no outputs; firing a trigger answers
 * `202 {fireId, started, error}`; and reaching a value meant fire → list fires
 * → match `fireId` → `flowExecutionId` → poll the execution → pluck
 * `steps[i].output.value` by a hardcoded step id. `FlowModel.output` names the
 * step and this draws it.
 *
 * ⚠ It is a BOUNDARY, not a `StepKind` — see `CanvasNode.boundary`. It compiles
 * to nothing, so it never enters `STEP_SHAPES` and costs no generation
 * measurement.
 */
import { describe, expect, it } from "vitest";
import { END_ID, START_ID, endNodeCollides, endOutputFrom, withEnd, withStart } from "./canvas-model";
import type { CanvasGraph } from "./canvas-model";

const g = (
  nodes: Array<{ id: string }>,
  edges: Array<{ source: string; target: string }> = [],
): CanvasGraph =>
  ({
    nodes: nodes.map((n) => ({
      id: n.id,
      label: n.id,
      kind: "transform",
      ref: null,
      status: null,
      seam: null,
      meta: null,
      attempt: null,
      generated: false,
      platform: false,
      facts: [],
    })),
    edges,
  }) as unknown as CanvasGraph;

const chain = () => g([{ id: "a" }, { id: "b" }], [{ source: "a", target: "b" }]);
const endOf = (graph: CanvasGraph) => graph.nodes.find((n) => n.id === END_ID)!;

describe("withEnd — the execution exit", () => {
  it("attaches to the LEAF even when the declared result names a mid-chain step", () => {
    // End is the inverse of Start: the exit follows execution, not the
    // declared answer. A flow answering from its query still ends after
    // its last side effect — the parallel fork was the bug (2026-09-14).
    const out = withEnd(chain(), { stepId: "a", description: null });
    expect(out.edges.filter((e) => e.target === END_ID)).toEqual([{ source: "b", target: END_ID }]);
  });

  it("attaches to every LEAF of a branch, never one arm", () => {
    const branch = g(
      [{ id: "a" }, { id: "x" }, { id: "y" }],
      [
        { source: "a", target: "x" },
        { source: "a", target: "y" },
      ],
    );
    const out = withEnd(branch, { stepId: "a", description: null });
    expect(out.edges.filter((e) => e.target === END_ID).map((e) => e.source).sort()).toEqual(["x", "y"]);
  });

  it("names the step, and the description when there is one", () => {
    const n = endOf(withEnd(chain(), { stepId: "b", description: "this week's misses" }));
    expect(n.meta).toBe("this week's misses");
    expect(n.facts?.map((f) => f.value).join(" ")).toContain('"b"');
    expect(n.facts?.map((f) => f.value).join(" ")).toContain("this week's misses");
  });

  it("falls back to naming the step when there is no description", () => {
    expect(endOf(withEnd(chain(), { stepId: "b", description: null })).meta).toBe("from b");
  });
});

describe("withEnd — the states that must not read as working", () => {
  it("is drawn even when NOTHING is declared, and says an API caller gets no answer", () => {
    // `withStart`'s rule: a node that appears only sometimes reads as a flow
    // being special. Here it does a second job — a flow with no declared
    // result is the most common broken state, and this is the only place a
    // person would find that out.
    const n = endOf(withEnd(chain(), null));
    expect(n.meta).toBe("no result declared");
    expect(n.facts?.[0].value).toMatch(/no answer/i);
  });

  it("attaches to every LEAF when nothing is declared", () => {
    const branch = g(
      [{ id: "a" }, { id: "x" }, { id: "y" }],
      [
        { source: "a", target: "x" },
        { source: "a", target: "y" },
      ],
    );
    const out = withEnd(branch, null);
    expect(out.edges.filter((e) => e.target === END_ID).map((e) => e.source).sort()).toEqual(["x", "y"]);
  });

  it("still terminates the leaves when the declared step is missing, and says what is wrong", () => {
    // `checkFlowOutput` refuses this server-side, so it should be unreachable —
    // but stored revisions predate the check. The exit is a fact even when
    // the declaration is broken; the warning rides on the card, not in a
    // dangling node.
    const out = withEnd(chain(), { stepId: "gone", description: null });
    expect(endOf(out).meta).toBe("declared result is missing");
    expect(endOf(out).facts?.[0].value).toContain("gone");
    expect(out.edges.filter((e) => e.target === END_ID)).toEqual([{ source: "b", target: END_ID }]);
  });
});

describe("withEnd — the invariants it shares with withStart", () => {
  it("returns the SAME object for an empty graph, so node identity survives", () => {
    // React Flow compares nodes by identity; a rebuild resets `measured` and
    // every edge unmounts (I-66).
    const empty = g([]);
    expect(withEnd(empty, null)).toBe(empty);
  });

  it("adds nothing a second time", () => {
    const once = withEnd(chain(), null);
    expect(withEnd(once, null)).toBe(once);
  });

  it("leaves a graph alone if a step already owns the id", () => {
    const clash = g([{ id: END_ID }]);
    expect(withEnd(clash, null)).toBe(clash);
    expect(endNodeCollides([END_ID])).toBe(true);
    expect(endNodeCollides(["a", "b"])).toBe(false);
  });

  it("carries no status and is not a platform task", () => {
    const n = endOf(withEnd(chain(), null));
    expect(n.status).toBeNull();
    expect(n.platform).toBe(false);
    expect(n.kind).toBeNull();
    expect(n.boundary).toBe("end");
  });

  it("does not treat the entry point as a leaf", () => {
    // ⚠ NOT a control: `withStart` wires start→every root, so the entry point
    // always feeds something and is never a leaf whatever the filter says.
    // Perturbing `boundary == null` out of `withEnd` leaves this green, which
    // is why the code carries a comment saying the guard is defensive rather
    // than pretending it is load-bearing (I-38).
    const out = withEnd(withStart(g([{ id: "a" }]), []), null);
    expect(out.edges.filter((e) => e.target === END_ID)).toEqual([{ source: "a", target: END_ID }]);
    expect(out.edges).not.toContainEqual({ source: START_ID, target: END_ID });
  });

  it("composes with withStart to give exactly one of each boundary", () => {
    const out = withEnd(withStart(chain(), []), { stepId: "b", description: null });
    expect(out.nodes.filter((n) => n.boundary === "start")).toHaveLength(1);
    expect(out.nodes.filter((n) => n.boundary === "end")).toHaveLength(1);
    expect(out.nodes[0].id).toBe(START_ID);
    expect(out.nodes[out.nodes.length - 1].id).toBe(END_ID);
  });
});

describe("endOutputFrom", () => {
  it("reads a declaration", () => {
    expect(endOutputFrom({ stepId: "a", description: "x" })).toEqual({ stepId: "a", description: "x" });
  });

  it("is null for everything unreadable, and never guesses", () => {
    for (const bad of [null, undefined, {}, { stepId: "" }, { stepId: 3 }, "a", []]) {
      expect(endOutputFrom(bad)).toBeNull();
    }
  });

  it("drops an unusable description rather than rendering it", () => {
    expect(endOutputFrom({ stepId: "a", description: 7 })).toEqual({ stepId: "a", description: null });
  });
});
