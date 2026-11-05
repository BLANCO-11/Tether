// @vitest-environment jsdom
//
// src/components/flow/FlowCanvas.fields.test.tsx — per-field target ports.
//
// A card with known bindable inputs draws one target handle per input; a drop
// onto one reports `(from, to, field)` through `onConnectToField`, while the
// unnamed target keeps the plain `onConnectSteps` path. Cards without known
// fields keep the single unnamed target — pinned, not incidental.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FlowCanvas } from "@/components/flow/FlowCanvas";
import { canvasFromRawModel, type FieldPort } from "@/lib/canvas-model";
import type { StepPorts } from "@/lib/flow-field-drop";
import { heightFor, MAX_NODE_H, NODE_H, NODE_W, widthFor } from "@/lib/canvas-layout";

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  const React = await import("react");
  const Passthrough = ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  type AnyProps = Record<string, unknown>;
  const renderers = (props: AnyProps) => {
    const nodes = (props.nodes ?? []) as Array<AnyProps>;
    const nodeTypes = (props.nodeTypes ?? {}) as Record<string, React.ComponentType<AnyProps>>;
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
            "data-box": JSON.stringify({ ...(n.position as object), h: (n.measured as { height?: number } | undefined)?.height, w: (n.measured as { width?: number } | undefined)?.width }),
            onClick: (e: unknown) =>
              (props.onNodeClick as ((e: unknown, n: unknown) => void) | undefined)?.(e, n),
          },
          C ? React.createElement(C, { ...(n as object), key: n.id as string }) : null,
        );
      }),
      // jsdom cannot drag a handle; the gesture origin is simulated here while
      // everything downstream (linkSource, the field branch, the surface
      // callback) is production. The click event carries the connection in the
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
                targetHandle: t.dataset.targetHandle || undefined,
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
    // Rendered (unlike the c2 suite's null stub) so the port count per card is
    // assertable: one marker per handle, carrying its type and id.
    Handle: (props: AnyProps) =>
      React.createElement(
        "div",
        {
          "data-testid": `handle-${String(props.type)}-${String(props.id ?? "default")}`,
          "data-handle-type": String(props.type),
          "data-handle-id": props.id == null ? "" : String(props.id),
        },
        // Per-port remove buttons live inside the handle's children; without
        // them the I/O controls are unclickable under this mock while the
        // handle-count assertions above (keyed on data-handle-type) are unaffected.
        props.children as React.ReactNode,
      ),
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
    id: "field-flow",
    steps: [
      { id: "fetch", kind: "datasource", ref: "finance_demo.invoices_overdue", dependsOn: [] },
      { id: "send", kind: "tool", ref: "mail_send", dependsOn: [] },
    ],
  });

const drag = (
  container: HTMLElement,
  source: string,
  target: string,
  opts: { sourceHandle?: string; targetHandle?: string } = {},
) => {
  const btn = container.querySelector('[data-testid="mock-connect"]') as HTMLElement;
  btn.dataset.source = source;
  btn.dataset.target = target;
  if (opts.sourceHandle === undefined) delete btn.dataset.handle;
  else btn.dataset.handle = opts.sourceHandle;
  if (opts.targetHandle === undefined) delete btn.dataset.targetHandle;
  else btn.dataset.targetHandle = opts.targetHandle;
  fireEvent.click(btn);
};

/**
 * ⚠ Ports carry BINDING STATE now, not just names — see `FieldPort`. This
 * fixture binds nothing, which is the state that used to render as identical
 * stubs on a working step.
 */
const ports = (...names: string[]): FieldPort[] => names.map((name) => ({ name, source: { kind: "unset" } }));
const stepPorts = (...names: string[]): StepPorts => ({ fields: ports(...names), wholeFrom: null, bindable: true });

const FIELDS = new Map([["send", stepPorts("to_email", "subject")]]);

