// @vitest-environment jsdom
//
// src/components/flow/FlowCanvas.c2.test.tsx — programme C2: the core Dify
// canvas interactions (palette drop, mid-edge insert, inline rename).
//
// ⚠ Why `@xyflow/react` is mocked here and NOT in FlowCanvas.test.tsx: jsdom
// measures every node as 0×0, so React Flow's EdgeRenderer renders no edge
// geometry at all — no `.react-flow__edge` element ever mounts, and neither
// the delete affordance nor the new insert `+` can be reached (the same
// limitation FlowCanvas.test.tsx documents as browser territory). The mock
// below stubs ONLY the viewport shell (ReactFlow, its provider, the label
// portal, Handle) and renders the REAL `StepNode`/`StepStepEdge` components
// through the canvas's own `nodeTypes`/`edgeTypes` — the title input, the
// `+` button and the kind menu under test are the production components,
// and the drop-target div is untouched production code throughout.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FlowCanvas } from "@/components/flow/FlowCanvas";
import { canvasFromRawModel, withStart } from "@/lib/canvas-model";
import { PALETTE_MIME } from "@/lib/palette-drag";

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  const React = await import("react");
  const Passthrough = ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  type AnyProps = Record<string, unknown>;
  const renderers = (props: AnyProps) => {
    const nodes = (props.nodes ?? []) as Array<AnyProps>;
    const edges = (props.edges ?? []) as Array<AnyProps>;
    const nodeTypes = (props.nodeTypes ?? {}) as Record<string, React.ComponentType<AnyProps>>;
    const edgeTypes = (props.edgeTypes ?? {}) as Record<string, React.ComponentType<AnyProps>>;
    return React.createElement(
      "div",
      { "data-testid": "react-flow-mock" },
      nodes.map((n) => {
        const C = nodeTypes[n.type as string];
        return React.createElement(
          "div",
          {
            key: n.id as string,
            "data-testid": `node-${n.id as string}`,
            onClick: (e: unknown) =>
              (props.onNodeClick as ((e: unknown, n: unknown) => void) | undefined)?.(e, n),
          },
          C ? React.createElement(C, { ...(n as object), key: n.id as string }) : null,
        );
      }),
      edges.map((e) => {
        const C = edgeTypes[e.type as string];
        return React.createElement(
          "div",
          {
            key: e.id as string,
            "data-testid": `edge-${e.id as string}`,
            onClick: (ev: unknown) =>
              (props.onEdgeClick as ((e: unknown, edge: unknown) => void) | undefined)?.(ev, e),
          },
          C
            ? React.createElement(C, {
                id: e.id,
                source: e.source,
                target: e.target,
                sourceX: 0,
                sourceY: 0,
                targetX: 100,
                targetY: 100,
                sourcePosition: "right",
                targetPosition: "left",
                selected: e.selected,
                data: e.data,
                key: e.id as string,
              })
            : null,
        );
      }),
      // jsdom cannot drag a handle; the gesture origin is simulated here while
      // everything downstream (linkSource, the surface callback) is production.
      // Narrowed, never cast: the click event carries the connection in the
      // button's dataset, set per test before clicking.
      React.createElement("button", {
        "data-testid": "mock-connect",
        onClick: (ev: unknown) => {
          if (ev && typeof ev === "object" && "currentTarget" in ev && ev.currentTarget instanceof HTMLElement) {
            const t = ev.currentTarget;
            if (typeof props.onConnect === "function") {
              props.onConnect({
                source: t.dataset.source,
                target: t.dataset.target,
                sourceHandle: t.dataset.handle || undefined,
              });
            }
          }
        },
      }),
      props.children as React.ReactNode,
    );
  };
  return {
    ...actual,
    ReactFlow: renderers,
    ReactFlowProvider: Passthrough,
    Background: () => null,
    BackgroundVariant: { Dots: "dots" },
    MiniMap: () => null,
    Handle: () => null,
    EdgeLabelRenderer: Passthrough,
    useReactFlow: () => ({
      fitView: vi.fn(),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      setCenter: vi.fn(),
    }),
  };
});

// React Flow measures its container and observes resizes; jsdom does neither.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (RO as never);
globalThis.DOMMatrixReadOnly = globalThis.DOMMatrixReadOnly ?? (class {} as never);

afterEach(() => cleanup());

