import { describe, expect, it } from "vitest";
import { EDGE_LEAD_MS, REVEAL_HOLD_MS, REVEAL_MAX_MS, REVEAL_STEP_MS, entering, noteEdges, noteNodes, type Seen } from "./canvas-reveal";

const at = (id: string, x: number, y = 0) => ({ id, position: { x, y } });

describe("noteNodes — new nodes enter in reading order, once", () => {
  it("orders a batch left to right, then top to bottom, one step apart", () => {
    const seen: Seen = new Map();
    noteNodes(seen, [at("c", 400), at("a", 0), at("b2", 200, 90), at("b1", 200, 0)], 1000);
    expect(["a", "b1", "b2", "c"].map((id) => seen.get(id)!.delay)).toEqual([0, 1, 2, 3].map((i) => i * REVEAL_STEP_MS));
  });

  it("a node already seen keeps its entry; a later batch starts its own stagger from zero", () => {
    const seen: Seen = new Map();
    noteNodes(seen, [at("a", 0), at("b", 200)], 1000);
    noteNodes(seen, [at("a", 0), at("b", 200), at("c", 400)], 5000);
    expect(seen.get("b")).toEqual({ delay: REVEAL_STEP_MS, at: 1000 });
    expect(seen.get("c")).toEqual({ delay: 0, at: 5000 });
  });

  it("caps the wait however large the batch", () => {
    const seen: Seen = new Map();
    noteNodes(seen, Array.from({ length: 60 }, (_, i) => at(`n${i}`, i * 10)), 0);
    expect(Math.max(...[...seen.values()].map((v) => v.delay))).toBe(REVEAL_MAX_MS);
  });
});

describe("noteEdges — a link draws after both of its ends have landed", () => {
  it("waits for the LATER end of a link between two entering nodes", () => {
    const nodes: Seen = new Map();
    noteNodes(nodes, [at("a", 0), at("b", 200), at("c", 400)], 1000);
    const edges = noteEdges(new Map(), nodes, [{ id: "a-c", source: "a", target: "c" }], 1000);
    expect(edges.get("a-c")!.delay).toBe(2 * REVEAL_STEP_MS + EDGE_LEAD_MS);
  });

  it("measures from NOW, so an edges memo running a render later still lines up", () => {
    const nodes: Seen = new Map();
    noteNodes(nodes, [at("a", 0), at("b", 200)], 1000);
    const edges = noteEdges(new Map(), nodes, [{ id: "a-b", source: "a", target: "b" }], 1050);
    expect(edges.get("a-b")!.delay).toBe(REVEAL_STEP_MS - 50 + EDGE_LEAD_MS);
  });

  it("a link added between nodes long on screen draws at once", () => {
    const nodes: Seen = new Map();
    noteNodes(nodes, [at("a", 0), at("b", 200)], 0);
    const edges = noteEdges(new Map(), nodes, [{ id: "a-b", source: "a", target: "b" }], 60_000);
    expect(edges.get("a-b")!.delay).toBe(0);
  });
});

describe("entering — the class comes off after the entrance, so a re-mount does not replay it", () => {
  it("is true through the delay plus the hold, then false", () => {
    const e = { delay: 200, at: 1000 };
    expect(entering(e, 1000)).toBe(true);
    expect(entering(e, 1000 + 200 + REVEAL_HOLD_MS - 1)).toBe(true);
    expect(entering(e, 1000 + 200 + REVEAL_HOLD_MS)).toBe(false);
    expect(entering(undefined, 1000)).toBe(false);
  });
});