describe("drops onto a named field", () => {
  it("report (from, to, field) through onConnectToField, not the plain path", () => {
    const onConnectSteps = vi.fn();
    const onConnectToField = vi.fn();
    const { container } = render(
      <FlowCanvas
        graph={graph()}
        editable
        inputHandles={FIELDS}
        onConnectSteps={onConnectSteps}
        onConnectToField={onConnectToField}
      />,
    );
    drag(container, "fetch", "send", { targetHandle: "to_email" });
    expect(onConnectToField).toHaveBeenCalledTimes(1);
    expect(onConnectToField).toHaveBeenCalledWith("fetch", "send", "to_email");
    expect(onConnectSteps).not.toHaveBeenCalled();
  });

  it("a drop onto the unnamed target takes the plain path, even with ports on the card", () => {
    const onConnectSteps = vi.fn();
    const onConnectToField = vi.fn();
    const { container } = render(
      <FlowCanvas
        graph={graph()}
        editable
        inputHandles={FIELDS}
        onConnectSteps={onConnectSteps}
        onConnectToField={onConnectToField}
      />,
    );
    drag(container, "fetch", "send");
    expect(onConnectSteps).toHaveBeenCalledTimes(1);
    expect(onConnectSteps).toHaveBeenCalledWith("fetch", "send");
    expect(onConnectToField).not.toHaveBeenCalled();
  });

  it("a drop from an arm handle onto a field carries BOTH ends", () => {
    const armed = canvasFromRawModel({
      id: "arm-field-flow",
      steps: [
        { id: "big", kind: "branch", ref: null, dependsOn: [], conditionExpr: "{{ 1 }}", elseOf: null },
        { id: "small", kind: "branch", ref: null, dependsOn: [], conditionExpr: "{{ 2 }}", elseOf: "big" },
        { id: "rest", kind: "branch", ref: null, dependsOn: [], conditionExpr: null, elseOf: "small" },
        { id: "send", kind: "tool", ref: "mail_send", dependsOn: [] },
      ],
    });
    const onConnectSteps = vi.fn();
    const onConnectToField = vi.fn();
    const { container } = render(
      <FlowCanvas
        graph={armed}
        editable
        inputHandles={new Map([["send", stepPorts("to_email")]])}
        onConnectSteps={onConnectSteps}
        onConnectToField={onConnectToField}
      />,
    );
    // Leaving by the elif handle: the SOURCE resolves to the arm step, while
    // the TARGET still names the field.
    drag(container, "big", "send", { sourceHandle: "small", targetHandle: "to_email" });
    expect(onConnectToField).toHaveBeenCalledTimes(1);
    expect(onConnectToField).toHaveBeenCalledWith("small", "send", "to_email");
    expect(onConnectSteps).not.toHaveBeenCalled();
  });

  it("without a field handler a named drop falls back to the plain path", () => {
    const onConnectSteps = vi.fn();
    const { container } = render(
      <FlowCanvas graph={graph()} editable inputHandles={FIELDS} onConnectSteps={onConnectSteps} />,
    );
    drag(container, "fetch", "send", { targetHandle: "to_email" });
    expect(onConnectSteps).toHaveBeenCalledTimes(1);
    expect(onConnectSteps).toHaveBeenCalledWith("fetch", "send");
  });
});