const graph = () =>
  canvasFromRawModel({
    id: "c2-flow",
    steps: [
      { id: "s1", kind: "transform", ref: null, dependsOn: [] },
      { id: "s2", kind: "tool", ref: "mail_send", dependsOn: ["s1"] },
    ],
  });

const paletteTransfer = (kind: string, ref: string | null) =>
  ({
    types: [PALETTE_MIME],
    getData: (type: string) =>
      type === PALETTE_MIME ? JSON.stringify({ kind, ref }) : "",
    dropEffect: "copy" as const,
    setData: () => {},
    clearData: () => {},
    files: [] as File[],
    items: [] as unknown as DataTransferItemList,
  }) as unknown as DataTransfer;

// `fireEvent.drop` builds a `DragEvent` whose `clientX/clientY` never reach
// the handler under jsdom, so the drop point (the thing under test) is
// dispatched on a plain bubbling event instead — React reads the same fields.
const dropAt = (target: HTMLElement, transfer: DataTransfer, x: number, y: number) => {
  const ev = new Event("drop", { bubbles: true, cancelable: true }) as Event & {
    dataTransfer?: DataTransfer;
    clientX?: number;
    clientY?: number;
  };
  ev.dataTransfer = transfer;
  ev.clientX = x;
  ev.clientY = y;
  target.dispatchEvent(ev);
};

describe("palette drop (C2)", () => {
  it("delivers kind, ref and drop point to onDropStep", () => {
    // The path was already complete (dragstart writes PALETTE_MIME via
    // setPaletteDrag, the canvas reads it via readPaletteDrag); this pins it.
    const onDropStep = vi.fn();
    const { container } = render(<FlowCanvas graph={graph()} editable onDropStep={onDropStep} />);
    const canvas = container.querySelector('[data-testid="flow-canvas"]') as HTMLElement;
    dropAt(canvas, paletteTransfer("tool", "mail_send"), 120, 80);
    expect(onDropStep).toHaveBeenCalledTimes(1);
    expect(onDropStep).toHaveBeenCalledWith("tool", "mail_send", 120, 80);
  });

  it("supports a from-scratch kind with no ref", () => {
    const onDropStep = vi.fn();
    const { container } = render(<FlowCanvas graph={graph()} editable onDropStep={onDropStep} />);
    const canvas = container.querySelector('[data-testid="flow-canvas"]') as HTMLElement;
    dropAt(canvas, paletteTransfer("transform", null), 10, 20);
    expect(onDropStep).toHaveBeenCalledWith("transform", null, 10, 20);
  });

  it("ignores drops that are not palette rows, and kinds the canvas cannot draw", () => {
    const onDropStep = vi.fn();
    const { container } = render(<FlowCanvas graph={graph()} editable onDropStep={onDropStep} />);
    const canvas = container.querySelector('[data-testid="flow-canvas"]') as HTMLElement;
    fireEvent.drop(canvas, {
      dataTransfer: { types: ["text/plain"], getData: () => "hello" } as unknown as DataTransfer,
    } as unknown as DragEvent);
    fireEvent.drop(canvas, {
      dataTransfer: paletteTransfer("not_a_kind", null),
    } as unknown as DragEvent);
    expect(onDropStep).not.toHaveBeenCalled();
  });

  it("a canvas without onDropStep is not a drop target", () => {
    const { container } = render(<FlowCanvas graph={graph()} editable />);
    const canvas = container.querySelector('[data-testid="flow-canvas"]') as HTMLElement;
    fireEvent.dragOver(canvas, { dataTransfer: paletteTransfer("transform", null) } as unknown as DragEvent);
    expect(canvas.className).not.toContain("canvas-drop-target");
    expect(() =>
      fireEvent.drop(canvas, {
        dataTransfer: paletteTransfer("transform", null),
      } as unknown as DragEvent),
    ).not.toThrow();
  });

  it("flags the drop target while a palette row hovers", () => {
    const { container } = render(
      <FlowCanvas graph={graph()} editable onDropStep={() => {}} />,
    );
    const canvas = container.querySelector('[data-testid="flow-canvas"]') as HTMLElement;
    fireEvent.dragOver(canvas, { dataTransfer: paletteTransfer("transform", null) } as unknown as DragEvent);
    expect(canvas.className).toContain("canvas-drop-target");
  });
});

