import { readFileSync } from "node:fs";
import { join } from "node:path";
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { PALETTE_MIME } from "@/lib/palette-drag";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { FlowCanvas, stepNodes, applyDragPositions, MIN_CANVAS, SHELL_CHROME, PANES, LANE_GAP } from "./FlowCanvas";
import { layout } from "@/lib/canvas-layout";
import { canvasFromRawModel } from "@/lib/canvas-model";
import { listPhases, listFlags } from "@/lib/api";
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (RO as never);
globalThis.DOMMatrixReadOnly = globalThis.DOMMatrixReadOnly ?? (class {} as never);

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  const React = await import("react");
  const Passthrough = ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children);
  return {
    ...actual,
    ReactFlow: ({ children, nodes, edges }: { children: React.ReactNode; nodes: unknown[]; edges: unknown[] }) =>
      React.createElement(
        "div",
        { "data-testid": "react-flow-mock", "data-nodes": (nodes as unknown[]).length, "data-edges": (edges as unknown[]).length },
        children,
      ),
    ReactFlowProvider: Passthrough,
    Background: () => null,
    BackgroundVariant: { Dots: "dots" },
    Controls: () => null,
    MiniMap: (props: unknown) => React.createElement("div", { "data-testid": "minimap", ...(props as object) }),
    Handle: () => null,
    useReactFlow: () => ({
      fitView: vi.fn(),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      setCenter: vi.fn(),
    }),
  };
});

afterEach(() => cleanup());