describe("the ports on the card", () => {
  it("one labelled target handle per bindable input, PLUS the card's own", () => {
    /**
     * ⚠ `__params__` comes FIRST and is deliberate, not an extra to tolerate.
     * A node with only named ports has no unnamed target, so React Flow
     * attached every incoming edge to whichever named handle it picked first —
     * drawing the transform as feeding `subject` on a step that bound the
     * whole params object, and leaving the rest looking like missing wires.
     * The card handle is where an edge lands honestly.
     */
    const { container } = render(<FlowCanvas graph={graph()} editable inputHandles={FIELDS} />);
    const card = container.querySelector('[data-testid="node-send"]') as HTMLElement;
    const targets = [...card.querySelectorAll('[data-handle-type="target"]')];
    expect(targets.map((h) => h.getAttribute("data-handle-id"))).toEqual([
      "__params__",
      "to_email",
      "subject",
    ]);
  });

  it("a card with no known fields keeps its single unnamed target", () => {
    const { container } = render(<FlowCanvas graph={graph()} editable inputHandles={FIELDS} />);
    const card = container.querySelector('[data-testid="node-fetch"]') as HTMLElement;
    const targets = [...card.querySelectorAll('[data-handle-type="target"]')];
    expect(targets).toHaveLength(1);
    expect(targets[0]!.getAttribute("data-handle-id")).toBe("");
  });

  it("no inputHandles at all: every card keeps one target — pinned", () => {
    const { container } = render(<FlowCanvas graph={graph()} editable />);
    for (const id of ["fetch", "send"]) {
      const card = container.querySelector(`[data-testid="node-${id}"]`) as HTMLElement;
      const targets = [...card.querySelectorAll('[data-handle-type="target"]')];
      expect(targets).toHaveLength(1);
      expect(targets[0]!.getAttribute("data-handle-id")).toBe("");
    }
  });

  /**
   * ⚠ **THIS ASSERTED "CROWD, NEVER RESIZE" AND THAT RULE IS GONE.** It was
   * written against three `FlowCanvas` comments claiming I-66 forbade the card
   * growing for its ports. I-66's rule is that the DECLARED size, dagre's
   * spacing and the drawn card must AGREE — crowding satisfied that by never
   * moving, and `heightFor`/`widthFor` satisfy it by moving all three together.
   *
   * The property that actually matters is unchanged and is what is asserted
   * now: the card draws at exactly the size it declares. Two ports still fit
   * the base height, so this fixture's numbers do not move — which is why the
   * case below it exists.
   */
  it("the card draws at exactly the size the layout declares", () => {
    const { container } = render(<FlowCanvas graph={graph()} editable inputHandles={FIELDS} />);
    const g = graph();
    const send = g.nodes.find((n) => n.id === "send")!;
    const card = container.querySelector('[data-testid="node-send"]') as HTMLElement;
    const box = card.querySelector("div.group") as HTMLElement;
    const withPorts = { ...send, inputHandles: FIELDS.get("send")!.fields };
    expect(box.style.width).toBe(`${widthFor(withPorts)}px`);
    expect(box.style.height).toBe(`${heightFor(withPorts)}px`);
  });

  it("and MANY arms make it taller, which few alone cannot show", () => {
    // Arm dots sit beside laid-out rows at a fixed 22px pitch: six arms need
    // six rows past the header, which the base height cannot hold. Inputs buy
    // no rows anymore — the fixture above proves nothing about growth on its
    // own.
    const arms = ["if", "elif-a", "elif-b", "elif-c", "elif-d", "else"].map((label, i) => ({ id: `a${i}`, label }));
    const base = graph();
    const tall = { ...base, nodes: base.nodes.map((n) => (n.id === "send" ? { ...n, arms } : n)) };
    const { container } = render(<FlowCanvas graph={tall} editable />);
    const send = base.nodes.find((n) => n.id === "send")!;
    const h = heightFor({ ...send, arms });
    expect(h).toBeGreaterThan(heightFor(send));
    expect(h).toBeLessThanOrEqual(MAX_NODE_H);
    const box = container
      .querySelector('[data-testid="node-send"]')!
      .querySelector("div.group") as HTMLElement;
    expect(box.style.height).toBe(`${h}px`);
    // One source handle per arm. Asserted as an exact count so a lost arm is
    // a failure rather than a silently shorter card.
    const sources = [...box.querySelectorAll('[data-handle-type="source"]')];
    expect(sources).toHaveLength(arms.length);
  });
});