describe("mid-edge insert (C2)", () => {
  it("a selected edge offers `+`, and picking a kind reports (from, to, kind)", () => {
    const onInsertStep = vi.fn();
    const { container } = render(
      <FlowCanvas graph={graph()} editable onDisconnectSteps={() => {}} onInsertStep={onInsertStep} />,
    );
    // No affordance before the edge is selected…
    expect(screen.queryByTitle("Insert a step here")).toBeNull();
    // …click the edge (the mock routes it to the canvas's onEdgeClick)…
    const edge = container.querySelector('[data-testid^="edge-"]') as HTMLElement;
    fireEvent.click(edge);
    // …the `+` appears at the midpoint and opens the kind chooser…
    const plus = screen.getByTitle("Insert a step here");
    expect(plus.getAttribute("aria-label")).toBe("Insert a step between s1 and s2");
    fireEvent.click(plus);
    expect(screen.getByText("Insert a step here")).toBeTruthy();
    // …picking a kind reports the splice and closes the menu.
    const pick = screen
      .getAllByRole("menuitem")
      .find((el) => el.textContent?.includes("transform"))!;
    fireEvent.click(pick);
    expect(onInsertStep).toHaveBeenCalledTimes(1);
    // The trailing `undefined` is the optional ref — a transform needs none.
    expect(onInsertStep).toHaveBeenCalledWith("s1", "s2", "transform", undefined);
  });

  it("no `+` without onInsertStep — the surface keeps delete-only edges", () => {
    const { container } = render(
      <FlowCanvas graph={graph()} editable onDisconnectSteps={() => {}} />,
    );
    const edge = container.querySelector('[data-testid^="edge-"]') as HTMLElement;
    fireEvent.click(edge);
    expect(screen.queryByTitle("Insert a step here")).toBeNull();
    // …while the delete affordance still shows (unchanged behaviour).
    expect(screen.getByTitle("Remove this link (Delete)")).toBeTruthy();
  });
});