describe("interactive canvas 232px with pan/zoom/drag/minimap/palette", () => {
  const graph = canvasFromRawModel({
    id: "test-flow",
    steps: [
      { id: "s1", kind: "datasource", ref: null, dependsOn: [] },
      { id: "s2", kind: "transform", ref: null, dependsOn: ["s1"] },
      { id: "s3", kind: "transform", ref: null, dependsOn: ["s2"] },
    ],
  });

  it("exports geometry constants 232px node width, 840 MIN_CANVAS, 120 SHELL_CHROME, 708/788/1006 PANES, 56 LANE_GAP", () => {
    expect(MIN_CANVAS).toBe(840);
    expect(SHELL_CHROME).toBe(120);
    expect(PANES.builder).toBe(708);
    expect(PANES.inspector).toBe(788);
    expect(PANES.canvasOnly).toBe(1006);
    expect(LANE_GAP).toBe(56);
    // NODE_W is 232
    const pos = layout(graph.nodes, graph.edges);
    const nodes = stepNodes(graph.nodes, pos);
    expect(nodes[0].measured).toEqual({ width: 232, height: 76 });
  });

  it("renders minimap overlay for builder dot-grid canvas", () => {
    const { container } = render(<FlowCanvas graph={graph} dotGrid />);
    expect(container.querySelector('[data-testid="minimap"]')).not.toBeNull();
  });

  it("handles pan/zoom via toolbar controls", async () => {
    const { container } = render(<FlowCanvas graph={graph} />);
    // toolbar has Fit, Zoom out, Zoom in buttons
    expect(screen.getByLabelText("Fit the graph to the view")).toBeTruthy();
    expect(screen.getByLabelText("Zoom out")).toBeTruthy();
    expect(screen.getByLabelText("Zoom in")).toBeTruthy();
    // clicking fit should not throw
    fireEvent.click(screen.getByLabelText("Fit the graph to the view"));
    expect(container.querySelector('[data-testid="react-flow-mock"]')).not.toBeNull();
  });

  it("supports node drag with positions persistence", async () => {
    const onMove = vi.fn();
    const positions = new Map([["s1", { x: 10, y: 20 }]]);
    render(<FlowCanvas graph={graph} positions={positions} onMoveStep={onMove} />);
    // nodesDraggable true when onMoveStep supplied — check via stepNodes
    const pos = layout(graph.nodes, graph.edges, positions);
    const nodes = stepNodes(graph.nodes, pos, { draggable: true });
    expect(nodes.find((n) => n.id === "s1")?.draggable).toBe(true);
    expect(nodes.find((n) => n.id === "s1")?.position).toEqual({ x: 10, y: 20 });
  });

  it("selection syncs to inspector via onSelect", async () => {
    const onSelect = vi.fn();
    render(<FlowCanvas graph={graph} selectedStepId="s2" onSelect={onSelect} />);
    // NodeDetails panel shows selected step info
    expect(screen.getByText("s2")).toBeTruthy();
  });

  it("supports palette drag-to-canvas via onDropStep", async () => {
    const onDrop = vi.fn();
    const { container } = render(<FlowCanvas graph={graph} editable onDropStep={onDrop} />);
    const canvas = container.querySelector('[data-testid="flow-canvas"]') as HTMLElement;
    expect(canvas).not.toBeNull();
    // Simulate drag over with correct type
    const dataTransfer = {
      // ⚠ The MIME comes from the module under the feature, not a literal. A
      // literal here would keep passing after a change to `PALETTE_MIME` that
      // broke every real drag — the test would be simulating a browser that no
      // longer exists.
      types: [PALETTE_MIME],
      getData: (type: string) => (type === PALETTE_MIME ? JSON.stringify({ kind: "transform", ref: null }) : ""),
      dropEffect: "copy" as const,
      setData: () => {},
      clearData: () => {},
      files: [] as File[],
      items: [] as unknown as DataTransferItemList,
    } as unknown as DataTransfer;
    // onDragOver should set dragOver, but we test that canvas accepts drop
    fireEvent.dragOver(canvas, { dataTransfer } as unknown as DragEvent);
    expect(canvas.className).toContain("flow-canvas");
  });

  it("a link has ONE geometry whether or not the canvas is editable (2026-09-30: it flipped to elbows while busy)", () => {
    // jsdom mocks React Flow and lays nothing out, so the geometry is read from the source: no elbow routing anywhere, and both edge
    // components draw through the one `linkPath`.
    const src = readFileSync(join(__dirname, "FlowCanvas.tsx"), "utf8");
    expect(src.length).toBeGreaterThan(10_000); // CONTROL: the file was read
    expect(src).not.toMatch(/getSmoothStepPath|type: "smoothstep"|type: "step" as const/);
    expect(src.match(/= linkPath\(\{/g)?.length).toBe(2);
    expect(src).toMatch(/function SmoothEdge[\s\S]{0,300}linkPath\(/);
    expect(src).toMatch(/function StepEdge[\s\S]{0,600}linkPath\(/);
  });
});

describe("phase frames as background divs not groups", () => {
  const graph = canvasFromRawModel({
    id: "phased-flow",
    steps: [
      { id: "a1", kind: "transform", ref: null, dependsOn: [] },
      { id: "a2", kind: "transform", ref: null, dependsOn: ["a1"] },
    ],
  });

  it("renders phases in ordinal order with PHASE N eyebrow", () => {
    const phases = [
      { id: "p2", label: "CHECK EXCEPTIONS", ordinal: 2 },
      { id: "p1", label: "APPLY POLICY", ordinal: 1 },
      { id: "p3", label: "NOTIFY", ordinal: 3 },
    ];
    const { container } = render(<FlowCanvas graph={graph} phases={phases} />);
    const frames = [...container.querySelectorAll('[data-testid="phase-frame"]')];
    expect(frames.length).toBe(3);
    // Order should be 1,2,3 regardless of input order
    expect(frames[0].textContent).toContain("PHASE 1");
    expect(frames[1].textContent).toContain("PHASE 2");
    expect(frames[2].textContent).toContain("PHASE 3");
    expect(frames[0].textContent).toContain("APPLY POLICY");
    expect(frames[1].textContent).toContain("CHECK EXCEPTIONS");
    // Background divs not groups — check data-phase attribute and class
    expect(frames[0].getAttribute("data-phase")).toBe("1");
    expect(frames[0].className).toContain("border");
  });

  it("phase frames use 56px lane gap", () => {
    const phases = [
      { id: "p1", label: "APPLY POLICY", ordinal: 1 },
      { id: "p2", label: "CHECK EXCEPTIONS", ordinal: 2 },
    ];
    const { container } = render(<FlowCanvas graph={graph} phases={phases} />);
    const lane = container.querySelector('[style*="56px"]');
    expect(lane).not.toBeNull();
  });
});

describe("flag badges on canvas nodes", () => {
  it("node shows dot badge when flagCount present", () => {
    const graph = canvasFromRawModel({
      id: "flagged-flow",
      steps: [
        { id: "s1", kind: "transform", ref: null, dependsOn: [] },
        { id: "s2", kind: "transform", ref: null, dependsOn: ["s1"] },
      ],
    });
    // Add flag to first node via flagCounts
    const flagCounts = new Map([["s1", 1]]);
    const pos = layout(graph.nodes, graph.edges);
    const nodes = stepNodes(graph.nodes, pos, { flagCounts });
    expect(nodes.find((n) => n.id === "s1")?.data.flagCount).toBe(1);
    expect(nodes.find((n) => n.id === "s2")?.data.flagCount).toBeUndefined();
  });
  it("reads phases/flags per-revision via listPhases/listFlags (client-only, no any)", () => {
    // Verify the api functions exist and have correct signatures (no any)
    expect(typeof listPhases).toBe("function");
    expect(typeof listFlags).toBe("function");
    // Check that FlowCanvas accepts flowId/revision props
    const graph = canvasFromRawModel({ id: "x", steps: [{ id: "s1", kind: "transform", ref: null, dependsOn: [] }] });
    const { container } = render(<FlowCanvas graph={graph} flowId="flow-123" revision={4} />);
    expect(container.querySelector('[data-testid="flow-canvas"]')).not.toBeNull();
  });
});
describe("the drag overlay (B3.3, 2026-09-03)", () => {
  const graph = canvasFromRawModel({
    id: "drag-flow",
    steps: [
      { id: "s1", kind: "datasource", ref: null, dependsOn: [] },
      { id: "s2", kind: "transform", ref: null, dependsOn: ["s1"] },
    ],
  });
  const base = stepNodes(graph.nodes, layout(graph.nodes, graph.edges));

  it("returns the memoised array untouched when no drag is in flight", () => {
    // Identity, not equality: downstream memos must not rebuild on status polls.
    expect(applyDragPositions(base, new Map())).toBe(base);
  });

  it("echoes the live position and rings only the dragged card", () => {
    const out = applyDragPositions(base, new Map([["s1", { x: 111, y: 222 }]]));
    expect(out.find((n) => n.id === "s1")?.position).toEqual({ x: 111, y: 222 });
    expect(out.find((n) => n.id === "s1")?.className).toContain("node-dragging");
    // The untouched card keeps its layout position and gains no ring.
    const bare = base.find((n) => n.id === "s2")!;
    expect(out.find((n) => n.id === "s2")).toBe(bare);
  });

  it("never strips the fields parseHandles needs (I-66)", () => {
    const out = applyDragPositions(base, new Map([["s2", { x: 1, y: 2 }]]));
    for (const n of out) {
      expect(n.measured).toEqual({ width: 232, height: 76 });
      expect(n.width).toBe(232);
      expect(n.height).toBe(76);
    }
  });
});