describe("on-canvas I/O editing", () => {
  const codeGraph = () =>
    canvasFromRawModel({
      id: "io-flow",
      steps: [{ id: "frag", kind: "code", ref: null, dependsOn: [] }],
    });

  it("a code card offers add-input/add-output; add reports (id, which, add)", () => {
    const onEditStepIo = vi.fn();
    render(<FlowCanvas graph={codeGraph()} editable onEditStepIo={onEditStepIo} />);
    expect(screen.getByRole("button", { name: "Add input to frag" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add output to frag" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add input to frag" }));
    expect(onEditStepIo).toHaveBeenCalledTimes(1);
    expect(onEditStepIo).toHaveBeenCalledWith("frag", "input", "add", undefined);
  });

  it("no per-input remove button — the rows it lived in are gone", () => {
    // The diet deleted the port rows and the remove buttons inside them. The
    // card keeps add-input/add-output (above) and output remove; there is no
    // per-input remove on the card anymore.
    const onEditStepIo = vi.fn();
    render(
      <FlowCanvas
        graph={codeGraph()}
        editable
        inputHandles={new Map([["frag", stepPorts("a")]])}
        onEditStepIo={onEditStepIo}
      />,
    );
    expect(screen.queryByRole("button", { name: "Remove input a from frag" })).toBeNull();
    expect(onEditStepIo).not.toHaveBeenCalled();
  });

  it("a tool card renders no I/O controls even with the callback", () => {
    const toolGraph = canvasFromRawModel({
      id: "io-tool-flow",
      steps: [{ id: "tls", kind: "tool", ref: "mail_send", dependsOn: [] }],
    });
    render(
      <FlowCanvas
        graph={toolGraph}
        editable
        inputHandles={new Map([["tls", stepPorts("to_email")]])}
        onEditStepIo={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Add input to|Add output to|Remove input|Remove output/ }),
    ).toBeNull();
  });

  it("without the callback a code card renders no I/O controls", () => {
    render(<FlowCanvas graph={codeGraph()} editable inputHandles={new Map([["frag", stepPorts("a")]])} />);
    expect(
      screen.queryByRole("button", { name: /Add input to|Add output to|Remove input|Remove output/ }),
    ).toBeNull();
  });

  it("the code card keeps its fixed size with the controls mounted (I-66)", () => {
    const { container } = render(<FlowCanvas graph={codeGraph()} editable onEditStepIo={vi.fn()} />);
    const card = container.querySelector('[data-testid="node-frag"]') as HTMLElement;
    const box = card.querySelector("div.group") as HTMLElement;
    expect(box.style.width).toBe(`${NODE_W}px`);
    expect(box.style.height).toBe(`${NODE_H}px`);
  });
});

describe("cards are laid out at the size they are DRAWN (2026-09-30: new steps spawned on top of each other)", () => {
  it("a card's input rows are counted by the layout — three siblings with three rows each never overlap", () => {
    const g = canvasFromRawModel({
      id: "stack",
      steps: [
        { id: "fetch", kind: "datasource", ref: "finance_demo.invoices_overdue", dependsOn: [] },
        { id: "a", kind: "tool", ref: "chat_post_message", dependsOn: ["fetch"] },
        { id: "b", kind: "tool", ref: "chat_post_message", dependsOn: ["fetch"] },
        { id: "c", kind: "tool", ref: "chat_post_message", dependsOn: ["fetch"] },
      ],
    });
    const rows = new Map(["a", "b", "c"].map((id) => [id, stepPorts("author", "channel", "text")]));
    const { container } = render(<FlowCanvas graph={g} editable inputHandles={rows} />);
    const box = (id: string) => JSON.parse(container.querySelector(`[data-testid="node-${id}"]`)!.getAttribute("data-box")!) as { x: number; y: number; w: number; h: number };
    const [a, b, c] = ["a", "b", "c"].map(box);
    expect(a!.h).toBeGreaterThan(100); // CONTROL: the rows made the cards tall enough to collide if spaced as header-only cards
    const clear = (p: typeof a, q: typeof a) => p!.y + p!.h <= q!.y || q!.y + q!.h <= p!.y || p!.x + p!.w <= q!.x || q!.x + q!.w <= p!.x;
    expect([clear(a, b), clear(b, c), clear(a, c)]).toEqual([true, true, true]);
  });
});