describe("inline rename (C2)", () => {
  it("double-click turns the title into an input; Enter commits via onRenameStep", () => {
    const onRenameStep = vi.fn();
    render(<FlowCanvas graph={graph()} editable details={false} onRenameStep={onRenameStep} />);
    // Single click selects and never edits…
    fireEvent.click(screen.getByText("s1"));
    expect(screen.queryByLabelText("Rename s1")).toBeNull();
    // …double-click opens the input…
    fireEvent.doubleClick(screen.getByText("s1"));
    const input = screen.getByLabelText("Rename s1") as HTMLInputElement;
    expect(input).toBeTruthy();
    // …typing + Enter commits the trimmed id.
    fireEvent.change(input, { target: { value: "  fetch_invoices " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRenameStep).toHaveBeenCalledTimes(1);
    expect(onRenameStep).toHaveBeenCalledWith("s1", "fetch_invoices");
  });

  it("blur commits, Escape cancels, an unchanged id reports nothing", () => {
    const onRenameStep = vi.fn();
    render(<FlowCanvas graph={graph()} editable details={false} onRenameStep={onRenameStep} />);
    fireEvent.doubleClick(screen.getByText("s1"));
    fireEvent.change(screen.getByLabelText("Rename s1"), { target: { value: "s1_2" } });
    fireEvent.blur(screen.getByLabelText("Rename s1"));
    expect(onRenameStep).toHaveBeenCalledWith("s1", "s1_2");

    fireEvent.doubleClick(screen.getByText("s2"));
    fireEvent.change(screen.getByLabelText("Rename s2"), { target: { value: "abandoned" } });
    fireEvent.keyDown(screen.getByLabelText("Rename s2"), { key: "Escape" });
    expect(onRenameStep).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Rename s2")).toBeNull();

    fireEvent.doubleClick(screen.getByText("s2"));
    fireEvent.blur(screen.getByLabelText("Rename s2"));
    expect(onRenameStep).toHaveBeenCalledTimes(1);
  });

  it("without onRenameStep the title is not editable", () => {
    render(<FlowCanvas graph={graph()} editable />);
    fireEvent.doubleClick(screen.getByText("s1"));
    expect(screen.queryByLabelText("Rename s1")).toBeNull();
  });
});

describe("arm-aware links", () => {
  // big → small → rest is one if/elif/otherwise decision on a single card;
  // email starts unconnected. canvasFromRawModel carries elseOf/conditionExpr
  // on raw rows, so this is the production collapse, not a hand-built graph.
  const branchGraph = () =>
    canvasFromRawModel({
      id: "arm-flow",
      steps: [
        { id: "big", kind: "branch", ref: null, dependsOn: [], conditionExpr: "{{ 1 }}", elseOf: null },
        { id: "small", kind: "branch", ref: null, dependsOn: [], conditionExpr: "{{ 2 }}", elseOf: "big" },
        { id: "rest", kind: "branch", ref: null, dependsOn: [], conditionExpr: null, elseOf: "small" },
        { id: "email", kind: "transform", ref: null, dependsOn: [] },
      ],
    });

  const dragFrom = (container: HTMLElement, source: string, target: string, handle?: string) => {
    const btn = container.querySelector('[data-testid="mock-connect"]') as HTMLElement;
    btn.dataset.source = source;
    btn.dataset.target = target;
    if (handle === undefined) delete btn.dataset.handle;
    else btn.dataset.handle = handle;
    fireEvent.click(btn);
  };

  it("a drag from the elif handle reports the arm step, not the head", () => {
    const onConnectSteps = vi.fn();
    const { container } = render(
      <FlowCanvas graph={branchGraph()} editable onConnectSteps={onConnectSteps} />,
    );
    // The chain collapsed: one card for three steps…
    expect(container.querySelector('[data-testid="node-big"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="node-small"]')).toBeNull();
    // …and leaving by the elif handle wires the elif.
    dragFrom(container, "big", "email", "small");
    expect(onConnectSteps).toHaveBeenCalledTimes(1);
    expect(onConnectSteps).toHaveBeenCalledWith("small", "email");
  });

  it("a drag with no handle, or a handle that is not an arm, reports the card", () => {
    const onConnectSteps = vi.fn();
    const { container } = render(
      <FlowCanvas graph={branchGraph()} editable onConnectSteps={onConnectSteps} />,
    );
    dragFrom(container, "big", "email");
    expect(onConnectSteps).toHaveBeenLastCalledWith("big", "email");
    // A code field handle names a field, not a step — the card, still.
    dragFrom(container, "big", "email", "some_field");
    expect(onConnectSteps).toHaveBeenLastCalledWith("big", "email");
  });

  it("deleting an arm edge reports the arm step, so the disconnect lands", () => {
    // email runs after the elif: the model edge is small→email, drawn as
    // big→email with the arm named. Reporting the head would refuse with
    // "does not run after" — the arm is what must go.
    const armed = canvasFromRawModel({
      id: "arm-flow",
      steps: [
        { id: "big", kind: "branch", ref: null, dependsOn: [], conditionExpr: "{{ 1 }}", elseOf: null },
        { id: "small", kind: "branch", ref: null, dependsOn: [], conditionExpr: "{{ 2 }}", elseOf: "big" },
        { id: "rest", kind: "branch", ref: null, dependsOn: [], conditionExpr: null, elseOf: "small" },
        { id: "email", kind: "transform", ref: null, dependsOn: ["small"] },
      ],
    });
    const onDisconnectSteps = vi.fn();
    const { container } = render(
      <FlowCanvas graph={armed} editable onDisconnectSteps={onDisconnectSteps} />,
    );
    const edge = container.querySelector('[data-testid^="edge-"]') as HTMLElement;
    fireEvent.click(edge);
    fireEvent.click(screen.getByTitle("Remove this link (Delete)"));
    expect(onDisconnectSteps).toHaveBeenCalledTimes(1);
    expect(onDisconnectSteps).toHaveBeenCalledWith("small", "email");
  });

  it("entry/exit edges carry no delete affordance — drawn, not authored", () => {
    const solo = withStart(
      canvasFromRawModel({
        id: "solo-flow",
        steps: [{ id: "only", kind: "transform", ref: null, dependsOn: [] }],
      }),
      [],
    );
    const onDisconnectSteps = vi.fn();
    const { container } = render(<FlowCanvas graph={solo} editable onDisconnectSteps={onDisconnectSteps} />);
    const edge = container.querySelector('[data-testid^="edge-"]') as HTMLElement;
    fireEvent.click(edge);
    expect(screen.queryByTitle("Remove this link (Delete)")).toBeNull();
    expect(onDisconnectSteps).not.toHaveBeenCalled();
  });
});
