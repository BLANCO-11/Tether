// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/api", () => ({ getFlowPositions: vi.fn(async () => new Map()), putFlowPositions: vi.fn(async () => undefined) }));
const { PiFlowCanvas, place } = await import("./PiFlowCanvas");
const { piCanvasModel } = await import("@/lib/pi-canvas");

const wf = {
  inputs: { week: { type: "date" } },
  steps: [
    { id: "load", params: { week: "$input.week" }, outputs: ["rows"] },
    { id: "send", inputs: { rows: "load.rows" }, outputs: ["sent"] },
  ],
};

describe("PiFlowCanvas", () => {
  it("hovering a card lights its path and runs a pulse along it", () => {
    const { container } = render(<PiFlowCanvas workflow={wf} selectedId={null} onSelect={() => {}} />);
    expect(container.querySelectorAll(".pic-pulse")).toHaveLength(0);
    fireEvent.pointerEnter(container.querySelector('.pic-node[data-id="send"]')!);
    const pulses = container.querySelectorAll<SVGPathElement>(".pic-pulse");
    expect(pulses.length).toBeGreaterThan(0);
    expect(pulses[0]!.style.animationDuration).toMatch(/ms$/);
    expect(container.querySelectorAll(".pic-wire.flowing").length).toBe(pulses.length);
    fireEvent.pointerLeave(container.querySelector('.pic-node[data-id="send"]')!);
    expect(container.querySelectorAll(".pic-pulse")).toHaveLength(0);
  });

  it("the stylesheet still styles the pulse — the render above cannot see CSS, and it was lost once", () => {
    const css = readFileSync(join(__dirname, "../../app/globals.css"), "utf8");
    for (const sel of [".pic-pulse {", ".pic-wire.flowing {", ".pic-wire.dim {", ".pic-node.dim {", "@keyframes edge-pulse-run", "@keyframes edge-flow-in"]) {
      expect(css, sel).toContain(sel);
    }
  });
});

describe("a card can be dragged anywhere — above or left of every other card too", () => {
  const model = piCanvasModel(wf);
  const measured = { heights: new Map<string, number>(), portY: new Map<string, number>() };

  it("unmoved, nothing is shifted", () => {
    expect(place(model, measured, new Map()).shift).toEqual({ x: 0, y: 0 });
  });

  it("a card kept above the top grows the drawing upward: it is drawn at the margin, the rest move down with it", () => {
    const before = place(model, measured, new Map());
    const after = place(model, measured, new Map([["send", { x: 400, y: -200 }]]));
    expect(after.shift.y).toBeGreaterThan(0);
    // Drawn place = kept place + shift, never clamped at the edge.
    expect(after.boxes.get("send")!.y).toBe(-200 + after.shift.y);
    // Every other card keeps its place relative to the dragged one — they all moved by the same shift.
    expect(after.boxes.get("load")!.y).toBe(before.boxes.get("load")!.y + after.shift.y);
    expect(Math.min(...[...after.boxes.values()].map((b) => b.y))).toBeGreaterThanOrEqual(0);
  });

  it("a card kept left of everything grows the drawing leftward", () => {
    const after = place(model, measured, new Map([["send", { x: -300, y: 100 }]]));
    expect(after.shift.x).toBeGreaterThan(0);
    expect(after.boxes.get("send")!.x).toBe(-300 + after.shift.x);
  });
});

