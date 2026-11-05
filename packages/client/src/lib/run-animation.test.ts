import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { awaitingFirstStatus, edgeId, movingEdges, movingNodes } from "./run-animation";
import type { CanvasGraph } from "@/lib/canvas-model";

type N = { id: string; status?: string | null };
const g = (nodes: N[], edges: Array<[string, string]> = []): CanvasGraph =>
  ({
    nodes: nodes.map((n) => ({ id: n.id, label: n.id, status: n.status ?? null })),
    edges: edges.map(([source, target]) => ({ source, target })),
  }) as unknown as CanvasGraph;

describe("which nodes pulse", () => {
  it("pulses only the step that is running", () => {
    expect([...movingNodes(g([{ id: "a", status: "success" }, { id: "b", status: "running" }]))]).toEqual(["b"]);
  });

  it("⚠ does NOT pulse a paused step — it is waiting on a person, not moving", () => {
    expect(movingNodes(g([{ id: "a", status: "paused" }])).size).toBe(0);
  });

  it("does not pulse a step that has not started", () => {
    expect(movingNodes(g([{ id: "a", status: "created" }])).size).toBe(0);
  });

  it("pulses nothing on a graph with no run behind it", () => {
    expect(movingNodes(g([{ id: "a" }, { id: "b" }])).size).toBe(0);
  });

  it("pulses two steps when the flow really is running two", () => {
    expect(movingNodes(g([{ id: "a", status: "running" }, { id: "b", status: "running" }])).size).toBe(2);
  });
});

describe("which edges flow", () => {
  it("lights the edge the run is CROSSING", () => {
    const graph = g(
      [{ id: "a", status: "success" }, { id: "b", status: "running" }],
      [["a", "b"]],
    );
    expect([...movingEdges(graph)]).toEqual(["a->b"]);
  });

  it("⚠ does not light every edge out of a finished step", () => {
    const graph = g(
      [
        { id: "a", status: "success" },
        { id: "b", status: "running" },
        { id: "c", status: "created" },
      ],
      [
        ["a", "b"],
        ["a", "c"],
      ],
    );
    expect([...movingEdges(graph)]).toEqual(["a->b"]);
  });

  it("does not light an edge whose source has not settled", () => {
    const graph = g([{ id: "a", status: "running" }, { id: "b", status: "running" }], [["a", "b"]]);
    expect(movingEdges(graph).size).toBe(0);
  });

  it("counts a FAILED source as settled — the run did move past it", () => {
    const graph = g([{ id: "a", status: "failed" }, { id: "b", status: "running" }], [["a", "b"]]);
    expect(movingEdges(graph).size).toBe(1);
  });

  it("⚠ counts a SKIPPED source as settled, or a branch leaves its edge dark for ever", () => {
    const graph = g([{ id: "a", status: "skipped" }, { id: "b", status: "running" }], [["a", "b"]]);
    expect(movingEdges(graph).size).toBe(1);
  });

  it("lights nothing on a graph with no statuses", () => {
    expect(movingEdges(g([{ id: "a" }, { id: "b" }], [["a", "b"]])).size).toBe(0);
  });

  it("builds an edge id the canvas will recognise", () => {
    expect(edgeId("a", "b")).toBe("a->b");
  });
});

describe("before the first status arrives", () => {
  it("says so, so the blanket animation can stand in for a moment", () => {
    expect(awaitingFirstStatus(g([{ id: "a" }, { id: "b" }]))).toBe(true);
  });

  it("stops saying so as soon as ONE step reports", () => {
    expect(awaitingFirstStatus(g([{ id: "a", status: "created" }, { id: "b" }]))).toBe(false);
  });

  it("is true for an empty graph, which animates nothing either way", () => {
    expect(awaitingFirstStatus(g([]))).toBe(true);
  });
});

describe("⚠ driven by events, never by a clock", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "run-animation.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("has a control: the source was read", () => {
    expect(code).toContain("movingEdges");
    expect(code.length).toBeGreaterThan(400);
  });

  it("holds no timer, interval or clock of its own", () => {
    expect(code).not.toMatch(/setTimeout|setInterval|requestAnimationFrame|Date\.now|performance\.now/);
  });

  /**
   * ⚠ The canvas built its own `` `${source}->${target}` `` in FIVE places and
   * the animation looks an edge up by that string. Two spellings drift
   * silently, and the symptom is an edge that simply never lights — nothing
   * throws, nothing logs. So there is one implementation and this counts it.
   */
  it("is the ONE place an edge id is spelled", () => {
    const canvas = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "components", "flow", "FlowCanvas.tsx"),
      "utf8",
    );
    expect(canvas).toContain("edgeId(");
    expect(canvas).not.toMatch(/`\$\{[^`]*\}->\$\{/);
  });

  it("keeps no state — the same graph always gives the same answer", () => {
    const graph = g([{ id: "a", status: "running" }]);
    expect([...movingNodes(graph)]).toEqual([...movingNodes(graph)]);
  });
});
