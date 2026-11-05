// @vitest-environment jsdom
//
// Phase 4.2 + 4.3: the data-reference overlay and drag-time refusal seams.
//
// The geometry is unprovable in jsdom (no layout), so this file pins what is
// provable: the pure link/flow projections, and that the canvas draws the
// overlay's labels (not where the wires land).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { connectionRefusal, type AuthoredStep } from "@foundry/flow-edit";
import { canvasFromRawModel, START_ID, type CanvasGraph } from "@/lib/canvas-model";
import { buildFanOutParams, type OutputShapes } from "@/lib/flow-expr";
import {
  dataRefLinksFor,
  FlowCanvas,
  refusalFlowForGraph,
  SHOW_DATA_REFS_KEY,
} from "@/components/flow/FlowCanvas";
import type { IoInput } from "@/lib/step-io";
// jsdom performs no layout, so unmeasured edges never mount under the real
// ReactFlow (see the `EdgeWrapper returns null` note in `FlowCanvas.tsx`).
// The stub below renders the canvas's OWN edge components headlessly — the
// overlay label this phase owes is asserted through the real `DataRefEdge`.
// Same shape as the stub in `FlowCanvas.c2.test.tsx`.
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
          { key: n.id as string, "data-testid": `node-${n.id as string}` },
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
      fitView: () => {},
      zoomIn: () => {},
      zoomOut: () => {},
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      setCenter: () => {},
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

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(SHOW_DATA_REFS_KEY);
});

const SHAPES = {
  datasource: { template: "json(outputs.<id>.body)", describes: "the query's rows", caution: null },
  tool: { template: "json(outputs.<id>.body)", describes: "the endpoint's response", caution: null },
} as unknown as OutputShapes;

const CATALOGUE = {
  outputs: SHAPES as never,
  entries: [
    {
      ref: "mail_send",
      params: [{ name: "to_email", type: "string", required: true, description: null }],
    },
  ],
};

const fetchStep = { kind: "datasource", id: "fetch", ref: "q" } as unknown as AuthoredStep;
const sendStep = (paramsExpr: string | null): AuthoredStep =>
  ({ kind: "tool", id: "send", ref: "mail_send", paramsExpr, dependsOn: ["fetch"] }) as unknown as AuthoredStep;

const boundExpr = buildFanOutParams(SHAPES, fetchStep, [
  { param: "to_email", source: { from: "step", stepId: "fetch", field: "body" } },
]);

function graph() {
  return canvasFromRawModel({
    id: "f",
    steps: [
      { id: "fetch", kind: "datasource", ref: "q", dependsOn: [] },
      { id: "send", kind: "tool", ref: "mail_send", dependsOn: ["fetch"] },
    ],
  });
}

function producerTitle(g: CanvasGraph): string {
  return g.nodes.find((n) => n.id === "fetch")?.label ?? "fetch";
}

function canvas(extra?: { editable?: boolean; selectedStepId?: string | null }) {
  const selectedStepId = extra && "selectedStepId" in extra ? extra.selectedStepId : "send";
  return (
    <FlowCanvas
      graph={graph()}
      editable={extra?.editable}
      selectedStepId={selectedStepId}
      dataRefs={{ steps: [fetchStep, sendStep(boundExpr)], catalogue: CATALOGUE }}
    />
  );
}

describe("dataRefLinksFor", () => {
  const titleOf = (id: string) => (id === "fetch" ? "Fetch open offers" : undefined);
  it("names the producer and the field read", () => {
    const inputs = [
      { name: "to_email", type: "string", required: true, description: null, source: { kind: "step", stepId: "fetch", field: "body" } },
    ] as IoInput[];
    expect(dataRefLinksFor({ consumerId: "send", inputs, overStepId: null, titleOf })).toEqual([
      { producerId: "fetch", consumerId: "send", label: "Fetch open offers → body" },
    ]);
  });
  it("whole and fan-out sources read the whole of the producer", () => {
    const inputs = [
      { name: "a", type: "string", required: true, description: null, source: { kind: "whole", stepId: "fetch" } },
      { name: "b", type: "string", required: true, description: null, source: { kind: "self" } },
    ] as unknown as IoInput[];
    expect(dataRefLinksFor({ consumerId: "send", inputs, overStepId: "fetch", titleOf })).toEqual([
      { producerId: "fetch", consumerId: "send", label: "the whole of Fetch open offers" },
    ]);
  });
  it("a fan-out over nothing names nothing", () => {
    const inputs = [
      { name: "b", type: "string", required: true, description: null, source: { kind: "self" } },
    ] as unknown as IoInput[];
    expect(dataRefLinksFor({ consumerId: "send", inputs, overStepId: null, titleOf })).toEqual([]);
  });
  it("run inputs, literals, unset and unknown have no producer to draw", () => {
    const inputs = [
      { name: "a", type: "string", required: true, description: null, source: { kind: "input", inputId: "month" } },
      { name: "b", type: "string", required: true, description: null, source: { kind: "literal", value: "x" } },
      { name: "c", type: "string", required: true, description: null, source: { kind: "unset" } },
      { name: "d", type: "string", required: true, description: null, source: { kind: "unknown" } },
    ] as unknown as IoInput[];
    expect(dataRefLinksFor({ consumerId: "send", inputs, overStepId: null, titleOf })).toEqual([]);
  });
  it("a producer with no drawn card is skipped, never invented", () => {
    const inputs = [
      { name: "a", type: "string", required: true, description: null, source: { kind: "step", stepId: "gone", field: "body" } },
    ] as IoInput[];
    expect(dataRefLinksFor({ consumerId: "send", inputs, overStepId: null, titleOf })).toEqual([]);
  });
});

describe("refusalFlowForGraph", () => {
  const armed = {
    nodes: [
      { id: "fetch", kind: "datasource" },
      { id: "send", kind: "tool" },
      { id: "big", kind: "branch", arms: [{ id: "big_if", label: "if" }, { id: "big_else", label: "else" }] },
      { id: START_ID, boundary: "start" },
    ],
    edges: [
      { source: "fetch", target: "send" },
      { source: "big_if", target: "send" },
      { source: START_ID, target: "fetch" },
    ],
  } as unknown as CanvasGraph;
  it("rebuilds steps and links, with arm ids present and boundaries skipped", () => {
    const flow = refusalFlowForGraph(armed);
    expect(flow.steps.map((s) => s.id).sort()).toEqual(["big", "big_else", "big_if", "fetch", "send"]);
    const send = flow.steps.find((s) => s.id === "send")!;
    expect([...send.dependsOn!].sort()).toEqual(["big_if", "fetch"]);
  });
  it("refuses through the shared rule: self, duplicate, cycle, unknown", () => {
    const flow = refusalFlowForGraph(armed);
    expect(connectionRefusal(flow, "send", "send")).toBe("a step cannot depend on itself");
    expect(connectionRefusal(flow, "fetch", "send")).toBe('"send" already runs after "fetch"');
    expect(connectionRefusal(flow, "send", "fetch")).toBe('that would make a loop — "send" already runs after "fetch"');
    expect(connectionRefusal(flow, "missing", "send")).toBe("both ends of a link must be steps in this flow");
  });
  it("an arm drag is judged on topology, never refused as an unknown end", () => {
    const flow = refusalFlowForGraph(armed);
    expect(connectionRefusal(flow, "big_if", "send")).toBe('"send" already runs after "big_if"');
    expect(connectionRefusal(flow, "fetch", "big")).toBe(null);
  });
});

describe("FlowCanvas data-reference overlay", () => {
  it("hides the toggle without the model it would picture", () => {
    render(<FlowCanvas graph={graph()} editable selectedStepId="send" />);
    expect(screen.queryByRole("button", { name: "Show data references" })).toBeNull();
  });
  it("hides the toggle on a read-only surface", () => {
    render(
      <FlowCanvas
        graph={graph()}
        selectedStepId="send"
        dataRefs={{ steps: [fetchStep, sendStep(boundExpr)], catalogue: CATALOGUE }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Show data references" })).toBeNull();
  });
  it("toggles the overlay, labels the wire, and persists the choice", () => {
    const g = graph();
    render(canvas({ editable: true }));
    const toggle = screen.getByRole("button", { name: "Show data references" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText(`${producerTitle(g)} → body`)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText(`${producerTitle(g)} → body`)).toBeTruthy();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem(SHOW_DATA_REFS_KEY)).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryByText(`${producerTitle(g)} → body`)).toBeNull();
    expect(window.localStorage.getItem(SHOW_DATA_REFS_KEY)).toBe("false");
  });
  it("with nothing selected there are no wires, and the toggle says so", () => {
    window.localStorage.setItem(SHOW_DATA_REFS_KEY, "true");
    const g = graph();
    render(canvas({ editable: true, selectedStepId: null }));
    expect(screen.queryByText(`${producerTitle(g)} → body`)).toBeNull();
    expect(screen.getByRole("button", { name: "Show data references" }).getAttribute("title")).toMatch(
      /select a step/,
    );
  });
  it("clicking an overlay wire selects nothing — a selected edge keeps its affordance", () => {
    const { container } = render(canvas({ editable: true }));
    fireEvent.click(screen.getByRole("button", { name: "Show data references" }));
    const realId = `edge-fetch->send`;
    const overlayId = [...container.querySelectorAll('[data-testid^="edge-dataref:"]')][0]?.getAttribute("data-testid");
    expect(overlayId).toMatch(/^edge-dataref:/);
    // Selecting the real edge arms its delete affordance …
    fireEvent.click(screen.getByTestId(realId));
    expect(screen.getByTitle("Remove this link (Delete)")).toBeTruthy();
    // … and clicking the overlay wire does not disarm it.
    fireEvent.click(screen.getByTestId(overlayId!));
    expect(screen.getByTitle("Remove this link (Delete)")).toBeTruthy();
  });
});
